/**
 * SourceRegistry
 * Simple, in-memory source map registry with safe, minimal touchpoints.
 * Excludes parsing and graph mutation concerns to maintain strict SoC.
 */
export class SourceRegistry {
  private map = new Map<string, unknown>();

  has(path: string) {
    return this.map.has(path);
  }

  get(path: string): unknown {
    return this.map.get(path);
  }

  add(path: string, ast: unknown) {
    this.map.set(path, ast);
  }
}
