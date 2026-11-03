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
- **Repo state.** Master (77cc649) still has `--chrome.headless` (line 61) and `--chrome.args no-sandbox` (line 62). The fix is commit `0042880` on PR #116. It is an ancestor of the PR head at check time (`eb25878`), of `593b4a8`, and of the current head `70085a0` (checked).
- **Evidence.**
  - Run `41343160794` failed on commit `a9c5179` (checked with `gh run view`).
  - Runs `41343304723` and `41343374398` passed on `0042880` (checked).
  - Commit `0042880` message: Browsertime 28 reads a top-level `--headless`, and `--chrome.headless` "was ignored without an error" (checked).
  - PR #116, open (checked).
- **Status.** CONFIRMED for the runs, commits, PR and workflow lines. The silent ignore is stated in commit `0042880` ("ignored without an error"), and the `--version` misreport in commit `260acb3` ("prints 1.0.0 for 28.4.0"). Neither was reproduced here, so the live `--version` behaviour is UNVERIFIED.

## P2. The secret and the `--no-sandbox` browser share one job (PR #116)

- **What happened.** In an earlier state of PR #116, Chrome ran with `--no-sandbox` while loading measured pages (sourcery-ai High, anchored at commit `63432a5`). On master, `PROBE_INGEST_SECRET` is injected in a later step of the same `measure` job, so a browser exploit in the earlier step could reach the secret. Master's own flag is written as `no-sandbox` without the dashes (line 62), so Chrome does not receive it (see P1). The shared-job layout is still on master.
- **Why.** A step or job was treated as an isolation boundary. It is not one.
- **Rule.** Split the work into two jobs. The first job runs the browser and has no secrets. The second job holds the secret and posts results, receiving the data through an artifact.
- **Repo state.** Master has one job, `measure` (line 20). The secret is injected at line 74. PR #116's head at check time (2026-11-02) is `70085a0`. Earlier heads `eb25878` and `593b4a8` split the work into `measure` (Chrome, no secrets, no `--no-sandbox`) and `send` (holds `PROBE_INGEST_SECRET`, downloads the results as an artifact). The split is on the PR branch, not on master. At `70085a0` the `send` job sets `environment: probe-ingest`, which Cubic says does not protect the secret while it stays repository-level (see Attribution).
- **Evidence.**
  - sourcery-ai inline review comment on `real-browser-latency.yml`, rated **High**, "Measured pages bypass Chrome's sandbox". Anchored at commit `63432a5`, which passes `--chrome.args=--no-sandbox`. It names the later step that receives `PROBE_INGEST_SECRET` (checked on the API and with `git show`).
  - Job layout on master (checked).
  - PR #116 heads `eb25878`, `593b4a8` and `70085a0`: `rg` finds no `--no-sandbox` in the workflow, and `PROBE_INGEST_SECRET` appears only in the `send` job and the header comment (checked). A PR comment says the High was addressed in `eb2587876` (checked).
- **Attribution.**
  - The High finding is from sourcery-ai (checked on the API).
  - The Cubic P1 on head `70085a0` is API-confirmed: `environment: probe-ingest` does not protect the repository-level `PROBE_INGEST_SECRET` (`.github/workflows/real-browser-latency.yml:114` at `70085a0`; review comment by `cubic-dev-ai[bot]`). It is a different finding from the sourcery High above. An earlier version of this lesson cited a Cubic P1 about a shared job as a "founder paste". No Cubic comment on PR #116 says that, so that attribution is withdrawn.
  - The other Cubic findings on this file (CONFIRMED on the API): a P3 about `chromedriver --version` (review on `0042880`); a P2 that the summary artifact name is not unique across reruns (review on `eb25878`); and a P2 that the file header describes branch dispatch wrongly (review on `70085a0`).

## P3. Vercel Function Storage is team-wide and grows with every production deploy

