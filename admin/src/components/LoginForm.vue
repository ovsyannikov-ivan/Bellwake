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
					<input
						id="login-password"
						v-model="password"
						type="password"
						class="form-control form-control-lg"
						placeholder="Пароль"
						autocomplete="current-password"
						required
					/>
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
	padding: clamp(1rem, 4vw, 3rem);
	place-items: center;
	background:
		radial-gradient(circle at 50% 15%, rgba(var(--bs-primary-rgb), 0.12), transparent 38rem),
		color-mix(in srgb, var(--bs-body-bg) 88%, var(--bs-secondary-bg));
}

.login-card {
	width: min(100%, 50rem);
	padding: clamp(2rem, 7vw, 6rem);
	border: 1px solid var(--bs-border-color);
	border-radius: clamp(1.5rem, 4vw, 3rem);
	background: var(--bs-body-bg);
	box-shadow: 0 1.5rem 5rem rgba(var(--bs-dark-rgb), 0.18);
}

.login-logo {
	display: block;
	width: clamp(5rem, 14vw, 7rem);
	height: auto;
	margin: 0 auto 2rem;
	border-radius: 1.5rem;
	box-shadow: 0 1rem 2.5rem rgba(var(--bs-primary-rgb), 0.22);
}

.login-title {
	margin: 0 0 clamp(2rem, 6vw, 4rem);
	font-size: clamp(2rem, 5vw, 3rem);
	font-weight: 300;
	text-align: center;
}

.login-form {
	display: grid;
	gap: 1.5rem;

	.form-control {
		min-height: 5.25rem;
		padding-inline: 1.5rem;
		border-radius: 1rem;
		background-color: var(--bs-body-bg);
		font-size: clamp(1.1rem, 3vw, 1.45rem);
		font-weight: 600;
	}
}

.login-submit {
	min-height: 5rem;
	border-radius: 1rem;
	font-size: 1.35rem;
}

@media (max-width: 575.98px) {
	.login-card {
		padding: 2rem 1.25rem;
	}

	.login-form {
		gap: 1rem;

		.form-control,
		.login-submit {
			min-height: 3.75rem;
		}
	}
}
</style>
