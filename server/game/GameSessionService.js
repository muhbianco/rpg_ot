const { v4: uuidv4 } = require('uuid');
const { ENEMY_TEMPLATES } = require('../rules/catalog');
const { scaleEncounter, applyScaleToEnemy } = require('../rules/EncounterScaler');
const RulesEngine = require('../rules/RulesEngine');
const { hudPayload } = require('../character/CharacterService');
const GameFinder = require('../db/GameFinder');
const GmService = require('../gm/GmService');
const { SKILLS, tickCooldowns } = require('../rules/skills');

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
      turn: null,
      outcome: null,
      createdAt: Date.now(),
    };

    session.turn = {
      order: ['gm', ...members.map((m) => m.playerId)],
      index: 0,
      round: 1,
      current: 'gm',
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

  /** Reidrata sessão a partir do snapshot persistido em world_state_json. */
  rehydrate(snapshot) {
    if (!snapshot?.id) return null;
    if (this.sessions.has(snapshot.id)) return this.sessions.get(snapshot.id);

    const session = {
      id: snapshot.id,
      partyId: snapshot.partyId,
      mapId: snapshot.mapId || 'taverna_arton',
      mapW: snapshot.mapW || MAP_W,
      mapH: snapshot.mapH || MAP_H,
      encounterBudget: snapshot.encounterBudget || 1,
      scale: snapshot.scale || { partySize: Object.keys(snapshot.characters || {}).length || 1 },
      characters: snapshot.characters || {},
      enemies: snapshot.enemies || [],
      world: snapshot.world || {
        mapId: snapshot.mapId || 'taverna_arton',
        mapW: snapshot.mapW || MAP_W,
        mapH: snapshot.mapH || MAP_H,
        entities: [],
        tiles: buildTavernTiles(MAP_W, MAP_H),
      },
      log: snapshot.log || [],
      turn: snapshot.turn || null,
      outcome: snapshot.outcome || null,
      createdAt: snapshot.createdAt || Date.now(),
    };

    // Garante kind nos personagens
    for (const c of Object.values(session.characters)) {
      c.kind = 'player';
    }
    for (const e of session.enemies) {
      e.kind = 'enemy';
    }

    this.syncEntities(session);
    this.sessions.set(session.id, session);
    return session;
  }

  async ensureLoaded(partyId) {
    let session = this.getByParty(partyId);
    if (session) return session;
    const snap = await GameFinder.loadSessionByParty(partyId);
    if (!snap) return null;
    return this.rehydrate(snap);
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

  // ---------------------------------------------------------------------------
  // Turnos: Mestre (IA) primeiro, depois cada player. Inimigos agem no turno do Mestre.
  // ---------------------------------------------------------------------------

  isIncapacitated(char) {
    return !char || (char.status || []).includes('incapacitado') || char.hp <= 0;
  }

  isPlayersTurn(session, playerId) {
    return Boolean(session.turn) && session.turn.current === playerId;
  }

  advanceTurn(session) {
    const t = session.turn;
    if (!t) return null;

    // Ao sair do turno de um player: reduz CDs
    if (t.current && t.current !== 'gm') {
      const leaving = session.characters[t.current];
      tickCooldowns(leaving);
    }

    const order = t.order || [];
    for (let step = 0; step <= order.length; step += 1) {
      t.index += 1;
      if (t.index >= order.length) {
        t.index = 0;
        t.round += 1;
      }
      const id = order[t.index];
      if (id === 'gm') {
        t.current = 'gm';
        return 'gm';
      }
      if (!this.isIncapacitated(session.characters[id])) {
        // Início do turno do player: buffs "até próximo turno" caem
        const char = session.characters[id];
        if (char) {
          char.tempDefenseBonus = 0;
          char.tempAttackBonus = 0;
          char.defense = char.baseDefense || char.defense;
        }
        t.current = id;
        return id;
      }
    }
    t.current = 'gm';
    return 'gm';
  }

  checkOutcome(session) {
    const enemiesAlive = session.enemies.some((e) => e.hp > 0);
    const playersAlive = Object.values(session.characters).some((c) => !this.isIncapacitated(c));
    if (!enemiesAlive) return 'victory';
    if (!playersAlive) return 'defeat';
    return null;
  }

  turnPayload(session) {
    const t = session.turn || {};
    const nameFor = (id) => (id === 'gm' ? 'Mestre' : session.characters[id]?.name || 'Jogador');
    return {
      current: t.current || null,
      currentName: nameFor(t.current),
      round: t.round || 1,
      order: (t.order || []).map((id) => ({
        id,
        kind: id === 'gm' ? 'gm' : 'player',
        name: nameFor(id),
        down: id !== 'gm' && this.isIncapacitated(session.characters[id]),
      })),
      outcome: session.outcome || null,
    };
  }

  runGmTurn(session, { intro = false } = {}) {
    const combat = [];
    const effects = [];
    const livingEnemies = session.enemies.filter((e) => e.hp > 0);

    if (!intro) {
      for (const enemy of livingEnemies) {
        const targets = Object.values(session.characters).filter((c) => !this.isIncapacitated(c));
        if (!targets.length) break;
        const target = targets.slice().sort((a, b) => a.hp / a.hpMax - b.hp / b.hpMax)[0];
        const mercy = this.rules.mercyFor(target);
        const atk = this.rules.resolveAttack(enemy, target, { isNpc: true, mercyMods: mercy.mods });
        const downed = this.isIncapacitated(target);
        combat.push({
          summary: atk.hit
            ? `${enemy.name} atinge ${target.name} (${atk.damage} de dano).${downed ? ` ${target.name} cai!` : ''}`
            : `${enemy.name} avança sobre ${target.name}, mas erra.`,
          outcome: atk.outcome,
          damage: atk.damage || 0,
        });
        effects.push({ type: 'attack', attackerId: enemy.id, targetId: target.id, outcome: atk.outcome, damage: atk.damage || 0 });
        if (downed) effects.push({ type: 'death', id: target.id });
      }
    }

    this.syncEntities(session);

    let narrative;
    if (intro) {
      narrative = livingEnemies.length
        ? `A cena se abre na Taverna de Arton. ${livingEnemies.map((e) => e.name).join(', ')} encaram a party com hostilidade. Preparem-se.`
        : 'A cena se abre na Taverna de Arton. O salão está tenso e silencioso.';
    } else if (combat.some((c) => c.summary)) {
      narrative = combat.map((c) => c.summary).filter(Boolean).join(' ');
    } else {
      narrative = livingEnemies.length ? 'Os inimigos recuam e observam, à espreita.' : 'Nenhum inimigo de pé.';
    }

    return { narrative, combat, effects };
  }

  openingTurn(session) {
    const gm = this.runGmTurn(session, { intro: true });
    session.outcome = this.checkOutcome(session);
    if (!session.outcome) this.advanceTurn(session);
    this.syncEntities(session);
    GameFinder.saveSession(session).catch(() => {});
    return {
      segment: { by: 'gm', name: 'Mestre', ...gm },
      turn: this.turnPayload(session),
      outcome: session.outcome,
    };
  }

  progressAfterActor(session) {
    const segments = [];
    session.outcome = this.checkOutcome(session);
    if (session.outcome) return { segments, outcome: session.outcome };

    const next = this.advanceTurn(session);
    if (next === 'gm') {
      const gm = this.runGmTurn(session);
      segments.push({ by: 'gm', name: 'Mestre', ...gm });
      session.outcome = this.checkOutcome(session);
      if (!session.outcome) this.advanceTurn(session);
    }
    return { segments, outcome: session.outcome };
  }

  async submitPlayerAction(session, playerId, rawText) {
    const playerSeg = await this.resolvePlayerAction(session, playerId, rawText);
    const prog = this.progressAfterActor(session);
    this.syncEntities(session);
    GameFinder.saveSession(session).catch(() => {});
    return {
      segments: [playerSeg, ...prog.segments],
      turn: this.turnPayload(session),
      outcome: prog.outcome,
      hud: hudPayload(session.characters[playerId]),
    };
  }

  async submitPlayerSkill(session, playerId, skillKey, targetHint) {
    const actor = session.characters[playerId];
    if (!actor) throw new Error('Personagem não encontrado.');
    if (this.isIncapacitated(actor)) throw new Error('Personagem incapacitado.');

    const rank = actor.skillRanks?.[skillKey] || 0;
    if (rank <= 0) throw new Error('Você não possui esta habilidade.');
    const skillDef = SKILLS[skillKey];
    if (!skillDef) throw new Error('Habilidade desconhecida.');

    let target = null;
    if (skillDef.type === 'heal') {
      target = this.findTarget(session, targetHint || 'self', playerId) || actor;
    } else if (skillDef.type !== 'buff_self') {
      target = this.findTarget(session, targetHint || null, playerId);
      if (!target || target.kind === 'player') throw new Error('Escolha um inimigo válido.');
    }

    const res = this.rules.resolveSkill(actor, target, skillKey, skillDef, rank);
    if (!res.ok) throw new Error(res.reason || 'Falha ao usar habilidade.');

    // Recalcula defesa com buff
    actor.defense = (actor.baseDefense || actor.defense) + (actor.tempDefenseBonus || 0);

    const combat = [];
    const effects = [];
    let summary = res.summary || `${actor.name} usa ${skillDef.label}.`;

    if (res.healed) {
      summary = `${actor.name} usa ${skillDef.label} e cura ${res.healed} PV de ${(target || actor).name}.`;
      effects.push({
        type: 'cast',
        casterId: actor.id,
        targetId: (target || actor).id,
        spell: skillDef.label,
        healed: res.healed,
        damage: 0,
      });
    } else if (res.damage) {
      const downed = target && target.hp <= 0;
      summary = res.hit
        ? `${actor.name} usa ${skillDef.label} em ${target.name} (${res.damage} de dano).${downed ? ` ${target.name} cai!` : ''}`
        : `${actor.name} usa ${skillDef.label}, mas erra.`;
      effects.push({
        type: skillDef.type === 'auto_damage' || skillDef.type === 'damage_save' ? 'cast' : 'attack',
        attackerId: actor.id,
        casterId: actor.id,
        targetId: target.id,
        outcome: res.outcome,
        damage: res.damage || 0,
        spell: skillDef.label,
      });
      if (downed) effects.push({ type: 'death', id: target.id });
    } else if (skillDef.type === 'buff_self') {
      effects.push({ type: 'cast', casterId: actor.id, targetId: actor.id, spell: skillDef.label, healed: 0, damage: 0 });
    }

    combat.push({
      summary,
      outcome: res.outcome || 'ok',
      damage: res.damage || 0,
      healed: res.healed || 0,
    });

    this.syncEntities(session);
    const narrative = summary;
    session.log.push({ at: Date.now(), playerId, rawText: `[skill:${skillKey}]`, narrative });
    if (session.log.length > 40) session.log.shift();
    GameFinder.logAction(session.id, playerId, `[skill:${skillKey}]`, { narrative, combat }).catch(() => {});

    const playerSeg = {
      by: 'player',
      playerId,
      name: actor.name,
      narrative,
      effects,
      combat,
    };

    const prog = this.progressAfterActor(session);
    this.syncEntities(session);
    GameFinder.saveSession(session).catch(() => {});

    return {
      segments: [playerSeg, ...prog.segments],
      turn: this.turnPayload(session),
      outcome: prog.outcome,
      hud: hudPayload(session.characters[playerId]),
    };
  }

  skipCurrent(session) {
    const prog = this.progressAfterActor(session);
    this.syncEntities(session);
    GameFinder.saveSession(session).catch(() => {});
    return {
      segments: prog.segments,
      turn: this.turnPayload(session),
      outcome: prog.outcome,
    };
  }

  async resolvePlayerAction(session, playerId, rawText) {
    const actor = session.characters[playerId];
    if (!actor) throw new Error('Personagem não encontrado.');

    const memory = await GameFinder.getGmMemory(session.id).catch(() => '');
    const mercy = this.rules.mercyFor(actor);
    const gmOut = await this.gm.narrate({ action: rawText, actor, session, memory, mercy });

    const combat = [];
    const effects = [];

    for (const intent of gmOut.intents || []) {
      const resolved = this.applyIntent(session, playerId, intent, mercy);
      if (resolved) {
        combat.push(resolved);
        if (resolved.effects) effects.push(...resolved.effects);
      }
    }

    // Fallback: texto claramente ofensivo sem intent de combate (sem contra-ataque — inimigos agem no turno do Mestre)
    if (!combat.length && /atac|golpe|bater|ferir|lutar/i.test(rawText)) {
      const target = this.findTarget(session, null, playerId);
      if (target && target.kind !== 'player') {
        const atk = this.rules.resolveAttack(actor, target);
        const downed = target.hp <= 0;
        combat.push({
          summary: atk.hit
            ? `${actor.name} acerta ${target.name} (${atk.damage} de dano).${downed ? ` ${target.name} cai!` : ''}`
            : `${actor.name} erra o ataque contra ${target.name}.`,
          outcome: atk.outcome,
          damage: atk.damage || 0,
        });
        effects.push({ type: 'attack', attackerId: actor.id, targetId: target.id, outcome: atk.outcome, damage: atk.damage || 0 });
        if (downed) effects.push({ type: 'death', id: target.id });
      }
    }

    this.syncEntities(session);
    const narrative = this.composeNarrative(gmOut.narrative, combat, mercy);

    session.log.push({ at: Date.now(), playerId, rawText, narrative });
    if (session.log.length > 40) session.log.shift();

    const summaryLine = `${actor.name}: ${rawText} → ${narrative.slice(0, 180)}`;
    const newMem = `${memory}\n${summaryLine}`.slice(-4000);
    GameFinder.saveGmMemory(session.id, newMem).catch(() => {});
    GameFinder.logAction(session.id, playerId, rawText, { narrative, combat }).catch(() => {});

    return {
      by: 'player',
      playerId,
      name: actor.name,
      narrative,
      effects,
      combat: combat.map((c) => ({
        summary: c.summary,
        outcome: c.outcome || (c.hit ? 'hit' : c.ok === false ? 'fail' : 'ok'),
        damage: c.damage || 0,
        healed: c.healed || 0,
      })),
      mercyScore: mercy.score,
    };
  }

  applyIntent(session, playerId, intent, mercy) {
    const actor = session.characters[playerId];
    const type = intent.type || 'wait';

    if (type === 'move') {
      const fromX = actor.x;
      const fromY = actor.y;
      if (intent.x != null && intent.y != null) {
        actor.x = Math.max(0, Math.min(session.mapW - 1, Number(intent.x)));
        actor.y = Math.max(0, Math.min(session.mapH - 1, Number(intent.y)));
      } else {
        const dx = Number(intent.dx || 0);
        const dy = Number(intent.dy || 0);
        actor.x = Math.max(0, Math.min(session.mapW - 1, actor.x + dx));
        actor.y = Math.max(0, Math.min(session.mapH - 1, actor.y + dy));
      }
      return {
        summary: `${actor.name} se desloca.`,
        outcome: 'ok',
        effects: [{ type: 'move', id: actor.id, fromX, fromY, x: actor.x, y: actor.y }],
      };
    }

    if (type === 'attack') {
      const target = this.findTarget(session, intent.targetId || intent.target, playerId);
      if (!target || target.kind === 'player') {
        return { summary: `${actor.name} não encontra um alvo válido.`, outcome: 'fail' };
      }
      const atk = this.rules.resolveAttack(actor, target);
      const downed = target.hp <= 0;
      const out = {
        summary: atk.hit
          ? `${actor.name} acerta ${target.name}${atk.isCrit ? ' em cheio' : ''} (${atk.damage} de dano).${downed ? ` ${target.name} cai!` : ''}`
          : `${actor.name} erra o golpe em ${target.name}.`,
        outcome: atk.outcome,
        damage: atk.damage || 0,
        effects: [{ type: 'attack', attackerId: actor.id, targetId: target.id, outcome: atk.outcome, damage: atk.damage || 0 }],
      };
      if (downed) out.effects.push({ type: 'death', id: target.id });
      return out;
    }

    if (type === 'cast') {
      const spellKey = intent.spellKey || intent.skillHint;
      let target = this.findTarget(session, intent.targetId || intent.target || 'self', playerId);
      if (!target) target = actor;
      const res = this.rules.resolveSpell(actor, target, spellKey);
      if (!res.ok) return { summary: res.reason || 'Falha ao conjurar.', outcome: 'fail' };
      const downed = target.kind === 'enemy' && target.hp <= 0;
      const effects = [{
        type: 'cast',
        casterId: actor.id,
        targetId: target.id,
        spell: res.spell,
        damage: res.damage || 0,
        healed: res.healed || 0,
      }];
      if (downed) effects.push({ type: 'death', id: target.id });
      return {
        summary: res.healed
          ? `${actor.name} conjura ${res.spell} e recupera ${res.healed} PV de ${target.name}.`
          : res.damage
            ? `${actor.name} conjura ${res.spell} em ${target.name} (${res.damage} de dano).${downed ? ` ${target.name} cai!` : ''}`
            : `${actor.name} conjura ${res.spell}.`,
        outcome: 'ok',
        damage: res.damage || 0,
        healed: res.healed || 0,
        effects,
      };
    }

    if (type === 'skill') {
      const skillKey = intent.skillKey || intent.skillHint;
      const rank = actor.skillRanks?.[skillKey] || 0;
      const skillDef = SKILLS[skillKey];
      if (!skillDef || rank <= 0) {
        return { summary: `${actor.name} tenta uma habilidade que não conhece.`, outcome: 'fail' };
      }
      let target = null;
      if (skillDef.type === 'heal') {
        target = this.findTarget(session, intent.targetId || intent.target || 'self', playerId) || actor;
      } else if (skillDef.type !== 'buff_self') {
        target = this.findTarget(session, intent.targetId || intent.target, playerId);
      }
      const res = this.rules.resolveSkill(actor, target, skillKey, skillDef, rank);
      if (!res.ok) return { summary: res.reason || 'Falha na habilidade.', outcome: 'fail' };
      actor.defense = (actor.baseDefense || actor.defense) + (actor.tempDefenseBonus || 0);
      const downed = target && target.kind === 'enemy' && target.hp <= 0;
      const effects = [];
      if (res.damage || res.healed) {
        effects.push({
          type: res.healed ? 'cast' : 'attack',
          attackerId: actor.id,
          casterId: actor.id,
          targetId: (target || actor).id,
          outcome: res.outcome,
          damage: res.damage || 0,
          healed: res.healed || 0,
          spell: skillDef.label,
        });
      } else {
        effects.push({ type: 'cast', casterId: actor.id, targetId: actor.id, spell: skillDef.label, damage: 0, healed: 0 });
      }
      if (downed) effects.push({ type: 'death', id: target.id });
      return {
        summary: res.healed
          ? `${actor.name} usa ${skillDef.label} e cura ${res.healed} PV.`
          : res.damage
            ? `${actor.name} usa ${skillDef.label} (${res.damage} de dano).${downed ? ` ${target.name} cai!` : ''}`
            : `${actor.name} usa ${skillDef.label}.`,
        outcome: res.outcome || 'ok',
        damage: res.damage || 0,
        healed: res.healed || 0,
        effects,
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
