# REVIEW VERDICT — the docs-sweep duplicate fix (`6ce4d85`) and the merge conflict resolution (`dc15d81`)

Reviewed: branch `rv2-dupe` tip `db9f12e` ("test(queue): update the enqueue()
call-site inventory after the docs sweep"), on top of `main`. The defect under
review was found by `rv-docsweep` §4; the fix is `6ce4d85`; `dc15d81` is the
merge that resolved one conflict in `electron/fitScorer.ts`.

Reviewer evidence: **`electron/rv2dupe.test.ts`, 46 tests I wrote and ran**, plus
**10 mutations I applied and reverted**. Every claim below is labelled *proved by
failing test I ran* or *reasoned from code*. I did not reuse the fixing agent's
harness or assertions; `electron/docsAutoQueue.crossProducer.store.test.ts`
exists and is good, but "the fixing agent tested it" is the one claim a reviewer
must not accept.

---

## 1. Verdict

# SHIP WITH FIXES — the duplicate is genuinely closed, and one residual duplicate path remains

**The defect in §4 of the prior verdict is fixed, and it is fixed the right way:**
one exported predicate, `jobDocWorkInFlight` (`electron/docAutoQueue.ts:188`),
asked by all three producers, with `jobCoveredByLiveTailor` deleted rather than
left behind as a second opinion. I reproduced the prior review's exact scenario
end-to-end against the real store and the real `processQueue` with only `fetch`
stubbed, and the job ends with **exactly one `cv` document and one
`cover_letter` document, from 1 CV tailoring + 1 CL tailoring + 2 reviews**, with
a second sweep+trigger pass adding nothing and spending nothing.

**But "the duplicate is gone" is an overstatement, and the overstatement is in
the fix's own framing.** The shared predicate answers *"is a live row going to
produce a first generation of this document?"* — which is the right question for
the sweep, because the sweep decides per unit against `needsDoc`. It is the
wrong question for the trigger, which **never consults `needsDoc` at all**: it
means "both documents", so a job that already has a CV gets a new one anyway. I
measured that: from one job with a CV whose review is in flight, a single fit
landing produces **3 `cv` documents and 2 `cover_letter` documents** — the exact
symptom count of the original defect, reached by the other road. Finding 1 below.

Everything else holds: all five previously-fixed defects are still fixed, the
conflict resolution is correct (with one honest caveat about redundancy), the
revival bound is unchanged at **80 attempts per job, all inside day one, 0 after**,
and `db9f12e`'s call-site inventory is correct as re-derived.

---

## 2. FIXED / STILL-BROKEN table

| # | Defect | Verdict | Test I ran | Result | Evidence |
|---|--------|---------|-----------|--------|----------|
| 1 | Hourly interval was a no-op (240 in the settings default and the backfill) | **STILL FIXED** | `DEFECT 1` ×2: arms the real timers and asserts `nextRunAt <= 3600000` and `intervalMinutes === 60` for both sweeps on a real store; plus a grep for a standalone `240` token across `database.ts` / `fitAutoScore.ts` / `docsAutoQueue.ts` | **proved by test I ran.** `fit_autoscore_interval_minutes` is 60 at `database.ts:96` and 60 at `database.ts:304-305`; both live timers read 3600000 | Mutation M5 (both 240s restored) → **2 of my tests fail.** Reverted. |
| 2 | The sweep ignored every generation precondition | **STILL FIXED** | `DEFECT 2`: below-threshold job, null-score job and no-base-CV job, each asserted on `maybeAutoEnqueueDocs`, `runDocsAutoQueueBacklog` **and** `enqueueDocsBacklog` | **proved by test I ran.** `autoDocQueueEligible` (`docAutoQueue.ts:79`) is one function; both sweep paths call it with `{ requireConfiguredBaseCv: true }`, the trigger without the flag | Mutation M6 (gate dropped from the periodic sweep) → **1 of my tests fails.** Reverted. |
| 3 | A live `pending`/`processing` `tailor_job_docs` row not treated as in-flight | **STILL FIXED** | `DEFECT 3` ×2 and `DEFECT 4`: a live and a `processing` tailor row stop both sweep paths; the revive budget is respected on both; **and** a revival is asserted to *charge* `autoRevives` and *apply* the 4h cooldown on each path | **proved by test I ran.** `jobDocWorkInFlight` is the only liveness check; `planUnit`'s old per-type check is gone | Mutation M2 (sweep's gate removed) → **13 of my tests fail.** Mutation M4 (startup revive reverted to `enqueue()`) → **my new budget-charge test fails** — see §5, this closes the gap the prior reviewer flagged in their own §5.5. Reverted. |
| 4 | Startup path used shared `enqueue()`, bypassing the revive budget → infinite re-queue | **STILL FIXED** | `30 simulated days` (sweep lane) + `and a job that DOES succeed spends nothing at all afterwards` | **proved by test I ran. THE NUMBER: 80 attempts for the whole 30 days, every one inside day one, `[80, 0 × 29]`.** See §4 | Mutation M4 → fails. Mutation M9 (sweep asks per job instead of per unit) → **20 of my tests fail.** Reverted. |
| 5 | Prior reviewer's `zzReviewDocsweep.test.ts` must be gone | **STILL FIXED** | `DEFECT 5`: file absent; plus `git log --all --diff-filter=A --name-only` finds no such path in any commit, and a loop over every dangling blob from `git fsck --lost-found` finds none containing the name | **proved by test I ran** (absence). Also absent: `electron/rvDocsweep.test.ts` — the prior reviewer's own 29-test file is not in this tree either, so the coverage it described lives only in the branch's own suites and in my file | — |
| **6** | **NEW: the sweep and the trigger both queue for one job → 3 CVs + 3 cover letters** | **FIXED for the ordering that produced it; a residual duplicate path remains (Finding 1)** | §1 block (5 end-to-end tests), §2 block (predicate call + truth table), §3 block (the hunt) | **proved by test I ran.** Sweep→trigger, trigger→sweep, startup path, four interleaved passes, and a post-processing second pass all give exactly one of each. Mutations M1 (trigger's gate removed), M2 (sweep's gates removed), M7 (a private single-direction check restored instead), M9 (per-job instead of per-unit), M10 (trigger asks about one type) → **16 / 13 / 11 / 21 / 3 of my tests fail respectively.** Reverted. |

