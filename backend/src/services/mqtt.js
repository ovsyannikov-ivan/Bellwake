import crypto from "node:crypto";
import mqtt from "mqtt";

export const verifyAgentCredentials = async ({ username, password }) => {
	const port = Number(process.env.MQTT_LOCAL_PORT ?? 1883);
	const clientId = `bellwake-credential-check-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
	let client;
	try {
		client = await mqtt.connectAsync(
			`mqtt://127.0.0.1:${port}`,
			{
				username,
				password,
				clientId,
				clean: true,
				reconnectPeriod: 0,
				connectTimeout: 3000,
			},
			false
		);
	} catch (error) {
		throw new Error(`MQTT agent credentials do not match the broker: ${error.message}`);
	} finally {
		client?.end(true);
	}
};
