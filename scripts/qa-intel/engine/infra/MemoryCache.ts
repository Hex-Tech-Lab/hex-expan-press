import type { CachePort } from "../application/ports/CachePort";

export class MemoryCache implements CachePort {
  private store = new Map<string, string>();

  async getAST(path: string): Promise<string | undefined> {
    return this.store.get(path);
  }

  async setAST(path: string, astText: string): Promise<void> {
    this.store.set(path, astText);
  }

  async del(path: string): Promise<void> {
    this.store.delete(path);
  }
}
