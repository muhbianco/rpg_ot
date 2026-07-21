const { v4: uuidv4 } = require('uuid');
const { ENEMY_TEMPLATES } = require('../rules/catalog');
const { scaleEncounter, applyScaleToEnemy } = require('../rules/EncounterScaler');
const RulesEngine = require('../rules/RulesEngine');
const { hudPayload } = require('../character/CharacterService');
const GameFinder = require('../db/GameFinder');
const GmService = require('../gm/GmService');

const MAP_W = 12;
const MAP_H = 10;

class GameSessionService {
  constructor(partyService) {
    this.partyService = partyService;
    this.sessions = new Map();
    this.rules = new RulesEngine();
    this.gm = new GmService();
  }

  startFromParty(party) {
    const members = [...party.members.values()];
    const partySize = members.length;
    const scale = scaleEncounter(partySize, { cr: 1 });

    const characters = {};
    const entities = [];
    members.forEach((m, idx) => {
      const c = { ...m.character };
      c.x = 2 + (idx % 4);
      c.y = 7 + Math.floor(idx / 4);
      c.kind = 'player';
      characters[c.playerId] = c;
      entities.push({
        id: c.id,
        kind: 'player',
        playerId: c.playerId,
        name: c.name,
        x: c.x,
        y: c.y,
        color: c.color,
        hp: c.hp,
        hpMax: c.hpMax,
      });
    });

    const enemies = [];
    const templates = [ENEMY_TEMPLATES.goblin, ENEMY_TEMPLATES.lobo, ENEMY_TEMPLATES.bandido];
    for (let i = 0; i < scale.enemyCount; i += 1) {
      const tpl = templates[i % templates.length];
      const scaled = applyScaleToEnemy(tpl, scale);
      const enemy = {
        id: uuidv4(),
        kind: 'enemy',
        key: scaled.key,
        name: `${scaled.name}${scale.enemyCount > 1 ? ` ${i + 1}` : ''}`,
        hp: scaled.hp,
        hpMax: scaled.hpMax,
        defense: scaled.defense,
        attackMod: scaled.attackMod,
        damageDice: scaled.damageDice,
        weaponKey: scaled.key === 'goblin' ? 'adaga' : 'clava',
        dmgMult: scaled.dmgMult,
        attrs: { FOR: 12, DES: 12, CON: 12, INT: 8, SAB: 10, CAR: 8 },
        status: [],
        x: 8 + (i % 3),
        y: 2 + Math.floor(i / 3),
        color: scaled.color,
        mercy: { deaths: 0, failStreak: 0, punishments: 0 },
      };
      enemies.push(enemy);
      entities.push({
        id: enemy.id,
        kind: 'enemy',
        name: enemy.name,
        x: enemy.x,
        y: enemy.y,
        color: enemy.color,
        hp: enemy.hp,
        hpMax: enemy.hpMax,
      });
    }

    const session = {
      id: uuidv4(),
      partyId: party.id,
      mapId: 'taverna_arton',
      mapW: MAP_W,
      mapH: MAP_H,
      encounterBudget: scale.budget,
      scale,
      characters,
      enemies,
      world: {
        mapId: 'taverna_arton',
        mapW: MAP_W,
        mapH: MAP_H,
        entities,
        tiles: buildTavernTiles(MAP_W, MAP_H),
      },
      log: [],
      createdAt: Date.now(),
    };

    party.status = 'active';
    party.sessionId = session.id;
    this.sessions.set(session.id, session);

    GameFinder.saveParty(party).catch(() => {});
    GameFinder.saveSession(session).catch(() => {});
    GameFinder.saveGmMemory(
      session.id,
      `Sessão iniciada na Taverna de Arton. Party de ${partySize}. Inimigos: ${enemies.map((e) => e.name).join(', ')}.`
    ).catch(() => {});

    return session;
  }

  get(sessionId) {
    return this.sessions.get(sessionId) || null;
  }

  getByParty(partyId) {
    for (const s of this.sessions.values()) {
      if (s.partyId === partyId) return s;
    }
    return null;
  }

  publicWorld(session) {
    this.syncEntities(session);
    return {
      sessionId: session.id,
      mapId: session.mapId,
      mapW: session.mapW,
      mapH: session.mapH,
      encounterBudget: session.encounterBudget,
      partySize: session.scale.partySize,
      entities: session.world.entities,
      tiles: session.world.tiles,
    };
  }

