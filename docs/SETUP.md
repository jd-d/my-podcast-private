# Cloudflare setup for final Telegram + Pi design

**Read [PRIMARY_TODO](../PRIMARY_TODO.md) before deploying.** This file supersedes the initial RSS-only setup description.

Use existing Cloudflare authentication on the local dev machine.

## Provision Cloudflare

```bash
npm install
npm run typecheck && npm test
npx wrangler whoami
npx wrangler d1 create my-podcast-private-db
npx wrangler r2 bucket create my-podcast-private-audio
```

If a resource already exists, reuse it. Replace `REPLACE_AFTER_D1_CREATE` in `wrangler.jsonc` with the returned D1 UUID and keep the R2 bucket name accurate. Verify the R2 bucket has **no public `r2.dev` hostname or custom domain**.

```bash
npm run db:migrate:local
npm run db:migrate:remote
```

Both migrations `0001_initial.sql` and `0002_import_jobs.sql` are required.

## Create independent Worker secrets

Generate each with a cryptographically secure RNG:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Never reuse a generated value across purposes. Set these secrets with Wrangler:

```bash
npx wrangler secret put APP_HMAC_SECRET
npx wrangler secret put PI_AGENT_TOKEN
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
```

`TELEGRAM_OWNER_USER_ID` and `PUBLIC_BASE_URL` can be standard Worker variables, but they need correct values. Populate `wrangler.jsonc` vars or use secret bindings for them. All must be available at runtime.

Keep a local `.dev.vars` copied from `.dev.vars.example` for local testing and the `npm run telegram:webhook` script. Do **not** commit the real file. `APP_HMAC_SECRET` must match between a local token-generation script and the deployed Worker if you are using that local script.

## Deploy

```bash
npm run deploy
```

Set `PUBLIC_BASE_URL` to the final Worker origin. You can use `*.workers.dev` at first. Do not confuse this with the R2 bucket endpoint.

Register Telegram:

```bash
npm run telegram:webhook
```

Follow [Telegram instructions](TELEGRAM.md).

## Pi authentication and R2

Use the same `PI_AGENT_TOKEN` value in the Pi's root-owned env file. Create *separate* R2 API S3 credentials scoped to this private bucket for the Pi. **Do not** give the Pi the full account Cloudflare API token.

Follow [Pi instructions](PI_SETUP.md).

## Smoke test

1. Request `/robots.txt` from the Worker.
2. Unknown private feed URL returns 404.
3. The bot responds to owner `/help`.
4. `/add Test Friend` returns a unique RSS URL in the owner's private bot chat.
5. Non-owner Telegram messages cannot create recipients.
6. `/import <YouTube URL>` queues a job.
7. Start Pi agent; observe job claim, download, R2 upload and publish notification.
8. Subscribe to the feed in Apple Podcasts or Overcast.
9. Validate playback, seek, download cap, rotation, revocation and privacy.

## Deployment safety

Current source implementation still has P0 race/behavior checks described in [PRIMARY_TODO](../PRIMARY_TODO.md). Do not publish sensitive audio before those tests are complete.

Avoid enabling Worker observability that stores feed URL paths, because the path includes a bearer secret.
