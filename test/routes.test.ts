import { describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { AppEnv } from "../src/security";

const fakeEnv = {
  DB: {} as D1Database,
  AUDIO: {} as R2Bucket,
  APP_HMAC_SECRET: "unit-test-secret-should-never-be-deployed",
  PI_AGENT_TOKEN: "valid-test-agent-token",
  TELEGRAM_WEBHOOK_SECRET: "valid-webhook-secret",
  TELEGRAM_BOT_TOKEN: "unused-fake-token",
  TELEGRAM_OWNER_USER_ID: "123456",
} satisfies AppEnv;

describe("public route isolation", () => {
  it("catches asynchronous backend failures without logging their sensitive exception text", async () => {
    const logger = vi.spyOn(console,"error").mockImplementation(()=>{});
    let queries = 0;
    const env = { ...fakeEnv, DB: {prepare() {
      if (++queries === 1) return {bind:()=>({first:async()=>({id:1})})};
      throw new Error("synthetic-private-url-must-not-be-logged");
    }} as unknown as D1Database };
    try {
      const response = await worker.fetch(new Request(`https://example.test/f/${"A".repeat(43)}/audio/test`),env);
      expect(response.status).toBe(500);
      expect(logger).toHaveBeenCalledExactlyOnceWith("request_failed");
    } finally { logger.mockRestore(); }
  });
  it("never allows unknown paths or malformed feed tokens", async () => {
    const notFound = await worker.fetch(new Request("https://example.test/"), fakeEnv);
    expect(notFound.status).toBe(404);
    const invalid = await worker.fetch(
      new Request("https://example.test/f/abc/feed.xml"), fakeEnv);
    expect(invalid.status).toBe(404);
  });

  it("does not accept unauthenticated agent requests", async () => {
    const result = await worker.fetch(
      new Request("https://example.test/agent/claim", {method:"POST"}), fakeEnv);
    expect(result.status).toBe(401);
  });

  it("rejects forged Telegram calls without the webhook secret", async () => {
    const result = await worker.fetch(
      new Request("https://example.test/telegram", {
        method: "POST",
        headers: {"Content-Type":"application/json"},
        body: JSON.stringify({update_id:99,message:{text:"/add Stolen"}})
      }), fakeEnv);
    expect(result.status).toBe(404);
  });

  it("denies unknown HTTP write routes", async () => {
    const result = await worker.fetch(
      new Request("https://example.test/f/abc/feed.xml", {method:"DELETE"}), fakeEnv);
    expect(result.status).toBe(405);
  });
});
