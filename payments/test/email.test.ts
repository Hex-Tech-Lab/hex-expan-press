import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const sendMock = vi.fn();

vi.mock("resend", () => ({
  Resend: class {
    emails = { send: sendMock };
  },
}));

import { sendEmail, sendEmailSafe, isOnSendingDomain, EmailSendError } from "../src/email.ts";

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
    await expect(sendEmail({ to: "a@b.c", subject: "s", html: "<p>hi</p>", text: "hi" })).rejects.toThrow(
      "RESEND_API_KEY is missing",
    );
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("returns the id on success", async () => {
    process.env.RESEND_API_KEY = "test-key";
    sendMock.mockResolvedValue({ data: { id: "abc-123" }, error: null });

    const out = await sendEmail({ to: "a@b.c", subject: "s", html: "<p>hi</p>", text: "hi" });
    expect(out).toEqual({ id: "abc-123" });
    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        from: "ExpanPress <support@esign.expanpress.com>",
        to: "a@b.c",
        text: "hi",
        replyTo: "support@expanpress.com",
      }),
    );
  });

  it("throws on an error response", async () => {
    process.env.RESEND_API_KEY = "test-key";
    sendMock.mockResolvedValue({ data: null, error: { message: "invalid to address" } });

    await expect(sendEmail({ to: "bad", subject: "s", html: "<p>hi</p>", text: "hi" })).rejects.toThrow(
      "Resend error: invalid to address",
    );
  });

  it("refuses an HTML-only email (multipart required)", async () => {
    process.env.RESEND_API_KEY = "test-key";
    await expect(sendEmail({ to: "a@b.c", subject: "s", html: "<p>hi</p>", text: "  " })).rejects.toThrow(/multipart/);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("refuses a From address off the sending domain", async () => {
    process.env.RESEND_API_KEY = "test-key";
    process.env.EMAIL_FROM = "Spoof <noreply@expanpress.com.evil.test>";
    await expect(sendEmail({ to: "a@b.c", subject: "s", html: "<p>hi</p>", text: "hi" })).rejects.toThrow(/not on expanpress.com/);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("matches the sending domain and its subdomains only", () => {
    expect(isOnSendingDomain("ExpanPress <signin@ops.expanpress.com>")).toBe(true);
    expect(isOnSendingDomain("support@expanpress.com")).toBe(true);
    expect(isOnSendingDomain("a@notexpanpress.com")).toBe(false);
    expect(isOnSendingDomain("a@expanpress.com.evil.test")).toBe(false);
  });

  it.each([
    [429, true],
    [500, true],
    [422, false],
    [403, false],
  ])("Resend status %i → retryable=%s", async (statusCode, retryable) => {
    process.env.RESEND_API_KEY = "test-key";
    sendMock.mockResolvedValue({ data: null, error: { message: "x", statusCode } });
    const err = await sendEmail({ to: "a@b.c", subject: "s", html: "<p>hi</p>", text: "hi" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EmailSendError);
    expect((err as EmailSendError).retryable).toBe(retryable);
    expect((err as EmailSendError).statusCode).toBe(statusCode);
  });

  it("a transport failure is retryable", async () => {
    process.env.RESEND_API_KEY = "test-key";
    sendMock.mockRejectedValue(new Error("ECONNRESET"));
    const err = await sendEmail({ to: "a@b.c", subject: "s", html: "<p>hi</p>", text: "hi" }).catch((e: unknown) => e);
    expect((err as EmailSendError).retryable).toBe(true);
  });

  it("sendEmailSafe never throws and reports the outcome", async () => {
    process.env.RESEND_API_KEY = "test-key";
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    sendMock.mockResolvedValue({ data: null, error: { message: "rate limited", statusCode: 429 } });
    await expect(sendEmailSafe({ to: "a@b.c", subject: "s", html: "<p>hi</p>", text: "hi" })).resolves.toEqual({
      ok: false,
      error: "Resend error (429): rate limited",
      retryable: true,
    });
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("retryable=true status=429"));
    errSpy.mockRestore();
  });
});
