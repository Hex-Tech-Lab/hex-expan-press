/**
 * ExpanPress palette — the EXACT existing colors from the legacy static site.
 * Ported verbatim from web/index.html tailwind.config (2026-09-27 landing).
 * Do not invent colors here; design decisions route through the founder.
 */
export const palette = {
  canvas: "#F9F6F0",
  charcoal: "#181818",
  peach: "#FF9E80",
} as const;

export type PaletteKey = keyof typeof palette;
