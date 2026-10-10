# t_89dcb160 — Fiat settlement state machine (durable intents, exactly-once settled_reserved, restart-safe replay + ADR-0012 escalation)

Branch: `worker-base/t_89dcb160` (stacked on `fix/gate-money-safety` = PR #13, the money-bug fix).
Worktree: `/home/c03rad0r/worktrees/t_89dcb160` (node_modules symlinked to the reference repo).

## Why this card exists
`ExplicitGate` (fixed by PR #13) claims exactly once and fails terminally, but it binds NOTHING:
one `orderId` reused with a different caller / tool / amount / order silently reuses the stored
invoice. A 100-sat invoice can therefore fund a 500-sat fiat attempt. This card adds the durable
intent table with a full binding, a durable proof-reuse barrier, processor-final receipt
verification, and the ADR-0012 escalation state machine.

## Log
- 2026-10-10 05:0x — oriented. Repo `~/repos/cvm-service-kit`; worktree created off PR #13.
  Baseline `bun test src services` = 167 pass / 1 skip / 0 fail. Read payment.ts, gate-store.ts,
  cashu.ts, proof-store.ts, transport.ts, lnwallet.ts, services/cvm-2fiat/*.
- 2026-10-10 05:1x — wrote RED tests (intent-store / settlement / escalation) + the RED-before probe.
- next: modules -> GREEN, multi-process evidence, service wiring (OWNER_NPUB_HEX operator DM),
  REPORT.md, push.
