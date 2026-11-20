import { addCollection } from "@iconify/react";

// Bundled Lucide set, registered once per page load so icons render from the
// local bundle instead of fetching from the public Iconify API at runtime.
let loading: Promise<void> | null = null;

export function loadLucideIcons(): Promise<void> {
  loading ??= import("@iconify-json/lucide/icons.json").then((m) => {
    const data = (m as { default?: object }).default ?? (m as object);
    addCollection(data as Parameters<typeof addCollection>[0]);
  });
  return loading;
}
