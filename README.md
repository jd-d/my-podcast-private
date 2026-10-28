# my-podcast-private

Private podcast feeds managed through **Telegram**, with **Cloudflare Workers + D1 + private R2** and a **Raspberry Pi 3B+** performing audio imports using yt-dlp.

## Workflow

1. In a private Telegram chat, send `/import https://youtu.be/...`.
2. The Cloudflare Worker verifies your Telegram user ID and registers a job in D1.
3. Your Pi polls Cloudflare over outbound HTTPS; no inbound ports, VPN, or Docker required.
4. The Pi downloads just audio with yt-dlp; passes through M4A or converts to AAC/M4A with FFmpeg when necessary.
5. The Pi uploads to a private R2 bucket using bucket-scoped S3 credentials.
6. It reports the completed job back to the Worker, which verifies the R2 object, publishes the episode into D1, and notifies you on Telegram.
7. Each friend subscribes via a **separate 256-bit random RSS URL**, in Apple Podcasts or Overcast.

## Components

- `src/index.ts`: existing private RSS/audio Worker gateway, download limits and activity.
- `src/telegram.ts`: owner-only Telegram webhook and admin commands.
- `src/agent.ts`: authenticated Pi polling/claim/heartbeat/completion API.
- `src/security.ts`: token generation, keyed hashing, URL restrictions.
- `migrations/`: D1 schemas including the import job queue.
- `pi/worker.py`: single-job headless downloader and R2 uploader.
- `pi/podcast-pi-agent.service`: systemd unit.
- `scripts/set-telegram-webhook.mjs`: webhook registration.
- `test/` and `.github/workflows/ci.yml`: JS tests, TypeScript check and Python compile check.

## Start here

**Coding agent:** read [PRIMARY_TODO.md](PRIMARY_TODO.md), then [AGENTS.md](AGENTS.md) and [docs/SETUP.md](docs/SETUP.md).

**Owner:** gather Telegram BotFather token, numeric Telegram user ID, a Cloudflare account, and Pi SSH access. All other generated secrets should be created during setup and stored only in the environment/Cloudflare secrets. See [docs/TELEGRAM.md](docs/TELEGRAM.md) and [docs/PI_SETUP.md](docs/PI_SETUP.md).

Local code checks:

```bash
npm install
npm run typecheck
npm test
```

## Telegram commands

```text
/add Sarah                    create private feed URL
/list                         show recipients and usage
/revoke 3                     revoke recipient #3
/rotate 3                     invalidate previous link, create new one
/limit 3 5                    configure recipient's per-episode limit
/reset 3                      reset usage
/import https://youtu.be/...  queue an audio import
/jobs                         show import status
/retry <full-job-uuid>         retry failed job
/help                         show commands
```

For small MP3/M4A recordings under 20 MB, send the file directly to the bot. The Worker publishes it immediately to private R2 without involving the Pi.

Admin commands only work from your configured numeric Telegram user ID **in a private chat**. Telegram retains messages containing shared feed URLs, so only send to recipients via an appropriately trusted channel.

## Security and limits

- No public R2 bucket endpoint.
- No public admin dashboard.
- Unique 32-byte random recipient tokens and HMAC-only storage.
- Alias private in D1; never in public feed links.
- Default **5 logical download sessions per episode per recipient**, not five raw HTTP Range requests.
- No identity verification for recipients: a bearer URL can be forwarded. Cap is abuse mitigation, not DRM. A charged-session marker reduces concurrent uncounted Range bypasses, but real-client testing is mandatory.
- Podcast clients, platforms and intermediaries may receive private feed URL information during normal use.
- Use only recordings you have permission to download and share.

See [SECURITY.md](SECURITY.md). The first real-device tests and security review remain necessary before treating the service as production-ready.

## Project hygiene

[PRIMARY_TODO.md](PRIMARY_TODO.md) · [TODO.md](TODO.md) · [WIKI.md](WIKI.md) · [AGENTS.md](AGENTS.md) · [ARCHITECTURE.md](ARCHITECTURE.md)
