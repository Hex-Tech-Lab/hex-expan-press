import { describe, it, expect, vi, beforeEach } from "vitest";
import { DeliveryPendingError } from "../../../../payments/src/delivery_errors.ts";
import { deliverWithinBudget } from "../process_billing_webhook.ts";

// The request-level deadline race (deliverWithinBudget). The sale lock holder keeps the lock until the send that the answer
// was cut from has settled. The delivery work is mocked so the test controls when its send is in flight and when it answers.
const delivery = vi.hoisted(() => ({
  deliverSaleForWebhook: vi.fn(async (): Promise<void> => undefined),
  saleDeliveryConfirmed: vi.fn(async () => false),
}));
vi.mock("../../../../payments/src/delivery.ts", () => delivery);

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const DEADLINE_MS = 30;
const WORK_MS = 60;

const input = (deadlineAt: number) => ({
  provider: "paddle",
  saleId: "sale_budget_1",
  productAlias: "prod_1",
  buyerEmail: "ann@example.com",
  deadlineAt,
});

beforeEach(() => {
  delivery.deliverSaleForWebhook.mockReset();
});

describe("deliverWithinBudget: the sale lock outlives a send cut at the request deadline (F-01a)", () => {
  it("holds the lock while the send that the answer was cut from is still running", async () => {
    let finishSend!: () => void;
    const send = new Promise<void>((resolve) => (finishSend = resolve));
    const sendSettled = send.then(() => undefined, () => undefined);
    // The delivery's own send timer fires after the outer deadline; the send itself is not aborted.
    delivery.deliverSaleForWebhook.mockImplementationOnce(
      () =>
        new Promise<void>((_, reject) =>
          setTimeout(
            () => reject(new DeliveryPendingError("sale_budget_1", new Error("email send timed out"), sendSettled)),
            WORK_MS,
          ),
        ),
    );

    const err = await deliverWithinBudget(input(Date.now() + DEADLINE_MS)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DeliveryPendingError);
    const background = (err as DeliveryPendingError).backgroundWork;
    expect(background).toBeDefined();

    let released = false;
    background!.then(() => (released = true));
    // The delivery has answered by now, and the send is still running: the lock must not be released.
    await sleep(WORK_MS + 30);
    expect(released).toBe(false);

    finishSend();
    await background;
    expect(released).toBe(true);
  });

  it("releases the lock at once when the delivery ends with no send in flight", async () => {
    // Work that is still in a database step past the deadline, and that ends without any send.
    delivery.deliverSaleForWebhook.mockImplementationOnce(
      () => new Promise<void>((_, reject) => setTimeout(() => reject(new DeliveryPendingError("sale_budget_1", new Error("db slow"))), WORK_MS)),
    );

    const err = await deliverWithinBudget(input(Date.now() + DEADLINE_MS)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DeliveryPendingError);
    const background = (err as DeliveryPendingError).backgroundWork!;
    let released = false;
    background.then(() => (released = true));
    await sleep(WORK_MS + 30);
    expect(released).toBe(true);
  });
});
