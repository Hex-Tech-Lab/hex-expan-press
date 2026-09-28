// Sibling regression tests for the Wave 6.1 review-answer Server Action
// (qa-intel rule: auth-bearing changes need sibling tests).
// Contract: ssr session fail-closed; empty answers rejected; the write goes
// through the submit_review_answer RPC under the RLS identity.
import { describe, it, expect, vi, beforeEach } from "vitest";

const rpcMock = vi.fn();

vi.mock("../../../../src/lib/supabase-server", () => ({
  getPortalSession: vi.fn(async () => ({
    user: { id: "u1", email: "a@b.c" },
    supabase: { rpc: rpcMock },
  })),
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

import { submitReviewAnswerAction } from "../actions";

describe("submitReviewAnswerAction (Wave 6.1)", () => {
  beforeEach(() => {
    rpcMock.mockReset();
    rpcMock.mockResolvedValue({ error: null });
  });

  it("fails closed with a session-expired error when there is no session (no redirect — the client stepper shows it)", async () => {
    const { getPortalSession } = await import("../../../../src/lib/supabase-server");
    (getPortalSession as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    const res = await submitReviewAnswerAction("item-1", "A", null);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/session expired/i);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("rejects a completely empty answer without writing", async () => {
    const res = await submitReviewAnswerAction("item-1", null, "   ");
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/choose an option or write/i);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("persists through the RPC with the exact arguments", async () => {
    const res = await submitReviewAnswerAction("item-1", "A", "about $9,000 a year");
    expect(res).toEqual({ ok: true });
    expect(rpcMock).toHaveBeenCalledWith("submit_review_answer", {
      item_id: "item-1",
      choice: "A",
      free_text: "about $9,000 a year",
    });
  });

  it("maps an RPC failure to a friendly error", async () => {
    rpcMock.mockResolvedValueOnce({ error: { message: "append-only violation" } });
    const res = await submitReviewAnswerAction("item-1", "A", null);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/could not save/i);
  });
});
