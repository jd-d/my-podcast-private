# Wiki

The canonical project documentation is in the repository. This index is the entrypoint.

## How it works

**Telegram** is the owner-only admin UI, including direct MP3/M4A upload for small files. **Cloudflare Workers** validates the webhook, runs the private RSS gateway and agent API. **D1** stores recipients, episodes, job queue, token digests and usage. **R2** stores private audio. **Pi 3B+** runs yt-dlp/FFmpeg and uploads via R2 S3 API.

## Key concepts

- **Recipient:** private owner-visible alias and associated secret link; alias is not the URL.
- **Bearer token:** 32 cryptographically random bytes encoded in base64url; only its keyed HMAC digest is stored. If lost, rotate via `/rotate <id>`.
- **Feed:** `https://host/f/<token>/feed.xml`; enclosure points back through the Worker.
- **Episode:** D1 metadata record backed by a private R2 audio object.
- **Download allowance:** default 5 sessions per episode per recipient; session is approximated using an IP+UA HMAC per recipient and a 30-minute time bucket. Not DRM or identity verification.
- **Import job:** pending → processing (leased 30 minutes, heartbeats every 2 minutes) → completed or failed. Pi polls outbound.
- **Administration:** `/add`, `/list`, `/revoke`, `/rotate`, `/limit`, `/reset`, `/import`, `/jobs`, `/retry`, `/help`.

## Entry points

- [README](README.md)
- [PRIMARY TODO](PRIMARY_TODO.md)
- [General TODO](TODO.md)
- [Agent instructions](AGENTS.md)
- [Architecture](ARCHITECTURE.md)
- [Security](SECURITY.md)
- [Cloudflare setup](docs/SETUP.md)
- [Pi setup](docs/PI_SETUP.md)
- [Telegram setup](docs/TELEGRAM.md)
- [Operations](docs/OPERATIONS.md)

## Status

Source is implemented and committed; provisioning, CI fixes if any, real podcast-client integration, Pi runtime and download-cap robustness tests are not yet complete. See PRIMARY_TODO.
