#!/usr/bin/env node
// Small admin page: load results, failure reasons and world sessions, from the files bridge.mjs writes.
//   ADMIN_PASSWORD=secret node admin.mjs      then open http://127.0.0.1:8081 (user: admin)
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const STATS_DIR = path.resolve(here, process.env.STATS_DIR ?? "stats");
const PORT = Number(process.env.ADMIN_PORT ?? 8081);
const HOST = process.env.ADMIN_HOST ?? "0.0.0.0";
const PASSWORD = process.env.ADMIN_PASSWORD;
if (!PASSWORD) { console.error("Set ADMIN_PASSWORD."); process.exit(1); }

const lines = (f) => {
  try { return fs.readFileSync(path.join(STATS_DIR, f), "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); }
  catch { return []; }
};
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const count = (rows, key) => rows.reduce((m, r) => ((m[r[key]] = (m[r[key]] ?? 0) + 1), m), {});
const table = (head, rows) => `<table><tr>${head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr>${rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`).join("")}</table>`;
const avg = (a) => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : 0);

function page(days) {
  const since = Date.now() - days * 86400_000;
  const events = lines("events.jsonl").filter((e) => e.t >= since);
  const byEvent = count(events, "event");
  const failures = count(events.filter((e) => e.event === "load_failed"), "detail");
  const browsers = count(events.filter((e) => e.event === "visit"), "detail");
  const loads = events.filter((e) => e.event === "loaded").map((e) => e.ms / 1000);
  // last report per session id
  const last = new Map();
  for (const s of lines("sessions.jsonl")) if (s.t >= since) last.set(s.id, s);
  const sessions = [...last.values()];
  const devices = {};
  for (const s of sessions) (devices[s.device] ??= []).push(s);
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>WoW admin</title>
<style>body{font:14px system-ui;background:#111;color:#ddd;margin:24px}h1,h2{color:#d9a826}table{border-collapse:collapse;margin:8px 0 24px}
td,th{border:1px solid #444;padding:4px 10px;text-align:left}a{color:#d9a826}</style>
<h1>WoW</h1>
<p>Last: ${[1, 7, 30].map((d) => `<a href="?days=${d}">${d} day${d > 1 ? "s" : ""}</a>`).join(" · ")} (showing ${days})</p>
<h2>Page loads</h2>${table(["event", "count"], Object.entries(byEvent))}
<p>Median-ish load time (loaded): ${avg(loads)} s over ${loads.length} loads</p>
<h2>Browsers</h2>${table(["browser", "visits"], Object.entries(browsers))}
<h2>Load failures</h2>${table(["reason", "count"], Object.entries(failures))}
<h2>World sessions</h2>${table(["device", "sessions", "avg minutes", "avg fps"],
    Object.entries(devices).map(([d, a]) => [d, a.length, (avg(a.map((s) => s.seconds)) / 60).toFixed(1), avg(a.filter((s) => s.fps).map((s) => s.fps))]))}`;
}

http.createServer((req, res) => {
  const auth = /^Basic (.+)$/.exec(req.headers.authorization ?? "");
  const [user, pass] = auth ? Buffer.from(auth[1], "base64").toString().split(/:(.*)/s) : [];
  if (user !== "admin" || pass !== PASSWORD) {
    res.writeHead(401, { "WWW-Authenticate": 'Basic realm="WoW admin"' });
    return res.end("Login required");
  }
  const days = Math.min(365, Math.max(1, Number(new URL(req.url, "http://x").searchParams.get("days")) || 7));
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  res.end(page(days));
}).listen(PORT, HOST, () => console.log(`Admin on http://${HOST}:${PORT}`));
