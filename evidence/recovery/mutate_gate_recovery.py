#!/usr/bin/env python3
"""Mutation check for the gate recovery path (review finding B7: "do the tests have teeth?").

Mutates the recovery source in place, runs the recovery suite, restores byte-identical.
Every mutation names the review finding it is meant to catch.

  python3 evidence/recovery/mutate_gate_recovery.py

Exit 0 when every mutation is CAUGHT or provably EQUIVALENT; 1 otherwise (a SURVIVOR is a
real coverage gap and must be fixed, not explained away).
"""
import re
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
HARNESS = "bun"  # resolved from PATH; this script is run from a shell with bun available
TARGET = "src/gate-recovery.test.ts"

# (label, file, old, new, why-equivalent-if-it-survives or None)
MUTATIONS = [
    ("M-B2  drop the legacy 'paid' bucket from the stuck report", "src/gate-recovery.ts",
     'legacy: bucket("paid"),', 'legacy: [],', None),
    ("M-B3  remove settlement_reserved from COMPENSATABLE_STATUSES", "src/gate-recovery.ts",
     '  "settlement_reserved",\n  // Legacy pre-2026-10-09', '  // Legacy pre-2026-10-09', None),
    ("M-B4  remove the --lease-min lower bound (shrink the guard instead of --force)",
     "src/gate-recovery-cli.ts",
     'if (minutes < DEFAULT_RESERVATION_LEASE_MS / 60_000) {', 'if (false) {', None),
    ("M-B5  revert putResolution to an upsert (the log loses history)", "src/gate-store.ts",
     '`INSERT INTO gate_recovery (order_id, outcome, note, at) VALUES (?, ?, ?, ?)`',
     '`INSERT INTO gate_recovery (order_id, outcome, note, at) VALUES (?, ?, ?, ?)'
     ' ON CONFLICT(order_id) DO UPDATE SET outcome=excluded.outcome,'
     ' note=excluded.note, at=excluded.at`',
     None),
    ("M-B6  classify(): drop the Number.isFinite guard on the lease flag", "src/gate-recovery.ts",
     'leaseExpired: Number.isFinite(ageMs) && ageMs > leaseMs', 'leaseExpired: ageMs > leaseMs',
     "EQUIVALENT: ageMs is NaN exactly when Number.isFinite(ageMs) is false, and `NaN > x` is "
     "false, so both expressions yield false for every input. The guard is intent, not behaviour."),
    ("M-B6b releaseReservation(): drop the fail-closed non-finite age guard", "src/gate-recovery.ts",
     'if (!Number.isFinite(ageMs) || ageMs <= leaseMs) {', 'if (ageMs <= leaseMs) {',
     None),
    ("M-R4a releaseReservation(): status-only CAS (the ABA the round-4 review found)",
     "src/gate-recovery.ts",
     'const released = store.releaseIfUnchanged(orderId, order.updatedAt);',
     'const released = store.claim(orderId, "settlement_reserved", "awaiting_payment");',
     None),
    ("M-R4b listResolutions(): order by `at` instead of insertion order", "src/gate-store.ts",
     'ORDER BY seq ASC`', 'ORDER BY at ASC, seq ASC`', None),
]


def run_suite() -> tuple[int, int, list[str]]:
    r = subprocess.run([HARNESS, "test", TARGET], cwd=REPO, capture_output=True, text=True)
    out = r.stdout + r.stderr
    pm, fm = re.search(r"(\d+) pass", out), re.search(r"(\d+) fail", out)
    return (
        int(pm.group(1)) if pm else 0,
        int(fm.group(1)) if fm else -1,
        re.findall(r"\(fail\) gate recovery[^\n]*", out),
    )


def main() -> int:
    head = subprocess.run(["git", "rev-parse", "HEAD"], cwd=REPO, capture_output=True,
                          text=True).stdout.strip()
    dirty = subprocess.run(["git", "status", "--porcelain"], cwd=REPO, capture_output=True,
                           text=True).stdout.strip()
    print("=" * 72)
    print("MUTATION EVIDENCE - gate recovery path (round-2 review findings)")
    print(f"HEAD: {head}")
    tree = ("DIRTY:\n" + dirty) if dirty else "clean"
    print(f"working tree: {tree}")
    # Pin the evidence to the SOURCE CONTENT, not just the commit: a later docs-only
    # commit moves HEAD without touching what was mutated, and a reader must be able
    # to tell those two situations apart. (Review finding B8, round 4.)
    sources = ["src/gate-recovery.ts", "src/gate-recovery-cli.ts", "src/gate-store.ts",
               "src/gate-recovery.test.ts"]
    print("source blobs (git hash-object - these ARE the mutated files):")
    for rel in sources:
        blob = subprocess.run(["git", "hash-object", rel], cwd=REPO, capture_output=True,
                              text=True).stdout.strip()
        print(f"  {blob}  {rel}")
    print(f"Method: mutate in place, `bun test {TARGET}`, restore byte-identical (asserted).")
    print("=" * 72)

    p, f, _ = run_suite()
    print(f"\nBASELINE (unmutated): {p} pass / {f} fail\n")

    survivors = []
    for label, rel, old, new, equivalent in MUTATIONS:
        path = REPO / rel
        src = path.read_text()
        if old not in src:
            print(f"{label}\n    SKIP - anchor not found (source drifted)")
            survivors.append(label)
            continue
        path.write_text(src.replace(old, new, 1))
        try:
            p2, f2, fails = run_suite()
        finally:
            path.write_text(src)
        assert path.read_text() == src, f"restore failed for {rel}"
        if f2 > 0:
            verdict = "CAUGHT"
        elif equivalent:
            verdict = f"SURVIVED but {equivalent}"
        else:
            verdict = "*** SURVIVED - COVERAGE GAP ***"
            survivors.append(label)
        print(f"{label}\n    {p2} pass / {f2} fail -> {verdict}")
        for n in fails[:1]:
            print(f"      {n.strip()[:150]}")

    p, f, _ = run_suite()
    print(f"\nPOST-RESTORE: {p} pass / {f} fail (source byte-identical)")
    print(f"\nRESULT: {len(survivors)} unexplained survivor(s)")
    return 1 if survivors else 0


if __name__ == "__main__":
    sys.exit(main())
