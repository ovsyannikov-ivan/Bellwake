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

#
# RELAY_SEND_TOKEN является общим ключом официального
# Bellwake Bootstrap Relay.
#
# Для каждой организации он НЕ генерируется заново.
# Если параметр отсутствует в существующем .env,
# копируем его из .env.example без изменений.
#

if ! grep -q '^RELAY_SEND_TOKEN=' "${ENV_FILE}"; then
	if [[ ! -f "${ENV_EXAMPLE}" ]]; then
		echo "Ошибка: ${ENV_EXAMPLE} не найден." >&2
		exit 1
	fi

	RELAY_SEND_TOKEN_LINE="$(
		grep -m1 '^RELAY_SEND_TOKEN=' "${ENV_EXAMPLE}" || true
	)"

	if [[ -z "${RELAY_SEND_TOKEN_LINE}" ]]; then
		echo "Ошибка: RELAY_SEND_TOKEN отсутствует в ${ENV_EXAMPLE}." >&2
		exit 1
	fi

	echo
	echo "==> Добавление Bellwake Relay token..."

	printf '\n%s\n' "${RELAY_SEND_TOKEN_LINE}" >> "${ENV_FILE}"
fi

chmod 0600 "${ENV_FILE}"

CURRENT_DOMAIN="$(get_env "BELLWAKE_DOMAIN" || true)"
CURRENT_DB_NAME="$(get_env "DB_NAME" || true)"
CURRENT_DB_USER="$(get_env "DB_USER" || true)"
CURRENT_DB_PASSWORD="$(get_env "DB_PASSWORD" || true)"

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


read -r -p "Имя базы данных [${CURRENT_DB_NAME}]: " INPUT_DB_NAME
DB_NAME="${INPUT_DB_NAME:-${CURRENT_DB_NAME}}"


read -r -p "Пользователь MySQL [${CURRENT_DB_USER}]: " INPUT_DB_USER
DB_USER="${INPUT_DB_USER:-${CURRENT_DB_USER}}"


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
echo "    ${DB_NAME}"
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