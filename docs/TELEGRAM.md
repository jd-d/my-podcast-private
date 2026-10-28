# Telegram bot setup

## Owner preparation

1. Open a private conversation with Telegram's verified **@BotFather** account.
2. Create a bot via `/newbot`; save its Bot API token as a secret.
3. Find your **numeric Telegram user ID** (not username). Verify it carefully from a trusted `getUpdates` response or reputable user-ID helper.
4. Open a private chat with the new bot and send `/start`.

## Worker configuration

Local-only `.dev.vars` plus Cloudflare Wrangler secrets:

```text
TELEGRAM_BOT_TOKEN=...
TELEGRAM_WEBHOOK_SECRET=<independent random token, base64url alphabet>
TELEGRAM_OWNER_USER_ID=<decimal owner id>
PUBLIC_BASE_URL=https://<worker>.workers.dev
```

Use `wrangler secret put` for token/secret values. User ID and public base URL are not themselves secrets but should be configured correctly.

To generate secrets in a development terminal:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Use a **different** value for each of `APP_HMAC_SECRET`, `TELEGRAM_WEBHOOK_SECRET` and `PI_AGENT_TOKEN`.

Deploy Worker first; then run:

```bash
npm run telegram:webhook
```

This calls Telegram's `setWebhook` with secret header authentication and requests only `message` updates. Initial registration intentionally clears pending messages; it should not be repeated unnecessarily in a busy bot.

## Security testing

- `/help` in your private bot chat works.
- Someone else's private Telegram account receives no admin response.
- Commands sent from groups are ignored, including messages from the owner.
- Direct calls to `POST /telegram` without the secret header are rejected.
- The bot token and webhook secret never appear in Git or Worker URL paths.
- Telegram bot chats are **not** end-to-end encrypted; recipient RSS links in bot messages are sensitive bearer credentials.

## Commands

See [README](../README.md). Initially prefer one owner only. Additional admin users would need a deliberate security redesign and proper audit behavior.
