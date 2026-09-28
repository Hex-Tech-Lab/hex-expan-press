// Regenerates web/app/creator/dashboard/astryx-tokens.css from the installed
// @astryxdesign/theme-neutral package. Run: node scripts/extract_astryx_tokens.mjs
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { neutralTheme } = require("../web/node_modules/@astryxdesign/theme-neutral");
const lines = Object.entries(neutralTheme.tokens).map(([k, v]) => `  ${k}: ${v};`);
const header = `/* GENERATED from @astryxdesign/theme-neutral (neutralTheme.tokens) —
   build-time extraction; regenerate via scripts/extract_astryx_tokens.mjs.
   Consumed by the creator portal via Tailwind v4 var syntax. */
:root {
`;
writeFileSync("web/app/creator/dashboard/astryx-tokens.css", header + lines.join("\n") + "\n}\n");
console.log("tokens emitted:", lines.length);
