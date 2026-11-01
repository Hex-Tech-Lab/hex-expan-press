import { test } from "node:test";
import assert from "node:assert/strict";
import { edgeFacts } from "../edge";

test("reads cache state, region and age from Vercel headers", () => {
  assert.deepEqual(
    edgeFacts({ "x-vercel-cache": "HIT", "x-vercel-id": "fra1::dzlfp-1793570495476-a3c633f34e8e", age: "46892" }),
    { c: "HIT", ed: "fra1", ag: 46892 },
  );
});

test("normalises cache state case and ignores unknown states", () => {
  assert.equal(edgeFacts({ "x-vercel-cache": "miss" }).c, "MISS");
  assert.equal(edgeFacts({ "x-vercel-cache": "something-new" }).c, null);
});

test("region is only taken when it looks like a region code", () => {
  assert.equal(edgeFacts({ "x-vercel-id": "iad1:iad1:sfo1::sfo1::bbj9w-1" }).ed, "iad1");
  assert.equal(edgeFacts({ "x-vercel-id": "<script>::x" }).ed, null);
  assert.equal(edgeFacts({}).ed, null);
});

test("age must be plain digits", () => {
  assert.equal(edgeFacts({ age: "12" }).ag, 12);
  assert.equal(edgeFacts({ age: "12s" }).ag, null);
  assert.equal(edgeFacts({ age: "-5" }).ag, null);
  assert.equal(edgeFacts({ age: "1234567890123" }).ag, null);
});

test("array-valued headers use the first value", () => {
  assert.equal(edgeFacts({ "x-vercel-cache": ["STALE", "HIT"] }).c, "STALE");
});

test("missing headers give nulls, never undefined", () => {
  assert.deepEqual(edgeFacts({}), { c: null, ed: null, ag: null });
});
