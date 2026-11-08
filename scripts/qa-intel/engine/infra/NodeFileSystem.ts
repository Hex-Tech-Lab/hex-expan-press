import * as fs from "fs";
import * as path from "path";
import type { FileSystemPort } from "../application/ports/FileSystemPort";

export class NodeFileSystem implements FileSystemPort {
  exists(p: string): boolean {
    return fs.existsSync(p);
  }

  resolve(p: string): string {
    // Sanitize path parameter to prevent path traversal (e.g. resolve user input ../)
    const sanitized = p.replace(/\.\.(?:\/|\\|$)/g, "");
    return path.resolve(process.cwd(), sanitized);
  }
}
