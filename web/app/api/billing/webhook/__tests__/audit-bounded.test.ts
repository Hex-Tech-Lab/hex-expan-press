import { describe, it, expect, vi, afterEach } from "vitest";
import { auditBounded } from "../handler";

describe("auditBounded", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("rejects to the caller when the audit rejects, and clears the timer", async () => {
    vi.useFakeTimers();
    const boom = new Error("audit insert exploded");
    const run = vi.fn(() => Promise.reject(boom));

    await expect(auditBounded({ reason: "test" }, run)).rejects.toBe(boom);

    expect(run).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects and clears the timer when the audit throws synchronously", async () => {
    vi.useFakeTimers();
    const boom = new Error("audit threw before returning a promise");
    const run = vi.fn((): Promise<void> => {
      throw boom;
    });

    await expect(auditBounded({ reason: "test" }, run)).rejects.toBe(boom);

    expect(run).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the timer when the audit resolves", async () => {
    vi.useFakeTimers();
    const run = vi.fn(() => Promise.resolve());

    await expect(auditBounded({ reason: "test" }, run)).resolves.toBeUndefined();

    expect(vi.getTimerCount()).toBe(0);
  });
});
