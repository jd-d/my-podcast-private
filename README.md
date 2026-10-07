# my-podcast-private

A small self-hosted private podcast service designed for Cloudflare Workers, D1 and R2.

The core security model is **per-recipient unguessable bearer URLs**. Each friend gets a different random token. The public URL contains no name or alias. The service stores only a keyed hash of the token and maps that internally to an alias so access can be attributed and revoked without exposing identity in the URL.

## Goals

- Private RSS feeds compatible with podcast clients such as Apple Podcasts and Overcast.
- One unique 256-bit random feed token per recipient.
- Human-readable recipient alias stored only server-side.
- Private R2 bucket for audio.
- Download abuse protection with a configurable default cap of 5.
- Per-recipient revocation and token rotation.
- No public directory or browseable audio URLs.
- RSS marked private / blocked from public podcast directories and search engines.
- Minimal Cloudflare Free-tier footprint.
- No secrets, recipient data or audio committed to Git.

## Planned request shape

```text
https://<host>/f/<256-bit-token>/feed.xml
https://<host>/f/<256-bit-token>/audio/<episode-id>
```

The token is a bearer secret. Anyone possessing it can use the feed, so it must be treated like a password.

## Architecture

```text
Podcast client
     |
     | secret recipient URL
     v
Cloudflare Worker
     |
     +-- D1: recipients, episodes, access/download accounting
     |
     +-- R2: private audio objects
```

The Worker is the only public gateway. R2 must not have a public bucket URL.

## Current status

Initial implementation scaffold. See [PRIMARY_TODO.md](PRIMARY_TODO.md) for the handoff plan and [TODO.md](TODO.md) for the broader backlog.

## Quick local start

Prerequisites:

- Node.js 20+
- npm
- Wrangler authenticated against the intended Cloudflare account

Then:

```bash
npm install
cp .dev.vars.example .dev.vars
npm run typecheck
npm test
```

Cloudflare resource creation and first deployment are intentionally left to the local coding agent because the local environment already has the relevant Cloudflare credentials. Follow [docs/SETUP.md](docs/SETUP.md).

## Security

- Never commit `.dev.vars`, Cloudflare API tokens, R2 credentials, recipient bearer tokens, recipient aliases exported from production, or audio files.
- Tokens are generated with 32 random bytes and encoded as base64url.
- Only an HMAC-SHA-256 digest of the bearer token is persisted.
- Feed responses carry `X-Robots-Tag: noindex, nofollow, noarchive`.
- RSS includes `<itunes:block>Yes</itunes:block>`.
- Audio is served through the Worker after recipient validation and policy checks.

See [SECURITY.md](SECURITY.md).

## License

No open-source license has been granted yet. The repository may be publicly readable, but copyright remains with the repository owner unless a license is added later.
