<script setup>
import { nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { Modal } from "bootstrap";
import QrScanner from "qr-scanner";

const props = defineProps({
	csrfToken: { type: String, required: true },
});
const emit = defineEmits(["unauthorized"]);

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const modalElement = ref(null);
const videoElement = ref(null);
const phase = ref("scanner");
const cameraState = ref("idle");
const recognizedSocketId = ref("");
const scanMessage = ref("");
const submitMessage = ref("");
const submitting = ref(false);

let modal;
let scanner;
let scannerRevision = 0;
let requestController;
let requestTimeout;

const stopScanner = () => {
	scannerRevision += 1;

	if (scanner) {
		scanner.destroy();
		scanner = null;
	}

	const stream = videoElement.value?.srcObject;
	if (stream?.getTracks) {
		for (const track of stream.getTracks()) track.stop();
	}
	if (videoElement.value) videoElement.value.srcObject = null;

	cameraState.value = "idle";
};

const getCameraErrorMessage = (error) => {
	if (!window.isSecureContext) return "Камера доступна только при открытии панели по HTTPS.";

	switch (error?.name) {
		case "NotAllowedError":
		case "PermissionDeniedError":
			return "Доступ к камере запрещён. Разрешите его в настройках браузера и повторите попытку.";
		case "NotFoundError":
		case "DevicesNotFoundError":
			return "Камера на этом устройстве не найдена.";
		case "NotReadableError":
		case "TrackStartError":
			return "Камера занята другим приложением или недоступна.";
		default:
			return "Не удалось запустить камеру. Проверьте разрешение браузера и повторите попытку.";
	}
};

const onDecode = (result) => {
	if (phase.value !== "scanner" || recognizedSocketId.value) return;

	const socketId = String(result?.data ?? "").trim().toLowerCase();
	if (!UUID_V4_RE.test(socketId)) {
		scanMessage.value = "Этот QR-код не является кодом подключения Bellwake.";
		return;
	}

	recognizedSocketId.value = socketId;
	scanMessage.value = "";
	phase.value = "confirm";
	stopScanner();
};

const startScanner = async () => {
	stopScanner();
	const revision = scannerRevision;
	scanMessage.value = "";
	cameraState.value = "starting";

	await nextTick();

	if (!navigator.mediaDevices?.getUserMedia) {
		cameraState.value = "error";
		scanMessage.value = "Этот браузер не поддерживает доступ к камере.";
		return;
	}

	const video = videoElement.value;
	if (!video) {
		cameraState.value = "error";
		scanMessage.value = "Не удалось подготовить окно камеры. Закройте окно и повторите попытку.";
		return;
	}

	let instance;
	try {
		instance = new QrScanner(video, onDecode, {
			preferredCamera: "environment",
			maxScansPerSecond: 10,
			returnDetailedScanResult: true,
		});
		scanner = instance;
		await instance.start();
		if (revision !== scannerRevision || scanner !== instance) {
			instance.destroy();
			return;
		}
		cameraState.value = "active";
	} catch (error) {
		if (scanner === instance) scanner = null;
		instance?.destroy();
		if (revision !== scannerRevision) return;

		cameraState.value = "error";
		scanMessage.value = getCameraErrorMessage(error);
	}
};

const reset = () => {
	stopScanner();
	phase.value = "scanner";
	recognizedSocketId.value = "";
	scanMessage.value = "";
	submitMessage.value = "";
	submitting.value = false;
};

const open = () => {
	if (modalElement.value?.classList.contains("show") || modalElement.value?.classList.contains("showing")) return;
	reset();
	modal ??= Modal.getOrCreateInstance(modalElement.value, {
		backdrop: "static",
		keyboard: false,
	});
	modal.show();
};

const scanAgain = async () => {
	recognizedSocketId.value = "";
	submitMessage.value = "";
	phase.value = "scanner";
	await startScanner();
};

const getApprovalErrorMessage = (status, payload) => {
	switch (payload?.error) {
		case "invalid_socket_id":
			return "Сервер отклонил идентификатор. Отсканируйте QR-код ещё раз.";
		case "relay_timeout":
			return "Cloudflare Relay не ответил вовремя. Повторите попытку.";
		case "relay_delivery_failed":
			return "Не удалось передать настройки устройству. QR-код мог устареть или Cloudflare Relay сейчас недоступен.";
		case "pairing_already_approved":
			return "Этот QR-код уже подтверждён. Дождитесь завершения регистрации устройства.";
		default:
			return status >= 500
				? "Сервер временно не может подключить устройство. Повторите попытку позже."
				: "Не удалось подключить устройство.";
	}
};

const approve = async () => {
	if (submitting.value || !UUID_V4_RE.test(recognizedSocketId.value)) return;

	submitting.value = true;
	submitMessage.value = "";
	requestController = new AbortController();
	requestTimeout = window.setTimeout(() => requestController?.abort(), 12000);

	try {
		const response = await fetch("/api/pairing/approve", {
			method: "POST",
			credentials: "same-origin",
			headers: {
				"Content-Type": "application/json",
				"X-Bellwake-Request": "admin",
				"X-CSRF-Token": props.csrfToken,
			},
			body: JSON.stringify({ socketId: recognizedSocketId.value }),
			signal: requestController.signal,
		});
		const payload = await response.json().catch(() => ({}));
		if (response.status === 401) {
			emit("unauthorized");
			return;
		}

		if (!response.ok) {
			throw new Error(getApprovalErrorMessage(response.status, payload));
		}
		if (payload?.delivered !== true) {
			throw new Error("Сервер не подтвердил передачу настроек устройству.");
		}

		phase.value = "success";
	} catch (error) {
		if (error?.name === "AbortError") {
			submitMessage.value = "Сервер не ответил вовремя. Проверьте соединение и повторите попытку.";
		} else if (error instanceof TypeError) {
			submitMessage.value = "Не удалось связаться с сервером Bellwake. Проверьте подключение к сети.";
		} else {
			submitMessage.value = error instanceof Error ? error.message : "Не удалось подключить устройство.";
		}
	} finally {
		window.clearTimeout(requestTimeout);
		requestTimeout = undefined;
		requestController = undefined;
		submitting.value = false;
	}
};

const onShown = () => {
	if (phase.value === "scanner") void startScanner();
};

const onHidden = () => {
	requestController?.abort();
	window.clearTimeout(requestTimeout);
	requestController = undefined;
	requestTimeout = undefined;
	reset();
};

onMounted(() => {
	modal = Modal.getOrCreateInstance(modalElement.value, {
		backdrop: "static",
		keyboard: false,
	});
	modalElement.value.addEventListener("shown.bs.modal", onShown);
	modalElement.value.addEventListener("hidden.bs.modal", onHidden);
});

onBeforeUnmount(() => {
	requestController?.abort();
	window.clearTimeout(requestTimeout);
	stopScanner();
	modalElement.value?.removeEventListener("shown.bs.modal", onShown);
	modalElement.value?.removeEventListener("hidden.bs.modal", onHidden);
	modal?.dispose();
});

defineExpose({ open });
</script>

<template>
	<div ref="modalElement" v-zindex-modal class="modal fade" tabindex="-1" aria-labelledby="pairing-modal-title">
		<div class="modal-dialog modal-dialog-centered modal-dialog-scrollable pairing-modal-dialog">
			<div class="modal-content">
				<div class="modal-header">
					<div id="pairing-modal-title" class="modal-title">Подключение устройства</div>
					<button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Закрыть" :disabled="submitting" />
				</div>

				<div class="modal-body">
					<template v-if="phase === 'scanner'">
						<div class="pairing-camera">
							<video ref="videoElement" class="pairing-camera-video" muted playsinline />
							<div class="pairing-camera-guide" aria-hidden="true" />
							<div v-if="cameraState === 'starting'" class="pairing-camera-status">
								<span class="spinner-border text-light" role="status" />
								<span>Запускаем камеру…</span>
							</div>
							<div v-else-if="cameraState === 'error'" class="pairing-camera-status">
								<i class="bi bi-camera-video-off fs-1" />
							</div>
						</div>
						<p class="mt-3 mb-0 text-body-secondary text-center">Наведите камеру на QR-код в окне нового агента Bellwake.</p>
						<div v-if="scanMessage" class="alert alert-warning mt-3 mb-0" role="alert" aria-live="polite">{{ scanMessage }}</div>
					</template>

					<template v-else-if="phase === 'confirm'">
						<div class="pairing-result-icon text-primary"><i class="bi bi-qr-code-scan" /></div>
						<p class="text-center mb-3">Проверьте распознанный идентификатор перед подключением устройства.</p>
						<div class="pairing-socket-id" aria-label="Распознанный идентификатор устройства">{{ recognizedSocketId }}</div>
						<div v-if="submitMessage" class="alert alert-danger mt-3 mb-0" role="alert" aria-live="assertive">{{ submitMessage }}</div>
					</template>

					<template v-else>
						<div class="pairing-result-icon text-success"><i class="bi bi-check-circle-fill" /></div>
						<h2 class="h5 text-center">Настройки отправлены</h2>
						<p class="mb-0 text-body-secondary text-center">Устройство завершит регистрацию и подключится к Bellwake автоматически.</p>
					</template>
				</div>

				<div class="modal-footer justify-content-between">
					<template v-if="phase === 'scanner'">
						<button type="button" class="btn btn-light border" data-bs-dismiss="modal">Отмена</button>
						<button v-if="cameraState === 'error'" type="button" class="btn btn-primary" @click="startScanner">
							<i class="bi bi-arrow-clockwise me-1" />Повторить
						</button>
					</template>
					<template v-else-if="phase === 'confirm'">
						<button type="button" class="btn btn-light border" :disabled="submitting" @click="scanAgain">
							<i class="bi bi-camera me-1" />Сканировать снова
						</button>
						<button type="button" class="btn btn-primary" :disabled="submitting" @click="approve">
							<span v-if="submitting" class="spinner-border spinner-border-sm me-2" />{{ submitting ? "Подключаем…" : "Подключить" }}
						</button>
					</template>
					<button v-else type="button" class="btn btn-primary ms-auto" data-bs-dismiss="modal">Готово</button>
				</div>
			</div>
		</div>
	</div>
</template>

<style scoped lang="scss">
.pairing-modal-dialog {
	max-width: 34rem;
}

.pairing-camera {
	position: relative;
	width: min(100%, 28rem);
	margin-inline: auto;
	overflow: hidden;
	aspect-ratio: 1;
	border: 1px solid var(--bs-border-color);
	border-radius: var(--bs-border-radius);
	background: var(--bs-dark);

	&-video {
		display: block;
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	&-guide {
		position: absolute;
		inset: 15%;
		border: 0.2rem solid rgba(255, 255, 255, 0.92);
		border-radius: var(--bs-border-radius);
		box-shadow: 0 0 0 100vmax rgba(0, 0, 0, 0.3);
		pointer-events: none;
	}

	&-status {
		position: absolute;
		inset: 0;
		display: grid;
		place-content: center;
		justify-items: center;
		gap: 0.75rem;
		color: var(--bs-light);
		background: rgba(var(--bs-dark-rgb), 0.82);
	}
}

.pairing-result-icon {
	display: grid;
	place-items: center;
	margin: 0.5rem auto 1rem;
	font-size: 3rem;
}

.pairing-socket-id {
	padding: 1rem;
	border: 1px solid var(--bs-border-color);
	border-radius: var(--bs-border-radius);
	background: var(--bs-tertiary-bg);
	font-family: var(--bs-font-monospace);
	font-size: 0.95rem;
	font-weight: 600;
	text-align: center;
	word-break: break-all;
}

@media (max-width: 575.98px) {
	.pairing-camera {
		width: 100%;
	}

	.modal-footer {
		gap: 0.75rem;

		.btn {
			flex: 1 1 auto;
		}
	}
}
</style>