  syncEntities(session) {
    const entities = [];
    for (const c of Object.values(session.characters)) {
      entities.push({
        id: c.id,
        kind: 'player',
        playerId: c.playerId,
        name: c.name,
        x: c.x,
        y: c.y,
        color: c.color,
        hp: c.hp,
        hpMax: c.hpMax,
        status: c.status,
      });
    }
    for (const e of session.enemies) {
      if (e.hp <= 0) continue;
      entities.push({
        id: e.id,
        kind: 'enemy',
        name: e.name,
        x: e.x,
        y: e.y,
        color: e.color,
        hp: e.hp,
        hpMax: e.hpMax,
        status: e.status,
      });
    }
    session.world.entities = entities;
  }

  partyHudList(session) {
    return Object.values(session.characters).map((c) => ({
      playerId: c.playerId,
      name: c.name,
      hp: c.hp,
      hpMax: c.hpMax,
      hpPct: c.hpMax ? Math.round((c.hp / c.hpMax) * 100) : 0,
      status: c.status || [],
    }));
  }

  findTarget(session, hint, actorPlayerId) {
    if (!hint) {
      return session.enemies.find((e) => e.hp > 0) || null;
    }
    const h = String(hint).toLowerCase();
    if (h === 'self' || h === 'eu' || h === 'mim') {
      return session.characters[actorPlayerId] || null;
    }
    const enemy = session.enemies.find(
      (e) => e.hp > 0 && (e.id === hint || e.name.toLowerCase().includes(h) || e.key === h)
    );
    if (enemy) return enemy;
    const ally = Object.values(session.characters).find(
      (c) => c.id === hint || c.name.toLowerCase().includes(h) || c.playerId === hint
    );
    return ally || null;
  }

  async handleAction(session, playerId, rawText) {
    const actor = session.characters[playerId];
    if (!actor) throw new Error('Personagem não encontrado.');
    if (actor.status?.includes('incapacitado')) {
      return {
        narrative: `${actor.name} está incapacitado e não consegue agir. Um aliado precisa ajudá-lo.`,
        effects: [],
        combat: [],
      };
    }

    const memory = await GameFinder.getGmMemory(session.id).catch(() => '');
    const mercy = this.rules.mercyFor(actor);
    const gmOut = await this.gm.narrate({
      action: rawText,
      actor,
      session,
      memory,
      mercy,
    });

    const combat = [];
    const effects = [];

    for (const intent of gmOut.intents || []) {
      const resolved = this.applyIntent(session, playerId, intent, mercy);
      if (resolved) {
        combat.push(resolved);
        if (resolved.effect) effects.push(resolved.effect);
      }
    }

    // Se a IA não gerou intent de combate mas o texto claramente ataca, fallback
    if (!combat.length && /atac|golpe|bater|ferir|lutar/i.test(rawText)) {
      const target = this.findTarget(session, null, playerId);
      if (target && target.kind !== 'player') {
        const atk = this.rules.resolveAttack(actor, target, { mercyMods: null });
        combat.push({
          summary: atk.hit
            ? `${actor.name} acerta ${target.name} (${atk.damage} de dano).`
            : `${actor.name} erra o ataque contra ${target.name}.`,
          ...atk,
        });
        // retaliação simples
        if (target.hp > 0) {
          const m2 = this.rules.mercyFor(actor);
          const ret = this.rules.resolveAttack(target, actor, { isNpc: true, mercyMods: m2.mods });
          combat.push({
            summary: ret.hit
              ? `${target.name} contra-ataca ${actor.name} (${ret.damage} de dano).`
              : `${target.name} erra o contra-ataque.`,
            ...ret,
          });
        }
      }
    }

    this.syncEntities(session);
    const narrative = this.composeNarrative(gmOut.narrative, combat, mercy);

    const payload = {
      narrative,
      effects,
      combat: combat.map((c) => ({
        summary: c.summary,
        outcome: c.outcome || (c.hit ? 'hit' : c.ok === false ? 'fail' : 'ok'),
        damage: c.damage || 0,
        healed: c.healed || 0,
      })),
      world: this.publicWorld(session),
      party: this.partyHudList(session),
      hud: hudPayload(actor),
      mercyScore: mercy.score,
    };

    session.log.push({ at: Date.now(), playerId, rawText, narrative });
    if (session.log.length > 40) session.log.shift();

    const summaryLine = `${actor.name}: ${rawText} → ${narrative.slice(0, 180)}`;
    const newMem = `${memory}\n${summaryLine}`.slice(-4000);
    GameFinder.saveGmMemory(session.id, newMem).catch(() => {});
    GameFinder.logAction(session.id, playerId, rawText, payload).catch(() => {});
    GameFinder.saveSession(session).catch(() => {});

    return payload;
  }

