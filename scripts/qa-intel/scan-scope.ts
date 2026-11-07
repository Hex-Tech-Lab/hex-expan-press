/**
 * TypeScript globs the full-mode scan walks. The scanner's own sources under scripts/ are not listed,
 * and SELF_SCAN_EXCLUDE in the runner keeps them out of the diff-mode scan.
 */
export const FULL_MODE_CODE_GLOBS: readonly string[] = ["{web,worker}/**/*.{ts,tsx}", "payments/**/*.ts", "src/**/*.ts"];
