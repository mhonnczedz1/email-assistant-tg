import { createHash, timingSafeEqual } from "node:crypto";

export const TTL = 900; // seconds a code may wait
export const PER_VISITOR = 20; // callbacks one visitor may store per window; real use is one
export const STATE_RE = /^[A-Za-z0-9_-]{20,64}$/;
export const CODE_RE = /^4\/[\w\-.~]{10,512}$/;
export const ERROR_RE = /^[a-z_]{1,40}$/;

export const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>Email Assistant</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:28rem;margin:3rem auto;padding:0 1rem;color:#1a1a1a}</style></head>
<body><h1>Thanks</h1><p>You can go back to Telegram now. The assistant will tell you when it is connected.</p>
<p style="color:#555;font-size:.9rem">If nothing happens there, tap Connect Gmail in the chat and try again.</p></body></html>`;

export function privateHeaders(res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
}

export function paramsOf(req) {
  return new URL(req.url, "http://relay.local").searchParams;
}

/** A short, non-reversible label for the visitor, so the limiter keeps no addresses. */
export function visitor(req) {
  const h = req.headers ?? {};
  const raw = h["x-real-ip"] || String(h["x-forwarded-for"] ?? "").split(",")[0].trim() || "unknown";
  return createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

const digest = (s) => createHash("sha256").update(String(s)).digest();

/** True if the Authorization header is `Bearer <expected>`; compares fixed-length digests in constant time. */
export function keyOk(header, expected) {
  if (!expected || typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  return timingSafeEqual(digest(header.slice(7)), digest(expected));
}

/** Keep a code (or a Google refusal) for `state`, once, for TTL seconds. Anything malformed is ignored. */
export async function keep(redis, params, who = "unknown") {
  const state = params.get("state"), code = params.get("code"), error = params.get("error");
  if (!STATE_RE.test(state ?? "")) return false;
  let value;
  if (code && CODE_RE.test(code)) value = `c:${code}`;
  else if (!code && error && ERROR_RE.test(error)) value = `e:${error}`;
  else return false;
  if (await redis.exists(`oauth:x:${state}`)) return false; // already collected: a reload must not re-store it
  const bucket = `oauth:rl:${who}:${Math.floor(Date.now() / 1000 / TTL)}`; // a fresh key each window
  const n = await redis.incr(bucket);
  await redis.expire(bucket, TTL * 2); // every time, so a failed call can never leave it permanent
  if (n > PER_VISITOR) return false;
  return (await redis.set(`oauth:${state}`, value, { ex: TTL, nx: true })) === "OK";
}

/** Read and delete what is waiting for `state`: {code}, {error} or null. */
export async function take(redis, state) {
  const value = await redis.getdel(`oauth:${state}`);
  if (typeof value !== "string") return null;
  await redis.set(`oauth:x:${state}`, "1", { ex: TTL }); // remember it was collected
  if (value.startsWith("c:")) return { code: value.slice(2) };
  if (value.startsWith("e:")) return { error: value.slice(2) };
  return null;
}
