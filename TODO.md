# TODO

## Now

- [ ] Complete every P0 item in [PRIMARY_TODO.md](PRIMARY_TODO.md).
- [ ] Run `npm install`, `npm run typecheck`, and `npm test` locally.
- [ ] Provision D1 + R2 and replace the D1 placeholder ID.
- [ ] Apply migration 0001.
- [ ] Set `APP_HMAC_SECRET` as a Wrangler secret.
- [ ] Publish one small test MP3 and matching episode row.
- [ ] Test Range behavior locally.
- [ ] Deploy and test subscription/download in Apple Podcasts.
- [ ] Test subscription/download in Overcast.
- [ ] Verify the five-download policy behaves sensibly in both clients.

## Security / privacy

- [ ] Verify R2 public access is disabled.
- [ ] Audit Cloudflare logs/analytics for bearer-token URL leakage.
- [ ] Decide retention policy for any request metadata.
- [ ] Add invalid-token rate limiting if worthwhile.
- [ ] Add token rotation tooling.
- [ ] Add download-cap reset tooling.
- [ ] Document incident response for a leaked recipient URL.
- [ ] Decide whether download limit default should remain per-episode or become per-recipient.
- [ ] Evaluate whether client fingerprint should use a rotating server-side salt or separate HMAC secret.

## Operations

- [ ] Add recipient management CLI.
- [ ] Add episode upload/publish CLI.
- [ ] Add owner status/report command.
- [ ] Add backup/export procedure for D1 metadata.
- [ ] Add restore procedure.
- [ ] Add R2 object lifecycle policy if old audio should expire.
- [ ] Add a safe way to replace an audio object without breaking existing episodes.

## Feed quality

- [ ] Add optional private artwork handling.
- [ ] Confirm Apple Podcasts accepts the minimum feed shape.
- [ ] Confirm Overcast accepts the minimum feed shape.
- [ ] Add explicit feed/category/language configuration if needed.
- [ ] Validate RSS against current podcast tooling.
- [ ] Decide whether individual recipients should be able to see different subsets of episodes.

## Testing

- [ ] Worker integration tests with D1/R2 bindings.
- [ ] Revoked-recipient tests.
- [ ] Download-limit concurrency tests.
- [ ] Range request tests.
- [ ] RSS escaping tests for real episode metadata.
- [ ] Test token rotation and old-token rejection.
- [ ] Test scheduled cleanup.

## Later

- [ ] Owner-only dashboard, if CLI becomes inconvenient.
- [ ] Recipient-specific episode permissions.
- [ ] Expiring recipient links.
- [ ] Optional total-byte quota in addition to session/download count.
- [ ] Optional alerts when a recipient hits the cap.
