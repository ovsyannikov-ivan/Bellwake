import { createApp } from "vue";
import App from "./App.vue";

import 'bootstrap/dist/css/bootstrap.min.css'

const syncTheme = () => {
  const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches

  document.documentElement.setAttribute(
    'data-bs-theme',
    isDark ? 'dark' : 'light'
  )
}

syncTheme()

window
  .matchMedia('(prefers-color-scheme: dark)')
  .addEventListener('change', syncTheme)

createApp(App).mount("#app");
