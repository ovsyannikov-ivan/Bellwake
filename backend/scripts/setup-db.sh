#!/usr/bin/env bash

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ROOT_DIR}/.env"
ENV_LIB="${ROOT_DIR}/scripts/lib/env.sh"

die() {
	echo
	echo "Ошибка: $*" >&2
	exit 1
}

if [[ ! -f "${ENV_LIB}" ]]; then
	die "${ENV_LIB} не найден."
fi

source "${ENV_LIB}"

if [[ ! -f "${ENV_FILE}" ]]; then
	die "Файл ${ENV_FILE} не найден.

Сначала выполните:

	npm run setup:env"
fi

if ! command -v mysql >/dev/null 2>&1; then
	die "Клиент mysql не найден. Установите mysql-client и повторите запуск."
fi

DB_HOST="$(get_env "DB_HOST" || true)"
DB_PORT="$(get_env "DB_PORT" || true)"
DB_NAME="$(get_env "DB_NAME" || true)"
DB_USER="$(get_env "DB_USER" || true)"
DB_PASSWORD="$(get_env "DB_PASSWORD" || true)"

DB_HOST="${DB_HOST:-127.0.0.1}"
DB_PORT="${DB_PORT:-3306}"

[[ -n "${DB_HOST}" ]] || die "В .env отсутствует DB_HOST."

if [[ ! "${DB_PORT}" =~ ^[0-9]+$ ]] || (( DB_PORT < 1 || DB_PORT > 65535 )); then
	die "DB_PORT должен быть числом от 1 до 65535."
fi

[[ -n "${DB_NAME}" ]] || die "В .env отсутствует DB_NAME."
[[ -n "${DB_USER}" ]] || die "В .env отсутствует DB_USER."
[[ -n "${DB_PASSWORD}" ]] || die "В .env отсутствует DB_PASSWORD."

echo
echo "============================================================"
echo " Инициализация базы данных Bellwake"
echo "============================================================"
echo
echo "Сервер: ${DB_HOST}:${DB_PORT}"
echo "База:   ${DB_NAME}"
echo "Пользователь: ${DB_USER}"
echo

export MYSQL_PWD="${DB_PASSWORD}"
trap 'unset MYSQL_PWD' EXIT

mysql \
	--protocol=TCP \
	--host="${DB_HOST}" \
	--port="${DB_PORT}" \
	--user="${DB_USER}" \
	--database="${DB_NAME}" \
	--default-character-set=utf8mb4 <<'SQL'
