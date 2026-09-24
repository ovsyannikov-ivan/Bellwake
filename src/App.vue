<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import MarkdownIt from "markdown-it";
import { currentMonitor, getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import QrcodeVue from "qrcode.vue";

const MIN_HEIGHT = 280;
const MAX_SCREEN_RATIO = 0.8;

const contentRef = ref(null);
const isConstrained = ref(false);
const isAcknowledging = ref(false);

const notification = ref(null);
const isSetup = ref(false);
const isSavingSetup = ref(false);
const setupServerUrl = ref("");
const setupEnrollmentToken = ref("");
const setupError = ref("");
const setupMode = ref("connecting"); // connecting | qr | manual | received — внутренние состояния экрана настройки
const manualSetupReason = ref(null); // user | unavailable — причина перехода к ручной настройке
const relaySocketId = ref("");
const relayListeners = [];
const notificationListeners = [];

const md = new MarkdownIt({
	html: false,
	linkify: true,
	typographer: true,
	breaks: true,
});

/*
 * Rust управляет MQTT-соединением и очередью ожидающих ID даже тогда,
 * когда это окно скрыто. Событие служит только сигналом пробуждения —
 * актуальное состояние очереди всегда читаем из Rust.
 */
let queueSync = Promise.resolve();

const synchronizeNotifications = async (refreshCurrent = false) => {
	if (isSetup.value || isAcknowledging.value) return;

	const pendingIds = await invoke("get_pending_notification_ids");
	const currentId = notification.value?.id;

	if (currentId && pendingIds.includes(currentId) && !refreshCurrent) return;

	if (pendingIds.length === 0) {
		notification.value = null;
		await getCurrentWindow().hide();
		return;
	}

	/*
	 * Если приходит ещё одно уведомление, текущее остаётся на экране.
	 * Текущий ID тоже запрашиваем повторно на случай, если администратор отредактировал уведомление.
	 */
	const notificationId = currentId && pendingIds.includes(currentId)
		? currentId
		: pendingIds[0];

	try {
		const loaded = await invoke("get_notification", { notificationId });

		// Пока выполнялся HTTP-запрос, могло прийти пустое retained-сообщение об отмене уведомления.
		const latestIds = await invoke("get_pending_notification_ids");
		if (!latestIds.includes(notificationId)) {
			void requestQueueSync();
			return;
		}

		notification.value = loaded;
		await nextTick();
		if (document.fonts?.ready) await document.fonts.ready;
		await resizeWindowToContent();

		const window = getCurrentWindow();
		const wasVisible = await window.isVisible();
		if (!wasVisible) {
			await window.show();
			await window.setFocus();
		}
	} catch (error) {
		console.error(`Unable to load Bellwake notification ${notificationId}:`, error);
		/*
		 * Оставляем ID в Rust, чтобы повторить загрузку после временной ошибки REST.
		 * До этого момента старое или уже отменённое уведомление не показываем.
		 */
		if (!currentId || currentId !== notificationId) {
			notification.value = null;
			await getCurrentWindow().hide();
		}
	}
};

const requestQueueSync = (refreshCurrent = false) => {
	queueSync = queueSync.catch((error) => {
		console.error("Bellwake queue synchronization error:", error);
	}).then(() => synchronizeNotifications(refreshCurrent));
	return queueSync;
};

const renderedMessage = computed(() => {
	if (!notification.value) return "";
	return md.render(notification.value.body);
});
const acknowledgeLabels = ["Принято", "Всё понятно", "Я в курсе", "Ладно", "Уф, ладно", "Сообщение принято", "Да-да, уже знаю", "Прочитано, честно", "Ладно, убедили", "Окей, шеф", "Буду знать"];
const acknowledgeLabel = acknowledgeLabels[Math.floor(Math.random() * acknowledgeLabels.length)];

const acknowledge = async () => {
	if (isAcknowledging.value) return;

	isAcknowledging.value = true;

	try {
		const result = await invoke("acknowledge_notification", {
			notificationId: notification.value.id,
		});

		console.log("Acknowledge result:", result);

		if (result.acknowledged) {
			const notificationId = notification.value.id;

			/*
			 * Сначала скрываем окно. Если очистить состояние Vue, пока нативное окно ещё видно,
			 * между уведомлениями на короткое время появляется пустое серое окно.
			 */
			await getCurrentWindow().hide();
			notification.value = null;
			await invoke("dismiss_notification", { notificationId });
		}
	} catch (error) {
		console.error("Acknowledge error:", error);
	} finally {
		isAcknowledging.value = false;
		await requestQueueSync();
	}
};

const resizeWindowToContent = async () => {
	if (!contentRef.value) return;
	isConstrained.value = false;

	await nextTick();

	const appWindow = getCurrentWindow();
	const monitor = await currentMonitor();
	const innerSize = await appWindow.innerSize();
	const scaleFactor = await appWindow.scaleFactor();
	const logicalWindowSize = innerSize.toLogical(scaleFactor);
	let maxHeight = 720;

	if (monitor) {
		const workArea = monitor.workArea.size.toLogical(monitor.scaleFactor);
		maxHeight = Math.floor(workArea.height * MAX_SCREEN_RATIO);
	}

	const rootFontSize = parseFloat(getComputedStyle(document.documentElement).fontSize);
	const WINDOW_HEIGHT_PADDING = rootFontSize * 2.5;
	const contentHeight = Math.ceil(contentRef.value.scrollHeight) + WINDOW_HEIGHT_PADDING;
	const targetHeight = Math.min(maxHeight, Math.max(MIN_HEIGHT, contentHeight));

	isConstrained.value = contentHeight > maxHeight;

	await appWindow.setSize(new LogicalSize(logicalWindowSize.width, targetHeight));
	await appWindow.center();
};

const startRelaySetup = async () => {
	setupMode.value = "connecting";
	manualSetupReason.value = null;
	relaySocketId.value = "";
	setupError.value = "";

	try {
		await invoke("start_relay_pairing");
	} catch (error) {
		console.warn("Bellwake bootstrap connection failed:", error);
		setupMode.value = "manual";
		manualSetupReason.value = "unavailable";
		setupError.value = "Сервер автоматической настройки недоступен";
	}
};

const showManualSetup = async () => {
	setupMode.value = "manual";
	manualSetupReason.value = "user";
	relaySocketId.value = "";
	setupError.value = "";

	try {
		await invoke("stop_relay_pairing");
	} catch (error) {
		console.warn("Unable to stop pairing connection:", error);
	}
};

const saveSetup = async () => {
	if (isSavingSetup.value) return;
	setupError.value = "";
	isSavingSetup.value = true;
	try {
		await invoke("save_server_url", {
			serverUrl: setupServerUrl.value,
		});

		const settings = await invoke("enroll_client", {
			enrollmentToken: setupEnrollmentToken.value,
		});

		console.log("Bellwake enrollment completed:", settings);

		setupEnrollmentToken.value = "";
		isSetup.value = false;
		await getCurrentWindow().hide();
		await requestQueueSync(); // Фоновый MQTT-обработчик запускается после сохранения настроек.
	} catch (error) {
		console.error("Bellwake setup error:", error);
		setupError.value = String(error);
	} finally {
		isSavingSetup.value = false;
	}
};

onMounted(async () => {
	const appWindow = getCurrentWindow();
	await appWindow.hide();

	try {
		/*
		 * Подписываемся на события ДО чтения очереди Rust:
		 * retained-сообщения MQTT могут прийти сразу после установки соединения.
		 */
		notificationListeners.push(
			await listen("bellwake-notification", () => {
				void requestQueueSync(true);
			}),
		);

		relayListeners.push(
			await listen("bellwake-relay-connected", ({ payload }) => {
				if (!isSetup.value || setupMode.value !== "connecting") return;
				relaySocketId.value = payload.socketId;
				setupMode.value = "qr";
			}),
		);

		relayListeners.push(
			await listen("bellwake-relay-unavailable", () => {
				if (!isSetup.value || !["connecting", "qr"].includes(setupMode.value)) return;

				const wasConnected = setupMode.value === "qr";

				setupMode.value = "manual";
				manualSetupReason.value = "unavailable";
				relaySocketId.value = "";
				setupError.value = wasConnected ? "Соединение с сервером автоматической настройки прервано" : "Сервер автоматической настройки недоступен";
			}),
		);

		relayListeners.push(
			await listen("bellwake-relay-enrolled", async ({ payload }) => {
				if (!isSetup.value) return;

				setupServerUrl.value = payload.serverUrl;
				setupEnrollmentToken.value = "";
				setupError.value = "";
				manualSetupReason.value = null;
				relaySocketId.value = "";
				setupMode.value = "received";

				try {
					isSetup.value = false;
					await getCurrentWindow().hide();
					await requestQueueSync();
				} catch (error) {
					console.error("Bellwake initialization after automatic enrollment failed:", error);
					setupError.value = "Настройка завершена, но не удалось запустить Bellwake";
				}
			}),
		);

		relayListeners.push(
			await listen("bellwake-relay-enrollment-failed", ({ payload }) => {
				if (!isSetup.value) return;

				if (payload?.serverUrl) {
					setupServerUrl.value = payload.serverUrl;
				}

				relaySocketId.value = "";
				setupMode.value = "manual";
				manualSetupReason.value = "unavailable";
				setupError.value = "Не удалось завершить автоматическую настройку";
			}),
		);

		const settings = await invoke("get_client_settings");
		setupServerUrl.value = settings?.serverUrl ?? "";

		if (!settings?.mqtt) {
			isSetup.value = true;
			await appWindow.show();
			await startRelaySetup();
		} else {
			await requestQueueSync();
		}

		await nextTick();
		if (document.fonts?.ready) await document.fonts.ready;
		await resizeWindowToContent();
	} catch (error) {
		console.error("Bellwake initialization error:", error);
	}
});

let retryTimer;
onMounted(() => {
	// Если REST временно недоступен, не теряем ID, полученный через MQTT.
	retryTimer = window.setInterval(() => {
		if (!isSetup.value && !isAcknowledging.value) void requestQueueSync();
	}, 15000);
});

onUnmounted(() => {
	clearInterval(retryTimer);
	for (const unlisten of notificationListeners) unlisten();
	for (const unlisten of relayListeners) unlisten();
	void invoke("stop_relay_pairing").catch(() => {});
});

watch(
	[notification, isSetup, setupMode, relaySocketId, setupError],
	async () => {
		await nextTick();
		await resizeWindowToContent();
	},
	{
		deep: true,
		flush: "post",
	},
);
</script>

<template>
	<main ref="contentRef" class="bellwake p-4" :class="{ 'is-constrained': isConstrained }">
		<div class="container-fluid">
			<div v-if="isSetup" class="bellwake-content d-flex flex-column">
				<h1 class="mb-4">Настройка Bellwake</h1>

				<div v-if="setupMode === 'connecting'" class="text-center">
					<div class="spinner-border text-primary mb-3" role="status" />
					<p>Подключаемся к серверу автоматической настройки…</p>
					<button type="button" class="btn btn-secondary" @click="showManualSetup">Настроить вручную</button>
				</div>

				<div v-else-if="setupMode === 'qr'" class="text-center">
					<h2 class="h5 mb-3">Подключение устройства</h2>
					<div class="qr-box d-inline-flex p-3 bg-white rounded mb-3">
						<QrcodeVue :value="relaySocketId" :size="200" level="M" render-as="svg" />
					</div>
					<p class="text-muted small">Отсканируйте QR-код через панель администратора</p>
					<button type="button" class="btn btn-secondary" @click="showManualSetup">Настроить вручную</button>
				</div>

				<div v-else-if="setupMode === 'received'" class="text-center">
					<div class="spinner-border text-primary mb-3" role="status" />
					<p class="mb-3">Настройка Bellwake завершена</p>
					<div v-if="setupError" class="alert alert-warning mt-3" role="alert">
						{{ setupError }}
					</div>
				</div>

				<form v-else @submit.prevent="saveSetup">
					<div v-if="setupError" class="alert alert-warning" role="alert">
						{{ setupError }}
					</div>

					<div class="form-floating mb-2">
						<input id="server-url" v-model.trim="setupServerUrl" type="url" class="form-control" placeholder="https://bellwake.example.org" autocomplete="off" required />
						<label for="server-url">Адрес сервера</label>
					</div>
					<div class="form-text small text-muted mb-4">Пример: https://bellwake.example.org</div>

					<div class="form-floating mb-2">
						<input id="enrollment-token" v-model.trim="setupEnrollmentToken" type="password" class="form-control" placeholder="Enrollment токен" autocomplete="off" required />
						<label for="enrollment-token">Токен подключения</label>
					</div>
					<div class="form-text small text-muted mb-4">Код, полученный у администратора.</div>

					<div class="text-center pt-3">
						<div class="mt-2">
							<button type="button" class="btn btn-secondary me-2" :disabled="isSavingSetup" @click="startRelaySetup">
								{{ manualSetupReason === "unavailable" ? "Повторить попытку" : "Автоматическая настройка" }}
							</button>
							<button type="submit" class="btn btn-primary px-5" :disabled="isSavingSetup">
								<span v-if="isSavingSetup" class="spinner-border spinner-border-sm me-2" />
								{{ isSavingSetup ? "Подключаю…" : "Продолжить" }}
							</button>
						</div>
					</div>
				</form>
			</div>

			<div v-else-if="notification" class="bellwake-content d-flex flex-column">
				<h1 class="mb-4">{{ notification.title }}</h1>
				<div class="bellwake-message" v-html="renderedMessage" />

				<div class="bellwake-actions text-center mt-auto pt-4">
					<button class="btn btn-primary px-5" @click="acknowledge" :disabled="isAcknowledging">
						<span v-if="isAcknowledging" class="spinner-border spinner-border-sm me-2" />
						{{ isAcknowledging ? "Подтверждаю…" : acknowledgeLabel }}
					</button>
				</div>
			</div>
		</div>
	</main>
</template>

<style>
:root {
	--bs-border-radius: 0.5rem;
}
</style>

<style scoped lang="scss">
.bellwake {
	&.is-constrained {
		height: 100vh;
		.container-fluid,
		.bellwake-content {
			height: 100%;
		}
		.bellwake-content {
			min-height: 0;
		}
		.bellwake-message {
			flex: 1 1 auto;
			min-height: 0;
		}
	}
	&-message {
		overflow-y: auto;
		:deep(h1) {
			margin-bottom: 1.5rem;
		}
		:deep(blockquote) {
			margin: 1.5rem 0;
			padding-left: 1rem;
			border-left: 4px solid var(--bs-border-color);
			color: var(--bs-secondary-color);
		}
	}
	&-actions {
		flex-shrink: 0;
	}
}
</style>