---

## 3. Findings, ranked by severity

### FINDING 1 — HIGH (money), residual duplicate, pre-existing but *not* closed by the fix

**The two producers still disagree about a job that already has a document, and
the trigger's answer costs a duplicate CV plus a duplicate cover letter.**

`electron/fitScorer.ts:63-134` · `electron/docAutoQueue.ts:113-200`

`jobDocWorkInFlight` is, by design, a predicate about **queue rows**:
> "will a live row for this job already produce a FIRST generation of any of
> `docTypes`?"

and it deliberately excludes two things:

* a row whose `status` is not `pending`/`processing` (`docAutoQueue.ts:195`), and
* a row carrying a `documentId` (`docAutoQueue.ts:196`) — the review→regenerate
  loop, which rebuilds a document that already EXISTS.

Both exclusions are correct **for the sweep**, which is deciding per unit
against `needsDoc` (`docsAutoQueue.ts:134-136`) and genuinely wants a first
generation. Neither is correct **for the trigger**, because the trigger does not
consult `needsDoc` at all: it enqueues one `tailor_job_docs` row that produces
**both** documents, so "is a missing document in flight?" is not the question it
needs answered. "Is this job *not already shippable*?" is its question, and that
is `autoDocQueueEligible`'s condition 4 — which is satisfied by a job with one
CV and no cover letter, or with a CV below the review bar.

**Proved by failing test I ran** — `FINDING: a job whose CV is mid-REVIEW — the
two producers disagree` and `FINDING: ...and the trigger's answer to the same job
is a fresh CV`. Identical starting state, one test apart in time:

| | starting state | answer |
|---|---|---|
| sweep | 1 `cv` doc + a pending `verify` row | queues **1** row: `generate_cover_letter`. Leaves the CV alone. |
| trigger | 1 `cv` doc + a pending `verify` row | queues **1** row: `tailor_job_docs`, which regenerates the CV. |

After processing, one job holds **3 `cv` documents and 2 `cover_letter`
documents**, from 2 CV tailorings. The window is not contrived:

* the sweep generates the CV, the processor chains the review, and the review is
  a real provider call taking seconds to a minute — `FINDING: ...a fresh CV`;
* a failing review queues a `generate_cv` row carrying the CV's `documentId`,
  which the predicate cannot see, and that row stays live for the whole
  regeneration loop up to `AUTO_REGEN_MAX` — `FINDING: the regeneration loop is
  invisible to the trigger too` (proved by failing test I ran);
* `maybeAutoEnqueueDocs` is reached from `jobs:recomputeFit`, the `score_fit`
  queue item, `jobs:create` and `jobs:importFromUrl`, and `runDeferredStoreWork`
  (`main.ts:1227`, `main.ts:1232`) queues `score_fit` *before* the docs sweep, so
  a cold launch reaches it with no user action at all.

