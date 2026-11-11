// Handle validation. The rule itself lives in creator-handle.ts (the database rule, not a new one).
// web/src/lib/__tests__/handle_rule.test.ts reads the migration and fails if the two drift apart.
import { CREATOR_HANDLE_MAX, CREATOR_HANDLE_MIN, CREATOR_HANDLE_RE } from "./creator-handle";

export const HANDLE_RE = CREATOR_HANDLE_RE;

export type HandleCheck = { ok: true; handle: string } | { ok: false; reason: string };

export function validateHandle(raw: string): HandleCheck {
  if (raw.length === 0) return { ok: false, reason: "Enter a handle." };
  if (!HANDLE_RE.test(raw)) {
    return {
      ok: false,
      reason: `Use ${CREATOR_HANDLE_MIN} to ${CREATOR_HANDLE_MAX} lowercase letters, numbers, underscores or hyphens.`,
    };
  }
  return { ok: true, handle: raw };
}
