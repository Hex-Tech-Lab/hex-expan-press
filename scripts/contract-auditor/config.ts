/**
 * Single source for contract-auditor constants. Nothing outside this file repeats these values.
 * selfFiles are exempt from the two patterns whose regex literals they must contain.
 */
export const CONTRACT_AUDITOR_CONFIG = {
  scanRoots: ["web", "payments", "scripts"],
  baselineFile: "scripts/contract-auditor.baseline.json",
  selfFiles: [
    "scripts/contract-auditor/rules.ts",
    "scripts/contract-auditor/cli.ts",
    "scripts/contract-auditor/gate.ts",
    "scripts/contract-auditor/config.ts",
    "scripts/contract-auditor.ts",
  ],
  skipDirs: ["node_modules", ".next", ".git", "dist", "coverage", ".turbo"],
  codeExtensions: [".ts", ".tsx"],
  testMarkers: [".test.", ".spec.", "__tests__"],
  /** Third-party management or analytics hosts whose call paths drift between API versions. */
  riskyHosts: ["api.supabase.com", "qstash.upstash.io", "api.vercel.com", ".upstash.io", "openrouter.ai", "api.cloudflare.com"],
} as const;
