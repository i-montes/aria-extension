#!/Users/imontes/.aria/bin/node
// Aria — native messaging host + servidor TCP local.
// Chrome nos spawnea (connectNative desde la extensión) y nos da stdio.
// Aria (agente) habla por TCP 127.0.0.1 con token en ~/.aria/bridge.json.
//
// Protocolo stdio (4B LE len + JSON):
//   ext -> host: {type:"pong"} | {type:"event",name,data}
//              | {type:"resp",id,ok,data} | {type:"resp",id,chunked,total}
//              | {type:"chunk",id,i,total,part}
//   host -> ext: {type:"ping"} | {type:"cmd",id,cmd,params}
// Protocolo TCP (JSON por línea):
//   -> {token, id, cmd, params}
//   <- {id, ok, data|error} | {event, data}

"use strict";

const net = require("net");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const DIR = process.env.ARIA_BRIDGE_DIR || path.join(os.homedir(), ".aria");
const PING_MS = Number(process.env.ARIA_PING_MS || 20_000);
const CMD_TIMEOUT_MS = Number(process.env.ARIA_CMD_TIMEOUT_MS || 20_000);
const ACTIVITY_FILE = path.join(DIR, "activity.jsonl");
const BRIDGE_FILE = path.join(DIR, "bridge.json");
const TOKEN_FILE = path.join(DIR, "bridge.token");

fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });

// --- token persistente ---
let token;
try {
  token = fs.readFileSync(TOKEN_FILE, "utf8").trim();
  if (!token) throw new Error("empty");
} catch (e) {
  token = crypto.randomBytes(24).toString("hex");
  fs.writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
}

// --- stdio framing ---
let buf = Buffer.alloc(0);
const chunks = new Map(); // id -> {parts:[], total}
const pending = new Map(); // hostId -> {sock, clientId, timer}

function writeExt(obj) {
  if (stdoutDead) return;
  try {
    const body = Buffer.from(JSON.stringify(obj), "utf8");
    const head = Buffer.alloc(4);
    head.writeUInt32LE(body.length, 0);
    process.stdout.write(Buffer.concat([head, body]));
  } catch (e) {
    stdoutDead = true;
  }
}

let stdoutDead = false;
process.stdout.on("error", () => {
  stdoutDead = true;
});

process.stdin.on("data", (d) => {
  buf = Buffer.concat([buf, d]);
  while (buf.length >= 4) {
    const n = buf.readUInt32LE(0);
    if (buf.length < 4 + n) break;
    const body = buf.subarray(4, 4 + n);
    buf = buf.subarray(4 + n);
    let msg;
    try {
      msg = JSON.parse(body.toString("utf8"));
    } catch (e) {
      continue;
    }
    onExtMessage(msg);
  }
});

process.stdin.on("end", () => shutdown());
process.stdin.on("error", () => shutdown());

// Chrome nos spawna solo cuando la ext conecta: dado por conectado desde el inicio.
let extConnected = true;

function onExtMessage(m) {
  extConnected = true;
  if (!m || typeof m !== "object") return;

  if (m.type === "chunk") {
    let c = chunks.get(m.id);
    if (!c) {
      c = { parts: [], total: m.total };
      chunks.set(m.id, c);
    }
    c.parts[m.i] = m.part;
    return;
  }

  if (m.type === "resp") {
    let payload = m;
    if (m.chunked) {
      const c = chunks.get(m.id);
      chunks.delete(m.id);
      if (!c) return resolvePending(m.id, false, "chunking incompleto");
      const joined = c.parts.join("");
      try {
        payload = JSON.parse(joined);
      } catch (e) {
        return resolvePending(m.id, false, "JSON de chunk inválido");
      }
    }
    resolvePending(m.id, payload.ok, payload.data);
    return;
  }

  if (m.type === "event") {
    logActivity(m.name, m.data);
    broadcast({ event: m.name, data: m.data });
    return;
  }
  // pong u otros: ignorar (el ping ya mantiene vivo el SW)
}

