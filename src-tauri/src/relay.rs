use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};
use tokio::time::timeout;
use tokio_tungstenite::{connect_async, tungstenite::Message};

use crate::{
	enroll_client,
	normalize_server_url,
	save_server_url,
};

/*
 * Bellwake Bootstrap Relay
 *
 * Этот WebSocket endpoint намеренно прописан в клиенте.
 *
 * Relay является общей инфраструктурой Bellwake и используется
 * только при первоначальной настройке нового клиента.
 *
 * ОДИН relay обслуживает все организации.
 * Для каждой новой установки Bellwake отдельный Cloudflare Worker
 * создавать не требуется.
 *
 * Схема работы:
 *
 *   1. Чистый Bellwake-клиент подключается к RELAY_URL.
 *
 *   2. Relay выдаёт клиенту временный socketId.
 *
 *   3. Клиент показывает socketId в виде QR-кода.
 *
 *   4. Администратор сканирует QR-код на сервере своей организации.
 *
 *   5. Backend организации отправляет через relay пакет:
 *
 *      {
 *          "type": "pairingApproved",
 *          "serverUrl": "https://bellwake.example.org",
 *          "enrollmentToken": "..."
 *      }
 *
 *   6. Relay ничего не знает об организации и содержимое пакета
 *      не интерпретирует. Он только пересылает payload в WebSocket,
 *      соответствующий socketId.
 *
 *   7. Bellwake получает serverUrl и enrollmentToken и запускает
 *      обычный существующий механизм /api/enroll.
 *
 * После успешного enrollment:
 *
 *   - clientToken сохраняется в системном хранилище credentials;
 *   - MQTT password сохраняется там же;
 *   - несекретные MQTT settings сохраняются в settings.json;
 *   - enrollmentToken на клиенте НЕ сохраняется.
 *
 * Relay не хранит:
 *
 *   - список организаций;
 *   - пользователей;
 *   - клиентов Bellwake;
 *   - enrollmentToken;
 *   - параметры MQTT;
 *   - настройки организаций.
 *
 * RELAY_SEND_TOKEN используется только для авторизации backend-ов,
 * отправляющих данные в /send/:socketId, и никогда не передаётся
 * Bellwake-клиенту.
 *
 * Если адрес relay когда-нибудь изменится, необходимо изменить
 * RELAY_URL и пересобрать клиент Bellwake.
 */

