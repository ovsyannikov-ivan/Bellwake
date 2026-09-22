import { reactive } from "vue";
import { io } from "socket.io-client";

export const createSocketService = () => {
	const state = reactive({ connected: false, hasConnected: false });
	const socket = io("/admin", {
		path: "/api/socket.io",
		transports: ["websocket"],
		reconnection: true,
	});

	socket.on("connect", () => {
		state.connected = true;
		state.hasConnected = true;
	});
	socket.on("disconnect", () => {
		state.connected = false;
	});

	return { socket, state };
};
