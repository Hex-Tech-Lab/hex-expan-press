import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadBookIdentity } from "../book_identity";
import {
  flagValue,
  loadSyncConfigFromDb,
  normaliseBookRef,
  runSync,
  selectSyncTarget,
  type BookRegistryRow,
  type CliEnv,
  type SyncConfig,
} from "../sync_book_identity";
import { GLOBAL } from "../src/settings_registry";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// Duane's row mirrors the live single-book fixture used by book_identity.test.ts.
const DUANE_ROW: BookRegistryRow = {
  id: "57596c19-c550-4bde-b17a-e87b86d005c5",
  store_product_id: "duane",
  book_registry: "books/duane.json",
  paddle_product_ref: "pro_01m3ysqv4cjhxksyqrtfssp4th",
};

// Synthetic ids: no live product uses them.
const QUIET_ROW: BookRegistryRow = {
  id: "00000000-0000-4000-8000-00000000c0de",
  store_product_id: "house_the_quiet_workshop_v1",
  book_registry: "books/the_quiet_workshop.json",
  paddle_product_ref: "pro_TESTQUIETWORKSHOP",
};

const duaneTarget: SyncConfig = {
  book: "books/duane.json",
  db_product_id: DUANE_ROW.id,
  paddle_product_ref: DUANE_ROW.paddle_product_ref ?? "",
};

const quietTarget: SyncConfig = {
  book: "books/the_quiet_workshop.json",
  db_product_id: QUIET_ROW.id,
  paddle_product_ref: QUIET_ROW.paddle_product_ref ?? "",
};

const quietIdentity = loadBookIdentity(join(repoRoot, "books", "the_quiet_workshop.json"));
const duaneIdentity = loadBookIdentity(join(repoRoot, "books", "duane.json"));

const ENV_OK: CliEnv = {
  SUPABASE_URL: "https://sup.supabase.co",
  SUPABASE_SECRET_KEY: "sk",
  PADDLE_API_KEY: "pdl",
  PADDLE_ENVIRONMENT: "sandbox",
};

