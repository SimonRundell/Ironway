-- 001_schema.sql
-- Phase 1 schema for Ironway. See DESIGN.md 8.2.
-- Assumes the target database already exists (InnoDB, utf8mb4).
-- Every CREATE TABLE uses IF NOT EXISTS because MySQL DDL auto-commits
-- statement by statement, so a migration that fails partway through
-- must be safe to re-run from the top.

CREATE TABLE IF NOT EXISTS users (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  username VARCHAR(32) NOT NULL,
  email VARCHAR(255) NULL,
  password_hash VARCHAR(255) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_users_username (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sessions (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id INT UNSIGNED NOT NULL,
  token_hash CHAR(64) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME NOT NULL,
  last_seen DATETIME NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_sessions_token_hash (token_hash),
  KEY idx_sessions_user_id (user_id),
  CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS login_attempts (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  username VARCHAR(32) NOT NULL,
  attempted_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  success TINYINT(1) NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  KEY idx_login_attempts_username_time (username, attempted_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS saves (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id INT UNSIGNED NOT NULL,
  name VARCHAR(100) NOT NULL,
  seed VARCHAR(40) NOT NULL,
  attempt TINYINT UNSIGNED NOT NULL DEFAULT 0,
  generator_version SMALLINT UNSIGNED NOT NULL,
  start_year SMALLINT UNSIGNED NOT NULL,
  difficulty VARCHAR(16) NOT NULL,
  game_day INT UNSIGNED NOT NULL DEFAULT 0,
  version INT UNSIGNED NOT NULL DEFAULT 1,
  settings JSON NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_saves_user_id (user_id),
  CONSTRAINT fk_saves_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS save_map (
  save_id INT UNSIGNED NOT NULL,
  `blob` MEDIUMBLOB NOT NULL,
  checksum CHAR(16) NOT NULL,
  bytes INT UNSIGNED NOT NULL,
  PRIMARY KEY (save_id),
  CONSTRAINT fk_save_map_save FOREIGN KEY (save_id) REFERENCES saves (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS settlements (
  save_id INT UNSIGNED NOT NULL,
  id SMALLINT UNSIGNED NOT NULL,
  name VARCHAR(60) NOT NULL,
  kind VARCHAR(16) NOT NULL,
  x FLOAT NOT NULL,
  y FLOAT NOT NULL,
  port_tier TINYINT UNSIGNED NOT NULL DEFAULT 0,
  housing INT UNSIGNED NOT NULL DEFAULT 0,
  region_cells INT UNSIGNED NOT NULL DEFAULT 0,
  stock JSON NULL,
  PRIMARY KEY (save_id, id),
  CONSTRAINT fk_settlements_save FOREIGN KEY (save_id) REFERENCES saves (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS settlement_pop (
  save_id INT UNSIGNED NOT NULL,
  settlement_id SMALLINT UNSIGNED NOT NULL,
  class TINYINT UNSIGNED NOT NULL,
  pop INT UNSIGNED NOT NULL DEFAULT 0,
  employed INT UNSIGNED NOT NULL DEFAULT 0,
  confidence FLOAT NOT NULL DEFAULT 50,
  PRIMARY KEY (save_id, settlement_id, class),
  CONSTRAINT fk_settlement_pop_settlement FOREIGN KEY (save_id, settlement_id) REFERENCES settlements (save_id, id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS industries (
  save_id INT UNSIGNED NOT NULL,
  id SMALLINT UNSIGNED NOT NULL,
  type_id VARCHAR(40) NOT NULL,
  name VARCHAR(60) NOT NULL,
  x FLOAT NOT NULL,
  y FLOAT NOT NULL,
  home_settlement_id SMALLINT UNSIGNED NOT NULL,
  capacity FLOAT NOT NULL DEFAULT 0,
  utilisation FLOAT NOT NULL DEFAULT 0,
  richness_left FLOAT NOT NULL DEFAULT 1,
  opened_day INT UNSIGNED NOT NULL DEFAULT 0,
  closed_day INT UNSIGNED NULL,
  months_low SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  stock JSON NULL,
  PRIMARY KEY (save_id, id),
  KEY idx_industries_home_settlement (save_id, home_settlement_id),
  CONSTRAINT fk_industries_save FOREIGN KEY (save_id) REFERENCES saves (id) ON DELETE CASCADE,
  CONSTRAINT fk_industries_home_settlement FOREIGN KEY (save_id, home_settlement_id) REFERENCES settlements (save_id, id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS links (
  save_id INT UNSIGNED NOT NULL,
  id SMALLINT UNSIGNED NOT NULL,
  a_type CHAR(1) NOT NULL,
  a_id SMALLINT UNSIGNED NOT NULL,
  b_type CHAR(1) NOT NULL,
  b_id SMALLINT UNSIGNED NOT NULL,
  mode VARCHAR(8) NOT NULL,
  tier TINYINT UNSIGNED NOT NULL DEFAULT 0,
  length_mi FLOAT NOT NULL,
  gradient FLOAT NOT NULL DEFAULT 0,
  `condition` FLOAT NOT NULL DEFAULT 1,
  owner VARCHAR(8) NOT NULL DEFAULT 'public',
  path JSON NULL,
  PRIMARY KEY (save_id, id),
  CONSTRAINT fk_links_save FOREIGN KEY (save_id) REFERENCES saves (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS economy_state (
  save_id INT UNSIGNED NOT NULL,
  level TINYINT UNSIGNED NOT NULL DEFAULT 2,
  last_change_dir TINYINT NOT NULL DEFAULT 0,
  last_check_day INT UNSIGNED NOT NULL DEFAULT 0,
  indicators JSON NULL,
  PRIMARY KEY (save_id),
  CONSTRAINT fk_economy_state_save FOREIGN KEY (save_id) REFERENCES saves (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS company (
  save_id INT UNSIGNED NOT NULL,
  name VARCHAR(100) NOT NULL,
  cash DECIMAL(14,2) NOT NULL DEFAULT 0,
  loans DECIMAL(14,2) NOT NULL DEFAULT 0,
  rank_key VARCHAR(24) NOT NULL DEFAULT 'novice',
  stats JSON NULL,
  PRIMARY KEY (save_id),
  CONSTRAINT fk_company_save FOREIGN KEY (save_id) REFERENCES saves (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS history_monthly (
  save_id INT UNSIGNED NOT NULL,
  month_index INT UNSIGNED NOT NULL,
  pop_total INT UNSIGNED NOT NULL DEFAULT 0,
  pop_u INT UNSIGNED NOT NULL DEFAULT 0,
  pop_m INT UNSIGNED NOT NULL DEFAULT 0,
  pop_w INT UNSIGNED NOT NULL DEFAULT 0,
  employment FLOAT NOT NULL DEFAULT 0,
  confidence FLOAT NOT NULL DEFAULT 0,
  trade_value DOUBLE NOT NULL DEFAULT 0,
  level TINYINT UNSIGNED NOT NULL DEFAULT 2,
  extra JSON NULL,
  PRIMARY KEY (save_id, month_index),
  CONSTRAINT fk_history_monthly_save FOREIGN KEY (save_id) REFERENCES saves (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS events_log (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  save_id INT UNSIGNED NOT NULL,
  game_day INT UNSIGNED NOT NULL,
  kind VARCHAR(24) NOT NULL,
  subject_type VARCHAR(16) NULL,
  subject_id SMALLINT UNSIGNED NULL,
  text VARCHAR(255) NOT NULL,
  PRIMARY KEY (id),
  KEY idx_events_log_save_day (save_id, game_day),
  CONSTRAINT fk_events_log_save FOREIGN KEY (save_id) REFERENCES saves (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
