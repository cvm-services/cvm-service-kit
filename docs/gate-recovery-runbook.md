# Runbook: recovering an order the money gate will not retry

Operator procedure for the two states the gate deliberately refuses to leave on its
own. Card `t_7233c336` (PR #13 hardening); code in `src/gate-recovery.ts`, command in
`src/gate-recovery-cli.ts`.

## Why these states exist

`ExplicitGate.gate()` takes payment, claims the order (`awaiting_payment ->
settlement_reserved`, a single guarded `UPDATE`), then runs the downstream action. It
will never re-run an action against a payment it has already verified — that is the
double-spend fix — so two states have no automatic exit:

| state | how it happens | what the customer sees |
| --- | --- | --- |
| `settlement_reserved` | the process died (OOM, redeploy, `Restart=always`, host loss) after the claim and before it wrote an outcome | retries throw `SettlementInProgressError` forever; sats taken, no service |
| `settlement_failed` | the action ran and failed (venue refused, upstream 5xx) | retries throw `SettlementFailedError` forever; sats taken, no service |

Nothing here is allowed to be automatic. **Whether a `settlement_reserved` action
actually reached the venue is knowable only by looking at the venue.** A crashed
action and a merely slow one are indistinguishable from the store, so an automatic
release would re-run an action whose result is unknown — the exact double spend this
gate exists to prevent. The lease (`--lease-min`, default 15) only decides what gets
*flagged* to you; it never moves a row.

## 1. Find stuck orders

One gate database per service, on the state directory the `cvm_service` ansible role
creates (`/var/lib/loom/<service>/gate.sqlite`; `GATE_DB` in the render for
`cvm-sms4sats`):

```sh
for db in /var/lib/loom/cvm-*/gate.sqlite; do
  echo "== $db"
  bun src/gate-recovery-cli.ts list --db "$db"
done
```

`list` is read-only. Output is one line per stuck order:

```
reserved <orderId> age=3.4min LEASE EXPIRED sats=1200 tool=tool:send_sms
failed   <orderId> age=41.0min lease live     sats=5022 tool=tool:place_order compensated=refunded
```

A `lease live` reservation may still be a running action — do not touch it. Re-run
`list` later; a reservation whose age keeps growing past the lease is the crash case.

## 2. A stuck `settlement_reserved` order

1. **Look at the venue first.** Ask the downstream system whether it ever received
   this order. The gate's `orderId` is the idempotency key the service passes
   downstream, so a hit means the action ran.
2. **The action ran** → do *not* release. Compensate (step 3) after refunding, and if
   the order is still `settlement_reserved` because the process died before the
   terminal write, first let it be — the row is the evidence of what happened. The
   status will only move when the row is released and a retry re-runs the action, which
   you must not do. Record the compensation against the order, then close the incident
   with that evidence in the ticket.
3. **The venue never received it** → release the claim so the caller may retry:

```sh
bun src/gate-recovery-cli.ts release --db /var/lib/loom/cvm-ppq/gate.sqlite --order <orderId> --force
```

   `--force` is required while the lease is live; without it the command refuses with
   the age, which is the reminder to do step 1. The release is the same
   `settlement_reserved -> awaiting_payment` compare-and-set the gate uses, so it
   cannot create a second owner if the original caller is somehow still alive.
4. The caller retries; the gate re-verifies the same (already settled) invoice, claims
   it, and runs the action once. If it now fails, the order becomes
   `settlement_failed` and step 3 applies.

## 3. A terminal `settlement_failed` order

The customer paid and the service failed. Refund (or decide to abandon) through the
normal treasury path, then record it:

```sh
bun src/gate-recovery-cli.ts compensate --db /var/lib/loom/cvm-2fiat/gate.sqlite \
  --order <orderId> --outcome refunded --note "mint swap back to npub1..., tx 0xabc"
```

`--outcome` is `refunded` or `abandoned`. The record goes to the `gate_recovery` table
(`order_id`, `outcome`, `note`, `at`) and is durable across restarts; `list` shows it as
`compensated=refunded`.

**The order status is deliberately NOT changed.** `settlement_failed` is what keeps a
replay throwing `SettlementFailedError` instead of re-running the failed action. A
compensation is bookkeeping about the money; it is not a licence to retry. Do not edit
`gate_orders` by hand to "clear" a row — the status is the money-safety fact.

## Hard rules

- Never auto-release, never add a timeout sweep that flips rows on its own. Any such
  change re-introduces the double spend for the crashed-but-actually-ran case.
- Never write `gate_orders.status` by hand. Use `release` (which goes through the CAS)
  or `compensate` (which does not touch the status at all).
- Never point the command at a database a service is not holding — the gate is the only
  writer, and a second writer bypasses the CAS.
- Every release and compensation is an operator action; put the `orderId`, the venue
  check and the outcome in the incident notes. The tool prints what it did; keep the
  output.