The fix's own doc comment anticipates this shape and dismisses it
(`docAutoQueue.ts:162-186`): *"Deferring to a single-unit row is total only for
that unit … the other document stays the backlog sweep's job."* That is true
while the deferred-to row is live. It stops being true the moment it lands —
once a `generate_cv` row has produced its CV and the sibling `generate_cover_letter`
row is dead, the sweep's answer is "queue only the cover letter" (per-unit
`needsDoc`) and the trigger's is "queue both". My
`a dead-sibling state with a PASSING CV` and
`a dead-sibling state with NO documents at all` cases pin the two answers that
*are* correct, so this is a gap, not a misreading.

**Is this a regression? No.** Pre-`6ce4d85` the trigger had no coverage check at
all, so it queued in this state too, and in *more* states. `6ce4d85` strictly
reduces the number of paths that reach this. It does not close it.

**REPORT, not FIX.** The obvious closure — have the trigger queue per missing
document, or route it through the sweep's per-unit decision — changes when the
fit-landing trigger queues work, which is shipped behaviour with its own tests.
That is a design decision. The natural, minimal version is to give
`maybeAutoEnqueueDocs` the same `needsDoc` question the sweep asks (and/or teach
`jobDocWorkInFlight` to count a live `verify`/regeneration row for the document
it is reviewing), which is one more shared predicate rather than a new one.

---

### FINDING 2 — HIGH (money), pre-existing, untouched by the fix, and it is the multiplier on Finding 1

**`tailor_job_docs` writes each document twice, from one tailoring call.**

`electron/tailorJobDocs.ts:62-114` · `electron/ai.ts:1180` · `electron/database.ts:1033-1073`

`tailorJobDocsForJob` calls `tailorDocument`, which for a first generation calls
`createDocument` (`ai.ts:1180`, which **pushes a new row**,
`database.ts:1178`), and then calls `writeDocuments`, which **inserts a second
row** for each document (`database.ts:1041-1070`, `s.documents.push(doc)` at
1053 and 1068). One `tailor_job_docs` row, one CV tailoring, one CL tailoring,
one review — and **two** `cv` rows and **two** `cover_letter` rows.

**Proved by failing test I ran** — `FINDING: tailor_job_docs writes each document
TWICE, on its own`, which also pins the contrast: the sweep's path
(`generate_cv` / `generate_cover_letter`, `aiQueue.ts:150-178`) creates its
document and stops, so it leaves **one** of each. The two producers therefore do
not just differ on *whether* to regenerate — they differ on *how many rows* they
leave behind for identical work.

This is why Finding 1's numbers are 3 CVs and 2 cover letters rather than 2 and
1, and it means the trigger path **on its own, with no sweep involved**, has
always shown the user two of everything. `6ce4d85` did not introduce it, does not
touch `tailorJobDocs.ts`, and the fixing agent's commit body notes it correctly.
REPORT, not FIX — it is in a module this change does not own.

---

### FINDING 3 — MEDIUM (money), pre-existing, unbounded, and completely silent

**The fit-landing trigger has no revive budget and no cooldown, and leaves no
trace behind for one to bound.**

`electron/fitScorer.ts:133` · `electron/aiQueue.ts:876-936` ·
`electron/tailorJobDocs.ts:74-97`

`maybeAutoEnqueueDocs` returns `enqueue({ type: 'tailor_job_docs', jobId })`. Two
things follow:

1. `enqueue`'s duplicate path revives a `failed` row with `revivePatch()`
   (`aiQueue.ts:919`, `aiQueue.ts:588-595`): `attempts: 0`, `nextRetryAt: now`,
   **`autoRevives` untouched**. That is precisely the write `dc15d81` went out of
   its way *not* to use on the startup path (`docsAutoQueue.ts:370-376`), so the
   guarantee the fix established for the sweep does not extend to the trigger.
2. There is usually nothing to dedupe against at all. When both documents fail,
   `tailorJobDocsForJob` writes nothing and **throws nothing**
   (`tailorJobDocs.ts:74-97`), so `processItem` treats the item as a **success**
   and removes it (`aiQueue.ts:283-288`). The queue holds no record, so the next
   fit landing adds a brand-new row with a full fresh attempt budget.

**Proved by failing test I ran** — `spends 2 generations per fit landing, every
day, for 30 days`. Over the same 30 simulated days as §4: **428 attempts
(80 + 29 × 12), per-day `[80, 12, 12, …, 12]`**, against the sweep lane's
`[80, 0, …, 0]`. It is 5.35× the sweep's whole 30-day cost and it never stops.

Reachability in production is **narrower than my 4-hourly loop** and I want to be
precise about that: the hourly fit re-seeder only queues `score_fit` for jobs
whose score is missing or whose `fit_score_version` is stale
(`fitAutoScore.ts:69-72`, `fitAutoScore.ts:94-95`), so this repeats **once per
fit landing**, not once per tick. Those landings are a Recompute Fit, a
`jobs:create` / `jobs:importFromUrl`, a `score_fit` retry, or a `cv_version` bump
in Settings (which makes *every* job stale and re-queues them all). It needs user
action, which is why I report it rather than call it a leak — but it is unbounded
in the number of landings and nothing surfaces it: no row survives, no error
touches the job, and `maybeAutoEnqueueDocs` returns `true` every time so every
caller believes it scheduled something.

