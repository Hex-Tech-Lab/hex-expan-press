# Project lessons: hex-expan (ExpanPress)

Written 2026-11-02 against `origin/master` at 77cc649. The portable form of each lesson is in `ECOSYSTEM_LESSONS.md` (same numbering, E1-E12).

**Status key**

- **CONFIRMED**: checked in this session against git, GitHub (PR, runs, comments) or the repo files. The check is named.
- **UNVERIFIED**: stated in the source facts but not confirmed here. Nothing in this session contradicts it, except where a correction is noted.

Note on the workflow: `.github/workflows/real-browser-latency.yml` on master still has the broken Browsertime arguments. The fix is on PR #116, which is open and not merged.

---

## P1. Browsertime 28.x ignored `--chrome.headless`, and `--version` printed a wrong number

- **What happened.** The real-browser latency workflow passed `--chrome.headless`. Browsertime 28.x ignored it with no error. Chrome ran headed on a runner with no display and failed to start. The `--chrome.args` values were also written without leading dashes (`--chrome.args no-sandbox`). `browsertime --version` printed a wrong number in 28.x.
- **Why.** The unknown option was dropped silently. The version output could not confirm which Browsertime was running.
- **Rule.** Use `--headless` for Browsertime 28.x. Write every Chrome argument with a leading dash, for example `--chrome.args=--no-sandbox`. Read the version from the installed package's `package.json`. Treat a live run as the test for tool arguments.
- **Repo state.** Master (77cc649) still has `--chrome.headless` (line 61) and `--chrome.args no-sandbox` (line 62). The fix is commit `0042880` on PR #116.
- **Evidence.**
  - Run `41343160794` failed on commit `a9c5179` (checked with `gh run view`).
  - Runs `41343304723` and `41343374398` passed on `0042880` (checked).
  - Commit `0042880` message: Browsertime 28 reads a top-level `--headless`, and `--chrome.headless` "was ignored without an error" (checked).
  - PR #116, open (checked).
- **Status.** CONFIRMED for the runs, commits, PR and workflow lines. The `--version` misreport is UNVERIFIED (not reproduced here).

## P2. The secret and the `--no-sandbox` browser share one job (PR #116)

- **What happened.** The latency job runs Chrome with `--no-sandbox` while loading measured pages. `PROBE_INGEST_SECRET` is injected in a later step of the same `measure` job. A browser exploit in the earlier step could reach the secret.
- **Why.** A step or job was treated as an isolation boundary. It is not one.
- **Rule.** Split the work into two jobs. The first job runs the browser and has no secrets. The second job holds the secret and posts results, receiving the data through an artifact.
- **Repo state.** Master has one job, `measure` (line 20). `--no-sandbox` is at line 62 and the secret is injected at line 74. The PR #116 head (`0042880`) still has the secret in the same job (line 91 on that branch), so the split is not yet made.
- **Evidence.**
  - sourcery-ai review comment on PR #116 on `real-browser-latency.yml`, rated **High**, "Measured pages bypass Chrome's sandbox". It names the later step that receives `PROBE_INGEST_SECRET` (checked).
  - Job layout on master (checked).
- **Correction to the source facts.** The facts say Cubic flagged this as a P1. The High finding on PR #116 is from sourcery-ai. Cubic's only comment on that file is a P3 about `chromedriver --version`. No Cubic P1 appears in PR review comments or issue comments. **The Cubic P1 attribution is UNVERIFIED.**

## P3. Vercel Function Storage is team-wide and grows with every production deploy

- **What happened.** Storage kept growing with each production deploy. Moving release files to R2 or B2 did not reduce it. Deployment listing is paginated with `until`, and large results overflowed the tool output.
- **Why.** Stated cause: storage is team-wide and each deploy adds to it, so moving release files does not change the total.
- **Rule.** Before cleanup, confirm what the meter counts and whether it is per team or per project. Page deployment listings with `until`, save the output to a file, and parse it with a script.
- **Evidence.** None in the repo. `rg` over `docs/` and `scripts/` for "Function Storage" returned no hits. No deployment or run IDs were given.
- **Status.** UNVERIFIED.

## P4. Relative paths in skill-gate writes produced a stray copy

- **What happened.** Gate lines were written with a relative path from inside the gate folder. They ended up in a stray copy.
- **Where the records live.** `$(git rev-parse --git-dir)/skill-gates`. In the main checkout the git dir is `.git`, so the folder is `/home/kellyb_dev/projects/hex-expan/.git/skill-gates`. It exists and holds `agent_*.md` and `agent_*.txt` files (checked).
- **Rule.** Build the gate path as an absolute path from `git rev-parse --git-dir` before writing. Never write with a relative path from inside the gate folder.
- **Evidence.** Gate folder layout (CONFIRMED). The stray-copy incident itself: UNVERIFIED.

