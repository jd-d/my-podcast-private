# Operations

## Recipient status

Use Telegram `/list` for recipient counters, status and last activity.
Use `/jobs` for full import UUIDs and `/retry <uuid>` for failed imports.

This lets the owner see which private alias is behind incoming authorized traffic without placing
the alias in the public URL.

## Revoke a leaked URL

```sql
UPDATE recipients
SET status = 'revoked', revoked_at = datetime('now')
WHERE id = ?;
```

The next request using that token should return the same generic 404 as an unknown token.

## Rotate

1. Generate a fresh 32-byte token.
2. Compute its HMAC digest using the same `APP_HMAC_SECRET` and `recipient:` domain prefix.
3. Replace the recipient's `token_digest`.
4. Set `status = 'active'` and clear `revoked_at`.
5. Give the intended recipient the new feed URL.
6. Verify the old URL returns 404.

Do not keep a plaintext-token archive unless there is a clear operational need.

## Reset usage

Use `/reset <recipient-id>` in the owner chat. It clears both usage counters and
live session markers in one transaction. The next audio request consumes a new
allowance. Resetting only a counter leaves already-authorized sessions active.

For a custom per-episode reset, pause traffic and clear the matching usage and
session records in one D1 batch. Do not run partial resets against live traffic.

## Change default behavior for a recipient

```sql
UPDATE recipients
SET download_limit = 10,
    download_scope = 'episode'
WHERE id = ?;
```

Supported scopes are `episode` and `recipient`.

## Publish / unpublish

Unpublish without deleting audio:

```sql
UPDATE episodes SET is_active = 0 WHERE id = ?;
```

Republish:

```sql
UPDATE episodes SET is_active = 1 WHERE id = ?;
```

## Suspected leak

Signals can include:

- download cap reached unexpectedly;
- sudden growth in download sessions;
- repeated activity inconsistent with the intended recipient.

Response:

1. Revoke the recipient token.
2. Inspect aggregated activity and usage.
3. Decide whether to issue a new token.
4. Reset counters only after deciding the old URL is no longer trusted.
5. If the token may have appeared in logs, fix log retention before issuing another URL.

## Backups

Keep exports in an encrypted backup destination outside Git. For a local export,
create ignored `private/backups/` first, then run:

```bash
npx wrangler d1 export DB --remote --output=private/backups/database.sql
```

Exports contain private aliases, token digests, source URLs and any encrypted
pending replies. Do not print or attach the dump to CI, issues or review records.
Export blocks database requests while it runs; schedule a quiet maintenance period.
Back up `APP_HMAC_SECRET` separately through the owner's secret-management process.
R2 audio must be backed up separately; a D1 dump does not contain the audio bytes.

Restore rehearsals use a new, empty scratch database:

```bash
npx wrangler d1 execute <scratch-database-name> --remote --file=private/backups/database.sql
```

Verify schema/migration history, row counts, token behavior and matching R2 keys
against a staging Worker. Do not import a full schema dump into a populated live
database. Record the scratch test result before planning any production restore.
Cloudflare also provides Time Travel; check the account's current retention and
capture a bookmark before migrations. A production restore overwrites live state
and needs a separate approved recovery plan.

See [Cloudflare's export/import
guide](https://developers.cloudflare.com/d1/best-practices/import-export-data/)
and [Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/).

## Orphan audio and failed imports

A lost lease may leave objects under its attempt-specific prefix. Failed direct
Telegram uploads may leave an unreferenced object after an interruption. Never
infer that an object is orphaned from its age alone.

Pause imports, inventory candidate keys privately, and exclude every key referenced
by episodes or by an unexpired processing job's upload prefix. Recheck the
references immediately before any approved deletion. Configure and verify an
incomplete-multipart retention policy separately when R2 write access is available.
No automatic destructive cleanup runs in this version.

## Secret rotation and diagnostics

Rotating a recipient with `/rotate` invalidates its old link. Changing
`APP_HMAC_SECRET` invalidates all recipient digests and pending encrypted replies;
it is not an ordinary per-recipient rotation. Preserve the old secret privately
until a tested migration/reissue plan is ready. Rotate `PI_AGENT_TOKEN` on Worker
and Pi together while the agent is stopped. Rotate the webhook secret on both
Worker and Telegram registration together, preserving pending updates by default.

Worker diagnostics use fixed event names: `request_failed`,
`telegram_operation_failed`, `telegram_reply_failed` and
`telegram_orphan_cleanup_failed`. They contain no request text, exception text or
bearer paths. Keep request-path observability disabled. Pi logs identify job stage
and exception class without downloader stderr, raw URLs or S3 exception details.
Real-device diagnostics and backup/restore execution remain unverified.
