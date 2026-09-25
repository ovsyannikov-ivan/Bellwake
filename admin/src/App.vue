<script setup>
import { computed, inject, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { Dropdown } from "bootstrap";
import LoginForm from "./components/LoginForm.vue";
import NotificationTable from "./components/NotificationTable.vue";
import NotificationModal from "./components/NotificationModal.vue";
import PairingModal from "./components/PairingModal.vue";
import ModalError from "./components/ModalError.vue";
import { AuthRequestError, getAdminSession, loginAdmin, logoutAdmin } from "./services/service.auth.js";
import { socketServiceKey } from "./symbols.js";

const { state, connect, disconnect } = inject(socketServiceKey);
const tableRef = ref(null);
const modalRef = ref(null);
const pairingModalRef = ref(null);
const themeDropdownButton = ref(null);
const session = ref(null);
const authReady = ref(false);
const loginSubmitting = ref(false);
const logoutSubmitting = ref(false);
const loginError = ref("");
const adminMessage = ref("");
const systemTheme = window.matchMedia("(prefers-color-scheme: dark)");
const themeMode = ref(document.documentElement.dataset.bsThemeMode ?? "auto");
let themeDropdown;

const themeOptions = [
	{ value: "light", label: "Светлая", icon: "bi-sun-fill" },
	{ value: "dark", label: "Тёмная", icon: "bi-moon-stars-fill" },
	{ value: "auto", label: "Системная", icon: "bi-circle-half" },
];
const activeTheme = computed(() => themeOptions.find(({ value }) => value === themeMode.value) ?? themeOptions[2]);

const applyTheme = () => {
	const resolvedTheme = themeMode.value === "auto" ? (systemTheme.matches ? "dark" : "light") : themeMode.value;
	document.documentElement.dataset.bsThemeMode = themeMode.value;
	document.documentElement.setAttribute("data-bs-theme", resolvedTheme);
};

const selectTheme = (mode) => {
	themeMode.value = mode;
	localStorage.setItem("bellwake-admin-theme", mode);
	applyTheme();
	themeDropdown?.hide();
};

const onSystemThemeChange = () => {
	if (themeMode.value === "auto") applyTheme();
};

const initializeThemeDropdown = async () => {
	await nextTick();
	if (themeDropdownButton.value && !themeDropdown) themeDropdown = new Dropdown(themeDropdownButton.value);
};

const clearAuthenticatedSession = () => {
	disconnect();
	themeDropdown?.dispose();
	themeDropdown = undefined;
	session.value = null;
};

const acceptSession = (payload) => {
	session.value = payload;
	connect(payload.csrfToken);
};

const getLoginError = (error) => {
	if (!(error instanceof AuthRequestError)) return "Не удалось связаться с сервером Bellwake.";
	switch (error.code) {
		case "invalid_credentials":
			return "Неверное имя пользователя или пароль.";
		case "user_inactive":
			return "Учётная запись отключена. Обратитесь к администратору.";
		case "login_rate_limited":
			return "Слишком много неудачных попыток. Повторите вход через 15 минут.";
		default:
			return error.status >= 500 ? "Сервер временно недоступен." : "Не удалось выполнить вход.";
	}
};

const restoreSession = async () => {
	try {
		const restored = await getAdminSession();
		if (restored) acceptSession(restored);
	} catch {
		loginError.value = "Не удалось проверить сессию. Проверьте соединение с сервером.";
	} finally {
		authReady.value = true;
	}
};

const handleLogin = async (credentials) => {
	if (loginSubmitting.value) return;
	loginSubmitting.value = true;
	loginError.value = "";
	try {
		acceptSession(await loginAdmin(credentials));
	} catch (error) {
		loginError.value = getLoginError(error);
	} finally {
		loginSubmitting.value = false;
	}
};

const handleLogout = async () => {
	if (logoutSubmitting.value || !session.value) return;
	logoutSubmitting.value = true;
	adminMessage.value = "";
	try {
		await logoutAdmin(session.value.csrfToken);
		clearAuthenticatedSession();
	} catch {
		adminMessage.value = "Не удалось завершить серверную сессию. Повторите попытку.";
	} finally {
		logoutSubmitting.value = false;
	}
};

const handleUnauthorized = () => {
	if (!session.value) return;
	const deliberateLogout = logoutSubmitting.value;
	clearAuthenticatedSession();
	if (!deliberateLogout) loginError.value = "Сессия завершена. Войдите в систему повторно.";
};

watch(session, (value) => {
	if (value) void initializeThemeDropdown();
});
watch(() => state.authExpiredRevision, handleUnauthorized);

onMounted(() => {
	systemTheme.addEventListener("change", onSystemThemeChange);
	void restoreSession();
});

onBeforeUnmount(() => {
	systemTheme.removeEventListener("change", onSystemThemeChange);
	disconnect();
	themeDropdown?.dispose();
});

const openCreate = () => modalRef.value?.openCreate();
const openEdit = (id) => modalRef.value?.openEdit(id);
const openPairing = () => pairingModalRef.value?.open();
const onChanged = (change) => modalRef.value?.notifyExternalChange(change);
const onSaved = () => tableRef.value?.reload();
</script>

<template>
	<div v-if="!authReady" class="auth-loading" role="status">
		<img src="/bellwake-icon-256.png" width="72" height="72" alt="" />
		<span class="spinner-border text-primary" />
	</div>

	<LoginForm v-else-if="!session" :submitting="loginSubmitting" :error="loginError" @login="handleLogin" />

	<div v-else class="app-shell">
		<nav class="navbar navbar-expand border-bottom sticky-top">
			<div class="container-fluid app-container">
				<a class="navbar-brand d-flex align-items-center gap-3" href="#" aria-label="Bellwake Admin">
					<img class="brand-icon" src="/bellwake-icon-256.png" width="40" height="40" alt="" />
					<span><span class="brand-name">Bellwake</span><span class="brand-product">Панель администрирования</span></span>
				</a>
				<div class="d-flex align-items-center gap-2 gap-md-3">
					<div class="connection-status" :class="state.connected ? 'is-online' : 'is-offline'" :title="state.connected ? 'Соединение установлено' : 'Переподключение к серверу'">
						<span class="connection-dot" /><span class="d-none d-lg-inline">{{ state.connected ? "На связи" : "Нет связи" }}</span>
					</div>
					<div class="admin-user" :title="session.user.username">
						<i class="bi bi-person-circle" /><span class="d-none d-md-inline">{{ session.user.displayName }}</span>
					</div>
					<button type="button" class="btn btn-icon" title="Выйти" aria-label="Выйти" :disabled="logoutSubmitting" @click="handleLogout">
						<span v-if="logoutSubmitting" class="spinner-border spinner-border-sm" /><i v-else class="bi bi-box-arrow-right" />
					</button>
					<div class="dropdown">
						<button ref="themeDropdownButton" type="button" class="btn btn-icon dropdown-toggle" data-bs-toggle="dropdown" aria-label="Выбрать цветовую тему" aria-haspopup="true" aria-expanded="false">
							<i class="bi" :class="activeTheme.icon" />
						</button>
						<ul class="dropdown-menu dropdown-menu-end theme-menu">
							<li v-for="option in themeOptions" :key="option.value">
								<button type="button" class="dropdown-item d-flex align-items-center" :class="{ active: themeMode === option.value }" :aria-pressed="themeMode === option.value" @click="selectTheme(option.value)">
									<i class="bi me-2" :class="option.icon" /><span>{{ option.label }}</span><i v-if="themeMode === option.value" class="bi bi-check2 ms-auto" />
								</button>
							</li>
						</ul>
					</div>
				</div>
			</div>
		</nav>

		<main class="app-container py-3 py-lg-3">
			<div v-if="adminMessage" class="alert alert-danger" role="alert">{{ adminMessage }}</div>
			<div v-if="!state.connected" class="alert alert-warning connection-alert d-flex align-items-center gap-3" role="status">
				<span class="spinner-grow spinner-grow-sm" />
				<div><strong>Соединение с сервером потеряно.</strong> Таблица обновится автоматически после восстановления связи.</div>
			</div>

			<NotificationTable ref="tableRef" @create="openCreate" @pair="openPairing" @edit="openEdit" @changed="onChanged" />
		</main>

		<NotificationModal ref="modalRef" @saved="onSaved" />
		<PairingModal ref="pairingModalRef" :csrf-token="session.csrfToken" @unauthorized="handleUnauthorized" />
		<ModalError />
	</div>
</template>
