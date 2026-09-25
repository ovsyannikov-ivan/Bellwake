#!/usr/bin/env bash

get_env() {
	local key="$1"
	local line
	local value

	line="$(grep -m 1 -E "^${key}=" "${ENV_FILE}" 2>/dev/null || true)"

	if [[ -z "${line}" ]]; then
		return 1
	fi

	value="${line#*=}"
	value="${value%$'\r'}"

	if [[ "${value}" == \"*\" && "${value}" == *\" ]]; then
		value="${value:1:${#value}-2}"
	elif [[ "${value}" == \'*\' && "${value}" == *\' ]]; then
		value="${value:1:${#value}-2}"
	fi

	printf '%s' "${value}"
}

set_env() {
	local key="$1"
	local value="$2"
	local tmp

	tmp="$(mktemp "${ENV_FILE}.tmp.XXXXXX")"

	if ! BELLWAKE_ENV_VALUE="${value}" awk -v key="${key}" '
	BEGIN {
		found = 0
	}

	$0 ~ ("^" key "=") {
		if (!found) {
			print key "=" ENVIRON["BELLWAKE_ENV_VALUE"]
			found = 1
		}
		next
	}

	{
		print
	}

	END {
		if (!found) {
			print key "=" ENVIRON["BELLWAKE_ENV_VALUE"]
		}
	}
	' "${ENV_FILE}" > "${tmp}"; then
		rm -f "${tmp}"
		return 1
	fi

	chmod --reference="${ENV_FILE}" "${tmp}" 2>/dev/null || chmod 0600 "${tmp}"

	# При запуске через sudo сохраняем владельца исходного .env.
	if [[ "${EUID:-$(id -u)}" -eq 0 ]]; then
		local owner

		if owner="$(stat -c '%u:%g' "${ENV_FILE}" 2>/dev/null)"; then
			chown "${owner}" "${tmp}"
		elif owner="$(stat -f '%u:%g' "${ENV_FILE}" 2>/dev/null)"; then
			chown "${owner}" "${tmp}"
		fi
	fi

	mv "${tmp}" "${ENV_FILE}"
}

generate_secret() {
	openssl rand -hex 32
}
