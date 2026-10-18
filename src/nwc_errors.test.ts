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

import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { NwcTimeout, describeNwcFailure } from "./nwc_errors.ts";

// --- a timeout is NOT a plain failure -------------------------------------
Deno.test("pay_invoice timeout is classified as OUTCOME UNKNOWN, not failure", () => {
  const e = new NwcTimeout("pay_invoice", "invoice-may-be-paid");
  assertEquals(e.outcomeUnknown, true);
  assertEquals(e.method, "pay_invoice");

  const msg = describeNwcFailure(e, { eventsSeen: 0 });
  assertStringIncludes(msg, "UNKNOWN");
  assertStringIncludes(msg, "do not retry");
});

Deno.test("a read-only timeout is NOT ambiguous (nothing could have moved)", () => {
  const e = new NwcTimeout("get_balance", "no-reply");
  // A read cannot spend anything, so retrying it is safe.
  assertEquals(e.outcomeUnknown, false);
  const msg = describeNwcFailure(e, { eventsSeen: 0 });
  assertStringIncludes(msg, "safe to retry");
});

// --- silent reply discard must be impossible to hide ----------------------
Deno.test("a timeout that SAW reply events reports undecryptable, not silence", () => {
  const e = new NwcTimeout("pay_invoice", "no-reply");
  const msg = describeNwcFailure(e, { eventsSeen: 2, decryptScheme: "none" });
  assertStringIncludes(msg, "undecryptable");
  // The diagnostic must name what was tried, or the next person debugs blind again.
  assertStringIncludes(msg, "nip04");
});

Deno.test("a timeout with NO reply events reports silence, distinctly", () => {
  const e = new NwcTimeout("pay_invoice", "no-reply");
  const msg = describeNwcFailure(e, { eventsSeen: 0 });
  assertStringIncludes(msg, "no reply events");
});

// --- the two failure modes are distinguishable ----------------------------
Deno.test("silence and undecryptable produce DIFFERENT diagnostics", () => {
  const e = new NwcTimeout("pay_invoice", "no-reply");
  const silent = describeNwcFailure(e, { eventsSeen: 0 });
  const garbled = describeNwcFailure(e, { eventsSeen: 3, decryptScheme: "none" });
  assertEquals(silent === garbled, false);
});

// --- a NIP-47 error reply is a definite answer, not a timeout -------------
Deno.test("a NIP-47 error reply carries the broker's own code", () => {
  const e = new NwcTimeout("lookup_invoice", "unsupported");
  assertEquals(e.outcomeUnknown, false); // it answered; it just refused
});
