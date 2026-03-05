-- whitelist.sql
-- Whitelist DB used by the access middleware

CREATE DATABASE IF NOT EXISTS `whitelist`
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE `whitelist`;

-- ─── access_allowlist ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS `access_allowlist` (
  `id`   INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `pid`  BIGINT UNSIGNED NOT NULL,
  `env`  ENUM('dev','stg','prod') NOT NULL DEFAULT 'dev',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_pid` (`pid`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Insert a dev-mode wildcard entry so local testing works immediately.
-- Replace PID 0 with your real Pretendo PID.
INSERT IGNORE INTO `access_allowlist` (`pid`, `env`) VALUES (0, 'dev');
