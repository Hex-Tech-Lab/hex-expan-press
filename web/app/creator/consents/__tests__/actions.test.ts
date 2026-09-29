// Sibling regression tests for the Wave 6.1 consent-signing Server Action
// (qa-intel rule: auth-bearing changes need sibling tests).
// Contract: ssr session is the only credential (fail-closed redirect);
// only C1/C2 are user-signable; the legal-name rule is enforced server-side;
// the write goes through the submit_consent RPC under the RLS identity.
import { describe, it, expect, vi, beforeEach } from "vitest";

const rpcMock = vi.fn();
let releaseSha: string | null = "a".repeat(64);
const productSelect = {
  select: vi.fn(() => ({
    order: vi.fn(() => ({
      limit: vi.fn(async () => ({ data: [{ id: "p1", release_sha256: releaseSha }] })),
    })),
  })),
};

vi.mock("../../../../src/lib/supabase-server", () => ({
  getPortalSession: vi.fn(async () => ({
    user: { id: "u1", email: "a@b.c", app_metadata: { provider: "google" } },
    supabase: { from: () => productSelect, rpc: rpcMock },
  })),
}));

vi.mock("next/headers", () => ({
  headers: async () =>
    new Map([
      ["x-forwarded-for", "203.0.113.9, 10.0.0.1"],
      ["user-agent", "vitest-agent/1.0"],
    ]) as unknown as Headers,
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

import { signConsentAction } from "../actions";

function fd(kind: string, name: string): FormData {
  const f = new FormData();
  f.set("kind", kind);
  f.set("typedName", name);
  return f;
}

describe("signConsentAction (Wave 6.1)", () => {
  beforeEach(() => {
    rpcMock.mockReset();
    rpcMock.mockResolvedValue({ error: null });
    releaseSha = "a".repeat(64);
  });

  it("fails closed to the signin redirect when there is no session", async () => {
    const { getPortalSession } = await import("../../../../src/lib/supabase-server");
    (getPortalSession as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    await expect(signConsentAction({}, fd("C1_data_accuracy", "Duane Smith"))).rejects.toThrow(
      "NEXT_REDIRECT:/creator/signin",
    );
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("rejects a name that is not a full legal name (single word) without writing", async () => {
    const res = await signConsentAction({}, fd("C1_data_accuracy", "Duane"));
    expect(res.ok).toBeUndefined();
    expect(res.error).toMatch(/full legal name/i);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("rejects unknown consent kinds — C3 comes only from the Firma webhook", async () => {
    const res = await signConsentAction({}, fd("C3_revenue_split", "Duane Smith"));
    expect(res.error).toMatch(/unknown consent/i);
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("records C1 with the zeros document hash and request IP/UA", async () => {
    const res = await signConsentAction({}, fd("C1_data_accuracy", "Duane Smith"));
    expect(res).toEqual({ ok: true });
    expect(rpcMock).toHaveBeenCalledWith(
      "submit_consent",
      expect.objectContaining({
        p_product_id: "p1",
        p_kind: "C1_data_accuracy",
        p_decision: "given",
        p_text_version: "v1.0",
        p_document_sha256: "0".repeat(64),
        p_typed_name: "Duane Smith",
        p_ip: "203.0.113.9",
        p_user_agent: "vitest-agent/1.0",
        p_auth_provider: "google",
      }),
    );
  });

  it("records C2 with the product release hash when present", async () => {
    const res = await signConsentAction({}, fd("C2_release_approval", "Duane Smith"));
    expect(res).toEqual({ ok: true });
    expect(rpcMock).toHaveBeenCalledWith(
      "submit_consent",
      expect.objectContaining({
        p_kind: "C2_release_approval",
        p_document_sha256: "a".repeat(64),
      }),
    );
  });

  it("refuses C2 when the release hash is missing or the zero placeholder — never writes", async () => {
    for (const bad of [null, "0".repeat(64), "not-a-hash"]) {
      releaseSha = bad;
      const res = await signConsentAction({}, fd("C2_release_approval", "Duane Smith"));
      expect(res.error).toMatch(/isn't ready to approve/);
    }
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it("maps an RPC failure to a friendly error, never a crash", async () => {
    rpcMock.mockResolvedValueOnce({ error: { message: "append-only violation" } });
    const res = await signConsentAction({}, fd("C1_data_accuracy", "Duane Smith"));
    expect(res.error).toMatch(/could not record/i);
  });
});