- **What happened.** Storage kept growing with each production deploy. Moving release files to R2 or B2 did not reduce it. Deployment listing is paginated with `until`, and large results overflowed the tool output.
- **Why.** Stated cause: storage is team-wide and each deploy adds to it, so moving release files does not change the total.
- **Rule.** Before cleanup, confirm what the meter counts and whether it is per team or per project. Page deployment listings with `until`, save the output to a file, and parse it with a script.
- **Evidence.** None in the repo. `rg` over `docs/` and `scripts/` for "Function Storage" matched only this lesson file (CONFIRMED). No other record was found in those folders. No deployment or run IDs were given.
- **Status.** UNVERIFIED.

## P4. Relative paths in skill-gate writes produced a stray copy

- **What happened.** Gate lines were written with a relative path from inside the gate folder. They ended up in a stray copy.
- **Where the records live.** `$(git rev-parse --git-dir)/skill-gates`. In the main checkout the git dir is `.git`, so the folder is `<main checkout>/.git/skill-gates`. It exists and holds `agent_*.md` and `agent_*.txt` files (checked).
- **Rule.** Build the gate path as an absolute path from `git rev-parse --git-dir` before writing. Never write with a relative path from inside the gate folder.
- **Evidence.** Gate folder layout (CONFIRMED). The stray-copy incident itself: UNVERIFIED.

## P5. The latency probe's code sat in an untracked folder with one copy

- **What happened.** The probe's code lived in an untracked folder with a single copy.
- **Current state.** The probe source is committed on `origin/feat/latency-probe-source`: commit `7c3e7cf` ("add the latency probe source under latency-probe/"), with `42a1c99` on top (checked; a docs commit, not probe source). It is not on master. Master tracks only `scripts/latency/summarize-browsertime.mjs` (with its test) and the workflow.
- **Rule.** Deployable code lives in a tracked path on master or on a PR branch. Check `git ls-files` before relying on a folder. An untracked folder is one copy.
- **Evidence.** Commit `7c3e7cf` is the probe source and `42a1c99` is a docs commit (both CONFIRMED). The original untracked state: UNVERIFIED (not seen in this session).

## P6. A neutral Cubic check hid a quota stop

- **What happened.** Cubic reportedly hit its monthly line quota (40,032 of 40,000; UNVERIFIED). Its check then reported neutral on master commits.
- **Rule.** A neutral Cubic check means no review ran. Read the review comments before calling a PR clean.
- **Evidence.** Neutral Cubic check runs on master (check-runs API, CONFIRMED): `0c4e3f5` dated 2026-11-01 (checked directly), and at least 37 more dated 2026-10-16 to 2026-10-25 from one scan of the 100 newest master commits since 2026-10-15. That scan silently dropped some failed API calls, so 37 is a lower bound. A neutral run on 2026-11-01 does not fit the 2026-10-30 resume date in the source facts, so that date is not supported. The quota figures are UNVERIFIED: searches for `40,032` and `40032` in `docs/agent_ledger.jsonl` found nothing. Cubic was active on PR #116, which has reviews on `real-browser-latency.yml` (CONFIRMED).
- **Status.** UNVERIFIED.

## P7. The probe's schedule runs only from master, and each run writes to production

- **What happened.** The probe's cron trigger fires only from the default branch. Branch tests need a manual dispatch. Each run posts signed rows to the probe's ingest endpoint.
- **Repo state.** `.github/workflows/real-browser-latency.yml` has the header comment "Scheduled runs only fire from the default branch. Use workflow_dispatch to test a branch." (line 5). Triggers are `schedule: "*/30 * * * *"` (lines 8-9) and `workflow_dispatch` (line 10). The job posts signed results to the probe using `PROBE_INGEST_SECRET`.
- **Rule.** Test a branch with `gh workflow run real-browser-latency.yml --ref <branch>`. Assume each run writes real rows.
- **Evidence.** Workflow triggers and header (CONFIRMED). The endpoint is `expan-latency-probe.vercel.app/api/ingest` (master line 85, CONFIRMED). The PR #116 branch header (line 7 at `70085a0`) says a branch dispatch posts to the production probe (CONFIRMED on the branch). Cubic's P2 on `70085a0` says that header is wrong if the environment is master-only. Master's header does not say so, and whether master's target is production: UNVERIFIED. The run ID of the incident: UNVERIFIED.

