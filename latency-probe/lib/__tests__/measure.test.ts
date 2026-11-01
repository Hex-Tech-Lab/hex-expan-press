import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { measureAll } from "../measure";

// A local server that answers like a Vercel edge: cache headers on the first response, and a redirect
// to check that the first hop's facts are the ones kept.
function startServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    if (req.url === "/redirect") {
      res.writeHead(302, { location: "/final", "x-vercel-cache": "MISS", "x-vercel-id": "cdg1::redirect-1" });
      res.end();
      return;
    }
    if (req.url === "/final") {
      res.writeHead(200, { "x-vercel-cache": "STALE", "x-vercel-id": "sfo1::final-2", age: "99" });
      res.end("ok");
      return;
    }
    res.writeHead(200, { "x-vercel-cache": "HIT", "x-vercel-id": "fra1::page-3", age: "46892", "content-type": "text/plain" });
    res.end("hello");
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    }),
  );
}

const loc = [{ id: "test", label: "Test" }];

test("a cached response keeps its cache state, region and age", async () => {
  const srv = await startServer();
  try {
    const out = await measureAll([{ id: "page", url: `${srv.url}/`, why: "test" }], loc);
    const s = out.test.page;
    assert.equal(s.s, 200);
    assert.equal(s.c, "HIT");
    assert.equal(s.ed, "fra1");
    assert.equal(s.ag, 46892);
    assert.equal(s.e, null);
  } finally {
    await srv.close();
  }
});

test("with a redirect, the facts come from the first response", async () => {
  const srv = await startServer();
  try {
    const out = await measureAll([{ id: "r", url: `${srv.url}/redirect`, why: "test" }], loc);
    const s = out.test.r;
    assert.equal(s.r, 1, "one redirect followed");
    assert.equal(s.s, 200);
    assert.equal(s.c, "MISS", "first hop's cache state");
    assert.equal(s.ed, "cdg1", "first hop's region");
    assert.equal(s.ag, null, "first hop had no age");
  } finally {
    await srv.close();
  }
});

test("a transport error leaves the new fields null", async () => {
  const out = await measureAll([{ id: "dead", url: "http://127.0.0.1:1/", why: "test" }], loc);
  const s = out.test.dead;
  assert.equal(s.s, null);
  assert.equal(s.c, null);
  assert.equal(s.ed, null);
  assert.equal(s.ag, null);
  assert.notEqual(s.e, null);
});
