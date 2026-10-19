/**
 * Port for object storage operations (release files, digital downloads, assets).
 */
export interface StoragePort {
  /**
   * Creates a time-limited signed URL for downloading an object.
   * @param path The key/path of the object within the bucket
   * @param expiresInSeconds Duration in seconds for which the URL is valid
   * @returns The signed URL string, or null if creation failed
   */
  createSignedDownloadUrl(path: string, expiresInSeconds: number): Promise<string | null>;
}
