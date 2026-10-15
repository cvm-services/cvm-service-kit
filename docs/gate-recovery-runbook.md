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
gate exists to prevent.

The lease (`--lease-min`, default 15 min) never moves a row by itself. It does two
things and only two: it decides what `list` **flags** to you, and it decides whether
`release` **refuses** without `--force`. `--lease-min` may only be *raised* — lowering
it is the same act as `--force` (it shrinks the guard past a live reservation without
an explicit, auditable flag), so the command refuses to lower it. If you need to
release something the lease still protects, say `--force` and say why.

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
reserved    <orderId> age=3.4min LEASE EXPIRED sats=1200 tool=tool:send_sms
failed      <orderId> age=41.0min lease live     sats=5022 tool=tool:place_order compensated=refunded
legacy-paid <orderId> age=6.2d   lease live     sats=1000 tool=tool:place_order
```

A `lease live` reservation may still be a running action — do not touch it. Re-run
`list` later; a reservation whose age keeps growing past the lease is the crash case.

## 2. A stuck `settlement_reserved` order

1. **Look at the venue first.** Ask the downstream system whether it ever received
   this order. The gate's `orderId` is the idempotency key the service passes
   downstream, so a hit means the action ran.
2. **The action ran** → do *not* release. The sats are spent for a service the
   customer received; record a compensation against the order:

```sh
bun src/gate-recovery-cli.ts compensate --db /var/lib/loom/cvm-ppq/gate.sqlite \
  --order <orderId> --outcome refunded --note "venue confirms order X was delivered"
```

   `compensate` accepts a `settlement_reserved` order for exactly this case (if it
   did not, the runbook would be describing an action the tool refuses). The row
   **stays** `settlement_reserved`: that status is what keeps every retry throwing
   `SettlementInProgressError` instead of re-running an action of unknown outcome.
   It keeps appearing in `list`, now marked `compensated=<outcome>` — that is the
   record that a human resolved it. Close the incident with the venue check and
   this record in the ticket.
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
`compensated=refunded`. The table is **append-only**: a second compensation for the same
order (a correction, or a refund after an earlier abandonment) is added to the history
rather than overwriting the first, and `list` shows the most recent one. Nothing is lost,
so an incident can be reconstructed after the fact.

**The order status is deliberately NOT changed.** `settlement_failed` is what keeps a
replay throwing `SettlementFailedError` instead of re-running the failed action. A
compensation is bookkeeping about the money; it is not a licence to retry. Do not edit
`gate_orders` by hand to "clear" a row — the status is the money-safety fact.

## 4. A legacy `paid` order

`paid` is the pre-2026-10-09 status: the gate wrote it **before** running the action, so
the outcome is unverifiable by construction and the gate refuses the row forever with
`GateOrderStateError` ("settlement outcome unknown"). It is not a reservation, so there is
nothing to release; it is not `settlement_failed`, so there is no failure to inspect.

`list` reports these as `legacy-paid`. The only operator action is to decide the money and
record it:

```sh
bun src/gate-recovery-cli.ts compensate --db /var/lib/loom/cvm-sms4sats/gate.sqlite \
  --order <orderId> --outcome refunded --note "pre-2026-10-09 row; outcome unverifiable, refunded on request"
```

The row stays `paid`. Do not hand-edit it to `settled` or `settlement_failed`: both would
assert an outcome nobody recorded, and `settled` would additionally let a replay return a
cached result for work that may never have run.

## Upgrading a service to the durable gate (the cutover window)

A service whose gate was built over `MemoryOrderStore` (the in-process Map) has **no durable
record of what it settled**. `cvm-sms4sats` was the last such service and now builds
`buildGate(processor, cfg.gateDb)`; the same applies to any future service adopting
`SqliteGateStore` for the first time.

The new `gate.sqlite` starts **empty**, so a proof that was settled *before* the upgrade has
no row to match and the first replay after the upgrade can re-run the action. This window is
not closable by migration — the old store recorded nothing to migrate — so treat it as a
deployment step:

1. Stop taking new paid work for the service (`PAYMENT_MODE=none`, or drain the wrapper).
2. Let in-flight actions finish (the "reserved" rows are the in-flight set).
3. Deploy the version with `GATE_DB` set, then re-enable paid work.

The exposed set is exactly the orders that were settled *and still resident in RAM* at the
moment of cutover; after the cutover the window is closed permanently. Before the fix the
same set was replayable on **every** restart, so this is a strict narrowing, not a new risk.
Full reasoning: `docs/gate-consumer-audit.md` § F5b.

## Hard rules

- Never auto-release, never add a timeout sweep that flips rows on its own. Any such
  change re-introduces the double spend for the crashed-but-actually-ran case.
- `--force` can release a **live, merely slow** caller: the original caller is not
  cancelled and will still finish, so a retry started afterwards can run the action a
  second time against the same payment. `--force` is break-glass for "the venue tells
  me it never received this" — never a retry button, and never for an order whose
  venue check you have not actually done.
- Never write `gate_orders.status` by hand. Use `release` (which goes through the CAS)
  or `compensate` (which does not touch the status at all).
- Never point the command at a database a service is not holding — the gate is the only
  writer, and a second writer bypasses the CAS.
- Every release and compensation is an operator action; put the `orderId`, the venue
  check and the outcome in the incident notes. The tool prints what it did; keep the
  output.

## Scope of the recovery path

`list` / `release` / `compensate` are implemented against the concrete `SqliteGateStore`
(`list` is deliberately NOT on the `GateOrderStore` interface, so the shared interface is
not widened again for an operator concern). All six gate consumers in this repo construct a
`SqliteGateStore`, so every deployed service is covered; a future service that ships a
*different* durable store would need its own recovery implementation.
