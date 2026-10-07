# Cloudflare setup

The project uses a Worker, D1 and R2.

Current Cloudflare documentation recommends Wrangler configuration in `wrangler.jsonc`. D1 migrations live in `migrations/`, and the Worker accesses R2 through a binding.

## 1. Install

```bash
npm install
npm run typecheck
npm test
```

## 2. Create D1

```bash
npx wrangler d1 create my-podcast-private-db
```

Copy the returned database UUID into the `database_id` field in `wrangler.jsonc`.

If you want EU jurisdiction/storage constraints, decide that **before** creating production resources and use the current supported Wrangler flags.

## 3. Create R2

```bash
npx wrangler r2 bucket create my-podcast-private-audio
```

Keep the bucket private. Do not enable public `r2.dev` access.

## 4. Create the HMAC secret

Generate:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

For local development, copy `.dev.vars.example` to `.dev.vars` and place the value there.

For production:

```bash
npx wrangler secret put APP_HMAC_SECRET
```

The local and production values must match if you expect recipient digests created locally to work against production D1.

## 5. Migrate D1

Local:

```bash
npm run db:migrate:local
```

Remote:

```bash
npm run db:migrate:remote
```

## 6. Generate a recipient

```bash
npm run recipient:token -- "Friend alias"
```

The script prints:

- the alias;
- a newly generated 256-bit bearer token;
- the SQL command needed to insert its digest;
- the feed URL shape.

The service intentionally cannot recover the plaintext token from D1.

## 7. Add a test episode

Until the episode CLI is implemented, upload with Wrangler and insert metadata manually.

Example:

```bash
npx wrangler r2 object put my-podcast-private-audio/episodes/test.mp3 --file ./test.mp3 --content-type audio/mpeg
```

Determine the exact file byte length locally, then insert an episode:

```sql
INSERT INTO episodes (
  id, title, description, r2_key, mime_type, byte_length, duration_seconds, published_at
) VALUES (
  'test-001',
  'Test audio',
  'First private test',
  'episodes/test.mp3',
  'audio/mpeg',
  1234567,
  NULL,
  '2026-10-07T12:00:00Z'
);
```

Execute it with Wrangler D1 against the intended database.

## 8. Run locally

```bash
npm run dev
```

Test the feed URL generated for the recipient.

## 9. Deploy

```bash
npm run deploy
```

Then subscribe using the exact private feed URL in Apple Podcasts and Overcast.

## 10. Custom domain

A custom hostname can be added later. It is not required for the security model.

If changing hostnames after recipients have subscribed, verify how each podcast client handles enclosure URLs and feed relocation before removing the old hostname.
