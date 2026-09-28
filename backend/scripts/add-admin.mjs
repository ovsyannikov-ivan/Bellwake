#!/usr/bin/env node

import "dotenv/config";
import { Writable } from "node:stream";
import { createInterface } from "node:readline/promises";
import argon2 from "argon2";
import pool from "../src/database.js";

if (!process.stdin.isTTY || !process.stdout.isTTY) {
	await pool.end();

	throw new Error(
		"Для создания администратора запустите npm run admin:add в интерактивном терминале."
	);
}

let muted = false;

const output = new Writable({
	write(chunk, encoding, callback) {
		if (!muted) process.stdout.write(chunk, encoding);
		callback();
	},
});

const prompt = createInterface({
	input: process.stdin,
	output,
	terminal: true,
});

const askSecret = async (label) => {
	process.stdout.write(label);

	muted = true;
	const value = await prompt.question("");
	muted = false;

	process.stdout.write("\n");

	return value;
};

try {
	console.log();
	console.log("============================================================");
	console.log(" Добавление администратора Bellwake");
	console.log("============================================================");
	console.log();

	const username = (await prompt.question("Имя пользователя: ")).trim();

	if (!/^[\p{L}\p{N}._-]{3,100}$/u.test(username)) {
		throw new Error(
			"Имя пользователя должно содержать от 3 до 100 букв, цифр или символов . _ -"
		);
	}

	const [existingUsers] = await pool.execute(
		"SELECT user_id FROM users WHERE username = ? LIMIT 1",
		[username],
	);

	if (existingUsers.length > 0) {
		throw new Error(`Пользователь ${username} уже существует.`);
	}

	const displayName = (
		await prompt.question("Отображаемое имя: ")
	).trim();

	if (!displayName || displayName.length > 255) {
		throw new Error(
			"Отображаемое имя должно содержать от 1 до 255 символов."
		);
	}

	const password = await askSecret(
		"Пароль (не менее 12 символов): "
	);

	const passwordConfirmation = await askSecret(
		"Повторите пароль: "
	);

	if (password.length < 12 || password.length > 1024) {
		throw new Error(
			"Пароль должен содержать от 12 до 1024 символов."
		);
	}

	if (password !== passwordConfirmation) {
		throw new Error("Введённые пароли не совпадают.");
	}

	const passwordHash = await argon2.hash(password, {
		type: argon2.argon2id,
		memoryCost: 19456,
		timeCost: 2,
		parallelism: 1,
	});

	await pool.execute(
		`INSERT INTO users (
			username,
			password_hash,
			display_name,
			is_active
		)
		VALUES (?, ?, ?, 1)`,
		[
			username,
			passwordHash,
			displayName,
		],
	);

	console.log();
	console.log(`✓ Администратор ${username} создан.`);
} finally {
	muted = false;
	prompt.close();
	await pool.end();
}
