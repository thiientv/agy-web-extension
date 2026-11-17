import { describe, expect, it } from "vitest";
import { normalizeNavigationUrl, redactSensitiveUrl } from "../src/shared/url-redact.js";

describe("url-redact helpers", () => {
  it("normalizes bare hostnames to https:// while preserving explicit schemes and history keywords", () => {
    expect(normalizeNavigationUrl("example.com/docs")).toBe("https://example.com/docs");
    expect(normalizeNavigationUrl("http://localhost:3000/test")).toBe("http://localhost:3000/test");
    expect(normalizeNavigationUrl("back")).toBe("back");
    expect(normalizeNavigationUrl("forward")).toBe("forward");
  });

  it("redacts sensitive auth/token query parameters while keeping benign parameters intact", () => {
    const raw = "https://api.example.com/v1/items?page=2&access_token=secret123&apiKey=xyz&category=books";
    const redacted = redactSensitiveUrl(raw);
    expect(redacted).toContain("page=2");
    expect(redacted).toContain("category=books");
    expect(redacted).toContain("access_token=REDACTED");
    expect(redacted).toContain("apiKey=REDACTED");
    expect(redacted).not.toContain("secret123");
    expect(redacted).not.toContain("xyz");
  });
});
