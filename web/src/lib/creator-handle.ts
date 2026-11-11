// Creator handle charset: the single source for the rule the database enforces on creators.handle
// (supabase/migrations/20260926000000_creator_portal.sql). Storefront and handle checks both import this.
export const CREATOR_HANDLE_MIN = 2;
export const CREATOR_HANDLE_MAX = 64;
export const CREATOR_HANDLE_RE = new RegExp(`^[a-z0-9_-]{${CREATOR_HANDLE_MIN},${CREATOR_HANDLE_MAX}}$`);
