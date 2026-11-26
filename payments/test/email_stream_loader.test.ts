import { describe, expect, it } from "vitest";
import { isOnSendingDomain } from "../src/email.ts";
import { DEFAULT_GLOBAL, loadEmailSection } from "../src/settings_registry.ts";

const DEFAULT_BUYER = DEFAULT_GLOBAL.email.streams.buyer_delivery;

describe("email stream loader (global.json overrides)", () => {
  it("keeps a sending_domain override when the From address sits on that domain", () => {
    const email = loadEmailSection({ sending_domain: "x.expanpress.com", from: "ExpanPress <d@x.expanpress.com>" });
    expect(email.streams.buyer_delivery).toEqual({ from: "ExpanPress <d@x.expanpress.com>", domain: "x.expanpress.com" });
    expect(email.streams.ops_alerts.domain).toBe("ops.expanpress.com");
  });

  it("falls back to the default when sending_domain does not match the From address (no buyer send is left refused)", () => {
    const email = loadEmailSection({ sending_domain: "custom.expanpress.com" });
    expect(email.streams.buyer_delivery).toEqual(DEFAULT_BUYER);
    expect(isOnSendingDomain(email.streams.buyer_delivery.from, email.streams.buyer_delivery.domain)).toBe(true);
  });

  it("refuses the root domain as a stream domain", () => {
    const email = loadEmailSection({ streams: { buyer_delivery: { from: "ExpanPress <d@expanpress.com>", domain: "expanpress.com" } } });
    expect(email.streams.buyer_delivery).toEqual(DEFAULT_BUYER);
  });

  it("refuses the reserved esign domain as a stream domain", () => {
    const email = loadEmailSection({ streams: { ops_alerts: { from: "ExpanPress <a@esign.expanpress.com>", domain: "esign.expanpress.com" } } });
    expect(email.streams.ops_alerts).toEqual(DEFAULT_GLOBAL.email.streams.ops_alerts);
  });

  it("treats a scalar or array email section as absent", () => {
    expect(loadEmailSection("oops" as never).streams).toEqual(DEFAULT_GLOBAL.email.streams);
    expect(loadEmailSection([] as never).streams).toEqual(DEFAULT_GLOBAL.email.streams);
  });

  it("refuses a double-bracket From with a second mailbox, at load and at send", () => {
    const from = "A <x@mail.expanpress.com> <y@evil.example>";
    expect(isOnSendingDomain(from, "mail.expanpress.com")).toBe(false);
    const email = loadEmailSection({ streams: { buyer_delivery: { from, domain: "mail.expanpress.com" } } });
    expect(email.streams.buyer_delivery).toEqual(DEFAULT_BUYER);
  });

  it("refuses a two-mailbox From at load, so it never reaches send", () => {
    const email = loadEmailSection({ streams: { buyer_delivery: { from: "Support <x@mail.expanpress.com>, Bad <y@mail.expanpress.com>", domain: "mail.expanpress.com" } } });
    expect(email.streams.buyer_delivery).toEqual(DEFAULT_BUYER);
  });

  it("refuses text after the closing bracket of a From, which Resend would send as part of the header", () => {
    const from = "ExpanPress <delivery@mail.expanpress.com> evil@attacker.com";
    const email = loadEmailSection({ streams: { buyer_delivery: { from, domain: "mail.expanpress.com" } } });
    expect(email.streams.buyer_delivery).toEqual(DEFAULT_BUYER);
  });

  it("refuses a line break in the display name (header injection)", () => {
    const from = "\"ExpanPress\r\nBcc: spy@evil.example\" <delivery@mail.expanpress.com>";
    const email = loadEmailSection({ streams: { buyer_delivery: { from, domain: "mail.expanpress.com" } } });
    expect(email.streams.buyer_delivery).toEqual(DEFAULT_BUYER);
  });

  it("refuses a From address with a second @ (the send-time host would be the wrong one)", () => {
    const from = "attacker@evil.com@mail.expanpress.com";
    expect(isOnSendingDomain(from, "mail.expanpress.com")).toBe(false);
    const email = loadEmailSection({ streams: { buyer_delivery: { from, domain: "mail.expanpress.com" } } });
    expect(email.streams.buyer_delivery).toEqual(DEFAULT_BUYER);
  });

  it("refuses the root domain written with a double trailing dot", () => {
    const email = loadEmailSection({ streams: { buyer_delivery: { from: "a@expanpress.com..", domain: "expanpress.com.." } } });
    expect(email.streams.buyer_delivery).toEqual(DEFAULT_BUYER);
  });

  it("refuses the root domain written with a trailing dot", () => {
    const email = loadEmailSection({ streams: { buyer_delivery: { from: "ExpanPress <d@expanpress.com.>", domain: "expanpress.com." } } });
    expect(email.streams.buyer_delivery).toEqual(DEFAULT_BUYER);
  });

  it("refuses an ops From address that is off its domain", () => {
    const email = loadEmailSection({ streams: { ops_alerts: { from: "ExpanPress Ops <x@evil.example>", domain: "ops.expanpress.com" } } });
    expect(email.streams.ops_alerts).toEqual(DEFAULT_GLOBAL.email.streams.ops_alerts);
  });
});

describe("From address parsing at send time", () => {
  it("takes the host after the last @, so a suffixed address is refused", () => {
    expect(isOnSendingDomain("billing@expanpress.com@evil.example", "expanpress.com")).toBe(false);
  });

  it("refuses a From header with a second mailbox", () => {
    expect(isOnSendingDomain("Support <x@mail.expanpress.com>, Bad <y@evil.example>", "mail.expanpress.com")).toBe(false);
    expect(isOnSendingDomain("a@mail.expanpress.com, b@evil.example", "mail.expanpress.com")).toBe(false);
  });

  it("accepts one mailbox on the domain", () => {
    expect(isOnSendingDomain("ExpanPress <delivery@mail.expanpress.com>", "mail.expanpress.com")).toBe(true);
  });
});
