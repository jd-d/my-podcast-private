# PRIMARY TODO

This is the first file a coding agent should read after cloning the repository.

## Objective

Take the current scaffold to a working private podcast deployment on the owner's Cloudflare account, using the existing local Cloudflare credentials/environment.

Do not redesign the security model unless testing proves a concrete incompatibility.

## P0: provision and prove the vertical slice

1. Install dependencies:
   ```bash
   npm install
   npm run typecheck
   npm test
   ```

2. Create the Cloudflare resources if they do not already exist:
   ```bash
   npx wrangler d1 create my-podcast-private-db
   npx wrangler r2 bucket create my-podcast-private-audio
   ```

3. Replace `REPLACE_AFTER_D1_CREATE` in `wrangler.jsonc` with the real D1 database UUID returned by Cloudflare.

4. Generate a strong HMAC secret locally:
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
   ```

5. Put the same value in local `.dev.vars` as `APP_HMAC_SECRET`, then set it remotely:
   ```bash
   npx wrangler secret put APP_HMAC_SECRET
   ```

6. Apply migrations:
   ```bash
   npm run db:migrate:local
   npm run db:migrate:remote
   ```

7. Run `npx wrangler types`. If generated Worker types supersede `@cloudflare/workers-types`, migrate cleanly to Wrangler-generated types and remove the redundant dependency.

8. Create one test recipient:
   ```bash
   npm run recipient:token -- "Test friend"
   ```
   Run the generated D1 insert command. Preserve the plaintext bearer URL somewhere private because only its HMAC digest is stored.

9. Put one small MP3 into the private R2 bucket, then create its matching `episodes` row in D1. Verify `byte_length` matches the actual object size.

10. Run locally first. Confirm:
    - unknown paths return 404;
    - invalid and unknown tokens return 404;
    - the valid feed returns RSS;
    - audio is inaccessible without the recipient token;
    - Range requests return 206 and correct `Content-Range`;
    - multiple Range requests during the same session do not count as multiple downloads;
    - the sixth genuinely new download session is denied when the default limit is 5.

11. Deploy:
    ```bash
    npm run deploy
    ```

12. Subscribe to the deployed feed in **Apple Podcasts** and **Overcast** using "Follow/Add by URL". This real-client test is mandatory before calling P0 complete.

## P0: fix anything discovered by real podcast clients

The current download counter intentionally does **not** count raw GET requests. It uses a digest of Cloudflare's connecting IP + User-Agent and a 30-minute bucket to collapse Range requests/retries into one logical download session.

This is an approximation. Apple Podcasts and Overcast may issue requests in patterns that require adjustment.

Test at least:

- initial subscription;
- feed refresh;
- stream without explicit download;
- download to device;
- pause/resume;
- seek;
- re-download;
- app restart;
- second device using the same recipient URL.

Do not weaken token validation or expose R2 directly to solve client problems.

## P1: operational tooling

Build small local-only commands, not public admin HTTP routes:

- `recipient:add <alias> [limit=5] [scope=episode|recipient]`
- `recipient:list`
- `recipient:revoke <id|alias>`
- `recipient:rotate <id|alias>`
- `recipient:reset-usage <id|alias> [episode]`
- `episode:add <audio-file> --title ... [--description ...]`
  - calculate byte size automatically;
  - generate a safe episode ID;
  - upload to R2;
  - insert D1 metadata;
  - fail/rollback cleanly if one half fails;
- `episode:list`
- `episode:disable <id>`
- `status` showing alias, status, feed requests, audio requests, last access, and download usage.

These commands may call Wrangler from Node. Keep bearer tokens out of shell history where practical.

## P1: security verification

- Confirm the R2 bucket has no public `r2.dev` access and no custom public bucket domain.
- Confirm no bearer token appears in Worker logs/observability. If Cloudflare request logging captures full paths, determine how to avoid or minimize retention because the token is in the path.
- Review whether Cloudflare analytics/logging retain full request URLs for this Worker.
- Add rate limiting for repeated invalid-token probing if it can be done within the chosen plan without introducing fragility.
- Add tests for malformed Range headers and large/suffix Range requests.
- Return generic 404 for all invalid/revoked token cases.
- Ensure aliases are never written to responses or logs.
- Add a documented token rotation procedure.
- Consider separate HMAC secrets for recipient-token digests and client fingerprints if that materially improves secret rotation/operations.

## P2: UX

A tiny authenticated owner dashboard would be useful later, but **do not expose one until authentication is designed properly**.

Possible features:

- recipients with aliases;
- last activity;
- download usage;
- revoke / rotate;
- upload and publish episode;
- reset cap;
- copy feed URL only at token creation/rotation time.

Cloudflare Access may be appropriate for owner-only administration, but keep it completely separate from podcast-client feed authentication.

## Definition of done for first usable release

- One real recipient can subscribe in Apple Podcasts and Overcast.
- Recipient alias is visible only to the owner.
- Recipient has a different 256-bit bearer token from every other recipient.
- R2 objects cannot be fetched directly.
- Feed is not publicly discoverable through the service.
- RSS contains `itunes:block=Yes`.
- Search-engine headers/robots deny indexing.
- Default download limit is 5.
- Range/retry traffic does not trivially consume all 5.
- Revoking a recipient immediately makes that URL unusable.
- No secrets/audio/private recipient data are committed to Git.
