/**
 * Shared test transport for FirmaAdapter download-path logic tests.
 *
 * Routes the download through the stubbed GLOBAL fetch, bypassing the
 * pinned dispatcher. The pinned-dispatcher seam itself (production
 * transport + factory + fail-closed lookup) is proven against real local
 * sockets in src/adapters/esign/__tests__/firma.adapter.test.ts — the
 * sprint-13 describe block (DNS-pinned dispatcher, TOCTOU eradication).
 */
import type { DownloadFetch } from "../../src/adapters/esign/firma.adapter";

export const passthroughDownload: DownloadFetch = (url, init) => fetch(url, init);
