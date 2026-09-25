#!/usr/bin/env bash

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

ENV_FILE="${ROOT_DIR}/.env"
ENV_EXAMPLE="${ROOT_DIR}/.env.example"
ENV_LIB="${ROOT_DIR}/scripts/lib/env.sh"

if [[ ! -f "${ENV_LIB}" ]]; then
	echo "Ошибка: ${ENV_LIB} не найден." >&2
	exit 1
fi

source "${ENV_LIB}"

if [[ ! -f "${ENV_FILE}" ]]; then
	if [[ ! -f "${ENV_EXAMPLE}" ]]; then
		echo "Ошибка: ${ENV_EXAMPLE} не найден." >&2
		exit 1
	fi

	echo "==> Создание .env из .env.example..."

	cp "${ENV_EXAMPLE}" "${ENV_FILE}"
else
	echo "==> Используется существующий .env"
	echo "    Текущие значения и секреты будут сохранены."
fi

chmod 0600 "${ENV_FILE}"

# RELAY_SEND_TOKEN — общий ключ единого официального Cloudflare Relay.
# Если параметр отсутствует или пуст, переносим штатное значение из шаблона.
CURRENT_RELAY_SEND_TOKEN="$(get_env "RELAY_SEND_TOKEN" || true)"

if [[ -z "${CURRENT_RELAY_SEND_TOKEN}" ]]; then
	TEMPLATE_RELAY_SEND_TOKEN="$(
		sed -n 's/^RELAY_SEND_TOKEN=//p' "${ENV_EXAMPLE}" | head -n 1
	)"

	if [[ -z "${TEMPLATE_RELAY_SEND_TOKEN}" ]]; then
		echo "Ошибка: RELAY_SEND_TOKEN отсутствует в ${ENV_EXAMPLE}." >&2
		exit 1
	fi

	echo
	echo "==> Добавление токена официального Bellwake Relay..."
	set_env "RELAY_SEND_TOKEN" "${TEMPLATE_RELAY_SEND_TOKEN}"
fi

CURRENT_DOMAIN="$(get_env "BELLWAKE_DOMAIN" || true)"
CURRENT_DB_HOST="$(get_env "DB_HOST" || true)"
CURRENT_DB_PORT="$(get_env "DB_PORT" || true)"
CURRENT_DB_NAME="$(get_env "DB_NAME" || true)"
CURRENT_DB_USER="$(get_env "DB_USER" || true)"
CURRENT_DB_PASSWORD="$(get_env "DB_PASSWORD" || true)"

CURRENT_DB_HOST="${CURRENT_DB_HOST:-127.0.0.1}"
CURRENT_DB_PORT="${CURRENT_DB_PORT:-3306}"
CURRENT_DB_NAME="${CURRENT_DB_NAME:-bellwake}"
CURRENT_DB_USER="${CURRENT_DB_USER:-bellwake}"

echo
echo "============================================================"
echo "Настройка Bellwake"
echo "============================================================"
echo

if [[ -n "${CURRENT_DOMAIN}" ]]; then
	read -r -p "Домен Bellwake [${CURRENT_DOMAIN}]: " INPUT_DOMAIN
	BELLWAKE_DOMAIN="${INPUT_DOMAIN:-${CURRENT_DOMAIN}}"
else
	read -r -p "Домен Bellwake: " BELLWAKE_DOMAIN
fi


if [[ -z "${BELLWAKE_DOMAIN}" ]]; then
	echo "Ошибка: домен Bellwake не может быть пустым." >&2
	exit 1
fi

read -r -p "Хост MySQL [${CURRENT_DB_HOST}]: " INPUT_DB_HOST
DB_HOST="${INPUT_DB_HOST:-${CURRENT_DB_HOST}}"

if [[ -z "${DB_HOST}" ]]; then
	echo "Ошибка: хост MySQL не может быть пустым." >&2
	exit 1
fi

read -r -p "Порт MySQL [${CURRENT_DB_PORT}]: " INPUT_DB_PORT
DB_PORT="${INPUT_DB_PORT:-${CURRENT_DB_PORT}}"

if [[ ! "${DB_PORT}" =~ ^[0-9]+$ ]] || (( DB_PORT < 1 || DB_PORT > 65535 )); then
	echo "Ошибка: порт MySQL должен быть числом от 1 до 65535." >&2
	exit 1
fi

read -r -p "Имя базы данных [${CURRENT_DB_NAME}]: " INPUT_DB_NAME
DB_NAME="${INPUT_DB_NAME:-${CURRENT_DB_NAME}}"

if [[ -z "${DB_NAME}" ]]; then
	echo "Ошибка: имя базы данных не может быть пустым." >&2
	exit 1
fi

read -r -p "Пользователь MySQL [${CURRENT_DB_USER}]: " INPUT_DB_USER
DB_USER="${INPUT_DB_USER:-${CURRENT_DB_USER}}"

if [[ -z "${DB_USER}" ]]; then
	echo "Ошибка: пользователь MySQL не может быть пустым." >&2
	exit 1
fi

if [[ -n "${CURRENT_DB_PASSWORD}" ]]; then
	echo
	read -r -s -p "Пароль MySQL [Enter — оставить текущий]: " INPUT_DB_PASSWORD
	echo

	if [[ -n "${INPUT_DB_PASSWORD}" ]]; then
		DB_PASSWORD="${INPUT_DB_PASSWORD}"
	else
		DB_PASSWORD="${CURRENT_DB_PASSWORD}"
	fi
else
	echo
	read -r -s -p "Пароль MySQL: " DB_PASSWORD
	echo

	if [[ -z "${DB_PASSWORD}" ]]; then
		echo "Ошибка: пароль MySQL не может быть пустым." >&2
		exit 1
	fi
fi

set_env "BELLWAKE_DOMAIN" "${BELLWAKE_DOMAIN}"
set_env "DB_HOST" "${DB_HOST}"
set_env "DB_PORT" "${DB_PORT}"
set_env "DB_NAME" "${DB_NAME}"
set_env "DB_USER" "${DB_USER}"
set_env "DB_PASSWORD" "${DB_PASSWORD}"

ENROLLMENT_TOKEN="$(get_env "ENROLLMENT_TOKEN" || true)"
ENROLLMENT_TOKEN_GENERATED=false

if [[ -z "${ENROLLMENT_TOKEN}" ]]; then
	echo
	echo "==> Генерация Bellwake enrollment token..."

	ENROLLMENT_TOKEN="$(generate_secret)"

	set_env "ENROLLMENT_TOKEN" "${ENROLLMENT_TOKEN}"

	ENROLLMENT_TOKEN_GENERATED=true
fi

chmod 0600 "${ENV_FILE}"

echo
echo "============================================================"
echo " Настройка Bellwake завершена"
echo "============================================================"
echo
echo "Домен:"
echo "    ${BELLWAKE_DOMAIN}"
echo
echo "База данных:"
echo "    ${DB_HOST}:${DB_PORT}/${DB_NAME}"
echo
echo "Пользователь MySQL:"
echo "    ${DB_USER}"
echo
echo "Конфигурация:"
echo "    ${ENV_FILE}"

if [[ "${ENROLLMENT_TOKEN_GENERATED}" == true ]]; then
	echo
	echo "Создан новый enrollment token:"
	echo
	echo "    ${ENROLLMENT_TOKEN}"
fi

echo
