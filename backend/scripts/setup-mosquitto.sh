#!/usr/bin/env bash

set -Eeuo pipefail

#
# Установщик Bellwake MQTT broker
#
# Поддержка:
#   Debian / Ubuntu
#   Mosquitto 2.0+
#
# Перед запуском выполнить:
#
#   npm run setup:env
#
# Затем:
#
#   npm run setup:broker
#

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ROOT_DIR}/.env"
ENV_LIB="${ROOT_DIR}/scripts/lib/env.sh"

MOSQUITTO_DIR="/etc/mosquitto"
MOSQUITTO_CONFIG="${MOSQUITTO_DIR}/mosquitto.conf"

BELLWAKE_DIR="${MOSQUITTO_DIR}/bellwake"
CERT_DIR="${MOSQUITTO_DIR}/certs"

DYNSEC_CONFIG="${BELLWAKE_DIR}/dynamic-security.json"
BELLWAKE_CONFIG="${MOSQUITTO_DIR}/conf.d/99-bellwake.conf"

CERT_DEST="${CERT_DIR}/bellwake-fullchain.pem"
KEY_DEST="${CERT_DIR}/bellwake-privkey.pem"

CERTBOT_HOOK="/etc/letsencrypt/renewal-hooks/deploy/bellwake-mosquitto"

die() {
	echo
	echo "Ошибка: $*" >&2
	exit 1
}

#
# Базовые проверки
#

if [[ ! -f "${ENV_LIB}" ]]; then
	die "${ENV_LIB} не найден."
fi

source "${ENV_LIB}"

if [[ "${EUID}" -ne 0 ]]; then
	die "setup-mosquitto.sh необходимо запускать через sudo/root."
fi


if [[ ! -f "${ENV_FILE}" ]]; then
	die "Файл ${ENV_FILE} не найден.

Сначала выполните:

	npm run setup:env"
fi


if ! command -v apt-get >/dev/null 2>&1; then
	die "Этот installer поддерживает только Debian/Ubuntu (apt-get)."
fi

#
# Конфигурация Bellwake
#

BELLWAKE_DOMAIN="$(get_env "BELLWAKE_DOMAIN" || true)"

if [[ -z "${BELLWAKE_DOMAIN}" ]]; then
	die "В .env отсутствует BELLWAKE_DOMAIN."
fi

if [[ "${BELLWAKE_DOMAIN}" == *"://"* ]]; then
	die "BELLWAKE_DOMAIN должен содержать только имя хоста, без https://"
fi

MQTT_LOCAL_PORT="$(get_env "MQTT_LOCAL_PORT" || true)"
MQTT_LOCAL_PORT="${MQTT_LOCAL_PORT:-1883}"

MQTT_PORT="$(get_env "MQTT_PORT" || true)"
MQTT_PORT="${MQTT_PORT:-8883}"

MQTT_TOPIC="$(get_env "MQTT_TOPIC" || true)"
MQTT_TOPIC="${MQTT_TOPIC:-bellwake/notifications}"

MQTT_SESSION_EXPIRATION="$(
	get_env "MQTT_SESSION_EXPIRATION" || true
)"
MQTT_SESSION_EXPIRATION="${MQTT_SESSION_EXPIRATION:-90d}"

MQTT_ADMIN_USER="$(get_env "MQTT_ADMIN_USER" || true)"
MQTT_ADMIN_USER="${MQTT_ADMIN_USER:-bellwake-admin}"

MQTT_PUBLISHER_USER="$(get_env "MQTT_PUBLISHER_USER" || true)"
MQTT_PUBLISHER_USER="${MQTT_PUBLISHER_USER:-bellwake-server}"

MQTT_AGENT_USER="$(get_env "MQTT_AGENT_USER" || true)"
MQTT_AGENT_USER="${MQTT_AGENT_USER:-bellwake-agent}"

#
# Сертификаты
#
# При необходимости пути можно переопределить в .env:
#
# MQTT_CERT_FILE=/path/to/fullchain.pem
# MQTT_KEY_FILE=/path/to/privkey.pem
#

MQTT_CERT_FILE="$(get_env "MQTT_CERT_FILE" || true)"
MQTT_KEY_FILE="$(get_env "MQTT_KEY_FILE" || true)"

MQTT_CERT_FILE="${MQTT_CERT_FILE:-/etc/letsencrypt/live/${BELLWAKE_DOMAIN}/fullchain.pem}"
MQTT_KEY_FILE="${MQTT_KEY_FILE:-/etc/letsencrypt/live/${BELLWAKE_DOMAIN}/privkey.pem}"

echo
echo "============================================================"
echo " Установка MQTT брокера"
echo "============================================================"
echo
echo "Домен:  ${BELLWAKE_DOMAIN}"
echo "Порт:    ${MQTT_PORT}"
echo "Топик:   ${MQTT_TOPIC}"
echo

