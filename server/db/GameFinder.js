const { getPool } = require('./pool');

async function upsertPlayer(player) {
  const p = getPool();
  await p.query(
    `INSERT INTO players (id, nickname, session_token)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE nickname = VALUES(nickname)`,
    [player.id, player.nickname, player.token]
  );
}

async function saveParty(party) {
  const p = getPool();
  await p.query(
    `INSERT INTO parties (id, code, host_id, status, max_size)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE status = VALUES(status), host_id = VALUES(host_id)`,
    [party.id, party.code, party.hostId, party.status, party.maxSize]
  );
}

async function savePartyMember(partyId, playerId, ready = 0) {
  const p = getPool();
  await p.query(
    `INSERT INTO party_members (party_id, player_id, ready)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE ready = VALUES(ready)`,
    [partyId, playerId, ready ? 1 : 0]
  );
}

async function removePartyMember(partyId, playerId) {
  const p = getPool();
  await p.query(`DELETE FROM party_members WHERE party_id = ? AND player_id = ?`, [partyId, playerId]);
}

async function saveCharacter(char) {
  const p = getPool();
  await p.query(
    `INSERT INTO characters (
      id, player_id, party_id, name, race, class_key, level,
      attrs_json, hp, hp_max, mp, mp_max, defense, weapon_key,
      status_json, inventory_json, mercy_stats_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      name = VALUES(name), race = VALUES(race), class_key = VALUES(class_key),
      attrs_json = VALUES(attrs_json), hp = VALUES(hp), hp_max = VALUES(hp_max),
      mp = VALUES(mp), mp_max = VALUES(mp_max), defense = VALUES(defense),
      weapon_key = VALUES(weapon_key), status_json = VALUES(status_json),
      inventory_json = VALUES(inventory_json), mercy_stats_json = VALUES(mercy_stats_json)`,
    [
      char.id, char.playerId, char.partyId, char.name, char.race, char.classKey, char.level,
      JSON.stringify(char.attrs), char.hp, char.hpMax, char.mp, char.mpMax, char.defense, char.weaponKey,
      JSON.stringify(char.status), JSON.stringify(char.inventory), JSON.stringify(char.mercy),
    ]
  );
}

async function saveSession(session) {
  const p = getPool();
  await p.query(
    `INSERT INTO sessions (id, party_id, map_id, world_state_json, encounter_budget)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       world_state_json = VALUES(world_state_json),
       encounter_budget = VALUES(encounter_budget)`,
    [session.id, session.partyId, session.mapId, JSON.stringify(session.world), session.encounterBudget]
  );
}

async function logAction(sessionId, playerId, rawText, resolved) {
  const p = getPool();
  await p.query(
    `INSERT INTO action_log (session_id, player_id, raw_text, resolved_json) VALUES (?, ?, ?, ?)`,
    [sessionId, playerId, rawText.slice(0, 500), JSON.stringify(resolved || null)]
  );
}

async function saveGmMemory(sessionId, summary) {
  const p = getPool();
  await p.query(
    `INSERT INTO gm_memory (session_id, summary_text) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE summary_text = VALUES(summary_text)`,
    [sessionId, summary.slice(0, 8000)]
  );
}

async function getGmMemory(sessionId) {
  const p = getPool();
  const [rows] = await p.query(`SELECT summary_text FROM gm_memory WHERE session_id = ?`, [sessionId]);
  return rows[0]?.summary_text || '';
}

module.exports = {
  upsertPlayer,
  saveParty,
  savePartyMember,
  removePartyMember,
  saveCharacter,
  saveSession,
  logAction,
  saveGmMemory,
  getGmMemory,
};
