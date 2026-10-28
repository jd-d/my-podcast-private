# my-podcast-private

Private podcast feeds managed through **Telegram**, with **Cloudflare Workers + D1 + private R2**
and a **Raspberry Pi 3B+** performing audio imports using yt-dlp.

## Workflow

1. In a private Telegram chat, send `/import https://youtu.be/...`.
2. The Cloudflare Worker verifies your Telegram user ID and registers a job in D1.
3. Your Pi polls Cloudflare over outbound HTTPS; no inbound ports, VPN, or Docker required.
4. The Pi downloads just audio with yt-dlp; passes through M4A or converts to AAC/M4A with FFmpeg
   when necessary.
5. The Pi uploads to a private R2 bucket using bucket-scoped S3 credentials.
6. It reports the completed job back to the Worker, which verifies the R2 object, publishes the
   episode into D1, and notifies you on Telegram.
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
- `test/` and `.github/workflows/ci.yml`: unit tests, local D1/R2 integration tests and Pi
  behavioral tests.

## Start here

**Coding agent:** read [PRIMARY_TODO.md](PRIMARY_TODO.md), then [AGENTS.md](AGENTS.md) and
[docs/SETUP.md](docs/SETUP.md).

**Owner:** gather Telegram BotFather token, numeric Telegram user ID, a Cloudflare account, and Pi
SSH access. All other generated secrets should be created during setup and stored only in the
environment/Cloudflare secrets. See [docs/TELEGRAM.md](docs/TELEGRAM.md) and
[docs/PI_SETUP.md](docs/PI_SETUP.md).

Local code checks:

```bash
npm ci
npm run typecheck
npm run lint:md
npm test
python -m venv .venv
# Activate .venv using your shell, then:
python -m pip install -r pi/requirements.txt
python -m unittest discover -s pi -p "test_*.py" -v
```

Integration tests use synthetic data, a local Worker runtime and mocked Telegram calls.
Generated builds and fixtures stay under ignored `tmp/`.

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

For small MP3/M4A recordings under 20 MB, send the file directly to the bot. The Worker publishes it
immediately to private R2 without involving the Pi.

Admin commands only work from your configured numeric Telegram user ID **in a private chat**.
Telegram retains messages containing shared feed URLs, so only send to recipients via an
appropriately trusted channel.

## Security and limits

- No public R2 bucket endpoint.
- No public admin dashboard.
- Unique 32-byte random recipient tokens; recipient records store HMAC digests only.
- Pending Telegram replies are AES-GCM encrypted in a transactional outbox, then cleared after
  delivery. Retries do not repeat committed commands.
- Alias private in D1; never in public feed links.
- Default **5 logical download sessions per episode per recipient**, not five raw HTTP Range
  requests.
- No identity verification for recipients: a bearer URL can be forwarded. Cap is abuse mitigation,
  not DRM. Quota and session creation commit atomically. A session expires after 30 minutes of
  inactivity; each accepted audio request extends it. Repeated downloads from the same apparent
  client remain one session while active. Real-client testing is mandatory.
- Podcast clients, platforms and intermediaries may receive private feed URL information during
  normal use.
- Use only recordings you have permission to download and share.

Range delivery supports single byte ranges and strong ETag `If-Range` checks.
Invalid, multiple or unsatisfiable ranges return 416 without consuming an allowance.
A charged request is an accepted transfer, not proof that the client saved every byte.

Each Pi lease has its own upload path. Lease rejection or local expiry cancels work;
stale attempts cannot overwrite the current attempt's published object.

Apply all **six migrations** before using this version; update Worker and Pi together.
See [SECURITY.md](SECURITY.md). The first real-device tests and security review remain necessary
before treating the service as production-ready.

## Project hygiene

[PRIMARY_TODO.md](PRIMARY_TODO.md) Â· [TODO.md](TODO.md) Â· [WIKI.md](WIKI.md) Â·
[AGENTS.md](AGENTS.md) Â· [ARCHITECTURE.md](ARCHITECTURE.md)
