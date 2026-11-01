# Skills catalogue: when to use each one (hex-expan)

Status: working catalogue, 2026-11-02. Governed by ADR 0062 and `AGENTS.md` §Universal Skills Mandate.
Scope: the skills listed for this workspace in the Skill tool. Names are the invocation names. Skills marked *user-only* are run by the founder, not by an agent.

Rule of thumb: pick the skill whose trigger matches the change you are about to make. Record the run in the turn's `### Skills Run & Findings` block, even when the result is "nothing found".

## 1. Mandatory on every relevant turn (Core)

| Skill | Use it when | Gate |
|---|---|---|
| `build-graph` (code-graph) | Start of any session, or after a repo change, to refresh the code graph | Run first |
| `explore-codebase` (code-graph-view) | Before reading files: module map, callers, flows | Before opening files |
| `review-delta` | Before any commit: blast radius of the diff against `origin/master` | Pre-commit |
| `refactor-safely` (code-refactor) | Any rename, move, or delete: dependency check first, dead-code check after | Before a mutation |
| `qa-intel` | `--mode diff` on every commit, `--mode full` at milestones | Standing gate |
| `code-reviewer` | Correctness, null-safety, API contract on the diff | Before PR |
| `simplify` | After a feature or fix lands: reuse, simplification, efficiency, altitude | Before PR. Behaviour must not change |
| `review-duplication` | Before adding a utility, type, or constant: check it does not already exist | Before PR |
| `impeccable` | Any UI, visual, or layout change | UI gate |
| `pr-review-workflow` (review-pr) | Opening or advancing a PR; full review loop | PR gate |

## 2. Select skills (activate on context match)

### Testing and verification
| Skill | Use it when |
|---|---|
| `verification-before-completion` | Before saying "done", "fixed", or "passing". Run the command and show the output |
| `runtime-verification` | Code passes lint and types but has not run: start the app, hit endpoints, check the browser |
| `tdd` / `test-driven-development` | Building a feature or fixing a bug test-first |
| `webapp-testing` | Browser checks of a running app |
| `e2e-testing` | Multi-step end-to-end flows |
| `race-condition-guard` | Concurrent writes, locks, double submit, idempotency |
| `systematic-debugging` / `diagnosing-bugs` | A bug with no known cause |

### Security
| Skill | Use it when |
|---|---|
| `security-review` / `ecc-security-review` | Auth, webhooks, signatures, secrets handling |
| `owasp-top-10` | Web input handling, injection, XSS, access control |
| `gha-security-review` | Any change under `.github/workflows/` |
| `differential-review` | Security review of a specific diff, including whether it reintroduces a fixed bug |
| `fp-check` | Checking whether a suspected finding is real before fixing it |

### Database
| Skill | Use it when |
|---|---|
| `database-sentinel` | Any change under `supabase/` or any `.sql`. PASS/FAIL gate |
| `supabase` | Any Supabase task: migrations, RLS, auth, CLI, logs |
| `supabase-postgres-best-practices` | Writing or changing tables, indexes, RLS, functions, or queries |
| `database-architect-10x` | Schema design decisions |
| `sql-queries` / `write-query` | Writing a query for analysis |

### Infrastructure and deploy
| Skill | Use it when |
|---|---|
| `deploy-to-vercel` | Deploying a Vercel project |
| `vercel-cli-with-tokens` | CLI work on Vercel, including env vars |
| `vercel-optimize` | Cost or performance of a deployed Vercel project |
| `upstash-redis-js`, `upstash-qstash-js`, `upstash-ratelimit-js` | Redis, QStash scheduling, or rate limits on Upstash |

### Frontend
| Skill | Use it when |
|---|---|
| `ui-ux-pro-max` | UI structure, components, accessibility, interaction design |
| `web-design-guidelines` | Review for the Web Interface Guidelines: accessibility, audit, UX |
| `web-perf` / `agent-skills:webperf` | Core Web Vitals, load time, rendering |
| `react-best-practices` | React or Next.js performance |
| `composition-patterns` | Component API design, compound components |
| `animate` / `motion-patterns` | Motion work |
| `dataviz` | Any chart, graph, or dashboard visual |

### Documentation and process
| Skill | Use it when |
|---|---|
| `comment-analyzer` | Comments added or changed in a PR |
| `pr-test-analyzer` | Test coverage gaps in a PR |
| `silent-failure-hunter` | Error handling, catch blocks, fallbacks |
| `type-design-analyzer` | New or changed types |
| `writing-for-agents` / `docs-writer` | Writing agent-facing docs or handovers |
| `llm-council` | A genuine multi-option decision with stakes. Not for factual lookups |

### Data and research
| Skill | Use it when |
|---|---|
| `data:analyze`, `data:statistical-analysis` | Analysis of numbers |
| `data:build-dashboard` | A data dashboard artifact |
| `last30days`, `live-research` | Current facts that may have changed |

## 3. User-only

| Skill | Note |
|---|---|
| `verify` | The founder runs it. Agents cannot |

## 4. How to choose quickly

1. Touching a database file? `database-sentinel` + `supabase-postgres-best-practices`.
2. Touching a workflow file? `gha-security-review`.
3. Touching UI? `impeccable` + `ui-ux-pro-max`.
4. Touching a webhook, signature, or secret? `security-review` + `owasp-top-10`.
5. Before "done"? `verification-before-completion` with real command output.
6. Anything else? Core list in section 1, always.
