# Agent instructions

**First read [PRIMARY_TODO.md](PRIMARY_TODO.md).** The final design uses a Telegram bot (Cloudflare
Worker), private R2, D1 jobs and a Raspberry Pi 3B+ importer. The earlier standalone Workers-only
setup is superseded.

Key references: [README.md](README.md), [ARCHITECTURE.md](ARCHITECTURE.md),
[SECURITY.md](SECURITY.md), [docs/SETUP.md](docs/SETUP.md), [docs/PI_SETUP.md](docs/PI_SETUP.md),
[docs/TELEGRAM.md](docs/TELEGRAM.md).

## Non-negotiables

- No public R2 URL and no public admin interface.
- Never store raw bearer tokens in D1 or commit them to Git. Same for Telegram/PI/R2/API secrets and
  private audio.
- Every recipient must have a different cryptographically random 256-bit token; private aliases stay
  in D1 only.
- One **private owner Telegram chat**, configured by numeric Telegram ID and authenticated webhook
  secret.
- Pi initiates outbound-only connections; do not open inbound ports on the Pi.
- Pi runs **one job at a time** to fit the 1 GB RAM Raspberry Pi 3B+.
- Prefer M4A AAC passthrough; transcode only when needed.
- Current yt-dlp on YouTube requires JavaScript challenge solving support: install yt-dlp EJS and a
  compatible Deno (>=2.3) or Node (>=22). Verify on device.
- No shell execution of user-controlled URLs. Only supported HTTPS YouTube hosts for MVP.
- Usage cap default 5 per recipient *per episode*, tracking logical download sessions, not raw HTTP
  requests.
- Preserve support for media Range requests and private Apple Podcasts / Overcast RSS.
- Keep D1 schema modifications in numbered migrations; this version requires 0001 through 0006.
- Worker and Pi upload protocols must be upgraded together. Every lease uses a separate upload
  prefix.
- Charge new inactivity-based sessions atomically with D1 batches. Do not claim completed-file
  counts.
- Pending Telegram replies may be stored only as authenticated ciphertext, committed with command
  effects.
- Do not represent scaffolded components as deployed or production-tested.
- Do not print secrets, real feed URLs or private user identity in issue logs/CI.
- Update TODO/WIKI/README when implementing or changing behavior.

## Implementation workflow

Inspect current code first, run tests locally, check CI. Fix regressions before provisioning. Use
the owner's **existing local Cloudflare credentials** for D1/R2/Worker provisioning; do not
introduce other stored tokens unnecessarily.

Confirm runtime behavior on a real Pi and real podcast clients. Explicitly document any security or
quota caveats discovered.

## Privacy model

Recipient token identifies the issued URL, not the actual person using it. IP + UA is HMACed per
recipient for coarse session deduplication and is not strong identity. This is not DRM.
