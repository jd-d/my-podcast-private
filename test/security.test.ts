import { describe, expect, it } from "vitest";
import { constantTimeEqual, isYoutubeUrl, randomToken, encryptReply, decryptReply } from "../src/security";

describe("encrypted Telegram outbox", () => {
  it("authenticates the secret and update ID and uses fresh IVs", async () => {
    const a=await encryptReply("synthetic-secret",1,"synthetic-private-feed");
    const b=await encryptReply("synthetic-secret",1,"synthetic-private-feed");
    expect(a).not.toBe(b);
    expect(a).not.toContain("synthetic-private-feed");
    expect(await decryptReply("synthetic-secret",1,a)).toBe("synthetic-private-feed");
    await expect(decryptReply("wrong-secret",1,a)).rejects.toThrow();
    await expect(decryptReply("synthetic-secret",2,a)).rejects.toThrow();
  });
});

describe("recipient token generation", () => {
  it("uses 32 random bytes encoded as 43 base64url characters", () => {
    const a = randomToken();
    const b = randomToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a).not.toEqual(b);
  });
});

describe("authorization comparison", () => {
  it("handles mismatched lengths without accepting a prefix", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
  });
});

describe("import URL restrictions", () => {
  it("accepts YouTube https links only", () => {
    expect(isYoutubeUrl("https://www.youtube.com/watch?v=abc")).toBe(true);
    expect(isYoutubeUrl("https://youtu.be/abc")).toBe(true);
    expect(isYoutubeUrl("http://youtube.com/watch?v=abc")).toBe(false);
    expect(isYoutubeUrl("https://youtube.com.evil.test/watch?v=abc")).toBe(false);
    expect(isYoutubeUrl("https://127.0.0.1/private")).toBe(false);
    expect(isYoutubeUrl("https://example.com/video")).toBe(false);
  });
});
