# Operations

## Recipient status

Use the query in [WIKI.md](../WIKI.md) to join `recipients` with `recipient_activity`.

This lets the owner see which private alias is behind incoming authorized traffic without placing the alias in the public URL.

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

Per-episode scope:

```sql
UPDATE recipient_episode_usage
SET download_count = 0
WHERE recipient_id = ? AND episode_id = ?;
```

Recipient-wide scope:

```sql
UPDATE recipient_usage
SET download_count = 0
WHERE recipient_id = ?;
```

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

A D1 backup/export procedure still needs to be formalized. See [TODO.md](../TODO.md).
