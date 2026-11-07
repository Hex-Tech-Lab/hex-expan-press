# qa-intel spin-off plan (option C)

**Status:** parked. Kept for later. Not started.

**Current approach:** plan B, the vendored copy. See `PLAN_B_STATUS.md`. This plan applies only after the starting condition below is met.

## Option C

Move the qa-intel engine into a standalone `qa-engine` repository. Each project consumes it as a git-tagged devDependency and keeps its own config profile.

- **Repository.** One standalone engine repository with tagged releases.
- **Consumption.** Each project pins an engine git tag as a devDependency.
- **Per-project config.** Each project keeps a config profile. The profile selects rules and thresholds for that project. The engine holds no project settings.
- **Runtime dependencies.** The engine imports only `ts-morph`, `typescript` and `vitest`.
- **Redis.** Optional. The engine runs without it.
- **Supabase, Vercel and Upstash.** These appear only as rule targets, meaning what a rule checks. They are never imports.

## Infrastructure needed

None. Running the engine needs no new service, secret or hosted runner.

## Starting condition

Start this plan only when both hold:

1. Plan B is stable.
2. Two projects consume the vendored copy.

## Open decisions

1. Repository name.
2. Versioning policy.
3. Profile schema.
