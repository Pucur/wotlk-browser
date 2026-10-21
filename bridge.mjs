#!/usr/bin/env node

// WoW bridge: serves the web client, the game data in 64 KB blocks, and tunnels WebSockets to the realm's TCP ports.
//
//   node bridge.mjs [--trace]
//
// Environment (all optional):
//   PORT=443                   HTTPS port
//   HOST=127.0.0.1             address to listen on
//   WEB_DIR=web                index.html, Wow.js, Wow.wasm, login-blocks.txt, world-blocks.txt ...
//   ART_DIR=web-art            output of extract-art.mjs (optional)
//   GAME_DIR=web/blocks        the folder that contains Data/ and Interface/
//   REALM_HOSTS=127.0.0.1      hosts the client may ask the tunnel for
//   REALM_PORTS=3724,8085      ports the tunnel may reach (auth, world)
//   REDIRECT_3724=82.76.141.15 every 3724 tunnel connection is sent to this address instead of the requested host
//   REDIRECT_8085=             optional, same for 8085 (empty = no redirect)
//   STATS_DIR=stats            where /stats/* events are appended

import https from "node:https";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const here = path.dirname(fileURLToPath(import.meta.url));
const env = (k, d) => process.env[k] ?? d;

const PORT = Number(env("PORT", 443));
const HOST = env("HOST", "127.0.0.1");
const WEB_DIR = path.resolve(here, env("WEB_DIR", "web"));
const ART_DIR = path.resolve(here, env("ART_DIR", "web-art"));
const GAME_DIR = path.resolve(here, env("GAME_DIR", "web/blocks"));
const STATS_DIR = path.resolve(here, env("STATS_DIR", "stats"));
const REALM_HOSTS = new Set(env("REALM_HOSTS", "127.0.0.1").split(",").map((s) => s.trim()));
const REALM_PORTS = new Set(env("REALM_PORTS", "3724,8085").split(",").map(Number));
const CORE_HOST = env("CORE_HOST", "127.0.0.1");


// Port -> fixed target. A redirected port ignores the host the client asked for.
const REDIRECTS = new Map([[3724, env("REDIRECT_3724", "51.254.7.68")]]);
if (env("REDIRECT_8085", "")) REDIRECTS.set(8085, env("REDIRECT_8085", "79.172.215.158"));

const TRACE = process.argv.includes("--trace");
const BLOCK = 64 * 1024;
fs.mkdirSync(STATS_DIR, { recursive: true });

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".wasm": "application/wasm", ".json": "application/json", ".webmanifest": "application/manifest+json",
  ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".ttf": "font/ttf", ".txt": "text/plain; charset=utf-8",
  ".data": "application/octet-stream",
};

// Required for SharedArrayBuffer / threads: the page must be cross-origin isolated.
function baseHeaders(res) {
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("X-Content-Type-Options", "nosniff");
}

// ---- case-insensitive, traversal-safe lookup inside GAME_DIR (the client uses Windows-style casing) ----
const dirCache = new Map();
function listDir(dir) {
  let m = dirCache.get(dir);
  if (!m) {
    m = new Map();
    try { for (const n of fs.readdirSync(dir)) m.set(n.toLowerCase(), n); } catch {}
    dirCache.set(dir, m);
  }
  return m;
}

function resolveGameFile(rel) {
  let cur = GAME_DIR;
  for (const part of rel.split(/[\\/]+/).filter(Boolean)) {
    if (part === ".." || part === ".") return null;
    const real = listDir(cur).get(part.toLowerCase());
    if (!real) return null;
    cur = path.join(cur, real);
  }
  return cur.startsWith(GAME_DIR) ? cur : null;
}

