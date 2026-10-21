# Aria — extensión de navegador

Extensión MV3 para Chrome que le da a Aria (tu agente de escritorio) capacidad de
**observar, abrir e interactuar** con el navegador **sin activación manual**: con
instalarla y tener Chrome abierto basta. Arquitectura inspirada en la extensión de
Claude (service worker + native messaging), analizada con REA
(`rea-agents analyze-javascript-application`).

## Cómo funciona

```
Aria (agente) ──TCP 127.0.0.1 + token──> aria-host.js ──stdio nativo──> extensión MV3
   aria-browse (CLI)                     Chrome lo spawnea                background.js
                                         vía connectNative                (content on demand)
```

- **`manifest.json`** — MV3, sin UI, sin content script permanente. Solo `alarms`,
  `nativeMessaging`, `scripting`, `tabs` + host `<all_urls>`.
- **`background.js`** — service worker: recibe comandos y los ejecuta con
  `chrome.scripting` / `chrome.tabs`. Mantiene vivo el puente con ping/pong cada
  20 s y reintenta la conexión con `chrome.alarms`. Respuestas >700 KB se trocean
  (límite de 1 MB por mensaje nativo).
- **`host/aria-host.js`** — native messaging host (lo spawnea Chrome) + servidor
  TCP local en `127.0.0.1` con token. Guarda capturas en `~/.aria/shots/` y eventos
  de navegación en `~/.aria/activity.jsonl`. Estado en `~/.aria/bridge.json`.
- **`tools/aria-browse`** — CLI que Aria usa para hablar con el puente.

## Comandos

`ping`, `list_tabs`, `open_tab <url>`, `activate_tab <id>`, `close_tab <id>`,
`get_page [id]` (texto, headings, links, inputs, tablas),
`extract <selector> [--attr href]`, `click --selector/--text`, `fill <sel> <val>`,
`scroll [--y|--selector]`, `screenshot [id]`, `events [-n 50]`.

Ejemplo: `tools/aria-browse get_page` → estructura de la pestaña activa.

## Instalación (única, manual)

1. `chrome://extensions` → activar **Modo de desarrollador** → **Cargar descomprimida**
   → seleccionar esta carpeta (`/Users/imontes/projects/aria-extension`).
   El ID queda fijo por la clave del manifest: `ecneebhmoknhilcegbhceenfmekllkjp`.
2. El registro del native host ya está en
   `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.aria.browser.json`.

No hay popup, ni botón, ni pasos posteriores: instalada = operativa.

## Verificación

Prueba integral del puente (ping, RPC, chunking 2 MB, activity log, token,
screenshot): ver el flujo en la sesión donde se creó el proyecto. La extensión se
verifica en vivo con `tools/aria-browse ping` tras cargarla en Chrome.
