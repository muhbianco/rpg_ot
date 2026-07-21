const { v4: uuidv4 } = require('uuid');
const config = require('../config');
const GameFinder = require('../db/GameFinder');
const { partyMemberPublic } = require('../character/CharacterService');

function partyCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i += 1) {
    code += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return code;
}

class PartyService {
  constructor() {
    this.parties = new Map(); // id -> party
    this.codeIndex = new Map(); // code -> id
    this.playerParty = new Map(); // playerId -> partyId
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
    if (party.status === 'active') throw new Error('Sessão já em andamento.');

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

    party.members.delete(playerId);
    GameFinder.removePartyMember(partyId, playerId).catch(() => {});

    if (party.members.size === 0) {
      this.parties.delete(partyId);
      this.codeIndex.delete(party.code);
      party.status = 'ended';
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
