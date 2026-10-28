# Runtime hardening execution record

Started at 2026-10-28T02:53:02Z after the
[readiness review](2026-10-28-readiness-review.md). Work is on
`codex/harden-podcast-runtime`; deployment and real-device acceptance are separate.

## Changes

- F1: explicit single-range parsing, finite headers, 416 rejection, strong ETag
  If-Range handling, and actual R2 size/conditional reads.
- F2: lease-specific object prefixes, terminal heartbeat rejection, conservative
  local expiry, subprocess cancellation, upload callbacks and one-process lock.
- F3: sliding inactivity sessions and quota charging in one D1 transaction,
  after range/R2 validation. Counter resets remove session markers atomically.
- F4: authenticated encrypted replies commit with command effects under unique
  Telegram update IDs. Send failures replay the reply without repeating effects.
  Ciphertext is cleared after delivery. Operation IDs prevent ambiguous commit
  recovery from deleting a winning direct-upload object.
- F5: explicit Deno/Node runtime arguments and startup version checks.
- F6: awaited handler boundaries and fixed diagnostic events; no raw exceptions.
- Additional fixes: conversion output/disk limits, full job IDs, explicit opt-in
  for dropping Telegram pending updates, real body-size limits and JSON validation.
- Dependency lockfile, npm ci, unit/runtime/Pi tests and Markdown lint in CI.
  The linter's run-con dependency stays at 1.3.2 for Node 22.14 compatibility.
- Private source archive installation, coordinated upgrades, secret rotation,
  backup/restore and nondestructive orphan-recovery instructions.

## Database and upgrade contract

Apply migrations 0001 through 0006. Migration 0004 preserves counters and usable
charged legacy sessions, using a 30-minute transition window. Migration 0005
adds a fresh upload prefix to each claim; old Pi agents cannot complete jobs
against the updated Worker. Migration 0006 adds the encrypted reply outbox.
Stop the Pi and pause live traffic for a coordinated upgrade.

No raw recipient bearer token is stored in D1. Pending encrypted replies require
both D1 access and APP_HMAC_SECRET to decrypt. Keep that secret backed up privately;
rotating it invalidates existing token digests and pending replies.

## Validation

Local checks include TypeScript, Markdown lint, Python syntax and a Wrangler
deployment dry run. Wrangler's local migration runner applied all six migrations.
The initial Linux CI run caught a Windows lockfile missing TypeScript's Linux
optional binary; the lock was regenerated from an empty directory, preserving
the reviewed direct versions and including both platform binaries.
The suites contain 17 unit tests, 20 local Worker/D1/R2
integration tests, and 12 Pi behavioral tests. Integration fixtures use synthetic
credentials/audio and mocked Telegram networking; no listener content is sent.

The integration suite exercises exact Range lengths, malformed ranges, HEAD,
If-Range, same-client concurrency, independent-client cap enforcement, inactivity
expiry, recipient-wide scope, rollback, reset, RSS, token rotation/revocation,
owner/group authorization, duplicate updates, encrypted reply retry, direct audio,
stale leases, request-size limits and populated legacy migration upgrades.

The Pi suite verifies URL restrictions, heartbeat rejection/expiry, cancellation,
runtime selection/version, AAC-container passthrough, conversion size rejection,
disk checks, attempt-specific upload keys and loss of lease before upload.

## Remaining limits

An authorized transfer can consume allowance even if the client disconnects.
Repeated requests from the same apparent client renew its inactivity session;
this remains a heuristic, not identity enforcement or a completed-file meter.
Telegram may duplicate a reply after an ambiguous send, and its retry window is
finite. Interrupted external uploads may leave orphan objects. No automatic
destructive cleanup has been added.

Cloudflare R2 write access, Pi S3 credentials, BotFather token, numeric owner ID,
intended Pi access/current-workload inventory and a permitted YouTube URL remain
setup inputs. Real deployment privacy/logging, backups/restores, Pi ARM/runtime/
power behavior, extraction, outage recovery and podcast-client acceptance remain
unverified. See [PRIMARY_TODO](../PRIMARY_TODO.md) for the execution checklist.
