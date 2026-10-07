import { describe, expect, it } from "vitest";
import {
  escapeXml,
  formatRssDate,
  isValidBearerToken,
  parsePositiveInt,
  safeEpisodeId,
  secondsToItunesDuration,
  sessionBucket,
} from "../src/lib";

describe("token validation", () => {
  it("accepts a 32-byte base64url token", () => {
    expect(isValidBearerToken("A".repeat(43))).toBe(true);
  });

  it("rejects short or unsafe values", () => {
    expect(isValidBearerToken("abc")).toBe(false);
    expect(isValidBearerToken("/".repeat(43))).toBe(false);
  });
});

describe("RSS helpers", () => {
  it("escapes XML", () => {
    expect(escapeXml(`A & <B> "C"`)).toBe(
      "A &amp; &lt;B&gt; &quot;C&quot;",
    );
  });

  it("formats RFC-style dates", () => {
    expect(formatRssDate("2026-10-07T10:00:00Z")).toContain("07 Oct 2026");
  });

  it("formats durations", () => {
    expect(secondsToItunesDuration(65)).toBe("1:05");
    expect(secondsToItunesDuration(3661)).toBe("1:01:01");
  });
});

describe("routing helpers", () => {
  it("accepts conservative episode IDs", () => {
    expect(safeEpisodeId("episode-01")).toBe(true);
    expect(safeEpisodeId("../secret")).toBe(false);
  });

  it("falls back for invalid positive ints", () => {
    expect(parsePositiveInt("45", 30)).toBe(45);
    expect(parsePositiveInt("0", 30)).toBe(30);
  });

  it("groups time into session windows", () => {
    expect(sessionBucket(30 * 60_000, 30)).toBe(1);
  });
});
