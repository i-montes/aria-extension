// Aria — service worker (MV3)
// Puente: Chrome native messaging <-> com.aria.browser (host local)
// Comandos: list_tabs, open_tab, activate_tab, close_tab, get_page,
//           extract, click, fill, scroll, screenshot, ping
//
// Sin UI y sin activación: con la extensión instalada y Chrome abierto,
// el host local (spawned por Chrome) queda disponible para Aria.

const HOST_NAME = "com.aria.browser";
const RECONNECT_ALARM = "aria-reconnect";
const SMALL_MSG = 700_000; // tope por mensaje nativo (límite 1MB con margen)

let port = null;

function connect() {
  if (port) return;
  try {
    port = chrome.runtime.connectNative(HOST_NAME);
  } catch (e) {
    port = null;
    chrome.alarms.create(RECONNECT_ALARM, { delayInMinutes: 0.5 });
    return;
  }
  port.onMessage.addListener(onHostMessage);
  port.onDisconnect.addListener(() => {
    port = null;
    // Reintento: si el host no está instalado o Chrome reinicia el SW.
    chrome.alarms.create(RECONNECT_ALARM, { delayInMinutes: 0.5 });
  });
}

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === RECONNECT_ALARM) connect();
});

connect();

function send(msg) {
  if (!port) return false;
  try {
    port.postMessage(msg);
    return true;
  } catch (e) {
    port = null;
    chrome.alarms.create(RECONNECT_ALARM, { delayInMinutes: 0.5 });
    return false;
  }
}

function emit(name, data) {
  send({ type: "event", name, data: { ...data, ts: Date.now() } });
}

// --- eventos de observación (pestañas) ---
chrome.tabs.onActivated.addListener(({ tabId, windowId }) =>
  emit("nav", { kind: "activated", tabId, windowId })
);
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.url)
    emit("nav", {
      kind: "updated",
      tabId,
      url: info.url,
      title: info.title ?? tab.title ?? null,
    });
});

// --- respuestas (con chunking para mensajes grandes) ---
function sendResp(id, ok, data) {
  const full = JSON.stringify({ ok, data });
  if (full.length <= SMALL_MSG) {
    send({ type: "resp", id, ok, data });
    return;
  }
  const total = Math.ceil(full.length / SMALL_MSG);
  for (let i = 0; i < total; i++) {
    send({
      type: "chunk",
      id,
      i,
      total,
      part: full.slice(i * SMALL_MSG, (i + 1) * SMALL_MSG),
    });
  }
  send({ type: "resp", id, chunked: true, total });
}

async function onHostMessage(msg) {
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "ping") {
    send({ type: "pong", ts: Date.now() });
    return;
  }
  if (msg.type !== "cmd") return;
  try {
    const data = await run(msg.cmd, msg.params || {});
    sendResp(msg.id, true, data);
  } catch (e) {
    sendResp(msg.id, false, String((e && e.message) || e));
  }
}

// --- helpers ---
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function targetTab(tabId) {
  if (tabId == null) {
    const [t] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (!t) throw new Error("no hay pestaña activa");
    return t;
  }
  return chrome.tabs.get(tabId);
}

async function inject(tabId, func, args) {
  const res = await chrome.scripting.executeScript({
    target: { tabId },
    func,
    args: args || [],
  });
  if (!res || !res.length) throw new Error("inyección fallida");
  return res[0].result === undefined ? null : res[0].result;
}

