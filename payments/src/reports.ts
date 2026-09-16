import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig, type ProductConfig } from "./settings.ts";
import { GLOBAL } from "./settings_registry.ts";
import { formatUsd, usdToCents } from "./split.ts";

// settings registry: global.json paths.* (inline fallbacks keep standalone runs working)
const DEFAULT_SALES_FILE: string = GLOBAL.paths.sales_ledger;
const DEFAULT_REPORTS_DIR: string = GLOBAL.paths.reports_dir;

export interface SaleLine {
  ts: string;
  sale_id: string;
  provider: string;
  product_id: string;
  amount_usd: number;
  creator_id: string;
  creator_split_pct?: number;
  creator_split_usd: number;
  our_split_usd: number;
  currency: string;
  event_type?: "sale" | "refund";
}

export type TitleMap = Map<string, string>;

interface Totals {
  count: number;
  refunds: number;
  gross: number;
  creator: number;
  ours: number;
}

const emptyTotals = (): Totals => ({ count: 0, refunds: 0, gross: 0, creator: 0, ours: 0 });

function addTotals(t: Totals, s: SaleLine): void {
  if (s.event_type === "refund") {
    t.refunds += 1;
    t.gross -= usdToCents(s.amount_usd);
    t.creator += usdToCents(s.creator_split_usd);
    t.ours += usdToCents(s.our_split_usd);
    return;
  }
  t.count += 1;
  t.gross += usdToCents(s.amount_usd);
  t.creator += usdToCents(s.creator_split_usd);
  t.ours += usdToCents(s.our_split_usd);
}

function mdCell(v: string): string {
  return v.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

const dayOf = (ts: string): string => new Date(ts).toISOString().slice(0, 10);

function isoWeekOf(ts: string): { label: string; start: string; end: string } {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) throw new Error(`reports: unparseable timestamp ${ts}`);
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - dow);
  const yearStart = Date.UTC(t.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((t.getTime() - yearStart) / 86_400_000 + 1) / 7);
  const monday = new Date(t);
  monday.setUTCDate(monday.getUTCDate() - 3);
  const sunday = new Date(t);
  sunday.setUTCDate(sunday.getUTCDate() + 3);
  const iso = (x: Date): string => x.toISOString().slice(0, 10);
  return { label: `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`, start: iso(monday), end: iso(sunday) };
}

const safeFilePart = (v: string): string => v.replace(/[^A-Za-z0-9._-]+/g, "_");

export function loadSales(salesFile: string): SaleLine[] {
  if (!existsSync(salesFile)) {
    console.error(`[reports] no ledger at ${salesFile} — treating as zero sales`);
    return [];
  }
  const sales: SaleLine[] = [];
  const lines = readFileSync(salesFile, "utf8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === "") continue;
    try {
      const o = JSON.parse(line) as Record<string, unknown>;
      const s = o as Partial<SaleLine>;
      const bad = (why: string): never => {
        throw new Error(why);
      };
      if (typeof s.ts !== "string" || Number.isNaN(Date.parse(s.ts))) bad("ts missing/unparseable");
      if (typeof s.sale_id !== "string" || s.sale_id === "") bad("sale_id missing");
      if (typeof s.provider !== "string" || s.provider === "") bad("provider missing");
      if (typeof s.product_id !== "string" || s.product_id === "") bad("product_id missing");
      if (typeof s.creator_id !== "string" || s.creator_id === "") bad("creator_id missing");
      if (typeof s.amount_usd !== "number" || !Number.isFinite(s.amount_usd)) bad("amount_usd missing/non-finite");
      if (typeof s.creator_split_usd !== "number" || !Number.isFinite(s.creator_split_usd)) bad("creator_split_usd missing/non-finite");
      if (typeof s.our_split_usd !== "number" || !Number.isFinite(s.our_split_usd)) bad("our_split_usd missing/non-finite");
      if (s.creator_split_pct !== undefined) {
        if (typeof s.creator_split_pct !== "number" || !Number.isFinite(s.creator_split_pct) || s.creator_split_pct < 0 || s.creator_split_pct > 100) {
          bad("creator_split_pct invalid (must be a finite number within 0-100 when present)");
        }
      }
      if (s.event_type !== undefined && s.event_type !== "sale" && s.event_type !== "refund") bad("event_type invalid (must be \"sale\" or \"refund\" when present)");
      sales.push(s as SaleLine);
    } catch (err) {
      console.error(`[reports] skipping ${salesFile}:${i + 1}: ${(err as Error).message}`);
    }
  }
  return sales.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.sale_id < b.sale_id ? -1 : 1));
}

