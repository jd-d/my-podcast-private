# Wiki

The canonical project documentation is in the repository. This index is the entrypoint.

## How it works

**Telegram** is the owner-only admin UI, including direct MP3/M4A upload for small files.
**Cloudflare Workers** validates the webhook, runs the private RSS gateway and agent API. **D1**
stores recipients, episodes, job queue, token digests and usage. **R2** stores private audio. **Pi
3B+** runs yt-dlp/FFmpeg and uploads via R2 S3 API.

## Key concepts

- **Recipient:** private owner-visible alias and associated secret link; alias is not the URL.
- **Bearer token:** 32 cryptographically random bytes encoded in base64url; only its keyed HMAC
  digest is stored. If lost, rotate via `/rotate <id>`.
- **Feed:** `https://host/f/<token>/feed.xml`; enclosure points back through the Worker.
- **Episode:** D1 metadata record backed by a private R2 audio object.
- **Download allowance:** default 5 sessions per episode per recipient; session is approximated
  using an IP+UA HMAC per recipient and a sliding 30-minute inactivity window. Not DRM or identity
  verification.
- **Import job:** pending -> processing (leased 30 minutes, heartbeats every 2 minutes) -> completed
  or failed. Pi polls outbound.
- **Administration:** `/add`, `/list`, `/revoke`, `/rotate`, `/limit`, `/reset`, `/import`, `/jobs`,
  `/retry`, `/help`.

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

Source is implemented and committed; provisioning, CI fixes if any, real podcast-client integration,
Pi runtime and download-cap robustness tests are not yet complete. See PRIMARY_TODO.

## Readiness review

At 2026-10-28T02:48:46Z, main at `aedc9d0` passed local typecheck, 15 unit
tests, Python syntax validation and a Wrangler dry-run build. Synthetic local
D1/R2 probes exposed invalid Range headers and confirmed basic job lifecycle,
revocation and same-client concurrency behavior. A targeted Pi probe confirmed
HTTP 409 heartbeats do not set the lost-lease flag. Existing Cloudflare access
has Workers/D1 write permissions but only R2 read permission. No resources were
provisioned. See the [readiness review](reviews/2026-10-28-readiness-review.md)
for evidence, priorities, access requirements and remaining owner inputs.

## Runtime hardening

At 2026-10-28T03:08:53Z, the readiness findings were addressed in source:

- Single-range offsets and lengths are parsed explicitly. R2 optional-property
  getters no longer influence response math. If-Range uses strong ETags.
- Migration 0004 replaces provisional fixed buckets with transactional sessions
  that expire after inactivity. It preserves counters and active charged legacy
  sessions using a 30-minute transition window. New sessions use the configured
  inactivity duration. It does not turn the heuristic into identity or DRM.
- Migration 0005 assigns every lease an independent R2 upload prefix. Update
  Worker and Pi together; previous agents cannot use the new completion protocol.
- The Pi handles rejected/expired leases, cancellation, Node runtime selection,
  output limits, disk reservation and a shared state-directory process lock.
- Migration 0006 adds the encrypted Telegram reply outbox. The unique update row
  and command changes commit together. Ciphertext is cleared after delivery;
  random operation IDs identify which concurrent upload attempt owns cleanup.
- API body limits count actual bytes; asynchronous handler failures emit fixed
  diagnostic events. Dependency resolution is locked for npm ci in CI.

See `integration/runtime.test.mjs`, `pi/test_worker.py` and the existing unit
suite. Fixtures/builds are ignored under `tmp/`. Deployment, real Pi behavior,
private-bucket/logging verification and listener acceptance remain separate.
The original [readiness review](reviews/2026-10-28-readiness-review.md) records
the before state; [Operations](docs/OPERATIONS.md) records recovery procedures.

CI exposed a Windows lockfile missing TypeScript's Linux optional binary.
Regenerate locks from an empty directory, with direct dependencies pinned to the
reviewed versions; resolution against an existing platform-specific node_modules
tree can omit other platforms. Verify Linux/Windows TypeScript and runtime entries
before committing a regenerated lock. Wrangler's local migration runner also
applied all six migrations successfully.
