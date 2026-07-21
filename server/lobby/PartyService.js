const { v4: uuidv4 } = require('uuid');
const config = require('../config');
const GameFinder = require('../db/GameFinder');
const { partyMemberPublic, RACES, CLASSES, WEAPONS } = require('../character/CharacterService');

function partyCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i += 1) {
    code += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return code;
}

function classColor(classKey) {
  return {
    guerreiro: '#c45c2a',
    ladino: '#4a8f6a',
    clerigo: '#d4b84a',
    arcanista: '#5a6ac8',
  }[classKey] || '#aaaaaa';
}

function hydrateCharacterFromRow(row) {
  if (!row) return null;
  const raceKey = row.race;
  const classKey = row.class_key;
  const race = RACES[raceKey] || RACES.humano;
  const klass = CLASSES[classKey] || CLASSES.guerreiro;
  const weapon = WEAPONS[row.weapon_key] || WEAPONS.clava;
  const meta = row.skillsMeta || {};
  return {
    id: row.id,
    playerId: row.player_id,
    partyId: row.party_id,
    name: row.name,
    race: raceKey,
    raceLabel: race.label,
    classKey,
    classLabel: klass.label,
    level: row.level,
    attrs: row.attrs || {},
    hp: row.hp,
    hpMax: row.hp_max,
    mp: row.mp,
    mpMax: row.mp_max,
    defense: row.defense,
    baseDefense: meta.baseDefense || row.defense,
    weaponKey: row.weapon_key,
    weaponLabel: weapon.label,
    spells: [...(klass.spells || [])],
    skillRanks: meta.skillRanks || {},
    knownSkills: meta.knownSkills || [],
    powerPointsSpent: meta.powerPointsSpent || 0,
    powerPointsBudget: meta.powerPointsBudget || 1,
    powerPointsRemaining: meta.powerPointsRemaining || 0,
    skillCooldowns: meta.skillCooldowns || {},
    tempDefenseBonus: 0,
    tempAttackBonus: 0,
    raceTraits: meta.raceTraits || [],
    raceTraitsCombat: meta.raceTraitsCombat || {},
    status: row.status || [],
    inventory: row.inventory || [],
    mercy: row.mercy || { deaths: 0, failStreak: 0, punishments: 0 },
    x: 4,
    y: 4,
    color: classColor(classKey),
    kind: 'player',
  };
}

class PartyService {
  constructor() {
    this.parties = new Map();
    this.codeIndex = new Map();
    this.playerParty = new Map();
  }

  create(host) {
    const existing = this.playerParty.get(host.id);
    if (existing) this.leave(host.id);

    const id = uuidv4();
    const code = partyCode();
    const party = {
      id,
      code,
      hostId: host.id,
      status: 'lobby',
      maxSize: config.limits.partyMax,
      members: new Map(),
      sessionId: null,
    };
    party.members.set(host.id, {
      playerId: host.id,
      nickname: host.nickname,
      ready: false,
      character: null,
      socketId: host.socketId,
    });

    this.parties.set(id, party);
    this.codeIndex.set(code, id);
    this.playerParty.set(host.id, id);
    GameFinder.saveParty(party).catch(() => {});
    GameFinder.savePartyMember(id, host.id, 0).catch(() => {});
    return this.snapshot(party);
  }

  join(code, player) {
    const id = this.codeIndex.get(String(code).toUpperCase());
    const party = this.parties.get(id);
    if (!party) throw new Error('Party não encontrada.');
    if (party.status === 'ended') throw new Error('Party encerrada.');
    if (party.members.size >= party.maxSize) throw new Error('Party cheia (máx. 10).');
    if (party.status === 'active') throw new Error('Sessão já em andamento — use Meus Jogos para reentrar.');

    const prev = this.playerParty.get(player.id);
    if (prev && prev !== party.id) this.leave(player.id);

    party.members.set(player.id, {
      playerId: player.id,
      nickname: player.nickname,
      ready: false,
      character: null,
      socketId: player.socketId,
    });
    this.playerParty.set(player.id, party.id);
    GameFinder.savePartyMember(party.id, player.id, 0).catch(() => {});
    return this.snapshot(party);
  }

  leave(playerId) {
    const partyId = this.playerParty.get(playerId);
    if (!partyId) return null;
    const party = this.parties.get(partyId);
    this.playerParty.delete(playerId);
    if (!party) return null;

    // Em partida ativa, só desconecta (mantém membership para reentrada).
    if (party.status === 'active') {
      const m = party.members.get(playerId);
      if (m) m.socketId = null;
      return this.snapshot(party);
    }

    party.members.delete(playerId);
    GameFinder.removePartyMember(partyId, playerId).catch(() => {});

    if (party.members.size === 0) {
      this.parties.delete(partyId);
      this.codeIndex.delete(party.code);
      party.status = 'ended';
      GameFinder.saveParty(party).catch(() => {});
      return null;
    }

    if (party.hostId === playerId) {
      party.hostId = [...party.members.keys()][0];
      GameFinder.saveParty(party).catch(() => {});
    }
    return this.snapshot(party);
  }

