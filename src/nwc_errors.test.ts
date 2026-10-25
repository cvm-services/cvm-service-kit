// Regression tests for the NWC client's silent-failure modes.
//
// WHY THESE EXIST
//   Two failures cost real money and turns, and neither produced an honest error:
//
//   1. SILENT REPLY DISCARD. The reply handler wrapped decryption in
//      `catch { /* ignore undecryptable events */ }`. If a valid reply used an
//      unexpected scheme, it was thrown away and the caller waited out the full
//      timeout — indistinguishable from "the wallet never answered".
//
//   2. TIMEOUT AS AMBIGUITY. `pay_invoice` timed out while the broker HAD executed
//      the payment. The error text ("NWC pay_invoice timed out") reads like a
//      failure, so a caller's natural retry would DOUBLE-PAY. Measured on the fleet
//      broker: balance 20002 -> 19874 after a timeout.
//
// The client must therefore:
//   * try BOTH NIP-04 and NIP-44 on decrypt, and report which worked;
//   * report how many reply events it SAW, so "no reply" is distinguishable from
//     "a reply we could not read";
//   * classify a timeout on pay_invoice as OUTCOME UNKNOWN (not failure), and say
//     plainly that retrying is unsafe.
//
// RUNNER NOTE: this file originally imported `jsr:@std/assert@1` while every other
// test in this repo (38 of them) uses `bun:test`. Neither runner could load it —
// `bun test` cannot resolve the `jsr:` specifier and offline `deno` cannot fetch
// it — so these cases had NEVER executed. Ported to `bun:test` so the guard is
// proven on every run.

import { describe, expect, test } from "bun:test";
import { NwcErrorReply, NwcTimeout, describeNwcFailure } from "./nwc_errors.ts";

// --- a timeout is NOT a plain failure -------------------------------------
describe("NwcTimeout classification", () => {
  test("pay_invoice timeout is classified as OUTCOME UNKNOWN, not failure", () => {
    const e = new NwcTimeout("pay_invoice", "invoice-may-be-paid");
    expect(e.outcomeUnknown).toBe(true);
    expect(e.method).toBe("pay_invoice");

    const msg = describeNwcFailure(e, { eventsSeen: 0 });
    expect(msg).toContain("UNKNOWN");
    expect(msg).toContain("do not retry");
  });

  test("a read-only timeout is NOT ambiguous (nothing could have moved)", () => {
    const e = new NwcTimeout("get_balance", "no-reply");
    // A read cannot spend anything, so retrying it is safe.
    expect(e.outcomeUnknown).toBe(false);
    const msg = describeNwcFailure(e, { eventsSeen: 0 });
    expect(msg).toContain("safe to retry");
  });

  test("pay_keysend is also a spending method and is ambiguous", () => {
    const e = new NwcTimeout("pay_keysend", "invoice-may-be-paid");
    expect(e.outcomeUnknown).toBe(true);
  });

  test("a NIP-47 error reply is a definite answer, not a timeout", () => {
    const reply = new NwcErrorReply("lookup_invoice", "NOT_IMPLEMENTED", "not implemented");
    expect(reply.outcomeUnknown).toBe(false); // it answered; it just refused
    expect(reply.code).toBe("NOT_IMPLEMENTED");
  });
});

// --- silent reply discard must be impossible to hide ----------------------
describe("describeNwcFailure diagnostics", () => {
  test("a timeout that SAW reply events reports undecryptable, not silence", () => {
    const e = new NwcTimeout("pay_invoice", "no-reply");
    const msg = describeNwcFailure(e, { eventsSeen: 2, decryptScheme: "none" });
    expect(msg).toContain("undecryptable");
    // The diagnostic must name what was tried, or the next person debugs blind again.
    expect(msg).toContain("nip04");
  });

  test("a timeout with NO reply events reports silence, distinctly", () => {
    const e = new NwcTimeout("pay_invoice", "no-reply");
    const msg = describeNwcFailure(e, { eventsSeen: 0 });
    expect(msg).toContain("no reply events");
  });

  test("silence and undecryptable produce DIFFERENT diagnostics", () => {
    const e = new NwcTimeout("pay_invoice", "no-reply");
    const silent = describeNwcFailure(e, { eventsSeen: 0 });
    const garbled = describeNwcFailure(e, { eventsSeen: 3, decryptScheme: "none" });
    expect(silent === garbled).toBe(false);
  });

  test("a successful decrypt names the scheme that worked", () => {
    const e = new NwcTimeout("pay_invoice", "reply-not-usable");
    const msg = describeNwcFailure(e, { eventsSeen: 1, decryptScheme: "nip44" });
    expect(msg).toContain("nip44");
  });

  // A reply we saw but whose scheme was never recorded must NOT be described as
  // having decrypted anything: "decrypted via undefined" is exactly the kind of
  // dishonest diagnostic this module exists to prevent.
  test("a seen reply with no recorded scheme does not claim a scheme", () => {
    const e = new NwcTimeout("pay_invoice", "no-reply");
    const msg = describeNwcFailure(e, { eventsSeen: 1 });
    expect(msg).not.toContain("undefined");
  });
});