## P8. The identity file has no legal-name field

- **What happened.** An automated name check was run against the identity file. The file has author fields but no legal-name field, so the check could not cover the legal name.
- **Repo state.** The book identity file (`books/<book-id>.json`, main checkout) has `author` and `cover.author` keys and no legal-name key. This check read key paths only. No values were read or printed.
- **Rule.** A name check covers only the fields it reads. Keep the legal name in a separate reference and check against that. Never print the legal name in chat or in commits.
- **Evidence.** Key-path check of the book identity file (CONFIRMED). The incident itself: UNVERIFIED.

## P9. An evidence line claimed a search had run before it ran

- **What happened.** An evidence line said a search had been done before it ran. It was caught and corrected.
- **Rule.** Run the check first, then write the evidence line from its actual output.
- **Evidence.** UNVERIFIED. No PR, run, or commit was given, and none was found in the repo.
- **Status.** UNVERIFIED.

## P10. Use `rg`, `recollq`, `fzf` or the code graph, not `grep`, in the founder's presence

- **What happened.** Instruction from the founder in this session: do not use `grep` when the founder is present.
- **Rule.** Search with `rg`, `recollq -c ~/.recoll-hex-expan -t -q "<query>"`, `fzf`, or the code graph.
- **Evidence.** `CLAUDE.md` "Search tools (binding for all agents)" names `fzf`, the graph and `recoll` (CONFIRMED). It does not mention `rg` or prohibit it; `rg` comes from the founder's instruction. The incident behind the instruction: UNVERIFIED.

## P11. `gh pr checks --watch` blocked the shell for more than 120 seconds

- **What happened.** Run in the foreground, `gh pr checks --watch` blocked the shell for more than 120 seconds.
- **Rule.** Background any long-running `gh` watch and give it a timeout. Poll the result instead of waiting in the foreground.
- **Evidence.** UNVERIFIED. No command log was found in the repo.
- **Status.** UNVERIFIED.

## P12. Only the live run caught the P1 argument error

- **What happened.** The Browsertime flag error in P1 was not caught before the live run. It failed only in the live run (runs `41343160794` failed; `41343304723` and `41343374398` passed on `0042880`). Which pre-push checks ran is not recorded (UNVERIFIED).
- **Repo state.** On master (`77cc649`) no workflow linter is configured: no actionlint, yamllint or zizmor reference in `.github/`, `scripts/` or `package.json` (CONFIRMED). Branch `ci/lint-workflows` (`abb176b`) adds an actionlint workflow at `.github/workflows/lint-ci.yml`; it is not on master. ESLint covers `src` and `payments` only.
- **Rule.** Treat a workflow change that calls an external tool as untested until a live run passes.
- **Evidence.** Run IDs above (CONFIRMED). The claim about what actionlint does and does not check: UNVERIFIED (stated in the source facts; not reproduced here).

## P13. A workflow file in the PR can disable its own gates

- **What happened.** The lint gate on PR 117 runs the workflow file from the PR. A PR can edit `lint-ci.yml` to drop or neutralise the gitleaks and ruff jobs, and the run still passes. Cubic raised this as P1 and Sourcery as Medium on the same root cause.
- **Origin.** PR 117 threads `PRRT_kwDOUrokqs6yfTcc` (Cubic P1, open at triage) and `PRRT_kwDOUrokqs6yfRkt` (Sourcery Medium, open at triage). The header of `.github/workflows/lint-ci.yml` (lines 10-12) states the limit.
- **Lesson or rule.** A check that the PR defines cannot enforce itself. Enforcement comes from branch protection: list the gates as required status checks, so a job the PR removes leaves a missing required check and blocks the merge. A base-controlled workflow (`pull_request_target`, running no PR code) is the code-side follow-up. Until both exist, a gate added by a PR is advisory for that PR. This is an owner action.

