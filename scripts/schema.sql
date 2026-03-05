-- schema.sql
-- Minimal tables used by tvii-v2-dev

CREATE DATABASE IF NOT EXISTS `tvii`
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE `tvii`;

-- ─── account ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `account` (
  `id`               INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `pid`              BIGINT UNSIGNED NOT NULL,
  `country`          VARCHAR(4) NOT NULL DEFAULT 'US',
  `mii_data`         TEXT,
  `mii_name`         VARCHAR(32),
  `mii_bday`         VARCHAR(16),
  `utc_offset`       INT DEFAULT 0,
  `serial_number`    VARCHAR(128),
  `access_key`       VARCHAR(128),
  `last_data_update` DATETIME DEFAULT CURRENT_TIMESTAMP,
  `env`              ENUM('dev','stg','prod') NOT NULL DEFAULT 'dev',
  `created_at`       DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_pid` (`pid`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─── settings ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `settings` (
  `id`                       INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `pid`                      BIGINT UNSIGNED NOT NULL,
  `tv_provider_id`           VARCHAR(128),
  `tv_provider_tz`           VARCHAR(64),
  `bsky_auth_session_json`   TEXT,
  `bsky_password_hashed`     TEXT,
  `bsky_username`            VARCHAR(128),
  `created_at`               DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_pid` (`pid`),
  FOREIGN KEY (`pid`) REFERENCES `account`(`pid`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─── favorite_channels ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS `favorite_channels` (
  `id`           INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `pid`          BIGINT UNSIGNED NOT NULL,
  `channel_id`   VARCHAR(128) NOT NULL,
  `create_time`  VARCHAR(64),
  PRIMARY KEY (`id`),
  KEY `idx_pid` (`pid`),
  UNIQUE KEY `uk_pid_channel` (`pid`, `channel_id`),
  FOREIGN KEY (`pid`) REFERENCES `account`(`pid`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─── posts (Miiverse / OLV) ────────────────────────────────
CREATE TABLE IF NOT EXISTS `posts` (
  `post_id`       INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `pid`           BIGINT UNSIGNED NOT NULL,
  `create_time`   DATETIME DEFAULT CURRENT_TIMESTAMP,
  `search_keys`   JSON,
  `body`          TEXT,
  `painting`      VARCHAR(512),
  `screenshot`    VARCHAR(512),
  `feeling_id`    TINYINT UNSIGNED DEFAULT 0,
  `is_spoiler`    TINYINT UNSIGNED DEFAULT 0,
  `topic_tag`     VARCHAR(256) DEFAULT '',
  PRIMARY KEY (`post_id`),
  KEY `idx_pid` (`pid`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─── empathies (Yeahs) ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS `empathies` (
  `id`          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `pid`         BIGINT UNSIGNED NOT NULL,
  `post_id`     INT UNSIGNED NOT NULL,
  `create_time` DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_post_id` (`post_id`),
  KEY `idx_pid` (`pid`),
  CONSTRAINT `fk_empathies_post` FOREIGN KEY (`post_id`) REFERENCES `posts`(`post_id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ─── reminders (program reminders) ─────────────────────────
CREATE TABLE IF NOT EXISTS `reminders` (
  `id`           INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `pid`          BIGINT UNSIGNED NOT NULL,
  `listing_id`   VARCHAR(255) NOT NULL,
  `channel_id`   VARCHAR(128) NOT NULL,
  `channel_name` VARCHAR(255) DEFAULT '',
  `program_name` VARCHAR(512) DEFAULT '',
  `start_time`   DATETIME NOT NULL,
  `created_at`   DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_pid_listing` (`pid`, `listing_id`),
  KEY `idx_pid` (`pid`),
  KEY `idx_start` (`start_time`),
  FOREIGN KEY (`pid`) REFERENCES `account`(`pid`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
