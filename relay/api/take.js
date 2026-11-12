import { Redis } from "@upstash/redis";
import { STATE_RE, keyOk, paramsOf, privateHeaders, take } from "../lib/core.js";

/** The assistant asks for the code that belongs to its sign-in. Needs the private key. */
export function makeTake(redis, key) {
  return async function takeHandler(req, res) {
    privateHeaders(res);
    if (req.method !== "GET") return res.status(405).send("");
    if (!keyOk(req.headers?.authorization, key)) return res.status(401).send("");
    const state = paramsOf(req).get("state") ?? "";
    if (!STATE_RE.test(state)) return res.status(400).send("");
    const got = await take(redis, state);
    if (got === null) return res.status(204).end();
    return res.status(200).json(got);
  };
}

let redis;
export default function handler(req, res) {
  redis ??= new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN,
  });
  return makeTake(redis, process.env.OAUTH_RELAY_KEY)(req, res);
}
