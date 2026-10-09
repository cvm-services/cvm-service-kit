# PROGRESS — t_63be63f1 (gated fiat payment path)

Task: no fiat spend before the sats have settled (ADR-0008) + ADR-0012 escalation.

## Sequencing reality (checked 2026-10-10, do not re-discover)
- t_e19ad2e9 (MONEY BUG / kit gate fix) = `ready`. Work exists as PR #13
  `fix/gate-money-safety`, OPEN + cross-family review **BLOCKED** (consumer audit
  open, no recovery path for `settlement_reserved`/`settlement_failed`).
- t_89dcb160 (Fiat settlement state machine) = `ready`, UNSTARTED, no branch.
- This card therefore branches from `fix/gate-money-safety` (b35b916) so the
  money path is enforced by the durable claim that fix introduces, and adds the
  piece the review's [HIGH] finding asks for: a durable, reply-driven, escalated
  escape hatch. No second gate is created: `ExplicitGate` remains the only
  decision about whether the sats were paid.

## Clusters
1. [x] kit: `src/fiat-intent.ts` + `src/fiat-store.ts` + `src/escalation.ts` +
       `src/fiat-path.ts` + `src/fiat-path.test.ts` (17 tests) — bun suite
       184 pass / 0 fail, `tsc --noEmit` clean.
2. [ ] cvm-2fiat: `card.pay_checkout` tool wired owner-first + gate-downstream,
       service RED test (tool absent) then GREEN, contract text.
3. [ ] private 2fiat-local-adapter: implement `pay_checkout` + tests.
4. [ ] REPORT.md + evidence (RED before/after, human step statement).

## Worktrees
- kit: /home/c03rad0r/worktrees/t_63be63f1/kit  (branch worker-base/t_63be63f1-kit, base fix/gate-money-safety)
- adapter: /home/c03rad0r/worktrees/t_63be63f1/2fiat (branch worker-base/t_63be63f1)
- node_modules symlinked from ~/repos/cvm-service-kit (gitignored in the worktree)
