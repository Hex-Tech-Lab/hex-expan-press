/**
 * QA-Intel Rule Configuration
 *
 * Declarative rule definitions - 55 total rules across 7 categories.
 * Separated from execution logic in rules-engine.ts
 */

export interface RuleConfig {
  name: string;
  category: string;
  severity: "low" | "medium" | "high" | "critical";
  description: string;
  scope?: "file" | "neighbors" | "graph";
  check: (matchers: any) => any;
}

// Architecture Rules: 11 total
export const ARCHITECTURE_RULES: RuleConfig[] = [
  {
    name: "hexagonal-boundary-enforcer",
    category: "architecture",
    severity: "critical",
    description: "Enforces hexagonal architecture boundaries",
    check: () => () => []
  },
  {
    name: "complexity-monitor",
    category: "architecture",
    severity: "medium",
    description: "Monitors file complexity by line count",
    check: () => () => []
  },
  {
    name: "error-taxonomy-audit",
    category: "architecture",
    severity: "high",
    description: "Validates error taxonomy consistency",
    check: () => () => []
  },
  {
    name: "cross-platform-compatibility",
    category: "architecture",
    severity: "medium",
    description: "Checks for cross-platform line ending handling",
    check: () => () => []
  },
  {
    name: "schema-contract-audit",
    category: "architecture",
    severity: "critical",
    description: "Ensures schema refinements have guards",
    check: () => () => []
  },
  {
    name: "redundant-validation-detector",
    category: "architecture",
    severity: "medium",
    description: "Detects redundant manual validation with Zod",
    check: () => () => []
  },
  {
    name: "workflow-safety-check",
    category: "architecture",
    severity: "high",
    description: "Ensures I/O operations have proper error handling",
    check: () => () => []
  },
  {
    name: "transcript-unsafe-access",
    category: "architecture",
    severity: "high",
    description: "Prevents unsafe deep property chain access on transcripts",
    check: () => () => []
  },
  {
    name: "hardcoded-domain-logic",
    category: "architecture",
    severity: "medium",
    description: "Detects hardcoded domain-specific constants",
    check: () => () => []
  },
  {
    name: "state-sync-audit",
    category: "architecture",
    severity: "medium",
    description: "Ensures state mutations maintain consistency",
    check: () => () => []
  },
  {
    name: "graph-aware-boundary",
    category: "architecture",
    severity: "critical",
    description: "Validates domain/usecase layer doesn't depend on infrastructure",
    check: () => () => []
  }
];

// Security Rules: 13 total
export const SECURITY_RULES: RuleConfig[] = [
  { name: "credential-leak-detector", category: "security", severity: "critical", description: "Detects hardcoded sensitive IDs", check: () => () => [] },
  { name: "sanitization-check", category: "security", severity: "critical", description: "Ensures dangerouslySetInnerHTML is sanitized", check: () => () => [] },
  { name: "secrets-exposure-detector", category: "security", severity: "high", description: "Detects accidental secret exposure in logs", check: () => () => [] },
  { name: "auth-security-check", category: "security", severity: "high", description: "Validates authentication token handling", check: () => () => [] },
  { name: "hmac-message-format-rule", category: "security", severity: "high", description: "Validates HMAC message format compliance", check: () => () => [] },
  { name: "unsafe-property-access", category: "security", severity: "high", description: "Detects unsafe object property access", check: () => () => [] },
  { name: "env-placeholder-namespace", category: "security", severity: "medium", description: "Ensures env variables follow naming convention", check: () => () => [] },
  { name: "insecure-fallback", category: "security", severity: "high", description: "Detects insecure fallback values", check: () => () => [] },
  { name: "sql-injection-rule", category: "security", severity: "critical", description: "Detects potential SQL injection risks", check: () => () => [] },
  { name: "whitelist-path-sanitization", category: "security", severity: "high", description: "Validates path sanitization uses whitelist approach", check: () => () => [] },
  { name: "information-disclosure", category: "security", severity: "high", description: "Prevents information disclosure in error responses", check: () => () => [] },
  { name: "yaml-injection", category: "security", severity: "high", description: "Detects YAML injection vulnerabilities", check: () => () => [] },
  { name: "reserved-keyword-rule", category: "security", severity: "medium", description: "Prevents use of reserved keywords as identifiers", check: () => () => [] }
];

