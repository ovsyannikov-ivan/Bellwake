#!/usr/bin/env bash

set -Eeuo pipefail

PROJECT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${PROJECT}/.env"
ENV_LIB="${PROJECT}/scripts/lib/env.sh"

die() {
	echo
	echo "Ошибка: $*" >&2
	exit 1
}

[[ -f "${ENV_FILE}" ]] || die "${ENV_FILE} не найден. Сначала выполните npm run setup:env."
[[ -f "${ENV_LIB}" ]] || die "${ENV_LIB} не найден."

source "${ENV_LIB}"

BELLWAKE_DOMAIN="$(get_env "BELLWAKE_DOMAIN" || true)"
SSH_TARGET="${DEPLOY_SSH_TARGET:-$(get_env "DEPLOY_SSH_TARGET" || true)}"
SSH_PORT="${DEPLOY_SSH_PORT:-$(get_env "DEPLOY_SSH_PORT" || true)}"
REMOTE_DIR="${DEPLOY_REMOTE_DIR:-$(get_env "DEPLOY_REMOTE_DIR" || true)}"
PM2_APP="${DEPLOY_PM2_APP:-$(get_env "DEPLOY_PM2_APP" || true)}"
SKIP_RESTART="${DEPLOY_SKIP_RESTART:-false}"

[[ -n "${BELLWAKE_DOMAIN}" ]] || die "В .env отсутствует BELLWAKE_DOMAIN."

SSH_PORT="${SSH_PORT:-22}"
REMOTE_DIR="${REMOTE_DIR:-/var/www/${BELLWAKE_DOMAIN}/backend}"
PM2_APP="${PM2_APP:-bellwake-api}"

[[ -n "${SSH_TARGET}" ]] || die "Укажите DEPLOY_SSH_TARGET в .env или окружении."

if [[ ! "${SSH_PORT}" =~ ^[0-9]+$ ]] || (( SSH_PORT < 1 || SSH_PORT > 65535 )); then
	die "DEPLOY_SSH_PORT должен быть числом от 1 до 65535."
fi

DEST="${SSH_TARGET}:${REMOTE_DIR}/"
REMOTE_NODE_SETUP='export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"'

echo
echo "$(date '+%H:%M:%S') → Сборка и публикация Bellwake Backend"
echo "    Сервер: ${SSH_TARGET}:${SSH_PORT}"
echo "    Каталог: ${REMOTE_DIR}"

cd "${PROJECT}"

echo
echo "$(date '+%H:%M:%S') → Копирование backend"

rsync -az --delete \
	-e "ssh -p ${SSH_PORT}" \
	--no-owner \
	--no-group \
	--chmod='Dg+s,Dg+w,Fg+w' \
	--exclude '.DS_Store' \
	--exclude '.env' \
	--exclude 'node_modules/' \
	--exclude 'npm-debug.log*' \
	--exclude 'coverage/' \
	"${PROJECT}/" \
	"${DEST}"

echo
echo "$(date '+%H:%M:%S') ✓ Файлы скопированы"
echo "$(date '+%H:%M:%S') → Установка production-зависимостей"

ssh -p "${SSH_PORT}" "${SSH_TARGET}" \
	"${REMOTE_NODE_SETUP} && cd '${REMOTE_DIR}' && npm ci --omit=dev"

if [[ "${SKIP_RESTART}" == "true" ]]; then
	echo
	echo "$(date '+%H:%M:%S') ✓ Backend скопирован без перезапуска PM2"
	echo "    После миграции перезапустите: pm2 restart '${PM2_APP}' --update-env"
	exit 0
fi

echo
echo "$(date '+%H:%M:%S') → Перезапуск PM2"

ssh -p "${SSH_PORT}" "${SSH_TARGET}" \
	"${REMOTE_NODE_SETUP} && pm2 restart '${PM2_APP}' --update-env && pm2 show '${PM2_APP}'"

echo
echo "$(date '+%H:%M:%S') ✓ Backend опубликован"
