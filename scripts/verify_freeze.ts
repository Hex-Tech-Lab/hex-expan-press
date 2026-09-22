// scripts/verify_freeze.ts — fails loudly if the environment has drifted from tech-freeze.json.  pnpm freeze:check
import { execFileSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
const F = JSON.parse(fs.readFileSync("tech-freeze.json", "utf8"));
let bad = 0;
const ok = (m: string) => console.log(`ok    ${m}`);
const fail = (m: string) => { bad++; console.log(`DRIFT ${m}`); };
const run = (c: string, a: string[]) => { try { return execFileSync(c, a, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return ""; } };
const sha = (p: string) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const home = (p: string) => p.replace(/^~/, process.env.HOME ?? "");

const node = process.version.replace(/^v/, "");
node === F.runtime.node ? ok(`node ${node}`) : fail(`node ${node}, frozen ${F.runtime.node}`);
const pn = run("pnpm", ["--version"]);
pn === F.runtime.pnpm ? ok(`pnpm ${pn}`) : fail(`pnpm ${pn}, frozen ${F.runtime.pnpm}`);
const py = run("python3", ["--version"]).replace("Python ", "");
py === F.runtime.python ? ok(`python ${py}`) : fail(`python ${py}, frozen ${F.runtime.python}`);

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const deps = { ...pkg.dependencies, ...pkg.devDependencies };
for (const [k, v] of Object.entries<string>(F.npm_exact)) {
  if (deps[k] !== v) { fail(`package.json ${k}=${deps[k]}, frozen exactly ${v} (no ^ or ~)`); continue; }
  const installed = JSON.parse(fs.readFileSync(path.join("node_modules", k, "package.json"), "utf8")).version;
  installed === v ? ok(`${k} ${v}`) : fail(`${k} installed ${installed}, frozen ${v}`);
}
for (const k of Object.keys(deps)) if (!(k in F.npm_exact)) fail(`package.json has ${k}, which is not in tech-freeze.json`);

const t = F.binaries.typst;
if (!fs.existsSync(t.path)) fail(`typst missing at ${t.path}`);
else { const v = run(t.path, ["--version"]); v.startsWith(`typst ${t.version} `) ? ok(v) : fail(`typst says "${v}", frozen ${t.version}`); sha(t.path) === t.sha256 ? ok("typst sha256") : fail("typst binary sha256 changed"); }
const y = F.binaries["yt-dlp"], yp = home(y.path);
if (!fs.existsSync(yp)) fail("yt-dlp missing");
else { const v = run(yp, ["--version"]); v === y.version ? ok(`yt-dlp ${v}`) : fail(`yt-dlp ${v}, frozen ${y.version}`); sha(yp) === y.sha256 ? ok("yt-dlp sha256") : fail("yt-dlp binary sha256 changed (did something run -U?)"); }
const oc = run(home("~/.opencode/bin/opencode"), ["--version"]);
oc === F.binaries.opencode.version ? ok(`opencode ${oc}`) : fail(`opencode ${oc}, frozen ${F.binaries.opencode.version}`);
for (const n of F.non_conforming ?? []) console.log(`WARN  known non-conforming: ${n.tool} ${n.installed} (${n.problem}); ${n.action}`);
console.log(bad ? `\n${bad} drift(s). The stack is NOT frozen as recorded.` : "\nfrozen stack verified.");
process.exit(bad ? 1 : 0);