/** A fetch stub that answers the --check reads with the given identity, as the remote surfaces would. */
const remoteShowing = (identity: { title: string; subtitle: string }): typeof fetch =>
  (async (url: string | URL | Request) => {
    const body = String(url).includes("rest/v1/products")
      ? [{ title: identity.title }]
      : { data: { id: quietTarget.paddle_product_ref, name: identity.title, description: identity.subtitle } };
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;

describe("normaliseBookRef", () => {
  it("maps a bare book id and a registry path to the same repo-relative file", () => {
    expect(normaliseBookRef("the_quiet_workshop")).toBe("books/the_quiet_workshop.json");
    expect(normaliseBookRef("books/the_quiet_workshop.json")).toBe("books/the_quiet_workshop.json");
    expect(normaliseBookRef("books/the_quiet_workshop")).toBe("books/the_quiet_workshop.json");
    expect(normaliseBookRef("./books/duane.json")).toBe("books/duane.json");
  });

  it("rejects references that leave books/", () => {
    expect(() => normaliseBookRef("../secrets.json")).toThrow(/repo-relative books/);
    expect(() => normaliseBookRef("books/../../.env")).toThrow(/repo-relative books/);
    expect(() => normaliseBookRef("/etc/passwd")).toThrow(/repo-relative books/);
    expect(() => normaliseBookRef("elsewhere/x.json")).toThrow(/repo-relative books/);
  });
});

describe("selectSyncTarget: one book (back-compat for Duane)", () => {
  it("selects the only registered row when no selector is given", () => {
    expect(selectSyncTarget([DUANE_ROW], {})).toEqual(duaneTarget);
  });

  it("ignores rows without a book_registry", () => {
    const plain: BookRegistryRow = { ...QUIET_ROW, id: "11111111-1111-4111-8111-111111111111", book_registry: null };
    expect(selectSyncTarget([plain, DUANE_ROW], {})).toEqual(duaneTarget);
  });

  it("refuses an empty row set", () => {
    expect(() => selectSyncTarget([], {})).toThrow(/no products row carries a book_registry — nothing to sync/);
  });
});

describe("selectSyncTarget: two books share the database", () => {
  const rows = [DUANE_ROW, QUIET_ROW];

  it("fails loud with no selector and names both books and the flags to use", () => {
    expect(() => selectSyncTarget(rows, {})).toThrow(/sync target ambiguous/);
    expect(() => selectSyncTarget(rows, {})).toThrow(/books\/duane\.json.*books\/the_quiet_workshop\.json/);
    expect(() => selectSyncTarget(rows, {})).toThrow(/--book <id>/);
  });

  it("selects the quiet workshop by book id", () => {
    expect(selectSyncTarget(rows, { book: "the_quiet_workshop" })).toEqual(quietTarget);
  });

  it("selects Duane by book id, so the existing sync keeps working", () => {
    expect(selectSyncTarget(rows, { book: "duane" })).toEqual(duaneTarget);
  });

  it("selects by registry path as well as by id", () => {
    expect(selectSyncTarget(rows, { book: "books/the_quiet_workshop.json" })).toEqual(quietTarget);
  });

  it("selects by products.id", () => {
    expect(selectSyncTarget(rows, { product: QUIET_ROW.id })).toEqual(quietTarget);
  });

  it("refuses when --book and --product name different books", () => {
    expect(() => selectSyncTarget(rows, { book: "duane", product: QUIET_ROW.id })).toThrow(
      /no products row carries a book_registry matching --book duane --product/,
    );
  });

  it("refuses an unknown book id instead of falling back to another book", () => {
    expect(() => selectSyncTarget(rows, { book: "not_a_book" })).toThrow(
      /no products row carries a book_registry matching --book not_a_book/,
    );
  });

  it("refuses when two rows share a book and --book cannot tell them apart; --product can", () => {
    const twin: BookRegistryRow = { ...QUIET_ROW, id: "00000000-0000-4000-8000-00000000beef" };
    expect(() => selectSyncTarget([QUIET_ROW, twin], { book: "the_quiet_workshop" })).toThrow(
      /2 products rows match --book the_quiet_workshop.*--product/,
    );
    expect(selectSyncTarget([QUIET_ROW, twin], { product: twin.id }).db_product_id).toBe(twin.id);
  });

  it("fails closed when the selected row has no paddle_product_ref", () => {
    const unlinked: BookRegistryRow = { ...QUIET_ROW, paddle_product_ref: null };
    expect(() => selectSyncTarget([unlinked, DUANE_ROW], { book: "the_quiet_workshop" })).toThrow(
      /"paddle_product_ref" must be a non-empty string/,
    );
  });
});

describe("loadSyncConfigFromDb: the row list drives the same selection", () => {
  it("no selector across two books fails loud instead of guessing", async () => {
    await expect(loadSyncConfigFromDb({}, async () => [DUANE_ROW, QUIET_ROW])).rejects.toThrow(/sync target ambiguous/);
  });

  it("--book the_quiet_workshop returns the quiet workshop target", async () => {
    await expect(loadSyncConfigFromDb({ book: "the_quiet_workshop" }, async () => [DUANE_ROW, QUIET_ROW])).resolves.toEqual(
      quietTarget,
    );
  });

  it("a single-book database still syncs with no selector", async () => {
    await expect(loadSyncConfigFromDb({}, async () => [DUANE_ROW])).resolves.toEqual(duaneTarget);
  });
});

describe("runSync with two books", () => {
  it("--check on the quiet workshop target compares against the quiet workshop identity", async () => {
    const result = await runSync(["--book", "the_quiet_workshop", "--check"], ENV_OK, remoteShowing(quietIdentity), quietTarget);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`target: books/the_quiet_workshop.json (products.id ${QUIET_ROW.id})`);
  });

  it("--check reports a mismatch when the remote still carries the other book's identity", async () => {
    const result = await runSync(["--check"], ENV_OK, remoteShowing(duaneIdentity), quietTarget);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.join("\n")).toMatch(/supabase title mismatch/);
  });

  it("a selector that names the other book refuses before any network call", async () => {
    let calls = 0;
    const fetchMock = (async () => {
      calls += 1;
      return new Response("[]", { status: 200 });
    }) as typeof fetch;
    await expect(runSync(["--book", "duane", "--check"], ENV_OK, fetchMock, quietTarget)).rejects.toThrow(
      /no products row carries a book_registry matching --book duane/,
    );
    expect(calls).toBe(0);
  });

  it("a flag with no value fails closed before any network call", async () => {
    let calls = 0;
    const fetchMock = (async () => {
      calls += 1;
      return new Response("[]", { status: 200 });
    }) as typeof fetch;
    await expect(runSync(["--book"], ENV_OK, fetchMock, quietTarget)).rejects.toThrow(/--book requires a value/);
    await expect(runSync(["--book", "--check"], ENV_OK, fetchMock, quietTarget)).rejects.toThrow(/--book requires a value/);
    expect(calls).toBe(0);
  });
});

describe("flagValue", () => {
  it("returns undefined when the flag is absent and the value when present", () => {
    expect(flagValue(["--check"], "--book")).toBeUndefined();
    expect(flagValue(["--book", "duane"], "--book")).toBe("duane");
  });
});

describe("registry: the products row-read limit is a registry setting", () => {
  it("is a positive integer within its declared bounds", () => {
    const limit = GLOBAL.payments.sync_products_query_limit;
    expect(Number.isInteger(limit)).toBe(true);
    expect(limit).toBeGreaterThanOrEqual(1);
    expect(limit).toBeLessThanOrEqual(5000);
  });
});