function resolvePending(hostId, ok, data) {
  const p = pending.get(hostId);
  if (!p) return;
  pending.delete(hostId);
  clearTimeout(p.timer);

  // screenshot: guardar imagen y devolver solo la ruta
  if (p.cmd === "screenshot" && ok && data && data.dataUrl) {
    try {
      const b64 = String(data.dataUrl).replace(/^data:[^,]+,/, "");
      const bufImg = Buffer.from(b64, "base64");
      const shots = path.join(DIR, "shots");
      fs.mkdirSync(shots, { recursive: true });
      const file = path.join(
        shots,
        `shot-${new Date().toISOString().replace(/[:.]/g, "-")}.png`
      );
      fs.writeFileSync(file, bufImg);
      data = { path: file, bytes: bufImg.length, tabId: data.tabId };
    } catch (e) {
      ok = false;
      data = "guardando screenshot: " + e.message;
    }
  }

  const resp = ok
    ? { id: p.clientId, ok: true, data: data === undefined ? null : data }
    : { id: p.clientId, ok: false, error: String(data) };
  line(p.sock, resp);
}

function logActivity(name, data) {
  try {
    fs.appendFileSync(
      ACTIVITY_FILE,
      JSON.stringify({ ts: new Date().toISOString(), event: name, ...data }) +
        "\n",
      { mode: 0o600 }
    );
  } catch (e) {
    /* best effort */
  }
}

// --- keepalive del service worker ---
const pingTimer = setInterval(() => writeExt({ type: "ping" }), PING_MS);
writeExt({ type: "ping" });

// --- TCP ---
const clients = new Set();
let seq = 0;

const server = net.createServer((sock) => {
  clients.add(sock);
  let acc = "";
  sock.setEncoding("utf8");
  sock.on("data", (d) => {
    acc += d;
    let idx;
    while ((idx = acc.indexOf("\n")) >= 0) {
      const raw = acc.slice(0, idx).trim();
      acc = acc.slice(idx + 1);
      if (!raw) continue;
      let req;
      try {
        req = JSON.parse(raw);
      } catch (e) {
        line(sock, { id: null, ok: false, error: "JSON inválido" });
        continue;
      }
      handleRequest(sock, req);
      return; // una petición por conexión
    }
  });
  sock.on("error", () => {});
  sock.on("close", () => clients.delete(sock));
});

function line(sock, obj) {
  try {
    sock.write(JSON.stringify(obj) + "\n");
  } catch (e) {}
}

function broadcast(obj) {
  for (const s of clients) line(s, obj);
}

function handleRequest(sock, req) {
  const { token: t, id, cmd, params } = req;
  if (t !== token) {
    line(sock, { id, ok: false, error: "token inválido" });
    sock.end();
    return;
  }
  if (!cmd) {
    line(sock, { id, ok: false, error: "cmd requerido" });
    sock.end();
    return;
  }
  if (stdoutDead || !extConnected) {
    line(sock, {
      id,
      ok: false,
      error: "extensión Aria no conectada (¿Chrome abierto y extensión cargada?)",
    });
    sock.end();
    return;
  }
  const hostId = ++seq;
  const timer = setTimeout(() => {
    pending.delete(hostId);
    line(sock, { id, ok: false, error: `timeout ${CMD_TIMEOUT_MS}ms en '${cmd}'` });
    sock.end();
  }, CMD_TIMEOUT_MS);
  pending.set(hostId, { sock, clientId: id, timer, cmd });
  writeExt({ type: "cmd", id: hostId, cmd, params: params || {} });
}

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    process.stderr.write("aria-host: puerto ocupado, saliendo\n");
    process.exit(1);
  }
  process.stderr.write("aria-host: " + e.message + "\n");
});

server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
  try {
    fs.writeFileSync(
      BRIDGE_FILE,
      JSON.stringify({ port, pid: process.pid, started: Date.now() }, null, 2),
      { mode: 0o600 }
    );
  } catch (e) {
    process.stderr.write("aria-host: escribiendo bridge.json: " + e.message + "\n");
  }
});

// --- salida limpia ---
let exiting = false;
function shutdown() {
  if (exiting) return;
  exiting = true;
  clearInterval(pingTimer);
  for (const [, p] of pending) {
    clearTimeout(p.timer);
    line(p.sock, { id: p.clientId, ok: false, error: "Chrome cerró el puente" });
  }
  pending.clear();
  try {
    server.close();
  } catch (e) {}
  try {
    if (fs.existsSync(BRIDGE_FILE)) {
      const b = JSON.parse(fs.readFileSync(BRIDGE_FILE, "utf8"));
      if (b.pid === process.pid) fs.unlinkSync(BRIDGE_FILE);
    }
  } catch (e) {}
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