`6ce4d85` neither introduced nor touched this. REPORT, not FIX — the closure is
the same bounded revival the sweep now uses, which is a behaviour change to a
shipped function.

---

### FINDING 4 — LOW (observation), the cross-type guard has no second line of defence

`electron/database.ts:2475-2479`

`dedupeAIQueueItems` — the one-shot startup repair in `runDeferredStoreWork` —
keys `sameWork` on `type` first, so it can never fold a `tailor_job_docs` row
into a `generate_cv` row. **Proved by failing test I ran** (`FINDING: the startup
dedupe repair cannot collapse a cross-type duplicate either`: 3 rows in, 3 rows
out). Stated plainly because it changes the risk profile: after `6ce4d85`,
`jobDocWorkInFlight` is the **only** thing in the tree that knows those two row
types are the same work. That is the right architecture — one predicate, one
answer — but it means the predicate has no backstop, which is exactly why
checklist item 2 of this brief mattered.

---

### FINDING 5 — INFORMATIONAL, the conflict resolution's switch half is defence-in-depth, not load-bearing

`electron/fitScorer.ts:91-99`

The prior reviewer asked me to rule on the 6 lines + comment in `dc15d81`. My
ruling is in §6. The short version: they are **correct and harmless, and nothing
observable depends on them.** Mutation M3 removed them and only one behavioural
test in the whole suite failed — `fitScorer.test.ts`'s *"still checks the toggles
before the queue"*, which asserts `enqueue` was **not called** (it mocks
`./aiQueue`), i.e. it pins *where* the check happens, not *whether* the outcome
differs. Against the real `enqueue`, removing the 6 lines changes no outcome,
because `autoQueueAllows` already enforces exactly the same rule for
`tailor_job_docs` (`aiQueue.ts:829-830`: `auto_queue_cv !== false &&
auto_queue_cover_letter !== false`). My `SOUNDNESS: the trigger's inline switch
rule agrees with enqueue's central one, in all four` test proves the two agree on
every combination, against real code. Worth stating because a future reader will
assume those 6 lines are load-bearing and be reluctant to touch them; the honest
description is "belt and braces, with a comment that slightly oversells it."

---

## 4. The revival-rate number

**Re-derived and re-measured. Two numbers, because they are two different
questions.**

### Re-derivation (*reasoned from code*)

Per document row, per life:

```
  attempts ladder     aiQueue.ts:334   `isRateLimit && attempts < 10`   → 10 attempts, then park
  lifetime budget     aiQueue.ts:369   `autoRevives < AUTO_REVIVE_MAX`  → AUTO_REVIVE_MAX = 3 parks
  ⇒ 4 cycles × 10 attempts            = 40 attempts per document unit
  a job has 2 units (cv, cover_letter)
  ⇒ 80 attempts per job, ever
```

The park is `nextRetryAt = now + AUTO_REVIVE_COOLDOWN_MS` = 4h
(`aiQueue.ts:375`), and the sweep's own revive refuses while
`existing.nextRetryAt > now` (`docsAutoQueue.ts:211`), so the hourly cadence
multiplies how often the sweep *looks*, not how often a row is *resurrected*.

### Measurement (*proved by test I ran*)

`is 80 attempts for the whole 30 days, every one of them inside day one`, against
the real store and the real `processQueue`, only `fetch` stubbed, provider
rate-limited forever, model health cleared before every pass and before every
request, a launch every 4 h, a scan every 2 h and the hourly tick on top.
Attempts are read off the queue's own `attempts` counter as it moves, so the
figure does not depend on how many requests a provider cooldown happens to
swallow:

```
ATTEMPTS = 80          per-day = [80, 0, 0, 0, ... 0]   (29 zeros)
```

**80 attempts per job, whole 30 days, all inside day one, 0 after. Identical to
the prior review's number.** The fix did not loosen it.

Two secondary numbers from the same run, because the brief asked for the money:

* **Wire-level cost in that configuration: 40.** A 429 puts the model on a 15 s
  cooldown (`ai.ts:512-514`), so the *second* document unit processed in the same
  pass throws before it reaches the wire (`ai.ts:846-849`) and all 40 of its
  attempts are free. Real providers suppress more, never less, so **80 is the
  ceiling and 40 is what this specific configuration costs.**
