use sha2::{Digest, Sha256};
use std::collections::{HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Mutex,
};
use std::time::Duration;
use rumqttc::{AsyncClient, Event, Incoming, MqttOptions, QoS, Transport};
use tauri::{Emitter, Manager};

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

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct AcknowledgeApiResponse {
    notification_id: u64,
    acknowledged: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
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

/*
 * Rust отвечает за доставку уведомлений даже тогда, когда WebView скрыт.
 * Retained-сообщение MQTT означает активное уведомление, а пустой payload отменяет его.
 */
#[derive(Default)]
struct NotificationQueue {
    pending: VecDeque<u64>,
    acknowledged_this_run: HashSet<u64>,
}

#[derive(Default)]
struct MqttRuntime {
    queue: Mutex<NotificationQueue>,
    configuration_revision: AtomicU64,
    client_token: Mutex<Option<String>>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct MqttNotificationPayload {
    notification_id: u64,
}

fn pending_ids(app: &tauri::AppHandle) -> Result<Vec<u64>, String> {
    let runtime = app.state::<MqttRuntime>();
    let queue = runtime.queue.lock().map_err(|_| "Notification queue lock poisoned".to_string())?;
    Ok(queue.pending.iter().copied().collect())
}

fn emit_queue_changed(app: &tauri::AppHandle) {
    // События пробуждают Vue; актуальный снимок очереди всегда можно получить из Rust.
    if let Err(error) = app.emit("bellwake-notification", ()) {
        eprintln!("Unable to emit Bellwake queue event: {error}");
    }
}

fn notify_mqtt_configuration_changed(app: &tauri::AppHandle) {
    app.state::<MqttRuntime>()
        .configuration_revision
        .fetch_add(1, Ordering::Release);
}

fn clear_pending(app: &tauri::AppHandle, clear_acknowledgements: bool) {
    let runtime = app.state::<MqttRuntime>();
    let changed = match runtime.queue.lock() {
        Ok(mut queue) => {
            let changed = !queue.pending.is_empty();
            queue.pending.clear();
            if clear_acknowledgements {
                queue.acknowledged_this_run.clear();
            }
            changed
        }
        Err(_) => {
            eprintln!("Notification queue lock poisoned");
            return;
        }
    };
    if changed { emit_queue_changed(app); }
}

fn upsert_notification(app: &tauri::AppHandle, id: u64) {
    #[cfg(debug_assertions)]
    println!("Bellwake MQTT notification queued: {id}");

    let runtime = app.state::<MqttRuntime>();
    let should_emit = match runtime.queue.lock() {
        Ok(mut queue) => {
            if queue.acknowledged_this_run.contains(&id) {
                false
            } else {
                if !queue.pending.contains(&id) {
                    queue.pending.push_back(id);
                }
                // Также обновляем содержимое, если этот ID был опубликован повторно после редактирования.
                true
            }
        }
        Err(_) => {
            eprintln!("Notification queue lock poisoned");
            return;
        }
    };
    if should_emit {
        /*
         * Rust отвечает за доставку и очередь ожидающих уведомлений,
         * а Vue — за отображение окна.
         * Окно здесь не показываем: сначала Vue загружает уведомление через REST,
         * формирует интерфейс, изменяет размер окна и только после этого показывает его.
         */
        emit_queue_changed(app);
    }
}

fn remove_notification(app: &tauri::AppHandle, id: u64) {
    let runtime = app.state::<MqttRuntime>();
    let changed = match runtime.queue.lock() {
        Ok(mut queue) => {
            let before = queue.pending.len();
            queue.pending.retain(|current| *current != id);
            queue.acknowledged_this_run.remove(&id);
            queue.pending.len() != before
        }
        Err(_) => {
            eprintln!("Notification queue lock poisoned");
            return;
        }
    };
    if changed { emit_queue_changed(app); }
}

#[tauri::command]
fn get_pending_notification_ids(app: tauri::AppHandle) -> Result<Vec<u64>, String> {
    pending_ids(&app)
}

// Вызывается из Vue только ПОСЛЕ успешного acknowledge_notification.
#[tauri::command]
fn dismiss_notification(app: tauri::AppHandle, notification_id: u64) -> Result<(), String> {
    let runtime = app.state::<MqttRuntime>();
    {
        let mut queue = runtime.queue.lock().map_err(|_| "Notification queue lock poisoned".to_string())?;
        queue.pending.retain(|id| *id != notification_id);
        queue.acknowledged_this_run.insert(notification_id);
    }
    emit_queue_changed(&app);
    Ok(())
}

async fn mqtt_connection(app: tauri::AppHandle, mqtt: MqttSettings, password: String) {
    let root = mqtt.topic.trim_end_matches('/');
    if root.is_empty() {
        eprintln!("Bellwake MQTT topic must not be empty");
        return;
    }
    let filter = format!("{root}/+");
    let prefix = format!("{root}/");
    let mut options = MqttOptions::new(mqtt.client_id.clone(), mqtt.host.clone(), mqtt.port);
    options.set_credentials(mqtt.username.clone(), password);
    options.set_transport(Transport::tls_with_default_config());
    options.set_keep_alive(Duration::from_secs(30));
    options.set_clean_session(true);

    let (client, mut eventloop) = AsyncClient::new(options, 32);
    loop {
        match eventloop.poll().await {
            Ok(Event::Incoming(Incoming::ConnAck(_))) => {
                /*
                 * При КАЖДОМ переподключении заново собираем очередь
                 * из текущего набора retained-сообщений брокера.
                 * Так из очереди исчезают ID уведомлений, срок которых истёк, пока клиент был офлайн.
                 */
                clear_pending(&app, false);
                if let Err(error) = client.subscribe(filter.clone(), QoS::AtLeastOnce).await {
                    eprintln!("Bellwake MQTT subscription failed: {error}");
                } else {
                    println!("Bellwake MQTT subscribed to {filter}");
                }
            }
            Ok(Event::Incoming(Incoming::Publish(publish))) => {
                let Some(suffix) = publish.topic.strip_prefix(&prefix) else { continue };
                let Ok(topic_id) = suffix.parse::<u64>() else { continue };
                if topic_id == 0 || suffix.contains('/') { continue; }

                if publish.payload.is_empty() {
                    remove_notification(&app, topic_id);
                    continue;
                }
                match serde_json::from_slice::<MqttNotificationPayload>(&publish.payload) {
                    Ok(data) if data.notification_id == topic_id => {
                        upsert_notification(&app, topic_id);
                    }
                    Ok(_) => eprintln!("Bellwake MQTT topic/payload ID mismatch on {}", publish.topic),
                    Err(error) => eprintln!("Bellwake MQTT invalid payload on {}: {error}", publish.topic),
                }
            }
            Ok(_) => {}
            Err(error) => {
                eprintln!("Bellwake MQTT connection error: {error}; retrying...");
                tokio::time::sleep(Duration::from_secs(5)).await;
            }
        }
    }
}

/*
 * Работает вместе с процессом Tauri, а НЕ с окном.
 * После enrollment, включая QR-подключение, настройки записываются
 * в settings.json и Keychain, после чего фоновый MQTT-обработчик подхватывает их.
 */
async fn mqtt_supervisor(app: tauri::AppHandle) {
    let mut running: Option<(MqttSettings, String, tauri::async_runtime::JoinHandle<()>)> = None;
    let mut applied_revision = None;

    loop {
        let revision = app
            .state::<MqttRuntime>()
            .configuration_revision
            .load(Ordering::Acquire);

        if applied_revision == Some(revision) {
            tokio::time::sleep(Duration::from_secs(3)).await;
            continue;
        }

        let desired = match load_client_settings_internal(&app) {
            Ok(Some(settings)) => match settings.mqtt {
                Some(mqtt) => match load_mqtt_password() {
                    Ok(Some(password)) => Some((mqtt, password)),
                    Ok(None) => None,
                    Err(error) => {
                        eprintln!("Bellwake MQTT credential error: {error}");
                        None
                    }
                },
                None => None,
            },
            Ok(None) => None,
            Err(error) => {
                eprintln!("Bellwake MQTT settings error: {error}");
                None
            }
        };

        applied_revision = Some(revision);

        let changed = match (&running, &desired) {
            (None, None) => false,
            (Some((current_mqtt, current_password, _)), Some((next_mqtt, next_password))) => {
                current_mqtt != next_mqtt || current_password != next_password
            }
            _ => true,
        };

        if changed {
            if let Some((_, _, task)) = running.take() {
                task.abort();
            }
            clear_pending(&app, true);
            if let Some((mqtt, password)) = desired {
                let task = tauri::async_runtime::spawn(mqtt_connection(
                    app.clone(), mqtt.clone(), password.clone(),
                ));
                running = Some((mqtt, password, task));
            }
        }
        tokio::time::sleep(Duration::from_secs(3)).await;
    }
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

fn load_mqtt_password() -> Result<Option<String>, String> {
    #[cfg(debug_assertions)]
    if let Ok(password) = std::env::var("BELLWAKE_MQTT_PASSWORD") {
        if !password.is_empty() {
            return Ok(Some(password));
        }
    }

    load_secret(KEYRING_MQTT_PASSWORD)
}

fn load_client_token(app: &tauri::AppHandle) -> Result<Option<String>, String> {
    let runtime = app.state::<MqttRuntime>();

    if let Some(token) = runtime
        .client_token
        .lock()
        .map_err(|_| "Client token cache lock poisoned".to_string())?
        .clone()
    {
        return Ok(Some(token));
    }

    #[cfg(debug_assertions)]
    let token = match std::env::var("BELLWAKE_CLIENT_TOKEN")
        .ok()
        .filter(|value| !value.is_empty())
    {
        Some(token) => Some(token),
        None => load_secret(KEYRING_CLIENT_TOKEN)?,
    };

    #[cfg(not(debug_assertions))]
    let token = load_secret(KEYRING_CLIENT_TOKEN)?;

    if let Some(token) = token.as_ref() {
        *runtime
            .client_token
            .lock()
            .map_err(|_| "Client token cache lock poisoned".to_string())? = Some(token.clone());
    }

    Ok(token)
}

fn cache_client_token(app: &tauri::AppHandle, token: &str) -> Result<(), String> {
    *app
        .state::<MqttRuntime>()
        .client_token
        .lock()
        .map_err(|_| "Client token cache lock poisoned".to_string())? = Some(token.to_string());

    Ok(())
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
    use std::os::windows::process::CommandExt;
    use std::process::Command;

    const CREATE_NO_WINDOW: u32 = 0x08000000;

    let output = Command::new("whoami")
        .args(["/user", "/fo", "csv", "/nh"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let line = stdout.trim();

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
async fn acknowledge_notification(
    app: tauri::AppHandle,
    notification_id: u64,
) -> Result<AcknowledgeResult, String> {
    let settings = load_client_settings_internal(&app)?
        .ok_or_else(|| "Bellwake is not configured".to_string())?;
    let client = collect_client_identity()?;
    let client_token = load_client_token(&app)?
        .ok_or_else(|| "Bellwake client token is unavailable".to_string())?;
    let base_url = settings.server_url.trim_end_matches('/');
    let url = format!("{base_url}/api/notifications/{notification_id}/acknowledge");

    let response = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|error| format!("Unable to create HTTP client: {error}"))?
        .post(&url)
        .bearer_auth(&client_token)
        .header("X-Bellwake-Device-Id", &client.device.device_id)
        .send()
        .await
        .map_err(|error| format!("Unable to acknowledge notification: {error}"))?;

    let status = response.status();

    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();

        return Err(format!(
            "Bellwake acknowledgement failed: HTTP {status}: {body}"
        ));
    }

    let acknowledged = response
        .json::<AcknowledgeApiResponse>()
        .await
        .map_err(|error| format!("Unable to decode acknowledgement: {error}"))?;

    if acknowledged.notification_id != notification_id || !acknowledged.acknowledged {
        return Err("Bellwake server did not confirm the acknowledgement".to_string());
    }

    println!(
        "Notification {} acknowledged by {} on {}",
        notification_id,
        client.user.username,
        client.device.hostname
    );

    Ok(AcknowledgeResult {
        notification_id,
        acknowledged: acknowledged.acknowledged,
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
	let client_token = load_client_token(&app)?;
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

		cache_client_token(&app, client_token)?;
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
	notify_mqtt_configuration_changed(&app);

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
) -> Result<Option<Notification>, String> {
	let settings = load_client_settings_internal(&app)?
		.ok_or_else(|| "Bellwake is not configured".to_string())?;
	let identity = collect_client_identity()?;
	let client_token = load_client_token(&app)?
		.ok_or_else(|| "Bellwake client token is unavailable".to_string())?;

	let base_url = settings.server_url.trim_end_matches('/');
	let url = format!("{base_url}/api/notifications/{notification_id}/delivery");

	let client = reqwest::Client::builder()
		.timeout(std::time::Duration::from_secs(10))
		.build()
		.map_err(|error| format!("Unable to create HTTP client: {error}"))?;

	let response = client
		.get(&url)
		.bearer_auth(&client_token)
		.header("X-Bellwake-Device-Id", &identity.device.device_id)
		.send()
		.await
		.map_err(|error| format!("Unable to request notification: {error}"))?;

	if response.status() == reqwest::StatusCode::NO_CONTENT {
		#[cfg(debug_assertions)]
		println!("Bellwake notification {notification_id} was already acknowledged");

		return Ok(None);
	}

	if !response.status().is_success() {
		return Err(format!(
			"Bellwake server returned HTTP {}",
			response.status()
		));
	}

	let notification = response
		.json::<Notification>()
		.await
		.map_err(|error| format!("Unable to decode notification: {error}"))?;

	#[cfg(debug_assertions)]
	println!(
		"Bellwake notification {} loaded from REST",
		notification.id
	);

	Ok(Some(notification))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_opener::init())
        .manage(relay::RelayState::default())
        .manage(MqttRuntime::default())
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            #[cfg(not(debug_assertions))]
            {
                use tauri_plugin_autostart::ManagerExt;

                let autostart = app.autolaunch();
                match autostart.is_enabled() {
                    Ok(true) => {}
                    Ok(false) => {
                        if let Err(error) = autostart.enable() {
                            eprintln!("Не удалось включить автозапуск Bellwake: {error}");
                        }
                    }
                    Err(error) => {
                        eprintln!("Не удалось проверить автозапуск Bellwake: {error}");
                    }
                }
            }

            /*
             * Bellwake работает как фоновый агент. Главное окно остаётся скрытым,
             * пока Vue не будет готов показать экран настройки или полностью загруженное уведомление.
             */
            if let Some(window) = app.get_webview_window("main") {
                #[cfg(target_os = "windows")]
                window.set_skip_taskbar(true)?;

                let _ = window.hide();
            }

            let handle = app.handle().clone();
            tauri::async_runtime::spawn(mqtt_supervisor(handle));
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_client_identity,
            get_client_settings,
            save_server_url,
            enroll_client,
            relay::start_relay_pairing,
            relay::stop_relay_pairing,
            get_notification,
            acknowledge_notification,
            get_pending_notification_ids,
            dismiss_notification,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
