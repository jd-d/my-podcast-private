# Security

## Threat model

Primary threat: an unlisted feed URL leaks and is then fetched by people other than the intended recipient.

The service reduces that risk through:

- one independent random token per recipient;
- 256 bits of token entropy;
- no recipient identity in the URL;
- HMAC-only token storage;
- per-recipient revocation/rotation;
- download/session caps;
- private R2 storage;
- no public browse/index endpoint;
- noindex headers and private-feed RSS metadata.

## What the design does guarantee

Assuming the random token is generated correctly and kept secret, guessing a valid token by brute force is computationally infeasible.

A leaked URL can be revoked independently without affecting other recipients.

R2 audio objects are intended to be inaccessible except through Worker authorization.

## What the design does not guarantee

This is not DRM and not identity authentication.

A legitimate recipient can:

- copy their feed URL;
- share downloaded audio;
- deliberately proxy content;
- share a network/User-Agent profile that weakens the usefulness of client fingerprinting.

The five-download default limits ordinary accidental leakage and casual sharing. It does not stop a determined authorized recipient from redistributing the audio after one successful download.

## Bearer-token handling

Treat feed URLs as passwords.

Never:

- paste a real feed URL into GitHub;
- put it into test fixtures;
- include it in screenshots meant for public sharing;
- expose it in analytics deliberately;
- include the alias in the URL.

Plaintext tokens are intentionally not stored in D1. If a token is lost, rotate it.

## Cloudflare logging risk

Because the bearer token is part of the request path, any infrastructure that records full request URLs could capture it.

Before production use, explicitly inspect Worker observability, request logs, analytics, third-party monitoring and error reporting. Disable or minimize any facility that retains full URLs if feasible.

Do not log `request.url`.

## R2

Keep the bucket private.

Do not enable a public `r2.dev` URL or public custom domain for the bucket. All reads must pass through the Worker.

## HMAC secret

`APP_HMAC_SECRET` must be random, at least 32 bytes of entropy, and stored as a Cloudflare Worker secret. Do not put the production value in `wrangler.jsonc`, Git, or CI logs.

Changing it invalidates every stored recipient digest, so rotation requires a migration plan.

## Download-cap caveat

The current dedupe algorithm hashes IP + User-Agent and groups requests into time buckets. That is deliberately privacy-conscious and simple, but it is heuristic.

Real Apple Podcasts and Overcast traffic must be tested before relying on the cap. If concurrency can exceed a strict limit in practice, consider a stronger serialization mechanism such as a Durable Object for accounting, but only after measuring the actual failure mode.

## Reporting

For now this repository has no public vulnerability-reporting address. Do not create a public issue containing a real feed URL, Cloudflare credential, private alias or audio file.
