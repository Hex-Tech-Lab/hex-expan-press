import { describe, expect, it, vi } from "vitest";
import { scrubDownloadTokens } from "../src/lib/sentry-scrub";

const TOKEN = "A".repeat(43);

describe("scrubDownloadTokens", () => {
  it("removes the download token from the request URL, transaction name and exception message", () => {
    const event = {
      request: { url: `https://expanpress.com/books/d/${TOKEN}`, method: "GET" },
      transaction: `GET /books/d/${TOKEN}`,
      exception: { values: [{ value: `failed at /books/d/${TOKEN}` }] },
    };
    const out = scrubDownloadTokens(event);
    expect(out).not.toBeNull();
    expect(JSON.stringify(out)).not.toContain(TOKEN);
    expect(out?.request.url).toBe("https://expanpress.com/books/d/[REDACTED]");
    expect(out?.request.method).toBe("GET");
  });

  it("removes the token from breadcrumbs as well", () => {
    const out = scrubDownloadTokens({ breadcrumbs: [{ data: { url: `/books/d/${TOKEN}?x=1` } }] });
    expect(out).not.toBeNull();
    expect(JSON.stringify(out)).not.toContain(TOKEN);
  });

  it("returns events with no download path as the same object, without a copy", () => {
    const event = { request: { url: "https://expanpress.com/checkout/abc" }, level: "error" };
    expect(scrubDownloadTokens(event)).toBe(event);
  });

  it("does not redact a path segment that is not a 43-character token", () => {
    const out = scrubDownloadTokens({ request: { url: "https://expanpress.com/books/d/short" } });
    expect(out?.request.url).toBe("https://expanpress.com/books/d/short");
  });

  it("drops an event that cannot be serialized, and logs it, so no token can leave unscrubbed", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const circular: Record<string, unknown> = { url: `/books/d/${TOKEN}` };
    circular.self = circular;
    try {
      expect(scrubDownloadTokens(circular)).toBeNull();
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("could not be serialized"), expect.anything());
    } finally {
      errorSpy.mockRestore();
    }
  });
});
