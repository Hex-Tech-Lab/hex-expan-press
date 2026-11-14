// Single source of truth for the creator handle SHAPE: length, charset and separator.
// Used only at creator sign-up (handle-policy.ts). The storefront looks handles up by value and does not check shape.
// The DB CHECK (supabase/migrations/20261113000000_handle_shape.sql) carries the same rule in SQL.
// Values come from the settings registry (handles section). No profanity or reserved-word logic here.
import { GLOBAL } from "../../../payments/src/settings_registry";

export const HANDLE_MIN = GLOBAL.handles.min_length;
export const HANDLE_MAX = GLOBAL.handles.max_length;
export const HANDLE_SEPARATOR = GLOBAL.handles.separator;

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const SEGMENT = "[a-z0-9]+";
const SEP = escapeRegExp(HANDLE_SEPARATOR);

/** Lowercase letters and digits, joined by single separators. Length-checked by lookahead. */
export const HANDLE_SHAPE_RE = new RegExp(`^(?=.{${HANDLE_MIN},${HANDLE_MAX}}$)${SEGMENT}(?:${SEP}${SEGMENT})*$`);
