/**
 * Operator command for the gate recovery path (`src/gate-recovery.ts`).
 *
 *   bun src/gate-recovery-cli.ts list       --db <gate.sqlite> [--lease-min N]
 *   bun src/gate-recovery-cli.ts release    --db <gate.sqlite> --order <id> [--lease-min N] [--force]
 *   bun src/gate-recovery-cli.ts compensate --db <gate.sqlite> --order <id> \
 *                                           --outcome refunded|abandoned --note "<why>"
 *
 * Exit codes: 0 = done, 1 = refused (nothing changed), 2 = usage error.
 * See `docs/gate-recovery-runbook.md` for when each command is correct.
 */
import { SqliteGateStore } from "./gate-store.ts";
import {
  DEFAULT_RESERVATION_LEASE_MS,
  type CompensationOutcome,
  findStuckOrders,
  recordCompensation,
  releaseReservation,
} from "./gate-recovery.ts";

export interface CliIo {
  log: (line: string) => void;
  error: (line: string) => void;
}

const USAGE = `gate-recovery - operator escape hatch for orders the gate will not retry

  list       --db <gate.sqlite> [--lease-min N]
  release    --db <gate.sqlite> --order <id> [--lease-min N] [--force]
  compensate --db <gate.sqlite> --order <id> --outcome refunded|abandoned --note <why>

  release   moves a crashed 'settlement_reserved' order back to awaiting_payment
            so a retry can re-drive it. It refuses while the lease is live
            unless --force is given: check the downstream venue FIRST.
  compensate records an operator compensation for a 'settlement_failed' order.
            It never changes the status, so the order still refuses to re-run.`;

interface Flags {
  values: Map<string, string>;
  booleans: Set<string>;
}

const BOOLEAN_FLAGS = new Set(["force", "help"]);
const KNOWN_FLAGS = new Set(["db", "order", "outcome", "note", "lease-min", "force", "help"]);

function parseFlags(argv: string[]): Flags | string {
  const values = new Map<string, string>();
  const booleans = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) return `unexpected argument: ${arg}`;
    const name = arg.slice(2);
    if (!KNOWN_FLAGS.has(name)) return `unknown flag: --${name}`;
    if (BOOLEAN_FLAGS.has(name)) {
      booleans.add(name);
      continue;
    }
    const value = argv[++i];
    if (value === undefined) return `flag --${name} needs a value`;
    values.set(name, value);
  }
  return { values, booleans };
}

function leaseMsOf(flags: Flags): number | string {
  const raw = flags.values.get("lease-min");
  if (raw === undefined) return DEFAULT_RESERVATION_LEASE_MS;
  const minutes = Number(raw);
  if (!Number.isFinite(minutes) || minutes <= 0) return `--lease-min must be a positive number`;
  return minutes * 60_000;
}

/** Run the CLI. Returns the process exit code; never throws for a user error. */
export async function main(argv: string[], io: CliIo = console): Promise<number> {
  const command = argv[0];
  if (command === undefined || command === "--help" || command === "help") {
    io.log(USAGE);
    return command === undefined ? 2 : 0;
  }

  const parsed = parseFlags(argv.slice(1));
  if (typeof parsed === "string") {
    io.error(`usage error: ${parsed}`);
    io.error(USAGE);
    return 2;
  }
  const leaseMs = leaseMsOf(parsed);
  if (typeof leaseMs === "string") {
    io.error(`usage error: ${leaseMs}`);
    return 2;
  }

  const db = parsed.values.get("db");
  if (!db) {
    io.error("usage error: --db <gate.sqlite> is required");
    return 2;
  }

  const store = new SqliteGateStore(db);
  try {
    switch (command) {
      case "list":
        return listCommand(store, leaseMs, io);
      case "release":
        return releaseCommand(store, leaseMs, parsed, io);
      case "compensate":
        return compensateCommand(store, parsed, io);
      default:
        io.error(`usage error: unknown command ${command}`);
        io.error(USAGE);
        return 2;
    }
  } finally {
    store.close();
  }
}

function listCommand(store: SqliteGateStore, leaseMs: number, io: CliIo): number {
  const report = findStuckOrders(store, { leaseMs });
  const describe = (label: string, rows: ReturnType<typeof findStuckOrders>["reserved"]) => {
    for (const row of rows) {
      const ageMin = (row.ageMs / 60_000).toFixed(1);
      const note = row.leaseExpired ? "LEASE EXPIRED" : "lease live";
      const compensated = row.resolution ? ` compensated=${row.resolution.outcome}` : "";
      io.log(
        `${label} ${row.order.orderId} age=${ageMin}min ${note} sats=${row.order.amountSats}` +
          ` tool=${row.order.tool}${compensated}`,
      );
    }
  };
  if (report.reserved.length === 0 && report.failed.length === 0) {
    io.log("no stuck orders");
    return 0;
  }
  describe("reserved", report.reserved);
  describe("failed", report.failed);
  if (report.reserved.length > 0) {
    io.log(
      `${report.reserved.length} reservation(s) still live. Do NOT release a live one: a slow` +
        ` action and a crashed one look the same here. Check the downstream venue first.`,
    );
  }
  return 0;
}

function releaseCommand(store: SqliteGateStore, leaseMs: number, flags: Flags, io: CliIo): number {
  const orderId = flags.values.get("order");
  if (!orderId) {
    io.error("usage error: release needs --order <id>");
    return 2;
  }
  const result = releaseReservation(store, orderId, {
    leaseMs,
    force: flags.booleans.has("force"),
  });
  if (result.released) {
    io.log(
      `released ${orderId}: settlement_reserved -> awaiting_payment (was stuck ${(
        (result.ageMs ?? 0) / 60_000
      ).toFixed(1)}min). A retry may now re-drive it.`,
    );
    return 0;
  }
  switch (result.refusal) {
    case "not_found":
      io.error(`refused: no order ${orderId} in this database`);
      return 1;
    case "not_reserved":
      io.error(
        `refused: ${orderId} is ${result.order?.status}, not settlement_reserved` +
          ` - a terminal order must never be resurrected`,
      );
      return 1;
    case "lease_active":
      io.error(
        `refused: ${orderId} is only ${((result.ageMs ?? 0) / 60_000).toFixed(1)}min into a ` +
          `${((result.leaseMs ?? leaseMs) / 60_000).toFixed(1)}min lease; it may still be running.` +
          ` Re-run with --force only after checking the venue never received the action.`,
      );
      return 1;
    default:
      io.error(`refused: ${orderId} moved while being released; nothing was changed`);
      return 1;
  }
}

function compensateCommand(store: SqliteGateStore, flags: Flags, io: CliIo): number {
  const orderId = flags.values.get("order");
  const outcome = flags.values.get("outcome");
  const note = flags.values.get("note");
  if (!orderId || !outcome || !note) {
    io.error("usage error: compensate needs --order <id> --outcome refunded|abandoned --note <why>");
    return 2;
  }
  if (outcome !== "refunded" && outcome !== "abandoned") {
    io.error("usage error: --outcome must be `refunded` or `abandoned`");
    return 2;
  }
  const result = recordCompensation(store, orderId, {
    outcome: outcome as CompensationOutcome,
    note,
  });
  if (result.recorded) {
    io.log(
      `recorded ${outcome} for ${orderId}. The order stays settlement_failed on purpose:` +
        ` it still refuses to re-run.`,
    );
    return 0;
  }
  if (result.refusal === "not_found") {
    io.error(`refused: no order ${orderId} in this database`);
  } else {
    io.error(`refused: ${orderId} is not settlement_failed, so there is nothing to compensate`);
  }
  return 1;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
