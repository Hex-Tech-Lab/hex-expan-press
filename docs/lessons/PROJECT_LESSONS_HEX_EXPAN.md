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
  - The Cubic P1 about the secret sharing a job with the `--no-sandbox` browser is cited as "Cubic web review (founder paste)". The GitHub API does not show it: no Cubic comment, review or issue comment on PR #116 mentions the sandbox or a shared job (checked by search). **That P1 is UNVERIFIED** and rests on the founder's paste alone.
  - The API does show other Cubic findings on this file (CONFIRMED): a P3 about `chromedriver --version` (review on `0042880`); a P2 that the summary artifact name is not unique across reruns (review on `eb25878`); and, on `70085a0`, a P1 that `environment: probe-ingest` does not protect the repository-level `PROBE_INGEST_SECRET`, plus a P2 that the file header describes branch dispatch wrongly. None of these is the founder-pasted P1.

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