#
# Установка пакетов
#

echo "==> Установка Mosquitto..."

export DEBIAN_FRONTEND=noninteractive

apt-get update

apt-get install -y mosquitto mosquitto-clients openssl

#
# Ищем Dynamic Security плагин
#
# На Ubuntu обычно:
#
# /usr/lib/x86_64-linux-gnu/mosquitto_dynamic_security.so
#

echo "==> Поиск Dynamic Security plugin..."

DYNSEC_PLUGIN="$(find /usr/lib /usr/local/lib -type f -name 'mosquitto_dynamic_security.so' -print -quit 2>/dev/null)"


if [[ -z "${DYNSEC_PLUGIN}" ]]; then
	die "mosquitto_dynamic_security.so не найден."
fi

echo "    ${DYNSEC_PLUGIN}"

#
# Каталоги
#

echo "==> Подготовка каталогов..."

install -d -o mosquitto -g mosquitto -m 0750 "${BELLWAKE_DIR}"
install -d -o root -g mosquitto -m 0750 "${CERT_DIR}"
install -d -o mosquitto -g mosquitto -m 0750 /var/lib/mosquitto

#
# TLS сертификаты
#

echo "==> Проверка TLS-сертификата..."

if [[ ! -f "${MQTT_CERT_FILE}" ]]; then
	die "TLS-сертификат не найден:

	${MQTT_CERT_FILE}"
fi


if [[ ! -f "${MQTT_KEY_FILE}" ]]; then
	die "TLS private key не найден:

	${MQTT_KEY_FILE}"
fi

echo "==> Копирование TLS-сертификата для Mosquitto..."

install -o root -g mosquitto -m 0640 "${MQTT_CERT_FILE}" "${CERT_DEST}"
install -o root -g mosquitto -m 0640 "${MQTT_KEY_FILE}" "${KEY_DEST}"

#
# Настройки MQTT
#

MQTT_ADMIN_PASSWORD="$(get_env "MQTT_ADMIN_PASSWORD" || true)"
MQTT_PUBLISHER_PASSWORD="$(get_env "MQTT_PUBLISHER_PASSWORD" || true)"
MQTT_AGENT_PASSWORD="$(get_env "MQTT_AGENT_PASSWORD" || true)"

#
# Если Dynamic Security уже существует, все связанные с ним
# credentials должны уже присутствовать в .env.
#
# Никогда не генерируем новые пароли автоматически для
# существующей конфигурации — это была бы неявная ротация.
#

if [[ -f "${DYNSEC_CONFIG}" ]]; then
	if [[ -z "${MQTT_ADMIN_PASSWORD}" ]]; then
		die "Dynamic Security уже настроен, но MQTT_ADMIN_PASSWORD отсутствует в .env."
	fi

	if [[ -z "${MQTT_PUBLISHER_PASSWORD}" ]]; then
		die "Dynamic Security уже настроен, но MQTT_PUBLISHER_PASSWORD отсутствует в .env."
	fi

	if [[ -z "${MQTT_AGENT_PASSWORD}" ]]; then
		die "Dynamic Security уже настроен, но MQTT_AGENT_PASSWORD отсутствует в .env."
	fi
else
	if [[ -z "${MQTT_ADMIN_PASSWORD}" ]]; then
		echo "==> Генерация MQTT admin password..."
		MQTT_ADMIN_PASSWORD="$(generate_secret)"
		set_env "MQTT_ADMIN_PASSWORD" "${MQTT_ADMIN_PASSWORD}"
	fi

	if [[ -z "${MQTT_PUBLISHER_PASSWORD}" ]]; then
		echo "==> Генерация MQTT publisher password..."
		MQTT_PUBLISHER_PASSWORD="$(generate_secret)"
		set_env "MQTT_PUBLISHER_PASSWORD" "${MQTT_PUBLISHER_PASSWORD}"
	fi

	if [[ -z "${MQTT_AGENT_PASSWORD}" ]]; then
		echo "==> Генерация MQTT agent password..."
		MQTT_AGENT_PASSWORD="$(generate_secret)"
		set_env "MQTT_AGENT_PASSWORD" "${MQTT_AGENT_PASSWORD}"
	fi
fi

#
# Заодно сохраняем defaults, если их ещё не было.
#

set_env "MQTT_LOCAL_PORT" "${MQTT_LOCAL_PORT}"
set_env "MQTT_PORT" "${MQTT_PORT}"
set_env "MQTT_TOPIC" "${MQTT_TOPIC}"
set_env "MQTT_SESSION_EXPIRATION" "${MQTT_SESSION_EXPIRATION}"

set_env "MQTT_ADMIN_USER" "${MQTT_ADMIN_USER}"
set_env "MQTT_PUBLISHER_USER" "${MQTT_PUBLISHER_USER}"
set_env "MQTT_AGENT_USER" "${MQTT_AGENT_USER}"

