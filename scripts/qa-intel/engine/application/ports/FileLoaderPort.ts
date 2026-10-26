import type { SourceFile } from "ts-morph";

export interface FileLoaderPort {
  load(path: string): Promise<SourceFile>;
  loadFromText(path: string, text: string): Promise<SourceFile>;
  getImports(ast: unknown): string[];
}
