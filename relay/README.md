# Sign-in callback relay

A tiny Vercel project. After someone taps Allow in Google, their browser lands on `/oauth/callback`. The relay keeps the one-time code for up to 15 minutes. The assistant, running anywhere, asks for it with a private key (`/api/take`), which deletes it. Nothing here can reach the assistant, and nothing here is a credential: the code is useless without the verifier and the Google client secret kept by the assistant.

- `GET /oauth/callback?code=&state=` (or `?error=&state=`): stores the code once for 15 minutes; always answers the same plain page; never shows the code.
- `GET /api/take?state=` with `Authorization: Bearer <OAUTH_RELAY_KEY>`: returns `{"code"}` or `{"error"}` once, or 204.

Environment (set in Vercel, never in git): `OAUTH_RELAY_KEY`, plus the Upstash Redis variables the Vercel integration adds (`KV_REST_API_URL`, `KV_REST_API_TOKEN`).

Assistant side (`.env`): `OAUTH_RELAY_URL=https://<your subdomain>` and the same `OAUTH_RELAY_KEY`. The Web client in Google Cloud must list `<OAUTH_RELAY_URL>/oauth/callback` as a redirect URI and its file must be saved as `google_web_client_secret.json`.

Vercel may log request addresses, including the query string of the callback, for a short time. A logged code is useless without the verifier and the client secret, but set the project's log retention to the minimum anyway.

Tests: `npm install`, then `npm test`.