// --- comandos ---
async function run(cmd, p) {
  switch (cmd) {
    case "ping":
      return {
        name: "Aria",
        version: chrome.runtime.getManifest().version,
        ts: Date.now(),
      };

    case "list_tabs": {
      const tabs = await chrome.tabs.query({});
      return tabs.map((t) => ({
        id: t.id,
        windowId: t.windowId,
        active: t.active,
        index: t.index,
        url: t.url || null,
        title: t.title || null,
      }));
    }

    case "open_tab": {
      if (!p.url) throw new Error("url requerida");
      const t = await chrome.tabs.create({
        url: p.url,
        active: p.active !== false,
      });
      return { tabId: t.id, url: p.url };
    }

    case "activate_tab": {
      const t = await chrome.tabs.update(p.tabId, { active: true });
      await chrome.windows.update(t.windowId, { focused: true });
      return { tabId: p.tabId };
    }

    case "close_tab": {
      await chrome.tabs.remove(p.tabId);
      return { closed: p.tabId };
    }

    case "get_page": {
      const tab = await targetTab(p.tabId);
      return inject(tab.id, () => {
        const cap = (s, n) =>
          String(s == null ? "" : s)
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, n);
        const q = (sel) => Array.from(document.querySelectorAll(sel));
        return {
          url: location.href,
          title: document.title,
          lang: document.documentElement.lang || null,
          text: cap(document.body ? document.body.innerText : "", 50000),
          headings: q("h1,h2,h3").slice(0, 50).map((h) => cap(h.innerText, 200)),
          links: q("a[href]")
            .slice(0, 200)
            .map((a) => ({ text: cap(a.innerText, 120), href: a.href })),
          inputs: q("input,textarea,select")
            .slice(0, 100)
            .map((el) => ({
              tag: el.tagName.toLowerCase(),
              type: el.type || null,
              name: el.name || null,
              placeholder: el.placeholder || null,
              value: cap(el.value, 200),
            })),
          tables: q("table")
            .slice(0, 5)
            .map((tb) =>
              Array.from(tb.rows)
                .slice(0, 30)
                .map((r) =>
                  Array.from(r.cells)
                    .slice(0, 15)
                    .map((c) => cap(c.innerText, 200))
                )
            ),
        };
      });
    }

    case "extract": {
      if (!p.selector) throw new Error("selector requerido");
      const tab = await targetTab(p.tabId);
      return inject(
        tab.id,
        (sel, attr, limit) => {
          const nodes = Array.from(document.querySelectorAll(sel)).slice(
            0,
            limit || 500
          );
          return nodes.map((el) =>
            attr
              ? el.getAttribute(attr)
              : String(el.innerText || el.textContent || "")
                  .replace(/\s+/g, " ")
                  .trim()
                  .slice(0, 500)
          );
        },
        [p.selector, p.attr || null, p.limit || 500]
      );
    }

    case "click": {
      const target = p.selector || p.text;
      if (!target) throw new Error("selector o text requerido");
      const tab = await targetTab(p.tabId);
      return inject(
        tab.id,
        (selector, text) => {
          let el = null;
          if (selector) el = document.querySelector(selector);
          if (!el && text) {
            const norm = (s) =>
              String(s || "").replace(/\s+/g, " ").trim();
            const interactive = Array.from(
              document.querySelectorAll(
                "a,button,[role=button],[role=link],input[type=submit],summary,li"
              )
            );
            el =
              interactive.find((e) => norm(e.textContent) === text) ||
              interactive.find((e) => norm(e.textContent).includes(text)) ||
              Array.from(document.querySelectorAll("a,button,span,div")).find(
                (e) => norm(e.textContent) === text
              );
          }
          if (!el) return { clicked: false, reason: "no encontrado" };
          el.scrollIntoView({ block: "center" });
          el.click();
          return {
            clicked: true,
            tag: el.tagName.toLowerCase(),
            text: String(el.textContent || "")
              .replace(/\s+/g, " ")
              .trim()
              .slice(0, 120),
          };
        },
        [p.selector || null, p.text || null]
      );
    }

    case "fill": {
      if (!p.selector) throw new Error("selector requerido");
      const tab = await targetTab(p.tabId);
      return inject(
        tab.id,
        (sel, value) => {
          const el = document.querySelector(sel);
          if (!el) return { filled: false, reason: "no encontrado" };
          el.focus();
          const proto =
            el.tagName === "TEXTAREA"
              ? HTMLTextAreaElement.prototype
              : el.tagName === "SELECT"
              ? HTMLSelectElement.prototype
              : HTMLInputElement.prototype;
          const desc = Object.getOwnPropertyDescriptor(proto, "value");
          if (desc && desc.set) desc.set.call(el, value);
          else el.value = value;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          return { filled: true, value: el.value };
        },
        [p.selector, String(p.value == null ? "" : p.value)]
      );
    }

    case "scroll": {
      const tab = await targetTab(p.tabId);
      return inject(
        tab.id,
        (selector, y) => {
          if (selector) {
            const el = document.querySelector(selector);
            if (!el) return { scrolled: false, reason: "no encontrado" };
            el.scrollIntoView({ block: "center" });
            return { scrolled: true, target: selector };
          }
          const top = y || 0;
          window.scrollTo({ top, behavior: "instant" });
          return { scrolled: true, y: top, maxY: document.body.scrollHeight };
        },
        [p.selector || null, p.y || 0]
      );
    }

    case "screenshot": {
      const tab = await targetTab(p.tabId);
      if (!tab.active) {
        await chrome.tabs.update(tab.id, { active: true });
        await sleep(200);
      }
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
        format: "png",
      });
      return { dataUrl, tabId: tab.id };
    }

    default:
      throw new Error("comando desconocido: " + cmd);
  }
}
