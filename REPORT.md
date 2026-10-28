# REPORT — t_7233c336 (PR #13 money gate: consumer audit + recovery path + test hardening)

Repo: `cvm-services/cvm-service-kit` · Worktree: `~/worktrees/pr13-consumer-audit`
Branch: `fix/gate-consumer-audit` · PR: **#17** (OPEN, MERGEABLE/CLEAN)
Head at the time of writing: `33071d1` (pushed, read back via `git ls-remote`)
Author family: glm/zai · Reviewer family: deepseek (via the `kimi-k2.7-code` lane)

## 1. Arrival state (what was already true when this pass started)

The dispatch prose was stale in three ways, and the work is not what it describes:

1. **PR #13 is MERGED**, not blocked-and-open. Its blocked verdict is a historical record; there
   is no open PR #13 to update or re-review.
2. **The blocker work already existed** on `fix/gate-consumer-audit`, published as **PR #17**.
   A previous pass had produced the audit doc, the recovery module, the CLI and the runbook.
3. **The card `t_7233c336` is not on any board** on this host (`hermes kanban show` → "no such
   task"); the durable record is the branch + PR.

So this pass did not redo the work. It **obtained the cross-family review that the earlier pass
had reported as unobtainable**, then worked every finding it produced — four rounds of them.

## 2. The cross-family review (the outstanding gate)

The earlier pass concluded "cross-family review is unobtainable here". That was wrong, and the
correction is worth keeping:

- the refusals were a **capacity burst**: `503` with `capacity_exhausted: true` and a **non-empty**
  `candidates_considered` (not exhaustion, not a missing lane — pitfall 11/18);
- **`kimi-k2.7-code` served `deepseek-flash`**, a genuine cross-family lane for the glm/zai author;
- **the same ~31 KB prompt returns 0 content chars at `--max-tokens 20000` and a full verdict at
  `60000`** (reasoning budget, pitfall 25's ascending ladder) — and a **43 KB prompt is refused
  where 34 KB is admitted**, so the harness must be trimmed, not abandoned.

Five review artifacts were produced (all under `~/reports/reviews/`, all carrying
`reviewer_model:`): rounds A2, B, C, D on the earlier heads, and F on the current head.

| round | verdict | what it found |
| --- | --- | --- |
| A2 | REQUEST_CHANGES | the audit's *evidence* was thin (narrow status grep, no cast/structural search) |
| B | REQUEST_CHANGES | 10 findings on the recovery path — real defects, not evidence gaps |
| C | REQUEST_CHANGES | **re-opened the ABA race and was right** |
| D | REQUEST_CHANGES | 5 more, including one **created by my own round-3 fix** |
| F | (see §6) | re-review of the round-5 fixes |

## 3. What changed in the code

### 3.1 The release race — the finding that justified the loop

- Round 3's argument was that the ABA "cannot happen without `--force`, because each CLI run
  re-reads the row". That covers only the case where the second read is *after* the re-claim.
- Round 4 described the case it misses, and was right: `releaseReservation` read the row, then
  CASed on **status only**. A read taken before (another operator's release + a caller's
  re-claim) still matched — `settlement_reserved` again — and **cancelled the live claim**,
  letting a second caller run the action concurrently. The read and the CAS are not atomic and a
  status is not a version.
- Round 5 then showed the first fix was still wrong: `updated_at` is wall-clock **milliseconds**,
  so release + re-claim inside one tick collide.

**Final fix:** `gate_orders.rev` — a **monotonic revision** (`INTEGER NOT NULL DEFAULT 0`, with an
`ALTER TABLE` migration) incremented by `claim`, `put` and `releaseIfUnchanged` on *every*
transition — and a release CAS predicated on `status AND rev`. A version can no longer repeat.
Test: the reviewer's own falsifier, an interleaving test that performs the interfering
release + re-claim from **inside** `get()`, driven through `releaseReservation`; it additionally
asserts the row advances exactly two revisions. Mutation `M-R4a` (reinstate the status-only CAS)
and `M-R5c` (stop advancing `rev`) are both **CAUGHT**.

### 3.2 The hole my own fix created (round 5)

Making a `settlement_reserved` order compensatable (round 3) was right — the runbook told
operators to do it. But `releaseReservation` never checked for a recorded compensation, so after
a refund a later `release` could still re-drive the action and the customer would hold **both the
refund and the service**. A compensated order is now **CLOSED**: `release` refuses it, with or
without `--force`. Mutation `M-R5a` **CAUGHT**.

### 3.3 The rest

| finding | fix |
| --- | --- |
| a compensation could be recorded for an order that settled in between | `putResolution` is a conditional `INSERT ... WHERE EXISTS (order_id, status, rev)`; `refusal: "raced"` otherwise |
| legacy `paid` rows had no operator surface at all | third `legacy` bucket in `findStuckOrders`, `legacy-paid` in `list`, compensatable, runbook §4 |
| the runbook told operators to compensate a reservation the API **refused** | a reservation is compensatable; step 2.2 rewritten |
| `--lease-min` could shrink the guard past `--force` | it may only **raise** the lease |
| the lease guard failed **open** on a non-finite `updatedAt` | fails closed |
| …and on a **zero/epoch** `updatedAt` | `usableAge()` requires finite **and positive** |
| the compensation log was an upsert (erased the record it corrected) | append-only (`seq INTEGER PRIMARY KEY AUTOINCREMENT`) + in-place rebuild migration |
| the "current" record was chosen by `at` | ordered by insertion (`seq`), so clock skew cannot resurrect an older entry |
| a flag a command does not honour was silently ignored | `COMMAND_FLAGS`: usage error |
| `compensate` printed "stays settlement_failed" for any row | names the actual status |

The audit doc (`docs/gate-consumer-audit.md`) carries the full per-finding adjudication, round by
round, including the findings I disputed and why — plus the two items that are **accepted
residuals** rather than fixes: `--force` can release a merely-slow live caller (it is the
tool's documented break-glass, and the venue check is the only control that can distinguish slow
from crashed), and the **cutover window** (§ F5b) for a service moving from the in-memory gate.

## 4. Evidence (measured, at head `33071d1`)

- `bun run typecheck` (`tsc --noEmit`) → **rc=0**
- `bun test src services` → **338 pass / 1 skip / 0 fail** (339 tests, 43 files)
- `bun test src/gate-recovery.test.ts` → **16 pass / 0 fail** (6 at arrival)
- `deno task test` → **29 passed / 0 failed**; `deno check` on the four changed files → rc=0
- `evidence/recovery/mutate_gate_recovery.py` (runnable; exits non-zero on an unexplained
  survivor **or a drifted anchor**, so it cannot pass vacuously): 12 mutants — **10 CAUGHT**,
  M-B6 provably *equivalent* (both forms return the same value for every input), **0 unexplained
  survivors**. Source restored byte-identical (asserted).
- `evidence/recovery/cli_smoke.sh` → measured exit codes 0/1/2.
- Both transcripts print the **source blob hashes** and the tree state, so the evidence is bound
  to the mutated *content* rather than to a commit a later docs-only commit moves.

## 5. Honest limits (not verified, stated not hidden)

- **`GATE_DB:` in `deploy/ansible/playbook-wrappers.yml` is an IaC change and is UNEXECUTED on a
  live node from this host** (no managed target, no fleet credentials). The fleet agreement
  requires a post-condition read back **from the node**; that read-back does not exist. The
  mitigating argument — the same `/var/lib/loom/<svc>/gate.sqlite` path is already declared for
  `cvm-nanogpt`/`cvm-ppq`/`cvm-2fiat`, the role creates the directory (owner = service user), and
  `cvm-sms4sats` already writes `orders.sqlite` + `cashu.sqlite` there — **is an argument, not
  evidence.**
- **The consumer-audit premise was false and that is itself a finding**: the five named
  "consumers" are not repositories. They are directories in this repo, compiled by the same
  `tsc --noEmit`. No consumer owns a `GateOrderStore`; no consumer reads a `GateOrder.status`;
  the `TypeError after payment` failure mode does not exist. The **durable control is the in-tree
  typecheck, not a prose checklist** — demonstrated when `main` gained a **sixth** consumer
  (`cvm-deepinfra`) that the original five-name list did not cover.
- **ngit push is not possible from this host** (`no accounts available`). GitHub only; stated
  in the PR rather than claimed.
- No claim is made that the round-6 verdict is APPROVED. Whatever it says is recorded.

## 6. State at handoff

- Branch `fix/gate-consumer-audit` at **`94f55ed`**, pushed to `github` and **read back via
  `git ls-remote`**.
- PR #17 updated with the findings/evidence write-up
  (https://github.com/cvm-services/cvm-service-kit/pull/17#issuecomment-6194454622).
- **PR #17 is NOT merged, and that is deliberate.** Five review rounds were obtained; **all five
  returned `REQUEST_CHANGES`**, and every round found at least one real defect — including two
  (round 5's refund-and-service hole, round 6's C1/C2) created or left open by my own previous
  fix. The findings are all fixed with tests and mutation evidence, **but the newest head has not
  been re-reviewed**, so the cross-family gate is unsatisfied. It is a fleet-owned repo, so the
  consolidation rule says merge — merging on a stack of unreviewed `REQUEST_CHANGES` fixes is
  exactly the "review published" theatre the working agreement exists to prevent.
- **Remaining work, in order:**
  1. Obtain a cross-family verdict on `94f55ed` (the round-6 re-review). If `APPROVE`, merge
     PR #17 to `main` and record the verdict in the audit doc. If `REQUEST_CHANGES`, work the
     findings. The lane recipe is in §2 — one lane serves (`kimi-k2.7-code` → `deepseek-flash`),
     ~34 KB is the largest prompt admitted, `--max-tokens 60000`, retry through bursts.
  2. Merge PR #17 (one open PR; `consolidate-branch.sh`).
  3. The `GATE_DB` IaC line needs a converge + a read-back **from a node** by someone with fleet
     credentials — out of scope for an unprivileged worker here.

### What round 6 changed (after the first version of this report)

Round 6 found the **root cause** of the release race that round 5 had only narrowed: the
compensation did not version the order row, so "check the log, then CAS" was still two steps.
Now `gate_orders.compensated` is set **and** `rev` advanced by the compensation CAS, the release
CAS requires `compensated = 0`, and `put` refuses (and throws on) recording a compensated order as
settled — closing the refund-AND-service path in both directions. Order identity is also refreshed
on a reused `orderId` (the new generation no longer inherits the old invoice/amount or its
compensation). Evidence at the final head: recovery **20/20**, full suite **342 pass / 1 skip /
0 fail**, `deno task test` 29/0, and **15 mutants — 14 CAUGHT, 1 provably equivalent, 0
unexplained survivors**.

---

# (previous pass — preserved verbatim)

# REPORT - gate money-safety fix (fix/gate-money-safety)

## t_7233c336 — offload verification pass 2 (2026-10-14, offload worker)

**Head shipped:** `74b5fad` on `fix/gate-consumer-audit` → **PR #17** (OPEN, `MERGEABLE`/`CLEAN`,
CI `bun` success + `deno` success at that head). PR #13 is MERGED.
**Artifacts touched:** `docs/gate-consumer-audit.md` (F3 table + Merge note 2),
`evidence/recovery/mutation_gate_recovery.txt` (new), `PROGRESS.md`, this report.

### 0. Arrival state: the card's work was already done. This pass verified it and closed two stale gaps.

The dispatch described work that a prior session had already completed and shipped as PR #17
(head `d450a1c`): the consumer audit, the HIGH recovery path, the MED fixes, the branch pushed
to GitHub, PR #13 pointed at. Re-doing it would have been waste and would have risked
regressing a reviewed artifact. So this pass did the two things that were genuinely open, and
verified the rest rather than asserting it:

1. **the branch had drifted 12 commits behind `main` again** — the same class of defect the
   previous pass fixed at 9 commits;
2. **the cross-family re-review was (and remains) unobtainable**, which is what actually gates
   a merge.

### 1. Verification: the audit's own evidence, re-derived independently (not trusted)

Every printed grep in the audit was re-run on the merged tree rather than read:

| claim | re-derived result |
| --- | --- |
| F1 — the five named consumers are directories, not repos; `tsconfig` includes `services/**` | holds; `services/{_shared,cvm-2fiat,cvm-lambda,cvm-nanogpt,cvm-ppq,cvm-sms4sats}`; `include: ["src/**/*.ts","services/**/*.ts"]` |
| F2 — no consumer owns a `GateOrderStore` | holds; exactly two `implements` sites, both in `src/` (`gate-store.ts:34`, `payment.ts:305`) |
| F2b — no consumer-typed store parameter | holds; one site, `payment.ts:356` (the gate's own default) |
| F3 — per-consumer construction | holds, **and the set had grown to six** (see §2) |
| F4 — no consumer branches on a gate status | holds; the sole product branch is `payment.ts:394`, inside the gate |
| F4b — no service catches the gate error classes | holds; `grep` over `services/` (minus tests): no matches |
| F6 — no replica/scale deployment | holds; `grep -iE "replica\|scale\|cluster\|instances" deploy/`: no matches |

### 2. Finding (real, from the merge): `main` added a SIXTH gate consumer

`main` advanced `0dc9b71` → `b9a50bf` (12 commits: PRs #20–#22, `cvm-jlc-quote`,
`cvm-deepinfra`). Merged into the branch as `6b69d08` — **merge, never rebase** — with **no
conflicts**. The only file touched on both sides is `deploy/ansible/playbook-wrappers.yml`;
our hunk adds `GATE_DB:` for `cvm-sms4sats` at the wrapper-list head, main's appends a whole
`cvm-jlc-quote` wrapper at the tail. Different regions, so it auto-resolved.

`services/cvm-deepinfra/src/server.ts:26-29` is a **new sixth** `ExplicitGate` construction
site, so the audit's "five consumers" framing was already stale when written. It passes
`new SqliteGateStore(env.GATE_DB ?? "/var/lib/loom/cvm-deepinfra/gate.sqlite")` — it has the
required `claim`.

**This strengthens rather than weakens the audit.** Had the new consumer lacked `claim`,
`bun run typecheck` — which compiles `src/**/*.ts` *and* `services/**/*.ts` — would have
failed on `main` the moment it landed, before any gate change could reach it. That is F1/F2's
argument, confirmed by the first new consumer to appear since the audit. The generalisable
conclusion: **the durable control is the in-tree typecheck, not a prose checklist frozen at
review time.** Any future consumer is covered automatically. F3's table and a "Merge note 2"
section were added to `docs/gate-consumer-audit.md`.

### 3. Verification: the recovery path was MUTATION-tested, not merely read

Reading a test and believing it is not evidence. Four mutants were injected into
`src/gate-recovery.ts` and `services/cvm-sms4sats/src/server.ts`, each run against its own
suite, then the source was restored and confirmed **byte-identical**.
Evidence: `evidence/recovery/mutation_gate_recovery.txt`.

| mutant | result | verdict |
| --- | --- | --- |
| M-R1 drop the live-lease guard (`ageMs <= leaseMs && !opts.force` → `false && …`) | 4 pass / **2 fail** | CAUGHT |
| M-R3 remove the `not_reserved` guard (line 116) | 4 pass / **2 fail** | CAUGHT |
| M-R2 CAS source `"settlement_reserved"` → `order.status` | 6 pass / 0 fail | **equivalent mutant**, not a gap — see below |
| M-S1 revert `buildGate` to `new ExplicitGate(processor)` (the pre-fix sms4sats shape) | 2 pass / **1 fail** | CAUGHT |

M-R2 deserves the note because "a survivor" is exactly the kind of result that gets over-read.
It is **provably equivalent**: line 116 returns early unless `order.status ===
"settlement_reserved"`, and `order` is a pre-read snapshot that nothing mutates before line
124, so the substituted expression is identical to the literal at that point. The *dangerous*
variant of the same idea — an unconditional / blind-put release — is caught by M-R3 and by the
"release goes through the CAS" test, which asserts `refusal === "not_reserved"`. So the
survivor is a property of the code's shape, not a hole in the suite.

### 4. Green on the merge result (`6b69d08`; `74b5fad` adds only docs)

- `bun run typecheck` → **rc=0**
- `bun test src services` → **328 pass / 1 skip / 0 fail** (329 tests, 43 files), rc=0
  (up from 259/1/0 before the merge, because `main` added `cvm-jlc-quote` and `cvm-deepinfra` tests)
- `deno task test` → **29 passed / 0 failed**
- `deno check src/{payment,gate-store,gate-recovery,gate-recovery-cli}.ts` → **rc=0**

### 5. Stated plainly — an honest caveat and what was NOT verified

- **`bun test src services tests` is 3 fail / 3 errors, and that is NOT this branch's doing.**
  All three are `ReferenceError: Deno is not defined` from the `Deno.test`-native files `main`
  added under `tests/` (`tests/deepinfra_quote_test.ts` et al.). Proven pre-existing: a detached
  worktree at pristine `github/main` (`b9a50bf`) reports the identical `0 pass / 3 fail /
  3 errors` for `bun test tests`. They pass in their own lane (`deno task test` → 29/0). The bun
  suite of record is `bun test src services`. Recorded in the audit doc so a reviewer does not
  mistake it for a branch defect.
- **The `GATE_DB:` line in `deploy/ansible/playbook-wrappers.yml` is an IaC change and has NOT
  been executed against a live node.** The fleet working agreement adds a 6th gate for IaC
  (execute against a real target, then read the post-condition back *from the node*). This host
  has no managed target and no fleet credentials, so the line is **syntax-checked only,
  unexecuted**. It is a pure additive env var with a code-side default (so an un-updated host
  still works) — but that is an argument, not evidence.
- **ngit push FAILED.** `ngit account login` → `authentication required; failed to get or find
  signer info`. This host has no ngit account, so this is **GitHub-only**. The GitHub push is
  confirmed independently by `git ls-remote`, not by the push's own exit code.
- **The cross-family re-review is still outstanding.** See §6 — it is the only thing gating
  PR #17, and it could not be obtained here.

### 6. The cross-family re-review: requested, and a lane-pool warning worth propagating

Every non-glm lane was probed directly, and this pass found something the earlier pass could
only report as "503":

- `kimi-k3`, `deepseek/deepseek-v4-pro`, `minimax-m3:cloud`, `qwen3.6-35b` →
  `{"error": "all providers exhausted (flat router)", "capacity_exhausted": true}`.
- **`kimi-k2.7-code` and `kimi-k3:cloud` return `"model": "deepseek-flash"` in the response
  body** — the flat router *silently substitutes* a same-family lane for an exhausted one.

That second one is a fleet-level trap, not a local annoyance: a reviewer that dispatches to
`kimi-k2.7-code`, reads the answer, and records `reviewer_model: kimi-k2.7-code` would produce
a **deepseek-reviewing-deepseek** verdict that *looks* cross-family in the transcript and
satisfies D-115 on paper while defeating it in fact. This audit's author family is glm, so a
deepseek reviewer is not cross-family in the way the gate intends for the *re-review of the
same finding set* the deepseek lane already reviewed on PR #13. Not accepted here.

Requested instead, on the PR: re-review at `74b5fad` (comment
`#issuecomment-6179406376`), and a formal reviewer request on `c03rad0r`
(`requested_reviewers` verified via the REST API, not via `gh pr edit`, whose GraphQL path
returned rc=0 while silently not applying the request). PR #13 also carries a pointer comment
(`#issuecomment-6179414947`). **The BLOCKED verdict on #13 stands as history until a
different-family reviewer returns APPROVED at `74b5fad`.**

### 7. Commits in this pass

| commit | what |
| --- | --- |
| `8755370` | `docs(evidence)`: mutation evidence for the gate recovery path |
| `6b69d08` | merge `github/main` (`b9a50bf`) into `fix/gate-consumer-audit` — no conflicts |
| `74b5fad` | `docs(audit)`: re-pin evidence to the merge; F3 gains the sixth consumer (`cvm-deepinfra`) + Merge note 2 |

Pushed to `github` (`d450a1c..74b5fad`), read back via `git ls-remote`:
`refs/heads/fix/gate-consumer-audit = 74b5fad81266425538315922193a044490abfe0c`.

`merge_claim: head=74b5fad diff=matched claim=matched ci=success`

---

## t_7233c336 — verification + merge pass (2026-10-14, offload worker)

**Deliverable:** `docs/gate-consumer-audit.md` (the consumer audit with per-consumer grep evidence),
`src/gate-recovery.ts` + `src/gate-recovery-cli.ts` + `src/gate-recovery.test.ts` (the HIGH recovery
path), `docs/gate-recovery-runbook.md`, and the test hardening — all on branch
`fix/gate-consumer-audit`, shipped as **PR #17**.

### 0. The dispatch prose was stale; this is a verification-and-merge pass, not a redo

Two facts had to be established before any work, and both change the framing:

1. **PR #13 is MERGED, not open.** `gh pr view 13` → `state=MERGED`,
   `mergedAt=2026-10-10T13:48:58Z`, `mergeCommit=220cb217ef27a91b0557b9d2df0db7d79094c052`, head
   `fix/gate-money-safety` @ `4949736`. The cross-family BLOCKED verdict was returned on
   `b35b916`; the branch was then advanced to `4949736` (which closed the M2-evidence and
   recovery-documentation findings) and merged. So the instructed action — "push the branch,
   update PR #13, request a re-review" — is not available: the PR it names is closed and merged.
2. **The blocker work already existed.** Branch `fix/gate-consumer-audit` (= **PR #17**, OPEN)
   already carried the audit, the recovery path and the test hardening, produced by the card's
   earlier run. The durable card id `t_7233c336` is **not on board `contextvm-services`**
   (`hermes kanban --board contextvm-services show t_7233c336` → "no such task").

So the honest job was: verify the existing work against reality, find what was genuinely still
wrong, fix that, and get PR #17 into a landable state.

### 1. Finding: the branch had drifted 9 commits behind main (the one real defect)

`git merge-base HEAD main` = `e2a7065`; `main` was at `0dc9b71`. The 9 missing commits include
**PR #19** (*settled-replay proof binding*), which changed the *same two files* this branch
changes: `GateOrder.proofHash`, the exported `TERMINAL_STATUSES`, the new-generation `CASE` in
`SqliteGateStore.put`, and the `SettlementEvidenceMismatchError` / `SettlementBindingNotPersistedError`
classes. `git merge-tree --write-tree main HEAD` reported conflicts in `src/gate-store.ts` and
`PROGRESS.md`. A PR that cannot be merged cleanly cannot be landed, so this was blocking.

**Fix:** merged `main` into the branch (never rebased, per the fleet working agreement), commit
`cb01506`. Conflicts resolved as a **union**:

* `src/gate-store.ts` — main's `proof_hash` migration, `TERMINAL_STATUSES`-derived SQL and
  4-argument `claim(orderId, from, to, proofHash?)` are KEPT, together with this branch's
  `gate_recovery` table, `list(statuses?)`, `putResolution()` / `listResolutions()` and the
  `GateResolution` type. The recovery path calls only `get` / `list` / `claim(id, from, to)`, all
  still satisfied (`proofHash` is optional, so the 3-argument call typechecks).
* `PROGRESS.md` — both sections kept (main's `t_5b30bdec` rounds 1–4 and the branch's
  `t_7233c336` entry).

### 2. Finding: the audit's printed evidence was pinned to a superseded base

`docs/gate-consumer-audit.md` printed raw grep output taken at `e2a7065`. Because PR #19 added
~275 lines to `payment.ts` and two new `GateOrderStore` implementations inside
`src/replay_binding.test.ts`, a reviewer following the document's own "Reproducing" section would
have got **different output** — line numbers moved and F2's grep gained two test-file matches.
The *claims* were unaffected; the *citations* were wrong.

**Fix** (commit `53a1bb1`): every grep re-run on the merged tree and the document corrected —
F2/F2b gain the `grep -v '\.test\.ts'` filter plus an explicit note naming the two test doubles
(`LossyStore`, `LegacyClaimStore`); F4's `src/payment.ts:195` → `:394`; the F3 table header
`e2a7065` → `0dc9b71`; F8's `gate-recovery.test.ts` count 5 → 6 (measured); and a new **merge
note** section recording exactly what was merged, how the union was resolved, what was
re-verified, and the unexecuted IaC line. `REPORT.md` carries the same base correction.

### 3. What was verified (all on the shipped head `53a1bb1`)

| check | result |
| --- | --- |
| `bun run typecheck` (`tsc --noEmit`) | **rc=0** |
| `bun test src services` | **258 pass / 1 skip / 0 fail** (259 tests, 38 files) **rc=0** |
| `bun test src/gate-recovery.test.ts` | 6 pass / 0 fail |
| `bun test services/cvm-sms4sats/src/gate-durability.test.ts` | 3 pass / 0 fail (incl. the CONTROL showing the pre-fix shape re-runs: `runs === 2`) |
| `bun test src/money_safety.test.ts` | 14 pass / 0 fail (incl. "a void tool (run() returns undefined) still replays from the cache") |
| `gate-recovery-cli` exit codes | usage **rc=2**, bad subcommand **rc=2**, refusal **rc=1** (captured directly, not through a pipe) |
| `ansible-playbook --syntax-check playbook-wrappers.yml` | **rc=0** |
| CI on `53a1bb1` (GitHub Actions) | `bun` success, `deno` success, both `head=53a1bb1` |
| PR #17 mergeability | `MERGEABLE` / `CLEAN` |

**Independent re-derivation of the audit's own claims.** The audit's greps (F2/F2b/F3/F4a/F4b)
plus the F1 `tsconfig` claim (`include: ["src/**/*.ts", "services/**/*.ts"]` — so every consumer
is compiled by the same `tsc --noEmit`) and the F6 deploy claim (no `replica|scale|cluster|instances`
anywhere in `deploy/`; the unit template is a plain `Type=simple`, single `ExecStart`,
`Restart=always`) were all re-run on the merged tree. **The substance of F1–F7 holds unchanged.**
The five named "consumers" are indeed directories under `services/` in this repo, not
repositories; no consumer implements or accepts a `GateOrderStore`; the only product-code branch
on a gate status is inside `src/payment.ts`; and no service product code references the gate error
classes.

### 4. Stated plainly — what was NOT verified

* **The IaC line is unexecuted.** `deploy/ansible/playbook-wrappers.yml` gains
  `GATE_DB: /var/lib/loom/cvm-sms4sats/gate.sqlite` for the `cvm-sms4sats` wrapper. The fleet
  working agreement is explicit that an IaC change is *not* done at "syntax-check passes": it must
  be executed against a live node and its post-condition read back **from the node**. This host has
  no managed target and no fleet credentials, so the line is **syntax-checked only**. It is
  additive, and `configFromEnv` defaults the identical path in code (so an un-updated host still
  works) — but that is an argument, not evidence. This is the one item a reviewer with fleet
  access should treat as open.
* **`ngit` was not updated.** This host has no ngit account: `ngit account list` → "no accounts
  available", and the push fails with `failed to get or find signer info in cli arguments, local
  git config, global git config or system git config`. The GitHub remote was pushed and read back
  (`git ls-remote github fix/gate-consumer-audit` = `53a1bb1`). Per the push policy a public repo
  should reach both; from this host only GitHub was reachable.
* **The cross-family re-review of PR #17 is outstanding.** The BLOCKED verdict on PR #13 is a
  historical record on a merged PR; what gates a merge now is PR #17's own review, which did not
  exist (`reviewDecision: ""`) when this pass started. The re-review request is published at
  https://github.com/cvm-services/cvm-service-kit/pull/17#issuecomment-6165452917.

### 5. Commits

| commit | what |
| --- | --- |
| `cb01506` | `merge: main (0dc9b71) into fix/gate-consumer-audit` — the union resolution above |
| `53a1bb1` | `docs: re-pin the consumer audit's grep evidence to the merged tree + merge note` |
| `361efdf` | `docs(report): t_7233c336 verification + merge pass write-up` |
| (final) | `fix(gate-store): list([]) is an empty filter` — TDD fix from the self-check |

### 6. The cross-family review could not be obtained here — and one real bug it still found

Every non-flash model lane was capacity-exhausted on this host:
`HTTP 503 "all providers exhausted (flat router)"` for `kimi-k3`, `kimi-k2.7-code`,
`kimi-k3:cloud`, `minimax-m3:cloud` **and** `deepseek/deepseek-v4-pro`. So no cross-family
review could be produced from this machine; the re-review **request** is published at
https://github.com/cvm-services/cvm-service-kit/pull/17#issuecomment-6165452917 and the review
itself remains outstanding. **D-115 is therefore NOT satisfied for this branch.**

A same-family, independent-context adversarial pass was run anyway (`deepseek/deepseek-v4-flash`
— the dispatching agent's own family, explicitly labelled in the artifact and in the audit doc as
**not** a review of record). It returned `APPROVED_WITH_FINDINGS` with 5 findings; the full
disposition table is in `docs/gate-consumer-audit.md` § "Independent self-check". Net result:

* One **real** latent bug, now fixed under TDD: `SqliteGateStore.list([])` returned **all**
  orders, contradicting its own documented contract ("all orders when omitted"). Unreachable from
  today's callers, but a trap for any caller whose status list filtered down to empty. RED test
  added first, then the fix; `list()` / `list("x")` / `list(["x","y"])` unchanged.
* One false HIGH (the CLI file was outside the diff subset handed to the lane — its exit codes
  were measured directly instead).
* Two accepted design tensions, both already documented: the lease is a *surfacing hint*, not an
  enforcement (the venue check cannot be automated); and the escape-hatch test's `verify()` is a
  fake, so the processor-level exactly-once hazard stays a documented residual.

Re-verified after the fix: `bun run typecheck` rc=0; `bun test src services` → **259 pass /
1 skip / 0 fail** (260 tests, 38 files) rc=0.

---



## t_7233c336 (2026-10-10) - consumer audit + operator recovery path + test hardening

Branch `fix/gate-consumer-audit`, first written against `github/main` @ `e2a7065` (PR #13 itself is
merged) and **merged with `github/main` @ `0dc9b71` on 2026-10-14** — the branch had drifted 9
commits behind, so the merge was taken and the greps below re-run on the merged tree. See the merge
note at the end of `docs/gate-consumer-audit.md`.
Full audit: `docs/gate-consumer-audit.md`. Runbook: `docs/gate-recovery-runbook.md`.
Evidence: `evidence/recovery/`.

The cross-family review of PR #13 (`deepseek-flash`, verdict BLOCKED) had one BLOCKER and one HIGH.
Both are closed here; the MEDs were mostly already fixed by the merged gate and are now either
covered by a named test or reconciled in the documents that contradicted each other.

### 1. BLOCKER: the five consumers - the premise was false, and one real defect was hiding

The review assumed `cvm-sms4sats`, `cvm-ppq`, `cvm-nanogpt`, `cvm-lambda` and `cvm-2fiat` are
separate repositories consuming a published kit, so a consumer-owned store missing the new
`claim` would throw `this.store.claim is not a function` **after** payment was verified.

They are not repositories at all: `gh repo list cvm-services` has none of those names, and all five
are directories under `services/` in **this** repo, importing the gate through relative paths
(`../../../src/index.ts`) and compiled by the same `tsc --noEmit` (`tsconfig.json` includes
`src/**/*.ts` and `services/**/*.ts`). There is no cross-repo version skew to break.

`grep -rn "implements GateOrderStore" src services` returns exactly two classes, both in the kit, and
`grep -rn ": GateOrderStore" src services` returns one construction site - the gate's own default.
No consumer owns a store, and no consumer branches on a gate status (`src/payment.ts:394` is the only
`.status ===` on a `GateOrder` in the tree). So the `TypeError` failure mode does not exist and the
new terminal states break nothing downstream.

The audit did find one real consumer defect, which F5 of the audit document and commit `64daf9e`
fix: **`cvm-sms4sats` passed no store at all**, so the gate's own memory of "this payment is settled"
lived in an in-process `Map`. With `Restart=always` (the deployed unit), a replayed proof was
re-verified against a still-settled invoice and the paid tool ran a second time against one payment -
the double spend the gate exists to prevent, for that tool shape. It now builds
`SqliteGateStore(cfg.gateDb)`, with a falsification control in
`services/cvm-sms4sats/src/gate-durability.test.ts` (pre-fix shape: `runs === 2`; fixed: `runs === 1`).

Multi-replica exposure was measured rather than assumed: no replica/scale/cluster instancing exists
anywhere in `deploy/`, so the single-process `MemoryOrderStore` was not reachable - but with
`cvm-sms4sats` moved off it, no shipped service constructs a gate over the in-memory store any more.

### 2. HIGH: no recovery path for `settlement_reserved` / `settlement_failed` (implemented)

The reviewer's HIGH finding: the gate correctly never re-runs an action against a verified payment,
but that left "money taken, order stuck" with no lease, no reconcile/refund command and no runbook.

Implemented as an operator path that is deliberately **not** automatic. Whether a crashed
`settlement_reserved` action ever reached the venue is knowable only by looking at the venue; a
crashed action and a slow one are indistinguishable from the store, so an automatic release (lease
expiry, timeout sweep) would re-run an action of unknown outcome - the original double spend. The
lease only decides what to *flag*.

| file | what it adds |
| --- | --- |
| `src/gate-recovery.ts` | `findStuckOrders` (read-only report of `settlement_reserved` + `settlement_failed`, with age and lease flag), `releaseReservation` (CAS `settlement_reserved -> awaiting_payment` through the SAME guarded UPDATE the gate uses; refuses a live lease unless `force`), `recordCompensation` (durable audit record for a `settlement_failed` order; deliberately does not touch the status) |
| `src/gate-recovery-cli.ts` | `bun src/gate-recovery-cli.ts list\|release\|compensate` (`bun run gate-recovery`); exit 0 done, 1 refused, 2 usage error |
| `src/gate-store.ts` | `list(statuses?)` + a `gate_recovery` table. `list` is deliberately on the concrete store, NOT on the `GateOrderStore` interface - the shared primitive is not widened a second time |
| `src/gate-recovery.test.ts` | 6 tests (see below) |
| `docs/gate-recovery-runbook.md` | the operator procedure: per-service gate DB paths, the venue check that must precede a release, and the hard rules |

What the tests pin down, and the falsification controls among them:

* **Inspecting changes nothing.** A crashed reservation is surfaced with its age; past the lease it is
  flagged, and the row is still `settlement_reserved` afterwards - `findStuckOrders` is read-only.
* **A live lease is refused.** `releaseReservation` on a 1-minute-old reservation refuses with
  `lease_active` and the status is unchanged; past the lease it releases, and the retry then runs the
  tool exactly once (a further replay returns the cache) - the escape hatch works end to end.
* **Release is a CAS, not a blind put.** Two connections over one file: after one releases, the
  other's release loses with `not_reserved`. A blind-put implementation would hand out two retries.
* **Nothing terminal can be resurrected.** `releaseReservation` refuses settled and failed rows;
  `recordCompensation` refuses anything not `settlement_failed`; a compensated order still throws
  `SettlementFailedError` with `runs === 0`, and the compensation survives a restart.

### 3. MEDs: what was already fixed by the merged gate, and the one contradiction that was real

| review finding | disposition |
| --- | --- |
| unenumerated statuses fall through to `run()` | already fixed in the merged gate: exhaustive `switch` + `default: deny` (`src/payment.ts`); covered by "an unrecognised order status is refused, never run" |
| terminal write unguarded (SQLITE_BUSY pins the row) | already fixed: both terminal `put`s wrapped, fail closed; covered by the lock-contention test |
| `rejects.toThrow()` with no argument | already fixed: asserts `SettlementFailedError` + code + orderId + message |
| `GateOrder.failure` with no DDL/migration; `changes === 1` presumes a unique key | already fixed: explicit `ALTER TABLE` migration, `order_id TEXT PRIMARY KEY`; covered by the pre-fix-database migration test |
| **comment contradicts the mutation table** | **real, and fixed here.** `src/money_safety.test.ts`'s concurrency comment claimed 4 rounds take detection to `~1-(1/3)^4 (~99%)` while the mutation row recorded 0 fail, and `evidence/README.md` claimed the strengthened run caught the mutant `6 of 6` - both refuted by the committed log in `evidence/mutation_M2_strengthened.txt` (runs 4 and 5 are `13 pass / 0 fail`). The `~99%` claim is removed, the comment now states the measured 4-of-6 (no improvement over a single round, no percentage claimed), and the two stale `REPORT.md` rows plus the `evidence/README.md` row carry the correction with the M1 re-measurement (snapshot-cache mutant: **now caught**, 2 failures) |
| `deno.lock` riding in an unrelated commit | closed: split into its own commit `cc38d9e` |
| UNVERIFIED: replay guard keying on `result !== undefined` | closed: the guard is `status === "settled"`, pinned by the "void tool (`run()` returns undefined)" test against **both** stores |

### Verification (this card's run, bun 1.4.2 / deno 2.9.0)

```
bun test src/gate-recovery.test.ts        6 pass / 0 fail   rc=0   evidence/recovery/recovery_tests.txt
bun run test                             231 pass / 1 skip / 0 fail (37 files) rc=0  evidence/recovery/suite_bun.txt
bun run typecheck   (tsc --noEmit)        rc=0                       evidence/recovery/typecheck.txt
deno task check + deno check <4 files>    rc=0                       evidence/recovery/deno_check.txt
bun src/gate-recovery-cli.ts              usage -> rc=2, list -> rc=0  evidence/recovery/cli_smoke.txt
```

`bun test src/money_safety.test.ts` (13 tests, the merged gate's suite) is part of the 231 and stayed
green after the comment edit. `deno.lock` is unchanged by this card's deno runs.

### Boundary, stated

The recovery path is an **operator** tool: it does not, and must not, decide on its own whether a
stuck order may be re-driven. Its two commands are also not wired into any service's HTTP surface -
an operator runs them against the service's `gate.sqlite`. Wiring a `reconcile` entry point into a
service (with authentication) is a separate card if it is wanted; the durable record it needs
(`gate_recovery`) is in place here.

## t_e19ad2e9 (2026-10-10) - close the money-safety gaps left open by the sections below

Commit `b4ecf58` on `fix/gate-money-safety` (base `b35b916`). Two of the three items the body of
this report left explicitly **open** are closed here; the third is closed with evidence.

### 1. Unknown statuses fell through to the action (fix)
`gate()` enumerated `settled`, `settlement_failed`, `paid`, `settlement_reserved` and
`awaiting_payment` as separate `if`s, then ran the action for everything that reached the bottom.
A `refused` order - or ANY status written by another build - therefore executed the downstream
action with **no `processor.verify()`, no `claim()`**: an unverified, unclaimed run. That is the
same double-spend class this branch exists to close, reached through the `default` case instead of
through a missing `claim`.

`gate()` is now an exhaustive `switch` with an explicit `default`:

| status | action |
| --- | --- |
| `settled` | replay cached result (unchanged) |
| `awaiting_payment` | only case that reaches `verify()` + `claim()` + the action |
| `settlement_reserved` | `SettlementInProgressError` |
| `settlement_failed` | `SettlementFailedError` with the recorded reason |
| `paid` (legacy) | `GateOrderStateError` - see below |
| `refused` | `GateOrderStateError` |
| anything else | `GateOrderStateError` (the `default`) |

### 2. A terminal failure was not terminal across a restart (fix)
`settlement_failed` and its reason were persisted only by whichever store happened to be in play.
On the in-memory store a restart simply forgot the order, and - because
`CREATE TABLE IF NOT EXISTS` is a **no-op on an already-deployed file** - a real deployment would
have kept the column-less schema too. `SqliteGateStore` now adds a `failure_json` column **and
migrates existing databases**:

```ts
const columns = this.db.query(`PRAGMA table_info(gate_orders)`).all() as { name: string }[];
if (!columns.some((c) => c.name === "failure_json")) {
  this.db.run(`ALTER TABLE gate_orders ADD COLUMN failure_json TEXT`);
}
```
`put()` writes it, `get()` reads it, and the `ON CONFLICT DO UPDATE` set-list carries it, so a
failure recorded before a restart is re-thrown with its original reason after one.

### 3. `SQLITE_BUSY` escaped as a raw error out of a paid call (the body's own follow-up: now fixed)
The section "Follow-up found while testing" below says setting `busy_timeout` "would turn lock
contention into an ordinary lose-the-CAS result" and left it for another card. Implemented here:
`SqliteGateStore`'s constructor sets `PRAGMA busy_timeout = 5000`. Contention now resolves as a lost
CAS (or a slightly slower winner) rather than an opaque throw from a call whose payment was accepted.

### 4. A completed action could be masked by a failed store write (fix)
Both terminal `put()` calls are now wrapped: if the action ran and succeeded but recording it
throws (a locked store), the error is not allowed to replace the successful result, because the
row is still `settlement_reserved` and the worst case is a replay reporting "in progress" - never a
second run. Same for the failure path: a failed terminal write must not be swallowed, and the row
staying `settlement_reserved` fails closed.

### 4b. A stuck `settlement_reserved` row: accepted dead-end + operator recovery (review F2)
`claim()` moves `awaiting_payment -> settlement_reserved` **before** the action runs, deliberately:
that is what makes a paid intent single-shot. The cost is a state a process cannot leave on its own -
if the worker dies between `claim()` and the terminal `put()`, or the terminal write itself fails,
the row stays `settlement_reserved` and every later call throws `SettlementInProgressError` (-32003)
forever. **This is accepted and correct**: the alternative (auto-retry) is exactly the double-spend
this gate exists to prevent, and nothing inside the gate can decide "did the action run?" from the
row alone. It is written down here because it needs a human, not a retry loop.

Impact: one order. The customer has paid and can obtain neither the result nor a failure - the
service reports "in progress" indefinitely. The row is per-order, so other orders are unaffected.

Operator recovery (manual, per order; there is no automatic path, by design):
1. Find stuck rows:
   `sqlite3 "$GATE_DB" "select order_id, updated_at, failure_json from gate_orders where status='settlement_reserved'"`
   (`$GATE_DB` is the service's gate database, e.g. `/var/lib/loom/cvm-<svc>/gate.sqlite`.)
2. Decide whether the downstream action ran, from a source **outside** the row: the provider/venue
   ledger or receipt for that `order_id`, the downstream service's own order store, and its logs.
3. If it did **not** run - release the claim so a retry re-drives it:
   `sqlite3 "$GATE_DB" "update gate_orders set status='awaiting_payment', updated_at=<now> where order_id='<id>' and status='settlement_reserved'"`
4. If it **did** run - write the terminal state so replays return the recorded outcome instead of
   "in progress":
   `sqlite3 "$GATE_DB" "update gate_orders set status='settled', updated_at=<now> where order_id='<id>' and status='settlement_reserved'"`
   (a genuinely failed action takes `status='settlement_failed'` with `failure_json` set, which
   replays re-throw - see section 2.)
5. Both statements carry `and status='settlement_reserved'`, so a concurrent claim wins the race and
   the operator's update becomes a no-op instead of overwriting a live transition.

Do not script this to run unattended, and do not "fix" the gate by adding a timeout-based automatic
retry: step 2 cannot be automated from inside the gate, and guessing it wrong re-runs a paid action.

### 5. `paid` is no longer reported as a settlement failure (behaviour change, flagged)
The body mapped a legacy `paid` row onto `SettlementFailedError`. That asserts the action FAILED,
which is not known - the old code wrote `paid` **before** the action ran, so the outcome is
unknowable. The new `GateOrderStateError` (`code -32005`) says exactly that and keeps the two
states distinguishable. **Consumer impact: none.** See the audit below - no consumer in this repo
imports or catches `SettlementFailedError` at all; only `PaymentRequiredError` is referenced, and
only from tests. `GateOrderStateError` deliberately mirrors its siblings
(`SettlementInProgressError` -32003, `SettlementFailedError` -32004) in also carrying **no** `data`
field: `transport.ts:214` requires `code < 0 && e.data` to emit a structured JSON-RPC error, so all
three surface as `isError: true` tool text. That is fail-closed and unchanged in kind.

### Consumer audit (the body's "Required before merge" item 4 - now done)
`bun run test` is `bun test src services`, so the services' own suites run in the declared suite and
were re-run after this change: **172 pass / 1 skip / 0 fail across 31 files**, including
`services/_shared/ai.test.ts`, `services/cvm-sms4sats/src/{tools,wallet,upstream}.test.ts`,
`services/cvm-lambda/src/*.test.ts` and `services/cvm-2fiat/src/hygiene.test.ts`.

| consumer | gate store | affected by this change? |
| --- | --- | --- |
| `services/cvm-lambda/src/server.ts:118-120` | `new SqliteGateStore(cfg.gateDb)` | gains durability + migration + busy timeout. `paid` rows now `GateOrderStateError`. |
| `services/cvm-ppq/src/server.ts:21-23` | `new SqliteGateStore(env.GATE_DB ?? "/var/lib/loom/cvm-ppq/gate.sqlite")` | same; **no test file in-repo** |
| `services/cvm-nanogpt/src/server.ts:16-18` | `new SqliteGateStore(env.GATE_DB ?? "/var/lib/loom/cvm-nanogpt/gate.sqlite")` | same; **no test file in-repo** |
| `services/cvm-2fiat/src/server.ts:85-87` | `new SqliteGateStore(cfg.gateDb)` | same |
| `services/cvm-sms4sats/src/server.ts:94` | **`new ExplicitGate(processor)`** - processor only, in-memory store | **outlier**: gets the default-deny + terminal-failure fix, but NOT the restart durability. Every restart forgets its gate orders. |

Nothing relied on an unknown status reaching the action, and nothing switches on the error classes,
so no consumer needed an edit. `cvm-sms4sats` is the one real finding: it builds a
`SqliteOrderStore(cfg.orderDb)` for its own orders but hands the gate no store at all. Fixing it is
a one-line change to a service, not to the gate, so it is left as a finding rather than smuggled
into a money-safety gate PR - it wants its own card.

### RED-before, re-measured on this card's tests
New worktree at `github/main` (`7958fff`), same test file, judged against pre-fix product code:
`evidence/red_main.txt` - **3 pass / 5 fail**, and the failure is the actual double spend, not a
missing symbol:

```
a failed run is terminal: a retry never re-runs the tool   -> Expected: 1  Received: 2
concurrent calls run the tool exactly once                 -> Expected: 1  Received: 2
claim is compare-and-set on the order status               -> store.claim is not a function
claim is compare-and-set across independent connections    -> a.claim is not a function
exactly one truly concurrent caller wins the claim         -> seed.close is not a function
```
The two `Received: 2` lines are the bug: two executions of the action against one payment.

### Mutation re-measurement, and a test that got stronger
The body's table recorded two mutants as "0 fail - not caught", including a snapshot-cache `claim`.
Re-measured against this card's suite (`evidence/mutation_M1_snapshot_cache.txt`,
`mutation_M2_snapshot_pre_read.txt`, `mutation_M2_strengthened.txt`):

| mutation of `SqliteGateStore.claim` | result |
| --- | --- |
| decide from a status snapshot cached by `put()`/`get()` (M1) | **2 fail - caught** |
| decide from a lazily-primed read, `UPDATE` unguarded (M2, TOCTOU shape) | 1 round: caught **4 of 6** runs; **4 rounds: also 4 of 6** (runs 4 and 5 survived) |

M1 is now caught by the truth-table and cross-connection tests - the suite that called it invisible
has grown teeth. M2 is a **process-interleaving** mutant, not a logic mutant: the losing window is
one synchronous statement pair, so it only trips when two processes genuinely overlap. The
concurrency invariant runs **4 independent rounds**, and on the committed 6-run measurement the
strengthened suite caught the mutant **4 of 6** runs - the same rate as the single round, so this
sample shows **no measured improvement**. Corrected 2026-10-10 (review F1): the row previously read
"4 rounds: 6 of 6" and the paragraph below derived a `~1-(1/3)^4 ≈ 99%` detection figure from it,
both of which the log in `evidence/mutation_M2_strengthened.txt` refutes (run4 and run5 are
`13 pass / 0 fail`). **No 99%, and no per-run detection percentage, is claimed for this test.** What
carries the guarantee is not the timing-dependent round loop but the **deterministic** truth-table
and cross-connection tests: an implementation that answers from a comparison instead of a statement
is caught there on every run, which is why M1 went from "not caught" to **caught**. The 4-round loop
remains as defence in depth for the interleaving shape, with its real measured rate stated above.

### Verification (this card's run, bun 1.4.2 / deno 2.9.0)
```
bun test src/money_safety.test.ts        13 pass / 0 fail           [6.87s]
bun run test                             172 pass / 1 skip / 0 fail  (31 files) [16.27s]
bun run typecheck   (tsc --noEmit)       rc=0
deno task check     (deno check src/mod.ts)  rc=0
deno task test      (deno test tests/)   ok | 24 passed | 0 failed
```
Full logs: `evidence/suite_bun.txt`, `evidence/suite_deno.txt`.

**Deno scope, stated exactly** (`evidence/deno_scope.txt`): `deno.json`'s `check` task is
`deno check src/mod.ts`, and `src/mod.ts` does **not** re-export `payment.ts` or `gate-store.ts`, so
`deno task check` alone would NOT have typechecked this fix. The changed source files were checked
explicitly:
```
deno check src/payment.ts src/gate-store.ts      rc=0
deno check src/money_safety.lock_holder.ts       rc=0
```
and deno genuinely reports errors there - a negative control injecting
`const won: number = this.store.claim(...)` (claim returns `boolean`) fails with
`TS2322 [ERROR] ... rc=1`. `src/money_safety.cas_runner.ts` cannot be deno-checked (`TS2868:
Cannot find name 'Bun'`) but it is **pre-existing on `b35b916`** and untouched by this card.

### Files changed by this card
| file | change |
| --- | --- |
| `src/payment.ts` | exhaustive `gate()` dispatch + `default`; `GateOrderStateError`; store-write failures no longer mask a completed action |
| `src/gate-store.ts` | `PRAGMA busy_timeout`; `failure_json` column + `ALTER TABLE` migration; read/write/upsert the reason |
| `src/money_safety.test.ts` | +5 tests (default-deny, legacy `paid`, durable failure reason across restart, lock contention via subprocess, pre-fix DB migration); concurrency test now 4 rounds |
| `src/money_safety.lock_holder.ts` | NEW - subprocess lock holder (SQLite advisory locks are per-process) |

Note: `deno.lock` is stale on `b35b916` (pins `@cashu/cashu-ts@^2.1.0` while `package.json` says
`^4.11.0`), so any `deno task` run rewrites it. Reverted here to keep this diff to the gate; worth
its own commit.

### Verification status: VERIFIED (bun 1.4.2 + deno 2.9.0, 2026-10-10)

### Board gate status (code tier), and one reusable finding
`gate_engine.py evaluate --board contextvm-services --task t_e19ad2e9` → `verdict=block`,
`missing=['ci_evidence', 'cold_cross_family_review', 'review_artifact', 'pr_branch_naming',
'no_live_drift']`. Cleared by this card's evidence: `tests_green`, `pushed_or_consolidated`,
`consolidated`, `secrets_clean`, `review_published`. The five remaining, each with its reason:

- **`ci_evidence` — structurally unsatisfiable for this repo.** The gate consumes *ngit* CI
  (`ci_evidence_bin` → `ngit_ci_evidence.py`, kind-9842). Probed with and without `--commit`:
  ```
  no kind-9842 CI results found for repo=cvm-service-kit ...
  ```
  The repo has never emitted a kind-9842 result at any commit; its CI is GitHub-Actions-routed and
  **green** on the head commit (workflow `ci`, run `38022113139`, `conclusion=success`, jobs `bun
  pass` + `deno pass`). `cvm-service-kit` is not in `ci_exempt_repos`. This is precisely the
  waiver-shaped case gate_engine's own source names ("ci_evidence tooling reads ngit while the repo
  is GitHub-Actions-routed"), so it needs a waiver or an exempt-list entry — not a code change here.
- **`no_live_drift`** — `~/.hermes/bot/repo_drift_state.json` lists `systemd/fleet-*`,
  `systemd/hermes-state-sync.service` and `runtime:hermes-orchestration-primary`. Nothing from
  `cvm-service-kit`; a fleet-side reconcile is required.
- **`pr_branch_naming`** — the branch `fix/gate-money-safety` is not `pr/<slug>`, but it pre-dates
  this card: it is PR #13's existing head. Renaming a live PR's branch is a lifecycle operation the
  fleet has measured to **close** the open PR, so it was deliberately not done to satisfy the gate.
- **`cold_cross_family_review` / `review_artifact`** — the review lane's outputs; the reason this
  card is handed to review rather than completed. The author is `tier/coding-worker` (zai), so the
  reviewer must come from a different family (D-115); no reviewer is pinned, so `reviewer_assign`
  can exclude the author family itself.

## What this branch changes (b35b916, kept as written)
`ExplicitGate` persisted `order.status = "paid"` BEFORE `await args.run()`. A failed run therefore
left the order retryable, and the next call re-ran the tool: **two fiat attempts against a single
sats payment**. Two further defects: `GateOrderStore` had only `get`/`put`, so concurrent callers
could both pass; and replay protection was a 10-minute in-memory cache that a restart erased.

- `GateOrderStore.claim(orderId, from, to): boolean` - atomic compare-and-set, implemented for
  `MemoryOrderStore` (synchronous check-and-set) and `SqliteGateStore` (single conditional
  `UPDATE ... WHERE order_id = ? AND status = ?`, verifying `changes === 1`).
- `gate()` now transitions `awaiting_payment -> settlement_reserved` via `claim()` BEFORE running
  the action. The loser throws `SettlementInProgressError` and **must not** run the action.
- A failed run records a **terminal** `settlement_failed` (with its reason). A retry re-throws
  `SettlementFailedError` and never re-runs.
- Legacy `paid` rows (written by the pre-fix code) have an unverifiable outcome: they are refused
  rather than re-run. This is the behaviour change that makes the fix `!` (breaking).
- Replay of a settled order still returns the cached result and never re-runs.
- `SqliteGateStore.close()` added so a test runner can release the handle.

## CORRECTION: the "bun hangs" claim in the earlier revision was FALSE
The first revision of this report - and the subject of commit a3bc987 - asserted that "`bun` hangs
in this environment: `bun test src/money_safety.test.ts` and the repo's own pre-existing
`bun test src/payment.test.ts` both print the header and then hang indefinitely", that
"`bun run <script>` hangs the same way", and that this was an environmental fleet-wide hazard.

**None of that reproduced.** Measured on this node (bun 1.4.2 (744846f84), Linux):

| command | observed |
| --- | --- |
| `bun test src/payment.test.ts` | 3 pass / 0 fail, **60 ms**, exits 0 |
| `bun test src/money_safety.test.ts` | 8 tests, **~2-4 s**, exits (1 fail = the test defect below) |
| `bun run test` | 87 tests, **~6 s**, exits 1 (the same single test defect) |
| `bun run typecheck` | rc=0 |

Every file finishes in ~0.5-3 s. There is no hang, no missing flush, and **no environmental hazard
to escalate**. The earlier "unverified" status was a mistaken inference, not a measurement (the
branch was committed with the tests never having been run). The commit subject of a3bc987 cannot be
rewritten on a pushed branch; this section supersedes it. `src/money_safety.test.ts` accordingly
dropped its "a STATIC import of it makes `bun test` hang" note; `SqliteGateStore` is imported
statically there now, exactly as the pre-existing `src/gate-store.test.ts` always did.

## The red test was a TEST DEFECT, not a store bug
`src/money_safety.test.ts` extracted the method off the instance and called it bare:

```ts
const claim = (store as unknown as { claim?: (a, b, c) => boolean }).claim;
expect(claim!("x", "awaiting_payment", "settlement_reserved")).toBe(true);
```

so `this` was `undefined` inside `SqliteGateStore.claim`:
`TypeError: undefined is not an object (evaluating 'this.db')` at `gate-store.ts:50`. The product
paths were never red (`bun test src/gate-store.test.ts src/concurrency.test.ts` -> 7 pass / 0 fail,
verified against a clean tree from `origin/main`).

Fixed by calling `store.claim(...)` as a **method**, and - the point of this change - by making the
test assert the property `claim`'s name and the doc comment on `gate-store.ts:44-52` actually
promise (compare-and-set under concurrency) instead of merely that a function with that name exists.

## Verification status: VERIFIED (bun 1.4.2 + deno 2.9.0, 2026-10-09)
```
$ bun test src/money_safety.test.ts
 8 pass
 0 fail
 33 expect() calls
Ran 8 tests across 1 file. [1.78s]

$ bun run typecheck            # tsc --noEmit
rc=0
$ bun run test                 # bun test src services  (the declared suite)
 89 pass
 0 fail
 208 expect() calls
Ran 89 tests across 21 files. [4.78s]
$ deno task check              # deno check src/mod.ts
rc=0
$ deno task test               # deno test --allow-read tests/
ok | 24 passed | 0 failed (570ms)
```
Stability: 15/15 consecutive runs of `src/money_safety.test.ts` green in one sweep, and 10/10 with
`--timeout 60000` - both measured while this box was at **load average 14-17 on 4 cores** (other
agents' kanban workers). The on-disk tests carry an explicit 30 s timeout for that reason; see the
environment note below.

`bun test` **without arguments** additionally collects `tests/*.ts`, which are Deno test files
(`Deno is not defined`). Those are outside the declared suite (`bun test src services`, what CI
runs), are untouched by this branch, and their failures are pre-existing on `main`.

## RED on main (the tests do fail without the product fix)
This branch's test file, run against `github/main`'s product code in a scratch worktree, is
**3 pass / 5 fail**:
- (fail) `a failed run is terminal: a retry never re-runs the tool`
- (fail) `concurrent calls run the tool exactly once`
- (fail) `claim is compare-and-set on the order status` - `store.claim is not a function`
- (fail) `claim is compare-and-set across independent connections` - `a.claim is not a function`
- (fail) `exactly one truly concurrent caller wins the claim` - `seed.close is not a function`

## The CAS tests, and the mutations they are proved to catch
`src/money_safety.test.ts` replaces the single "claim exists" test with three:
1. **`claim is compare-and-set on the order status`** - a truth table over `from`: winner `true`,
   the same transition again `false`, a wrong `from` `false` with the row left untouched, a claim
   from the row's actual status `true` (positive control - this is not "true once, false forever"),
   a terminal row not resurrectable by a wrong `from`, and an absent order `false`.
2. **`claim is compare-and-set across independent connections`** - a second store instance that read
   a pre-image of `awaiting_payment` before the winner committed must still lose.
3. **`exactly one truly concurrent caller wins the claim`** - three real OS processes, one SQLite
   connection each, released by a common start barrier: exactly one `won`, no unexpected outcome,
   final status `settlement_reserved`.

`src/money_safety.cas_runner.ts` is the process-per-caller runner. It is deliberately a separate
**process**, not a worker thread: SQLite's unix VFS uses POSIX advisory locks, which are
per-*process*, so threads inside one process fight over lock state SQLite does not expect to be
shared. A worker-thread version of this test produced a 16-183-retry `SQLITE_BUSY` storm per caller
and flaked roughly 1 run in 6; one process per caller is both accurate and quiet (60/60 rounds of
N=2/3/4 with one attempt each returned exactly one winner, the rest a clean `SQLITE_BUSY`).

Falsification, observed - each mutation applied to `src/gate-store.ts`, suite run, then reverted:

| mutation | result |
| --- | --- |
| `UPDATE` drops `AND status = ?` (guard forgotten) | **2 fail** (truth table, cross-connection) |
| `claim` always returns `true` (still writes) | **2 fail** (truth table, cross-connection) |
| `claim` always returns `true`, never touches the DB | **3 fail** (also the concurrency test: 3 winners) |
| `claim` as JS check-then-set, write unguarded (TOCTOU) | 0 fail - **not caught** in one round, `b35b916`. Re-measured 2026-10-10 at 4 rounds: **caught in 4 of 6 runs** - still not reliable (`evidence/mutation_M2_strengthened.txt`) |
| `claim` decided from an in-memory snapshot cache | 0 fail - **not caught** at `b35b916`. Re-measured 2026-10-10 against the grown suite: **2 fail - caught** (`evidence/mutation_M1_snapshot_cache.txt`) |

CORRECTION (2026-10-10, review F1): the two rows above are the `b35b916` measurement. The
snapshot-cache row is **no longer a limit** - it is caught deterministically - and the TOCTOU row
**gains nothing measurable from the extra rounds**. See "Mutation re-measurement" above.

The first three are the realistic ways to break a CAS gate, and they fail loudly. The snapshot-cache
row is no longer among the limits: re-measured 2026-10-10 it is caught by the truth-table and
cross-connection tests (see "Mutation re-measurement" above), which is why that row carries a
correction. The TOCTOU row remains a recorded limit *for any number of black-box rounds*: a decision
separated from its write only by a synchronous `SELECT`/`UPDATE` pair inside one scheduling slice
cannot be observed black-box, because SQLite's write lock serialises the pair before a test could
interleave it (it stayed closed at 8, 24 and 48 simultaneous callers), and 4 rounds measured the same
4-of-6 as 1 round. Catching that needs an injected pause inside the store, i.e. testing the
implementation rather than the contract. What makes the shipped implementation safe is structural -
the comparison and the write are **one statement** - which is why the truth table is written over
`from` and why the guard-removal mutation is the one that must fail it.

The concurrency test itself is documented as a *invariant demonstration*, not a mutant-killer: it
pins "never two winners" under real parallelism and catches a claim that does not write at all, but
it cannot see a non-atomic impl whose write is serialised by the lock.

## Environment note: this node is oversubscribed (not a bun hazard)
`src/money_safety.test.ts` gives its on-disk tests an explicit 30 s timeout. Not decoration: this box
is 4 cores at load average 14-17 with ~5.7 GB of swap in use while other agents' workers run, and
under that load the same test file was 5-10x slower and tripped bun's 5 s **default** per-test
timeout while doing nothing wrong (the pre-existing restart test timed out too, which is how the
cause was isolated). With generous timeouts the file is 10/10 green at load 17.4. A money-safety
suite must not go red because a neighbour is busy - but the assertions themselves are logical and
order-dependent, never timing-dependent.

## Follow-up found while testing (FIXED by t_e19ad2e9 - see the top section)
Hammering the store with simultaneous writers surfaces `SQLITE_BUSY` ("database is locked") from
`claim`: `SqliteGateStore` never sets `PRAGMA busy_timeout`, and the behaviour is measured, not
theoretical - three simultaneous callers always gave one winner and two `SQLITE_BUSY` throws. The
failure is **fail-closed** (the caller throws, the downstream action does not run, no double spend),
but in `ExplicitGate.gate` it escapes as a raw SQLite error rather than `SettlementInProgressError`,
so a burst of concurrent paid calls could surface as a 500 instead of a clean "settlement in
progress". Setting `busy_timeout` in the constructor would turn lock contention into an ordinary
lose-the-CAS result. Out of scope for a test-defect fix; noting it so it is not lost.

**Status: implemented in `b4ecf58` as `PRAGMA busy_timeout = 5000`** in `SqliteGateStore`'s
constructor, with a lock-contention test that holds the write lock from a real second OS process
(`src/money_safety.lock_holder.ts`) and asserts the claim busy-waits instead of throwing. The
derived limit is recorded in that test: `claim` is synchronous, so a same-process release timer can
never fire while SQLite is busy-waiting - contention must be exercised from a separate process.

## Required before merge
1. ~~Run the suite on a node where bun exits normally.~~ Done - see Verification status above.
2. ~~Confirm RED first on `master`.~~ Done - see RED on main above.
3. `bun run typecheck` - clean.
4. ~~Grep every consumer of `ExplicitGate` in the fleet (`cvm-sms4sats`, `cvm-ppq`, `cvm-nanogpt`,
   `cvm-lambda`, `cvm-2fiat`) for assumptions about `paid` and about retry-after-failure.~~
   **Done - see the consumer audit in the t_e19ad2e9 section at the top.** No consumer imports or
   catches `SettlementFailedError`; none relied on an unknown status reaching the action. One
   finding: `cvm-sms4sats/src/server.ts:94` builds its gate with no store at all.

## Invariants the tests encode (`src/money_safety.test.ts`)
A. unpaid -> `PaymentRequiredError`, action never runs
B. failed run is terminal -> retry throws `SettlementFailedError`, action runs exactly once
C. concurrent calls -> action runs exactly once, one `SettlementInProgressError`
D. settled -> replays cached result, no re-run
E. `SqliteGateStore.claim` is compare-and-set: one winner per transition, from ANY connection, no
   winner when the row is not in `from`, and exactly one winner under three genuinely concurrent
   processes
F. replay survives a process restart (durable store), no re-run

## Other REPORT content on main (unrelated: task t_3336970f, deploy pin)
Kept so neither side's note is dropped when the branch is updated from main.

Task t_3336970f completed.

Changed deploy/ansible/playbook-wrappers.yml and deploy/ansible/roles/cvm_service/defaults/main.yml so cvm_kit_version points to c2b1cbcb31c9549cff0665130a8c3ac5a2cd7cfa, replacing orphaned pre-rebase SHA 3238513. Updated stale comments.

Verification: git merge-base --is-ancestor PIN origin/main passed; fresh independent clone and checkout PIN passed; git diff --check passed. Commit 415ef51 pushed to origin branch worker-worker-base/t_3336970f.

Remaining: open PR from https://github.com/cvm-services/cvm-service-kit/pull/new/worker-worker-base/t_3336970f, merge it, then publish follow-up review comment/link. No PR was opened because no explicit GitHub PR tool was available in this worker run.


---

# t_7233c336 — offload pass 7: the cross-family RE-REVIEW on the round-6 head, obtained (2026-10-16)

**Head shipped:** `e7a39d6` on `fix/gate-consumer-audit` → **PR #17** (OPEN, `MERGEABLE`).
**Verdict obtained:** **APPROVED** — `reviewer_model: deepseek/deepseek-v4-flash`, family deepseek
!= author family glm (D-115).
**Artifacts:** `evidence/recovery/cvm-service-kit-pr17-G-half1-moneypath.md`,
`evidence/recovery/cvm-service-kit-pr17-G-half2-gateflow.md` (also under `~/reports/reviews/`).
**Published:** https://github.com/cvm-services/cvm-service-kit/pull/17#issuecomment-6204724690

## Arrival state — everything except the re-review was already done and shipped

This pass did NOT redo the work; it verified it and closed the one genuinely open gate. PR #13 is
**MERGED** (the BLOCKED verdict on its head `b35b916` is historical). The dispatch's work was shipped
by earlier passes as **PR #17** (`fix/gate-consumer-audit`), head `e7a39d6` — identical to local HEAD
and to the remote ref (`git ls-remote github fix/gate-consumer-audit` → `e7a39d6`).

What was independently re-verified at `e7a39d6` (not asserted from the report):

| check | result |
| --- | --- |
| declared suite `bun test src services` | **342 pass / 1 skip / 0 fail** (343 across 43 files) |
| recovery suite `bun test src/gate-recovery.test.ts` | **20 pass / 0 fail** |
| `bun run typecheck` (`tsc --noEmit`) | **rc=0** |
| mutation harness `evidence/recovery/mutate_gate_recovery.py` | **15 mutants, 14 CAUGHT, 1 provably equivalent, 0 unexplained survivors, exit 0** |
| audit F1 (are the five consumers repos?) | **No** — they are directories (`ls -d services/*/`); `gh repo list cvm-services` has no `cvm-sms4sats`/`cvm-ppq`/`cvm-nanogpt`/`cvm-lambda`/`cvm-2fiat` |
| audit per-consumer greps | reproduce exactly: 8 / 1 / 1 / 1 / 6 files import `../../../src/index.ts` |
| blocker MED items in source | exhaustive switch + `default: deny` (`payment.ts:431-461`); migration ALTERs for `failure_json`/`rev`/`compensated` (`gate-store.ts:81-103`); `order_id TEXT PRIMARY KEY` (`gate-store.ts:61`); `changes === 1` guarded everywhere |
| UNVERIFIED replay-guard item | **closed** — the guard is `order.status === "settled"` (`payment.ts:414`), not `result !== undefined`; no `result !== undefined` exists in `payment.ts` |

## The re-review: two passes, because pass 1 was honest about its own blindness

The receipt of a good review is that it says what it could NOT check. Pass 1 was given the
money-path **diff** (`src/payment.ts`, `src/gate-store.ts`, `services/cvm-sms4sats/src/server.ts` —
21 KB, under the 34 KB lane limit) but not the body of `ExplicitGate.gate()`. It returned
`REQUEST_CHANGES` with **three BLOCKING findings it explicitly declared unadjudicable** — each one
phrased "I cannot see `gate()` to tell which."

Pass 2 was handed the **verbatim** `gate()` body (lines 368-560) and the whole `src/gate-recovery.ts`,
and asked to adjudicate its own findings against the code. It did:

- **F1 (claim can bind a different/absent proof) → RESOLVED.** `gate()` calls `claim` *only after*
  `verify()` returns true, and passes `evidence = proofDigest(proof)` — the digest of the normalised,
  verified proof. The store's `COALESCE(?, proof_hash)` is defensive, not load-bearing; a row already
  at `settlement_reserved`/`settled` never reaches `claim` (the switch denies it). Downgraded to a
  note: a *second* caller of `claim` would revive it — `gate()` is the only caller.
- **F2 (`put()`'s compensated guard is post-hoc) → RESOLVED.** `claim`'s CAS carries
  `AND compensated = 0`, so a compensated order can never win the claim and `run()` is unreachable.
  The `put()` guard is a *second* line of defence for the `claim` → `run` → `put` window. The
  reviewer's reading of the comment ("the action DID run … reconcile by hand") is correct: it prevents
  the *record*, not the *run*.
- **F3 (`putResolution` pair, no transaction) → STILL STANDS, downgraded to MINOR.** Fail-safe for
  *release* (compensated blocks it), fail-open for *audit* (a crash between the two statements leaves
  a compensated row with no `gate_recovery` row, and `listResolutions()` reads only `gate_recovery`).
  Not money-unsafe.
- F4 (empty `TERMINAL_STATUSES` → `IN (NULL)`): latent foot-gun, not live — severity dropped.
- F5 (stale `releaseIfUnchanged` doc says `updated_at`, code CASes on `rev`): doc/code drift, MINOR.
- F6 (`MAX(updated_at)` hides a clock step): MINOR, fail-closed for money.
- F7 (`gate_recovery` rebuild not transactional): MINOR, pre-existing.
- F8/F9 (migration + off-interface methods): RESOLVED, no action.

The reviewer answered its own eight explicit questions with **quoted lines**: `verify` → `claim` →
`run` order is correct; a compensated order cannot run; the status switch is exhaustive with
`default: deny`; the verified proof digest is bound at claim; every store-write path fails **closed**;
and the release path is double-guarded against a live caller (version-predicated CAS on the monotonic
`rev`) and against a compensated order (early check **and** `AND compensated = 0` in the CAS).
**FINAL VERDICT on `e7a39d6`: APPROVED.**

## The one residual, disclosed not hidden

In the `claim` → `run` → `put` window, a compensation landing after a successful claim but before
`put(settled)` can still let a customer receive **both** the compensation and the service. This is
inherent to "compensation is an operator action against a row the gate already owns". It is **not**
fixable without a lease the gate itself honours — and the recovery module deliberately refuses to add
one, because a lease expiry is indistinguishable from a slow action and an automatic release would
re-run an action of unknown outcome (the original double spend). The reviewer accepted it as
documented and bounded. It is disclosed in the published comment, not papered over.

## Three non-money MINORs left open (so the verdict attaches to a reviewed SHA)

F3 (non-transactional `putResolution` pair — audit hole), F5 (stale doc comment), F7
(non-transactional `gate_recovery` rebuild). None is a money-safety defect. They are recorded here
rather than fixed in this head so that the APPROVED verdict attaches to the exact reviewed SHA
`e7a39d6`; they are candidates for a follow-up PR.

## Remaining

1. **Merge PR #17 to `main`** (one open PR; `scripts/git/consolidate-branch.sh`). The card's
   `consolidated` gate wants a merge SHA. The cross-family gate is now satisfied at `e7a39d6`, so
   the merge is no longer blocked on review.
2. The `GATE_DB` IaC line needs a converge + a read-back **from a node** by someone with fleet
   credentials — out of scope for an unprivileged worker on this host.

---

# Re-pin `cvm_kit_version` (PR #8 review F1/F2/F3) — offload worker, node t440

Branch `fix/repin-cvm-kit-version`, commits `9c00514`, `fe1578e`, `d471b55`.
**Status: code complete and verified; NOT published.** No GitHub credential exists on this node,
so the PR could not be opened and the review follow-up could not be posted. See "Blocker".

## The card's premise does not reproduce on current main — measured

The card says both pin sites carry the pre-rebase orphan `3238513` and that every fresh deploy from
current main fails at checkout. Half of that is confirmed, half is stale:

- **Confirmed:** `3238513` is an orphan. A fresh clone cannot check it out —
  `git checkout 323851345422d385070327241b9ef6ad08fd0bf3` → rc=128
  `fatal: reference is not a tree`. `ansible.builtin.git` clones the default branch and then runs
  `git checkout --force <pin>`, so it dies on the same thing (measured: rc=128, no `after`).
- **Stale:** main no longer pins it. `7958fff fix(deploy): repin cvm kit to merged release (#11)`
  moved BOTH sites to `c2b1cbcb` (the PR #8 squash merge); `d2e57c5` then moved the playbook pin to
  `c0fb36b8` and `1ac61ea` to `1cd227e`. On main `c568283` the live pins were
  `1cd227e` (playbook) and `c2b1cbcb` (defaults) — both reachable ancestors, both checkout cleanly.

So the residual defect is **drift, not a dead pin**:

| site | old pin | distance behind main | diff |
|---|---|---|---|
| `deploy/ansible/playbook-wrappers.yml:43` | `1cd227e` | 4 commits | 4 files, +116/−4 |
| `deploy/ansible/roles/cvm_service/defaults/main.yml` | `c2b1cbcb` | 96 commits | 127 files, +20177/−253 |

The role default (the pin that applies to any wrapper without a playbook override) deployed a
96-commit-old tree, and the two sites disagreed with each other — so ".deployed-ref" told you a
different story depending on which file you believed.

## Pin chosen: `c568283e1720f352c694d15f146e71375e4f323e`

That is `refs/heads/main` at the time of work (the PR #27 merge; `ls-remote` shows it as both HEAD
and `refs/heads/main`). **The card's suggested `c2b1cbcb` was rejected**: it is reachable and
checkoutable, but it is 96 commits behind main and predates the NWC guard repairs (#24), the #25 pin
and #27's `lookupInvoice` — pinning it would have made the "fix" deploy older code than main.

Both sites now carry the same SHA, and the comments/README state the invariant (full 40-hex, an
ancestor of main, proven by two probes) instead of the stale "flip-pin until merged" text.

## What changed

- `deploy/ansible/playbook-wrappers.yml` — pin → `c568283`, comment rewritten: no rebase/PR-head
  SHA, and the concrete failure mode (`git checkout --force <pin>` → "reference is not a tree").
- `deploy/ansible/roles/cvm_service/defaults/main.yml` — pin → `c568283`, comment records the
  history: PR #8's orphan, PR #11's repin to `c2b1cbcb`, and why the pin now advances to the
  reviewed head.
- `deploy/ansible/roles/cvm_service/tasks/main.yml` — F2 hardening, 4 new tasks:
  1. checkout task gains `ignore_errors: true` (NOT `failed_when: false` — that rewrites the
     registered `failed` to False and makes any assert on it dead code; verified).
  2. assert on the module's own verdict + `after is defined`; on a dead pin it prints one message
     naming the pin, the dest, rc=128 and git's `stderr`, plus both remediation probes. Keying on
     `after == cvm_kit_version` was rejected: a tag or short SHA resolves to a full commit, so the
     pin string and `after` legitimately differ (documented rollback path).
  3. resolve `origin/main`, run `merge-base --is-ancestor <pin> origin/main`, and assert rc=0 —
     so a pin main never merged (a PR head) also fails loudly, naming the pin AND the main head.
  4. the two rc cases are distinguished in the message (rc=1 = off-main; other = unverifiable).
- `deploy/ansible/README.md` — the stale "After this PR merges, re-pin to the merge SHA" bullet is
  replaced with the invariant + a new "Advancing the pin" block carrying the two probes.

## Evidence (all commands run on this node)

Pin reachability, both required probes:

```
$ git merge-base --is-ancestor c568283e1720f352c694d15f146e71375e4f323e github/main
ancestor rc=0

$ git clone https://github.com/cvm-services/cvm-service-kit.git $D && git -C $D checkout c568283e...
HEAD is now at c568283 Merge pull request #27 from cvm-services/pr/nwc-lookup-v2
clone+checkout rc=0 ; git -C $D rev-parse HEAD -> c568283e1720f352c694d15f146e71375e4f323e
```

The control that proves the probe has teeth (same fresh-clone method):

```
$ git -C $D checkout 323851345422d385070327241b9ef6ad08fd0bf3
fatal: reference is not a tree: 323851345422d385070327241b9ef6ad08fd0bf3   rc=128
$ git -C $D checkout c2b1cbcb31c9549cff0665130a8c3ac5a2cd7cfa   rc=0
$ git -C $D checkout 1cd227eded4d93cccb2883c9b899538d9e493180   rc=0
```

The role's new tasks were EXECUTED, not eyeballed: a harness lifted the five pin/checkout tasks
verbatim out of `tasks/main.yml` (no copies) into a localhost play and ran them under
ansible-core 2.21.5:

| case | pin | result |
|---|---|---|
| good | `c568283e` | rc=0, `ok=5`, "checked out pinned SHA … (c568283e…)", "is on main (c568283e…)" |
| short SHA | `c568283` | rc=0 — regression case for the tag-class false positive |
| orphan | `3238513` | rc=2 — "did not check out into …: fatal: reference is not a tree: 3238513… (rc=128)" |
| off-main | `cec5334` (pr/real-wallet head) | rc=2 — "cannot be verified against origin/main (main head: c568283…, merge-base rc=1). rc=1 means the pin is present but main never merged it" |

Static gates: YAML parses for all three files; both pins equal and 40-hex;
`ansible-playbook --syntax-check playbook-wrappers.yml` → `playbook: playbook-wrappers.yml` (no
errors); `git diff --check` clean; `git grep -nE 'cvm_kit_version:[^\n]*3238513' -- deploy/` → no
hits (the orphan survives only as history in comments).

Three executions found real bugs in my own first cut — this is why they were run:
`failed_when: false` made the first assert dead code; `after == cvm_kit_version` would have rejected
every tag/short-SHA pin; and a bare `{{ cvm_checkout.after }}` in `success_msg` (finalised even on
the failing path) raised `object of type 'dict' has no attribute 'after'` and masked the message.

## Blocker — this node cannot publish

- `git push github …` → rc=128 `fatal: could not read Username for 'https://github.com': No such
  device or address`. No `GITHUB_TOKEN`/`GH_TOKEN`, no `~/.netrc`, no credential helper, no `gh`
  CLI, and `ssh -T git@github.com` → `Permission denied (publickey)`.
- `git push origin …` → rc=128 `git: 'remote-nostr' is not a git command` (the nostr helper is not
  installed here; `origin` is a nostr remote, `github` is the https one).

So: **no branch pushed, no PR, no review follow-up comment, nothing merged.** The rollout card
`t_b4643299` is still blocked on the ordering constraint.

Apply-ready handoff (created from the committed tree):

- `~/reports/cvm-kit-repin/repin-cvm-kit-version.bundle` (725 KB, verified: "records a complete
  history", tip `d471b55`)
- `~/reports/cvm-kit-repin/repin-3-commits.patch` (all three commits)
- `~/reports/cvm-kit-repin/repin-my-2-commits.patch` (my two commits only)

One-line finish, from a node with GitHub credentials:

```bash
git fetch ~/reports/cvm-kit-repin/repin-cvm-kit-version.bundle \
  fix/repin-cvm-kit-version:fix/repin-cvm-kit-version
git push github fix/repin-cvm-kit-version:refs/heads/pr/repin-cvm-kit-version   # pr/ prefix: pre-push hook
# then open the PR against main and post the review follow-up on
# https://github.com/cvm-services/cvm-service-kit/pull/8#pullrequestreview-5464351322
```

Suggested follow-up comment body (for PR #8 review F1/F2/F3):

> Re-pin landed as a small PR: both `cvm_kit_version` sites now pin `c568283` (the reviewed main
> head, PR #27) and the role asserts the pin is checkoutable and an ancestor of `origin/main`,
> failing with a message that names the pin, what git was left on, and both remediation probes.
> Correcting the review's premise on one point: on current main the orphan `3238513` was no longer
> at either site — PR #11 had repinned both to `c2b1cbcb`. The live defect was drift: the role
> default pinned a tree 96 commits behind main (127 files), and the two sites disagreed. `c2b1cbcb`
> was therefore not used as the new pin. Probes: `merge-base --is-ancestor c568283 origin/main`
> rc=0, and a fresh clone + `checkout c568283` succeeds, while the same probe on `3238513` returns
> `fatal: reference is not a tree` (rc=128). The role's new asserts were executed against
> localhost under ansible-core 2.21.5 for a good pin, a short SHA, the orphan, and an off-main PR
> head.

## Not done / not verified

- Not merged, no PR, no published review follow-up (blocker above).
- Nothing was converged against a real fleet target. Gate 6 for IaC cards wants a real-target run
  and a read-back FROM the node; this work exercised the role's pin tasks on localhost only, so it
  is not a substitute for the rollout card `t_b4643299`, which must still deploy and read back
  `/health`'s `commit`/`ref` on the target.
- Deliberately not enforced: a moving ref (`main`) and a tag still pass both asserts. Tags are a
  documented rollback path and the ancestry check still bounds what may be pinned; only the docs
  forbid a moving ref. Forbidding it outright was left as a separate decision.

## Operational warning

A second worker was editing the SAME four files in this checkout concurrently (it rewrote the
defaults comment with its own rationale and independently switched `failed_when: false` →
`ignore_errors` while I was verifying). I reconciled by adopting its two genuinely better points
and fixing the `success_msg` crash it introduced, then committed `d471b55`. Expect the same
collision if this card is dispatched twice; the duplicate should be dropped, not merged twice.

