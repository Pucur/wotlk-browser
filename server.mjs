import express from "express";
import mysql from "mysql2/promise";
import crypto from "node:crypto";
import { N, g, k, modPow, toLE, fromLE, serverEphemeral, serverVerify } from "./srp.mjs";

const PORT = Number(process.env.PORT ?? 3000);
const EXPANSION_NAMES = {
  0: "Vanilla",
  1: "The Burning Crusade",
  2: "Wrath of the Lich King",
};
const CHALLENGE_TTL_MS = 60_000;
const SESSION_TTL_S = 24 * 60 * 60;

const pool = mysql.createPool({
  host: process.env.DB_HOST ?? "127.0.0.1",
  port: Number(process.env.DB_PORT ?? 3306),
  user: process.env.DB_USER ?? "acore",
  password: process.env.DB_PASS ?? "",
  database: process.env.AUTH_DB ?? "acore_auth",
  waitForConnections: true,
  connectionLimit: 10,
});

const challenges = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [id, c] of challenges) if (c.exp < now) challenges.delete(id);
}, 30_000).unref();

const USER_RE = /^[A-Za-z0-9_]{3,32}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const hexOf = (s, bytes) => typeof s === "string" && new RegExp(`^[0-9a-fA-F]{${bytes * 2}}$`).test(s);

function reply(res, status, lines) {
  res.status(status).type("text/plain").send(lines.join("\n"));
}
const fail = (res, status, msg) => reply(res, status, [msg]);

async function sessionAccount(token) {
  if (!/^[0-9a-f]{48}$/.test(token ?? "")) return null;
  const [rows] = await pool.query(
    `SELECT s.account_id AS id, a.username
       FROM wow_session s
       JOIN account a ON a.id = s.account_id
      WHERE s.token = ? AND s.expires_at > NOW()`,
    [token]
  );
  return rows[0] ?? null;
}

async function isBanned(accountId) {
  const [rows] = await pool.query(
    `SELECT 1 FROM account_banned
      WHERE id = ? AND active = 1
        AND (unbandate > UNIX_TIMESTAMP() OR unbandate = bandate)
      LIMIT 1`,
    [accountId]
  );
  return rows.length > 0;
}

async function accountInfoLines(accountId) {
  const [rows] = await pool.query(
    `SELECT username, email,
            COALESCE(DATE_FORMAT(last_login, '%Y-%m-%d %H:%i UTC'), 'Never') AS last_login,
            last_ip, expansion, failed_logins
       FROM account WHERE id = ?`,
    [accountId]
  );
  const a = rows[0];
  const banned = await isBanned(accountId);
  return [
    a.username,
    a.email,
    a.last_login,
    "Never",
    a.last_ip,
    EXPANSION_NAMES[a.expansion] ?? String(a.expansion),
    banned ? "Banned" : "Not banned",
    String(a.failed_logins ?? 0),
  ];
}

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

app.post("/account/register", async (req, res) => {
  const { user, salt, verifier, email } = req.body ?? {};

  if (!USER_RE.test(user ?? "")) return fail(res, 400, "INVALID_USERNAME");
  if (!hexOf(salt, 32) || !hexOf(verifier, 32)) return fail(res, 400, "INVALID_SALT_OR_VERIFIER");
  if (!EMAIL_RE.test(email ?? "")) return fail(res, 400, "INVALID_EMAIL");

  const name = user.toUpperCase();
  const [exists] = await pool.query("SELECT id FROM account WHERE username = ?", [name]);
  if (exists.length) return fail(res, 409, "USERNAME_TAKEN");

  try {
    await pool.query(
      `INSERT INTO account (username, salt, verifier, email, reg_mail, joindate, expansion)
       VALUES (?, UNHEX(?), UNHEX(?), ?, ?, NOW(), ?)`,
      [name, salt, verifier, email, email, 2]
    );
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") return fail(res, 409, "USERNAME_TAKEN");
    throw err;
  }
  reply(res, 200, ["OK"]);
});