function sendFile(req, res, file, { immutable = false, extra = {} } = {}) {
  let st;
  try { st = fs.statSync(file); } catch { return notFound(res); }
  if (!st.isFile()) return notFound(res);
  const type = TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
  res.setHeader("Content-Type", type);
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("X-File-Size", st.size);
  res.setHeader("Cache-Control", immutable ? "public, max-age=31536000, immutable" : "no-cache");
  for (const [k, v] of Object.entries(extra)) res.setHeader(k, v);
  let start = 0, end = st.size - 1, status = 200;
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
  if (m && (m[1] || m[2])) {
    if (m[1] === "") { start = Math.max(0, st.size - Number(m[2])); }
    else { start = Number(m[1]); if (m[2]) end = Math.min(end, Number(m[2])); }
    if (start > end || start >= st.size) { res.statusCode = 416; res.setHeader("Content-Range", `bytes */${st.size}`); return res.end(); }
    status = 206;
    res.setHeader("Content-Range", `bytes ${start}-${end}/${st.size}`);
  }
  res.statusCode = status;
  res.setHeader("Content-Length", end - start + 1);
  if (req.method === "HEAD") return res.end();
  fs.createReadStream(file, { start, end }).on("error", () => res.destroy()).pipe(res);
}

function notFound(res) { res.statusCode = 404; res.end("Not found"); }

// ---- /blocks/<path under GAME_DIR> (A 2. szkript stabil, tiszta logikája) ----
function blockRange(req, url, size) {
  const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? "");
  if (m) return null; // sendFile handles real Range requests
  for (const k of ["b", "block", "i", "n"]) {
    if (url.searchParams.has(k)) { const s = Number(url.searchParams.get(k)) * BLOCK; return [s, Math.min(size, s + BLOCK) - 1]; }
  }
  for (const k of ["o", "offset"]) {
    if (url.searchParams.has(k)) { const s = Number(url.searchParams.get(k)); return [s, Math.min(size, s + BLOCK) - 1]; }
  }
  return null;
}

function serveBlock(req, res, url) {
  const rel = decodeURIComponent(url.pathname.slice("/blocks/".length));
  const file = resolveGameFile(rel);
  if (!file) return notFound(res);
  let size;
  try { size = fs.statSync(file).size; } catch { return notFound(res); }
  const r = blockRange(req, url, size);
  if (r) req.headers.range = `bytes=${r[0]}-${r[1]}`;
  sendFile(req, res, file, { immutable: true });
}

// ---- /manifest.json ---------------------------------------------------------------------------------------------
function walk(dir, base, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name), rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) walk(p, rel, out); else out[rel] = fs.statSync(p).size;
  }
  return out;
}
let manifest;
function serveManifest(res) {
  try { manifest ??= JSON.stringify(walk(GAME_DIR, "blocks", {})); } catch { return notFound(res); }
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-cache");
  res.end(manifest);
}

// ---- /stats/* ---------------------------------------------------------------------------------------------------
function readBody(req, limit = 2048) {
  return new Promise((resolve) => {
    let size = 0; const chunks = [];
    req.on("data", (c) => { size += c.length; if (size > limit) { req.destroy(); resolve(null); } else chunks.push(c); });
    req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch { resolve(null); } });
    req.on("error", () => resolve(null));
  });
}
const str = (v, n) => String(v ?? "").slice(0, n);
async function handleStats(req, res, url) {
  if (req.method !== "POST") { res.statusCode = 405; return res.end(); }
  const body = await readBody(req);
  res.statusCode = 204;
  res.end();
  if (!body) return;
  if (url.pathname === "/stats/event") {
    const line = { t: Date.now(), event: str(body.event, 32), detail: str(body.detail, 64), ms: Number(body.ms) || 0 };
    fs.appendFile(path.join(STATS_DIR, "events.jsonl"), JSON.stringify(line) + "\n", () => {});
  } else if (url.pathname === "/stats/session") {
    const line = { t: Date.now(), id: str(body.id, 32), device: str(body.device, 12), seconds: Number(body.seconds) || 0, fps: Number(body.fps) || 0 };
    fs.appendFile(path.join(STATS_DIR, "sessions.jsonl"), JSON.stringify(line) + "\n", () => {});
  }
}

// ---- HTTPS Server -----------------------------------------------------------------------------------------------
const sslOptions = {
  key: fs.readFileSync("/etc/ssl/private/nginx-selfsigned.key"),
  cert: fs.readFileSync("/etc/ssl/certs/nginx-selfsigned.crt"),
};

