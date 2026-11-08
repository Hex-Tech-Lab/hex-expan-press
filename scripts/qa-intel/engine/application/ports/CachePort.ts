export interface CachePort {
  getAST(path: string): Promise<string | undefined>;
  setAST(path: string, astText: string, ttlSeconds?: number): Promise<void>;
  del(path: string): Promise<void>;
}