const RELAY_URL: &str = "wss://bellwake-relay.ovsyannikov-ivan.workers.dev/connect";

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const GREETING_TIMEOUT: Duration = Duration::from_secs(5);
const PAIRING_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Default)]
pub struct RelayState {
	task: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RelayConnectedMessage {
	#[serde(rename = "type")]
	message_type: String,
	socket_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairingApprovedMessage {
	#[serde(rename = "type")]
	message_type: String,
	server_url: String,
	enrollment_token: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RelayConnectedEvent {
	socket_id: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RelayEnrollmentEvent {
	server_url: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RelayEnrollmentFailedEvent {
	server_url: Option<String>,
}

#[tauri::command]
pub fn start_relay_pairing(
	app: AppHandle,
	state: State<'_, RelayState>,
) -> Result<(), String> {
	let mut task = state
		.task
		.lock()
		.map_err(|_| "Relay task state is unavailable".to_string())?;

	if let Some(previous) = task.take() {
		previous.abort();
	}

	*task = Some(tauri::async_runtime::spawn(async move {
		if let Err(error) = relay_session(&app).await {
			eprintln!("Bellwake relay: {error}");
			let _ = app.emit("bellwake-relay-unavailable", ());
		}
	}));

	Ok(())
}

#[tauri::command]
pub fn stop_relay_pairing(
	state: State<'_, RelayState>,
) -> Result<(), String> {
	let mut task = state
		.task
		.lock()
		.map_err(|_| "Relay task state is unavailable".to_string())?;

	if let Some(previous) = task.take() {
		previous.abort();
	}

	Ok(())
}

async fn relay_session(app: &AppHandle) -> Result<(), String> {
	let (mut socket, _) = timeout(
		CONNECT_TIMEOUT,
		connect_async(RELAY_URL),
	)
	.await
	.map_err(|_| "Connection timed out".to_string())?
	.map_err(|error| {
		format!("WebSocket connection failed: {error}")
	})?;

	let greeting = timeout(
		GREETING_TIMEOUT,
		socket.next(),
	)
	.await
	.map_err(|_| "Relay greeting timed out".to_string())?
	.ok_or_else(|| {
		"Relay disconnected before greeting".to_string()
	})?
	.map_err(|error| {
		format!("Relay greeting failed: {error}")
	})?;

	let Message::Text(text) = greeting else {
		return Err("Unexpected relay greeting".to_string());
	};

	let hello: RelayConnectedMessage =
		serde_json::from_str(text.as_ref())
			.map_err(|error| {
				format!("Invalid relay greeting: {error}")
			})?;

	if hello.message_type != "connected" ||
		hello.socket_id.trim().is_empty()
	{
		return Err(
			"Relay did not confirm connection".to_string(),
		);
	}

	#[cfg(debug_assertions)]
	println!(
		"Bellwake relay socketId: {}",
		hello.socket_id
	);

	app.emit(
		"bellwake-relay-connected",
		RelayConnectedEvent {
			socket_id: hello.socket_id,
		},
	)
	.map_err(|error| {
		format!("Unable to notify frontend: {error}")
	})?;

	let outcome = timeout(PAIRING_TIMEOUT, async {
		while let Some(message) = socket.next().await {
			match message {
				Ok(Message::Text(payload)) => {
					let message: PairingApprovedMessage =
						match serde_json::from_str(
							payload.as_ref(),
						) {
							Ok(message) => message,
							Err(error) => {
								eprintln!(
									"Bellwake pairing response is invalid: {error}"
								);

								let _ = app.emit(
									"bellwake-relay-enrollment-failed",
									RelayEnrollmentFailedEvent {
										server_url: None,
									},
								);

								return Ok(true);
							}
						};

					if message.message_type != "pairingApproved" {
						eprintln!(
							"Bellwake pairing response has unexpected type."
						);

						let _ = app.emit(
							"bellwake-relay-enrollment-failed",
							RelayEnrollmentFailedEvent {
								server_url: None,
							},
						);

						return Ok(true);
					}

					let server_url =
						match normalize_server_url(
							&message.server_url,
						) {
							Ok(server_url) => server_url,
							Err(error) => {
								eprintln!(
									"Bellwake pairing server URL is invalid: {error}"
								);

								let _ = app.emit(
									"bellwake-relay-enrollment-failed",
									RelayEnrollmentFailedEvent {
										server_url: None,
									},
								);

								return Ok(true);
							}
						};

					let enrollment_token = message
						.enrollment_token
						.trim()
						.to_string();

					if enrollment_token.is_empty() {
						eprintln!(
							"Bellwake pairing enrollment token is empty."
						);

						let _ = app.emit(
							"bellwake-relay-enrollment-failed",
							RelayEnrollmentFailedEvent {
								server_url: Some(
									server_url,
								),
							},
						);

						return Ok(true);
					}

					/*
					 * Reuse the existing manual enrollment flow:
					 *
					 * 1. save the Bellwake server URL;
					 * 2. call /api/enroll with enrollmentToken;
					 * 3. enroll_client stores clientToken and MQTT
					 *    password in the system credential store;
					 * 4. enroll_client stores only non-secret MQTT
					 *    settings in settings.json.
					 *
					 * enrollmentToken itself is never persisted.
					 */

					if let Err(error) = save_server_url(
						app.clone(),
						server_url.clone(),
					) {
						eprintln!(
							"Bellwake automatic setup failed while saving server URL: {error}"
						);

						let _ = app.emit(
							"bellwake-relay-enrollment-failed",
							RelayEnrollmentFailedEvent {
								server_url: Some(
									server_url,
								),
							},
						);

						return Ok(true);
					}

					match enroll_client(
						app.clone(),
						Some(enrollment_token),
					)
					.await
					{
						Ok(_) => {
							let _ = app.emit(
								"bellwake-relay-enrolled",
								RelayEnrollmentEvent {
									server_url,
								},
							);

							return Ok(true);
						}

						Err(error) => {
							eprintln!(
								"Bellwake automatic enrollment failed: {error}"
							);

							let _ = app.emit(
								"bellwake-relay-enrollment-failed",
								RelayEnrollmentFailedEvent {
									server_url: Some(
										server_url,
									),
								},
							);

							return Ok(true);
						}
					}
				}

				Ok(Message::Close(_)) => {
					return Ok(false);
				}

				Err(error) => {
					return Err(format!(
						"WebSocket disconnected: {error}"
					));
				}

				_ => {}
			}
		}

		Ok(false)
	})
	.await;

	match outcome {
		Ok(Ok(true)) => Ok(()),

		Ok(Ok(false)) => {
			Err("Relay connection closed".to_string())
		}

		Ok(Err(error)) => Err(error),

		Err(_) => {
			Err("Pairing session expired".to_string())
		}
	}
}
