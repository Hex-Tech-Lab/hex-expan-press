/**
 * Contract auditor entry point. Logic lives in scripts/contract-auditor/. Usage:
 *   tsx scripts/contract-auditor.ts [repoRoot]            gate: fail on criticals not in the baseline
 *   tsx scripts/contract-auditor.ts [repoRoot] --baseline accept every current critical (explicit)
 */
import { defaultRepoRoot, runContractAudit } from "./contract-auditor/cli";

try {
  process.exitCode = runContractAudit(process.argv.slice(2), defaultRepoRoot(), {
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  });
} catch (err) {
  console.error(`Contract Auditor: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 2;
}
