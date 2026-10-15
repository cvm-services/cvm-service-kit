# Evidence for t_e19ad2e9 (gate money-safety) and t_7233c336 (recovery path)

Raw, unedited command output. Each file starts with the command, the tree it ran in and the commit,
so it can be reproduced. All of it was produced on this node with bun 1.4.2 and deno 2.9.0 on
2026-10-10; nothing here is a summary written after the fact.

| file | what it shows |
| --- | --- |
| `red_main.txt` | The card's tests against PRE-FIX product code (`github/main` @ `7958fff`): **3 pass / 5 fail**, including two `Expected: 1 / Received: 2` - the downstream action ran twice against one payment. This is the RED-before proof. |
| `mutation_M1_snapshot_cache.txt` | Mutation: `claim` decides from a status snapshot cached by `put()`/`get()`. **2 fail - caught.** |
| `mutation_M2_snapshot_pre_read.txt` | Mutation: `claim` reads the row and only then writes it unguarded (TOCTOU shape), against the ORIGINAL single-round concurrency test. **Caught in 4 of 6 runs** - i.e. a single round is not a reliable detector. |
| `mutation_M2_strengthened.txt` | The same mutant against the strengthened (4-round) concurrency test: **caught 4 of 6 runs** - the SAME rate as one round, i.e. the extra rounds show no measured improvement. (Corrected 2026-10-10: this row previously read "6 of 6", which the log itself refutes - runs 4 and 5 are `13 pass / 0 fail`. See `../REPORT.md`, "Mutation re-measurement".) |
| `suite_bun.txt` | `bun run test` = 172 pass / 1 skip / 0 fail across 31 files; `bun run typecheck` rc=0. |
| `suite_deno.txt` | `deno task check` rc=0; `deno task test` ok \| 24 passed \| 0 failed. |
| `deno_scope.txt` | What the deno tasks actually cover (`src/mod.ts` does NOT re-export the changed files), an explicit `deno check` of the changed files (rc=0), and a NEGATIVE CONTROL proving deno really does report type errors there (`TS2322`, rc=1). |

## `evidence/recovery/` - t_7233c336, the operator recovery path

| file | what it shows |
| --- | --- |
| `recovery_tests.txt` | `bun test src/gate-recovery.test.ts` = **6 pass / 0 fail**, rc=0. |
| `suite_bun.txt` | `bun run test` = **231 pass / 1 skip / 0 fail across 37 files**, rc=0. |
| `typecheck.txt` | `bun run typecheck` (`tsc --noEmit`) rc=0 over the new modules. |
| `deno_check.txt` | `deno task check` rc=0 plus an explicit `deno check` of `gate-recovery.ts`, `gate-recovery-cli.ts`, `gate-store.ts`, `payment.ts` rc=0 (`src/mod.ts` does not re-export them). |
| `cli_smoke.txt` | The command really runs: no-arg usage exits **2**; `list --db <empty>` prints `no stuck orders` and exits **0**. |

The full prose write-up for the recovery path lives in `../REPORT.md`, section
"t_7233c336 (2026-10-10)".
