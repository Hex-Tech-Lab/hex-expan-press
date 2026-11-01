// Pages measured in a real browser. Ids are what the ingest route accepts.
// Matches the real-browser workflow (feat/real-browser-latency): home, storefront, playbook.
// Add a page here only with the owner's approval.
export const PAGES = [
  { id: "expanpress-home", label: "ExpanPress home" },
  { id: "expanpress-storefront", label: "ExpanPress storefront" },
  { id: "expanpress-playbook", label: "ExpanPress playbook" },
] as const;

export const SOURCES = ["sitespeed.io", "webpagetest"] as const;

// Metric names follow sitespeed.io. ttfb = time to first byte, firstContentfulPaint, largestContentfulPaint,
// pageLoadTime = time until the load event (the "total" for a browser run).
export const METRICS = ["ttfb", "firstContentfulPaint", "largestContentfulPaint", "pageLoadTime"] as const;
