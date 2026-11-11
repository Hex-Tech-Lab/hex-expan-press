import { describe, it, expect, vi, beforeEach } from "vitest";
import { listAllSupabaseFiles, parsePrefixArg } from "../sync-supabase-to-r2";
import { resetSyncTestEnv } from "./sync-supabase-to-r2.harness";

describe("sync-supabase-to-r2", () => {
  beforeEach(resetSyncTestEnv);

  describe("parsePrefixArg", () => {
    it("parses --prefix <val> syntax", () => {
      expect(parsePrefixArg(["node", "sync.ts", "--prefix", "releases/v1"])).toBe("releases/v1");
    });

    it("parses --prefix=<val> syntax", () => {
      expect(parsePrefixArg(["node", "sync.ts", "--prefix=releases/v2"])).toBe("releases/v2");
    });

    it("returns undefined when --prefix is not present", () => {
      expect(parsePrefixArg(["node", "sync.ts", "--dry-run"])).toBeUndefined();
    });

    it("returns undefined for an empty argv with no prefix flag", () => {
      expect(parsePrefixArg(["node", "sync.ts"])).toBeUndefined();
    });

    it("does not consume the next flag when --prefix is followed by --dry-run", () => {
      // Must throw rather than return "--dry-run" as the prefix value.
      expect(() => parsePrefixArg(["node", "sync.ts", "--prefix", "--dry-run"])).toThrow(
        /followed by the flag --dry-run/,
      );
    });

    it("rejects --prefix at the end of argv instead of treating it as the bucket root", () => {
      expect(() => parsePrefixArg(["node", "sync.ts", "--prefix"])).toThrow(/has no value/);
    });

    it("rejects an empty --prefix= value instead of returning an empty string", () => {
      expect(() => parsePrefixArg(["node", "sync.ts", "--prefix="])).toThrow(/empty value/);
    });

    it("rejects an empty separate --prefix value", () => {
      expect(() => parsePrefixArg(["node", "sync.ts", "--prefix", ""])).toThrow(/has no value/);
    });
  });

  describe("listAllSupabaseFiles", () => {
    it("lists files recursively, traversing folders when item.id is null", async () => {
      const listMock = vi.fn((prefix: string) => {
        if (prefix === "") {
          return Promise.resolve({
            data: [
              { name: "root.pdf", id: "f-root", metadata: { mimetype: "application/pdf", size: 100 } },
              { name: "books", id: null, metadata: {} }, // folder
            ],
            error: null,
          });
        }
        if (prefix === "books") {
          return Promise.resolve({
            data: [
              { name: "playbook.pdf", id: "f-playbook", metadata: { mimetype: "application/pdf", size: 200 } },
              { name: "guide.epub", id: "f-guide", metadata: { mimetype: "application/epub+zip", size: 300 } },
            ],
            error: null,
          });
        }
        return Promise.resolve({ data: [], error: null });
      });

      const fakeClient = {
        storage: {
          from: vi.fn(() => ({ list: listMock })),
        },
      };

      const files = await listAllSupabaseFiles(fakeClient as never, "release-files");
      expect(files).toEqual([
        { path: "root.pdf", mimetype: "application/pdf", size: 100 },
        { path: "books/playbook.pdf", mimetype: "application/pdf", size: 200 },
        { path: "books/guide.epub", mimetype: "application/epub+zip", size: 300 },
      ]);
    });

    it("throws an informative error if listing fails", async () => {
      const fakeClient = {
        storage: {
          from: vi.fn(() => ({
            list: vi.fn().mockResolvedValue({ data: null, error: { message: "Bucket not found" } }),
          })),
        },
      };

      await expect(listAllSupabaseFiles(fakeClient as never, "bad-bucket")).rejects.toThrow(
        "Failed to list files from Supabase Storage bucket [bad-bucket]",
      );
    });

    it("paginates across multiple pages when a folder contains more than 1,000 items", async () => {
      const page1Items = Array.from({ length: 1000 }, (_, i) => ({
        name: `file-${i.toString().padStart(4, "0")}.pdf`,
        id: `id-${i}`,
        metadata: { mimetype: "application/pdf", size: 1000 + i },
      }));
      const page2Items = [
        { name: "subfolder", id: null, metadata: {} },
        ...Array.from({ length: 499 }, (_, i) => ({
          name: `file-${(1000 + i).toString().padStart(4, "0")}.pdf`,
          id: `id-${1000 + i}`,
          metadata: { mimetype: "application/pdf", size: 2000 + i },
        })),
      ];
      const subfolderItems = [
        { name: "nested.pdf", id: "id-nested", metadata: { mimetype: "application/pdf", size: 500 } },
      ];

      const listMock = vi.fn((prefix: string, options?: { offset?: number; limit?: number }) => {
        if (prefix === "") {
          if (options?.offset === 0) {
            return Promise.resolve({ data: page1Items, error: null });
          }
          if (options?.offset === 1000) {
            return Promise.resolve({ data: page2Items, error: null });
          }
        }
        if (prefix === "subfolder") {
          return Promise.resolve({ data: subfolderItems, error: null });
        }
        return Promise.resolve({ data: [], error: null });
      });

      const fakeClient = {
        storage: {
          from: vi.fn(() => ({ list: listMock })),
        },
      };

      const files = await listAllSupabaseFiles(fakeClient as never, "release-files");
      expect(files.length).toBe(1500);
      expect(files[0].path).toBe("file-0000.pdf");
      expect(files[999].path).toBe("file-0999.pdf");
      expect(files[1000].path).toBe("subfolder/nested.pdf");
      expect(files[1001].path).toBe("file-1000.pdf");
      expect(listMock).toHaveBeenCalledWith("", expect.objectContaining({ limit: 1000, offset: 0 }));
      expect(listMock).toHaveBeenCalledWith("", expect.objectContaining({ limit: 1000, offset: 1000 }));
      expect(listMock).toHaveBeenCalledWith("subfolder", expect.objectContaining({ limit: 1000, offset: 0 }));
    });
  });

});
