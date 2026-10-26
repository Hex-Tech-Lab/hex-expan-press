export interface FileSystemPort {
  exists(path: string): boolean;
  resolve(path: string): string;
}
