# REVIEW VERDICT — verification of the Auto-queue fixes (`a36a43c`, `88c3cfe`)

Reviewer: `rv2autofix` (worktree `rv2-autofix`, branch `rv2-autofix`).
Base: `main` at **`db9f12e`**. This is a reviewer **verifying a fix**, not reviewing a
feature. Read `/Users/chef/.herdr/worktrees/flow_job/rv-autotoggles/REVIEW_VERDICT.md` first;
everything below assumes it.

---

## 1. Verdict

# SHIP WITH FIXES

**Both defects are genuinely fixed, and both fixes have teeth.** I proved that by
re-breaking each one and watching the named tests fail, then reverting. `.fails` markers
are gone — `rg "it\.fails" --glob '*.ts' --glob '*.tsx'` over the tree returns nothing, so
the suite is green *because the behaviour is right*, not because a marker was deleted.

I found **one new defect introduced by `a36a43c`** — a UI dead end that the fix's own
justification names as the escape hatch, and which does not exist. It is a documentation
and product decision, so I **reported** it rather than patching it.

I **fixed one small local thing**: the failure-path rollback reverted an edit the user made
*during* the in-flight write. That is the same class of data loss DEFECT 1 was, in the same
function, one branch away, and the fix is one line.

| | |
|---|---|
| Tests before this review | **1553 passing, 69 files** (`db9f12e`, measured) |
| Tests after this review | **1607 passing + 2 `it.fails` = 1609 total, 73 files — all green.** Four new files contribute 56. |
| Typecheck | clean (`npm run typecheck`) |
| Lint | **0 errors, 345 warnings — byte-identical to HEAD.** My four files add zero warnings. |
| Mutations applied to prove teeth | **13 runs across 5 source files, all reverted.** `git diff --name-only` = `src/pages/SettingsPage.tsx` only, and that is my one-line fix. |
| Source changes I made | **1 line** (`src/pages/SettingsPage.tsx:244`) + a 5-line comment refresh. Everything else is tests. |

### One caveat on "all green" — PRE-EXISTING FLAKINESS, proved at HEAD

`npm test` is **not deterministic on this repo, and was not before I touched it.** I
checked out unmodified `db9f12e` into a scratch worktree, symlinked the same `node_modules`,
and ran it there with **none of my work present**:

```
HEAD (db9f12e) full run 1:  3 failed | 1550 passed
  FAIL electron/fitHeuristic.test.ts > performance guard > ... (1000 listings under 1s)
  FAIL src/App.test.tsx > App module > evaluates without throwing
  FAIL src/semanticSkillMatcher.test.ts > ... "data analytics" canonicalizes to "analytics"
HEAD (db9f12e) full run 2:  2 failed | 1551 passed   (same two)
```

My tree reproduces exactly those failures. `fitHeuristic`'s case is a 1-second wall-clock
guard and `App.test.tsx`'s is a module-evaluation smoke test, so this is contention on a
loaded machine, not a logic fault. **Nothing I added is involved** — the two that fail in
isolation fail identically at HEAD, and `semanticSkillMatcher` passes in isolation.

**The count above is from a green run**, as is every per-file count in this document. There
is already a `fix/flaky-tests` worktree on this repo, so this is known. But it means a single
`npm test` invocation is not a gate here, and I would not sign off a release on one.

---

## 2. Findings, ranked

