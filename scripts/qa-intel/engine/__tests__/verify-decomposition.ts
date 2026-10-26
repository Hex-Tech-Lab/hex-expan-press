/**
 * Rules Decomposition Verification
 *
 * Verifies the refactored config + engine + registry architecture works correctly.
 * Can be run directly with: npx tsx verify-decomposition.ts
 */

import { Project } from "ts-morph";
import { RulesRegistry } from "../rules/rules-registry";
import { RulesExecutionEngine } from "../rules/rules-engine";
import {
  ALL_RULES,
  ARCHITECTURE_RULES,
  SECURITY_RULES,
  UI_RULES,
  DATA_INTEGRITY_RULES,
} from "../rules/rules-config";

/**
 * Helper: Create a test source file
 */
function createTestSource(code: string, fileName = "test.ts") {
  const project = new Project({ useInMemoryFileSystem: true });
  return project.createSourceFile(fileName, code);
}

/**
 * Run verification tests
 */
async function runVerification() {
  const registry = new RulesRegistry();
  const engine = new RulesExecutionEngine();
  let passed = 0;
  let failed = 0;

  console.log("🔍 Rules Decomposition Verification\n");
  console.log("=====================================\n");

  // Test 1: Configuration Structure
  console.log("Test 1: Configuration Structure");
  try {
    if (ALL_RULES.length === 55) {
      console.log("✓ All 55 rules defined");
      passed++;
    } else {
      console.log(`✗ Expected 55 rules, got ${ALL_RULES.length}`);
      failed++;
    }
  } catch (e) {
    console.log(`✗ ${e}`);
    failed++;
  }

  // Test 2: Categories
  console.log("\nTest 2: Rule Categories");
  try {
    const categories = registry.getCategories();
    const expected = [
      "architecture",
      "security",
      "streaming",
      "persistence",
      "ui",
      "quality",
      "data-integrity",
    ];
    if (expected.every((c) => categories.includes(c))) {
      console.log(`✓ All ${categories.length} categories present`);
      passed++;
    } else {
      console.log("✗ Missing categories");
      failed++;
    }
  } catch (e) {
    console.log(`✗ ${e}`);
    failed++;
  }

  // Test 3: Category Counts
  console.log("\nTest 3: Category Counts");
  try {
    const stats = registry.getCategoryStats();
    const expected: Record<string, number> = {
      architecture: 11,
      security: 13,
      streaming: 7,
      persistence: 5,
      ui: 10,
      quality: 6,
      "data-integrity": 3,
    };

    let allCorrect = true;
    for (const [cat, count] of Object.entries(expected)) {
      if (stats[cat] !== count) {
        console.log(
          `✗ ${cat}: expected ${count}, got ${stats[cat] || 0}`
        );
        allCorrect = false;
      }
    }

    if (allCorrect) {
      console.log("✓ All category counts correct");
      passed++;
    } else {
      failed++;
    }
  } catch (e) {
    console.log(`✗ ${e}`);
    failed++;
  }

  // Test 4: Rule Metadata
  console.log("\nTest 4: Rule Metadata Completeness");
  try {
    let allValid = true;
    for (const rule of ALL_RULES) {
      if (!rule.name || !rule.category || !rule.severity || !rule.description) {
        console.log(`✗ Rule missing metadata: ${rule.name}`);
        allValid = false;
        break;
      }
    }

    if (allValid) {
      console.log("✓ All rules have complete metadata");
      passed++;
    } else {
      failed++;
    }
  } catch (e) {
    console.log(`✗ ${e}`);
    failed++;
  }

  // Test 5: Registry Lookup
  console.log("\nTest 5: Registry Lookup");
  try {
    const rule = registry.getRuleByName("hexagonal-boundary-enforcer");
    if (rule && rule.name === "hexagonal-boundary-enforcer") {
      console.log("✓ Rule lookup works");
      passed++;
    } else {
      console.log("✗ Rule lookup failed");
      failed++;
    }
  } catch (e) {
    console.log(`✗ ${e}`);
    failed++;
  }

  // Test 6: Engine Execution - Complexity
  console.log("\nTest 6: Engine Execution - Complexity Rule");
  try {
    const rule = registry.getRuleByName("complexity-monitor");
    const code = Array(510).fill("const x = 1;").join("\n");
    const source = createTestSource(code);

    const findings = engine.execute(rule!, source, "test.ts");
    if (findings.length > 0 && findings[0].severity === "medium") {
      console.log("✓ Complexity rule executes correctly");
      passed++;
    } else {
      console.log("✗ Complexity rule failed to detect issue");
      failed++;
    }
  } catch (e) {
    console.log(`✗ ${e}`);
    failed++;
  }

  // Test 7: Engine Execution - Security
  console.log("\nTest 7: Engine Execution - Credential Leak Rule");
  try {
    const rule = registry.getRuleByName("credential-leak-detector");
    const code = `const userId = 'da4381c6-f774-4c99-8f04-2c1c9e27d1fb';`;
    const source = createTestSource(code);

    const findings = engine.execute(rule!, source, "test.ts");
    if (findings.length > 0 && findings[0].severity === "critical") {
      console.log("✓ Security rule executes correctly");
      passed++;
    } else {
      console.log("✗ Security rule failed to detect credential");
      failed++;
    }
  } catch (e) {
    console.log(`✗ ${e}`);
    failed++;
  }

  // Test 8: Engine Execution - UI
  console.log("\nTest 8: Engine Execution - UI Alert Blocker Rule");
  try {
    const rule = registry.getRuleByName("inp-alert-blocker");
    const code = `const handleClick = () => { alert('test'); };`;
    const source = createTestSource(code, "component.tsx");

    const findings = engine.execute(rule!, source, "component.tsx");
    if (findings.length > 0 && findings[0].severity === "high") {
      console.log("✓ UI rule executes correctly");
      passed++;
    } else {
      console.log("✗ UI rule failed to detect alert");
      failed++;
    }
  } catch (e) {
    console.log(`✗ ${e}`);
    failed++;
  }

  // Test 9: Engine Execution - Clean Code
  console.log("\nTest 9: Engine Execution - No False Positives");
  try {
    const rule = registry.getRuleByName("complexity-monitor");
    const code = `const x = 1; const y = 2;`;
    const source = createTestSource(code);

    const findings = engine.execute(rule!, source, "test.ts");
    if (findings.length === 0) {
      console.log("✓ No false positives on clean code");
      passed++;
    } else {
      console.log("✗ False positive detected");
      failed++;
    }
  } catch (e) {
    console.log(`✗ ${e}`);
    failed++;
  }

  // Test 10: Config to Rule Conversion
  console.log("\nTest 10: Config to Executable Rule Conversion");
  try {
    const config = registry.getRuleByName("complexity-monitor")!;
    const executable = registry.toExecutableRule(config);

    if (
      executable.name === config.name &&
      typeof executable.check === "function"
    ) {
      console.log("✓ Config conversion works");
      passed++;
    } else {
      console.log("✗ Config conversion failed");
      failed++;
    }
  } catch (e) {
    console.log(`✗ ${e}`);
    failed++;
  }

  // Test 11: Registry Report
  console.log("\nTest 11: Registry Report Generation");
  try {
    const report = registry.generateReport();
    if (
      report.includes("QA-Intel Rule Registry Report") &&
      report.includes("Total Rules: 55")
    ) {
      console.log("✓ Report generation works");
      passed++;
    } else {
      console.log("✗ Report generation failed");
      failed++;
    }
  } catch (e) {
    console.log(`✗ ${e}`);
    failed++;
  }

  // Test 12: Rule Validation
  console.log("\nTest 12: Rule Validation");
  try {
    const errors = registry.validateAll();
    if (errors.size === 0) {
      console.log("✓ All rules pass validation");
      passed++;
    } else {
      console.log(`✗ ${errors.size} rules have validation errors`);
      failed++;
    }
  } catch (e) {
    console.log(`✗ ${e}`);
    failed++;
  }

  // Test 13: All Executable Rules
  console.log("\nTest 13: Get All Executable Rules");
  try {
    const rules = registry.getAllExecutableRules();
    if (rules.length === 55) {
      console.log("✓ All 55 rules converted to executable");
      passed++;
    } else {
      console.log(
        `✗ Expected 55 executable rules, got ${rules.length}`
      );
      failed++;
    }
  } catch (e) {
    console.log(`✗ ${e}`);
    failed++;
  }

  // Test 14: Category-specific Executable Rules
  console.log("\nTest 14: Get Executable Rules by Category");
  try {
    const archRules = registry.getExecutableRulesByCategory("architecture");
    if (archRules.length === 11) {
      console.log("✓ Category filtering works");
      passed++;
    } else {
      console.log(
        `✗ Expected 11 architecture rules, got ${archRules.length}`
      );
      failed++;
    }
  } catch (e) {
    console.log(`✗ ${e}`);
    failed++;
  }

  // Test 15: Execution Tracking
  console.log("\nTest 15: Execution State Tracking");
  try {
    registry.resetExecutionTracking();
    if (!registry.wasExecuted("complexity-monitor")) {
      registry.markExecuted("complexity-monitor");
      if (registry.wasExecuted("complexity-monitor")) {
        registry.resetExecutionTracking();
        if (!registry.wasExecuted("complexity-monitor")) {
          console.log("✓ Execution tracking works");
          passed++;
        } else {
          console.log("✗ Reset failed");
          failed++;
        }
      } else {
        console.log("✗ Mark execution failed");
        failed++;
      }
    }
  } catch (e) {
    console.log(`✗ ${e}`);
    failed++;
  }

  // Summary
  console.log("\n=====================================");
  console.log("\n📊 Verification Results:");
  console.log(`✓ Passed: ${passed}/15`);
  console.log(`✗ Failed: ${failed}/15`);

  if (failed === 0) {
    console.log("\n✅ All verification tests passed!");
    console.log("\nRefactoring Status:");
    console.log("- Config module (rules-config.ts): ✓ Declarative rule definitions");
    console.log("- Engine module (rules-engine.ts): ✓ Pluggable execution logic");
    console.log("- Registry module (rules-registry.ts): ✓ Centralized rule management");
    console.log("\nSeparation of Concerns: ✓ ACHIEVED");
    console.log("- Rule definitions separate from execution");
    console.log("- Configuration separate from engine");
    console.log("- Centralized registry for all rules");
    process.exit(0);
  } else {
    console.log("\n❌ Some tests failed");
    process.exit(1);
  }
}

runVerification().catch((err) => {
  console.error("Verification failed:", err);
  process.exit(1);
});
