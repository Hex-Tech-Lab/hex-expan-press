-- Creator handle shape: one rule everywhere. Source of truth is the settings registry (handles section):
-- min_length 3, max_length 30, separator "_". The same rule lives in web/src/lib/handle-shape.ts.
-- Letters and digits; underscore is the only separator, and only between segments (no leading, trailing or doubled).
-- Replaces the older creators_handle_check, which allowed hyphens and 2-character handles.
alter table public.creators drop constraint if exists creators_handle_check;
alter table public.creators add constraint creators_handle_check
  check (handle ~ '^[a-z0-9]+(_[a-z0-9]+)*$' and char_length(handle) between 3 and 30);
