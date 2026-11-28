/** Options for a signed download URL. */
export interface SignedDownloadOptions {
  /**
   * Filename the browser saves the object as (Content-Disposition: attachment). Omit it to keep the storage key name.
   * Set it from the release convention so the buyer never sees a UUID or storage path as the file name.
   */
  downloadName?: string;
}

/**
 * Port for object storage operations (release files, digital downloads, assets).
 */
export interface StoragePort {
  /**
   * Creates a time-limited signed URL for downloading an object.
   * @param path The key/path of the object within the bucket
   * @param expiresInSeconds Duration in seconds for which the URL is valid
   * @param options Optional download settings, such as the saved filename
   * @returns The signed URL string, or null if creation failed
   */
  createSignedDownloadUrl(
    path: string,
    expiresInSeconds: number,
    options?: SignedDownloadOptions,
  ): Promise<string | null>;
}
