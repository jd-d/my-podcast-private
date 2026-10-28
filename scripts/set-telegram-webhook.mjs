// Run with: node --env-file=.dev.vars scripts/set-telegram-webhook.mjs
// Do not put the bot token in a command-line URL or commit it to Git.
const token = process.env.TELEGRAM_BOT_TOKEN;
const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
const origin = process.env.PUBLIC_BASE_URL;
if (!token || !secret || !origin) {
  console.error("TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET and PUBLIC_BASE_URL are required.");
  process.exit(1);
}
const target = new URL("/telegram", origin).href;
if (!target.startsWith("https://")) throw new Error("Webhook must use HTTPS");
const res = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    url: target,
    secret_token: secret,
    allowed_updates: ["message"],
    drop_pending_updates: true
  }),
});
const result = await res.json();
if (!res.ok || !result.ok) {
  console.error("Telegram webhook registration failed", res.status, result.description);
  process.exit(1);
}
console.log("Telegram webhook registered:", target);
