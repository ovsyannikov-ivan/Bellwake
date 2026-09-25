import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tauriBin = resolve(
	projectDir,
	"node_modules",
	".bin",
	process.platform === "win32" ? "tauri.cmd" : "tauri",
);
const args = process.argv.slice(2);
const environment = { ...process.env };

const getEnvValue = (contents, key) => {
	const line = contents
		.split(/\r?\n/u)
		.find((candidate) => candidate.startsWith(`${key}=`));

	if (!line) return "";

	const value = line.slice(key.length + 1).trim();
	if (value.length >= 2 && ['"', "'"].includes(value[0]) && value.at(-1) === value[0]) {
		return value.slice(1, -1);
	}

	return value;
};

if (args[0] === "dev") {
	const backendEnvFile = resolve(projectDir, "backend", ".env");

	if (existsSync(backendEnvFile)) {
		const backendEnv = readFileSync(backendEnvFile, "utf8");
		const mqttPassword = getEnvValue(backendEnv, "MQTT_AGENT_PASSWORD");

		if (mqttPassword) environment.BELLWAKE_MQTT_PASSWORD = mqttPassword;
	}

	if (process.platform === "darwin") {
		/*
		 * macOS связывает список доступа Keychain с подписью исполняемого файла.
		 * Отладочный бинарник Tauri меняется при каждой пересборке, а системная
		 * утилита security сохраняет одну подпись. После однократного выбора
		 * «Разрешать всегда» она передаёт токен процессу без новых запросов.
		 */
		const result = spawnSync(
			"/usr/bin/security",
			[
				"find-generic-password",
				"-s",
				"com.bellwake.agent",
				"-a",
				"client-token",
				"-w",
			],
			{ encoding: "utf8" },
		);
		const clientToken = result.status === 0 ? result.stdout.trim() : "";

		if (clientToken) environment.BELLWAKE_CLIENT_TOKEN = clientToken;
	}
}

const child = spawn(tauriBin, args, {
	cwd: projectDir,
	env: environment,
	stdio: "inherit",
});

child.once("error", (error) => {
	console.error(`Не удалось запустить Tauri: ${error.message}`);
	process.exitCode = 1;
});

child.once("exit", (code, signal) => {
	if (signal) {
		process.kill(process.pid, signal);
		return;
	}

	process.exitCode = code ?? 1;
});
