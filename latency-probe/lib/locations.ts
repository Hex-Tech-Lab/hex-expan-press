// Where the probe measures from. Only the Vercel iad1 datacentre remains. The residential proxy
// path and the ZenRows check were stopped by owner decision (both were paid sources).
export type Location = { id: string; label: string };

export const LOCATIONS: Location[] = [{ id: "iad1", label: "Vercel iad1, Ashburn VA (baseline)" }];