## P14. A fallback range must fail closed

- **What happened.** Two PR 117 gates fell back to a narrower range when the expected one was not available. Gitleaks used `HEAD --not --remotes=origin` when the push had no usable before SHA. Once `origin/<branch>` points at HEAD, that range is empty and the job passed with nothing scanned. Ruff fell back to `HEAD~1`, which linted only the last commit of a multi-commit push.
- **Origin.** Sourcery High and Cubic P1 on the gitleaks range (`PRRT_kwDOUrokqs6yfRko`, `PRRT_kwDOUrokqs6yfTcW`, resolved by `f4f8bc4`). Cubic P2 on the ruff fallback (`PRRT_kwDOUrokqs6yfTcl`, resolved by `1cdfef8`). Reproduced in a scratch repo: with `refs/remotes/origin/feature` at HEAD, `git log HEAD --not --remotes=origin` lists 0 commits and a full scan lists 2.
- **Lesson or rule.** When the trusted range cannot be computed, scan the full reachable history or exit 1. Never silently choose a smaller range. Where a scan depends on a range, check that the range is non-empty before reporting success.

## P15. A gate reads its config from the trusted ref, not the PR checkout

- **What happened.** The gitleaks step read `.gitleaks.toml` from the PR checkout, so a PR could add permissive rules or allowlists next to a secret. A PR-added `.gitleaksignore` would suppress its own leak. Ruff could be switched off by a PR's ruff config.
- **Origin.** Sourcery High `PRRT_kwDOUrokqs6yfRk1` and Cubic P1 `PRRT_kwDOUrokqs6yfTca` (both resolved by `abb176b`). Cubic P1 `PRRT_kwDOUrokqs6ypygj` on `.gitleaksignore` (resolved by `1cdfef8`). Ruff `--isolated` and `--ignore-noqa` (`2ba7927`).
- **Lesson or rule.** Read every gate's config from the base ref, or ignore the PR's copy. Turn off config discovery (`--config`, `--isolated`). Delete any PR-supplied ignore file before the scan. An inline `# noqa` or `gitleaks:allow` comment is not a configuration.

## P16. Match every extension the platform accepts

- **What happened.** The actionlint step globbed `*.yml` only, so `.yaml` workflows were never checked by actionlint or ShellCheck. GitHub accepts both extensions.
- **Origin.** Sourcery Medium `PRRT_kwDOUrokqs6yfRk8` and Cubic P2 `PRRT_kwDOUrokqs6yfTcn`. Both resolved by `1cdfef8`, which uses `-name '*.yml' -o -name '*.yaml'`.
- **Lesson or rule.** For a gate, list every extension the tool or platform accepts before writing the glob. A glob that matches one of two valid extensions skips the other without an error.

## P17. Keep one concern in one PR

- **What happened.** PR 117 is a lint-gate PR, but its branch carried five commits for the real-browser latency workflow and its summarizer: `c8a7d08`, `5526954`, `673b34b`, `74dea50` and `1ad8df8`. Their review threads were about latency code, not about the lint gates.
- **Origin.** The five commits (`git log --oneline 2ba7927..HEAD` on `ci/lint-workflows`, before the revert). The revert commit `b7c3eca` removes them and restores the lint-only diff against master.
- **Lesson or rule.** Before a PR is pushed, compare `git diff --stat origin/master...HEAD` with the PR title. Move any unrelated commit to its own branch first. A branch that carries two concerns needs two reviews.

## P18. A comment must not claim more than the code enforces