Labelled **`proved by failing test I ran`** (a test in one of my four files fails against
today's code as `it.fails`, or I watched it fail under a mutation) or
**`reasoned from code`**.

---

### Finding 1 — MEDIUM — a gated automatic row stranded `processing` has **no Retry button**: the escape hatch the fix names does not exist

**`electron/aiQueue.ts:444`** (`reclaimInterruptedItems`) + **`src/notifications/QueuePanel.tsx:108`**
+ **`src/fitQueue.ts:170`**.

**`proved by failing test I ran`** — `electron/review2.strandedRow.test.ts`, "a row the crash
gate strands is a DEAD END in the UI".

`a36a43c` justifies leaving a crashed row alone, twice, in its own words:

> "The row is not lost; it is visible in the panel, and **Retry resumes it ungated**."
> — `electron/aiQueue.ts`, `reclaimInterruptedItems` doc comment

> "it stays visible in the Queue panel and the ungated Retry button re-asks for it."
> — commit message

**That button is not rendered for this state.** `src/notifications/QueuePanel.tsx:108`:

```tsx
{item.status === 'failed' && (
  <button ... onClick={() => onRetry(item)}>Retry</button>
)}
```

and `reclaimInterruptedItems` leaves the row in exactly the one status it will never show a
Retry button for — `processing`, skipped by `if (!mayReviveUnattended(item)) continue`.

**The user-visible dead end.** The app crashes mid-generation. The user restarts with
`auto_queue_cv` off. The row:

- reads **"Processing…"** (`src/fitQueue.ts:170` — `if (item.status === 'processing') return 'Processing…'`),
  so the app is telling them it is running, indefinitely;
- has **no Retry button**;
- is never picked up again — `runPass` only ever collects `pending` and gated `failed` rows,
  and `reclaimInterruptedItems` skips it on **every** subsequent launch;
- is not even recoverable by turning the switch back on *within a session*, because that
  lane runs once, from `startQueueProcessor`.

**I corrected myself here, and the test caught it.** I first asserted that flipping the
switch back on mid-session does *not* recover the row. It does — my `HALF 1` case failed
(`expected 'pending' to be 'processing'`) and the honest version is now in the file. So the
stranded state lasts exactly as long as the user leaves the switch off, which is precisely
when they least want the app spending. That weakens the severity but does not remove the
dead end: **with the switch off, there is no button and no explanation.**

The `failed`-row escape hatch the commit leans on is genuinely intact — pinned as the
`CONTROL` case. It is only the `processing` state, which `a36a43c` newly created, that is
unreachable.

**Three candidate fixes, all design calls — REPORTED, not fixed:**

1. Offer Retry for `processing` rows (`QueuePanel.tsx:108`). One line. Changes what the
   button means, and a genuinely in-flight row would then offer a no-op-ish Retry.
2. Have `reclaimInterruptedItems` park a gated automatic row as `failed` with a reason
   instead of leaving it `processing`. Costs a status the user did not cause.
3. Revert the reclaim gate for manual-origin rows only — already done; the gap is
   *automatic* rows, which is the whole point of the gate.

**Teeth verified both ways.** Un-gating `reclaimInterruptedItems` fails `HALF 1`; widening
the Retry condition to `status !== 'pending'` fails `HALF 2` and the `CONTROL`. Both
mutations reverted.

---

### Finding 2 — MEDIUM/LOW — **FIXED by me**: the failure-path rollback reverted an edit made *during* the in-flight write

**`src/pages/SettingsPage.tsx:240`** (the line as shipped) → now **`:244`**.

**`proved by failing test I ran`** — `src/pages/review2.autoQueueMerge.test.tsx`,
`"an edit made DURING the in-flight write survives the rollback"`. Against the shipped code:

```
Expected the element to have value:  0.77
Received:                             0.5
```

`toggleAutoQueue` captures `const previous = settings` **before** the optimistic write and
the `catch` restored that whole snapshot. Only the five switches are `disabled` during the
write (`SettingsPage.tsx:868`); **every other tab's inputs stay live.** So: toggle a switch,
click to Scan, keep typing, and if the write fails your typing is silently reverted — the
same class of silent edit loss DEFECT 1 was about, one branch away, and the shipped test
`"leaves the unsaved edit intact when the toggle FAILS"` cannot see it because it makes the
edit *before* the toggle.

**Reachability.** The window is one IPC round trip, but `db.updateSettings` calls
`persistStore()` — a full-store AES-256-GCM encrypt plus atomic write and rename, which the
shipped comments measure at ~6 ms on a real store and which scales with store size, and
which queues behind whatever the main process is doing (a scan).

**FIXED (labelled), one line:**

```diff
-      if (previous) setSettings(previous)
+      setSettings((prev) => (prev ? { ...prev, [key]: previous?.[key] } : previous))
```

This is small, local and unambiguous: the rollback now undoes what this function changed and
nothing else, which is the same rule the success path already applies. I also refreshed the
now-stale comment at `:228`, which described the old whole-snapshot rollback as the model
the success path should match.

Verified: `src/pages/SettingsPage.test.tsx` (29), `review.autoQueueTab.test.tsx` (26) and
`review2.autoQueueMerge.test.tsx` (13) all pass; `npm run typecheck` clean; lint unchanged.

---

### Finding 3 — LOW — the merge writes `undefined` over the tapped key when the response omits it, and the switch then renders **ON**

**`src/pages/SettingsPage.tsx:236`.** **Proved by failing test I ran** (two `it.fails` in
`review2.autoQueueMerge.test.tsx`).

`{ ...prev, [key]: updated[key] }` — if `updated` has no such key, `updated[key]` is
`undefined`, so the merged state carries `auto_queue_cv: undefined`, and the render is
`checked={settings[row.key] !== false}` (`SettingsPage.tsx:867`). `undefined !== false` is
**true**, so a switch the user just turned **off** springs back on. The wrong direction is
the expensive one: the tab claims a feature is running when the store has it off.

**This is NOT a regression from the fix.** I reverted to `setSettings(updated)` and both
cases **still fail** — the whole-object set produced the identical `undefined` and the
identical wrong render. The merge's only additional sin is dropping the optimistic value
that would otherwise have been right.

**Unreachable through the shipped IPC, and I checked rather than assumed.**
`settings:update` → `db.updateSettings` → `return getSettings()`
(`electron/database.ts:1599-1614`), which is `loadStore().settings`, and `loadStore` coerces
all five keys to booleans on load (`database.ts:335-345`). `toggleAutoQueue` always sends a
boolean (`e.target.checked`), so the response always carries the key. `resetSettings` and
`backup:restore` both supply all five too.

**REPORTED, not fixed.** The one-line hardening (`updated?.[key] ?? on`) requires choosing
what the tab should believe when the store declines to confirm — a policy call, and a no-op
in production. Pinned as `it.fails` so it flips to a real failure the day the IPC shape
changes.

---

### Finding 4 — LOW — the doc comment's *other* inventory says "Four exist"; there are eleven

**`electron/aiQueue.ts:766`**. **`reasoned from code`**, cross-checked by a scan I wrote and
by nine passing tests.

`a36a43c` added a list of the paths that queue work **without** calling `enqueue`, and
claimed it was complete — *"Four exist"*. I re-derived every production write that can put a
row into a runnable state without going through `enqueue`:

| Write | Listed in the comment? | Gated by |
|---|---|---|
| `aiQueue.ts:335` rate-limit backoff requeue | no | in-run (correctly ungated) |
| `aiQueue.ts:346` score_fit backoff requeue | no | in-run (correctly ungated) |
| `aiQueue.ts:369` failure-path reschedule | **yes** | `mayReviveUnattended` |
| `aiQueue.ts:444` reclaimInterruptedItems | **yes** | `mayReviveUnattended` |
| `aiQueue.ts:518` runPass revival | **yes** | `mayReviveUnattended` |
| `aiQueue.ts:611` `retryQueueItem` (Retry — MANUAL) | no | ungated by design |
| `docsAutoQueue.ts:280` periodic sweep add | no | `unit.enabled` ← `autoQueueFlags()` |
| `docsAutoQueue.ts:282` periodic sweep revive | no | same |
| `docsAutoQueue.ts:370` startup/post-scan revive | no | same |
| `fitAutoScore.ts:150` fit re-seeder resurrect | **yes** | `auto_queue_fit` at `:88` |
| `fitAutoScore.ts:158` fit re-seeder add | no | same |

**Eleven sites, not four; five automatic lanes unlisted.** This is the same failure mode as
the previous review's Finding 3 — a comment that says five, names six and misses the
seventh — repeated three commits later on the *other* list, and `a36a43c` is the commit
that added it.

**No spend leak: every unlisted lane is genuinely gated.** `review2.strandedRow.test.ts`
drives all four of them (`runDocsAutoQueueBacklog`, `enqueueDocsBacklog`,
`runFitAutoScoreBacklog`, and the two in-run backoffs) with the switches off and on, and all
nine cases pass.

**REPORTED, not fixed** — rewording a comment the team may want to phrase differently is
documentation debt, not a defect, and the count is the kind of judgement call I should not
make silently. The nine behavioural tests mean the gate and the comment can no longer be
confused for each other.

---

### Finding 5 — INFO — what merge-the-key costs against refresh-the-whole-object

**`src/pages/SettingsPage.tsx:236`.** **Proved by failing test I ran** (it documents the
cost, so it passes; the cost is asserted).

The trade, stated plainly:

**Merge-the-key wins on two axes.** (a) It does not destroy concurrent unsaved edits —
that is DEFECT 1's fix. (b) It is *strictly better* under overlapping writes. I drove two
toggles with both writes in flight and settled the responses in **reverse** order (the
worst case for a whole-object set): with `setSettings(updated)` that case **fails** (the
first write's stale response drags the second switch back); with the merge both land. The
merge is the right call on both.

**Merge-the-key loses on exactly one axis: cross-key freshness.** The IPC returns the whole
store; the merge reads one key of it. Any *other* key that changed in the same window stays
stale in the page. A whole-object set would have picked it up.

**How much that costs today: nothing observable, and I checked rather than waved.** I traced
every writer of `s.settings`: `db.updateSettings` (this page), `db.resetSettings` (full
defaults), and the store loader. `settings:reset` is exposed in `preload.ts`/`api.ts` but
**never called from `src/`** — I grepped. There is no second window and no second process.
`handleSave` writes the page's whole object, but every settings mutation on this page goes
through `update()`, which writes local state **first**, so a Save can never carry a stale
key. The one live second writer — the Scan tab's `deleted_jobs_cap` `onBlur`
(`SettingsPage.tsx:1597`) — is also `update()`-first.

So merge-the-key costs a staleness window with **no second writer to create it**. It becomes
real only if a second window, a `settings:reset` UI, or a background settings mutator ever
exists. **Stated here so the next change to this line knows what it is trading.**

---

### Finding 6 — INFO, and **intended** — absent `manualQueued` means AUTOMATIC, so pre-existing hand-queued rows stop auto-reviving

**`electron/aiQueue.ts:871`** (`mayReviveUnattended`) + **`electron/types.ts:527-553`**.

**The brief's question, answered directly: yes.** `mayReviveUnattended` reads
`if (item.manualQueued === true) return true`, so `undefined` falls through to
`autoQueueAllows` — gated. Every row written by a version before `88c3cfe` carries no
field, so **on upgrade every one of them stops being revived** once its switch is off,
including rows a person queued by hand.

**I judge this correct and it is documented where it matters** — on the field
(`types.ts:527-552`: *"ABSENT means AUTOMATIC, deliberately… The cost is real and
intended"*), on the gate, and in the commit message. Reading absent as *manual* would hand
every pre-existing row a free pass and undo the gate for exactly the rows it exists to
protect. The cost is bounded (`AUTO_REVIVE_MAX = 3`, 4 h apart) and recoverable, both halves
proved:

- **`proved by failing test I ran`** — a legacy row still revives **with its switch on**
  (`review2.queueOrigin.test.ts`, "STILL REVIVES with its switch ON"), so absent is not
  "absent is dead";
- **`proved by failing test I ran`** — Retry still works on a legacy row with every switch
  off (the `failed` escape hatch);
- **`proved by failing test I ran`** — flipping the default to `manualQueued !== false`
  fails 3 of my cases, so the direction is pinned, not incidental.

The honest limitation, same as Finding 1: for a legacy row in `processing`, the escape
hatch is the one that does not exist.

---

### Finding 7 — INFO — the `manualQueued` flag is correctly and exclusively written

**`proved by failing test I ran`** — `electron/review2.queueOrigin.test.ts`, 26 cases, six
mutations. **No reverse bug found.**

- **Set on all four manual producers, on none of the automatic ones** — driven end to end
  through the real `ipcMain` handlers (`tailor:quickApply`, `documents:verify`, `ai:tailor`,
  `documents:regenerateSection`), each leaving `manualQueued === true`.
- **Persisted through store round-trips** — proved by `reloadStore()` after a macrotask
  yield (`persistStore` chains its write onto a promise).
- **Persisted through `revivePatch()`** and through every other `updateAIQueueItem` patch,
  because `updateAIQueueItem` spreads (`database.ts:2424`). Proved for the processor's claim
  (`aiQueue.ts:140`), the failure-path reschedule, `runPass`'s revival, and the docs
  backlog's direct revive (`docsAutoQueue.ts:370`).
- **No automatic producer can set it.** Proven for the fit-landing trigger, both of the
  processor's chains (`aiQueue.ts:177` and `:234`), the fit re-seeder's direct
  `addAIQueueItem`, an automatic enqueue landing on a manual row (no downgrade) and on an
  automatic row (no upgrade), and `retryQueueItem` (**Retry does not promote** — a one-click
  way to reopen the exact leak would have been the expensive direction, and it is closed).
- **Mutations, all caught, all reverted:** remove the manual exemption → 2 fail; flip absent
  to manual → 3 fail; drop the insert write → **18 fail**; drop the dedupe-patch write → 1
  fails; make Retry promote → 2 fail; make the generation→review chain inherit the flag →
  1 fails.

---

### Finding 8 — INFO — `manualQueued` now crosses the IPC to the renderer and is unused there

**`electron/types.ts:553`** — `QueueItemView = AIQueueItem & {…}`, so the flag reaches the
renderer on every `aiQueue:list`. Nothing reads it: `QueuePanel` and `fitQueue.ts` render
named fields only, and I confirmed no rendered text can contain it. `promotedAt` and
`autoRevives` already cross the same boundary, so this is consistency, not a new leak.
Reported for the record only.

---

## 3. Does the call-site inventory in `db9f12e` say something TRUE?

**Yes. I re-derived it independently and it is correct, not merely self-consistent.**

`db9f12e`'s own commit message admits it re-derived the pinned line numbers after a merge.
The brief asks whether it re-derived them *correctly*. A test asserting a wrong list is
worse than no test, so I did not use its own scanner: I wrote a second one in Python with a
different comment-stripping implementation and a different directory walk, and compared.

**Both scanners find the same eleven production `enqueue(` call sites** (tests excluded —
they are the callers that wrote the flag themselves), at the same line numbers:

| Call site | Polarity in source | Inventory says | Verdict |
|---|---|---|---|
| `electron/main.ts:394` `documents:verify` | `{ manual: true }` | manual | correct |
| `electron/main.ts:407` `documents:regenerateSection` | `{ manual: true }` | manual | correct |
| `electron/main.ts:586` `ai:tailor` | `{ manual: true }` | manual | correct |
| `electron/main.ts:602` `tailor:quickApply` | `{ manual: true }` | manual | correct |
| `electron/aiQueue.ts:177` generation → review chain | no flag | automatic | correct |
| `electron/aiQueue.ts:234` review → regenerate loop | no flag | automatic | correct |
| `electron/aiQueue.ts:307` tailor_job_docs → review fan-out | no flag | automatic | correct |
| `electron/docsAutoQueue.ts:363` documents backlog sweep | no flag | automatic | correct |
| `electron/fitAutoScore.ts:191` fit re-seeder | no flag | automatic | correct |
| `electron/fitScorer.ts:133` fit-landing trigger | no flag | automatic | correct |
| `electron/jobSearch.ts:1513` scan-time auto-tailor | no flag | automatic | correct |

**No misclassified call site.** Four manual, seven automatic. No dynamic
`{ manual: <expr> }` exists, and the test's literal-match would read one as automatic and
fail loudly, so it is self-guarding.

**No fifth manual producer.** I enumerated all 79 renderer-reachable IPC channels from
`preload.ts` and checked the four that could conceivably queue work. `jobs:recomputeFit`,
`jobs:importFromUrl` and `jobs:create` all reach `scoreOneJobInBackground` →
`maybeAutoEnqueueDocs`, which is **automatic and gated** — correctly so, since the button
asks for a score, not for documents (the previous review classified this too).
`aiQueue:retry` does not call `enqueue` at all.

### The doc comment's "seven automatic producers" — counted: **seven, and all seven are named correctly**

**`electron/aiQueue.ts:731`.** I enumerated every production `enqueue(` call site myself:
**7 automatic, 4 manual, 11 total.** The comment names all seven and each name maps to the
right site (fit-landing trigger in fitScorer → `:133`; scan-time auto-tailor in jobSearch →
`:1513`; generation→review chaining, review→regenerate loop and tailor_job_docs→review
fan-out in this file → `:177`, `:234`, `:307`; the fit re-seeder in fitAutoScore → `:191`;
the documents backlog sweep in docsAutoQueue → `:363`). `db9f12e`'s addition of
`docsAutoQueue` and its bump from six to seven is right.

---

## 4. Do manual actions still work with every toggle off?

# YES. I re-ran it myself and drove real handlers.

**What I actually ran.** `electron/review.manualIpc.test.ts` **does not exist in this
worktree** — it lives on `verify-autotoggles` (`89b2e57`). Both fix commits claim "it
passes 8/8"; that was a claim about a file on another branch. I extracted it from `89b2e57`,
ran it here, and got **8 passed / 0 failed**, driving the real `ipcMain` handlers
(`documents:verify` ×2, `documents:regenerateSection`, `ai:tailor` ×2,
`tailor:quickApply`, `aiQueue:retry`, plus a sanity case proving the mocked provider really
is throwing `RateLimitError` so the queueing branch is the one under test). I re-committed
it as `electron/review2.manualIpc.test.ts` with a header recording its provenance, so the
claim is now backed by a file in this tree.

**I drove four more real handlers myself**, in `electron/review2.queueOrigin.test.ts`, and
this is the half that `88c3cfe` did not have: I took the row each handler leaves in the
store, drove the **restart lanes**, and confirmed the manual exemption really is what lets
it through —

- `ai:tailor` → `generate_cv` row, marked `failed`, `processQueue()` with all switches off
  → **`pending`, one `tailorDocument` call spent.** Not "the flag was set"; the row ran.
- `documents:verify` → `verify` row, marked `processing` (crash), `reclaimInterruptedItems()`
  with all switches off → **`pending`.**
- `tailor:quickApply`, `documents:verify`, `ai:tailor`, `documents:regenerateSection` → each
  leaves `manualQueued === true`.
- `tailor:quickApply` still queues `tailor_job_docs` with all five switches off, and with
  one switch off (`review.enqueueCallSites.test.ts`, the prior reviewer's case, still green).

**Teeth check on the manual guarantee.** Deleting `{ manual: true }` from
`electron/main.ts:394` (the Verify button) fails **6** tests across three files — the two
manualIpc cases, my `documents:verify leaves manualQueued true`, my crash-reclaim case, and
`review.enqueueCallSites.test.ts`'s polarity + doc-comment cases. Reverted.

**Nothing in the queue changes breaks a manual action.** `retryQueueItem` is ungated
(`aiQueue.ts:611`), `enqueue`'s `opts.manual` short-circuit is untouched, and every automatic
lane I re-derived is gated without touching a manual path.

---

## 5. Anything NEW? — no new token-spend leak

I read `a36a43c` and `88c3cfe` in full and then went looking specifically for unattended
spend, user-data loss, and broken manual actions.

**New unattended spend: none found.** Every production write that can put a row into a
runnable state is one of the eleven in Finding 4's table. All three `a36a43c` lanes and all
four pre-existing non-`enqueue` lanes consult a gate, and the two docs sweeps are gated per
unit by `docUnits(autoQueueFlags())` — I drove both with the switches off and on (nine
passing cases). The `regenerate_section` type is ungated by design and has no automatic
producer. The `verify`-with-no-document passthrough spends nothing, because the processor
drops such a row without calling the model.

**The one new user-visible defect is Finding 1**, and it is a dead end rather than a leak.

**One test of mine failed for a reason that was my own overreach** — I asserted that
flipping the switch back on mid-session does *not* recover a stranded `processing` row. It
does. I corrected the assertion and left the correction in the file with a note, because the
error is the kind a future reader would otherwise re-derive.

---

## 6. What I could NOT verify

1. **No renderer was ever rendered in a real browser.** Every UI claim is jsdom. jsdom has
   no real `input[type=checkbox]` activation semantics and no CSS cascade, so the global
   checkbox *appearance* (`src/styles/global.css:510-590`) is unverified, and the
   `autoQueueSaving` disable window is argued from the HTML spec rather than observed. I did
   prove the merge behaves correctly under overlapping writes by driving jsdom's
   `fireEvent.click` **past** the disable window, which a browser would not deliver.
2. **`manualQueued`'s field is optional and unvalidated.** A hand-edited store with
   `manualQueued: "false"` (string) reads as `!== true` → automatic, which is the safe
   direction, but I did not find or add a coercion in `loadStore`'s normalisation
   (`database.ts:335-345` covers only the five `auto_queue_*` keys). Low risk; not fixed.
3. **Nothing was run against a real provider, a real keyring or a real encrypted store.**
   `safeStorage` is plaintext in every test here. The round-trip claims rest on
   `persistStore` → `reloadStore` with plaintext.
4. **The `jobSearch.ts:1513` scan path was not executed.** It sits at the end of
   `scanAllBoards`, which opens boards, fetches HTML and tears down a Camoufox singleton.
   I classified it from source; I did not run a scan.
5. **I did not re-run the prior reviewer's other two files** —
   `review.store.test.ts` and `review.processorRevive.test.ts` on `verify-autotoggles`. I
   read the second in full; its conclusion ("the processor's revival is not gated") is now
   **stale** — `a36a43c` gated it — so if that file is ever merged it will fail, correctly.
6. **Token cost of the leak `a36a43c` closed is estimated, not measured** — 3 revives, 4 h
   apart, from `AUTO_REVIVE_MAX` / `AUTO_REVIVE_COOLDOWN_MS`. I did not price a generation.
7. **The suite is flaky under load** (Finding caveat in §1). Measured at unmodified HEAD
   in a scratch worktree with none of my work present, so pre-existing; see §1 for the
   transcripts. My counts come from green runs, and every per-file count in this document
   was confirmed green in isolation or in a green full run. A branch `fix/flaky-tests`
   already exists on this repo.
8. **Single reviewer, single platform** (macOS/darwin), no second opinion, no manual pass
   over the running app.

---

## 7. Recommendation

1. **Decide Finding 1.** The crash-gate's stated escape hatch does not exist for the state
   the crash gate creates. My recommendation is the one-line `QueuePanel.tsx:108` change
   (offer Retry for `processing`), but it changes what the button means, so it is yours.
2. **Ship Finding 2's fix** (already in this tree, one line, tested).
3. **Finding 3** is unreachable and pre-existing; fix it when the IPC shape changes, or
   not at all. The `it.fails` pins it either way.
4. **Correct Finding 4's count** when you next touch that comment, and consider deleting
   hand-maintained counts in favour of the shape the enqueue inventory test already uses.
5. **Keep all four test files in this review.** `review2.strandedRow.test.ts` is the only
   thing standing between a stranded row and a user who cannot get it back;
   `review2.queueOrigin.test.ts` is the only thing that can detect an automatic producer
   growing a `manual` flag.

---

## 8. Tree state

- **`npm test`: GREEN on a green run** — 1607 passing + 2 `it.fails` = **1609 total,
  73 files.** See §1: `fitHeuristic` / `App` / `semanticSkillMatcher` flake under load and
  do so identically at unmodified `db9f12e`.
- **`npm run typecheck`: clean.**
- **`npm run lint`: 0 errors, 345 warnings — identical to HEAD; my files add zero.**
- **Mutations: 13 runs across 5 source files, all reverted.**
  `src/pages/SettingsPage.tsx`, `src/pages/review.autoQueueTab.test.tsx`,
  `src/notifications/QueuePanel.tsx`, `electron/main.ts`, `electron/aiQueue.ts`.
- **Tracked-file changes: one.** `src/pages/SettingsPage.tsx` — the one-line rollback fix
  (`:244`) plus a comment refresh at `:228`. Nothing else in any source file differs from
  `db9f12e`.
- **Files added:** `electron/review2.manualIpc.test.ts`,
  `electron/review2.queueOrigin.test.ts`, `electron/review2.strandedRow.test.ts`,
  `src/pages/review2.autoQueueMerge.test.tsx`, and this file.
- Not pushed, not merged, no `plans/` committed, no `Co-Authored-By` trailer.