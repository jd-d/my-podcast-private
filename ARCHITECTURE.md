# Architecture

## Request path

```text
Apple Podcasts / Overcast
          |
          | HTTPS
          v
   Cloudflare Worker
      /          \
     /            \
   D1              R2
metadata,        private
recipients,      audio
usage
```

R2 is not a public origin. The Worker is the authorization boundary.

## Recipient token model

Each recipient gets 32 random bytes, base64url encoded.

Plaintext token:

```text
shared with recipient
        |
        v
/f/<token>/feed.xml
```

Stored value:

```text
HMAC-SHA-256(APP_HMAC_SECRET, "recipient:" + token)
```

D1 therefore does not need to retain the bearer credential itself.

## Feed

For a valid active recipient, the Worker generates RSS from active `episodes` rows.

Every enclosure points back through the Worker with that same recipient token. Consequently an enclosure remains protected by the same recipient policy.

The feed includes `itunes:block=Yes` and responses include `X-Robots-Tag: noindex, nofollow, noarchive`.

## Download accounting

Podcast clients often fetch audio using multiple byte ranges, retries and resume requests. Raw request count is therefore not a useful approximation of "downloads".

The current implementation calculates:

```text
client_digest = HMAC(secret, IP + User-Agent)
session_bucket = floor(now / 30 minutes)
```

A tuple of:

```text
recipient + episode + client_digest + session_bucket
```

is inserted once into `download_sessions`.

Only the first request for a new tuple increments the download counter. Further requests in that session are allowed without consuming another unit.

Default policy:

```text
scope = episode
limit = 5
```

A recipient can instead be configured with `download_scope = recipient` to share one total counter across all episodes.

## Why this is not identity authentication

The system identifies which **issued bearer URL** is being used. It does not prove that the human making the request is the intended recipient.

A recipient can deliberately forward their URL. The cap, activity information and revocation make such leakage containable.

## Data minimization

The service intentionally stores no raw client IP addresses.

A keyed digest of IP + User-Agent is retained temporarily in `download_sessions` and as the recipient's most recent client digest. It exists only to collapse request bursts and provide coarse evidence that a URL may be used by multiple apparent clients.

## Failure behavior

Unknown token, malformed token and revoked token should all return generic 404 responses.

A valid recipient who exceeds the configured cap receives HTTP 429 on a new audio session. Existing requests within the already-counted session remain usable so ordinary Range retries are less likely to fail.
