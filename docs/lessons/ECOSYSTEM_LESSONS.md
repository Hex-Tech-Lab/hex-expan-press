# Ecosystem lessons

Portable lessons from running CI, cloud deploys, review bots and agent-driven work. Each one stands on its own. The "Origin" line gives where it was learned, for traceability only. The repo-specific account of each lesson is in `PROJECT_LESSONS_HEX_EXPAN.md`.

**Status key**

- **CONFIRMED**: checked against the origin system (PR, run, commit or file) in the session that wrote this.
- **UNVERIFIED**: reported but not confirmed in that session.

---

## E1. Unknown tool flags can be dropped silently, and `--version` can lie

- **What happened.** A browser-automation CLI (Browsertime 28.x) ignored an unknown option (`--chrome.headless`) with no error. The browser then ran in a mode the runner could not support and failed to start. The arguments were also passed without the leading dashes they need. The CLI's `--version` printed a wrong number.
- **Why.** The tool accepts unknown options without complaint. A version string is not reliable evidence of the installed release.
- **Rule.** Check each option against the installed version's own documentation or source. Read the version from the installed package's manifest, not from `--version`. Pass flags with their leading dashes. Confirm with a live run.
- **Origin.** hex-expan run `41343160794` failed on `a9c5179`; runs `41343304723` and `41343374398` passed on `0042880`. Fix in PR #116, which is open. **CONFIRMED** for the runs and commits. The silent ignore and the `--version` misreport are stated in commit messages (`0042880`, `260acb3`). Neither was reproduced, so the `--version` behaviour stays **UNVERIFIED**.

## E2. Only a live run caught a tool argument error

- **What happened.** A workflow passed the E1 flag error with no finding in any check before the push. It failed only in the live run.
- **Why.** Workflow linters check YAML structure and the platform schema. They do not parse arguments passed to external tools inside `run:` steps.
- **Rule.** A workflow change that calls an external tool is untested until a live run passes. Use a manual dispatch on the branch to get that run.
- **Origin.** Same runs as E1. On master (`77cc649`) this repo configures no workflow linter (no actionlint, yamllint or zizmor; **CONFIRMED**). Branch `ci/lint-workflows` (`abb176b`) adds actionlint, but it is not on master. The pre-push checks are not recorded. The scope of linters' checks: **UNVERIFIED** (stated, not reproduced).

## E3. A step or a job is not a secret boundary

- **What happened.** A job ran a browser with `--no-sandbox` against third-party pages. A later step of the same job received a signing secret. A browser exploit in the earlier step could reach the secret. A review bot rated this High on the PR.
- **Why.** Steps in one job share the runner's filesystem and process space. Putting a secret in a later step does not protect it from code that runs earlier.
- **Rule.** Put untrusted-code steps in a job with no secrets. Put secrets in a separate job that receives only the data it needs, passed as an artifact.
- **Origin.** hex-expan PR #116, sourcery-ai review (High, path `.github/workflows/real-browser-latency.yml`): **CONFIRMED**. The Cubic P1 about the secret sharing a job with the `--no-sandbox` browser is cited as "Cubic web review (founder paste)". The GitHub API does not show it: no Cubic comment, review or issue comment on the PR mentions the sandbox or a shared job (**CONFIRMED** by search). **UNVERIFIED**. The API does show other Cubic findings on this file, none of them that P1: a P3 (`chromedriver --version`), a P2 (artifact name), and on the current head a P1 (`environment: probe-ingest` does not protect the repository-level secret).

## E4. Check what a storage meter counts before cleanup, and page listings through a script

- **What happened.** Storage kept growing with each production deploy of a hosting platform. Moving release files to external object storage did not reduce it. A deployment listing, paginated by a cursor, was too large for the tool output.
- **Why.** The meter counted deploy artifacts at team level. Moving release files did not change that total.
- **Rule.** Before cleanup, confirm what the meter counts and whether it is per team or per project. Page listings with the cursor parameter, write them to a file, and parse the file with a script.
- **Origin.** hex-expan, Vercel deploys. No record of this was found in the repo. **UNVERIFIED.**

## E5. Write the evidence line after the check runs, not before

- **What happened.** A gate's evidence line said a search had been done before it ran. A reviewer caught it and it was corrected.
- **Why.** The line was written from the plan rather than from the output.
- **Rule.** Run the check first. Write the evidence line from the actual output, including the command and its result.
- **Origin.** hex-expan. No PR, run or commit was given. **UNVERIFIED.**