chmod 0600 "${ENV_FILE}"

#
# Инициализация Dynamic Security
#

if [[ ! -f "${DYNSEC_CONFIG}" ]]; then
	echo "==> Инициализация Dynamic Security..."
	mosquitto_ctrl dynsec init "${DYNSEC_CONFIG}" "${MQTT_ADMIN_USER}" "${MQTT_ADMIN_PASSWORD}"
	chown mosquitto:mosquitto "${DYNSEC_CONFIG}"
	chmod 0600 "${DYNSEC_CONFIG}"
else
	echo "==> Dynamic Security уже инициализирован."
fi

#
# Конфигурация Mosquitto
#

echo "==> Создание конфигурации Mosquitto..."

cat > "${BELLWAKE_CONFIG}" <<EOF
#
# Bellwake MQTT Broker
#
# This file is generated by:
#
# scripts/setup-mosquitto.sh
#

#
# Authentication
#

allow_anonymous false

#
# Dynamic Security should apply to all listeners.
#

per_listener_settings false

plugin ${DYNSEC_PLUGIN}
plugin_opt_config_file ${DYNSEC_CONFIG}

#
# Persistent sessions / offline messages
#
# Debian/Ubuntu package already enables persistence and defines:
#
#   persistence true
#   persistence_location /var/lib/mosquitto/
#

persistence_file bellwake.db

#
# Save broker state once per minute.
#

autosave_interval 60

#
# Remove abandoned persistent sessions after this period.
#

persistent_client_expiration ${MQTT_SESSION_EXPIRATION}

#
# Maximum number of queued QoS 1/2 messages per offline client.
#
# Bellwake messages are deliberately tiny, so 1000 is a very
# generous limit for normal notification traffic.
#

max_queued_messages 1000

#
# Local administration listener.
#
# Available only from the Bellwake server itself.
#

listener ${MQTT_LOCAL_PORT} 127.0.0.1
protocol mqtt

#
# Public MQTT over TLS.
#

listener ${MQTT_PORT}
protocol mqtt

certfile ${CERT_DEST}
keyfile ${KEY_DEST}

#
# Allow TLS 1.2 and newer.
#

tls_version tlsv1.2
EOF

chmod 0644 "${BELLWAKE_CONFIG}"

if ! grep -Eq \
	'^[[:space:]]*include_dir[[:space:]]+/etc/mosquitto/conf\.d([[:space:]]|$)' "${MOSQUITTO_CONFIG}"; then
	echo "==> Добавление /etc/mosquitto/conf.d в основной config..."
	{
		echo
		echo "include_dir /etc/mosquitto/conf.d"
	} >> "${MOSQUITTO_CONFIG}"
fi

#
# Запуск брокера
#

echo "==> Запуск Mosquitto..."

systemctl enable mosquitto
systemctl restart mosquitto

sleep 1

if ! systemctl is-active --quiet mosquitto; then
	echo
	echo "Mosquitto не смог запуститься:"
	echo
	journalctl -u mosquitto --no-pager -n 80
	exit 1
fi

#
# Команды Dynamic Security
#
# Здесь используется только loopback listener 127.0.0.1.
#

CTRL=(
	mosquitto_ctrl
	-h 127.0.0.1
	-p "${MQTT_LOCAL_PORT}"
	-u "${MQTT_ADMIN_USER}"
	-P "${MQTT_ADMIN_PASSWORD}"
)

echo "==> Настройка ACL..."

"${CTRL[@]}" dynsec setDefaultACLAccess publishClientSend deny
"${CTRL[@]}" dynsec setDefaultACLAccess publishClientReceive deny
"${CTRL[@]}" dynsec setDefaultACLAccess subscribe deny
"${CTRL[@]}" dynsec setDefaultACLAccess unsubscribe allow

role_exists() {
	"${CTRL[@]}" dynsec listRoles |
		grep -Fxq "$1"
}

client_exists() {
	"${CTRL[@]}" dynsec listClients |
		grep -Fxq "$1"
}

ensure_role() {
	local role="$1"

	if ! role_exists "${role}"; then
		"${CTRL[@]}" dynsec createRole "${role}"
	fi
}

ensure_acl() {
	local role="$1"
	local acl_type="$2"
	local topic="$3"
	local access="$4"
	local priority="$5"

	"${CTRL[@]}" dynsec removeRoleACL "${role}" "${acl_type}" "${topic}" >/dev/null 2>&1 || true
	"${CTRL[@]}" dynsec addRoleACL "${role}" "${acl_type}" "${topic}" "${access}" "${priority}"
}

