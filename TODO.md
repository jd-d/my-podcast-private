# TODO

**Canonical priority:** [PRIMARY_TODO.md](PRIMARY_TODO.md). This file is the general backlog.

## P0 validation and deployment

- [ ] Fix typecheck / CI failures, commit fixes.
- [ ] Apply migrations 0001 and 0002 and provision private R2.
- [ ] Set secrets/vars, deploy Worker, register Telegram webhook.
- [ ] Configure and start systemd service on Pi 3B+.
- [ ] Prove YouTube/M4A passthrough and FFmpeg fallback.
- [ ] Test bot admin commands, owner allowlist, direct MP3/M4A uploads and direct HTTP attacks.
- [ ] Test RSS in Apple Podcasts and Overcast, including Range and cap behavior.
- [ ] Verify private R2 permissions, logging, sensitive URL handling.
- [ ] Harden job completion lease race and download counter concurrency.
- [ ] Validate Pi low-power stability and memory usage.

## P1 operations and reliability

- [ ] Job failure retry and orphan-object cleanup policies.
- [ ] Offline / crash / heartbeat tests.
- [ ] R2 backup and D1 backup/restore.
- [ ] Status report with per-episode download usage.
- [ ] Monitoring and sanitized failures.
- [ ] Owner-only CLI for upload without Telegram 20MB Bot API restriction.
- [ ] Allow optional file-specific recipient permissions.
- [ ] Add explicit claim fairness and job timeout policy.
- [ ] CI integration tests against local D1/R2 emulator.

## P2 UX

- [ ] Optional Telegram buttons.
- [ ] Optional protected owner dashboard.
- [ ] Expiring recipient tokens.
- [ ] Client/device coarse anomaly alerts.
- [ ] Cleanup retention and token rotation procedure.

Historical initial scaffolding remains in commit history, but architecture is now Telegram + Pi importer, not yt-dlp on a Worker.
