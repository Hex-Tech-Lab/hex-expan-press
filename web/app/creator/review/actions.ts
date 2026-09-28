"use server";

import { revalidatePath } from "next/cache";
import { getPortalSession } from "../../../src/lib/supabase-server";

export interface SubmitAnswerResult {
  ok: boolean;
  error?: string;
}

/**
 * Persist one review answer (Wave 6.1). Auth is the ssr HttpOnly session
 * (fail-closed); the write goes through the submit_review_answer RPC under
 * the caller's RLS identity — the client never touches the table directly.
 */
export async function submitReviewAnswerAction(
  itemId: string,
  choice: string | null,
  freeText: string | null,
): Promise<SubmitAnswerResult> {
  const session = await getPortalSession();
  if (!session) return { ok: false, error: "Your session expired — reload the page to sign in again." };
  const trimmedChoice = choice?.trim() || null;
  const trimmedText = freeText?.trim() || null;
  if (!trimmedChoice && !trimmedText) return { ok: false, error: "Choose an option or write the correct fact first." };

  const { error } = await session.supabase.rpc("submit_review_answer", {
    item_id: itemId,
    choice: trimmedChoice,
    free_text: trimmedText,
  });
  if (error) {
    console.error("[review] submit_review_answer failed:", error.message);
    return { ok: false, error: "Could not save your answer — please try again." };
  }
  // The dashboard Step 1 status derives from review_answers — refresh it.
  revalidatePath("/creator/dashboard");
  return { ok: true };
}
