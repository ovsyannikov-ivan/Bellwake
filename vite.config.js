import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import process from "node:process";
const host = process.env.TAURI_DEV_HOST;

export default defineConfig(() => ({
	plugins: [vue()],

	// Параметры Vite для режимов `tauri dev` и `tauri build`.
	//
	// Не очищаем экран, чтобы сообщения Rust оставались видимыми.
	clearScreen: false,
	// Tauri ожидает фиксированный порт и должен завершиться, если он занят.
	server: {
		port: 1420,
		strictPort: true,
		host: host || "127.0.0.1",
		hmr: host
			? {
					protocol: "ws",
					host,
					port: 1421,
				}
			: undefined,
		watch: {
			// Не следим за изменениями в исходниках Rust через Vite.
			ignored: ["**/src-tauri/**"],
		},
	},
}));
