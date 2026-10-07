import { createHmac, randomBytes } from "node:crypto";

const alias = process.argv.slice(2).join(" ").trim();
const secret = process.env.APP_HMAC_SECRET;

if (!alias) {
  console.error('Usage: npm run recipient:token -- "Friend alias"');
  process.exit(1);
}

if (!secret || secret === "replace-with-a-long-random-secret") {
  console.error("APP_HMAC_SECRET is missing. Put the real local value in .dev.vars.");
  process.exit(1);
}

const token = randomBytes(32).toString("base64url");
const digest = createHmac("sha256", secret)
  .update(`recipient:${token}`)
  .digest("hex");

const sqlAlias = alias.replaceAll("'", "''");

console.log("\nRecipient created locally (nothing has been written to D1 yet).\n");
console.log(`Alias: ${alias}`);
console.log(`Token: ${token}`);
console.log("\nRun this against the intended database:");
console.log(
  `npx wrangler d1 execute DB --remote --command "INSERT INTO recipients (alias, token_digest) VALUES ('${sqlAlias}', '${digest}');"`,
);
console.log("\nThen share only:");
console.log(`https://<your-host>/f/${token}/feed.xml`);
console.log(
  "\nIMPORTANT: the plaintext token is intentionally not stored by the service. Save/share it now or generate a replacement.",
);