  applyIntent(session, playerId, intent, mercy) {
    const actor = session.characters[playerId];
    const type = intent.type || 'wait';

    if (type === 'move') {
      const dx = Number(intent.dx || 0);
      const dy = Number(intent.dy || 0);
      const nx = Math.max(0, Math.min(session.mapW - 1, actor.x + (dx || (intent.x != null ? intent.x - actor.x : 0))));
      const ny = Math.max(0, Math.min(session.mapH - 1, actor.y + (dy || (intent.y != null ? intent.y - actor.y : 0))));
      if (intent.x != null && intent.y != null) {
        actor.x = Math.max(0, Math.min(session.mapW - 1, Number(intent.x)));
        actor.y = Math.max(0, Math.min(session.mapH - 1, Number(intent.y)));
      } else {
        actor.x = nx;
        actor.y = ny;
      }
      return {
        summary: `${actor.name} se desloca.`,
        effect: { type: 'move', id: actor.id, x: actor.x, y: actor.y },
      };
    }

    if (type === 'attack') {
      const target = this.findTarget(session, intent.targetId || intent.target, playerId);
      if (!target || target.kind === 'player') {
        return { summary: `${actor.name} não encontra um alvo válido.`, outcome: 'fail' };
      }
      const atk = this.rules.resolveAttack(actor, target);
      const out = {
        summary: atk.hit
          ? `${actor.name} acerta ${target.name}${atk.isCrit ? ' em cheio' : ''} (${atk.damage} de dano).`
          : `${actor.name} erra o golpe em ${target.name}.`,
        ...atk,
      };
      if (target.hp > 0 && atk.hit) {
        const m2 = this.rules.mercyFor(actor);
        if (!(m2.mods.preferOtherTargets && m2.score > 0.7 && Math.random() < 0.5)) {
          const ret = this.rules.resolveAttack(target, actor, { isNpc: true, mercyMods: m2.mods });
          out.retaliation = ret;
          out.summary += ret.hit
            ? ` ${target.name} revida (${ret.damage}).`
            : ` ${target.name} tenta revidar e erra.`;
        }
      } else if (target.hp <= 0) {
        out.summary += ` ${target.name} cai!`;
      }
      return out;
    }

    if (type === 'cast') {
      const spellKey = intent.spellKey || intent.skillHint;
      let target = this.findTarget(session, intent.targetId || intent.target || 'self', playerId);
      if (!target) target = actor;
      const res = this.rules.resolveSpell(actor, target, spellKey);
      if (!res.ok) return { summary: res.reason || 'Falha ao conjurar.', outcome: 'fail' };
      return {
        summary: res.healed
          ? `${actor.name} conjura ${res.spell} e recupera ${res.healed} PV de ${target.name}.`
          : res.damage
            ? `${actor.name} conjura ${res.spell} em ${target.name} (${res.damage} de dano).`
            : `${actor.name} conjura ${res.spell}.`,
        ...res,
      };
    }

    if (type === 'inspect' || type === 'talk' || type === 'wait' || type === 'use_item') {
      return { summary: null, outcome: 'ok' };
    }

    return null;
  }

  composeNarrative(gmText, combat, mercy) {
    const parts = [];
    if (gmText) parts.push(gmText);
    for (const c of combat) {
      if (c.summary) parts.push(c.summary);
    }
    if (mercy.score >= 0.55 && mercy.mods.forceHint) {
      parts.push('O destino parece inclinado a te dar uma chance — observe as falhas do inimigo e uma saída próxima.');
    }
    return parts.filter(Boolean).join(' ') || 'O tempo passa na taverna...';
  }
}

function buildTavernTiles(w, h) {
  const tiles = [];
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      let type = 'floor';
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) type = 'wall';
      else if ((x === 3 || x === 4) && y === 3) type = 'table';
      else if ((x === 7 || x === 8) && y === 5) type = 'table';
      else if (x === 1 && y === 1) type = 'bar';
      tiles.push({ x, y, type });
    }
  }
  // porta
  const door = tiles.find((t) => t.x === Math.floor(w / 2) && t.y === h - 1);
  if (door) door.type = 'door';
  return tiles;
}

module.exports = GameSessionService;
