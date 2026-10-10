# Cold cross-family review of cc38d9e..HEAD (t_936c2a0f)

reviewer_model: kimi-k3 (family moonshot; author family tier/coding)
router X-Failover-Provider: deepseek | served: None | usage: {'prompt_tokens': 8587, 'completion_tokens': 32000, 'total_tokens': 40587, 'prompt_tokens_details': {'cached_tokens': 0}, 'completion_tokens_details': {'reasoning_tokens': 31191}, 'prompt_cache_hit_tokens': 0, 'prompt_cache_miss_tokens': 8587}
diffstat:
```
 evidence/consumer_audit_five_services.txt        |  45 +++
 evidence/determinism_3_rounds.txt                |  16 +
 evidence/green_sms4sats_gate.txt                 |  19 ++
 evidence/mutation_M2_memory_store.txt            |  67 +++++
 evidence/mutation_M3_put_create.txt              |  25 ++
 evidence/red_create_clobber.txt                  |  25 ++
 evidence/red_mutant_no_store.txt                 |  67 +++++
 evidence/suite_bun_pre_fix_FAIL.txt              | 358 +++++++++++++++++++++++
 evidence/suite_round1_pass.txt                   | 344 ++++++++++++++++++++++
 evidence/suite_round2_pass.txt                   | 344 ++++++++++++++++++++++
 evidence/typecheck_t936c2a0f.txt                 |   1 +
 services/cvm-sms4sats/src/gate-process.runner.ts |  99 +++++++
 services/cvm-sms4sats/src/gate-process.test.ts   | 298 +++++++++++++++++++
 src/gate-create-race.test.ts                     | 165 +++++++++++
 src/gate-store.ts                                |  29 ++
 src/payment.ts                                   |  31 +-
 16 files changed, 1932 insertions(+), 1 deletion(-)
```

VERDICT: APPROVED

FINDINGS:
1. src/gate-store.ts:97 (create read-back) — LOW/MED. `return this.get(order.orderId) ?? order;` violates the documented contract ("return the row that is there afterwards"). The INSERT and the SELECT are two autocommit statements, not one transaction; the SELECT is only guaranteed to see the conflicting/inserted row, not to be non-undefined. If any future delete/cleanup removes the row between the INSERT and the SELECT, `create` returns the caller's own `awaiting_payment` object — literally "continue from the one it tried to write," the thing the contract forbids — and the resurrection is back. Today there is no delete path, so it is unreachable; it should throw/return `undefined` instead of resurrecting. Concurrency otherwise holds: SQLite serializes writers, `ON CONFLICT(order_id) DO NOTHING` is atomic, and a separate read sees committed data only (no dirty read/lost update). The gap is strictly the delete window plus the fallback.

2. src/payment.ts:217 (`order = this.store.create(order)`) — MED (claim unproven, not a demonstrated bug). Claim #3 ("loser verifies against the SURVIVING row's invoice") is not shown by the diff: the hunk ends before the verify/claim block. It holds only if every downstream use reads the reassigned `order` (and `order.invoice`) and if `processor.verify` binds the proof to that invoice. Both test processors (`gate-process.runner.ts:24`, `gate-process.test.ts:29`) return `true` unconditionally, so no provided test actually exercises a mismatched pre-image — fail-closed is asserted, not tested. Since the invoice is generated per-orderId, a mismatch also requires a non-deterministic/invoice-bound `createInvoice`; the guarantee is only as strong as `verify`.

3. src/gate-create-race.test.ts:128 ("two racing creators converge") — LOW. As the evidence admits, this passes under M3. It is fully sequential (`a.create`, `a.claim`, `a.put settled`, `b.create`) and never races; it only checks `SqliteGateStore.create` insert-if-absent in isolation, not the gate's *use* of it. It is not load-bearing for the integration regression the PR fixes; its name overstates it. The load-bearing test is the StaleAbsentStore resurrection test.

4. src/gate-process.test.ts:130 (cross-process durable test) — MED (coverage overstated). The CREATE race is not deterministically exercised across two OS processes. It depends on both processes passing `get()==undefined` before either INSERTs; the start barrier plus the 250 ms hold make that likely but scheduler-dependent, and the evidence does not show this test failing under M3. The only deterministic create-race test is a single-process wrapper (StaleAbsentStore) whose surviving row is already `settled`, i.e. it exercises the replay path, not the "both hold `awaiting_payment`, both verify, one wins the CAS claim" interleaving. So "two OS processes both take the create path" is demonstrated only by a synthetic in-process pre-image.

5. src/payment.ts (restart mid-flight, `settlement_reserved`) — MED. Durability converts a crash between claim and settle into a permanently stuck order: no test covers restart while `settlement_reserved`, and the seeded test asserts it is refused forever (`refused:SettlementInProgressError`). The payment is captured, the action may have partially run, there is no expiry/reconciliation, and a naive operator reset of the row to `awaiting_payment` re-enables a second send. Fail-closed
