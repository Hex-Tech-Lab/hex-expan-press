/**
 * QA-Intel Rule Registry
 *
 * Centralized registry for all QA-Intel rules.
 * Provides unified interface for rule access, validation, and execution.
 */

import type { Rule, RuleContext } from "../domain/Rule";
import type { Finding } from "../domain/Finding";
import { RulesExecutionEngine, type RuleConfig } from "./rules-engine";
import {
  ALL_RULES_BY_CATEGORY,
  ALL_RULES,
  ARCHITECTURE_RULES,
  SECURITY_RULES,
  STREAMING_RULES,
  PERSISTENCE_RULES,
  UI_RULES,
  QUALITY_RULES,
  DATA_INTEGRITY_RULES,
} from "./rules-config";

export class RulesRegistry {
  private engine = new RulesExecutionEngine();
  private rulesByName = new Map<string, RuleConfig>();
  private rulesByCategory = new Map<string, RuleConfig[]>();

  constructor() {
    this.initialize();
  }

  private initialize() {
    for (const [category, configs] of Object.entries(ALL_RULES_BY_CATEGORY)) {
      this.rulesByCategory.set(category, configs);
      for (const config of configs) {
        this.rulesByName.set(config.name, config);
      }
    }
  }

  getAllRules(): RuleConfig[] {
    return ALL_RULES;
  }

  getRulesByCategory(category: string): RuleConfig[] {
    return this.rulesByCategory.get(category) || [];
  }

  getRuleByName(name: string): RuleConfig | undefined {
    return this.rulesByName.get(name);
  }

  getCategories(): string[] {
    return Array.from(this.rulesByCategory.keys());
  }

  getCategoryStats(): Record<string, number> {
    const stats: Record<string, number> = {};
    for (const [category, rules] of this.rulesByCategory.entries()) {
      stats[category] = rules.length;
    }
    return stats;
  }

  toExecutableRule(config: RuleConfig): Rule {
    return {
      name: config.name,
      scope: config.scope || "file",
      check: (ctx: RuleContext) => {
        try {
          const findings = this.engine.execute(config, ctx.ast, ctx.filePath);
          return findings;
        } catch (error) {
          console.error(`Rule "${config.name}" failed:`, error);
          return [];
        }
      }
    };
  }

  getAllExecutableRules(): Rule[] {
    return this.getAllRules().map((config) => this.toExecutableRule(config));
  }

  getExecutableRulesByCategory(category: string): Rule[] {
    return this.getRulesByCategory(category).map((config) => this.toExecutableRule(config));
  }

  generateReport(): string {
    let report = "# QA-Intel Rule Registry Report\n\n";
    report += `**Total Rules: ${this.getAllRules().length}**\n\n`;
    for (const category of this.getCategories()) {
      report += `## ${category.toUpperCase()}\n`;
    }
    return report;
  }

  validateRule(config: RuleConfig): string[] {
    const errors: string[] = [];
    if (!config.name) errors.push("Rule must have a name");
    if (!config.category) errors.push("Rule must have a category");
    if (!["low", "medium", "high", "critical"].includes(config.severity)) {
      errors.push("Invalid severity");
    }
    return errors;
  }

  validateAll(): Map<string, string[]> {
    const results = new Map<string, string[]>();
    for (const config of this.getAllRules()) {
      const errors = this.validateRule(config);
      if (errors.length > 0) {
        results.set(config.name, errors);
      }
    }
    return results;
  }
}

export const DEFAULT_REGISTRY = new RulesRegistry();

export {
  ALL_RULES_BY_CATEGORY,
  ALL_RULES,
  ARCHITECTURE_RULES,
  SECURITY_RULES,
  STREAMING_RULES,
  PERSISTENCE_RULES,
  UI_RULES,
  QUALITY_RULES,
  DATA_INTEGRITY_RULES,
};
