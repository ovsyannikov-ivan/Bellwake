<script setup>
import { inject, nextTick, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import { Modal } from "bootstrap";
import MarkdownEditor from "./MarkdownEditor.vue";
import { socketServiceKey } from "../symbols.js";
import { socketEmitAsync } from "../services/service.helpers.js";
import { modalErrorKey } from "../plugins/plugin.modalError.js";
import { useLoading } from "../plugins/plugin.loadingBackdrop.js";
import { socketErrorHandlerKey } from "../plugins/plugin.socketErrorHandler.js";

const emit = defineEmits(["saved"]);
const { socket } = inject(socketServiceKey);
const modalError = inject(modalErrorKey);
const loader = useLoading();
const handleSocketError = inject(socketErrorHandlerKey);
const modalElement = ref(null);
const editorRef = ref(null);
const formElement = ref(null);
const titleInput = ref(null);
const currentStep = ref(1);
const loading = ref(false);
const saving = ref(false);
const titleInvalid = ref(false);
const bodyInvalid = ref(false);
const codeVisible = ref(false);
const markdownCode = ref("");
const externalChange = ref(false);
let modal;

const emptyForm = () => ({ id: null, title: "", severity: "info", ackRequired: true, state: "draft", startsAt: "", expiresAt: "" });
const form = reactive(emptyForm());

const resetForm = () => {
	Object.assign(form, emptyForm());
	editorRef.value?.setMarkdown("");
	currentStep.value = 1;
	titleInvalid.value = false;
	bodyInvalid.value = false;
	codeVisible.value = false;
	markdownCode.value = "";
	externalChange.value = false;
};

const showModal = async () => {
	modal ??= Modal.getOrCreateInstance(modalElement.value, { backdrop: "static" });
	modal.show();
	await nextTick();
};

const openCreate = async () => {
	resetForm();
	await showModal();
};

const openEdit = async (id) => {
	resetForm();
	form.id = id;
	loading.value = true;
	await showModal();
	loader.show("pulse");
	try {
		const notification = await handleSocketError(() => socketEmitAsync(socket, "notifications:get", { id }), "Не удалось открыть уведомление");
		Object.assign(form, {
			id: notification.id,
			title: notification.title,
			severity: notification.severity,
			ackRequired: notification.ackRequired,
			state: notification.state,
			startsAt: notification.startsAt ?? "",
			expiresAt: notification.expiresAt ?? "",
		});
		editorRef.value?.setMarkdown(notification.body);
	} catch {
		modal.hide();
	} finally {
		loading.value = false;
		loader.hide();
	}
};

const onShown = async () => {
	await editorRef.value?.initialize();
	await editorRef.value?.resize();
	if (!loading.value) titleInput.value?.focus();
};

const toggleCode = async () => {
	markdownCode.value = editorRef.value?.getMarkdown() ?? "";
	codeVisible.value = !codeVisible.value;
	await editorRef.value?.resize();
};

const goToSettings = async () => {
	const body = editorRef.value?.getMarkdown().trim() ?? "";
	titleInvalid.value = !form.title.trim();
	bodyInvalid.value = !body;

	if (titleInvalid.value) {
		titleInput.value?.focus();
		return;
	}
	if (bodyInvalid.value) {
		editorRef.value?.focus();
		return;
	}

	currentStep.value = 2;
};

const goToContent = async () => {
	currentStep.value = 1;
	await editorRef.value?.resize();
};

const save = async () => {
	if (saving.value || loading.value) return;
	formElement.value.classList.add("was-validated");
	if (!formElement.value.checkValidity()) return;

	const body = editorRef.value?.getMarkdown().trim() ?? "";
	if (!body) {
		modalError.show("Введите текст уведомления", "Не удалось сохранить уведомление");
		return;
	}

	saving.value = true;
	try {
		const event = form.id ? "notifications:update" : "notifications:create";
		await handleSocketError(
			() =>
				socketEmitAsync(socket, event, {
					...(form.id ? { id: form.id } : {}),
					title: form.title,
					body,
					severity: form.severity,
					ackRequired: form.ackRequired,
					state: form.state,
					startsAt: form.startsAt || null,
					expiresAt: form.expiresAt || null,
				}),
			"Не удалось сохранить уведомление",
		);
		modal.hide();
		emit("saved");
	} catch {
		// The shared Socket.IO handler has already shown the error modal.
	} finally {
		saving.value = false;
	}
};

const notifyExternalChange = ({ action, id }) => {
	if (action === "updated" && Number(id) === Number(form.id) && modalElement.value?.classList.contains("show")) {
		externalChange.value = true;
	}
};

const onHidden = () => {
	formElement.value?.classList.remove("was-validated");
	currentStep.value = 1;
};
onMounted(() => {
	modalElement.value.addEventListener("shown.bs.modal", onShown);
	modalElement.value.addEventListener("hidden.bs.modal", onHidden);
});
onBeforeUnmount(() => {
	modalElement.value?.removeEventListener("shown.bs.modal", onShown);
	modalElement.value?.removeEventListener("hidden.bs.modal", onHidden);
	modal?.dispose();
});
defineExpose({ openCreate, openEdit, notifyExternalChange });
</script>

<template>
	<div ref="modalElement" v-zindex-modal class="modal fade notification-modal" tabindex="-1" aria-labelledby="notification-modal-title">
		<div class="modal-dialog modal-xl modal-dialog-scrollable modal-fullscreen-sm-down notification-modal-dialog">
			<div class="modal-content notification-modal-content">
				<div class="modal-header px-3 px-md-4">
					<div id="notification-modal-title" class="modal-title fs-4">{{ form.id ? `Уведомление #${form.id}` : "Новое уведомление" }}</div>
					<button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Закрыть" />
				</div>

				<form ref="formElement" class="notification-modal-form" novalidate @submit.prevent="save">
					<div class="modal-body p-3 p-md-4 notification-modal-body">
						<div v-if="externalChange" class="alert alert-warning d-flex gap-2 align-items-start" role="alert">
							<i class="bi bi-exclamation-triangle-fill" />
							<div>
								<strong>Уведомление изменено другим администратором.</strong><br /><span class="small">Ваш текст сохранён в форме. Закройте её без сохранения, чтобы загрузить актуальную версию.</span>
							</div>
						</div>

						<ol class="notification-stepper list-unstyled d-flex align-items-center gap-2 mb-3" aria-label="Этапы формы">
							<li class="d-flex align-items-center gap-2" :class="currentStep === 1 ? 'text-primary fw-semibold' : 'text-body-secondary'" :aria-current="currentStep === 1 ? 'step' : undefined">
								<span class="badge rounded-pill" :class="currentStep === 1 ? 'text-bg-primary' : 'text-bg-secondary'">1</span><span>Содержание</span>
							</li>
							<li class="text-body-tertiary" aria-hidden="true"><i class="bi bi-chevron-right" /></li>
							<li class="d-flex align-items-center gap-2" :class="currentStep === 2 ? 'text-primary fw-semibold' : 'text-body-secondary'" :aria-current="currentStep === 2 ? 'step' : undefined">
								<span class="badge rounded-pill" :class="currentStep === 2 ? 'text-bg-primary' : 'text-bg-secondary'">2</span><span>Параметры</span>
							</li>
						</ol>

						<div class="notification-steps" :class="{ 'opacity-25 pe-none': loading }">
							<section v-show="currentStep === 1" class="notification-step notification-step-content" aria-labelledby="notification-content-step">
								<div class="mb-3">
									<input
										id="notification-title"
										ref="titleInput"
										v-model.trim="form.title"
										class="form-control"
										:class="{ 'is-invalid': titleInvalid }"
										maxlength="255"
										autocomplete="off"
										required
										placeholder="Заголовок уведомления"
										@input="titleInvalid = false"
									/>
									<div class="invalid-feedback">Введите заголовок</div>
								</div>

								<div class="notification-editor-field">
									<div class="d-flex align-items-center justify-content-between gap-3 mb-2">
										<button type="button" class="btn btn-sm btn-outline-secondary" @click="toggleCode"><i class="bi bi-code-slash me-1" />{{ codeVisible ? "Скрыть код" : "Посмотреть код" }}</button>
									</div>
									<MarkdownEditor ref="editorRef" @change="bodyInvalid = false" />
									<div v-if="bodyInvalid" class="invalid-feedback d-block mt-2">Введите текст уведомления.</div>
									<div v-if="codeVisible" class="markdown-code mt-3">
										<div class="small fw-semibold text-body-secondary mb-2">Исходный Markdown</div>
										<pre class="mb-0">{{ markdownCode || "—" }}</pre>
									</div>
								</div>
							</section>

							<section v-show="currentStep === 2" class="notification-step notification-step-settings" aria-label="Параметры уведомления">
								<div class="row g-3 mb-4">
									<div class="col-md-4">
										<label for="severity" class="form-label fw-semibold">Важность</label
										><select id="severity" v-model="form.severity" class="form-select">
											<option value="info">Информационная</option>
											<option value="warning">Предупреждение</option>
											<option value="critical">Критическая</option>
										</select>
									</div>
									<div class="col-md-4">
										<label for="state" class="form-label fw-semibold">Статус</label
										><select id="state" v-model="form.state" class="form-select">
											<option value="draft">Черновик</option>
											<option value="active">Активно</option>
											<option value="archived">В архиве</option>
										</select>
									</div>
									<div class="col-md-4 d-flex align-items-end">
										<div class="form-check form-switch rounded border w-100 p-2 ps-5">
											<input id="ack-required" v-model="form.ackRequired" class="form-check-input" type="checkbox" /><label class="form-check-label" for="ack-required"
												>Требовать подтверждение</label
											>
										</div>
									</div>
								</div>
								<div class="row g-3">
									<div class="col-md-6">
										<label for="starts-at" class="form-label fw-semibold">Начало действия</label><input id="starts-at" v-model="form.startsAt" type="datetime-local" class="form-control" />
										<div class="form-text">Оставьте пустым, если ограничение не требуется.</div>
									</div>
									<div class="col-md-6">
										<label for="expires-at" class="form-label fw-semibold">Окончание действия</label
										><input id="expires-at" v-model="form.expiresAt" type="datetime-local" class="form-control" :min="form.startsAt || undefined" />
										<div class="form-text">Дата указывается в локальном времени организации.</div>
									</div>
								</div>
							</section>
						</div>
					</div>
					<div class="modal-footer justify-content-between px-md-4 py-4">
						<template v-if="currentStep === 1">
							<button type="button" class="btn btn-light border" data-bs-dismiss="modal" :disabled="loading">Отмена</button>
							<button type="button" class="btn btn-primary px-4" :disabled="loading" @click="goToSettings">Далее <i class="bi bi-arrow-right ms-1" /></button>
						</template>
						<template v-else>
							<button type="button" class="btn btn-light border" :disabled="saving" @click="goToContent"><i class="bi bi-arrow-left me-1" />Назад</button>
							<button type="submit" class="btn btn-primary px-4" :disabled="saving || loading">
								<span v-if="saving" class="spinner-border spinner-border-sm me-2" />{{ saving ? "Сохраняем…" : "Сохранить" }}
							</button>
						</template>
					</div>
				</form>
			</div>
		</div>
	</div>
</template>

<style scoped lang="scss">
.notification-modal {
	&-dialog {
		height: calc(100dvh - 2rem);
		max-height: calc(100dvh - 2rem);
		margin-block: 1rem;
	}

	&-content {
		height: 100%;
		max-height: 100%;
	}

	&-form,
	&-body,
	.notification-steps,
	.notification-step-content,
	.notification-editor-field {
		display: flex;
		flex-direction: column;
		min-height: 0;
	}

	&-form {
		flex: 1 1 auto;
	}

	&-body,
	.notification-steps,
	.notification-step,
	.notification-editor-field {
		flex: 1 1 auto;
	}

	&-body {
		overflow: hidden;
	}

	.notification-stepper {
		flex: 0 0 auto;
		font-size: 0.875rem;
	}

	.notification-step {
		width: 100%;
		min-height: 0;

		&-settings {
			overflow-y: auto;
		}
	}

	.notification-editor-field {
		:deep(.markdown-editor) {
			flex: 1 1 auto;
			min-height: 0;
		}
	}
}

.markdown-code {
	max-height: min(12rem, 25dvh);
	overflow: auto;
	padding: 1rem;
	border: 1px solid var(--bs-border-color);
	border-radius: var(--bs-border-radius);
	background: var(--bs-tertiary-bg);

	pre {
		white-space: pre-wrap;
		word-break: break-word;
		color: var(--bs-body-color);
		font-size: 0.82rem;
	}
}

@media (max-width: 575.98px) {
	.notification-modal {
		&-dialog {
			height: 100dvh;
			max-height: 100dvh;
			margin: 0;
		}

		&-content {
			height: 100dvh;
			max-height: 100dvh;
		}

		.notification-stepper {
			gap: 0.375rem !important;
			font-size: 0.8125rem;
		}
	}
}
</style>
