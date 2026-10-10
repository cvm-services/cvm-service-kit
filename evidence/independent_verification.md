# Independent verification — card t_5b30bdec (settled-replay proof binding)

The authoring run of this card crashed (signal 15, 1006 s, captured by
`kanban-crash-wrapper`, comment on the card) *after* committing `3c65009` but
before pushing or reporting. This file is the re-verification of that commit by
the resuming run: nothing below is taken from the authoring run's own evidence —
each item was re-executed.

| item | command | result |
|---|---|---|
| RED on main | `bun run evidence/replay_proof_binding.red.ts` in a **detached worktree at `e2a7065`** | every replay **RETURNED** the cached result — F4 reproduced independently |
| GREEN on the fix | same probe in this worktree | every mismatched replay **REFUSED** `SettlementEvidenceMismatchError`; same-proof replay still returns the cached result |
| mutation | `assertReplayedEvidence(...)` commented out, `bun test src/replay_binding.test.ts`, source restored | **8 pass / 6 fail** (guard is load-bearing); `restored identical: True` |
| suite | `bun run test` | **235 pass / 1 skip / 0 fail**, 236 tests / 36 files |
| types | `bun run typecheck` | `tsc --noEmit` exit **0** |

Raw transcripts: `replay_proof_binding.red.rerun.txt` (main, pre-fix),
`replay_proof_binding.fixed.rerun.txt` (this branch). The authoring run's
originals (`replay_proof_binding.red.txt`, `.fixed.txt`, `.mutation.txt`,
`.suite.txt`) are unchanged in `3c65009` and agree with these reruns.

Environment: bun 1.4.2. The `e2a7065` worktree was removed after the run
(`git worktree remove`), so no verification artifact is left outside this task's
worktree.

## Round 2 (after the cross-family review returned REQUEST_CHANGES, 7 findings)

Fixes for F1/F5/F6/F7 and the F2/F3 behaviour pins were committed as `f59412f`
(pushed to github + ngit/`origin`, verified with `git ls-remote` on both).

| item | command | result |
|---|---|---|
| targeted | `bun test src/replay_binding.test.ts` | **23 pass / 0 fail**, 75 `expect()` calls |
| suite | `bun run test` | **244 pass / 1 skip / 0 fail**, 245 tests / 36 files |
| types | `bun run typecheck` | `tsc --noEmit` exit **0** |
| deno | `deno task check` / `deno task test` | exit **0** / **24 passed, 0 failed** |
| mutation M1 (`MemoryOrderStore.put` back to an unconditional set) | `python3 /tmp/t5b30_mutation2.py` | **2 fail** — the F1 test is load-bearing |
| mutation M2 (F4 settle-path round-trip check removed) | same | **1 fail** |
| mutation M3 (`presentedProof` coerces non-strings) | same | **1 fail** |
| mutation M4 (per-case refusal reasons restored) | same | **1 fail** |

Raw transcript: `replay_proof_binding.mutation_round2.txt`. Note on M3: it was
NOT caught by the first version of the F5 test (which used a processor that
already rejects unknown strings, so it could not tell coercion from rejection);
the test was rewritten against a coercing processor and M3 then failed. That is
recorded because a mutation run that catches nothing is itself a finding.