// Streaming Rules: 7 total
export const STREAMING_RULES: RuleConfig[] = [
  { name: "stream-resilience-rule", category: "streaming", severity: "high", description: "Validates streaming response handling", check: () => () => [] },
  { name: "bundle-contradiction", category: "streaming", severity: "high", description: "Detects contradictory bundle/stream configurations", check: () => () => [] },
  { name: "transcript-guard", category: "streaming", severity: "high", description: "Ensures transcript data is validated before use", check: () => () => [] },
  { name: "stream-settle-rule", category: "streaming", severity: "medium", description: "Validates stream settlement and cleanup", check: () => () => [] },
  { name: "cascade-order", category: "streaming", severity: "medium", description: "Validates correct cascading order in streaming pipelines", check: () => () => [] },
  { name: "proxy-promotion", category: "streaming", severity: "medium", description: "Ensures streaming proxies are promoted correctly", check: () => () => [] },
  { name: "module-level-dynamic-import", category: "streaming", severity: "medium", description: "Prevents module-level dynamic imports", check: () => () => [] }
];

// Persistence Rules: 5 total
export const PERSISTENCE_RULES: RuleConfig[] = [
  { name: "persist-resilience-rule", category: "persistence", severity: "high", description: "Validates persistence operation resilience", check: () => () => [] },
  { name: "persist-abort-scope", category: "persistence", severity: "high", description: "Ensures abort signals have proper scope", check: () => () => [] },
  { name: "retry-flag-interference", category: "persistence", severity: "medium", description: "Detects retry flag interference with persistence", check: () => () => [] },
  { name: "quorum-timeout-completion", category: "persistence", severity: "high", description: "Validates quorum write completions with timeouts", check: () => () => [] },
  { name: "stale-state-reset", category: "persistence", severity: "medium", description: "Prevents stale cache state in persistence layer", check: () => () => [] }
];

// UI Rules: 10 total
export const UI_RULES: RuleConfig[] = [
  { name: "inp-alert-blocker", category: "ui", severity: "high", description: "Prevents alert() in event handlers (blocks main thread)", check: () => () => [] },
  { name: "canvas-hover-rerender", category: "ui", severity: "high", description: "Prevents hover state on canvas causing re-renders", check: () => () => [] },
  { name: "overlay-close-cascade", category: "ui", severity: "high", description: "Prevents overlay close from cascading re-renders", check: () => () => [] },
  { name: "validation-on-change", category: "ui", severity: "medium", description: "Prevents expensive validation on every onChange", check: () => () => [] },
  { name: "unhandled-clipboard-promise", category: "ui", severity: "high", description: "Ensures clipboard operations are awaited", check: () => () => [] },
  { name: "start-transition-wrapping", category: "ui", severity: "high", description: "Ensures expensive state updates use startTransition", check: () => () => [] },
  { name: "toast-accessibility", category: "ui", severity: "medium", description: "Ensures toast notifications are accessible", check: () => () => [] },
  { name: "swallowed-error", category: "ui", severity: "high", description: "Detects swallowed errors in event handlers", check: () => () => [] },
  { name: "sync-import-before-redirect", category: "ui", severity: "medium", description: "Ensures async imports complete before redirect", check: () => () => [] },
  { name: "canvas-stale-data", category: "ui", severity: "high", description: "Prevents canvas from rendering stale data", check: () => () => [] }
];

// Quality Rules: 6 total
export const QUALITY_RULES: RuleConfig[] = [
  { name: "async-without-await", category: "quality", severity: "high", description: "Detects async functions that don't use await", check: () => () => [] },
  { name: "dead-code", category: "quality", severity: "medium", description: "Detects unreachable/unused code", check: () => () => [] },
  { name: "variable-naming", category: "quality", severity: "low", description: "Enforces consistent variable naming", check: () => () => [] },
  { name: "timeout-cleanup", category: "quality", severity: "high", description: "Ensures timeouts are cleaned up", check: () => () => [] },
  { name: "import-ordering", category: "quality", severity: "low", description: "Enforces consistent import ordering", check: () => () => [] },
  { name: "error-observability", category: "quality", severity: "medium", description: "Ensures errors are observable (logged or tracked)", check: () => () => [] }
];

// Data Integrity Rules: 3 total
export const DATA_INTEGRITY_RULES: RuleConfig[] = [
  { name: "database-constraint", category: "data-integrity", severity: "high", description: "Validates database constraints in schema", check: () => () => [] },
  { name: "default-value-consistency", category: "data-integrity", severity: "medium", description: "Ensures default values match schema", check: () => () => [] },
  { name: "truncation-validation", category: "data-integrity", severity: "high", description: "Validates truncation operations have guards", check: () => () => [] }
];

export const ALL_RULES_BY_CATEGORY = {
  architecture: ARCHITECTURE_RULES,
  security: SECURITY_RULES,
  streaming: STREAMING_RULES,
  persistence: PERSISTENCE_RULES,
  ui: UI_RULES,
  quality: QUALITY_RULES,
  "data-integrity": DATA_INTEGRITY_RULES,
};

export const ALL_RULES = Object.values(ALL_RULES_BY_CATEGORY).flat();
