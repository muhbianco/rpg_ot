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
const { buildCharacter, previewCharacter, publicCatalog, hudPayload } = require('./character/CharacterService');
const GameSessionService = require('./game/GameSessionService');
const DiscordAuthService = require('./auth/DiscordAuthService');
const authSession = require('./auth/session');

function clientIp(socket) {
  const forwarded = socket.handshake.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length) {
    return forwarded.split(',')[0].trim();
  }
  return socket.handshake.address || 'unknown';
}

function clientIpFromReq(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length) {
    return forwarded.split(',')[0].trim();
  }
  return req.ip || req.socket?.remoteAddress || 'unknown';
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

  const discordAuth = new DiscordAuthService();
  if (!discordAuth.isConfigured()) {
    console.warn('[auth] Discord OAuth NÃO configurado (defina DISCORD_CLIENT_ID/SECRET/SERVER_ID). Login indisponível.');
  }
  if (!config.session.secret) {
    console.warn('[auth] SESSION_SECRET ausente — sessões desabilitadas até definir.');
  }

  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        'default-src': ["'self'"],
        'script-src': ["'self'"],
        'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        'font-src': ["'self'", 'https://fonts.gstatic.com', 'data:'],
        'img-src': ["'self'", 'data:', 'https://cdn.discordapp.com'],
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

  const publicDir = path.join(__dirname, '..', 'public');

  // Index sem cache — precisa vir ANTES do static
  app.get('/', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.sendFile(path.join(publicDir, 'index.html'));
  });

  app.use(express.static(publicDir, {
    index: false,
    etag: true,
    lastModified: true,
    setHeaders(res, filePath) {
      if (filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      } else if (/\.(js|css)$/.test(filePath)) {
        res.setHeader('Cache-Control', 'no-cache, must-revalidate');
      } else {
        res.setHeader('Cache-Control', config.nodeEnv === 'production' ? 'public, max-age=3600' : 'no-cache');
      }
    },
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

  function sanitizeDisplayName(raw) {
    return String(raw || 'Aventureiro')
      .replace(/[\u0000-\u001f<>]/g, '')
      .trim()
      .slice(0, 64) || 'Aventureiro';
  }

  app.get('/auth/status', (req, res) => {
    const sess = config.session.secret ? authSession.readSession(req) : null;
    res.json({
      configured: discordAuth.isConfigured() && Boolean(config.session.secret),
      authenticated: Boolean(sess?.uid),
    });
  });

  app.get('/api/me', (req, res) => {
    const sess = authSession.readSession(req);
    if (!sess?.uid) return res.status(401).json({ ok: false, error: 'Não autenticado.' });
    res.json({
      ok: true,
      player: { id: sess.uid, nickname: sess.nick, avatar: sess.av || null, discordId: sess.did },
    });
  });

  app.get('/auth/discord/login', (req, res) => {
    if (!discordAuth.isConfigured() || !config.session.secret) {
      return res.redirect('/?auth=disabled');
    }
    if (!rateLimit.hit(`oauth:${clientIpFromReq(req)}`, 20, 60000)) {
      return res.redirect('/?auth=ratelimited');
    }
    const state = crypto.randomBytes(16).toString('hex');
    authSession.setStateCookie(res, state);
    res.redirect(discordAuth.buildAuthUrl(state));
  });

  app.get('/auth/discord/callback', async (req, res) => {
    if (!discordAuth.isConfigured() || !config.session.secret) {
      return res.redirect('/?auth=disabled');
    }
    try {
      const { code, state } = req.query;
      const cookies = authSession.parseCookies(req.headers.cookie);
      const savedState = cookies[config.session.stateCookie];
      authSession.clearStateCookie(res);

      if (!code || !state || !savedState || String(state) !== String(savedState)) {
        return res.redirect('/?auth=state');
      }

      const tokens = await discordAuth.exchangeCode(String(code));
      const accessToken = tokens.access_token;
      if (!accessToken) return res.redirect('/?auth=token');

      const isMember = await discordAuth.isGuildMember(accessToken);
      if (!isMember) return res.redirect('/?auth=denied');

      const user = await discordAuth.fetchUser(accessToken);
      const existing = await GameFinder.findPlayerByDiscordId(user.id).catch(() => null);
      const nickname = sanitizeDisplayName(user.global_name || user.username);
      const avatarUrl = discordAuth.avatarUrl(user.id, user.avatar);

      const player = {
        id: existing?.id || uuidv4(),
        discordId: user.id,
        nickname,
        globalName: user.global_name || null,
        avatar: user.avatar || null,
        token: crypto.randomBytes(24).toString('hex'),
      };
      await GameFinder.upsertPlayer(player).catch((err) => {
        console.error('[auth] upsertPlayer falhou:', err.message);
      });

      authSession.setSession(res, { uid: player.id, did: user.id, nick: nickname, av: avatarUrl });
      res.redirect('/');
    } catch (err) {
      console.error('[auth] callback erro:', err.message);
      res.redirect('/?auth=error');
    }
  });

  app.get('/auth/logout', (_req, res) => {
    authSession.clearSession(res);
    res.redirect('/');
  });
  app.post('/auth/logout', (_req, res) => {
    authSession.clearSession(res);
    res.json({ ok: true });
  });

  const server = http.createServer(app);
  const io = new Server(server, {
    cors: { origin: config.corsOrigin, methods: ['GET', 'POST'] },
    maxHttpBufferSize: config.limits.payloadMaxBytes,
  });

  io.use((socket, next) => {
    try {
      if (!config.session.secret) return next(new Error('auth_unavailable'));
      const sess = authSession.readSessionFromHeader(socket.handshake.headers.cookie);
      if (!sess?.uid) return next(new Error('unauthorized'));
      socket.data.identity = {
        id: sess.uid,
        discordId: sess.did || null,
        nickname: sess.nick || 'Aventureiro',
        avatar: sess.av || null,
      };
      return next();
    } catch {
      return next(new Error('unauthorized'));
    }
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
        turn: games.turnPayload(session),
      });
    }
  }

  function emitTurn(session) {
    io.to(`party:${session.partyId}`).emit('turn:update', games.turnPayload(session));
  }

  function emitSegment(partyId, segment) {
    if (!segment) return;
    io.to(`party:${partyId}`).emit('narrative:push', {
      by: segment.by,
      from: segment.name,
      character: segment.by === 'player' ? segment.name : null,
      text: segment.narrative,
      combat: segment.combat || [],
      effects: segment.effects || [],
    });
  }

  function endGame(party, session, outcome) {
    session.outcome = outcome;
    parties.endParty(party.id);
    GameFinder.endParty(party.id).catch(() => {});
    GameFinder.saveSession(session).catch(() => {});
    io.to(`party:${party.id}`).emit('game:over', {
      outcome,
      turn: games.turnPayload(session),
    });
  }

  io.on('connection', (socket) => {
    const ip = clientIp(socket);
    const identity = socket.data.identity;

    const player = {
      id: identity.id,
      discordId: identity.discordId,
      nickname: identity.nickname,
      avatar: identity.avatar,
      token: crypto.randomBytes(24).toString('hex'),
      socketId: socket.id,
      ip,
    };
    sockets.set(socket.id, player);
    socket.join('lobby');
    GameFinder.upsertPlayer(player).catch(() => {});

    parties.setSocket(player.id, socket.id);
    const activeParty = parties.getByPlayer(player.id);
    if (activeParty) socket.join(`party:${activeParty.id}`);

    socket.emit('meta', {
      online: io.engine.clientsCount,
      catalog: publicCatalog(),
      gemini: Boolean(config.gemini.apiKey),
    });
    socket.emit('auth:ok', {
      player: { id: player.id, nickname: player.nickname, avatar: player.avatar },
    });
    io.emit('meta', { online: io.engine.clientsCount });

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

    socket.on('games:list', async (_data, cb) => {
      const reply = typeof cb === 'function' ? cb : () => {};
      const player = sockets.get(socket.id);
      if (!player) return reply({ ok: false, error: 'Não autenticado.' });
      try {
        const rows = await GameFinder.listPlayerGames(player.id);
        const gamesList = rows.map((r) => ({
          partyId: r.partyId,
          code: r.code,
          status: r.status,
          hostId: r.hostId,
          sessionId: r.sessionId || null,
          memberCount: Number(r.memberCount || 0),
          charName: r.charName || null,
          charClass: r.charClass || null,
          createdAt: r.createdAt,
          updatedAt: r.sessionUpdatedAt || r.updatedAt || r.createdAt,
          endedAt: r.endedAt || null,
          canRejoin: r.status === 'active' && Boolean(r.sessionId),
          canResumeLobby: r.status === 'lobby' || r.status === 'hall',
        }));
        reply({ ok: true, games: gamesList });
      } catch (err) {
        console.error('[games:list]', err.message);
        reply({ ok: false, error: 'Falha ao listar jogos.' });
      }
    });

    socket.on('games:rejoin', async (data, cb) => {
      const reply = typeof cb === 'function' ? cb : () => {};
      const player = sockets.get(socket.id);
      if (!player) return reply({ ok: false, error: 'Não autenticado.' });
      const partyId = String(data?.partyId || '');
      if (!partyId) return reply({ ok: false, error: 'Party inválida.' });

      try {
        const member = await GameFinder.isPartyMember(partyId, player.id);
        if (!member) return reply({ ok: false, error: 'Você não participa deste jogo.' });

        let party = parties.get(partyId);
        if (!party) {
          await parties.rehydrateFromDb(partyId);
          party = parties.get(partyId);
        }
        if (!party) return reply({ ok: false, error: 'Party não encontrada.' });

        if (party.status === 'ended') {
          return reply({ ok: false, error: 'Partida já finalizada. Use Ver recap.' });
        }

        // Lobby/hall: só reanexa
        if (party.status === 'lobby' || party.status === 'hall') {
          const prev = parties.getByPlayer(player.id);
          if (prev?.id && prev.id !== partyId) socket.leave(`party:${prev.id}`);
          const snap = parties.attachPlayer(partyId, player);
          socket.join(`party:${partyId}`);
          emitParty(snap);
          return reply({
            ok: true,
            mode: party.status,
            party: snap,
          });
        }

        // Active session
        let session = games.getByParty(partyId) || (party.sessionId ? games.get(party.sessionId) : null);
        if (!session) {
          session = await games.ensureLoaded(partyId);
        }
        if (!session) return reply({ ok: false, error: 'Sessão não encontrada no banco.' });
        if (session.outcome) return reply({ ok: false, error: 'Partida já terminou.' });

        party.sessionId = session.id;
        party.status = 'active';

        // Sincroniza personagem vivo da sessão no member
        const liveChar = session.characters[player.id];
        if (liveChar && party.members.has(player.id)) {
          party.members.get(player.id).character = liveChar;
        }

        const prev = parties.getByPlayer(player.id);
        if (prev?.id && prev.id !== partyId) socket.leave(`party:${prev.id}`);
        const snap = parties.attachPlayer(partyId, player);
        socket.join(`party:${partyId}`);

        reply({
          ok: true,
          mode: 'active',
          party: snap,
          sessionId: session.id,
          world: games.publicWorld(session),
          partyHud: games.partyHudList(session),
          hud: hudPayload(session.characters[player.id]),
          turn: games.turnPayload(session),
          log: (session.log || []).slice(-20).map((l) => ({
            who: session.characters[l.playerId]?.name || 'Ação',
            text: l.narrative || l.rawText,
          })),
        });
        emitSessionToParty(session);
        emitTurn(session);
      } catch (err) {
        console.error('[games:rejoin]', err);
        reply({ ok: false, error: err.message || 'Falha ao reentrar.' });
      }
    });

    socket.on('games:recap', async (data, cb) => {
      const reply = typeof cb === 'function' ? cb : () => {};
      const player = sockets.get(socket.id);
      if (!player) return reply({ ok: false, error: 'Não autenticado.' });
      const partyId = String(data?.partyId || '');
      if (!partyId) return reply({ ok: false, error: 'Party inválida.' });

      try {
        const member = await GameFinder.isPartyMember(partyId, player.id);
        if (!member) return reply({ ok: false, error: 'Você não participa deste jogo.' });

        const partyRow = await GameFinder.loadPartyById(partyId);
        const snap = await GameFinder.loadSessionByParty(partyId);
        const actions = snap?.id ? await GameFinder.loadActionRecap(snap.id, 40) : [];

        reply({
          ok: true,
          recap: {
            partyId,
            code: partyRow?.code || null,
            status: partyRow?.status || 'ended',
            outcome: snap?.outcome || null,
            endedAt: partyRow?.ended_at || null,
            characters: Object.values(snap?.characters || {}).map((c) => ({
              name: c.name,
              class: c.classLabel || c.classKey,
              hp: c.hp,
              hpMax: c.hpMax,
            })),
            log: (snap?.log || []).slice(-20).map((l) => ({
              text: l.narrative || l.rawText,
              at: l.at,
            })),
            actions: actions.map((a) => ({
              text: a.resolved?.narrative || a.rawText,
              at: a.createdAt,
            })),
          },
        });
      } catch (err) {
        console.error('[games:recap]', err.message);
        reply({ ok: false, error: 'Falha ao carregar recap.' });
      }
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
          attrs: data?.attrs || null,
        });
        const snap = parties.setCharacter(player.id, character);
        reply({ ok: true, character: hudPayload(character), party: snap });
        emitParty(snap);
      } catch (err) {
        reply({ ok: false, error: err.message });
      }
    });

    socket.on('character:preview', (data, cb) => {
      const reply = typeof cb === 'function' ? cb : () => {};
      const player = sockets.get(socket.id);
      if (!player) return reply({ ok: false, error: 'Não autenticado.' });
      if (payloadTooLarge(data)) return reply({ ok: false, error: 'Payload grande.' });
      if (!rateLimit.hit(`preview:${player.id}`, 60, 60000)) {
        return reply({ ok: false, error: 'Muitas prévias. Aguarde.' });
      }
      const out = previewCharacter({
        name: sanitizeNickname(data?.name) || player.nickname,
        raceKey: String(data?.race || 'humano'),
        classKey: String(data?.classKey || 'guerreiro'),
        attrs: data?.attrs || null,
      });
      reply(out);
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
            turn: games.turnPayload(session),
          });
          emitSessionToParty(session);

          // Mestre (IA) sempre começa primeiro — turno de abertura automático.
          const opening = games.openingTurn(session);
          emitSegment(party.id, opening.segment);
          emitSessionToParty(session);
          emitTurn(session);
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
      if (party.status === 'ended') return reply({ ok: false, error: 'Esta partida já terminou.' });
      const session = games.get(party.sessionId);
      if (!session) return reply({ ok: false, error: 'Sessão não encontrada.' });

      if (!games.isPlayersTurn(session, player.id)) {
        return reply({ ok: false, error: 'Não é o seu turno.' });
      }
      if (session._busy) return reply({ ok: false, error: 'Ação em andamento, aguarde.' });
      session._busy = true;

      try {
        const result = await games.submitPlayerAction(session, player.id, text);
        for (const seg of result.segments) emitSegment(party.id, seg);
        emitSessionToParty(session);
        emitTurn(session);
        if (result.outcome) endGame(party, session, result.outcome);
        reply({ ok: true, result: { hud: result.hud, turn: result.turn, outcome: result.outcome } });
      } catch (err) {
        console.error('[action]', err);
        reply({ ok: false, error: err.message || 'Falha ao resolver ação.' });
      } finally {
        session._busy = false;
      }
    });

    socket.on('turn:skip', (_data, cb) => {
      const reply = typeof cb === 'function' ? cb : () => {};
      const player = sockets.get(socket.id);
      if (!player) return reply({ ok: false, error: 'Não autenticado.' });
      const party = parties.getByPlayer(player.id);
      if (!party?.sessionId) return reply({ ok: false, error: 'Sessão inativa.' });
      if (party.hostId !== player.id) return reply({ ok: false, error: 'Só o host pode pular o turno.' });
      const session = games.get(party.sessionId);
      if (!session) return reply({ ok: false, error: 'Sessão não encontrada.' });

      const result = games.skipCurrent(session);
      for (const seg of result.segments) emitSegment(party.id, seg);
      emitSessionToParty(session);
      emitTurn(session);
      if (result.outcome) endGame(party, session, result.outcome);
      reply({ ok: true, result: { turn: result.turn, outcome: result.outcome } });
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
