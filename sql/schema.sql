CREATE DATABASE IF NOT EXISTS rpg_ot
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

USE rpg_ot;

CREATE TABLE IF NOT EXISTS players (
  id CHAR(36) NOT NULL PRIMARY KEY,
  discord_id VARCHAR(32) NULL,
  nickname VARCHAR(64) NOT NULL,
  global_name VARCHAR(64) NULL,
  avatar VARCHAR(128) NULL,
  session_token CHAR(64) NULL,
  last_login TIMESTAMP NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_players_discord (discord_id),
  INDEX idx_players_nickname (nickname)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS parties (
  id CHAR(36) NOT NULL PRIMARY KEY,
  code VARCHAR(8) NOT NULL,
  host_id CHAR(36) NOT NULL,
  name VARCHAR(60) NULL,
  status ENUM('lobby','hall','active','ended') NOT NULL DEFAULT 'lobby',
  max_size TINYINT UNSIGNED NOT NULL DEFAULT 10,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  ended_at TIMESTAMP NULL,
  UNIQUE KEY uq_parties_code (code),
  INDEX idx_parties_status (status),
  INDEX idx_parties_host (host_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS party_members (
  party_id CHAR(36) NOT NULL,
  player_id CHAR(36) NOT NULL,
  ready TINYINT(1) NOT NULL DEFAULT 0,
  joined_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (party_id, player_id),
  INDEX idx_party_members_player (player_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS characters (
  id CHAR(36) NOT NULL PRIMARY KEY,
  player_id CHAR(36) NOT NULL,
  party_id CHAR(36) NOT NULL,
  name VARCHAR(40) NOT NULL,
  race VARCHAR(32) NOT NULL,
  class_key VARCHAR(32) NOT NULL,
  level TINYINT UNSIGNED NOT NULL DEFAULT 1,
  attrs_json JSON NOT NULL,
  hp INT NOT NULL,
  hp_max INT NOT NULL,
  mp INT NOT NULL,
  mp_max INT NOT NULL,
  defense INT NOT NULL,
  weapon_key VARCHAR(32) NOT NULL,
  status_json JSON NOT NULL,
  inventory_json JSON NOT NULL,
  mercy_stats_json JSON NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_characters_party_player (party_id, player_id),
  INDEX idx_characters_player (player_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sessions (
  id CHAR(36) NOT NULL PRIMARY KEY,
  party_id CHAR(36) NOT NULL,
  map_id VARCHAR(64) NOT NULL DEFAULT 'taverna_arton',
  world_state_json JSON NOT NULL,
  encounter_budget DECIMAL(10,2) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_sessions_party (party_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS action_log (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  session_id CHAR(36) NOT NULL,
  player_id CHAR(36) NULL,
  raw_text VARCHAR(500) NOT NULL,
  resolved_json JSON NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_action_log_session (session_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS gm_memory (
  session_id CHAR(36) NOT NULL PRIMARY KEY,
  summary_text TEXT NOT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =============================================================================
-- Migrações evolutivas (idempotentes) para bases criadas antes do login Discord.
-- MariaDB suporta ADD COLUMN / ADD INDEX ... IF NOT EXISTS.
-- =============================================================================
ALTER TABLE players
  ADD COLUMN IF NOT EXISTS discord_id VARCHAR(32) NULL AFTER id,
  ADD COLUMN IF NOT EXISTS global_name VARCHAR(64) NULL AFTER nickname,
  ADD COLUMN IF NOT EXISTS avatar VARCHAR(128) NULL AFTER global_name,
  ADD COLUMN IF NOT EXISTS last_login TIMESTAMP NULL AFTER session_token,
  MODIFY COLUMN nickname VARCHAR(64) NOT NULL,
  MODIFY COLUMN session_token CHAR(64) NULL;
ALTER TABLE players ADD UNIQUE INDEX IF NOT EXISTS uq_players_discord (discord_id);

ALTER TABLE parties
  ADD COLUMN IF NOT EXISTS name VARCHAR(60) NULL AFTER host_id,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  ADD COLUMN IF NOT EXISTS ended_at TIMESTAMP NULL;
ALTER TABLE parties ADD INDEX IF NOT EXISTS idx_parties_host (host_id);

-- world_state_json passa a guardar o snapshot COMPLETO da sessão
-- (personagens, inimigos, turno, mundo) para permitir reidratação/reentrada.