const server = https.createServer(sslOptions, async (req, res) => {
  const url = new URL(req.url, "https://x");
  if (TRACE) console.log(`${req.method} ${url.pathname}${url.search}`);
  baseHeaders(res);
  let p = url.pathname;
  try { p = decodeURIComponent(p); } catch { res.statusCode = 400; return res.end(); }

  if (p.startsWith("/stats/")) return handleStats(req, res, url);
  if (p.startsWith("/blocks/")) return serveBlock(req, res, url);
  if (p === "/manifest.json") return serveManifest(res);
  if (p === "/u/lh.js") { res.setHeader("Content-Type", "text/javascript"); return res.end(""); }
  if (p.startsWith("/u/")) { res.statusCode = 204; return res.end(); }
  if (p === "/" || p === "/play") p = "/index.html";

  for (const dir of [WEB_DIR, ART_DIR]) {
    const file = path.join(dir, p);
    if (file.startsWith(dir + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      const extra = p === "/sw.js" ? { "Service-Worker-Allowed": "/" } : {};
      return sendFile(req, res, file, { extra });
    }
  }
  notFound(res);
});

// ---- WebSocket -> TCP tunnel: /tcp/<host>/<port> (A helyes, REDIRECT-es tunnel logikával) ----
const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 1 << 20 });
server.on("upgrade", (req, socket, head) => {
  const m = /^\/tcp\/([\w.\-]+)\/(\d+)$/.exec(new URL(req.url, "http://x").pathname);
  if (!m || !REALM_HOSTS.has(m[1]) || !REALM_PORTS.has(Number(m[2]))) {
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => tunnel(ws, m[1], Number(m[2])));
});

function tunnel(ws, host, port) {
  const target = REDIRECTS.get(port) ?? host;
  console.log(`TUNNEL open ${host}:${port} -> ${target}:${port}`);

  const tcp = net.connect({ host: target, port });
  tcp.setNoDelay(true);
  const queue = [];
  let connected = false;

  tcp.on("connect", () => {
    connected = true;
    console.log(`TUNNEL connected ${target}:${port}`);
    for (const b of queue) tcp.write(b);
    queue.length = 0;
  });
  tcp.on("data", (d) => { if (ws.readyState === ws.OPEN) ws.send(d, { binary: true }); });
  tcp.on("error", (e) => { console.log(`TUNNEL tcp error ${target}:${port}: ${e.code || e.message}`); ws.terminate(); });
  tcp.on("close", (hadErr) => { console.log(`TUNNEL tcp closed ${target}:${port} (error: ${hadErr})`); ws.close(); });

  ws.on("message", (data) => {
    const buf = Buffer.isBuffer(data) ? data : Buffer.concat(Array.isArray(data) ? data : [Buffer.from(data)]);
    if (connected) tcp.write(buf); else queue.push(buf);
  });
  ws.on("close", (code, reason) => {
    console.log(`TUNNEL ws closed ${host}:${port} code=${code} reason=${reason}`);
    tcp.destroy();
  });
  ws.on("error", (e) => { console.log(`TUNNEL ws error: ${e.message}`); tcp.destroy(); });

  const ping = setInterval(() => { if (ws.readyState === ws.OPEN) ws.ping(); }, 30000);
  ws.on("close", () => clearInterval(ping));
}

server.listen(PORT, HOST, () => {
  console.log(`WoW bridge on https://${HOST}:${PORT}`);
  console.log(`  web: ${WEB_DIR}\n  game data: ${GAME_DIR}\n  tunnel: ${[...REALM_HOSTS]} ports ${[...REALM_PORTS]}`);
  for (const [chk, what] of [[WEB_DIR, "index.html"], [path.join(GAME_DIR, "Data"), "Data/"]]) {
    if (!fs.existsSync(chk)) console.warn(`  WARNING: ${chk} is missing (${what})`);
  }
  for (const [port, target] of REDIRECTS) console.log(`  redirect: port ${port} -> ${target}`);
});
