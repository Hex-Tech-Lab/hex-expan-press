// Creator handle SHAPE (length, charset, separator). Values come from the settings registry (handles section).
// Used only at creator sign-up (handle-policy.ts). The storefront looks handles up by value and does not check shape.
// The DB CHECK (supabase/migrations/20261113000000_handle_shape.sql) carries the same rule in SQL.
import { GLOBAL } from "../../../payments/src/settings_registry";
import { identifierSchema } from "./identifier-rule";

export const HANDLE_MIN = GLOBAL.handles.min_length;
export const HANDLE_MAX = GLOBAL.handles.max_length;
export const HANDLE_SEPARATOR = GLOBAL.handles.separator;

export const handleSchema = identifierSchema(GLOBAL.handles);
