// Creator handle SHAPE (length, charset, separator). Values come from the settings registry (handles section).
// Imported by handle-policy.ts (creator sign-up) and zod-rules.ts (creatorHandleSchema -> productRefSchema, enforced on /api/billing/checkout). The storefront looks handles up by value and does not check shape.
// The DB CHECK (supabase/migrations/20261112231010_handle_shape.sql) carries the same rule in SQL.
import { GLOBAL } from "../../../payments/src/settings_registry";
import { identifierSchema } from "./identifier-rule";

export const HANDLE_MIN = GLOBAL.handles.min_length;
export const HANDLE_MAX = GLOBAL.handles.max_length;
export const HANDLE_SEPARATOR = GLOBAL.handles.separator;

export const handleSchema = identifierSchema(GLOBAL.handles);
