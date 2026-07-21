const { getPool } = require('./pool');

async function upsertPlayer(player) {
  const p = getPool();
  await p.query(
    `INSERT INTO players (id, discord_id, nickname, global_name, avatar, session_token, last_login)
     VALUES (?, ?, ?, ?, ?, ?, NOW())
     ON DUPLICATE KEY UPDATE
       discord_id = VALUES(discord_id),
       nickname = VALUES(nickname),
       global_name = VALUES(global_name),
       avatar = VALUES(avatar),
       session_token = VALUES(session_token),
       last_login = VALUES(last_login)`,
    [player.id, player.discordId || null, player.nickname, player.globalName || null, player.avatar || null, player.token || null]
  );
}

async function findPlayerByDiscordId(discordId) {
  const p = getPool();
  const [rows] = await p.query(`SELECT * FROM players WHERE discord_id = ? LIMIT 1`, [discordId]);
  return rows[0] || null;
}

async function findPlayerById(id) {
  const p = getPool();
  const [rows] = await p.query(`SELECT * FROM players WHERE id = ? LIMIT 1`, [id]);
  return rows[0] || null;
}

async function saveParty(party) {
  const p = getPool();
  await p.query(
    `INSERT INTO parties (id, code, host_id, name, status, max_size, ended_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       status = VALUES(status),
       host_id = VALUES(host_id),
       name = VALUES(name),
       ended_at = VALUES(ended_at)`,
    [
      party.id,
      party.code,
      party.hostId,
      party.name || null,
      party.status,
      party.maxSize,
      party.status === 'ended' ? new Date() : null,
    ]
  );
}

