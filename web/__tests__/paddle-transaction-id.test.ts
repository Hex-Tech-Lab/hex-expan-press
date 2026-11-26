import { describe, expect, it } from "vitest";
import { parseTransactionId } from "../src/lib/paddle-transaction-id";

describe("parseTransactionId (pay-host /checkout?_ptxn)", () => {
  it("accepts a Paddle transaction id", () => {
    expect(parseTransactionId("txn_01m8cdbf5er6xfhgrawfca7by4")).toBe("txn_01m8cdbf5er6xfhgrawfca7by4");
  });

  it.each([
    ["missing", undefined],
    ["repeated parameter", ["txn_01m8cdbf5er6xfhgrawfca7by4", "txn_01m8cdbf5er6xfhgrawfca7by4"]],
    ["empty", ""],
    ["wrong prefix", "sub_01m8cdbf5er6xfhgrawfca7by4"],
    ["too short", "txn_abc"],
    ["uppercase", "txn_01M8CDBF5ER6XFHGRAWFCA7BY4"],
    ["script injection", "txn_<script>alert(1)</script>"],
  ])("refuses %s", (_label, raw) => {
    expect(parseTransactionId(raw as string | string[] | undefined)).toBeNull();
  });
});
