export interface Split {
  creator_split_usd: number;
  our_split_usd: number;
}

export function usdToCents(usd: number): number {
  if (typeof usd !== "number" || !Number.isFinite(usd)) {
    throw new TypeError(`split: amount must be a finite number (got ${String(usd)})`);
  }
  return Math.round(usd * 100);
}

export function centsToUsd(cents: number): number {
  return cents / 100;
}

export function formatUsd(cents: number): string {
  const abs = Math.abs(Math.round(cents));
  let dollars = String(Math.floor(abs / 100));
  let grouped = "";
  while (dollars.length > 3) {
    grouped = "," + dollars.slice(-3) + grouped;
    dollars = dollars.slice(0, -3);
  }
  const centsPart = String(abs % 100).padStart(2, "0");
  return `${cents < 0 ? "-" : ""}$${dollars}${grouped}.${centsPart}`;
}

export function computeSplit(amount_usd: number, creator_split_pct: number): Split {
  if (typeof creator_split_pct !== "number" || !Number.isFinite(creator_split_pct) || creator_split_pct < 0 || creator_split_pct > 100) {
    throw new TypeError(`split: creator_split_pct must be a number within 0-100 (got ${String(creator_split_pct)})`);
  }
  const totalCents = usdToCents(amount_usd);
  if (totalCents < 0) {
    throw new TypeError(`split: amount_usd must be >= 0 (got ${amount_usd})`);
  }
  const creatorCents = Math.round((totalCents * creator_split_pct) / 100);
  return {
    creator_split_usd: centsToUsd(creatorCents),
    our_split_usd: centsToUsd(totalCents - creatorCents),
  };
}
