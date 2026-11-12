import { test } from "node:test";
import assert from "node:assert/strict";
import { makeCallback } from "../api/callback.js";
import { makeTake } from "../api/take.js";
import { keyOk, TTL } from "../lib/core.js";

const STATE = "S".repeat(30);
const CODE = "4/0AbCdEfGhIjKlMnOpQr_stu-v";
const KEY = "relay-key-123";

class FakeRedis {
  constructor() { this.data = new Map(); this.sets = []; this.counter = 0; }
  async set(key, value, opts = {}) {
    if (opts.nx && this.data.has(key)) return null;
    this.data.set(key, value); this.sets.push({ key, value, ...opts }); return "OK";
  }
  async getdel(key) { const v = this.data.has(key) ? this.data.get(key) : null; this.data.delete(key); return v; }
  async incr(key) { this.counts ??= {}; return (this.counts[key] = (this.counts[key] ?? 0) + 1); }
  async expire(key, ttl) { this.expires ??= {}; this.expires[key] = ttl; return 1; }
  async exists(key) { return this.data.has(key) ? 1 : 0; }
}

function res() {
  const r = { headers: {}, code: 200, body: undefined };
  r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; return r; };
  r.status = (c) => { r.code = c; return r; };
  r.send = (b) => { r.body = b; return r; };
  r.json = (b) => { r.headers["content-type"] = "application/json"; r.body = JSON.stringify(b); return r; };
  r.end = () => r;
  return r;
}
const get = (url, headers = {}) => ({ method: "GET", url, headers });

test("a well formed callback is stored once with an expiry", async () => {
  const redis = new FakeRedis(), cb = makeCallback(redis);
  const r1 = res(); await cb(get(`/oauth/callback?code=${encodeURIComponent(CODE)}&state=${STATE}`), r1);
  assert.equal(r1.code, 200);
  assert.equal(redis.sets.length, 1);
  assert.equal(redis.sets[0].ex, TTL); assert.equal(redis.sets[0].nx, true);
  const r2 = res(); await cb(get(`/oauth/callback?code=${encodeURIComponent("4/0Different_code_value")}&state=${STATE}`), r2);
  assert.equal(redis.data.get(`oauth:${STATE}`), `c:${CODE}`, "the first code is kept");
});

test("a Google refusal is stored as an error", async () => {
  const redis = new FakeRedis();
  await makeCallback(redis)(get(`/oauth/callback?error=access_denied&state=${STATE}`), res());
  assert.equal(redis.data.get(`oauth:${STATE}`), "e:access_denied");
});

test("malformed input stores nothing and gets the same neutral page", async () => {
  const redis = new FakeRedis(), cb = makeCallback(redis), pages = new Set();
  for (const q of [
    `code=${encodeURIComponent(CODE)}&state=short`, `code=${encodeURIComponent(CODE)}`, `state=${STATE}`,
    `code=notacode&state=${STATE}`, `code=${encodeURIComponent(CODE)}&state=${"a b".repeat(10)}`,
    `error=Bad%20Value!&state=${STATE}`, `code=${encodeURIComponent("4/" + "x".repeat(600))}&state=${STATE}`,
  ]) { const r = res(); await cb(get(`/oauth/callback?${q}`), r); assert.equal(r.code, 200); pages.add(r.body); }
  assert.equal(redis.sets.length, 0);
  assert.equal(pages.size, 1, "every request gets the identical page");
});

test("the page never echoes the code and sets private headers", async () => {
  const r = res();
  await makeCallback(new FakeRedis())(get(`/oauth/callback?code=${encodeURIComponent(CODE)}&state=${STATE}`), r);
  assert.ok(!r.body.includes(CODE) && !r.body.includes(STATE));
  assert.equal(r.headers["cache-control"], "no-store");
  assert.equal(r.headers["referrer-policy"], "no-referrer");
  assert.match(r.headers["content-type"], /text\/html/);
});