export function loadTitles(configPaths: string[]): TitleMap {
  const titles: TitleMap = new Map();
  for (const p of configPaths) {
    const c: ProductConfig = loadConfig(p);
    if (titles.has(c.product_id)) {
      console.error(`[reports] duplicate config for product_id "${c.product_id}" — keeping later file (${p})`);
    }
    titles.set(c.product_id, c.title);
  }
  return titles;
}

const productLabel = (productId: string, titles: TitleMap): string => titles.get(productId) ?? productId;

function moneyRow(s: SaleLine, titles: TitleMap, time: string): string {
  if (s.event_type === "refund") {
    const backSuffix = typeof s.creator_split_pct === "number" ? ` (${s.creator_split_pct}% back to creator)` : "";
    return `| ${mdCell(time)} | ${mdCell(s.sale_id)} | ${mdCell(productLabel(s.product_id, titles))} | ${formatUsd(-usdToCents(s.amount_usd))} refund | ${formatUsd(usdToCents(s.creator_split_usd))}${backSuffix} | ${formatUsd(usdToCents(s.our_split_usd))} |`;
  }
  const pctSuffix = typeof s.creator_split_pct === "number" ? ` (${s.creator_split_pct}%)` : "";
  return `| ${mdCell(time)} | ${mdCell(s.sale_id)} | ${mdCell(productLabel(s.product_id, titles))} | ${formatUsd(usdToCents(s.amount_usd))} | ${formatUsd(usdToCents(s.creator_split_usd))}${pctSuffix} | ${formatUsd(usdToCents(s.our_split_usd))} |`;
}

function totalsRow(label: string, t: Totals): string {
  const refundPart = t.refunds > 0 ? `, ${t.refunds} refund${t.refunds === 1 ? "" : "s"}` : "";
  return `| | | **${label} (${t.count} sale${t.count === 1 ? "" : "s"}${refundPart})** | **${formatUsd(t.gross)}** | **${formatUsd(t.creator)}** | **${formatUsd(t.ours)}** |`;
}

export function runDaily(opts: { date: string; sales: SaleLine[]; titles: TitleMap; reportsDir: string }): string[] {
  const { date, sales, titles, reportsDir } = opts;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`reports: --date must be YYYY-MM-DD (got ${date})`);
  const byCreator = new Map<string, SaleLine[]>();
  for (const s of sales) {
    if (dayOf(s.ts) !== date) continue;
    const list = byCreator.get(s.creator_id) ?? [];
    list.push(s);
    byCreator.set(s.creator_id, list);
  }
  if (byCreator.size === 0) {
    console.error(`[reports] daily: no sales for ${date} — nothing written`);
    return [];
  }
  mkdirSync(reportsDir, { recursive: true });
  const written: string[] = [];
  for (const creatorId of [...byCreator.keys()].sort()) {
    const rows = byCreator.get(creatorId) as SaleLine[];
    const totals = emptyTotals();
    const tableRows = rows.map((s) => {
      addTotals(totals, s);
      return moneyRow(s, titles, s.ts.slice(11, 16));
    });
    if (totals.creator + totals.ours !== totals.gross) {
      console.error(`[reports] WARNING: split columns do not sum to gross for creator ${creatorId} on ${date}`);
    }
    const md = [
      `# Daily sales — ${creatorId} — ${date} (UTC)`,
      "",
      `| Time | Sale ID | Product | Gross | Creator split | Our split |`,
      `| --- | --- | --- | ---: | ---: | ---: |`,
      ...tableRows,
      totalsRow("Totals", totals),
      "",
    ].join("\n") + "\n";
    const path = join(reportsDir, `creator_${safeFilePart(creatorId)}_${date}.md`);
    writeFileSync(path, md);
    written.push(path);
  }
  return written;
}

