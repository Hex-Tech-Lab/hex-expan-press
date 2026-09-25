import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const sendMock = vi.fn();

vi.mock("resend", () => ({
  Resend: class {
    emails = { send: sendMock };
  },
}));

import { sendEmail } from "../src/email.ts";

describe("payments/src/email", () => {
  const origKey = process.env.RESEND_API_KEY;
  const origFrom = process.env.EMAIL_FROM;

  beforeEach(() => {
    sendMock.mockReset();
    delete process.env.RESEND_API_KEY;
    delete process.env.EMAIL_FROM;
  });

  afterEach(() => {
    if (origKey !== undefined) process.env.RESEND_API_KEY = origKey;
    else delete process.env.RESEND_API_KEY;
    if (origFrom !== undefined) process.env.EMAIL_FROM = origFrom;
    else delete process.env.EMAIL_FROM;
  });

  it("throws a clear error when RESEND_API_KEY is missing", async () => {
    await expect(sendEmail({ to: "a@b.c", subject: "s", html: "<p>hi</p>" })).rejects.toThrow(
      "RESEND_API_KEY is missing",
    );
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("returns the id on success", async () => {
    process.env.RESEND_API_KEY = "test-key";
    sendMock.mockResolvedValue({ data: { id: "abc-123" }, error: null });

    const out = await sendEmail({ to: "a@b.c", subject: "s", html: "<p>hi</p>" });
    expect(out).toEqual({ id: "abc-123" });
    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({ from: "ExpanPress <onboarding@resend.dev>", to: "a@b.c" }),
    );
  });

  it("throws on an error response", async () => {
    process.env.RESEND_API_KEY = "test-key";
    sendMock.mockResolvedValue({ data: null, error: { message: "invalid to address" } });

    await expect(sendEmail({ to: "bad", subject: "s", html: "<p>hi</p>" })).rejects.toThrow(
      "Resend error: invalid to address",
    );
  });
});