CREATE TABLE IF NOT EXISTS `users` (
  `user_id` bigint unsigned NOT NULL AUTO_INCREMENT COMMENT 'Уникальный идентификатор администратора Bellwake',
  `username` varchar(100) NOT NULL COMMENT 'Уникальное имя пользователя администратора',
  `password_hash` varchar(255) NOT NULL COMMENT 'Хеш пароля Argon2id с индивидуальной солью',
  `display_name` varchar(255) NOT NULL COMMENT 'Отображаемое имя администратора',
  `is_active` tinyint(1) NOT NULL DEFAULT '1' COMMENT 'Разрешён ли вход администратора',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'Дата создания учётной записи',
  `last_login_at` datetime DEFAULT NULL COMMENT 'Дата последнего успешного входа',
  PRIMARY KEY (`user_id`),
  UNIQUE KEY `uq_users_username` (`username`),
  KEY `idx_users_active` (`is_active`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Администраторы Bellwake Admin';

CREATE TABLE IF NOT EXISTS `sessions` (
  `session_id` char(64) NOT NULL COMMENT 'SHA-256 случайного идентификатора серверной сессии',
  `user_id` bigint unsigned NOT NULL COMMENT 'Администратор, которому принадлежит сессия',
  `csrf_token` char(64) NOT NULL COMMENT 'Случайный токен защиты от CSRF',
  `ip_address` varchar(45) DEFAULT NULL COMMENT 'IP-адрес при создании сессии',
  `user_agent` varchar(512) DEFAULT NULL COMMENT 'User-Agent при создании сессии',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'Дата создания сессии',
  `expires_at` datetime NOT NULL COMMENT 'Дата обязательного завершения сессии',
  `revoked_at` datetime DEFAULT NULL COMMENT 'Дата ручного отзыва или выхода',
  PRIMARY KEY (`session_id`),
  KEY `idx_sessions_user` (`user_id`),
  KEY `idx_sessions_expiration` (`expires_at`),
  CONSTRAINT `fk_sessions_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`user_id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Серверные сессии Bellwake Admin';

CREATE TABLE IF NOT EXISTS `login_attempts` (
  `attempt_id` bigint unsigned NOT NULL AUTO_INCREMENT COMMENT 'Идентификатор неуспешной попытки входа',
  `username` varchar(100) NOT NULL COMMENT 'Введённое имя пользователя',
  `ip_address` varchar(45) NOT NULL COMMENT 'IP-адрес запроса',
  `attempted_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'Дата неуспешной попытки входа',
  PRIMARY KEY (`attempt_id`),
  KEY `idx_login_attempts_limit` (`username`,`ip_address`,`attempted_at`),
  KEY `idx_login_attempts_ip` (`ip_address`,`attempted_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Неуспешные попытки входа Bellwake Admin';

CREATE TABLE IF NOT EXISTS `pairing_requests` (
  `pairing_request_id` bigint unsigned NOT NULL AUTO_INCREMENT COMMENT 'Идентификатор подтверждённого QR-подключения',
  `socket_id` char(36) NOT NULL COMMENT 'Временный UUID v4 сессии Cloudflare Relay',
  `token_hash` char(64) NOT NULL COMMENT 'SHA-256 одноразового токена enrollment',
  `approved_by_user_id` bigint unsigned NOT NULL COMMENT 'Администратор, подтвердивший QR-подключение',
  `status` enum('pending','delivered','consumed','failed') NOT NULL DEFAULT 'pending' COMMENT 'Состояние QR-подключения',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'Дата подтверждения QR-кода',
  `expires_at` datetime NOT NULL COMMENT 'Дата истечения одноразового подтверждения',
  `delivered_at` datetime DEFAULT NULL COMMENT 'Дата успешной передачи через Relay',
  `used_at` datetime DEFAULT NULL COMMENT 'Дата успешного enrollment',
  `enrolled_device_id` char(64) DEFAULT NULL COMMENT 'Устройство, завершившее enrollment',
  `enrolled_user_key` char(64) DEFAULT NULL COMMENT 'Пользователь устройства, завершивший enrollment',
  PRIMARY KEY (`pairing_request_id`),
  UNIQUE KEY `uq_pairing_requests_socket` (`socket_id`),
  UNIQUE KEY `uq_pairing_requests_token` (`token_hash`),
  KEY `idx_pairing_requests_admin` (`approved_by_user_id`),
  KEY `idx_pairing_requests_expiration` (`expires_at`),
  CONSTRAINT `fk_pairing_requests_user` FOREIGN KEY (`approved_by_user_id`) REFERENCES `users` (`user_id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Краткоживущие подтверждения QR-подключений Bellwake';

CREATE TABLE IF NOT EXISTS `notifications` (
  `notification_id` bigint unsigned NOT NULL AUTO_INCREMENT COMMENT 'Уникальный идентификатор уведомления',
  `title` varchar(255) NOT NULL COMMENT 'Заголовок уведомления',
  `body` mediumtext NOT NULL COMMENT 'Текст уведомления в формате Markdown',
  `severity` enum('info','warning','critical') NOT NULL DEFAULT 'info' COMMENT 'Уровень важности уведомления',
  `ack_required` tinyint(1) NOT NULL DEFAULT '1' COMMENT 'Требуется ли обязательное подтверждение прочтения',
  `state` enum('draft','active','archived') NOT NULL DEFAULT 'draft' COMMENT 'Текущее состояние уведомления',
  `starts_at` datetime DEFAULT NULL COMMENT 'Дата и время начала действия уведомления',
  `expires_at` datetime DEFAULT NULL COMMENT 'Дата и время окончания действия уведомления',
  `create_datetime` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'Дата и время создания уведомления',
  PRIMARY KEY (`notification_id`),
  KEY `idx_notifications_state` (`state`),
  KEY `idx_notifications_period` (`starts_at`,`expires_at`),
  KEY `idx_notifications_create_datetime` (`create_datetime`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Уведомления Bellwake';

CREATE TABLE IF NOT EXISTS `devices` (
  `device_id` char(64) NOT NULL COMMENT 'Уникальный идентификатор устройства (SHA-256)',
  `hostname` varchar(255) NOT NULL COMMENT 'Имя компьютера в операционной системе',
  `os` varchar(32) NOT NULL COMMENT 'Операционная система',
  `os_version` varchar(100) DEFAULT NULL COMMENT 'Версия операционной системы',
  `native_id_type` varchar(32) DEFAULT NULL COMMENT 'Тип исходного системного идентификатора устройства',
  `first_seen` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'Дата и время первого обращения устройства',
  `last_seen` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'Дата и время последнего обращения устройства',
  PRIMARY KEY (`device_id`),
  KEY `idx_devices_hostname` (`hostname`),
  KEY `idx_devices_last_seen` (`last_seen`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Зарегистрированные устройства Bellwake';

CREATE TABLE IF NOT EXISTS `device_users` (
  `relation_id` bigint unsigned NOT NULL AUTO_INCREMENT COMMENT 'Уникальный идентификатор связи пользователя с устройством',
  `device_id` char(64) NOT NULL COMMENT 'Уникальный идентификатор устройства Bellwake (SHA-256)',
  `user_key` char(64) NOT NULL COMMENT 'Уникальный идентификатор учётной записи пользователя (SHA-256)',
  `username` varchar(255) NOT NULL COMMENT 'Имя пользователя операционной системы',
  `domain_name` varchar(255) DEFAULT NULL COMMENT 'Домен пользователя, если применимо',
  `sid` varchar(255) DEFAULT NULL COMMENT 'SID пользователя Windows, если доступен',
  `uid` bigint unsigned DEFAULT NULL COMMENT 'UID пользователя в Unix-подобных системах, если доступен',
  `first_seen` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'Дата и время первого обнаружения пользователя на устройстве',
  `last_seen` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'Дата и время последнего обнаружения пользователя на устройстве',
  `client_token_hash` char(64) DEFAULT NULL COMMENT 'SHA-256 токена для повторной аутентификации Bellwake Agent',
  `last_enroll_at` datetime DEFAULT NULL COMMENT 'Последнее успешное обновление конфигурации агента',
  `enrolled_by_user_id` bigint unsigned DEFAULT NULL COMMENT 'Администратор последнего явного QR-подключения',
  PRIMARY KEY (`relation_id`),
  UNIQUE KEY `uq_device_user` (`device_id`,`user_key`),
  KEY `idx_device_users_username` (`username`),
  KEY `idx_device_users_sid` (`sid`),
  KEY `idx_device_users_last_seen` (`last_seen`),
  KEY `idx_device_users_enrolled_by` (`enrolled_by_user_id`),
  CONSTRAINT `fk_device_users_device` FOREIGN KEY (`device_id`) REFERENCES `devices` (`device_id`) ON DELETE CASCADE,
  CONSTRAINT `fk_device_users_enrolled_by` FOREIGN KEY (`enrolled_by_user_id`) REFERENCES `users` (`user_id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Учётные записи пользователей, обнаруженные на устройствах Bellwake';

CREATE TABLE IF NOT EXISTS `notification_ack` (
  `notification_id` bigint unsigned NOT NULL COMMENT 'Уникальный идентификатор уведомления',
  `device_id` char(64) NOT NULL COMMENT 'Уникальный идентификатор устройства Bellwake (SHA-256)',
  `user_key` char(64) NOT NULL COMMENT 'Уникальный идентификатор учётной записи пользователя (SHA-256)',
  `acknowledged_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'Дата и время подтверждения уведомления',
  PRIMARY KEY (`notification_id`,`device_id`,`user_key`),
  KEY `idx_notification_ack_device` (`device_id`),
  KEY `idx_notification_ack_user` (`user_key`),
  KEY `idx_notification_ack_datetime` (`acknowledged_at`),
  CONSTRAINT `fk_notification_ack_device` FOREIGN KEY (`device_id`) REFERENCES `devices` (`device_id`) ON DELETE CASCADE,
  CONSTRAINT `fk_notification_ack_notification` FOREIGN KEY (`notification_id`) REFERENCES `notifications` (`notification_id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Подтверждения получения и прочтения уведомлений Bellwake';

SET @column_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'device_users'
    AND COLUMN_NAME = 'enrolled_by_user_id'
);
SET @migration_sql = IF(
  @column_exists = 0,
  'ALTER TABLE `device_users` ADD COLUMN `enrolled_by_user_id` bigint unsigned DEFAULT NULL COMMENT ''Администратор последнего явного QR-подключения'' AFTER `last_enroll_at`',
  'SELECT 1'
);
PREPARE migration_statement FROM @migration_sql;
EXECUTE migration_statement;
DEALLOCATE PREPARE migration_statement;

SET @index_exists = (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'device_users'
    AND INDEX_NAME = 'idx_device_users_enrolled_by'
);
SET @migration_sql = IF(
  @index_exists = 0,
  'ALTER TABLE `device_users` ADD INDEX `idx_device_users_enrolled_by` (`enrolled_by_user_id`)',
  'SELECT 1'
);
PREPARE migration_statement FROM @migration_sql;
EXECUTE migration_statement;
DEALLOCATE PREPARE migration_statement;

SET @constraint_exists = (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = DATABASE()
    AND TABLE_NAME = 'device_users'
    AND CONSTRAINT_NAME = 'fk_device_users_enrolled_by'
    AND CONSTRAINT_TYPE = 'FOREIGN KEY'
);
SET @migration_sql = IF(
  @constraint_exists = 0,
  'ALTER TABLE `device_users` ADD CONSTRAINT `fk_device_users_enrolled_by` FOREIGN KEY (`enrolled_by_user_id`) REFERENCES `users` (`user_id`) ON DELETE SET NULL',
  'SELECT 1'
);
PREPARE migration_statement FROM @migration_sql;
EXECUTE migration_statement;
DEALLOCATE PREPARE migration_statement;
SQL

echo
echo "✓ Таблицы и миграции Bellwake применены без удаления существующих данных."

node "${ROOT_DIR}/scripts/setup-admin.mjs"
