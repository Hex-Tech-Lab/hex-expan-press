import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const sendMock = vi.fn();

vi.mock("resend", () => ({
  Resend: class {
    emails = { send: sendMock };
  },
}));

import { sendEmail } from "../src/email.ts";

const MAIL = { to: "a@b.c", subject: "s", html: "<p>hi</p>", text: "hi" };

// `definite` answers whether the provider certainly did NOT accept the message.
// Only a definite rejection may release a buyer's link. An ambiguous outcome keeps it.
describe("payments/src/email send outcome", () => {
  const origKey = process.env.RESEND_API_KEY;

  beforeEach(() => {
    sendMock.mockReset();
    process.env.RESEND_API_KEY = "test-key";
  });

  afterEach(() => {
    if (origKey !== undefined) process.env.RESEND_API_KEY = origKey;
    else delete process.env.RESEND_API_KEY;
  });

  it("a missing key is a definite rejection: nothing was sent", async () => {
    delete process.env.RESEND_API_KEY;
    await expect(sendEmail(MAIL)).rejects.toMatchObject({ definite: true });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("a 4xx response from Resend is a definite rejection", async () => {
    sendMock.mockResolvedValue({ data: null, error: { message: "invalid to", name: "validation_error", statusCode: 422 } });
    await expect(sendEmail(MAIL)).rejects.toMatchObject({ definite: true, statusCode: 422 });
  });

  it("a 429 is a definite rejection: the request was refused, not processed", async () => {
    sendMock.mockResolvedValue({ data: null, error: { message: "rate limited", name: "rate_limit_exceeded", statusCode: 429 } });
    await expect(sendEmail(MAIL)).rejects.toMatchObject({ definite: true, statusCode: 429 });
  });

  it("a 5xx response is ambiguous: the provider may have accepted the message", async () => {
    sendMock.mockResolvedValue({ data: null, error: { message: "upstream", name: "application_error", statusCode: 503 } });
    await expect(sendEmail(MAIL)).rejects.toMatchObject({ definite: false, statusCode: 503 });
  });

  it("an error response with no status is ambiguous", async () => {
    sendMock.mockResolvedValue({ data: null, error: { message: "no data" } });
    await expect(sendEmail(MAIL)).rejects.toMatchObject({ definite: false });
  });

  it("a transport failure is ambiguous: the request may have reached Resend", async () => {
    sendMock.mockRejectedValue(new Error("socket hang up"));
    await expect(sendEmail(MAIL)).rejects.toMatchObject({ definite: false });
  });
});