## E6. Write gate records to absolute paths

- **What happened.** Gate lines written with a relative path from inside the gate folder ended up in a stray copy of the file.
- **Why.** The working directory at write time was not the directory the gate expected.
- **Rule.** Build the gate path as an absolute path from the repo's git directory (`git rev-parse --git-dir`) before writing. Never write with a relative path from inside the gate folder.
- **Origin.** hex-expan. The gate folder exists and holds the expected files (**CONFIRMED**). The stray-copy incident: **UNVERIFIED**.

## E7. Keep deployable code in tracked paths

- **What happened.** A monitoring probe's code sat in an untracked folder with only one copy.
- **Why.** The folder was never added to version control, so it had no history and no second copy.
- **Rule.** Deployable code lives in a tracked path on the default branch or a PR branch. Check the tracked file list before depending on a folder. An untracked folder is a single copy.
- **Origin.** hex-expan. The probe source is now committed on a feature branch (`7c3e7cf`; `42a1c99` on top is a docs commit) and not yet on the default branch (**CONFIRMED**). The original untracked state: **UNVERIFIED**.

## E8. A neutral review-bot check is not a pass

- **What happened.** A review bot reportedly hit its monthly line quota (UNVERIFIED). Its check then reported neutral on later commits.
- **Why.** A neutral result means the bot did not review the change. It does not mean the change is clean.
- **Rule.** Read the review comments before treating a neutral check as a pass. Track each bot's quota and when its reviews resume.
- **Origin.** hex-expan, Cubic. Neutral checks are **CONFIRMED** on at least 37 master commits dated 2026-10-16 to 2026-10-25, and on `0c4e3f5` dated 2026-11-01 (check-runs API). The 2026-10-30 resume date does not fit. The quota figures (40,032 of 40,000): **UNVERIFIED** (not found in the repo).

## E9. Scheduled workflows run only from the default branch

- **What happened.** A scheduled CI job runs only from the default branch. A branch can be tested only by a manual dispatch. Each run posts signed rows to the probe's ingest endpoint.
- **Why.** The schedule trigger is read from the default branch. Branch runs are not scheduled.
- **Rule.** Test a branch with a manual dispatch that names the ref (`gh workflow run <file> --ref <branch>`). Assume each run writes real data, and plan for it.
- **Origin.** hex-expan, `.github/workflows/real-browser-latency.yml` (header comment and triggers: **CONFIRMED**). The incident run ID: **UNVERIFIED**. The PR #116 branch header says the probe is production (**CONFIRMED** on the branch); master's target is **UNVERIFIED**.

## E10. An automated name check covers only the fields it reads

- **What happened.** An automated check ran against an identity file. The file has author fields and no legal-name field, so the check could not cover the legal name.
- **Why.** The check reads the fields it is given. An absent field is not flagged, so the gap looks like a pass.
- **Rule.** Keep the legal name in a separate reference and check against that. Record which fields a check covers. Never print the legal name in chat or in commits.
- **Origin.** hex-expan, the book identity file in the main checkout (key paths checked, values not read: **CONFIRMED** that no legal-name key exists). The incident: **UNVERIFIED**.

## E11. Search with approved tools, not `grep`, when the founder is present

- **What happened.** The founder asked that `grep` not be used in their presence. The approved routes are `fzf` (file names), `recollq` (file contents) and the code-structure graph. `rg` is also used under the founder's instruction.
- **Why.** Owner instruction. The reason behind it was not recorded.
- **Rule.** Use the approved search tools. Name the tool used in the output.
- **Origin.** hex-expan `CLAUDE.md`, "Search tools (binding for all agents)" (**CONFIRMED** that it names fzf, the graph and recoll; it does not name `rg`, whose use rests on the founder's instruction). The incident behind the rule: **UNVERIFIED**.

## E12. Background long-running CLI watches with a timeout

- **What happened.** A `gh pr checks --watch` run in the foreground blocked the agent's shell for more than 120 seconds.
- **Why.** The watch waits until checks finish, which can exceed the shell's tool time limit.
- **Rule.** Run any long-running watch in the background, with a timeout. Poll its result rather than waiting in the foreground.
- **Origin.** hex-expan. No command log was found. **UNVERIFIED.**