* **A job that succeeds spends 0 after day zero.** `and a job that DOES succeed
  spends nothing at all afterwards`: 30 days × 30 launches, zero further
  generations, still exactly one CV and one cover letter. This is the number that
  decides whether the sweep is a leak, and it is zero.

* **And the second lane: 428, unbounded.** Adding the fit-landing trigger on a
  4-hourly loop gives `ATTEMPTS = 428`, `per-day = [80, 12 × 29]`. That is
  Finding 3, and it is the number the prior review's 80 does not cover, because
  80 scoped the sweep's two paths only.

---

## 5. Item 2 — both directions use ONE predicate, and cannot drift

**Every call site of `jobDocWorkInFlight` in the tree, enumerated by hand and
re-derived:**

| file:line | form | direction |
|---|---|---|
| `electron/docAutoQueue.ts:188` | `export function jobDocWorkInFlight(` | the definition |
| `electron/docsAutoQueue.ts:275` | `if (jobDocWorkInFlight(queue, job.id, [unit.docType])) continue` | sweep → trigger (periodic path) |
| `electron/docsAutoQueue.ts:349` | `if (jobDocWorkInFlight(queue, job.id, [unit.docType])) continue` | sweep → trigger (startup / post-scan path) |
| `electron/fitScorer.ts:119` | `if (jobDocWorkInFlight(db.getAIQueue(), jobId, ['cv', 'cover_letter'])) return false` | trigger → sweep |

Three call sites, one definition, and **zero** private copies.

**Asserted as CALLS, not as names.** The prior reviewer's lesson was that
`toContain('autoDocQueueEligible')` is satisfied by an import alone — they
proved it by gutting `maybeAutoEnqueueDocs` to `return false` and watching 15
tests stay green. So:

* `the fit-landing trigger calls it, asking about BOTH documents` matches the
  whole `if (…) return false` statement **inside the sliced function body**, and
  additionally asserts the body contains **exactly one** call (two calls in one
  function is how a second implementation starts).
* `BOTH sweep paths call it, once each, per unit` counts the matches **and**
  pins them to each of the two exported entry points separately, so deleting one
  gate fails even with the other's text still in the file.
* `the old single-direction check is GONE, not left as a second opinion` asserts
  `jobCoveredByLiveTailor` appears nowhere in `docsAutoQueue.ts`,
  `fitScorer.ts`, `docAutoQueue.ts`, `aiQueue.ts` or `database.ts` (comments
  stripped), that neither caller names the row types it would scan for, and that
  `DOC_PRODUCING_ROWS` is written exactly once.
* `the predicate has one truth table` checks the predicate directly against 15
  hand-built rows, so the two producers cannot disagree about the predicate even
  if one of them stops calling it.

**Behavioural halves, and the reverse direction did not regress:**

* `BEHAVIOUR: with the sweep's rows live, the trigger queues nothing` — fails if
  the **trigger** is gutted.
* `BEHAVIOUR: with the trigger's row live, the sweep queues nothing` — fails if
  the **sweep** is gutted.
* `BEHAVIOUR: a PROCESSING row counts, not just a pending one`,
  `BEHAVIOUR: a FAILED row is not in flight in either direction`,
  `BEHAVIOUR: a regeneration row (carries a documentId) covers nothing`.
* `the old single-direction check is GONE` also fails if the sweep grows a
  private re-implementation (mutation M7 restores a
  `q.type === 'tailor_job_docs'` scan → it fails).

**Mutations that fail, each reverted (10 total, all reverted):**

| # | mutation | my tests that fail |
|---|---|---|
| M1 | remove the trigger's `jobDocWorkInFlight` call (pre-`6ce4d85`) | **16** |
| M2 | remove both sweep calls | **13** |
| M3 | remove the trigger's `auto_queue_*` switch checks (the conflict resolution's autotoggles half) | 2 (structural only — see Finding 5) |
| M4 | revert the startup path's revive to `enqueue(...)` (pre-fix defect 4) | 2, incl. the new budget-charge test |
| M5 | restore both `240`s in `database.ts` | 2 |
| M6 | drop the eligibility gate from the periodic sweep only | 1 |
| M7 | replace both sweep calls with a private single-direction `tailor_job_docs` scan | 11 |
| M8 | drop `&& !d.is_base` from `needsDoc` | 2 |
| M9 | make the sweep ask per **job** instead of per unit | **21** |
| M10 | make the trigger ask about `['cv']` instead of both types | 3 |

M9 is the one the fix's commit body calls "load-bearing", and it is: 21 of my
tests fail, including the revival bound.

**One acknowledged gap in my own suite, since a reviewer who only criticises
others is not reviewing.** Under M3 my *behavioural* switch tests do not fail,
because `enqueue`'s central gate produces the same answer. That is not a hole in
my tests — it is the measurement in Finding 5 — but it does mean the trigger's
switch half is pinned structurally (by my `both halves are present`, by M3, and
by the shipped `fitScorer.test.ts` call-count test) rather than behaviourally.
I could not find a state where its removal is observable, and I looked.