app.post("/account/challenge", async (req, res) => {
  const user = String(req.body?.user ?? "").toUpperCase();
  const [rows] = await pool.query(
    "SELECT id, HEX(salt) AS salt, HEX(verifier) AS verifier FROM account WHERE username = ?",
    [user]
  );
  if (!rows.length) return fail(res, 404, "ACCOUNT_NOT_FOUND");

  const acc = rows[0];
  const saltBuf = Buffer.from(acc.salt, "hex");
  const vBuf = Buffer.from(acc.verifier, "hex");
  const { b, B } = serverEphemeral(vBuf);

  const id = crypto.randomBytes(16).toString("hex");
  challenges.set(id, {
    accountId: acc.id,
    username: user,
    saltBuf,
    vBuf,
    b,
    B,
    exp: Date.now() + CHALLENGE_TTL_MS,
  });

  reply(res, 200, ["OK", id, saltBuf.toString("hex"), toLE(B).toString("hex")]);
});

app.post("/account/login", async (req, res) => {
  const { id, a, m1 } = req.body ?? {};

  const ch = challenges.get(id);
  challenges.delete(id);
  if (!ch || ch.exp < Date.now()) return fail(res, 401, "INVALID_CHALLENGE");
  if (!hexOf(a, 32) || !hexOf(m1, 20)) return fail(res, 400, "BAD_REQUEST");

  const A = fromLE(Buffer.from(a, "hex"));
  const proof = serverVerify({
    username: ch.username,
    saltBuf: ch.saltBuf,
    vBuf: ch.vBuf,
    b: ch.b,
    B: ch.B,
    A,
    m1: Buffer.from(m1, "hex"),
  });
  if (!proof) {
    await pool.query("UPDATE account SET failed_logins = failed_logins + 1 WHERE id = ?", [ch.accountId]);
    return fail(res, 401, "WRONG_PASSWORD");
  }

  if (await isBanned(ch.accountId)) return fail(res, 403, "BANNED");

  const token = crypto.randomBytes(24).toString("hex");
  await pool.query("DELETE FROM wow_session WHERE expires_at < NOW()");
  await pool.query(
    "INSERT INTO wow_session (token, account_id, expires_at) VALUES (?, ?, NOW() + INTERVAL ? SECOND)",
    [token, ch.accountId, SESSION_TTL_S]
  );
  await pool.query(
    "UPDATE account SET last_login = NOW(), last_ip = ?, failed_logins = 0 WHERE id = ?",
    [req.ip, ch.accountId]
  );

  const info = await accountInfoLines(ch.accountId);
  reply(res, 200, ["OK", token, ...info]);
});

app.post("/account/password", async (req, res) => {
  const { user, token, salt, verifier } = req.body ?? {};

  const session = await sessionAccount(token);
  if (!session) return fail(res, 401, "INVALID_TOKEN");
  if (session.username !== String(user ?? "").toUpperCase()) return fail(res, 403, "USER_MISMATCH");
  if (!hexOf(salt, 32) || !hexOf(verifier, 32)) return fail(res, 400, "INVALID_SALT_OR_VERIFIER");

  await pool.query("UPDATE account SET salt = UNHEX(?), verifier = UNHEX(?) WHERE id = ?", [
    salt,
    verifier,
    session.id,
  ]);
  reply(res, 200, ["OK"]);
});

app.post("/account/email", async (req, res) => {
  const { token, email } = req.body ?? {};

  const session = await sessionAccount(token);
  if (!session) return fail(res, 401, "INVALID_TOKEN");
  if (!EMAIL_RE.test(email ?? "")) return fail(res, 400, "INVALID_EMAIL");

  await pool.query("UPDATE account SET email = ? WHERE id = ?", [email, session.id]);
  reply(res, 200, ["OK"]);
});

app.post("/account/info", async (req, res) => {
  const session = await sessionAccount(req.body?.token);
  if (!session) return fail(res, 401, "INVALID_TOKEN");

  const info = await accountInfoLines(session.id);
  reply(res, 200, ["OK", ...info]);
});

app.use((err, req, res, _next) => {
  console.error(err);
  if (!res.headersSent) fail(res, 500, "SERVER_ERROR");
});

const schema = `CREATE TABLE IF NOT EXISTS wow_session (
  token CHAR(48) PRIMARY KEY,
  account_id INT UNSIGNED NOT NULL,
  expires_at DATETIME NOT NULL,
  INDEX idx_account (account_id),
  CONSTRAINT fk_lh_session_account
    FOREIGN KEY (account_id) REFERENCES account(id) ON DELETE CASCADE
)`;

await pool.query(schema);
app.listen(PORT, () => console.log(`account engine running: http://localhost:${PORT}`));
