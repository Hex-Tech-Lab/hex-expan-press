# Sprint-10 Creator Portal / UI-State Adversarial Audit Report (AGY)

**Auditor:** AGY (`gemini-3.8-flash-low`)  
**Workspace:** `Hex-Tech-Lab/hex-expan-press`  
**Execution Mode:** READ-ONLY (Analysis & Verification)  
**Verification Gate:** `pnpm --dir web exec tsc --noEmit` exited code `0`.  
**Operating Posture:** Zero-Trust E2E Traversal governed by [UNIVERSAL_DNA.md](file:///home/kellyb_dev/projects/hex-expan/docs/templates/UNIVERSAL_DNA.md) and [10X_HOSTILE_ADVERSARIAL_AUDIT.md](file:///home/kellyb_dev/projects/hex-expan/docs/10X_HOSTILE_ADVERSARIAL_AUDIT.md).

---

## 1. Premise Gate Verification

| Artifact / Path | Status | Verification Detail |
| :--- | :--- | :--- |
| `docs/templates/UNIVERSAL_DNA.md` | **CONFIRMED** | Canonical DNA loaded; 4 tenets and premise gate applied. |
| `docs/10X_HOSTILE_ADVERSARIAL_AUDIT.md` | **CONFIRMED** | 7-vector hostile audit specification verified. |
| `web/app/creator/**` | **CONFIRMED** | Next.js App Router creator portal directory tree verified. |
| `web/app/creator/consents/consent-cards.tsx` | **CONFIRMED** | Client component managing C1/C2 sign states and C3 handoff. |
| `web/app/creator/consents/actions.ts` | **CONFIRMED** | Server action `signConsentAction` invoking `submit_consent` RPC. |
| `web/app/creator/review/` | **CONFIRMED** | Stepper review client and RSC verified. |
| `web/app/creator/review/stepper-focus.test.ts` | **DRIFTED** | Present under [web/app/creator/review/__tests__/stepper-focus.test.ts](file:///home/kellyb_dev/projects/hex-expan/web/app/creator/review/__tests__/stepper-focus.test.ts) (nested under `__tests__`). |
| `web/src/lib/skew-retry-fetch.ts` | **CONFIRMED** | One-shot PGRST303 clock-skew fetch wrapper present. |
| `supabase/migrations/20261003000100_review_codes_c_to_q.sql` | **CONFIRMED** | Migration renaming review codes C1..C8 to Q1..Q8 verified. |
| `payments/bake_checkout.ts` | **CONFIRMED** | `assertLaunchConsents` verifies C1/C2/C3 supersession chains and `document_sha256`. |

---

## 2. Executive Blast Radius Table

| Severity | Subsystem Affected | Blast Radius (0.00–1.00) | Root Mechanism | Exact File & Line Range | Audit Vector |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **P1** | Portal Consent Validation | 0.82 | `consents/page.tsx` reads `consents` without checking supersedes chain or `signed_at` validity; displays superseded consent as valid `Signed ✓` | [web/app/creator/consents/page.tsx#L38-L56](file:///home/kellyb_dev/projects/hex-expan/web/app/creator/consents/page.tsx#L38-L56) | Vector 3 / Vector 5 |
| **P1** | Dashboard Consent Validation | 0.82 | `dashboard/page.tsx` filters `decision = 'given'` across all consents for primary product without supersession-chain pruning | [web/app/creator/dashboard/page.tsx#L65-L116](file:///home/kellyb_dev/projects/hex-expan/web/app/creator/dashboard/page.tsx#L65-L116) | Vector 3 / Vector 5 |
| **P2** | Auth Server Actions Skew Resilience | 0.65 | `createSsrClient` used in `signInWithGoogleAction`, `signInWithOtpAction`, `signOutAction` lacks `createSkewRetryFetch` wrapper | [web/src/lib/supabase-ssr.ts#L23-L43](file:///home/kellyb_dev/projects/hex-expan/web/src/lib/supabase-ssr.ts#L23-L43) | Vector 2 / Vector 5 |
| **P2** | Client Mutation Retry Gap | 0.58 | Server Actions (`signConsentAction`, `submitReviewAnswerAction`) do not retry on PostgREST/network fail; client error prompts user retry without idempotency lock | [web/app/creator/consents/actions.ts#L66-L80](file:///home/kellyb_dev/projects/hex-expan/web/app/creator/consents/actions.ts#L66-L80), [web/app/creator/review/actions.ts#L27-L35](file:///home/kellyb_dev/projects/hex-expan/web/app/creator/review/actions.ts#L27-L35) | Vector 2 / Vector 3 |
| **P2** | Review Stepper A11y & Form Association | 0.45 | Form controls (`textarea#freetext`, radio inputs) disconnected from question heading; `aria-labelledby`/`aria-describedby` omitted | [web/app/creator/review/review-client.tsx#L316-L376](file:///home/kellyb_dev/projects/hex-expan/web/app/creator/review/review-client.tsx#L316-L376) | Vector 5 / Vector 7 |
| **P3** | Natural Code Sorting Drift in Review | 0.20 | Natural sort regex `/(\d+)/` handles Q1..Q8 but comment/lineage still asserts legacy C1 codes; test suite covers mock Q codes only | [web/app/creator/review/page.tsx#L12-L22](file:///home/kellyb_dev/projects/hex-expan/web/app/creator/review/page.tsx#L12-L22) | Vector 7 |

---

## 3. Forensic Findings & Critical Breakages

### Target 1: Product Binding Chain & Consent Supersession (Vector 3 / Vector 5)

#### Finding 1.1 (P1): Divergent Supersession Evaluation between Portal RSC and Backend/Baker
- **Flaw & Trigger:**  
  In [web/app/creator/consents/page.tsx#L38](file:///home/kellyb_dev/projects/hex-expan/web/app/creator/consents/page.tsx#L38) and [web/app/creator/dashboard/page.tsx#L65](file:///home/kellyb_dev/projects/hex-expan/web/app/creator/dashboard/page.tsx#L65):
  ```typescript
  const consentsRes = await supabase.from("consents").select("kind, decision").eq("decision", "given").eq("product_id", product.id);
  const given = new Set((consentsRes.data ?? []).map((c) => c.kind));
  ```
  The RSC query fetches all rows matching `decision = 'given'`. If a creator signs C2, and later the release PDF is updated (or consent is revoked/refused in a superseding row `decision = 'refused'`, `supersedes = <old_c2_id>`), the portal UI still reads `given.has("C2_release_approval") === true`.
- **E2E Contract Discrepancy:**  
  1. `startPublisherAgreementAction` in [web/app/creator/dashboard/actions.ts#L45-L66](file:///home/kellyb_dev/projects/hex-expan/web/app/creator/dashboard/actions.ts#L45-L66) enforces strict chain-head resolution: it loads `supersedes`, finds the chain head, and requires `head.decision === 'given'`.
  2. `bake_checkout.ts` in [payments/bake_checkout.ts#L91-L107](file:///home/kellyb_dev/projects/hex-expan/payments/bake_checkout.ts#L91-L107) enforces that only the un-superseded head determines consent validity, and checks `document_sha256` matching `products.release_sha256`.
  3. But `consents/page.tsx` and `dashboard/page.tsx` do **not** check the chain head. A superseded C2 row allows the portal to show "Signed ✓", while clicking "Open the agreement →" immediately aborts and redirects to `/creator/dashboard?error=c2_required`.
- **Blast Radius (0.82):**  
  Creators see their release consent marked as signed, yet are blocked from signing C3, or believe their product is cleared when checkout baking (`bake_checkout.ts`) fails closed.
- **Minimal Surgical Fix Sketch:**  
  Extract a shared helper `resolveConsentHeads(consents: ConsentRow[])` (mirroring `bake_checkout.ts` and `dashboard/actions.ts`) and use it in `dashboard/page.tsx` and `consents/page.tsx`.

#### Finding 1.2 (P2): Stale Client-Side Optimistic State vs Server Truth in `ConsentCards`
- **Flaw & Trigger:**  
  In [web/app/creator/consents/consent-cards.tsx#L126-L127](file:///home/kellyb_dev/projects/hex-expan/web/app/creator/consents/consent-cards.tsx#L126-L127):
  ```typescript
  const c1Done = hasC1 || c1State.ok;
  const c2Done = hasC2 || c2State.ok;
  const allLegal = c1Done && c2Done;
  ```
  Once `signConsentAction` returns `{ ok: true }`, `c1State.ok` permanently latches to `true` in client state. If `revalidatePath` executes, `hasC1` becomes `true`. However, if the server later updates the product's `release_sha256`, the client retains `c2Done = true` without polling or revalidating the hash tie.
- **Contract Integrity Note:**  
  All portal mutations correctly route through `session.supabase.rpc("submit_consent", ...)` under caller RLS identity. Direct table inserts or updates to `consents` from client code are completely absent. The contract with the database RPC is strictly maintained.

---

### Target 2: Skew-Retry Mutation Coverage (Vector 2 / Vector 5)

#### Finding 2.1 (P2): `createSsrClient` Lacks Clock-Skew Fetch Retries
- **Flaw & Trigger:**  
  `createSkewRetryFetch` is wired in [web/src/lib/supabase-server.ts#L36](file:///home/kellyb_dev/projects/hex-expan/web/src/lib/supabase-server.ts#L36) for query execution via `validateJwt` and `clientWithJwt`.
  However, in [web/src/lib/supabase-ssr.ts#L23-L43](file:///home/kellyb_dev/projects/hex-expan/web/src/lib/supabase-ssr.ts#L23-L43):
  ```typescript
  export async function createSsrClient() {
    const cookieStore = await cookies();
    return createServerClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
      cookieOptions: { ... },
      cookies: { ... }
    });
  }
  ```
  `createServerClient` is instantiated **without** custom `global.fetch`.
- **Mechanism of Failure:**  
  `createSsrClient` is invoked in:
  - `web/app/creator/signin/actions.ts` (`signInWithGoogleAction`, `signInWithOtpAction`)
  - `web/app/auth/callback/route.ts` (OAuth code exchange)
  - `web/app/creator/dashboard/actions.ts` (`signOutAction`)
  If the Supabase Auth server or GoTrue/PostgREST boundary issues a JWT with future `iat` during OAuth code exchange or immediate follow-up reads on that client, the request will immediately fail with HTTP 401 without retry.
- **Blast Radius (0.65):**  
  Intermittent authentication failures during login spikes or clock drift between Vercel serverless containers and Supabase.
- **Minimal Surgical Fix Sketch:**  
  Pass `global: { fetch: createSkewRetryFetch(fetch, jwtSkewRetryDelayMs()) }` into `createServerClient` in `web/src/lib/supabase-ssr.ts`.

#### Finding 2.2 (P2): Mutation Double-Submit & Clock-Skew in `signConsentAction` & `submitReviewAnswerAction`
- **Flaw & Trigger:**  
  In [web/app/creator/consents/actions.ts#L66](file:///home/kellyb_dev/projects/hex-expan/web/app/creator/consents/actions.ts#L66):
  ```typescript
  const { error } = await session.supabase.rpc("submit_consent", { ... });
  ```
  The call uses `session.supabase`, which uses `clientWithJwt` and thus **does** have `createSkewRetryFetch` on its fetch transport.  
  - If a clock-skew error (401 PGRST303) occurs, `createSkewRetryFetch` retries the fetch.
  - Because `submit_consent` is an RPC (POST request with JSON body), `init.body` is a string (not a ReadableStream), so `createSkewRetryFetch` **will** retry the RPC!
  - **Risk Assessment:**  
    In Postgres, HTTP 401 PGRST303 happens *before* the transaction begins or executes (at the PostgREST JWT verification layer). Therefore, the first attempt was never committed. Retrying the POST RPC does **not** result in a double-insert. Furthermore, migration `20261004000600_submit_consent_race_lock.sql` introduces an advisory xact lock and supersedes pointer linking.
  - **Client-Side Form Button:**  
    The 2026-10-03 hardening converted the UI to `<SubmitButton>` using `useFormStatus()`, which disables the button while the action promise is in flight. This prevents client double-clicks during the ~350ms skew sleep!
  - **Remaining Gap:**  
    In `web/app/creator/review/review-client.tsx`, `submitReviewAnswerAction` is called directly from `saveAndNext()` (not inside a `<form>` action). It uses an internal `busy` boolean state. While `busy` disables the button, a transient network error throws and prompts the user to retry manually. If the server partially processed the RPC before a network drop, re-submitting invokes `submit_review_answer` again. Fortunately, `submit_review_answer` performs an upsert on `(creator_user_id, item_id)`, so duplicate calls are idempotent.

---

### Target 3: Accessibility (A11y) & Review Stepper After Q-Code Rename (Vector 5 / Vector 7)

#### Finding 3.1 (P2): Stepper Form Controls Lack Explicit Association to Question Heading
- **Flaw & Trigger:**  
  In [web/app/creator/review/review-client.tsx#L316-L376](file:///home/kellyb_dev/projects/hex-expan/web/app/creator/review/review-client.tsx#L316-L376):
  The question heading is rendered as:
  ```tsx
  <h2 id="review-question-text" ref={questionRef} tabIndex={-1} ...>
    {item.question}
  </h2>
  ```
  And the text input is:
  ```tsx
  <label htmlFor="freetext" ...>Other / the correct fact</label>
  <textarea id="freetext" ... />
  ```
  Screen readers navigating to `textarea#freetext` or radio options do not announce the question text as the field's description because neither `aria-describedby="review-question-text"` nor `aria-labelledby` includes the heading id on the interactive input.
- **Blast Radius (0.45):**  
  Blind or vision-impaired creators using screen readers tab into form controls without hearing the question context unless they navigate backwards to the preceding heading.
- **Minimal Surgical Fix Sketch:**  
  Add `aria-describedby="review-question-text"` to `textarea#freetext` and `role="radiogroup" aria-labelledby="review-question-text"` to the option group.

#### Finding 3.2 (P3): Analysis of Test Coverage in `stepper-focus.test.ts`
- **Location:** [web/app/creator/review/__tests__/stepper-focus.test.ts](file:///home/kellyb_dev/projects/hex-expan/web/app/creator/review/__tests__/stepper-focus.test.ts)
- **What It Covers:**
  1. Initial render does not steal focus (verifies `tabindex="-1"` and `activeElement !== h2`).
  2. Clicking "Back" moves focus to the previous question heading with `{ preventScroll: true }`.
  3. "Save & next" success moves focus to the next question heading with `{ preventScroll: true }` after the 500ms transition.
  4. "Save & next" failure retains focus and does not advance the question.
  5. Heading hierarchy check confirms exactly one `<h1>` ("Manuscript review") and the question as `<h2>`.
  6. Uses mock codes `Q1`, `Q2`, `Q3` matching the new Q-code convention.
- **What It Misses:**
  1. **Q-Code Sorting Validation:** Does not test `naturalCode` sorting against alphanumeric Q-codes mixed with legacy/other codes (e.g. `Q1`, `Q10`, `Q2`).
  2. **Empty Options vs Free Text A11y:** Does not test whether screen readers receive accessible names when questions have no preset options (`isNoAnswerNeeded` or free-text only).
  3. **Canvas Accessibility Attributes:** Does not test the canvas fallback or `aria-describedby="review-page-text review-question-text"`.
  4. **Leftover Hardcoded Strings:** Audit of `web/app/creator/review/` confirms **zero** leftover hardcoded `"C1"`..`"C8"` review strings in UI copy, IDs, or ARIA labels. All codes are rendered dynamically via `{item.code}`.

---

## 4. Skills Run & Findings

- **Skill / Tool:** `run_shell_command` (`pnpm --dir web exec tsc --noEmit`)  
  **Result:** Exited with code `0`. Zero type errors across Next.js creator portal code and shared libraries.
- **Skill / Tool:** `view_file` & Regex Audits  
  **Result:** Scanned all source files in `web/app/creator/**`, `payments/bake_checkout.ts`, and Supabase migrations.
- **Unavailable Tools:** No external visual regression browser runners or QA-intel CLI diff scripts were invoked inline; full repo files were audited directly via workspace inspection tools.

---

## 5. Immediate Remediation Recommendations (Orchestrator Punch List)

1. **[P1 Fix] Unify Consent Chain Resolution:**  
   Import and apply a chain-head resolver in `web/app/creator/consents/page.tsx` and `web/app/creator/dashboard/page.tsx` so superseded or revoked consents never show as active.
2. **[P2 Fix] Add Skew-Retry to SSR Client:**  
   Update `web/src/lib/supabase-ssr.ts` to include `global: { fetch: createSkewRetryFetch(fetch, jwtSkewRetryDelayMs()) }` in `createServerClient`.
3. **[P2 Fix] Enhance Review Form A11y:**  
   Connect `review-question-text` to `textarea#freetext` via `aria-describedby` in `review-client.tsx`.