async function endParty(partyId) {
  const p = getPool();
  await p.query(
    `UPDATE parties SET status = 'ended', ended_at = NOW() WHERE id = ? AND status <> 'ended'`,
    [partyId]
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
      status_json, inventory_json, mercy_stats_json, skills_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      name = VALUES(name), race = VALUES(race), class_key = VALUES(class_key),
      attrs_json = VALUES(attrs_json), hp = VALUES(hp), hp_max = VALUES(hp_max),
      mp = VALUES(mp), mp_max = VALUES(mp_max), defense = VALUES(defense),
      weapon_key = VALUES(weapon_key), status_json = VALUES(status_json),
      inventory_json = VALUES(inventory_json), mercy_stats_json = VALUES(mercy_stats_json),
      skills_json = VALUES(skills_json)`,
    [
      char.id, char.playerId, char.partyId, char.name, char.race, char.classKey, char.level,
      JSON.stringify(char.attrs), char.hp, char.hpMax, char.mp, char.mpMax, char.defense, char.weaponKey,
      JSON.stringify(char.status), JSON.stringify(char.inventory), JSON.stringify(char.mercy),
      JSON.stringify({
        skillRanks: char.skillRanks || {},
        knownSkills: char.knownSkills || [],
        powerPointsSpent: char.powerPointsSpent || 0,
        powerPointsBudget: char.powerPointsBudget || 1,
        powerPointsRemaining: char.powerPointsRemaining || 0,
        skillCooldowns: char.skillCooldowns || {},
        baseDefense: char.baseDefense || char.defense,
        raceTraits: char.raceTraits || [],
        raceTraitsCombat: char.raceTraitsCombat || {},
      }),
    ]
  );
}

function serializeSession(session) {
  return JSON.stringify({
    id: session.id,
    partyId: session.partyId,
    mapId: session.mapId,
    mapW: session.mapW,
    mapH: session.mapH,
    encounterBudget: session.encounterBudget,
    scale: session.scale,
    characters: session.characters,
    enemies: session.enemies,
    world: session.world,
    turn: session.turn || null,
    outcome: session.outcome || null,
    log: (session.log || []).slice(-40),
    createdAt: session.createdAt,
  });
}

async function saveSession(session) {
  const p = getPool();
  await p.query(
    `INSERT INTO sessions (id, party_id, map_id, world_state_json, encounter_budget)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       world_state_json = VALUES(world_state_json),
       encounter_budget = VALUES(encounter_budget)`,
    [session.id, session.partyId, session.mapId, serializeSession(session), session.encounterBudget]
  );
}

function parseJson(value, fallback = null) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

async function loadSessionSnapshot(sessionId) {
  const p = getPool();
  const [rows] = await p.query(`SELECT world_state_json FROM sessions WHERE id = ? LIMIT 1`, [sessionId]);
  return rows[0] ? parseJson(rows[0].world_state_json) : null;
}

async function loadSessionByParty(partyId) {
  const p = getPool();
  const [rows] = await p.query(
    `SELECT id, world_state_json FROM sessions WHERE party_id = ? LIMIT 1`,
    [partyId]
  );
  return rows[0] ? parseJson(rows[0].world_state_json) : null;
}

async function loadPartyById(partyId) {
  const p = getPool();
  const [rows] = await p.query(`SELECT * FROM parties WHERE id = ? LIMIT 1`, [partyId]);
  return rows[0] || null;
}

async function loadPartyMembers(partyId) {
  const p = getPool();
  const [rows] = await p.query(
    `SELECT pm.player_id, pm.ready, pl.nickname
       FROM party_members pm
       JOIN players pl ON pl.id = pm.player_id
      WHERE pm.party_id = ?`,
    [partyId]
  );
  return rows;
}

async function loadCharactersByParty(partyId) {
  const p = getPool();
  const [rows] = await p.query(`SELECT * FROM characters WHERE party_id = ?`, [partyId]);
  return rows.map((r) => ({
    ...r,
    attrs: parseJson(r.attrs_json, {}),
    status: parseJson(r.status_json, []),
    inventory: parseJson(r.inventory_json, []),
    mercy: parseJson(r.mercy_stats_json, { deaths: 0, failStreak: 0, punishments: 0 }),
    skillsMeta: parseJson(r.skills_json, {}),
  }));
}

async function listPlayerGames(playerId) {
  const p = getPool();
  const [rows] = await p.query(
    `SELECT p.id AS partyId, p.code, p.status, p.host_id AS hostId,
            p.created_at AS createdAt, p.updated_at AS updatedAt, p.ended_at AS endedAt,
            s.id AS sessionId, s.updated_at AS sessionUpdatedAt,
            (SELECT COUNT(*) FROM party_members pm2 WHERE pm2.party_id = p.id) AS memberCount,
            c.name AS charName, c.class_key AS charClass
       FROM party_members pm
       JOIN parties p ON p.id = pm.party_id
       LEFT JOIN sessions s ON s.party_id = p.id
       LEFT JOIN characters c ON c.party_id = p.id AND c.player_id = pm.player_id
      WHERE pm.player_id = ?
      ORDER BY COALESCE(s.updated_at, p.updated_at, p.created_at) DESC
      LIMIT 50`,
    [playerId]
  );
  return rows;
}

async function loadActionRecap(sessionId, limit = 30) {
  const p = getPool();
  const [rows] = await p.query(
    `SELECT player_id AS playerId, raw_text AS rawText, resolved_json AS resolved, created_at AS createdAt
       FROM action_log
      WHERE session_id = ?
      ORDER BY id DESC
      LIMIT ?`,
    [sessionId, limit]
  );
  return rows.map((r) => ({
    playerId: r.playerId,
    rawText: r.rawText,
    resolved: parseJson(r.resolved, null),
    createdAt: r.createdAt,
  })).reverse();
}

async function isPartyMember(partyId, playerId) {
  const p = getPool();
  const [rows] = await p.query(
    `SELECT 1 FROM party_members WHERE party_id = ? AND player_id = ? LIMIT 1`,
    [partyId, playerId]
  );
  return Boolean(rows[0]);
}

async function deletePartyCascade(partyId) {
  const p = getPool();
  const conn = await p.getConnection();
  try {
    await conn.beginTransaction();
    const [sessions] = await conn.query(`SELECT id FROM sessions WHERE party_id = ?`, [partyId]);
    const sessionIds = sessions.map((s) => s.id);
    if (sessionIds.length) {
      await conn.query(`DELETE FROM action_log WHERE session_id IN (?)`, [sessionIds]);
      await conn.query(`DELETE FROM gm_memory WHERE session_id IN (?)`, [sessionIds]);
      await conn.query(`DELETE FROM sessions WHERE party_id = ?`, [partyId]);
    }
    await conn.query(`DELETE FROM characters WHERE party_id = ?`, [partyId]);
    await conn.query(`DELETE FROM party_members WHERE party_id = ?`, [partyId]);
    const [result] = await conn.query(`DELETE FROM parties WHERE id = ?`, [partyId]);
    await conn.commit();
    return result.affectedRows > 0;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
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
  findPlayerByDiscordId,
  findPlayerById,
  saveParty,
  endParty,
  savePartyMember,
  removePartyMember,
  saveCharacter,
  saveSession,
  loadSessionSnapshot,
  loadSessionByParty,
  loadPartyById,
  loadPartyMembers,
  loadCharactersByParty,
  listPlayerGames,
  loadActionRecap,
  isPartyMember,
  deletePartyCascade,
  logAction,
  saveGmMemory,
  getGmMemory,
};
