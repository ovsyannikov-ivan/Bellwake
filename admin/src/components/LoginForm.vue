<script setup>
import { ref } from "vue";

defineProps({
	submitting: { type: Boolean, default: false },
	error: { type: String, default: "" },
});

const emit = defineEmits(["login"]);
const username = ref("");
const password = ref("");

const submit = () => {
	emit("login", { username: username.value.trim(), password: password.value });
};
</script>

<template>
	<main class="login-page">
		<section class="login-card" aria-labelledby="login-title">
			<img class="login-logo" src="/bellwake-icon-256.png" width="112" height="112" alt="Bellwake" />
			<h1 id="login-title" class="login-title">Войдите в систему</h1>

			<form class="login-form" @submit.prevent="submit">
				<div>
					<label class="visually-hidden" for="login-username">Имя пользователя</label>
					<input
						id="login-username"
						v-model="username"
						type="text"
						class="form-control form-control-lg"
						placeholder="Имя пользователя"
						autocomplete="username"
						autocapitalize="none"
						spellcheck="false"
						required
						autofocus
					/>
				</div>
				<div>
					<label class="visually-hidden" for="login-password">Пароль</label>
					<input id="login-password" v-model="password" type="password" class="form-control form-control-lg" placeholder="Пароль" autocomplete="current-password" required />
				</div>
				<div v-if="error" class="alert alert-danger mb-0" role="alert" aria-live="assertive">{{ error }}</div>
				<button type="submit" class="btn btn-primary btn-lg login-submit" :disabled="submitting || !username.trim() || !password">
					<span v-if="submitting" class="spinner-border spinner-border-sm me-2" role="status" />
					{{ submitting ? "Входим…" : "Войти" }}
				</button>
			</form>
		</section>
	</main>
</template>

<style scoped lang="scss">
.login-page {
	display: grid;
	min-height: 100vh;
	padding: 1rem;
	place-items: center;
	background: radial-gradient(circle at 50% 15%, rgba(var(--bs-primary-rgb), 0.08), transparent 36rem), color-mix(in srgb, var(--bs-body-bg) 88%, var(--bs-secondary-bg));
}
.login-card {
	width: min(100%, 24.5rem);
	padding: 3rem;
	border: 1px solid var(--bs-border-color);
	border-radius: 1.5rem;
	background: var(--bs-body-bg);
	box-shadow: 0 1rem 3rem rgba(var(--bs-dark-rgb), 0.14);
}
.login-logo {
	display: block;
	width: 3.5rem;
	height: 3.5rem;
	margin: 0 auto 1.5rem;
	object-fit: contain;
}
.login-title {
	margin: 0 0 2.25rem;
	font-size: 1.5rem;
	font-weight: 300;
	line-height: 1.25;
	text-align: center;
}
.login-form {
	display: grid;
	gap: 1rem;
	.form-control {
		min-height: 3.5rem;
		padding: 0.75rem 0.85rem;
		border-radius: 0.65rem;
		background-color: var(--bs-body-bg);
		font-size: 1rem;
	}
}
.login-submit {
	min-height: 2.65rem;
	padding: 0.55rem 1rem;
	border-radius: 0.55rem;
	font-size: 1rem;
}

@media (max-width: 575.98px) {
	.login-page {
		padding: 1rem;
	}
	.login-card {
		width: 100%;
		max-width: 24.5rem;
		padding: 2rem 1.5rem;
	}
	.login-title {
		margin-bottom: 1.75rem;
	}
	.login-form {
		gap: 0.85rem;
	}
}
</style>
