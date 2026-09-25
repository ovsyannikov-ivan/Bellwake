#!/usr/bin/env bash

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ROOT_DIR}/.env"

die() {
	echo
	echo "Ошибка: $*" >&2
	exit 1
}

[[ -f "${ENV_FILE}" ]] || die "${ENV_FILE} не найден. Сначала выполните npm run setup:env."
command -v node >/dev/null 2>&1 || die "Node.js не найден."

cd "${ROOT_DIR}"
exec node scripts/setup-admin.mjs