## P5. The latency probe's code sat in an untracked folder with one copy

- **What happened.** The probe's code lived in an untracked folder with a single copy.
- **Current state.** The probe source is committed on `origin/feat/latency-probe-source`: commit `7c3e7cf` ("add the latency probe source under latency-probe/"), with `42a1c99` on top (checked). It is not on master. Master tracks only `scripts/latency/summarize-browsertime.mjs` (with its test) and the workflow.
- **Rule.** Deployable code lives in a tracked path on master or on a PR branch. Check `git ls-files` before relying on a folder. An untracked folder is one copy.
- **Evidence.** Commits `7c3e7cf` and `42a1c99` (CONFIRMED). The original untracked state: UNVERIFIED (not seen in this session).

## P6. A neutral Cubic check hid a quota stop

- **What happened.** Cubic hit its monthly line quota (40,032 of 40,000). Its check reported neutral until reviews resumed on 2026-10-30.
- **Rule.** A neutral Cubic check means no review ran. Read the review comments before calling a PR clean.
- **Evidence.** UNVERIFIED. Searches for `40,032` and `40032` in `docs/agent_ledger.jsonl` found nothing. Cubic was active on PR #116, which shows reviews on `real-browser-latency.yml`.
- **Status.** UNVERIFIED.

## P7. The probe's schedule runs only from master, and each run writes to production

- **What happened.** The probe's cron trigger fires only from the default branch. Branch tests need a manual dispatch. Each run writes real rows to the production probe.
- **Repo state.** `.github/workflows/real-browser-latency.yml` has the header comment "Scheduled runs only fire from the default branch. Use workflow_dispatch to test a branch." (line 5). Triggers are `schedule: "*/30 * * * *"` (lines 8-9) and `workflow_dispatch` (line 10). The job posts signed results to the probe using `PROBE_INGEST_SECRET`.
- **Rule.** Test a branch with `gh workflow run real-browser-latency.yml --ref <branch>`. Assume each run writes real rows.
- **Evidence.** Workflow triggers and header (CONFIRMED). The run ID of the incident: UNVERIFIED.

## P8. The identity file has no legal-name field

- **What happened.** An automated name check was run against the identity file. The file has author fields but no legal-name field, so the check could not cover the legal name.
- **Repo state.** `books/duane.json` in the main checkout has `author` and `cover.author` keys and no legal-name key. This check read key paths only. No values were read or printed.
- **Rule.** A name check covers only the fields it reads. Keep the legal name in a separate reference and check against that. Never print the legal name in chat or in commits.
- **Evidence.** Key-path check of `books/duane.json` (CONFIRMED). The incident itself: UNVERIFIED.

## P9. An evidence line claimed a search had run before it ran

- **What happened.** An evidence line said a search had been done before it ran. It was caught and corrected.
- **Rule.** Run the check first, then write the evidence line from its actual output.
- **Evidence.** UNVERIFIED. No PR, run, or commit was given, and none was found in the repo.
- **Status.** UNVERIFIED.

## P10. Use `rg`, `recollq`, `fzf` or the code graph, not `grep`, in the founder's presence

- **What happened.** Founder instruction: do not use `grep` when the founder is present.
- **Rule.** Search with `rg`, `recollq -c ~/.recoll-hex-expan -t -q "<query>"`, `fzf`, or the code graph.
- **Evidence.** `CLAUDE.md` "Search tools (binding for all agents)" names `fzf`, the graph and `recoll` (CONFIRMED). It does not mention `rg` or prohibit it. The incident behind the instruction: UNVERIFIED.

## P11. `gh pr checks --watch` blocked the shell for more than 120 seconds

- **What happened.** Run in the foreground, `gh pr checks --watch` blocked the shell for more than 120 seconds.
- **Rule.** Background any long-running `gh` watch and give it a timeout. Poll the result instead of waiting in the foreground.
- **Evidence.** UNVERIFIED. No command log was found in the repo.
- **Status.** UNVERIFIED.

## P12. actionlint does not check the arguments passed to tools

- **What happened.** The Browsertime flag error in P1 passed workflow syntax checks. It failed only in the live run (runs `41343160794` failed; `41343304723` and `41343374398` passed on `0042880`).
- **Repo state.** No actionlint step or config exists in this repo: no reference in `.github/`, `scripts/` or `package.json` (CONFIRMED).
- **Rule.** Treat a workflow change that calls an external tool as untested until a live run passes.
- **Evidence.** Run IDs above (CONFIRMED). The claim about what actionlint does and does not check: UNVERIFIED (stated in the source facts; not reproduced here).
