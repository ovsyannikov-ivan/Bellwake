module.exports = {
	apps: [
		{
			name: "bellwake-api",
			script: "./src/app.js",
			cwd: __dirname,
			instances: 1,
			exec_mode: "fork",
			watch: ["src"],
			watch_delay: 500,
			ignore_watch: ["node_modules", ".git", "logs", ".env"],
			max_memory_restart: "256M",
			env: {
				NODE_ENV: "development",
			},
		},
	],
};
