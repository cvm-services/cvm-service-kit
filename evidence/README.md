# Evidence for t_e19ad2e9 (gate money-safety)

Raw, unedited command output. Each file starts with the command, the tree it ran in and the commit,
so it can be reproduced. All of it was produced on this node with bun 1.4.2 and deno 2.9.0 on
2026-10-10; nothing here is a summary written after the fact.

| file | what it shows |
| --- | --- |
| `red_main.txt` | The card's tests against PRE-FIX product code (`github/main` @ `7958fff`): **3 pass / 5 fail**, including two `Expected: 1 / Received: 2` - the downstream action ran twice against one payment. This is the RED-before proof. |
| `mutation_M1_snapshot_cache.txt` | Mutation: `claim` decides from a status snapshot cached by `put()`/`get()`. **2 fail - caught.** |
| `mutation_M2_snapshot_pre_read.txt` | Mutation: `claim` reads the row and only then writes it unguarded (TOCTOU shape), against the ORIGINAL single-round concurrency test. **Caught in 4 of 6 runs** - i.e. a single round is not a reliable detector. |
| `mutation_M2_strengthened.txt` | The same mutant against the strengthened (4-round) concurrency test: **caught 6 of 6 runs.** |
| `suite_bun.txt` | `bun run test` = 172 pass / 1 skip / 0 fail across 31 files; `bun run typecheck` rc=0. |
| `suite_deno.txt` | `deno task check` rc=0; `deno task test` ok \| 24 passed \| 0 failed. |
| `deno_scope.txt` | What the deno tasks actually cover (`src/mod.ts` does NOT re-export the changed files), an explicit `deno check` of the changed files (rc=0), and a NEGATIVE CONTROL proving deno really does report type errors there (`TS2322`, rc=1). |

The full prose write-up lives in `../REPORT.md`, section "t_e19ad2e9 (2026-10-10)".
