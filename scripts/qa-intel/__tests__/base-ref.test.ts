import { describe, expect, test } from "vitest";
import { resolveDefaultBaseRef, type GitRun } from "../base-ref";
import { QA_INTEL_CONFIG } from "../config";

/** A fake git: `existing` lists refs that exist; `symbolic` is the origin/HEAD answer (or a throw). */
function fakeGit(opts: { symbolic?: string | "throw"; existing?: string[] }): GitRun {
  return (args) => {
    if (args[0] === "symbolic-ref") {
      if (opts.symbolic === "throw" || opts.symbolic === undefined) throw new Error("no origin/HEAD");
      return opts.symbolic;
    }
    if (args[0] === "rev-parse") {
      const ref = args[args.length - 1];
      if ((opts.existing ?? []).includes(ref)) return ref;
      throw new Error(`unknown ref ${ref}`);
    }
    throw new Error(`unexpected git call ${args.join(" ")}`);
  };
}

describe("resolveDefaultBaseRef", () => {
  test("uses origin/HEAD when git records it", () => {
    expect(resolveDefaultBaseRef(fakeGit({ symbolic: "origin/master\n" }))).toBe("origin/master");
  });

  test("falls through to candidates when origin/HEAD is empty", () => {
    expect(resolveDefaultBaseRef(fakeGit({ symbolic: "  ", existing: ["refs/remotes/origin/main"] }), ["origin/main"])).toBe("origin/main");
  });

  test("falls through to candidates when origin/HEAD is not recorded", () => {
    expect(resolveDefaultBaseRef(fakeGit({ existing: ["refs/remotes/origin/master"] }), ["origin/master"])).toBe("origin/master");
  });

  test("skips a missing candidate and takes the next one that exists", () => {
    const git = fakeGit({ existing: ["refs/remotes/origin/main"] });
    expect(resolveDefaultBaseRef(git, ["origin/master", "origin/main"])).toBe("origin/main");
  });

  test("uses the configured candidate list by default", () => {
    const existing = [`refs/remotes/${QA_INTEL_CONFIG.baseRefCandidates[0]}`];
    expect(resolveDefaultBaseRef(fakeGit({ existing }))).toBe(QA_INTEL_CONFIG.baseRefCandidates[0]);
  });

  test("throws, naming what it tried, when no base exists", () => {
    expect(() => resolveDefaultBaseRef(fakeGit({}), ["origin/master", "origin/main"])).toThrow(
      "no diff base found. Tried origin/HEAD, then origin/master, origin/main",
    );
  });
});
