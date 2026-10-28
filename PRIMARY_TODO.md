# PRIMARY TODO: local agent handoff

**Target:** Finish and deploy Telegram -> Worker/D1 -> Pi importer -> private R2 -> RSS.

This is the canonical current handoff. Do not start by rewriting the architecture.

## P0. Verify committed code first

- [x] Run `npm ci`, `npm run typecheck`, `npm test`: local unit and Worker integration checks pass.
- [x] Commit verified changes and confirm the branch CI run.
- [x] Check GitHub Actions [CI](.github/workflows/ci.yml) and fix the Linux lockfile failure.
- [x] Validate Python syntax and run the Pi behavioral suite locally.
- [x] Add local D1/R2 tests for webhook security, lease fencing, publication, RSS, revoked tokens,
      Range headers, quotas, direct uploads and replay.
- [x] Confirm Wrangler configuration builds in dry-run mode; existing ambient types pass typecheck.
- [x] Make sliding session creation and quota charging transactional; validate local concurrency and
      failure rollback.
- [ ] Accept the heuristic session behavior with real podcast apps and network changes.

## P0. Cloudflare (using existing local credentials)

- [x] Verify the existing configured Cloudflare account without copying credentials into Git.
- [x] Create D1 database `my-podcast-private-db` and record its UUID in `wrangler.jsonc`.
- [ ] Create private R2 bucket `my-podcast-private-audio`, unless already present. Disable any
      public `r2.dev` or custom-domain access.
- [x] Apply all six D1 migrations; verify zero recipients, episodes and jobs.
- [x] Generate independent APP_HMAC_SECRET, PI_AGENT_TOKEN and TELEGRAM_WEBHOOK_SECRET
  values in ignored, access-restricted local `.dev.vars`.
- [ ] Set application secrets remotely when deploying the Worker; never commit their values.
- [ ] Configure `PUBLIC_BASE_URL` to the actual HTTPS Worker origin; set `PODCAST_TITLE`,
      `PODCAST_DESCRIPTION`, etc., as desired.
- [ ] Deploy Worker, then confirm `/robots.txt` responds and unknown tokens 404.
- [ ] Check Cloudflare Worker traces and logs: disable/sanitize any facility retaining paths with
      bearer tokens.

## P0. Telegram

- [ ] Owner creates a bot via @BotFather and obtains the bot token.
- [ ] Owner supplies their **numeric** Telegram user ID; check carefully.
- [ ] Put `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_OWNER_USER_ID` in local
      `.dev.vars` and production secrets/vars as appropriate.
- [ ] Run `npm run telegram:webhook` with `PUBLIC_BASE_URL` set.
- [ ] Test direct MP3/M4A upload under 20 MB through the bot and verify a published episode.
- [ ] Validate `/help`, `/add`, `/list`, `/import`, `/jobs`, `/rotate`, `/revoke`, `/reset`,
      `/limit`.
- [ ] Confirm messages from other users/groups and calls without the Telegram webhook secret cannot
      trigger any commands.

## P0. Raspberry Pi

- [ ] Verify Pi 3B+ is stable, fully updated, has sufficient free space and no undervoltage; test
      under FFmpeg load.
- [ ] Install 64-bit Raspberry Pi OS Lite, Python >=3.11, FFmpeg and current yt-dlp with EJS
      dependency.
- [ ] Install a **current Deno >=2.3** or Node >=22 that actually works on Pi's ARM platform;
      confirm yt-dlp detects it. Do not assume OS apt Node meets minimum.
- [ ] Install Pi dependencies into a venv, deploy `pi/worker.py`.
- [ ] Create an R2 access key limited to the audio bucket, preferably only required object
      operations. Store on Pi only.
- [ ] Create root-readable `/etc/my-podcast-private/pi-agent.env` from the example; match
      `PI_AGENT_TOKEN` with Cloudflare Worker secret.
- [ ] Install `pi/podcast-pi-agent.service`, enable and start systemd service.
- [ ] Test short YouTube audio import end to end, then an import that requires FFmpeg transcoding.
- [ ] Confirm Pi reconnects automatically after a reboot or internet outage and reports failed
      imports cleanly.
- [ ] Test file size/disk space behavior for long audio; measure processing time on Pi 3B+.
- [ ] Observe 30-minute lease heartbeat while a job runs; verify expired jobs are reclaimed.

## P0. Real listener validation

- [ ] Create test friend by `/add <alias>` and subscribe in Apple Podcasts.
- [ ] Repeat in Overcast, test playback/seek/resume/stream/download.
- [ ] Test incorrect and revoked tokens, feed noindex settings, no public R2 access.
- [ ] Verify cap = five distinct sessions under real client behavior, NOT five Range calls.
- [ ] Verify a sixth *new* session is denied while earlier counted session requests work.
- [ ] Test media metadata and enclosure `Content-Length`, `Content-Type`, `Content-Range`, `ETag`;
      validate RSS against both clients.
- [ ] Fix and document any deviation.

## P0 safety gaps to evaluate before real content

1. Local regressions now cover transactional sliding sessions and quota limits.
   Real clients still need to accept the inactivity model; accepted transfers can
   consume allowance even if the client later disconnects.
2. Completion uses a conditional D1 transaction and per-attempt R2 keys. Test real
   expired leases, upload interruption and outage recovery on the Pi.
3. Telegram uses an encrypted transactional reply outbox. Test real send failures,
   finite Telegram retry windows and possible duplicate replies after ambiguity.
4. Verify actual Cloudflare logging does not retain bearer paths. Source emits
   fixed diagnostic events; privacy still depends on account configuration.
5. Validate exact Range/HEAD/If-Range behavior in Apple Podcasts and Overcast.
6. Rehearse [backup/restore and orphan recovery](docs/OPERATIONS.md); cleanup of
   actual objects is a separate reviewed action.
7. Validate the updated systemd sandbox, shared state lock, ARM JavaScript runtime,
   temporary storage, certificates and R2 access on the intended device.

## After P0

- [ ] Simple local CLI for recipient and episode operations, if Telegram isn't sufficient.
- [x] Document D1 backup / restore procedure; real restore rehearsal remains pending.
- [x] Test owner-only direct Telegram audio upload locally with mocked Bot API; real upload remains
      pending.
- [ ] Explicit per-friend episode permissions if needed.
- [ ] Add a sanitized usage report and threshold alerts.
- [ ] Consider Cloudflare rate limiting invalid token probes.

## Definition of done

A user can send a YouTube URL to the bot; an idle Pi eventually picks it up, downloads only audio,
sends it to private R2, and a friend sees the published episode in Apple Podcasts or Overcast
through their separate unguessable feed URL. Revocation and download caps work as designed. No
source secrets or production audio are committed.