export function runWeekly(opts: { date: string; sales: SaleLine[]; titles: TitleMap; reportsDir: string }): string {
  const { date, sales, titles, reportsDir } = opts;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`reports: --date must be YYYY-MM-DD (got ${date})`);
  const { label, start, end } = isoWeekOf(`${date}T12:00:00Z`);
  const inWeek = sales.filter((s) => isoWeekOf(s.ts).label === label);
  const byCreator = new Map<string, Totals>();
  const byProduct = new Map<string, Totals>();
  const grand = emptyTotals();
  for (const s of inWeek) {
    const c = byCreator.get(s.creator_id) ?? emptyTotals();
    addTotals(c, s);
    byCreator.set(s.creator_id, c);
    const p = byProduct.get(productLabel(s.product_id, titles)) ?? emptyTotals();
    addTotals(p, s);
    byProduct.set(productLabel(s.product_id, titles), p);
    addTotals(grand, s);
  }
  const mdLines: string[] = [
    `# Weekly compound — ${label} (Mon ${start} → Sun ${end}, UTC)`,
    "",
  ];
  if (inWeek.length === 0) {
    mdLines.push("(no sales recorded this week)", "");
  } else {
    mdLines.push("## Totals by creator", "", `| Creator | Sales | Gross | Creator splits | Our splits |`, `| --- | ---: | ---: | ---: | ---: |`);
    for (const id of [...byCreator.keys()].sort()) {
      const t = byCreator.get(id) as Totals;
      if (t.creator + t.ours !== t.gross) console.error(`[reports] WARNING: split columns do not sum to gross for creator ${id} in ${label}`);
      mdLines.push(`| ${mdCell(id)} | ${t.count} | ${formatUsd(t.gross)} | ${formatUsd(t.creator)} | ${formatUsd(t.ours)} |`);
    }
    mdLines.push(`| **Total** | **${grand.count}** | **${formatUsd(grand.gross)}** | **${formatUsd(grand.creator)}** | **${formatUsd(grand.ours)}** |`, "");
    mdLines.push("## Totals by product", "", `| Product | Sales | Gross | Creator splits | Our splits |`, `| --- | ---: | ---: | ---: | ---: |`);
    for (const p of [...byProduct.keys()].sort()) {
      const t = byProduct.get(p) as Totals;
      mdLines.push(`| ${mdCell(p)} | ${t.count} | ${formatUsd(t.gross)} | ${formatUsd(t.creator)} | ${formatUsd(t.ours)} |`);
    }
    mdLines.push(`| **Total** | **${grand.count}** | **${formatUsd(grand.gross)}** | **${formatUsd(grand.creator)}** | **${formatUsd(grand.ours)}** |`, "");
  }
  mkdirSync(reportsDir, { recursive: true });
  const path = join(reportsDir, `compound_${label}.md`);
  writeFileSync(path, mdLines.join("\n") + "\n");
  return path;
}

function printUsage(): string {
  return [
    "payments reports — markdown sales reports from the append-only ledger",
    "",
    "usage: tsx payments/src/reports.ts --daily|--weekly [--date=YYYY-MM-DD]",
    "                                      [--sales-file=path] [--reports-dir=dir]",
    "                                      [--config=path]... (repeatable, resolves product titles)",
    "",
    `defaults: --date=today (UTC), --sales-file=${DEFAULT_SALES_FILE}, --reports-dir=${DEFAULT_REPORTS_DIR}`,
  ].join("\n");
}

interface CliArgs {
  mode: "daily" | "weekly" | null;
  date: string | null;
  salesFile: string;
  reportsDir: string;
  configs: string[];
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { mode: null, date: null, salesFile: DEFAULT_SALES_FILE, reportsDir: DEFAULT_REPORTS_DIR, configs: [], help: false };
  for (const raw of argv) {
    if (raw === "--daily" || raw === "--weekly") {
      if (args.mode !== null) throw new Error("pick only one mode: --daily or --weekly");
      args.mode = raw === "--daily" ? "daily" : "weekly";
      continue;
    }
    if (raw === "--help" || raw === "-h") {
      args.help = true;
      continue;
    }
    const eq = raw.indexOf("=");
    if (!raw.startsWith("--") || eq === -1) {
      throw new Error(`unsupported argument "${raw}" — use --key=value flags`);
    }
    const key = raw.slice(2, eq);
    const val = raw.slice(eq + 1);
    if (val === "") throw new Error(`--${key} requires a value`);
    switch (key) {
      case "date":
        args.date = val;
        break;
      case "sales-file":
        args.salesFile = val;
        break;
      case "reports-dir":
        args.reportsDir = val;
        break;
      case "config":
        args.configs.push(val);
        break;
      default:
        throw new Error(`unknown flag --${key}`);
    }
  }
  if (args.mode === null && !args.help) throw new Error("pick one mode: --daily or --weekly");
  return args;
}

function main(): void {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`[reports] ${(err as Error).message}\n\n${printUsage()}`);
    process.exit(2);
  }
  if (args.help) {
    console.log(printUsage());
    return;
  }
  const date = args.date ?? new Date().toISOString().slice(0, 10);
  try {
    const sales = loadSales(args.salesFile);
    const titles = loadTitles(args.configs);
    if (args.mode === "daily") {
      for (const f of runDaily({ date, sales, titles, reportsDir: args.reportsDir })) {
        console.log(`[reports] wrote ${f}`);
      }
    } else {
      console.log(`[reports] wrote ${runWeekly({ date, sales, titles, reportsDir: args.reportsDir })}`);
    }
  } catch (err) {
    console.error(`[reports] ${(err as Error).message}`);
    process.exit(2);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
