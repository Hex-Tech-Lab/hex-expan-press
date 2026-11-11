import { vi } from "vitest";

export interface HarnessOptions {
  files?: Array<{ name: string; id?: string | null; metadata?: Record<string, unknown> }>;
  /** Bytes served by the Supabase object GET. */
  downloadBlob?: Blob | null;
  /** ETag served with those bytes. Defaults to "src-v1", the ETag the harness serves on the object GET. */
  sourceEtag?: string;
  fetchImpl?: typeof fetch;
}

export function makeSyncTestHarness(opts: HarnessOptions = {}) {
  const logs: string[] = [];
  const testLogger = {
    log: (msg: string) => logs.push(msg),
    warn: (msg: string) => logs.push(msg),
    error: (msg: string) => logs.push(msg),
  };

  const listMock = vi.fn().mockResolvedValue({
    data: opts.files ?? [],
    error: null,
  });

  // The Supabase object GET: bytes and ETag come from one response, as in production.
  const sourceFetch = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () =>
    new Response(opts.downloadBlob ?? null, {
      status: 200,
      headers: { etag: opts.sourceEtag ?? '"src-v1"' },
    }),
  );

  const fakeClient = {
    storage: {
      from: vi.fn(() => ({
        list: listMock,
      })),
    },
  };

  const fetchImpl =
    opts.fetchImpl ?? vi.fn().mockResolvedValue(new Response(null, { status: 200 }));

  return {
    fakeClient,
    listMock,
    sourceFetch,
    fetchImpl,
    testLogger,
    logs,
  };
}

export const dummyR2Env = {
  R2_ACCOUNT_ID: "acc-123",
  R2_ACCESS_KEY_ID: "key-123",
  R2_SECRET_ACCESS_KEY: "secret-123",
  R2_BUCKET_NAME: "r2-bucket",
  SUPABASE_URL: "https://test.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "test-service-key",
};

// Shared per-test setup for the sync-supabase-to-r2 suites: clears mocks and sets the R2/Supabase env.
export function resetSyncTestEnv(): void {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  delete process.env.SUPABASE_SECRET_KEY;
  delete process.env.CLOUDFLARE_R2_ACCOUNT_ID;
  delete process.env.CLOUDFLARE_ACCOUNT_ID;
  delete process.env.CLOUDFLARE_R2_ACCESS_KEY_ID;
  delete process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY;
  delete process.env.CLOUDFLARE_R2_BUCKET;
  delete process.env.CLOUDFLARE_R2_BUCKET_NAME;
  // Host-only vars the source reads: clear them so the suite never depends on the developer's shell.
  delete process.env.SUPABASE_STORAGE_BUCKET;
  delete process.env.R2_ENDPOINT;
  delete process.env.R2_REGION;
  for (const [k, v] of Object.entries(dummyR2Env)) {
    vi.stubEnv(k, v);
  }
}