test("only GET is accepted on the callback", async () => {
  const redis = new FakeRedis(), r = res();
  await makeCallback(redis)({ method: "POST", url: `/oauth/callback?code=${CODE}&state=${STATE}`, headers: {} }, r);
  assert.equal(r.code, 405); assert.equal(redis.sets.length, 0);
});

test("one visitor cannot fill the store, and others are unaffected", async () => {
  const redis = new FakeRedis(), cb = makeCallback(redis);
  const from = (ip, i) => get(`/oauth/callback?code=${encodeURIComponent(CODE)}&state=${String(i).padStart(30, "s")}`, { "x-real-ip": ip });
  for (let i = 0; i < 40; i++) await cb(from("1.1.1.1", i), res());
  assert.equal(redis.sets.length, 20, "the noisy visitor is stopped at the limit");
  await cb(from("2.2.2.2", 99), res());
  assert.equal(redis.sets.length, 21, "a different visitor still gets through");
  assert.ok(Object.values(redis.expires).every((t) => t > 0), "the counter always gets an expiry");
});

test("a reloaded callback does not store a collected code again", async () => {
  const redis = new FakeRedis(), cb = makeCallback(redis), take = makeTake(redis, KEY);
  const url = `/oauth/callback?code=${encodeURIComponent(CODE)}&state=${STATE}`;
  await cb(get(url), res());
  await take(get(`/api/take?state=${STATE}`, { authorization: `Bearer ${KEY}` }), res());
  await cb(get(url), res());
  const r = res(); await take(get(`/api/take?state=${STATE}`, { authorization: `Bearer ${KEY}` }), r);
  assert.equal(r.code, 204);
});

test("take hands over the code once and forgets it", async () => {
  const redis = new FakeRedis(); await redis.set(`oauth:${STATE}`, `c:${CODE}`);
  const take = makeTake(redis, KEY), auth = { authorization: `Bearer ${KEY}` };
  const r1 = res(); await take(get(`/api/take?state=${STATE}`, auth), r1);
  assert.equal(r1.code, 200); assert.deepEqual(JSON.parse(r1.body), { code: CODE });
  const r2 = res(); await take(get(`/api/take?state=${STATE}`, auth), r2);
  assert.equal(r2.code, 204);
});

test("take returns an error entry as an error", async () => {
  const redis = new FakeRedis(); await redis.set(`oauth:${STATE}`, "e:access_denied");
  const r = res(); await makeTake(redis, KEY)(get(`/api/take?state=${STATE}`, { authorization: `Bearer ${KEY}` }), r);
  assert.deepEqual(JSON.parse(r.body), { error: "access_denied" });
});

test("take refuses a missing or wrong key and leaves the code alone", async () => {
  const redis = new FakeRedis(); await redis.set(`oauth:${STATE}`, `c:${CODE}`);
  const take = makeTake(redis, KEY);
  for (const headers of [{}, { authorization: "Bearer nope" }, { authorization: KEY }, { authorization: `Bearer ${KEY}x` }]) {
    const r = res(); await take(get(`/api/take?state=${STATE}`, headers), r); assert.equal(r.code, 401);
  }
  assert.ok(redis.data.has(`oauth:${STATE}`));
});

test("take refuses everything when no key is configured, and bad states", async () => {
  const r = res(); await makeTake(new FakeRedis(), undefined)(get(`/api/take?state=${STATE}`, { authorization: "Bearer " }), r);
  assert.equal(r.code, 401);
  const r2 = res(); await makeTake(new FakeRedis(), KEY)(get("/api/take?state=bad", { authorization: `Bearer ${KEY}` }), r2);
  assert.equal(r2.code, 400);
  const r3 = res(); await makeTake(new FakeRedis(), KEY)({ method: "POST", url: "/api/take", headers: { authorization: `Bearer ${KEY}` } }, r3);
  assert.equal(r3.code, 405);
});

test("keyOk compares without caring about length", () => {
  assert.equal(keyOk(`Bearer ${KEY}`, KEY), true);
  assert.equal(keyOk("Bearer short", KEY), false);
  assert.equal(keyOk(undefined, KEY), false);
  assert.equal(keyOk(`Bearer ${KEY}`, ""), false);
});
