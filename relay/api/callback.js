import { Redis } from "@upstash/redis";
import { PAGE, keep, paramsOf, privateHeaders, visitor } from "../lib/core.js";

/** Google sends the person's browser here. Nothing is ever echoed back, whatever the input. */
export function makeCallback(redis) {
  return async function callback(req, res) {
    privateHeaders(res);
    if (req.method !== "GET") return res.status(405).send("");
    try {
      await keep(redis, paramsOf(req), visitor(req));
    } catch {
      // The page is the same whether or not the store worked; the assistant tells the person if it never arrives.
    }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(200).send(PAGE);
  };
}

let redis;
export default function handler(req, res) {
  redis ??= new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN,
  });
  return makeCallback(redis)(req, res);
}
