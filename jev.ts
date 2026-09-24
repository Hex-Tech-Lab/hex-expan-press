// jev.ts — TypeScript port of scripts/jev.py: minimal client for TypeSafe Jev
// (OpenRouter Decisions API). Typed yes/no ("noul"), choice and score answers with
// calibrated probabilities. Never throws into the caller: any failure (no key,
// provider not allowed, timeout, bad response) resolves null, so every call site
// must keep a fallback path.
//
//   import { decide } from "./jev";
//   const a = await decide({ before, after }, { meaning_kept: { type: "noul", instructions: "...",
//     criteria: { true: "...", false: "..." } } });
//   if (a && a["meaning_kept"].noul > 0.8) ...
//
// Requires OPENROUTER_API_KEY in .env (dotenv with override: true — a stale shell
// export must never shadow the project key) and "TypeSafe" in the account's
// allowed providers.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const here = path.dirname(fileURLToPath(import.meta.url));
// Repo root .env, regardless of cwd; override: true per AGENTS.md stale-shell-key quirk.
dotenv.config({ override: true, path: path.resolve(here, ".env") });

const URL_ = "https://openrouter.ai/api/alpha/decisions";
const MODEL = "~typesafe/jev-latest";

export type JevQuestionType = "noul" | "choice" | "score";

export interface JevQuestion {
  type: JevQuestionType;
  instructions: string;
  criteria?: { true: string; false: string };
  options?: string[];
}

export type JevState = string | number | boolean | JevState[] | { [k: string]: JevState };
export type JevQuestions = Record<string, JevQuestion>;
export type JevAnswers = Record<string, { [k: string]: unknown; noul?: number }>;

function apiKey(): string | null {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  try {
    for (const line of fs.readFileSync(path.resolve(here, ".env"), "utf8").split(/\r?\n/)) {
      if (line.startsWith("OPENROUTER_API_KEY=")) {
        return line.split("=").slice(1).join("=").trim().replace(/^"|"$/g, "");
      }
    }
  } catch {}
  return null;
}

/** state: string | number | boolean | nested; questions: {name: {type, instructions, criteria}}.
 *  Resolves the `answers` dict, or null on any failure. Never throws. */
export async function decide(state: JevState, questions: JevQuestions, timeoutMs = 5000): Promise<JevAnswers | null> {
  const key = apiKey();
  if (!key) return null;
  try {
    const res = await fetch(URL_, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://github.com/Hex-Tech-Lab/hex-expan-press",
        "X-Title": "ExpanPress Jev",
      },
      body: JSON.stringify({ model: MODEL, state, questions }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { answers?: unknown };
    if (!body || typeof body !== "object" || !body.answers || typeof body.answers !== "object") return null;
    return body.answers as JevAnswers;
  } catch {
    return null;
  }
}
