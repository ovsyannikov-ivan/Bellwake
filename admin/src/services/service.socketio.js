import { reactive } from "vue";
import { io } from "socket.io-client";

export const createSocketService = () => {
	const state = reactive({ connected: false, hasConnected: false, authExpiredRevision: 0 });
	const socket = io("/admin", {
		path: "/api/socket.io",
		transports: ["websocket"],
		reconnection: true,
		autoConnect: false,
		withCredentials: true,
	});

	socket.on("connect", () => {
		state.connected = true;
		state.hasConnected = true;
	});
	socket.on("disconnect", (reason) => {
		state.connected = false;
		if (reason === "io server disconnect") state.authExpiredRevision += 1;
	});
	socket.on("auth:expired", () => {
		state.authExpiredRevision += 1;
	});
	socket.on("connect_error", (error) => {
		if (error?.data?.code === "admin_unauthorized") state.authExpiredRevision += 1;
	});

	const connect = (csrfToken) => {
		socket.auth = { csrfToken };
		if (!socket.connected) socket.connect();
	};

	const disconnect = () => {
		socket.disconnect();
		state.connected = false;
		state.hasConnected = false;
	};

	return { socket, state, connect, disconnect };
};
