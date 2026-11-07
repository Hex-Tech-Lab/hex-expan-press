import { describe, expect, test } from "vitest";
import * as fs from "fs";
import { fileURLToPath } from "url";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const pkg = JSON.parse(fs.readFileSync(`${repo}package.json`, "utf8")) as { devDependencies: Record<string, string> };
const lock = fs.readFileSync(`${repo}pnpm-lock.yaml`, "utf8");

// The root devDependencies the qa-intel toolchain runs on. A caret range lets a fresh install move them.
const PINNED = ["ts-morph", "glob", "vitest"] as const;

describe("qa-intel toolchain devDependencies are exact and agree with the lockfile", () => {
  test.each(PINNED)("%s is pinned to an exact version", (name) => {
    expect(pkg.devDependencies[name]).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test.each(PINNED)("%s specifier in pnpm-lock.yaml is the same exact version", (name) => {
    const match = lock.match(new RegExp(`\\n      ${name}:\\n        specifier: (\\S+)\\n`));
    expect(match?.[1]).toBe(pkg.devDependencies[name]);
  });
});
