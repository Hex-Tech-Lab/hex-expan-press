# qa-intel plan B status

**Status:** current approach.

## Model

- **Single source of truth.** `scripts/quality-engine` in the `hex-yt-intel` repository.
- **Vendoring.** Each project copies the engine at a pinned commit SHA. The copy carries a per-file hash manifest.
- **CI hash check.** CI recomputes each vendored file's hash and fails when a file differs from the manifest.
- **Symlinks are rejected.** They break CI.

## Adoption

- `hex-expan`: adopts plan B.
- `hex-aim`: adopts plan B.

Adoption status for other projects is tracked outside this repository.

## Next step

Option C, the standalone repository, is parked. See `SPINOFF_PLAN.md`. It starts only after plan B is stable and two projects consume the vendored copy.
