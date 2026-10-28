# Security model and open risks

## Current model

Each recipient gets an independent 256-bit random bearer token. The public URL contains no alias and
is not discoverable by sequential enumeration. Recipient rows store only HMAC-SHA-256 token digests.
Pending owner replies use
a purpose-derived AES-GCM key and random nonces to encrypt the complete reply in
D1. The encrypted reply commits with command effects, can be replayed after a
send failure, and is cleared after delivery. Access to both the database and
`APP_HMAC_SECRET` would expose pending replies; protect and back up the secret. The private R2
bucket is accessed only via the authorized Worker for playback; the Pi has separate bucket-scoped
write access for imports.

Telegram administration requires both an authenticated webhook secret and matching numeric owner
user/chat ID, in a private chat. The Pi API uses an independent `PI_AGENT_TOKEN`, short-lived random
job leases, and R2 object validation before publication.

No public admin dashboard or inbound Pi port is required.

## Boundaries

A bearer URL proves possession of the secret, **not human identity**. Sharing, forwarding, cached
copies, and already-downloaded files cannot be prevented. Five session counts are not five
guaranteed unique human downloads. Network clients, podcast infrastructure and Telegram may receive
secret feed URLs.

The Pi can receive arbitrary published YouTube URLs from the owner, restricted to HTTPS YouTube
hosts for the MVP; only download/share media you have rights to.

## Implemented hardening and remaining validation

- Quota charging, session insertion and sliding inactivity renewal share a D1
  transaction. Invalid ranges and missing R2 objects do not consume allowance.
- Sessions approximate recipient + IP + UA + episode activity. Repeated complete
  downloads may remain one session while active. Transfer interruption after
  authorization can consume allowance; this is not a completed-download meter.
- Single byte ranges have explicit finite offsets/lengths. Invalid, multiple or
  unsatisfiable ranges return 416. If-Range supports matching strong ETags;
  unsupported dates and weak tags fall back to a full response.
- Each job claim has its own R2 upload namespace. Stale lease holders cannot
  overwrite the key referenced by the new attempt's published episode.
- The Pi cancels subprocesses on lease loss and stops trusting a lease after its
  conservative local deadline. Its S3 callback checks ownership during upload.
- Telegram mutations and encrypted replies commit together. Failed sends return
  503 for replay without repeating effects. An ambiguous send can duplicate a
  reply; interrupted external R2 operations can leave orphan objects.
- Request body sizes are counted while reading, even without Content-Length.
  API inputs reject null/array JSON and invalid lease types.
- Worker exceptions are caught across asynchronous handlers. Logs contain fixed
  event names rather than raw exceptions, request paths or private metadata.
- Local runtime tests cover these paths, actual D1 transactions, fresh/upgrade
  migrations, concurrency, authorization, direct upload and retry behavior.
- **Still required:** deployed Cloudflare privacy/logging checks, real Pi runtime
  and power tests, real YouTube extraction, and Apple Podcasts/Overcast playback,
  seeking, quota, network-change and outage acceptance.
- **Still required:** bucket privacy, bucket-scoped Pi credentials, verified
  multipart cleanup, backup/restore rehearsal and rotation procedures in operation.

## Credential locations

| Credential | Location |
| --- | --- |
| APP_HMAC_SECRET | Worker secret + local .dev.vars |
| TELEGRAM_BOT_TOKEN | Worker secret + local .dev.vars |
| TELEGRAM_WEBHOOK_SECRET | Worker secret + local .dev.vars |
| TELEGRAM_OWNER_USER_ID | Worker var or secret |
| PI_AGENT_TOKEN | Worker secret + Pi root-owned environment file |
| R2 S3 access key and secret | Pi root-owned environment file only |
| PUBLIC_BASE_URL | Worker var + local .dev.vars |

These values must never appear in GitHub, public issues, build logs or screenshots.

## Browser and podcast privacy

Private feed links are bearer passwords and may appear in client support diagnostics, URL history,
reverse-proxy access logs or server observability. Enforce `Referrer-Policy: no-referrer` and
`Cache-Control: private, no-store` for sensitive content; verify upstream logging policies.

The feed sets `itunes:block=Yes` and index-blocking headers, but discovery prevention is not a
substitute for token authorization.

## Do not overclaim

Until real-device tests pass, do not call the service production-ready or the download cap exact.
The Pi does not evade YouTube rate limits or restrictions.
