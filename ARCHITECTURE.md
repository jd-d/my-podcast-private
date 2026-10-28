# Final architecture (2026-10)

```text
Your Telegram private chat
        | webhook HTTPS
        v
Cloudflare Worker (owner ID + webhook secret enforced)
        |               ^
        | register job  | status / completion
        v               |
D1 import_jobs     Pi 3B+ importer
                        ^ |
             outbound polling |
                        | v
             yt-dlp + FFmpeg (audio-only)
                        |
                        | R2 S3 API using bucket-limited credentials
                        v
                  Private R2 bucket
                        ^
                        | R2 binding, validated recipient token
                        |
Cloudflare Worker RSS/audio gateway
        ^
        |
Apple Podcasts / Overcast
(per-friend 256-bit secret RSS URL)
```

## Why use a local Pi

It removes monthly downloader VPS costs and usually uses a residential ISP IP instead of a cloud
data-center IP. It is not guaranteed to avoid YouTube rate limits, account challenges, or changing
extractor behavior.

## Bot interface

The Telegram webhook is `POST /telegram`. The server checks `X-Telegram-Bot-Api-Secret-Token`, then
verifies the sender and chat match `TELEGRAM_OWNER_USER_ID` and chat type is `private`. Commands
never expose raw token aliases in public endpoints. The bot may send recipient URLs to its owner in
Telegram, which is **not an end-to-end encrypted bot chat**.

## Job protocol

- `POST /agent/claim`: independent PI_AGENT_TOKEN authorization. Atomic D1 UPDATE claims one pending
  or expired-lease job. Returns the YouTube URL plus random lease.
- `POST /agent/jobs/:uuid/heartbeat`: renew 30-minute lease.
- `POST /agent/jobs/:uuid/complete`: verify lease, check exact R2 object exists and is nonempty,
  record episode in D1.
- `POST /agent/jobs/:uuid/fail`: mark failed with sanitized, short error.
- Jobs are persistent. The Pi needs **no inbound network access**.
- Do not retry completed or failed jobs automatically. Explicit `/retry <uuid>` requeues a failed
  job.

## R2 transport

The Pi does not send large audio through the Worker. It uses R2's S3-compatible endpoint directly,
with its own scoped credentials. It stores at `imports/<job-id>/<attempt-id>/audio.m4a` or
`audio.mp3`, then notifies the Worker. The Worker reads the object through the private R2 binding.

## Listening

Every recipient gets `/f/<256-bit-token>/feed.xml` and `/f/<token>/audio/<episode-id>`. The Worker
validates token HMAC and tracks usage. `itunes:block=Yes` prevents Apple directory submission, and
HTTP headers discourage indexing. There is no directory listing.

## Accuracy boundaries

The current download-session counter groups same IP + user-agent + episode within a sliding
30-minute inactivity window. This is a **heuristic**, not actual downloaded-file counts; has
transactional local concurrency coverage and still needs field tests. The bearer link proves
knowledge of a secret URL, not recipient identity.

## Recovery and consistency

A D1 batch creates or extends a download session and charges new sessions
atomically. R2 availability and single-range validation precede charging. A
successful authorization does not prove the client received or saved the body.

Each Pi lease receives a distinct upload namespace. The Pi uses a conservative
local renewal deadline, cancels tools on lease loss and checks the lease during
S3 transfer. Old objects may need cleanup, but cannot replace the winning key.

Telegram command mutations and an encrypted reply outbox commit together under
a unique update ID. Retries replay the saved reply. Replies are decrypted only
for delivery and cleared after acknowledgment; duplicate replies are possible
after an ambiguous Telegram send result. External R2 uploads cannot participate
in the D1 transaction, so interrupted uploads may leave orphan objects.
