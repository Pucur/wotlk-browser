import crypto from "node:crypto";

export const N = BigInt("0x894B645E89E1535BBDAD5B8B290650530801B18EBFBF5E8FAB3C82872A3E9BB7");
export const g = 7n;
export const k = 3n;

export function modPow(base, exp, mod) {
  let result = 1n;
  base %= mod;
  while (exp > 0n) {
    if (exp & 1n) result = (result * base) % mod;
    base = (base * base) % mod;
    exp >>= 1n;
  }
  return result;
}

export const sha1 = (...parts) => {
  const h = crypto.createHash("sha1");
  for (const p of parts) h.update(p);
  return h.digest();
};

export function toLE(n, len = 32) {
  const out = Buffer.alloc(len);
  let x = n;
  for (let i = 0; i < len; i++) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

export function fromLE(buf) {
  let n = 0n;
  for (let i = buf.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(buf[i]);
  return n;
}

export const randomBig = (bytes = 32) => fromLE(crypto.randomBytes(bytes));

const HN = sha1(toLE(N));
const HG = sha1(toLE(g));
const HN_XOR_HG = Buffer.from(HN.map((b, i) => b ^ HG[i]));

export function interleave(S) {
  let start = 0;
  while (start < S.length && S[start] === 0) start++;
  if ((S.length - start) % 2) start++;

  const even = [];
  const odd = [];
  for (let i = start; i < S.length; i += 2) {
    even.push(S[i]);
    odd.push(S[i + 1]);
  }
  const h0 = sha1(Buffer.from(even));
  const h1 = sha1(Buffer.from(odd));

  const K = Buffer.alloc(40);
  for (let i = 0; i < 20; i++) {
    K[2 * i] = h0[i];
    K[2 * i + 1] = h1[i];
  }
  return K;
}

export function serverEphemeral(vBuf) {
  const v = fromLE(vBuf);
  const b = randomBig(32);
  const B = (k * v + modPow(g, b, N)) % N;
  return { b, B };
}

export function serverVerify({ username, saltBuf, vBuf, b, B, A, m1 }) {
  if (A % N === 0n) return null;

  const Ab = toLE(A);
  const Bb = toLE(B);
  const v = fromLE(vBuf);

  const u = fromLE(sha1(Ab, Bb));
  const S = modPow((A * modPow(v, u, N)) % N, b, N);
  const K = interleave(toLE(S));

  const hUser = sha1(Buffer.from(username.toUpperCase()));
  const M1 = sha1(HN_XOR_HG, hUser, saltBuf, Ab, Bb, K);

  if (!M1.equals(m1)) return null;

  const M2 = sha1(Ab, M1, K);
  return { K, M2 };
}
