import { describe, it, expect } from "vitest";
import { toError } from "../error-reporting";

describe("toError", () => {
  it("returns an existing Error instance as-is", () => {
    const original = new Error("already an error");
    const result = toError(original);
    expect(result).toBe(original);
  });

  it("wraps a plain { message } object in an Error while preserving message and cause", () => {
    const pgError = { message: "permission denied for table consents", code: "42501" };
    const result = toError(pgError);
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe("permission denied for table consents");
    expect(result.cause).toBe(pgError);
  });

  it("wraps a string in an Error with the original string as message and cause", () => {
    const result = toError("network timeout");
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe("network timeout");
    expect(result.cause).toBe("network timeout");
  });

  it("falls back to String(err) when an object lacks a string message and preserves cause", () => {
    const weird = { message: 42, code: "ERR" };
    const result = toError(weird);
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe(String(weird));
    expect(result.cause).toBe(weird);
  });
});