  getByPlayer(playerId) {
    const id = this.playerParty.get(playerId);
    return id ? this.parties.get(id) : null;
  }

  get(partyId) {
    return this.parties.get(partyId) || null;
  }

  setSocket(playerId, socketId) {
    const party = this.getByPlayer(playerId);
    if (!party) return;
    const m = party.members.get(playerId);
    if (m) m.socketId = socketId;
  }

  attachPlayer(partyId, player) {
    const party = this.parties.get(partyId);
    if (!party) throw new Error('Party não encontrada.');
    if (!party.members.has(player.id)) throw new Error('Você não participa desta party.');
    const prev = this.playerParty.get(player.id);
    if (prev && prev !== partyId) {
      const prevParty = this.parties.get(prev);
      if (prevParty && prevParty.status !== 'active') this.leave(player.id);
      else if (prevParty) {
        const old = prevParty.members.get(player.id);
        if (old) old.socketId = null;
        if (this.playerParty.get(player.id) === prev) this.playerParty.delete(player.id);
      }
    }
    this.playerParty.set(player.id, partyId);
    const m = party.members.get(player.id);
    m.nickname = player.nickname || m.nickname;
    m.socketId = player.socketId;
    return this.snapshot(party);
  }

  startHall(playerId) {
    const party = this.getByPlayer(playerId);
    if (!party) throw new Error('Você não está em uma party.');
    if (party.hostId !== playerId) throw new Error('Só o host pode iniciar o hall.');
    if (party.members.size < config.limits.partyMin) throw new Error('Party vazia.');
    party.status = 'hall';
    for (const m of party.members.values()) m.ready = false;
    GameFinder.saveParty(party).catch(() => {});
    return this.snapshot(party);
  }

  setCharacter(playerId, character) {
    const party = this.getByPlayer(playerId);
    if (!party) throw new Error('Sem party.');
    if (party.status !== 'hall' && party.status !== 'lobby') {
      throw new Error('Criação de personagem fechada.');
    }
    if (party.status === 'lobby') party.status = 'hall';
    const m = party.members.get(playerId);
    m.character = character;
    m.ready = false;
    GameFinder.saveCharacter(character).catch(() => {});
    return this.snapshot(party);
  }

  setReady(playerId, ready = true) {
    const party = this.getByPlayer(playerId);
    if (!party) throw new Error('Sem party.');
    const m = party.members.get(playerId);
    if (!m.character) throw new Error('Crie o personagem antes.');
    m.ready = !!ready;
    GameFinder.savePartyMember(party.id, playerId, m.ready).catch(() => {});
    return this.snapshot(party);
  }

  endParty(partyId) {
    const party = this.parties.get(partyId);
    if (!party) return null;
    party.status = 'ended';
    for (const pid of party.members.keys()) {
      if (this.playerParty.get(pid) === partyId) this.playerParty.delete(pid);
    }
    GameFinder.saveParty(party).catch(() => {});
    return this.snapshot(party);
  }

  async rehydrateFromDb(partyId, sessionId = null) {
    if (this.parties.has(partyId)) return this.snapshot(this.parties.get(partyId));

    const row = await GameFinder.loadPartyById(partyId);
    if (!row) return null;

    const membersRows = await GameFinder.loadPartyMembers(partyId);
    const charRows = await GameFinder.loadCharactersByParty(partyId);
    const charByPlayer = new Map(charRows.map((c) => [c.player_id, hydrateCharacterFromRow(c)]));

    const party = {
      id: row.id,
      code: row.code,
      hostId: row.host_id,
      name: row.name || null,
      status: row.status,
      maxSize: row.max_size || config.limits.partyMax,
      members: new Map(),
      sessionId: sessionId || null,
    };

    for (const m of membersRows) {
      party.members.set(m.player_id, {
        playerId: m.player_id,
        nickname: m.nickname,
        ready: Boolean(m.ready),
        character: charByPlayer.get(m.player_id) || null,
        socketId: null,
      });
    }

    this.parties.set(party.id, party);
    this.codeIndex.set(party.code, party.id);
    return this.snapshot(party);
  }

  allReady(party) {
    if (!party.members.size) return false;
    for (const m of party.members.values()) {
      if (!m.character || !m.ready) return false;
    }
    return true;
  }

  snapshot(party) {
    if (!party) return null;
    return {
      id: party.id,
      code: party.code,
      hostId: party.hostId,
      status: party.status,
      maxSize: party.maxSize,
      size: party.members.size,
      sessionId: party.sessionId,
      members: [...party.members.values()].map(partyMemberPublic),
      allReady: this.allReady(party),
    };
  }
}

module.exports = PartyService;
