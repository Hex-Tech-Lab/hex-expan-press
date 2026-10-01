// Root lint (src/, payments/) — ESLint 9 flat config.
// Root compiles with TypeScript 7, which typescript-eslint does not support yet
// (typescript-eslint#10940). So the TypeScript rules are taken from web's
// eslint-config-next preset, resolved FROM web/ so its bundled typescript-eslint
// binds to web's TypeScript 6. Switch back to a root typescript-eslint dependency
// once it supports TS >= 7.
import { createRequire } from "node:module";

const requireFromWeb = createRequire(new URL("./web/package.json", import.meta.url));
const { default: nextTypescript } = await import(requireFromWeb.resolve("eslint-config-next/typescript"));

export default [
  { ignores: ["**/node_modules/**", "web/**", "data/**", "coverage/**"] },
  ...nextTypescript,
];
