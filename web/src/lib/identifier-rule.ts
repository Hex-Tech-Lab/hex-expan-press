// One identifier rule, built from the settings registry (ADR 0065). Used for creator handles and product slugs.
// The DB CHECK constraints carry the same rule in SQL; web/src/lib/__tests__/identifier-rule.test.ts pins the two together.
import { z } from "zod";

export type IdentifierRule = { min_length: number; max_length: number; separator: string };

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Lowercase letters and digits, joined by single separators, length-bounded. */
export function identifierSchema(rule: IdentifierRule) {
  const segment = "[a-z0-9]+";
  const sep = escapeRegExp(rule.separator);
  return z
    .string()
    .min(rule.min_length)
    .max(rule.max_length)
    .regex(new RegExp(`^${segment}(?:${sep}${segment})*$`));
}