---

## 6. Ruling on the conflict resolution in `dc15d81`

**CORRECT. Keep it as resolved.** The prior reviewer flagged their own resolution
for separate review; here is the ruling, on its own merits.

**What was at stake.** `fix-docsweep` moved the fit threshold and the
"not already shippable" check into the shared `autoDocQueueEligible` and left the
rest inline. `fix-autotoggles` added the `auto_queue_cv` / `auto_queue_cover_letter`
switch check to `maybeAutoEnqueueDocs` and left the rest inline. Merging
either-as-is would have silently deleted half a feature. The resolution kept
both, which is the only merge that loses nothing.

**Verified, all against real code:**

1. **The switch checks are PRESENT and still effective.** `fitScorer.ts:97-99`,
   as a call-shaped `if` in my regex (`either switch off means the trigger queues
   nothing` asserts each of the two independently against a real store).
2. **The shared-predicate call is PRESENT and effective.** `fitScorer.ts:119`;
   `BEHAVIOUR: with the sweep's rows live, the trigger queues nothing` fails if it
   is removed (mutation M1).
3. **The shared eligibility gate is PRESENT and effective.** `fitScorer.ts:105`;
   mutation M6 and the `DEFECT 2` block cover the sweep side, and the below-
   threshold / null-score cases cover the trigger side.
4. **Neither shadows the other.** `neither half shadows the other: all eight
   combinations of (switches, live rows)` walks the full 2 × 2 × 2 truth table
   and asserts both the return value and the resulting row count for each. There
   is no combination where one half masks the other's reason.
