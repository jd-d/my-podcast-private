# Deployment and security readiness review

Reviewed at 2026-10-28T02:48:46Z against main commit
`aedc9d0f9b550c2aeae71ee4dd1b35341b7e6a00`.

## Verdict

The final architecture is implemented, but deployment should wait for the
playback and recovery defects below. Passing CI does not establish production
readiness. No cloud resources, Telegram configuration, credentials or Pi
installation were changed during this review.

## Verified evidence

- GitHub main matches the local commit. Its CI run passed:
  [Actions run 40617807962](https://github.com/jd-d/my-podcast-private/actions/runs/40617807962).
- Local TypeScript check and all 15 existing tests pass. Python source parses
  successfully. Wrangler 4.154.0 builds the Worker in deployment dry-run mode.
- All three migrations apply successfully in local Miniflare D1.
- Synthetic local D1/R2 probes confirm normal GET/HEAD, revoked-token 404,
  claim/heartbeat/completion, repeated completion 409 and stale heartbeat 409.
- Eight concurrent same-client GETs all returned 200 and consumed one allowance.
  This is one successful scenario, not comprehensive race coverage.
- Runtime probes used Miniflare 5.20261023.1-beta and synthetic data only.
  Findings still need confirmation on deployed Workers and real clients.

## Cloudflare access

The existing environment contains a Cloudflare account ID and API token.
Read-only API checks verified the token is active and can list D1 databases,
R2 buckets, Workers and the Workers subdomain in the configured account.
No matching project resources were found in the returned inventories.

Reading the token policy established these relevant grants:

| Capability | Existing permission | Assessment |
| --- | --- | --- |
| Workers deployment and configuration | Workers Scripts Write | Granted |
| D1 provisioning and migrations | D1 Write | Granted |
| R2 inspection | Workers R2 Storage Read | Granted |
| R2 bucket creation and configuration | Workers R2 Storage Write | Missing |
| Creating additional API credentials | API Tokens / Account API Tokens Read only | No creation grant |

The account policy currently includes all accounts. Prefer restricting any new
deployment token to the intended account. A minimal deployment credential needs
Workers Scripts Write, D1 Write, Workers R2 Storage Write and the account read
permissions Wrangler requires. Dashboard labels can use Edit instead of Write.
Using workers.dev avoids needing custom-domain DNS or zone-route permissions.

The owner must either adjust the existing token's R2 permission or provide a
separate account-scoped deployment token through the local environment. Creating
the bucket manually is another option, but its privacy configuration must still
be verified. Do not grant token-creation privileges merely for convenience.

The Pi separately needs R2 S3 credentials restricted to the audio bucket, with
Object Read & Write permission. These are not the deployment API token. Current
credentials do not have permission to mint these automatically; create them in
the Cloudflare dashboard unless a separately approved credential can do so.

References:
[Cloudflare permissions](https://developers.cloudflare.com/fundamentals/api/reference/permissions/)
and [R2 authentication](https://developers.cloudflare.com/r2/api/tokens/).

## Findings to fix before deployment

### F1 - High: invalid Range response headers break playback

Location: `src/index.ts:254-266`.

With a ten-byte R2 object, `Range: bytes=0-3` returns four bytes and status 206,
but `Content-Range: bytes NaN-NaN/10`. A suffix request also produces NaN.
Temporary diagnostic instrumentation shows `"suffix" in object.range` is true
inside the Worker even when the serialized range is `{offset:0,length:4}`:
the optional property exists with an undefined value. Checking property presence
therefore chooses the wrong branch. The Node-side R2 proxy omits that property,
which can conceal the bug in tests outside the Worker runtime.

`bytes=999-` and `bytes=garbage` also returned 206 with the full ten-byte body and
invalid range metadata. Validate ranges explicitly; generate headers from finite
numeric values and actual object size; return 416 for unsatisfiable ranges.
Define deliberate malformed/multiple-range and If-Range behavior. Add runtime
integration tests before trying Apple Podcasts or Overcast.

### F2 - High: lease loss does not stop the Pi; retries can overwrite audio

Locations: `pi/worker.py:144-152`, `pi/worker.py:118`, `src/agent.ts:35-43`.

The HTTP client raises HTTPError on a 409 heartbeat. The heartbeat catches all
exceptions and only logs a warning, so its lost-lease flag is never set for that
response. A targeted probe confirmed HTTP 409 leaves the flag false. Prolonged
network failure likewise has no local lease deadline that prevents upload.

The old attempt can continue downloading and uploading after its lease expires.
If another agent instance reclaims the job, both use the same R2 key. A stale
uploader can overwrite the winning attempt's object even though its subsequent
completion request is rejected. The D1 transaction cannot fence the S3 write.

Treat definitive lease rejection as terminal, track a conservative renewal
deadline, and prevent stale publication with attempt-specific immutable object
keys. Add interruption/reclaim/upload-race tests. Enforce or document the single
agent process assumption; the claim API can lease different jobs to multiple
callers.

### F3 - Medium: allowance accounting can deny valid playback

Locations: `src/index.ts:221-245`, `src/index.ts:279-350`, `src/lib.ts:23-25`.

The quota is charged before R2 lookup and range validation. Missing objects,
failed R2 requests and invalid ranges can consume an allowance without usable
audio. A failure between the counter increment and counted-marker update can
also leave a charged but unusable session.

Sessions use fixed wall-clock buckets. Requests one second apart across a bucket
boundary consume separate allowances; a long play can consume multiple. In the
opposite direction, repeated full downloads with the same IP/UA inside a bucket
consume one allowance. Existing sessions are denied after the final bucket ends,
even if the listener is only resuming. These are semantic limits, not proof of a
new identity-based bypass. Decide the intended policy, then test independent
clients at the cap, boundary crossing, backend failure and counter reset races.

### F4 - Medium: Telegram deduplication loses failed commands or replies

Locations: `src/telegram.ts:51-65`, `src/telegram.ts:95-100`,
`src/telegram.ts:128-132`.

The update is marked processed before the operation and reply succeed. A crash,
D1/R2 failure or Telegram send failure suppresses Telegram's replay. If /add or
/rotate commits but its reply is lost, the plaintext feed token cannot be
recovered; the owner must rotate again. Direct uploads can leave orphan objects.
Use explicit operation state and recovery semantics without storing plaintext
recipient tokens in D1. The current error reply suggests checking sanitized logs,
but that catch records no diagnostic event.

### F5 - Medium: documented Node runtime alternative is not enabled

Location: `pi/worker.py:77-86`, `docs/PI_SETUP.md:11`.

The importer uses --ignore-config and never passes --js-runtimes node. Installing
Node 22 alone therefore does not implement the documented alternative to Deno.
The [official EJS guide](https://github.com/yt-dlp/yt-dlp/wiki/EJS) requires explicit
Node enablement; only Deno is enabled by default. Configure the runtime explicitly
and test it as the sandboxed systemd user. Verify an ARM-compatible binary on the
actual Pi; do not assume a default installer supplies one.

### F6 - Medium: asynchronous failures escape the intended error handler

Locations: `src/index.ts:48-51`, `src/index.ts:86-99`.

The fetch try/catch returns several promises without awaiting them. Rejections
inside those handlers escape its generic 500 response and logging policy. A
synthetic audio-backend failure reproduced this. Await handler completion inside
the catch boundary and emit fixed, sanitized diagnostic fields. Also remove raw
exception logging at line 99 before relying on a no-secret logging policy.
No actual credential disclosure was demonstrated in this review.

## Additional reliability and maintenance gaps

- `pi/worker.py:101-110`: the configured size cap is checked before transcoding,
  but not on the converted file. Low-bitrate input can produce much larger output;
  there is no duration cap or disk reservation. Bound conversion output and time,
  validate positive configuration values and measure memory/disk under load.
- `src/telegram.ts:155-166`: /jobs and failure notifications show eight-character
  IDs, while /retry requires a full UUID. The original queued message contains it,
  but recovery is awkward. Show full IDs or implement unambiguous prefix lookup.
- `scripts/set-telegram-webhook.mjs:21`: every registration drops pending updates.
  Make that an explicit first-install/recovery choice to avoid losing commands.
- `docs/PI_SETUP.md:22`: an unauthenticated HTTPS clone of this private repository
  will not work on a fresh Pi. Use a deployment archive or explicitly scoped
  read-only checkout credential; avoid copying broad GitHub credentials.
- Dependency versions float and there is no committed package lock. CI uses npm
  install, not npm ci, so reruns can test different transitive versions. The review
  resolved versions newer than the package.json minima. Pin a reviewed lockfile.
- No Python behavioral tests or D1/R2 integration tests run in CI. The 15 tests
  exercise helpers and early unauthenticated routes, not successful publication,
  owner authorization with a valid webhook secret, quotas or audio Range delivery.
- `TODO.md` still mentions only migrations 0001/0002. All three are required.
- `docs/OPERATIONS.md` reset SQL leaves session markers intact, unlike Telegram
  /reset. Document consistent reset semantics. Rotation of APP_HMAC_SECRET also
  invalidates every token digest; define backup and recovery before operation.
- Formalize D1 restore, R2 orphan/multipart cleanup, dependency updates, bounded
  retry policy and sanitized failure visibility. Observability is disabled in the
  config, but actual path retention and third-party feed handling remain untested.
- Request body limits trust Content-Length instead of counting received bytes;
  malformed authenticated JSON is not schema-validated. Lower priority because
  the relevant endpoints already require privileged secrets.

## What is already sound in the inspected source

Recipient tokens use 32 random bytes and HMAC-only storage. SQL values are bound,
RSS text is XML-escaped, the Telegram handler checks secret plus numeric owner
and private-chat IDs, and unauthenticated agent requests fail closed. The Pi uses
subprocess argument lists rather than shell commands. The architecture supports
outbound-only Pi traffic and private R2 binding access. These strengths do not
replace deployment/runtime validation or guarantee freedom from vulnerabilities.

## Remaining execution order and owner inputs

1. Fix F1-F6 and add focused runtime regression coverage; lock dependencies.
2. Resolve R2 provisioning access and select/confirm the intended account.
3. Provision private R2 and D1, apply all three migrations, set actual database
   ID, origin and independent Worker secrets, then deploy and verify privacy.
4. Supply BotFather token and numeric Telegram owner ID through private local
   configuration; register the webhook and test all owner/non-owner cases.
5. Identify the intended Pi, SSH host/user/access, current OS/architecture and
   current workload. Do not reimage or repurpose an existing device implicitly.
   Install the service only after an inventory and approved installation plan.
6. Generate separate bucket-scoped Pi S3 credentials and random shared agent
   token. No owner-supplied APP_HMAC_SECRET or random webhook secret is needed;
   these can be generated during setup.
7. Obtain a permitted short YouTube test URL, test direct Telegram audio, AAC
   passthrough, transcoding, outage/reboot recovery, lease expiry and concurrency.
8. Have the owner test Apple Podcasts and Overcast: subscription, seeking,
   playback, resume, sixth-session denial, rotation and revocation. Define the
   accepted cap semantics and document remaining limitations.

This review changed documentation only. Application fixes, deployment, secret
changes and Pi installation remain subsequent work. README behavior is unchanged
and does not require an update for the review itself.