- **What happened.** The real-browser workflow comment said the signing key stayed out of argv, which read as a stronger protection than the code gave. The key was still in the Node process environment. Cubic P3 `PRRT_kwDOUrokqs6yxxZJ` (resolved) asked for the claim to be narrowed.
- **Origin.** Cubic P3 thread on `real-browser-latency.yml`. Commit `1ad8df8` narrowed the claim; that file is removed from the lint branch by `b7c3eca`.
- **Lesson or rule.** State a guarantee in a comment only where the code gives it, and state the limit next to it. A reviewer reads the comment as a claim.

## P19. A test gate must count passes, not only the exit code

- **What happened.** An empty explicit test file passes under `node --test`. The CI step could therefore report success after the summarizer's tests were emptied, with exit 0.
- **Origin.** Cubic P2 `PRRT_kwDOUrokqs6yxKrU` on `.github/workflows/ci.yml` (resolved). Commit `fcb682b` makes the step require at least 22 passing tests and zero failures.
- **Lesson or rule.** A test step that can pass with zero tests must set a minimum pass count and fail below it. An exit code alone does not show that any test ran.

## P20. A finite number can serialise as null after rounding

- **What happened.** The summarizer rounded with `Math.round(v * 10) / 10`. Multiplying by 10 first overflows values near `Number.MAX_VALUE` to `Infinity`. `JSON.stringify` writes `Infinity` as `null`. The run exited 0 and wrote `null` metrics. Reproduced on the pre-fix head `b3cc6be` with a browsertime input of 1e308.
- **Origin.** Cubic P2 `PRRT_kwDOUrokqs6yxKrf` on `scripts/latency/summarize-browsertime.mjs` (open at triage). Fixed in `393919e`, with the new test "exits 1 and writes nothing when a finite metric overflows during rounding".
- **Lesson or rule.** After an arithmetic step that can overflow, check `Number.isFinite` on the value that is written, not only on the input. A check on the input proves nothing about the output.

## P21. Cleanup must cover a failure after the first write

- **What happened.** The summarizer cleared old output at startup, but it did not clear output when a write failed partway. With the second `writeFileSync` made to throw ENOSPC, the run exited 1 and left `expanpress-home.json` on disk, which contradicted the header's promise. Reproduced on `b3cc6be`.
- **Origin.** Cubic P2 `PRRT_kwDOUrokqs6yxKrq` on `scripts/latency/summarize-browsertime.mjs` (open at triage). Fixed in `393919e`: a write failure removes every expected output before exit 1.
- **Lesson or rule.** If a run promises no partial output, the cleanup must run on every failure path after the first write, not only before the run starts.

## P22. Check that a failure fixture fails where the test says it does

- **What happened.** A repro of the write-failure case put a directory at a summary's output path. The run stopped at startup with `ERR_FS_EISDIR` from `rmSync`, before any write. That fixture would not have tested partial output at all. The shipped test injects ENOSPC on the second write with a preload module (`--import`), and the red run showed it failing before the fix.
- **Origin.** The scratch repro on `b3cc6be`, and the red-then-green run of the two new tests in `393919e` (22 pass and 2 fail before the fix; 24 pass after it).
- **Lesson or rule.** Before a failure test is trusted, check that the failure is raised at the step it targets. Read the stack or the message of the red run. A fixture that fails earlier proves nothing about the later step.

## P23. Ledger `ts` is the append time; the review time goes in `ts_claimed`

- **What happened.** The backfill rows at `docs/agent_ledger.jsonl` lines 855-861 put the PR review time in `ts`. Ledger order then no longer shows when each entry was written, and the latest action is ambiguous.
- **Origin.** Cubic P2 `PRRT_kwDOUrokqs6yyS82` on `docs/agent_ledger.jsonl` line 855 (open at triage). Fixed by appending a corrective row with `ts` set to the append time and `ts_claimed` set to the historical time. Existing lines are not edited.
- **Lesson or rule.** Set `ts` with `date -u` at the moment of the append. Put any historical or claimed time in `ts_claimed` only. Never edit a ledger line to correct it; append a row that says what changed.
