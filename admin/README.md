# Bellwake Admin

Административный интерфейс управления уведомлениями Bellwake.

## Разработка

1. Запустите backend из `../backend`: `npm run dev`.
2. Запустите admin: `npm run dev`.
3. Откройте `http://127.0.0.1:5173`.

Vite проксирует `/api` (включая WebSocket Upgrade) на `http://127.0.0.1:3102`.

## Сборка

```sh
npm run build
```

Для публикации копируется содержимое `dist/` в корень `public_html`.

## Apache

Прокси для `/api/socket.io` должен сохранять WebSocket Upgrade и направлять соединение в тот же Bellwake backend. Пример для Apache 2.4 с `mod_proxy`, `mod_proxy_http` и `mod_proxy_wstunnel`:

```apache
ProxyPass        /api/socket.io ws://127.0.0.1:3102/api/socket.io
ProxyPassReverse /api/socket.io ws://127.0.0.1:3102/api/socket.io
```

Правило WebSocket следует разместить перед более общим `ProxyPass /api/ ...`. Конкретную конфигурацию VirtualHost необходимо сверить с уже действующими правилами сервера; этот проект её не изменяет.

> Namespace `/admin` пока не защищён. До production необходимо добавить реальную проверку административной сессии в Socket.IO middleware.
