# PRIMARY TODO: local agent handoff

**Target:** Finish and deploy the Telegram → Cloudflare Worker/D1 → Pi 3B+ yt-dlp → private R2 → RSS flow.

This is the canonical current handoff. Do not start by rewriting the architecture.

## P0. Verify committed code first

- [ ] Run `npm install`, `npm run typecheck`, `npm test`. Fix all failures and commit changes.
- [ ] Check GitHub Actions [CI](.github/workflows/ci.yml) status and fix failing jobs.
- [ ] Run `python3 -m py_compile pi/worker.py`.
- [ ] Add integration tests using local D1/R2 bindings. Especially test Telegram webhook security, claim/lease/heartbeat, R2 completion, RSS and revoked-token behavior.
- [ ] Confirm Cloudflare's current `wrangler.jsonc` syntax and migrate from any stale `@cloudflare/workers-types` patterns.
- [ ] Review download-session accounting for concurrency and quota bypass. Existing implementation is heuristic and has not been validated with real podcast apps.

## P0. Cloudflare (using existing local credentials)

- [ ] Identify correct Cloudflare account; do not copy credentials into Git.
- [ ] Create D1 database `my-podcast-private-db`, unless already present; update placeholder UUID in `wrangler.jsonc`.
- [ ] Create private R2 bucket `my-podcast-private-audio`, unless already present. Disable any public `r2.dev` or custom-domain access.
- [ ] Apply all three D1 migrations (0001, 0002 and 0003).
- [ ] Generate **independent** strong random values for `APP_HMAC_SECRET`, `PI_AGENT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`; put into local `.dev.vars` and remote Wrangler Secrets. Never commit them.
- [ ] Configure `PUBLIC_BASE_URL` to the actual HTTPS Worker origin; set `PODCAST_TITLE`, `PODCAST_DESCRIPTION`, etc., as desired.
- [ ] Deploy Worker, then confirm `/robots.txt` responds and unknown tokens 404.
- [ ] Check Cloudflare Worker traces and logs: disable/sanitize any facility retaining paths with bearer tokens.

## P0. Telegram

- [ ] Owner creates a bot via @BotFather and obtains the bot token.
- [ ] Owner supplies their **numeric** Telegram user ID; check carefully.
- [ ] Put `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_OWNER_USER_ID` in local `.dev.vars` and production secrets/vars as appropriate.
- [ ] Run `npm run telegram:webhook` with `PUBLIC_BASE_URL` set.
- [ ] Test direct MP3/M4A upload under 20 MB through the bot and verify a published episode.
- [ ] Validate `/help`, `/add`, `/list`, `/import`, `/jobs`, `/rotate`, `/revoke`, `/reset`, `/limit`.
- [ ] Confirm messages from other users/groups and calls without the Telegram webhook secret cannot trigger any commands.

## P0. Raspberry Pi

- [ ] Verify Pi 3B+ is stable, fully updated, has sufficient free space and no undervoltage; test under FFmpeg load.
- [ ] Install 64-bit Raspberry Pi OS Lite, Python >=3.11, FFmpeg and current yt-dlp with EJS dependency.
- [ ] Install a **current Deno >=2.3** or Node >=22 that actually works on Pi's ARM platform; confirm yt-dlp detects it. Do not assume OS apt Node meets minimum.
- [ ] Install Pi dependencies into a venv, deploy `pi/worker.py`.
- [ ] Create an R2 access key limited to the audio bucket, preferably only required object operations. Store on Pi only.
- [ ] Create root-readable `/etc/my-podcast-private/pi-agent.env` from the example; match `PI_AGENT_TOKEN` with Cloudflare Worker secret.
- [ ] Install `pi/podcast-pi-agent.service`, enable and start systemd service.
- [ ] Test short YouTube audio import end to end, then an import that requires FFmpeg transcoding.
- [ ] Confirm Pi reconnects automatically after a reboot or internet outage and reports failed imports cleanly.
- [ ] Test file size/disk space behavior for long audio; measure processing time on Pi 3B+.
- [ ] Observe 30-minute lease heartbeat while a job runs; verify expired jobs are reclaimed.

## P0. Real listener validation

- [ ] Create test friend by `/add <alias>` and subscribe in Apple Podcasts.
- [ ] Repeat in Overcast, test playback/seek/resume/stream/download.
- [ ] Test incorrect and revoked tokens, feed noindex settings, no public R2 access.
- [ ] Verify cap = five distinct sessions under real client behavior, NOT five Range calls.
- [ ] Verify a sixth *new* session is denied while earlier counted session requests work.
- [ ] Test media metadata and enclosure `Content-Length`, `Content-Type`, `Content-Range`, `ETag`; validate RSS against both clients.
- [ ] Fix and document any deviation.

## P0 safety gaps to evaluate before real content

1. Session accounting now marks charged sessions and prevents uncharged duplicates from being accepted, while quota increments use conditional SQL UPDATE. Verify concurrent behavior in integration tests; D1 steps still span multiple calls and failed requests may consume an allowance.
2. Job completion uses a batch with a conditional UPDATE after inserting an episode: verify it cannot publish after lease expiry or a race, and enforce that exactly one row transitioned.
3. Telegram `telegram_updates` de-duplicates before command execution. If a Telegram send or D1 command fails, that update will not automatically retry. Decide on explicit error replay/audit semantics.
4. Ensure Worker/Cloudflare logs and Telegram messages do not accidentally expose bearer credentials.
5. Limit RSS and episode responses to supported real-client behaviors; test malformed byte ranges.
6. Document recovery of a failed upload/job and cleanup of orphaned R2 objects.
7. Validate that the Pi service systemd sandbox allows all required binaries, temporary files, SSL/certificates and R2 access.

## After P0

- [ ] Simple local CLI for recipient and episode operations, if Telegram isn't sufficient.
- [ ] D1 backup / restore procedure.
- [ ] Optional trusted-only Telegram audio upload workflow (Bot API getFile typically capped at 20 MB).
- [ ] Explicit per-friend episode permissions if needed.
- [ ] Add a sanitized usage report and threshold alerts.
- [ ] Consider Cloudflare rate limiting invalid token probes.

## Definition of done

A user can send a YouTube URL to the bot; an idle Pi eventually picks it up, downloads only audio, sends it to private R2, and a friend sees the published episode in Apple Podcasts or Overcast through their separate unguessable feed URL. Revocation and download caps work as designed. No source secrets or production audio are committed.
