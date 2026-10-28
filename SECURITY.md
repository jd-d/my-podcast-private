# Security model and open risks

## Current model

Each recipient gets an independent 256-bit random bearer token. The public URL contains no alias and is not discoverable by sequential enumeration. HMAC-SHA-256 stores a digest of the token in D1. The private R2 bucket is accessed only via the authorized Worker for playback; the Pi has separate bucket-scoped write access for imports.

Telegram administration requires both an authenticated webhook secret and matching numeric owner user/chat ID, in a private chat. The Pi API uses an independent `PI_AGENT_TOKEN`, short-lived random job leases, and R2 object validation before publication.

No public admin dashboard or inbound Pi port is required.

## Boundaries

A bearer URL proves possession of the secret, **not human identity**. Sharing, forwarding, cached copies, and already-downloaded files cannot be prevented. Five session counts are not five guaranteed unique human downloads. Network clients, podcast infrastructure and Telegram may receive secret feed URLs.

The Pi can receive arbitrary published YouTube URLs from the owner, restricted to HTTPS YouTube hosts for the MVP; only download/share media you have rights to.

## Required validation

- **P0**: test concurrent download sessions and loss-of-connectivity cases; charged markers mitigate one quota bypass, but counting is still heuristic and several D1 calls are involved.
- **P0**: verify job lease expiry/race behavior with integration tests. The transactional conditional transition and changed-row checks are implemented.
- **P0**: verify Worker/Cloudflare observability does not store full bearer URLs; currently observability is disabled by default.
- **P0**: verify Telegram retry/at-least-once delivery behavior does not unexpectedly skip failed updates after deduplication.
- **P0**: ensure R2 bucket has no public URL, use bucket-scoped credentials for the Pi, and review R2 credentials rotation procedures.
- **P0**: test Range, HEAD, malformed Range and concurrent clients in Apple Podcasts/Overcast.
- **P0**: verify only intended owner's Telegram user and private chat can run commands.

## Credential locations

| Credential | Location |
|---|---|
| APP_HMAC_SECRET | Worker secret + local .dev.vars |
| TELEGRAM_BOT_TOKEN | Worker secret + local .dev.vars |
| TELEGRAM_WEBHOOK_SECRET | Worker secret + local .dev.vars |
| TELEGRAM_OWNER_USER_ID | Worker var or secret |
| PI_AGENT_TOKEN | Worker secret + Pi root-owned environment file |
| R2 S3 access key and secret | Pi root-owned environment file only |
| PUBLIC_BASE_URL | Worker var + local .dev.vars |

These values must never appear in GitHub, public issues, build logs or screenshots.

## Browser and podcast privacy

Private feed links are bearer passwords and may appear in client support diagnostics, URL history, reverse-proxy access logs or server observability. Enforce `Referrer-Policy: no-referrer` and `Cache-Control: private, no-store` for sensitive content; verify upstream logging policies.

The feed sets `itunes:block=Yes` and index-blocking headers, but discovery prevention is not a substitute for token authorization.

## Do not overclaim

Until real-device tests pass, do not call the service production-ready or the download cap exact. The Pi does not evade YouTube rate limits or restrictions.
