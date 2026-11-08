import { describe, it, expect, vi } from "vitest";
import { putR2ObjectIf } from "../r2.adapter";

// A conditional PUT must carry exactly one precondition. With neither set, the request would overwrite whatever
// is in R2, so the adapter refuses before any network call.
const base = {
  endpoint: "https://acc.r2.cloudflarestorage.com",
  bucket: "b",
  key: "k.pdf",
  accessKeyId: "id",
  secretAccessKey: "secret",
  body: Buffer.from("bytes"),
};

describe("putR2ObjectIf precondition", () => {
  it("refuses a write with no precondition and never contacts R2", async () => {
    const fetchImpl = vi.fn();
    const result = await putR2ObjectIf({ ...base, fetchImpl: fetchImpl as never });
    expect(result.status).toBe("failed");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses a write with both preconditions set", async () => {
    const fetchImpl = vi.fn();
    const result = await putR2ObjectIf({ ...base, ifMatch: '"e1"', ifNoneMatch: "*", fetchImpl: fetchImpl as never });
    expect(result.status).toBe("failed");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("sends a create-once write with If-None-Match: *", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    await putR2ObjectIf({ ...base, ifNoneMatch: "*", fetchImpl: fetchImpl as never });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const headers = (fetchImpl.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers["if-none-match"]).toBe("*");
  });
});
