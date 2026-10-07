# Agent instructions

## Read first

1. [PRIMARY_TODO.md](PRIMARY_TODO.md)
2. [ARCHITECTURE.md](ARCHITECTURE.md)
3. [SECURITY.md](SECURITY.md)
4. [docs/SETUP.md](docs/SETUP.md)

## Project intent

This is a small private podcast-sharing service, not a public podcast platform.

The owner creates recipient records using private aliases such as "friend A". Each recipient receives a unique 256-bit random bearer URL. The alias must never be included in that URL.

The Worker validates the bearer token, serves recipient-specific RSS, proxies audio from a non-public R2 bucket, and enforces a configurable download/session cap.

## Hard constraints

- Do not make R2 public.
- Do not replace unguessable per-recipient tokens with sequential IDs.
- Do not store plaintext recipient bearer tokens in D1.
- Do not put recipient aliases into URLs.
- Do not log plaintext tokens or raw IP addresses intentionally.
- Do not create a public admin API.
- Do not commit `.dev.vars`, account credentials, audio, aliases exported from production, or generated bearer links.
- Invalid, revoked and unknown tokens should look the same externally.
- Preserve HTTP Range support.
- Do not count every Range request as a separate download.
- Prefer Cloudflare Free-tier-compatible primitives and low write volume.
- Use the existing local Cloudflare authentication/environment rather than adding long-lived Cloudflare credentials to this repository.

## Development approach

Make the smallest testable change. Run typecheck and tests before committing.

For Cloudflare configuration, verify current official docs before changing binding syntax or resource commands because Wrangler evolves quickly.

Use D1 migrations for every schema change.

If strict download-cap concurrency becomes difficult in D1, document the exact race before introducing a Durable Object or another primitive. Do not add architecture merely for theoretical elegance.

## Privacy model

A token is a bearer credential. The system proves possession of the URL, not the human identity of the person using it.

The alias is the owner's label for the token.

Client fingerprinting is for deduplicating podcast-client Range/retry behavior and spotting broad link sharing. It is not identity verification.

## Commit hygiene

- Keep commits narrowly scoped.
- Update TODOs when work is completed or new gaps are found.
- Never paste production bearer URLs into issues, commits, test fixtures or logs.
- Use fake tokens in tests.
