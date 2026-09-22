<script setup>
defineProps({
	show: { type: Boolean, default: false },
	variant: { type: String, default: "pulse" },
});
const emit = defineEmits(["after-enter", "after-leave"]);
</script>

<template>
	<Transition name="loading-fade" @after-enter="emit('after-enter')" @after-leave="emit('after-leave')">
		<div v-if="show" class="loading-backdrop" role="status" aria-live="polite" aria-label="Загрузка">
			<div v-if="variant === 'rings'" class="spinner-rings" />
			<div v-else class="spinner-pulse" />
			<span class="visually-hidden">Загрузка…</span>
		</div>
	</Transition>
</template>

<style scoped>
.loading-backdrop { position: fixed; inset: 0; z-index: 3000; display: grid; place-items: center; background: rgba(16, 20, 29, .72); backdrop-filter: blur(9px); }
.spinner-pulse { width: 20px; height: 20px; border-radius: 50%; background: #fff; box-shadow: 0 0 0 7px rgba(255,255,255,.25), 0 0 0 14px rgba(255,255,255,.1); animation: loader-pulse 1.35s ease-in-out infinite; }
.spinner-rings { width: 58px; height: 58px; border: 4px solid rgba(255,255,255,.2); border-top-color: #fff; border-radius: 50%; animation: loader-spin 1s linear infinite; }
.loading-fade-enter-active, .loading-fade-leave-active { transition: opacity .2s ease; }
.loading-fade-enter-from, .loading-fade-leave-to { opacity: 0; }
@keyframes loader-pulse { 50% { opacity: .55; transform: scale(1.45); } }
@keyframes loader-spin { to { transform: rotate(360deg); } }
</style>