5. **The order is as the comment claims.** `both halves are present in
   maybeAutoEnqueueDocs, switches first` pins
   `switches < autoDocQueueEligible < jobDocWorkInFlight`, which is what the
   comment says and why ("a caller reads `false` here as 'generation was not
   scheduled', which is true whether the job scored low or the user turned CV
   auto-queueing off").
6. **The "keep the switch check out of the shared predicate" reasoning is
   right, and I checked the case that decides it.** `CV OFF, cover letters ON: a
   cover-letter-only sweep is legitimate, the trigger still refuses` — the sweep
   has real work to do in that state and the trigger has none. Had the switch
   check moved into `autoDocQueueEligible`, a CV-only or cover-letter-only sweep
   would have been gated by a rule that belongs to the both-documents unit.
7. **The switch check is not *load-bearing*, and that is fine.** Finding 5:
   `autoQueueAllows` (`aiQueue.ts:829-830`) enforces the identical rule at the
   central gate, so `maybeAutoEnqueueDocs`'s boolean cannot lie about it — which
   my `SOUNDNESS: the trigger's inline switch rule agrees with enqueue's central
   one, in all four` proves by driving both against real code in all four
   combinations. Defence in depth, correctly reasoned, with a comment that
   slightly oversells it. **Not worth changing**: it costs three lines, it is the
   reason `maybeAutoEnqueueDocs` reads its settings once, and it is what makes
   the return value honest if `enqueue`'s rule ever diverges.
8. **One inaccuracy in the comment**, small and worth fixing in passing:
   `fitScorer.ts:80-89` says *"enqueue() enforces the same rule for every other
   caller; this is the same check one step earlier."* True. But
   `fitScorer.ts:75-79` gives "come BEFORE the fit threshold" as being *because
   of the return value* — and since `enqueue` enforces the same rule anyway, the
   return value would be identical in either order. The order is harmless; the
   stated reason is not the operative one. REPORTED, not fixed (a comment edit on
   someone else's conflict resolution is not worth the merge).

---

## 7. `db9f12e`'s call-site inventory — re-derived, and it is CORRECT

I enumerated every production `enqueue(` call site myself rather than trusting
the table, because a test asserting a wrong list is worse than no test.

**All 11, with the polarity checked against the source, not against the table:**

| # | site | type | `manual:` | polarity — and why |
|---|---|---|---|---|
| 1 | `main.ts:394` | `verify` | `true` | `documents:verify`, the Verify button's rate-limit fallback |
| 2 | `main.ts:407` | `regenerate_section` | `true` | `documents:regenerateSection`, the Regenerate button's fallback |
| 3 | `main.ts:586` | `generate_cv` / `generate_cover_letter` | `true` | `ai:tailor`, Tailor / Generate's fallback |
| 4 | `main.ts:602` | `tailor_job_docs` | `true` | `tailor:quickApply`, Quick Apply (queues unconditionally) |
| 5 | `aiQueue.ts:177` | `verify` | — | processor: generation finished, chain the review |
| 6 | `aiQueue.ts:234` | `generate_cv` / `generate_cover_letter` | — | processor: review failed, auto-regenerate that document |
| 7 | `aiQueue.ts:307` | `verify` | — | processor: `tailor_job_docs` finished, fan out over the job's documents |
| 8 | `docsAutoQueue.ts:363` | `generate_cv` / `generate_cover_letter` | — | the docs sweep's `add` case |
| 9 | `fitAutoScore.ts:191` | `score_fit` | — | the fit-score re-seeder (startup + post-scan) |
| 10 | `fitScorer.ts:133` | `tailor_job_docs` | — | the fit-landing trigger |
| 11 | `jobSearch.ts:1513` | `tailor_job_docs` | — | the scan-time auto-tailor |

**4 manual, 7 automatic. `db9f12e`'s table matches exactly, and so does the
`aiQueue.ts` doc comment's "seven automatic producers" claim.**

Independently re-derived by me, and cross-checked three ways:

* `rg -n --pcre2 "(?<![\w$.])enqueue\s*\(" -g '!*.test.ts' electron src` finds
  exactly these 11 and nothing else. The negative lookbehind excludes member
  reads (`x.enqueue(`) and the `function enqueue` declaration is filtered, so
  the count is a count.
* My own test (`db9f12e: the enqueue() call-site inventory matches the tree, and
  every polarity does too`) re-derives the list with block comments stripped
  **across the whole file first** — the shipped version's scanner strips block
  comments correctly, and a per-line strip would let a `/** … enqueue() … */`
  block read as a call site. It asserts the 4 manual lines and the 7 automatic
  lines as literal `file:line` pairs.
* **Polarity checked against the source, not the table.** For each manual site I
  take the 12 lines above it, find the enclosing `ipcMain.handle('<channel>')`,
  and assert the channel is a user action and not a job/scan/queue listing. All
  four are. And the one ungated type (`regenerate_section`) has exactly one
  producer and it is manual, which is what makes `autoQueueAllows`'s
  `default: return true` safe for it.

**One forward-looking note, not a defect on this branch:** the sibling branch
`0a53a4d` ("retire the Scan tab's Auto-Queue section and its scan-time producer")
deletes `jobSearch.ts:1513`. `db9f12e`'s inventory pins that exact line, so that
branch will need the same re-derivation `db9f12e` just did. Flagging it so it is
not discovered by a red test.

---

## 8. Weak / flaky tests I found

Four tests in the tree fail under CPU contention. **None of them is in a file
this change touches, and all four pass when the machine is idle.** I measured
this rather than assuming it:

| run | result |
|---|---|
| cold, first run after checkout | 2 failures |
| idle, runs 2-4 | 0 failures (1599/1599) each |
| 4 CPU burners saturating the box, run 5 | 3 failures |
| idle again, run 6 | 2 failures |
| idle again, run 7 | **0 failures (1599/1599)** |

The four:

1. **`electron/aiQueue.unique.test.ts:244`** — `expect(viaEnqueue).toEqual(viaRetry)`
   compares two `nextRetryAt` values produced by two separate `Date.now()` calls
   and fails when the millisecond ticks between them. Observed:
   `1790900722569` vs `1790900722568`. This is a real defect *in the test*: it
   asserts clock equality where it means semantic equality.
2. **`electron/fitHeuristic.test.ts:1021`** — `expect(elapsed).toBeLessThan(1000)`
   for 1000 heuristic scorings. Measured 1035 ms on the cold run. A performance
   guard on shared hardware; it is doing its job, just not on a loaded box.
3. **`src/App.test.tsx:8`** — `await expect(import('./App')).resolves.toBeDefined()`.
   A dynamic import of the whole React app, which transitively loads the
   transformer model. Measured: passes alone, fails when run alongside a file
   that also loads the model, and fails under load. A 5s default test timeout
   against a cold `@xenova/transformers` import is not a stable assertion.
4. **`src/semanticSkillMatcher.test.ts:103`** — `"data analytics" canonicalizes to
   "analytics"`. `canonicalizeUnknownPhrase`
   (`src/semanticSkillMatcher.ts:204-229`) picks the nearest allowlist embedding
   by cosine similarity, and under CPU contention the runner-up wins. This is a
   genuine model-dependent test (its own describe block says so), but a
   similarity margin that thin is a flake waiting for a busy machine.

REPORTED, not fixed — there is a sibling branch (`fix/flaky-tests`, `aeb01fb`)
claiming the flakiness lane, and none of these four is in the docs-sweep path.

**Everything else I read in the branch's suite is either behavioural against the
real store or a call-form source assertion.** The prior reviewer's §5.1
(`toContain('autoDocQueueEligible')`, satisfied by a bare import) **has** been
replaced: the call form plus a body-scoped slice is now in `docAutoQueue.test.ts`,
and I confirmed it has teeth — mutation M1 fails it, which it would not have done
in its old form.

---

## 9. What I could NOT verify

Stated plainly, no hedging:

- **I could not verify any of this against a real provider.** Every generation
  and attempt number here is a `fetch` stub with model health cleared before
  every request, which deliberately *removes* a real provider's cooldown
  suppression. So 80 is a ceiling on attempts, 40 is what my single-model
  configuration costs on the wire, and production would be lower. The 428 of
  Finding 3 has the same caveat and is *unbounded* rather than merely high.
- **I could not verify the aggregate.** One job, measured. 200 jobs × 80
  attempts is arithmetic I did not run, and I did not measure the wall-clock cost
  of the sweeps over a large store.
- **I did not run the Electron app.** No renderer, no IPC round trip, no real
  `setTimeout` drift. The live-timer assertions read `nextRunAt` through the same
  `timerDeadlineMs` the app uses, but I did not watch a sweep fire.
- **I did not review the `fix-autotoggles` merge (`76c3e0c`) or
  `88c3cfe` beyond what the checklist named.** They are in the tree and their
  tests pass, but they were reviewed separately (`89b2e57`) and I have no
  opinion on them here.
- **I did not read the deleted `zzReviewDocsweep.test.ts`.** It is absent from
  every commit, reflog entry and dangling object in this repository, exactly as
  the prior reviewer found. I can prove absence; I cannot prove equivalence.
- **I could not determine whether Finding 1's trigger behaviour is *intended*.**
  `autoDocQueueEligible`'s own doc comment (`docAutoQueue.ts:50-54`) says the
  gate deliberately does not ask "which documents are missing", because "the
  trigger — which always means 'both documents'". That reads as a deliberate
  design choice, and it is the reason Finding 1 is a REPORT and not a FIX: I can
  prove the duplicate is reachable and measurable, but whether the right answer
  is "don't regenerate an existing CV" or "yes, and the user should know" is a
  product decision I am not entitled to make.
- **My Finding 3 reachability claim is deliberately conservative.** I could not
  find a *purely automatic* loop that re-fires `maybeAutoEnqueueDocs` forever for
  one job; `runFitAutoScoreBacklog` correctly refuses to re-queue `score_fit` for
  a job that already has a current-version score (`fitAutoScore.ts:69-72`). My
  4-hourly loop in the test is an adversary, not a schedule. Finding 3 is
  therefore "unbounded per fit landing, and every landing is user-driven" — not
  "leaks on its own".

---

## 10. Final state

- **`npm test`: 1599 passed / 1599, 70 files, 0 failures** on an idle machine,
  measured 7 full runs (§8 lists the 3 runs that had load-induced failures and
  which tests they were). 1553 / 69 at `db9f12e` before my file: **+46 tests,
  +1 file, nothing deleted.**
- **`npm run typecheck`: clean.**
- **`npx eslint electron/rv2dupe.test.ts`: clean — 0 errors, 0 warnings.**
  `npm run lint` over the whole repo: **345 problems, 0 errors, 345 warnings —
  byte-identical to the baseline with my file stashed**, so I contributed none.
- **All 10 mutations reverted.** `git diff --stat` is empty; `git status --short`
  shows exactly one untracked file, `electron/rv2dupe.test.ts`, which is mine.
  Every mutation used `git checkout --` on the file it touched, verified by the
  empty diff at the end.
- **Nothing fixed, everything reported.** I made no change to any source file.
  Every finding above is REPORT, because Findings 1–3 are all behaviour changes to
  shipped functions and Finding 5's comment inaccuracy is a one-line prose edit
  on someone else's conflict resolution.

## Recommended next steps

1. **Decide on Finding 1.** It is the same user-visible symptom as the defect
   this round fixed, at the same magnitude (3 CVs), reachable on ordinary paths,
   and the fix's own deferral comment reads as if it were handled. The minimal
   closure is one more shared predicate — "which document types is this job still
   missing?" — asked by the trigger as well as the sweep.
2. **Decide on Finding 3.** `maybeAutoEnqueueDocs` should get the bounded
   revival the sweep now has, and `tailorJobDocsForJob` should stop reporting a
   total failure as a success, so that a failed run leaves a row whose budget can
   be charged.
3. **Finding 2 is a separate piece of work** in `electron/tailorJobDocs.ts` /
   `electron/ai.ts`, and it multiplies Finding 1 whenever the trigger path runs.
4. Fix the two flakes in §8 on the `fix/flaky-tests` lane, or accept them.
5. Re-derive the `enqueue()` inventory on `0a53a4d` when it merges (§7).
