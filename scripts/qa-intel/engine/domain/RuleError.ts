import type { Finding } from './Finding';

export interface RuleError {
  ruleName: string;
  filePath: string;
  message: string;
  timestamp: number;
}

export interface AnalysisResult {
  findings: Finding[];
  errors: RuleError[];
}