ensure_client() {
	local username="$1"
	local password="$2"
	local role="$3"

	if client_exists "${username}"; then
		echo "    MQTT client ${username} уже существует. Пароль не изменяется."

		"${CTRL[@]}" dynsec enableClient "${username}" >/dev/null 2>&1 || true
	else
		echo "    Создание MQTT client ${username}..."

		"${CTRL[@]}" dynsec createClient "${username}" -p "${password}"
	fi

	"${CTRL[@]}" dynsec removeClientRole "${username}" "${role}" >/dev/null 2>&1 || true
	"${CTRL[@]}" dynsec addClientRole "${username}" "${role}" 10
}

#
# Настройка Bellwake backend
#

echo "==> Настройка роли Bellwake backend..."

ensure_role "bellwake-publisher"
ensure_acl "bellwake-publisher" "publishClientSend" "${MQTT_TOPIC}" "allow" 10

#
# Настройка Bellwake агента
#

echo "==> Настройка роли Bellwake агента..."

ensure_role "bellwake-agent"
ensure_acl "bellwake-agent" "subscribeLiteral" "${MQTT_TOPIC}" "allow" 10
ensure_acl "bellwake-agent" "publishClientReceive" "${MQTT_TOPIC}" "allow" 10

#
# MQTT пользователи
#

echo "==> Настройка MQTT backend..."

ensure_client "${MQTT_PUBLISHER_USER}" "${MQTT_PUBLISHER_PASSWORD}" "bellwake-publisher"

echo "==> Настройка MQTT агента..."

ensure_client "${MQTT_AGENT_USER}" "${MQTT_AGENT_PASSWORD}" "bellwake-agent"

#
# Certbot deploy hook
#
# Если используются стандартные пути Let's Encrypt,
# после успешного certbot renew:
#
#   1. копируем новый сертификат;
#   2. копируем новый private key;
#   3. посылаем Mosquitto reload.
#
# certfile/keyfile перечитываются Mosquitto по SIGHUP.
#

LE_LINEAGE=""

if [[ "${MQTT_CERT_FILE}" == /etc/letsencrypt/live/*/fullchain.pem ]]; then
	LE_LINEAGE="$(dirname "${MQTT_CERT_FILE}")"
fi

if [[ -n "${LE_LINEAGE}" &&
	  "${MQTT_KEY_FILE}" == "${LE_LINEAGE}/privkey.pem" ]]; then

	echo "==> Установка Certbot deploy hook..."

	install -d -o root -g root -m 0755 /etc/letsencrypt/renewal-hooks/deploy

	cat > "${CERTBOT_HOOK}" <<EOF
#!/usr/bin/env bash

set -Eeuo pipefail

EXPECTED_LINEAGE="${LE_LINEAGE}"

if [[ "\${RENEWED_LINEAGE:-}" != "\${EXPECTED_LINEAGE}" ]]; then
	exit 0
fi

install -o root -g mosquitto -m 0640 "\${RENEWED_LINEAGE}/fullchain.pem" "${CERT_DEST}"

install -o root -g mosquitto -m 0640 "\${RENEWED_LINEAGE}/privkey.pem" "${KEY_DEST}"

systemctl reload mosquitto ||
	systemctl restart mosquitto
EOF
	chown root:root "${CERTBOT_HOOK}"
	chmod 0755 "${CERTBOT_HOOK}"

else
	echo
	echo "==> Используется нестандартный путь к TLS-сертификату."
	echo "    Certbot deploy hook не устанавливается автоматически."
fi

#
# UFW
#
# Если UFW уже активен, разрешаем внешний MQTT/TLS порт.
# Сам firewall installer намеренно НЕ включает.
#

echo "==> Проверка UFW..."

if command -v ufw >/dev/null 2>&1; then
	if ufw status | grep -q '^Status: active'; then
		echo "    UFW активен. Разрешаем ${MQTT_PORT}/tcp..."
		ufw allow "${MQTT_PORT}/tcp" comment "Bellwake MQTT TLS"
	else
		echo "    UFW установлен, но не активен."
		echo "    Firewall автоматически не включается."
	fi
else
	echo "    UFW не установлен. Настройка firewall пропущена."
fi

#
# Финиш
#

echo
echo "============================================================"
echo " Bellwake MQTT брокер готов"
echo "============================================================"
echo
echo "MQTT:"
echo
echo "    mqtts://${BELLWAKE_DOMAIN}:${MQTT_PORT}"
echo
echo "Топик:"
echo
echo "    ${MQTT_TOPIC}"
echo
echo "Настройки сохранены в:"
echo
echo "    ${ENV_FILE}"
echo
echo "Статус:"
echo
echo "    systemctl status mosquitto"
echo
echo "Логи:"
echo
echo "    journalctl -u mosquitto -f"
echo
echo "Проверка Certbot deploy hook:"
echo
echo "    certbot renew --dry-run --run-deploy-hooks"
echo