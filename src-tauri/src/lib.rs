use sha2::{Digest, Sha256};
use std::path::PathBuf;
use tauri::Manager;

mod relay;

const KEYRING_SERVICE: &str = "com.bellwake.agent";
const KEYRING_CLIENT_TOKEN: &str = "client-token";
const KEYRING_MQTT_PASSWORD: &str = "mqtt-password";

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DeviceIdentity {
    device_id: String,
    hostname: String,
    os: String,
    native_id_type: String,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct UserIdentity {
    username: String,
    sid: Option<String>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ClientIdentity {
    device: DeviceIdentity,
    user: UserIdentity,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AcknowledgeResult {
    notification_id: u64,
    acknowledged: bool,
    client: ClientIdentity,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct MqttSettings {
	host: String,
	port: u16,
	topic: String,
	username: String,
	client_id: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClientSettings {
	server_url: String,

	#[serde(default)]
	mqtt: Option<MqttSettings>,
}

fn keyring_entry(name: &str) -> Result<keyring::Entry, String> {
	keyring::Entry::new(
		KEYRING_SERVICE,
		name,
	)
	.map_err(|error| {
		format!(
			"Unable to access system credential store for {name}: {error}"
		)
	})
}

fn load_secret(name: &str) -> Result<Option<String>, String> {
	let entry = keyring_entry(name)?;

	match entry.get_password() {
		Ok(value) => Ok(Some(value)),

		Err(keyring::Error::NoEntry) => Ok(None),

		Err(error) => Err(format!(
			"Unable to read {name} from system credential store: {error}"
		)),
	}
}

fn save_secret_if_changed(
	name: &str,
	value: &str,
) -> Result<bool, String> {
	let entry = keyring_entry(name)?;

	match entry.get_password() {
		Ok(current) if current == value => {
			return Ok(false);
		}

		Ok(_) | Err(keyring::Error::NoEntry) => {}

		Err(error) => {
			return Err(format!(
				"Unable to read {name} from system credential store: {error}"
			));
		}
	}

	entry
		.set_password(value)
		.map_err(|error| {
			format!(
				"Unable to save {name} to system credential store: {error}"
			)
		})?;

	Ok(true)
}

fn settings_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
	let config_dir = app
		.path()
		.app_config_dir()
		.map_err(|error| format!("Unable to resolve app config directory: {error}"))?;

	std::fs::create_dir_all(&config_dir)
		.map_err(|error| format!("Unable to create app config directory: {error}"))?;

	Ok(config_dir.join("settings.json"))
}

fn load_client_settings_internal(
	app: &tauri::AppHandle,
) -> Result<Option<ClientSettings>, String> {
	let path = settings_path(app)?;

	if !path.exists() {
		return Ok(None);
	}

	let json = std::fs::read_to_string(&path)
		.map_err(|error| format!("Unable to read settings: {error}"))?;

	let settings = serde_json::from_str::<ClientSettings>(&json)
		.map_err(|error| format!("Unable to decode settings: {error}"))?;

	Ok(Some(settings))
}

fn save_client_settings_internal(
	app: &tauri::AppHandle,
	settings: &ClientSettings,
) -> Result<(), String> {
	let path = settings_path(app)?;

	let json = serde_json::to_string_pretty(settings)
		.map_err(|error| format!("Unable to encode settings: {error}"))?;

	std::fs::write(&path, json)
		.map_err(|error| format!("Unable to save settings: {error}"))?;

	Ok(())
}

fn normalize_server_url(server_url: &str) -> Result<String, String> {
	let server_url = server_url
		.trim()
		.trim_end_matches('/')
		.to_string();

	if server_url.is_empty() {
		return Err("Server URL cannot be empty".to_string());
	}

	if !server_url.starts_with("https://") {
		return Err("Bellwake server must use HTTPS".to_string());
	}

	Ok(server_url)
}

#[tauri::command]
fn get_client_settings(
	app: tauri::AppHandle,
) -> Result<Option<ClientSettings>, String> {
	load_client_settings_internal(&app)
}

#[tauri::command]
fn save_server_url(
	app: tauri::AppHandle,
	server_url: String,
) -> Result<ClientSettings, String> {
	let server_url = normalize_server_url(&server_url)?;

	let mut settings = load_client_settings_internal(&app)?
		.unwrap_or(ClientSettings {
			server_url: server_url.clone(),
			mqtt: None,
		});

	settings.server_url = server_url;

	save_client_settings_internal(&app, &settings)?;

	Ok(settings)
}

fn hash_device_id(native_id: &str) -> String {
    /*
     * Добавляем namespace Bellwake, чтобы deviceId был именно
     * идентификатором Bellwake, а не просто SHA256(system-id).
     *
     * v1 позволит позднее поменять схему, не создавая путаницы.
     */
    let value = format!(
        "bellwake:device:v1:{}",
        native_id.trim().to_lowercase()
    );

    let digest = Sha256::digest(value.as_bytes());

    digest
        .iter()
        .map(|byte| format!("{:02x}", byte))
        .collect()
}

fn native_id_type() -> &'static str {
    #[cfg(target_os = "windows")]
    {
        return "machine-guid";
    }

    #[cfg(target_os = "linux")]
    {
        return "machine-id";
    }

    #[cfg(target_os = "macos")]
    {
        return "platform-uuid";
    }

    #[allow(unreachable_code)]
    "unknown"
}

#[cfg(target_os = "windows")]
fn current_user_sid() -> Option<String> {
    use std::process::Command;

    /*
     * Временная простая реализация.
     *
     * whoami.exe входит в Windows.
     * Позже при желании заменим на прямой WinAPI:
     * OpenProcessToken -> GetTokenInformation(TokenUser).
     */
    let output = Command::new("whoami")
        .args(["/user", "/fo", "csv", "/nh"])
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let line = stdout.trim();

    /*
     * Формат:
     *
     * "DOMAIN\username","S-1-5-21-..."
     */
    line.rsplit(',')
        .next()
        .map(|value| value.trim().trim_matches('"').to_string())
        .filter(|value| !value.is_empty())
}

#[cfg(not(target_os = "windows"))]
fn current_user_sid() -> Option<String> {
    None
}

fn collect_client_identity() -> Result<ClientIdentity, String> {
    /*
     * machine_uid::get():
     *
     * macOS   -> Platform UUID
     * Linux   -> /etc/machine-id
     * Windows -> MachineGuid
     */
    let native_id = machine_uid::get()
        .map_err(|error| format!("Unable to get machine ID: {error}"))?;

    let device_id = hash_device_id(&native_id);

    let hostname = whoami::hostname()
        .unwrap_or_else(|_| "unknown".to_string());

    let username = whoami::username()
        .unwrap_or_else(|_| "unknown".to_string());

    Ok(ClientIdentity {
        device: DeviceIdentity {
            device_id,
            hostname,
            os: std::env::consts::OS.to_string(),
            native_id_type: native_id_type().to_string(),
        },
        user: UserIdentity {
            username,
            sid: current_user_sid(),
        },
    })
}

#[tauri::command]
fn get_client_identity() -> Result<ClientIdentity, String> {
    collect_client_identity()
}

#[tauri::command]
fn acknowledge_notification(
    notification_id: u64,
) -> Result<AcknowledgeResult, String> {
    let client = collect_client_identity()?;

    println!(
        "Notification {} acknowledged by {} on {}",
        notification_id,
        client.user.username,
        client.device.hostname
    );

    Ok(AcknowledgeResult {
        notification_id,
        acknowledged: true,
        client,
    })
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct EnrollmentRequest {
	#[serde(skip_serializing_if = "Option::is_none")]
	enrollment_token: Option<String>,

	#[serde(skip_serializing_if = "Option::is_none")]
	client_token: Option<String>,

	device: DeviceIdentity,
	user: UserIdentity,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct EnrollmentMqttResponse {
	host: String,
	port: u16,
	topic: String,
	username: String,
	password: String,
	client_id: String,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct EnrollmentResponse {
	client_token: Option<String>,
	mqtt: EnrollmentMqttResponse,
}

#[tauri::command]
async fn enroll_client(
	app: tauri::AppHandle,
	enrollment_token: Option<String>,
) -> Result<ClientSettings, String> {
	let mut settings = load_client_settings_internal(&app)?
		.ok_or_else(|| {
			"Bellwake server is not configured".to_string()
		})?;
	let client_token = load_secret(
		KEYRING_CLIENT_TOKEN,
	)?;
	let enrollment_token = enrollment_token
		.map(|value| value.trim().to_string())
		.filter(|value| !value.is_empty());

	if client_token.is_none() && enrollment_token.is_none() {
		return Err(
			"Enrollment token is required for first setup."
				.to_string(),
		);
	}

	let ClientIdentity {
		device,
		user,
	} = collect_client_identity()?;

	let request = EnrollmentRequest {
		enrollment_token,
		client_token,
		device,
		user,
	};

	let base_url = settings
		.server_url
		.trim_end_matches('/');

	let url = format!("{base_url}/api/enroll");

	let client = reqwest::Client::builder()
		.timeout(std::time::Duration::from_secs(10))
		.build()
		.map_err(|error| {
			format!(
				"Unable to create HTTP client: {error}"
			)
		})?;

	let response = client
		.post(&url)
		.json(&request)
		.send()
		.await
		.map_err(|error| {
			format!(
				"Unable to contact Bellwake server: {error}"
			)
		})?;

	let status = response.status();

	if !status.is_success() {
		let body = response
			.text()
			.await
			.unwrap_or_default();

		return Err(format!(
			"Bellwake enrollment failed: HTTP {status}: {body}"
		));
	}

	let response = response
		.json::<EnrollmentResponse>()
		.await
		.map_err(|error| {
			format!(
				"Unable to decode enrollment response: {error}"
			)
		})?;

	/*
	 * Первый enrollment или re-enroll может выдать
	 * новый clientToken.
	 *
	 * При обычном refresh сервер его не присылает.
	 */

	if let Some(client_token) =
		response.client_token.as_deref()
	{
		let changed = save_secret_if_changed(
			KEYRING_CLIENT_TOKEN,
			client_token,
		)?;

		if changed {
			println!(
				"Bellwake client token saved to system credential store."
			);
		}
	}

	/*
	 * MQTT password сервер присылает при каждом refresh.
	 *
	 * Если пароль на сервере был легально изменён,
	 * Keychain автоматически обновится.
	 */

	let password_changed = save_secret_if_changed(
		KEYRING_MQTT_PASSWORD,
		&response.mqtt.password,
	)?;

	if password_changed {
		println!(
			"Bellwake MQTT password updated in system credential store."
		);
	}

	/*
	 * В settings.json сохраняем только несекретные
	 * MQTT settings.
	 */

	settings.mqtt = Some(MqttSettings {
		host: response.mqtt.host,
		port: response.mqtt.port,
		topic: response.mqtt.topic,
		username: response.mqtt.username,
		client_id: response.mqtt.client_id,
	});

	save_client_settings_internal(
		&app,
		&settings,
	)?;

	Ok(settings)
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Notification {
	id: u64,
	title: String,
	body: String,
	severity: String,
	ack_required: bool,
	state: String,
	starts_at: Option<String>,
	expires_at: Option<String>,
	create_datetime: String,
}

#[tauri::command]
async fn get_notification(
	app: tauri::AppHandle,
	notification_id: u64,
) -> Result<Notification, String> {
	let settings = load_client_settings_internal(&app)?
		.ok_or_else(|| "Bellwake is not configured".to_string())?;

	let base_url = settings.server_url.trim_end_matches('/');
	let url = format!("{base_url}/api/notifications/{notification_id}");

	let client = reqwest::Client::builder()
		.timeout(std::time::Duration::from_secs(10))
		.build()
		.map_err(|error| format!("Unable to create HTTP client: {error}"))?;

	let response = client
		.get(&url)
		.send()
		.await
		.map_err(|error| format!("Unable to request notification: {error}"))?;

	if !response.status().is_success() {
		return Err(format!(
			"Bellwake server returned HTTP {}",
			response.status()
		));
	}

	response
		.json::<Notification>()
		.await
		.map_err(|error| format!("Unable to decode notification: {error}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
		.manage(relay::RelayState::default())
        .invoke_handler(tauri::generate_handler![
			get_client_identity,
			get_client_settings,
			save_server_url,
			enroll_client,
			relay::start_relay_pairing,
			relay::stop_relay_pairing,
			get_notification,
			acknowledge_notification
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
