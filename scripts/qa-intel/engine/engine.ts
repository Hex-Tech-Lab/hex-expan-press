import { Project, Node, SourceFile } from "ts-morph";
import * as path from "path";
import * as fs from "fs";

export interface Finding {
  file: string;
  severity: "low" | "medium" | "high" | "critical";
  title: string;
  why: string;
  fix: string;
}

export interface IRule {
  name: string;
  allowSelfAnalysis?: boolean;
  check: (source: SourceFile) => Finding[];
}

export interface EngineConfig {
  cache?: {
    getAST(filePath: string): Promise<SourceFile | undefined>;
    setAST(filePath: string, src: SourceFile): Promise<void>;
  };
}

export class QualityIntelligenceEngine {
  private project: Project;
  private rules: IRule[] = [];
  private rootDir: string;
  private cache: EngineConfig["cache"] | undefined;

  constructor(rootDir: string, config?: EngineConfig) {
    this.rootDir = rootDir;
    this.cache = config?.cache;
    this.project = new Project({
      tsConfigFilePath: path.join(rootDir, "tsconfig.json"),
      skipAddingFilesFromTsConfig: true,
    });
  }

  addRule(rule: IRule) {
    this.rules.push(rule);
  }

  private async getOrParseSourceFile(filePath: string): Promise<SourceFile> {
    if (this.cache) {
      const cached = await this.cache.getAST(filePath);
      if (cached) return cached;
    }
    const sanitized = filePath.replace(/\.\.(?:\/|\\|$)/g, "");
    const source = this.project.addSourceFileAtPath(path.resolve(this.rootDir, sanitized));
    if (this.cache) {
      await this.cache.setAST(filePath, source);
    }
    return source;
  }

  async analyze(changedFiles: string[]): Promise<Finding[]> {
    const findings: Finding[] = [];
    // Only analyze files that exist in the project
    const files = changedFiles
      .map(relativePath => path.resolve(this.rootDir, relativePath))
      .filter(resolvedPath => fs.existsSync(resolvedPath));

    for (const filePath of files) {
      try {
        const source = await this.getOrParseSourceFile(filePath);
        for (const rule of this.rules) {
          try {
            findings.push(...rule.check(source));
          } catch (error) {
            console.error(`Rule "${rule.name}" failed on a source file:`, error);
          }
        }
      } catch (error) {
        console.error("Failed to process a source file:", error);
      }
    }
    return findings;
  }
}