// Zod schemas for identifiers on the purchase and review paths (ADR 0065).
// Product slug shape comes from the settings registry (product_slug). Guid is the 8-4-4-4-12 hex form.
import { z } from "zod";
import { GLOBAL } from "../../../payments/src/settings_registry";
import { identifierSchema } from "./identifier-rule";
import { handleSchema } from "./handle-shape";

export const productSlugSchema = identifierSchema(GLOBAL.product_slug);
export const guidSchema = z.guid();
export const creatorHandleSchema = handleSchema;
/** The handle form of a product reference: `<creator handle>/<product slug>`, both parts on the agreed rules (ADR 0065). */
export const productHandleRefSchema = z.string().refine((ref) => {
  const parts = ref.split("/");
  return parts.length === 2 && creatorHandleSchema.safeParse(parts[0]).success && productSlugSchema.safeParse(parts[1]).success;
}, "expected <creator handle>/<product slug>");
/** A product reference in a URL: a bare slug (shape-checked; the route decides whether it may resolve), its id (guid), or the handle form. */
export const productRefSchema = z.union([productSlugSchema, guidSchema, productHandleRefSchema]);
/** Sign-in email (O5): zod's email check, length-bounded by the registry (email_address.max_length). */
export const emailSchema = z.email().max(GLOBAL.email_address.max_length);
