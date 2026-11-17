/**
 * Normalises an unknown thrown or returned error (for example a PostgREST
 * `{ message }` object) into an `Error` instance for Sentry while preserving
 * the message and attaching the original value as `cause`.
 */
export function toError(err: unknown): Error {
  if (err instanceof Error) return err;
  if (
    err &&
    typeof err === "object" &&
    "message" in err &&
    typeof (err as { message: unknown }).message === "string"
  ) {
    return new Error((err as { message: string }).message, { cause: err });
  }
  return new Error(String(err), { cause: err });
}
