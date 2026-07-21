const { v4: uuidv4 } = require('uuid');
const { ENEMY_TEMPLATES } = require('../rules/catalog');
const { scaleEncounter, applyScaleToEnemy } = require('../rules/EncounterScaler');
const RulesEngine = require('../rules/RulesEngine');
const { hudPayload } = require('../character/CharacterService');
const GameFinder = require('../db/GameFinder');
const GmService = require('../gm/GmService');
const { SKILLS, tickCooldowns } = require('../rules/skills');
const {
  layoutKeyForAdventure,
  seedNpcsForLayout,
  upsertNpcs,
  buildSceneTiles,
} = require('./SceneBuilder');
const {
  buildFallbackCampaign,
  currentRoom,
  questPayload,
} = require('./AdventureCampaign');

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

    // RPG de mesa: campanha multi-sala (objetivos + progressão).
    const enemies = [];
    const adventure = this.gm.pickAdventureSeed();
    const campaign = buildFallbackCampaign(adventure);
    const room0 = campaign.rooms[0];
    const layoutKey = room0.layoutKey || layoutKeyForAdventure(adventure);
    adventure.layoutKey = layoutKey;

    const session = {
      id: uuidv4(),
      partyId: party.id,
      mapId: layoutKey,
      mapW: MAP_W,
      mapH: MAP_H,
      encounterBudget: scale.budget,
      scale,
      adventure,
      campaign,
      inCombat: false,
      characters,
      enemies,
      npcs: [],
      world: {
        mapId: layoutKey,
        mapW: MAP_W,
        mapH: MAP_H,
        layoutKey,
        entities,
        tiles: buildSceneTiles(layoutKey, MAP_W, MAP_H),
      },
      log: [],
      turn: null,
      outcome: null,
      createdAt: Date.now(),
    };

    upsertNpcs(session, room0.npcs?.length ? room0.npcs : seedNpcsForLayout(layoutKey));

    session.turn = {
      order: ['gm', ...members.map((m) => m.playerId)],
      index: 0,
      round: 1,
      current: 'gm',
    };

    party.status = 'active';
    party.sessionId = session.id;
    this.sessions.set(session.id, session);
    this.syncEntities(session);

    GameFinder.saveParty(party).catch(() => {});
    GameFinder.saveSession(session).catch(() => {});
    GameFinder.saveGmMemory(
      session.id,
      `Aventura: ${adventure.title}. Cenário: ${adventure.setting}. Gancho: ${adventure.hook}. Party de ${partySize}. Modo: narrativa (sem combate ainda).`
    ).catch(() => {});

    return session;
  }

  /**
   * Entra em combate com ameaça alinhada à aventura (não goblin genérico no start).
   */
  beginCombat(session, { reason = 'ameaça' } = {}) {
    if (session.inCombat && session.enemies.some((e) => e.hp > 0)) {
      return { spawned: false, enemies: session.enemies };
    }

    const scale = session.scale || scaleEncounter(Object.keys(session.characters).length, { cr: 1 });
    const templates = this.templatesForAdventure(session.adventure);
    const count = Math.max(1, Math.min(scale.enemyCount || 1, 3));
    const enemies = [];

    for (let i = 0; i < count; i += 1) {
      const tpl = templates[i % templates.length];
      const scaled = applyScaleToEnemy(tpl, scale);
      enemies.push({
        id: uuidv4(),
        kind: 'enemy',
        key: scaled.key,
        name: `${scaled.name}${count > 1 ? ` ${i + 1}` : ''}`,
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
        mercy: { deaths: 0, failStreak: 0, timeouts: 0 },
      });
    }

    session.enemies = enemies;
    session.inCombat = true;
    this.syncEntities(session);
    return { spawned: true, enemies, reason };
  }

  templatesForAdventure(adventure) {
    const title = String(adventure?.title || '').toLowerCase();
    if (/estrada|mensageiro|escolta|sombra/.test(title)) {
      return [ENEMY_TEMPLATES.bandido, ENEMY_TEMPLATES.lobo];
    }
    if (/porto|motim|marin/.test(title)) return [ENEMY_TEMPLATES.bandido];
    if (/ruína|tormenta|funeral|corvo/.test(title)) {
      return [ENEMY_TEMPLATES.goblin, ENEMY_TEMPLATES.lobo];
    }
    if (/cálice|taverna/.test(title)) {
      return [ENEMY_TEMPLATES.bandido, ENEMY_TEMPLATES.goblin];
    }
    return [ENEMY_TEMPLATES.bandido];
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

  removeByParty(partyId) {
    const session = this.getByParty(partyId);
    if (session) this.sessions.delete(session.id);
    return Boolean(session);
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
      adventure: snapshot.adventure || null,
      campaign: snapshot.campaign || null,
      inCombat: Boolean(snapshot.inCombat) || (snapshot.enemies || []).some((e) => e.hp > 0),
      characters: snapshot.characters || {},
      enemies: snapshot.enemies || [],
      npcs: snapshot.npcs || [],
      world: snapshot.world || {
        mapId: snapshot.mapId || 'tavern',
        mapW: snapshot.mapW || MAP_W,
        mapH: snapshot.mapH || MAP_H,
        entities: [],
        tiles: buildSceneTiles(snapshot.adventure?.layoutKey || 'tavern', MAP_W, MAP_H),
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
    for (const n of session.npcs || []) {
      entities.push({
        id: n.id,
        kind: 'npc',
        name: n.name,
        role: n.role,
        mood: n.mood,
        x: n.x,
        y: n.y,
        color: n.color,
        interactable: true,
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
    session.world.layoutKey = session.adventure?.layoutKey || session.world.layoutKey || session.mapId;
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
    const playersAlive = Object.values(session.characters).some((c) => !this.isIncapacitated(c));
    if (!playersAlive) return 'defeat';

    // Sem combate ativo / sem inimigos: aventura narrativa continua (não é vitória automática).
    if (!session.inCombat) return null;
    const enemiesAlive = session.enemies.some((e) => e.hp > 0);
    if (!enemiesAlive) {
      session.inCombat = false;
      return null; // encontro vencido; história segue (não encerra a sessão)
    }
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

    // Fora de combate: mestre só narra — não ataca a party.
    if (!intro && session.inCombat && livingEnemies.length) {
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
      const adv = session.adventure;
      narrative = adv
        ? `Aventura: ${adv.title}. ${adv.setting}. ${adv.hook}`
        : 'A cena se abre. A aventura começa.';
    } else if (combat.some((c) => c.summary)) {
      narrative = combat.map((c) => c.summary).filter(Boolean).join(' ');
    } else if (session.inCombat && livingEnemies.length) {
      narrative = 'Os inimigos observam, à espreita.';
    } else {
      narrative = 'A cena segue. O que a party faz?';
    }

    return { narrative, combat, effects };
  }

  /**
   * Aplica layout/NPCs da sala atual da campanha ao tabuleiro.
   */
  applyCurrentRoom(session, { resetPlayers = true } = {}) {
    const room = currentRoom(session.campaign);
    if (!room) return null;
    const layoutKey = room.layoutKey || 'tavern';
    session.mapId = layoutKey;
    session.world.mapId = layoutKey;
    session.world.layoutKey = layoutKey;
    session.world.tiles = buildSceneTiles(layoutKey, session.mapW, session.mapH);
    session.inCombat = false;
    session.enemies = [];
    session.npcs = [];
    upsertNpcs(session, room.npcs?.length ? room.npcs : seedNpcsForLayout(layoutKey));
    if (resetPlayers) {
      let i = 0;
      for (const c of Object.values(session.characters)) {
        c.x = 2 + (i % 4);
        c.y = 7 + Math.floor(i / 4);
        i += 1;
      }
    }
    this.syncEntities(session);
    return room;
  }

  /**
   * Avança para a próxima sala se o objetivo foi cumprido.
   * @returns {{ advanced: boolean, finished: boolean, segment?: object, quest?: object }}
   */
  tryAdvanceRoom(session, objectiveProgress) {
    if (objectiveProgress !== 'complete' || !session.campaign) {
      return { advanced: false, finished: false, quest: questPayload(session.campaign) };
    }

    const camp = session.campaign;
    const room = currentRoom(camp);
    if (room) room.status = 'done';
    camp.completedCount = (camp.completedCount || 0) + 1;

    if (camp.roomIndex >= camp.rooms.length - 1) {
      return {
        advanced: false,
        finished: true,
        quest: questPayload(camp),
        segment: {
          by: 'gm',
          name: 'Mestre',
          narrative:
            `Objetivo cumprido em ${room?.name || 'cena final'}! A aventura "${camp.title}" chega ao fim. ` +
            `A party escreveu mais um capítulo em Arton.`,
          combat: [],
          effects: [],
        },
      };
    }

    camp.roomIndex += 1;
    const next = currentRoom(camp);
    if (next) next.status = 'active';
    this.applyCurrentRoom(session, { resetPlayers: true });

    return {
      advanced: true,
      finished: false,
      quest: questPayload(camp),
      segment: {
        by: 'gm',
        name: 'Mestre',
        narrative:
          `Objetivo cumprido! A party deixa ${room?.name || 'a cena anterior'} e chega a ${next.name}. ` +
          `Novo objetivo: ${next.objective}`,
        combat: [],
        effects: [{ type: 'spawn', id: session.npcs[0]?.id, kind: 'npc', name: session.npcs[0]?.name }],
      },
    };
  }

  questPayload(session) {
    return questPayload(session.campaign);
  }

  async openingTurn(session) {
    const base = this.runGmTurn(session, { intro: true });
    try {
      const generated = await this.gm.generateCampaign(session);
      if (generated.campaign) {
        session.campaign = generated.campaign;
        session.adventure = {
          ...(session.adventure || {}),
          title: generated.campaign.title,
          hook: generated.campaign.premise,
          setting: generated.campaign.rooms?.[0]?.name,
          layoutKey: generated.campaign.rooms?.[0]?.layoutKey,
        };
        this.applyCurrentRoom(session, { resetPlayers: true });
      }
      if (generated.narrative) base.narrative = generated.narrative;
      if (Array.isArray(generated.npcs) && generated.npcs.length) {
        session.npcs = [];
        upsertNpcs(session, generated.npcs);
      }
      const room = currentRoom(session.campaign);
      const objLine = room ? ` [Objetivo: ${room.objective}]` : '';
      GameFinder.saveGmMemory(
        session.id,
        `Campanha: ${session.campaign?.title || ''} | Sala 1/${session.campaign?.rooms?.length || '?'} ${room?.name || ''} — ${generated.narrative}${objLine}`.slice(0, 4000)
      ).catch(() => {});
    } catch (err) {
      console.error('[opening]', err.message);
    }

    this.syncEntities(session);
    session.log.push({ at: Date.now(), playerId: null, rawText: '[intro]', narrative: base.narrative });
    session.outcome = this.checkOutcome(session);
    if (!session.outcome) this.advanceTurn(session);
    this.syncEntities(session);
    GameFinder.saveSession(session).catch(() => {});
    return {
      segment: { by: 'gm', name: 'Mestre', ...base },
      turn: this.turnPayload(session),
      outcome: session.outcome,
      quest: questPayload(session.campaign),
    };
  }

  progressAfterActor(session) {
    const segments = [];
    session.outcome = this.checkOutcome(session);
    if (session.outcome) return { segments, outcome: session.outcome };

    let next = this.advanceTurn(session);

    // Fora de combate: o mestre já narraram em resolvePlayerAction.
    // Não emite o "A cena segue" genérico nem gasta um turno vazio do GM.
    if (next === 'gm' && !session.inCombat) {
      next = this.advanceTurn(session);
    }

    if (next === 'gm' && session.inCombat) {
      const gm = this.runGmTurn(session);
      if (gm.narrative || (gm.combat && gm.combat.length)) {
        segments.push({ by: 'gm', name: 'Mestre', ...gm });
      }
      session.outcome = this.checkOutcome(session);
      if (!session.outcome) this.advanceTurn(session);
    }
    return { segments, outcome: session.outcome };
  }

  async submitPlayerAction(session, playerId, rawText) {
    const playerSeg = await this.resolvePlayerAction(session, playerId, rawText);
    const segments = [playerSeg];

    const advance = this.tryAdvanceRoom(session, playerSeg.objectiveProgress);
    if (advance.segment) segments.push(advance.segment);

    let outcome = null;
    if (advance.finished) {
      session.outcome = 'victory';
      outcome = 'victory';
    } else {
      const prog = this.progressAfterActor(session);
      segments.push(...prog.segments);
      outcome = prog.outcome;
    }

    this.syncEntities(session);
    GameFinder.saveSession(session).catch(() => {});
    return {
      segments,
      turn: this.turnPayload(session),
      outcome,
      hud: hudPayload(session.characters[playerId]),
      quest: advance.quest || questPayload(session.campaign),
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

    // NPCs sugeridos pelo mestre entram no tabuleiro
    if (Array.isArray(gmOut.npcs) && gmOut.npcs.length) {
      const added = upsertNpcs(session, gmOut.npcs);
      for (const n of added) {
        effects.push({ type: 'spawn', id: n.id, kind: 'npc', name: n.name, x: n.x, y: n.y });
      }
    }

    // Se o jogador partiu para a luta e ainda não há encontro, inicia combate alinhado à aventura.
    const wantsFight = (gmOut.intents || []).some((i) =>
      i.type === 'attack' || i.type === 'cast' || i.type === 'skill'
    );
    if (wantsFight && !session.enemies.some((e) => e.hp > 0)) {
      const started = this.beginCombat(session, { reason: 'ação hostil do jogador' });
      if (started.spawned) {
        const names = started.enemies.map((e) => e.name).join(', ');
        gmOut.narrative = `${gmOut.narrative || ''} Das sombras surge o confronto: ${names}!`.trim();
        // Garante um alvo se o intent veio sem inimigo prévio
        for (const intent of gmOut.intents || []) {
          if ((intent.type === 'attack' || intent.type === 'cast' || intent.type === 'skill') && !intent.targetId) {
            intent.targetId = started.enemies[0]?.name || null;
          }
        }
      }
    }

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
      objectiveProgress: gmOut.objectiveProgress || 'none',
      objectiveNote: gmOut.objectiveNote || null,
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
      if (!session.enemies.some((e) => e.hp > 0)) {
        return {
          summary: `${actor.name} se prepara para lutar, mas ainda não há inimigo em combate.`,
          outcome: 'fail',
        };
      }
      session.inCombat = true;
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

    if (type === 'talk') {
      const hint = String(intent.targetId || intent.target || '').toLowerCase();
      const npc = (session.npcs || []).find((n) =>
        !hint || n.name.toLowerCase().includes(hint) || n.role === hint
      );
      if (npc) {
        return {
          summary: `${actor.name} conversa com ${npc.name}.`,
          outcome: 'ok',
          effects: [{ type: 'focus', id: npc.id }],
        };
      }
      return { summary: null, outcome: 'ok' };
    }

    if (type === 'inspect' || type === 'wait' || type === 'use_item') {
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
    return parts.filter(Boolean).join(' ') || 'A cena aguarda a próxima ação.';
  }
}

module.exports = GameSessionService;
