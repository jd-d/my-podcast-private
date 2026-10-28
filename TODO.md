# TODO

**Canonical priority:** [PRIMARY_TODO.md](PRIMARY_TODO.md). This file is the general backlog.

## P0 validation and deployment

- [x] Fix runtime review findings F1-F6 with local regression coverage.
- [ ] Commit verified fixes and confirm branch CI.
- [ ] Apply migrations 0001 through 0006 and provision private R2;
  existing deployment token needs R2 write permission.
- [ ] Set secrets/vars, deploy Worker, register Telegram webhook.
- [ ] Configure and start systemd service on Pi 3B+.
- [ ] Prove YouTube/M4A passthrough and FFmpeg fallback.
- [ ] Test bot admin commands, owner allowlist, direct MP3/M4A uploads and direct HTTP attacks.
- [ ] Test RSS in Apple Podcasts and Overcast, including Range and cap behavior.
- [ ] Verify private R2 permissions, logging, sensitive URL handling.
- [x] Fence stale uploads by attempt and make quota/session charging transactional.
- [x] Resolve source findings F1-F6 from the
  [readiness review](reviews/2026-10-28-readiness-review.md); external acceptance remains pending.
- [ ] Validate Pi low-power stability and memory usage.

## P1 operations and reliability

- [ ] Job failure retry and orphan-object cleanup policies.
- [ ] Offline / crash / heartbeat tests.
- [ ] Rehearse documented D1 backup/restore and establish R2 audio backup.
- [ ] Status report with per-episode download usage.
- [ ] Monitoring and sanitized failures.
- [ ] Owner-only CLI for upload without Telegram 20MB Bot API restriction.
- [ ] Allow optional file-specific recipient permissions.
- [ ] Add explicit claim fairness and job timeout policy.
- [x] Add CI integration tests against local D1/R2 plus Pi behavioral tests.

## P2 UX

- [ ] Optional Telegram buttons.
- [ ] Optional protected owner dashboard.
- [ ] Expiring recipient tokens.
- [ ] Client/device coarse anomaly alerts.
- [ ] Cleanup retention and token rotation procedure.

Historical initial scaffolding remains in commit history, but architecture is now Telegram + Pi
importer, not yt-dlp on a Worker.
