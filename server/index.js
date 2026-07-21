const crypto = require('crypto');
const path = require('path');
const express = require('express');
const http = require('http');
const helmet = require('helmet');
const cors = require('cors');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');

const config = require('./config');
const { initSchema } = require('./db/pool');
const GameFinder = require('./db/GameFinder');
const rateLimit = require('./security/rateLimit');
const { sanitizeNickname, sanitizeAction, sanitizePartyCode } = require('./security/sanitize');
const PartyService = require('./lobby/PartyService');
const { buildCharacter, publicCatalog, hudPayload } = require('./character/CharacterService');
const GameSessionService = require('./game/GameSessionService');

function clientIp(socket) {
  const forwarded = socket.handshake.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length) {
    return forwarded.split(',')[0].trim();
  }
  return socket.handshake.address || 'unknown';
}

function payloadTooLarge(data) {
  try {
    return Buffer.byteLength(JSON.stringify(data || {}), 'utf8') > config.limits.payloadMaxBytes;
  } catch {
    return true;
  }
}

async function bootstrap() {
  try {
    await initSchema();
    console.log('[db] schema ok');
  } catch (err) {
    console.error('[db] falha schema — seguindo em memória:', err.message);
  }

  const app = express();
  app.set('trust proxy', 1);

  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        'default-src': ["'self'"],
        'script-src': ["'self'"],
        'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        'font-src': ["'self'", 'https://fonts.gstatic.com', 'data:'],
        'img-src': ["'self'", 'data:'],
        'connect-src': ["'self'", 'wss:', 'ws:'],
        'object-src': ["'none'"],
        'base-uri': ["'self'"],
        'frame-ancestors': ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  }));

  app.use(cors({ origin: config.corsOrigin, methods: ['GET'] }));
  app.use(express.json({ limit: '8kb' }));
  app.use(express.static(path.join(__dirname, '..', 'public'), {
    maxAge: config.nodeEnv === 'production' ? '1h' : 0,
  }));

  app.get('/health', (_req, res) => {
    res.json({
      ok: true,
      gemini: Boolean(config.gemini.apiKey),
      model: config.gemini.model,
    });
  });

  app.get('/api/catalog', (_req, res) => {
    res.json(publicCatalog());
  });

  const server = http.createServer(app);
  const io = new Server(server, {
    cors: { origin: config.corsOrigin, methods: ['GET', 'POST'] },
    maxHttpBufferSize: config.limits.payloadMaxBytes,
  });

  const parties = new PartyService();
  const games = new GameSessionService(parties);
  const sockets = new Map(); // socketId -> player

  setInterval(() => rateLimit.prune(), 60000);

  function emitParty(partySnap) {
    if (!partySnap) return;
    io.to(`party:${partySnap.id}`).emit('party:update', partySnap);
  }

  function emitSessionToParty(session) {
    const party = parties.get(session.partyId);
    if (!party) return;
    const world = games.publicWorld(session);
    const partyHud = games.partyHudList(session);
    for (const m of party.members.values()) {
      const sock = m.socketId ? io.sockets.sockets.get(m.socketId) : null;
      if (!sock) continue;
      const char = session.characters[m.playerId];
      sock.emit('session:state', {
        world,
        party: partyHud,
        hud: hudPayload(char),
      });
    }
  }

  io.on('connection', (socket) => {
    const ip = clientIp(socket);

    socket.emit('meta', {
      online: io.engine.clientsCount,
      catalog: publicCatalog(),
      gemini: Boolean(config.gemini.apiKey),
    });

    socket.on('auth:join', async (data, cb) => {
      const reply = typeof cb === 'function' ? cb : () => {};
      if (payloadTooLarge(data)) return reply({ ok: false, error: 'Payload grande.' });

      const nickname = sanitizeNickname(data?.nickname);
      if (!nickname) return reply({ ok: false, error: 'Nickname inválido.' });

      if (!rateLimit.hit(`join:${ip}`, 10, 60000)) {
        return reply({ ok: false, error: 'Muitas tentativas. Aguarde.' });
      }

      const player = {
        id: uuidv4(),
        nickname,
        token: crypto.randomBytes(24).toString('hex'),
        socketId: socket.id,
        ip,
      };
      sockets.set(socket.id, player);
      socket.join('lobby');
      GameFinder.upsertPlayer(player).catch(() => {});

      reply({ ok: true, player: { id: player.id, nickname: player.nickname, token: player.token } });
      io.emit('meta', { online: io.engine.clientsCount });
    });

    socket.on('party:create', (data, cb) => {
      const reply = typeof cb === 'function' ? cb : () => {};
      const player = sockets.get(socket.id);
      if (!player) return reply({ ok: false, error: 'Não autenticado.' });
      try {
        const snap = parties.create(player);
        socket.join(`party:${snap.id}`);
        reply({ ok: true, party: snap });
        emitParty(snap);
      } catch (err) {
        reply({ ok: false, error: err.message });
      }
    });

    socket.on('party:join', (data, cb) => {
      const reply = typeof cb === 'function' ? cb : () => {};
      const player = sockets.get(socket.id);
      if (!player) return reply({ ok: false, error: 'Não autenticado.' });
      const code = sanitizePartyCode(data?.code);
      if (!code) return reply({ ok: false, error: 'Código inválido.' });
      try {
        const snap = parties.join(code, player);
        socket.join(`party:${snap.id}`);
        reply({ ok: true, party: snap });
        emitParty(snap);
      } catch (err) {
        reply({ ok: false, error: err.message });
      }
    });

    socket.on('party:leave', (_data, cb) => {
      const reply = typeof cb === 'function' ? cb : () => {};
      const player = sockets.get(socket.id);
      if (!player) return reply({ ok: false, error: 'Não autenticado.' });
      const before = parties.getByPlayer(player.id);
      const partyId = before?.id;
      if (partyId) socket.leave(`party:${partyId}`);
      const snap = parties.leave(player.id);
      reply({ ok: true, party: snap });
      if (snap) emitParty(snap);
      else if (partyId) io.to(`party:${partyId}`).emit('party:update', null);
    });

    socket.on('party:start_hall', (_data, cb) => {
      const reply = typeof cb === 'function' ? cb : () => {};
      const player = sockets.get(socket.id);
      if (!player) return reply({ ok: false, error: 'Não autenticado.' });
      try {
        const snap = parties.startHall(player.id);
        reply({ ok: true, party: snap });
        emitParty(snap);
        io.to(`party:${snap.id}`).emit('party:hall', snap);
      } catch (err) {
        reply({ ok: false, error: err.message });
      }
    });

    socket.on('character:submit', (data, cb) => {
      const reply = typeof cb === 'function' ? cb : () => {};
      const player = sockets.get(socket.id);
      if (!player) return reply({ ok: false, error: 'Não autenticado.' });
      if (payloadTooLarge(data)) return reply({ ok: false, error: 'Payload grande.' });

      const party = parties.getByPlayer(player.id);
      if (!party) return reply({ ok: false, error: 'Sem party.' });

      const name = sanitizeNickname(data?.name) || player.nickname;
      const raceKey = String(data?.race || 'humano');
      const classKey = String(data?.classKey || 'guerreiro');

      try {
        const character = buildCharacter({
          playerId: player.id,
          partyId: party.id,
          name,
          raceKey,
          classKey,
        });
        const snap = parties.setCharacter(player.id, character);
        reply({ ok: true, character: hudPayload(character), party: snap });
        emitParty(snap);
      } catch (err) {
        reply({ ok: false, error: err.message });
      }
    });

    socket.on('party:ready', (data, cb) => {
      const reply = typeof cb === 'function' ? cb : () => {};
      const player = sockets.get(socket.id);
      if (!player) return reply({ ok: false, error: 'Não autenticado.' });
      try {
        const snap = parties.setReady(player.id, data?.ready !== false);
        reply({ ok: true, party: snap });
        emitParty(snap);

        if (snap.allReady) {
          const party = parties.get(snap.id);
          const session = games.startFromParty(party);
          io.to(`party:${snap.id}`).emit('session:start', {
            sessionId: session.id,
            world: games.publicWorld(session),
            party: games.partyHudList(session),
          });
          emitSessionToParty(session);
        }
      } catch (err) {
        reply({ ok: false, error: err.message });
      }
    });

    socket.on('action:submit', async (data, cb) => {
      const reply = typeof cb === 'function' ? cb : () => {};
      const player = sockets.get(socket.id);
      if (!player) return reply({ ok: false, error: 'Não autenticado.' });

      const text = sanitizeAction(data?.text);
      if (!text) return reply({ ok: false, error: 'Ação inválida.' });
      if (!rateLimit.hit(`act:${player.id}`, config.limits.actionsPerMinute, 60000)) {
        return reply({ ok: false, error: 'Calma — muitas ações.' });
      }

      const party = parties.getByPlayer(player.id);
      if (!party?.sessionId) return reply({ ok: false, error: 'Sessão inativa.' });
      const session = games.get(party.sessionId);
      if (!session) return reply({ ok: false, error: 'Sessão não encontrada.' });

      try {
        const result = await games.handleAction(session, player.id, text);
        io.to(`party:${party.id}`).emit('narrative:push', {
          from: player.nickname,
          character: session.characters[player.id]?.name,
          text: result.narrative,
          combat: result.combat,
        });
        emitSessionToParty(session);
        reply({ ok: true, result });
      } catch (err) {
        console.error('[action]', err);
        reply({ ok: false, error: err.message || 'Falha ao resolver ação.' });
      }
    });

    socket.on('disconnect', () => {
      const player = sockets.get(socket.id);
      sockets.delete(socket.id);
      if (player) {
        parties.setSocket(player.id, null);
      }
      io.emit('meta', { online: io.engine.clientsCount });
    });
  });

  server.listen(config.port, () => {
    console.log(`[rpg_ot] listening :${config.port} gemini=${Boolean(config.gemini.apiKey)} model=${config.gemini.model}`);
  });
}

bootstrap().catch((err) => {
  console.error(err);
  process.exit(1);
});
