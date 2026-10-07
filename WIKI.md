# Wiki

This file is the in-repository project wiki index.

## Core concepts

### Recipient

A person the owner wants to share audio with. D1 stores a private human-readable `alias` and the HMAC digest of that person's bearer token.

The alias never appears in the public URL.

### Bearer feed URL

A recipient receives a URL shaped like:

```text
https://<host>/f/<43-char-base64url-token>/feed.xml
```

The token is 32 cryptographically random bytes encoded as base64url, about 256 bits of entropy. Possession of this URL grants access.

### Episode

An audio item represented by metadata in D1 and a private object in R2.

The RSS enclosure URL contains the same recipient token:

```text
https://<host>/f/<token>/audio/<episode-id>
```

This prevents the feed from exposing a second predictable public R2 URL.

### Download limit

Default: **5**.

Current default scope: **per recipient, per episode**.

The Worker counts a logical download session, not every HTTP request. Requests from the same hashed IP + User-Agent + episode within a 30-minute window are deduplicated. This is specifically intended to tolerate Range requests, retries and resume behavior.

This should be treated as abuse containment, not DRM.

### Revocation

Set a recipient's status to `revoked`. The bearer URL should immediately become indistinguishable from an unknown URL.

### Rotation

Create a new token/digest for the same recipient, replace the stored digest, and give the recipient the new feed URL. The old URL then stops working.

## Useful owner queries

Recent recipient activity:

```sql
SELECT
  r.id,
  r.alias,
  r.status,
  r.download_limit,
  r.download_scope,
  COALESCE(a.feed_requests, 0) AS feed_requests,
  COALESCE(a.audio_requests, 0) AS audio_requests,
  a.last_feed_at,
  a.last_audio_at
FROM recipients r
LEFT JOIN recipient_activity a ON a.recipient_id = r.id
ORDER BY r.alias;
```

Per-episode usage:

```sql
SELECT
  r.alias,
  e.title,
  COALESCE(u.download_count, 0) AS downloads,
  r.download_limit
FROM recipients r
CROSS JOIN episodes e
LEFT JOIN recipient_episode_usage u
  ON u.recipient_id = r.id
 AND u.episode_id = e.id
WHERE e.is_active = 1
ORDER BY r.alias, e.published_at DESC;
```

Revoke:

```sql
UPDATE recipients
SET status = 'revoked', revoked_at = datetime('now')
WHERE id = ?;
```

Reset one recipient/episode counter:

```sql
UPDATE recipient_episode_usage
SET download_count = 0
WHERE recipient_id = ? AND episode_id = ?;
```

## Navigation

- [README](README.md)
- [Primary TODO](PRIMARY_TODO.md)
- [General TODO](TODO.md)
- [Architecture](ARCHITECTURE.md)
- [Security](SECURITY.md)
- [Setup](docs/SETUP.md)
- [Operations](docs/OPERATIONS.md)
