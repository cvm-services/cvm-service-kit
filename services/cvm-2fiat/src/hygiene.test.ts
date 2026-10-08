/**
 * cvm-2fiat — the card-hygiene invariants, written RED.
 *
 * These tests bind BEFORE the service exists (every import fails = RED) and
 * must stay green forever after. They are the contract the manager comment
 * requires: no credential-shaped value may appear in any tool response or
 * log line this service produces.
 */
import { describe, expect, test } from "bun:test";
import { ExplicitGate, type Invoice, type PaymentProcessor } from "../../../src/index.ts";
import { REFUSAL_LIST, redactCardMaterial, scanForCardMaterial } from "./hygiene.ts";
import { CONTRACT_TEXT } from "./contract.ts";
import { buildTwoFiatTools, type TwoFiatDeps } from "./tools.ts";
import { twoFiatAnnouncementContent } from "./announce-content.ts";

const OWNER_NPUB_HEX = "a".repeat(64);
const STRANGER_NPUB_HEX = "b".repeat(64);

/** A recording fake of the LOCAL adapter interface (never real credentials). */
function fakeAdapter(log: string[]) {
  return {
    async balance() {
      log.push("adapter.balance");
      return { currency: "USD", amount: "20.00", as_of: "2026-10-07T00:00:00Z" };
    },
    async capabilities() {
      log.push("adapter.capabilities");
      return {
        card_present: true,
        can_authorize: false as const,
        needs_human_3ds: true as const,
        adapter: "local" as const,
      };
    },
    async pay_checkout() {
      log.push("adapter.pay_checkout");
      return { status: "human_required" as const, order_id: "none" };
    },
  };
}

/** A processor whose invoices NEVER settle — for the unpaid-path test. */
const neverSettles: PaymentProcessor = {
  pmi: "bitcoin-cashu",
  async createInvoice(a: { orderId: string; amountSats: number }): Promise<Invoice> {
    return {
      orderId: a.orderId,
      paymentHash: "0".repeat(64),
      amountSats: a.amountSats,
      request: "cashuB-TEST-NEVER-SETTLES",
      pmi: "bitcoin-cashu",
    };
  },
  async verify(): Promise<boolean> {
    return false;
  },
};

function deps(over: Partial<TwoFiatDeps> = {}): TwoFiatDeps {
  const calls: string[] = [];
  const base: TwoFiatDeps = {
    adapter: fakeAdapter(calls),
    ownerNpub: OWNER_NPUB_HEX,
    adapterCalls: calls,
    ...over,
  };
  if (base.priceSats && base.priceSats > 0 && !base.gate) {
    base.gate = new ExplicitGate(neverSettles);
  }
  return base;
}

function toolByName(tools: ReturnType<typeof buildTwoFiatTools>, name: string) {
  const t = tools.find((t) => t.definition.name === name);
  if (!t) throw new Error(`tool ${name} not found`);
  return t;
}

describe("cvm-2fiat hygiene", () => {
  test("the refusal list names every refused capability", () => {
    for (const fragment of [
      "card.details",
      "payment.authorize",
      "charge",
      "card.create",
      "card.fund",
    ]) {
      expect(REFUSAL_LIST.join("\n")).toContain(fragment);
    }
  });

  test("no tool response contains PAN-, CVV- or token-shaped material", async () => {
    const tools = buildTwoFiatTools(deps());
    // Poison values are CONSTRUCTED at runtime from short fragments so that no
    // credential-shaped literal ever exists in a tracked file (manager rule 1:
    // nothing 2fiat may appear in any test fixture). Each is a well-known
    // synthetic TEST shape, never a real value.
    const poison = {
      pan: "4" + "1".repeat(15), // classic test PAN shape
      cvv: "1" + "23",
      cvv4: "45" + "67",
      token: "token" + "1" + "synthetic0000000000000000",
      note: "card " + "5" + "500001234" + "567890" + " code " + "9" + "99",
    };
    for (const t of tools) {
      let out: unknown;
      try {
        out = await t.handler({ ...poison, ...{ checkout_url: "https://pay.example/ord/1" } }, {
          caller: STRANGER_NPUB_HEX,
        });
      } catch (e) {
        out = (e as Error).message + " " + JSON.stringify((e as Error & { data?: unknown }).data ?? {});
      }
      const hits = scanForCardMaterial(JSON.stringify(out));
      expect(hits).toEqual([]);
    }
  });

  test("redactCardMaterial strips credential shapes from arbitrary text", async () => {
    // Constructed at runtime: no credential-shaped literal in a tracked file.
    const dirty =
      "balance ok; pan " + "42" + "42".repeat(6) + " cvv " + "3" + "13 last4 " +
      "42" + "42 " + "token" + "1" + "abcdef0123456789";
    const clean = redactCardMaterial(dirty);
    expect(scanForCardMaterial(clean)).toEqual([]);
    expect(clean).toContain("balance ok");
    // and the detector itself catches the dirty input
    expect(scanForCardMaterial(dirty).length).toBeGreaterThan(0);
  });
});

describe("cvm-2fiat card.balance", () => {
  test("refuses a non-owner pubkey BEFORE any adapter work", async () => {
    const d = deps();
    const tools = buildTwoFiatTools(d);
    const balance = toolByName(tools, "card.balance");
    let refused: unknown = null;
    try {
      await balance.handler({}, { caller: STRANGER_NPUB_HEX });
    } catch (e) {
      refused = e;
    }
    expect(refused).not.toBeNull();
    expect(d.adapterCalls).toEqual([]); // no adapter call ever happened
    expect(String((refused as Error).message)).toContain("payment_required");
    expect(
      JSON.stringify((refused as Error & { data?: { note?: string } }).data ?? {}),
    ).toContain("owner");
  });

  test("an UNPAID caller never reaches the adapter path", async () => {
    // Even the owner must pass the payment gate when the service is in paid
    // mode: the gate throws payment_required and the adapter is untouched.
    const d = deps({ priceSats: 100 });
    const gate = d.gate!;
    expect(gate).toBeDefined();
    const tools = buildTwoFiatTools(d);
    const balance = toolByName(tools, "card.balance");
    let err: unknown = null;
    try {
      await balance.handler({}, { caller: OWNER_NPUB_HEX });
    } catch (e) {
      err = e;
    }
    expect(err).not.toBeNull();
    expect((err as Error & { code?: number }).code).toBe(-32002);
    expect(d.adapterCalls).toEqual([]); // unpaid -> adapter never entered
  });

  test("owner reads balance through the adapter (paid path settled)", async () => {
    const d = deps({ priceSats: 0 });
    const tools = buildTwoFiatTools(d);
    const balance = toolByName(tools, "card.balance");
    const out = (await balance.handler({}, { caller: OWNER_NPUB_HEX })) as Record<string, unknown>;
    expect(d.adapterCalls).toContain("adapter.balance");
    expect(out.balance).toEqual({ currency: "USD", amount: "20.00", as_of: expect.any(String) });
    expect(scanForCardMaterial(JSON.stringify(out))).toEqual([]);
  });

  test("when the adapter is unconfigured, the tool refuses rail_unavailable, never fabricates", async () => {
    const d = deps({ adapter: undefined, adapterCalls: [] });
    const tools = buildTwoFiatTools(d);
    const balance = toolByName(tools, "card.balance");
    let err: unknown = null;
    try {
      await balance.handler({}, { caller: OWNER_NPUB_HEX });
    } catch (e) {
      err = e;
    }
    expect(String((err as Error & { reason?: string }).reason)).toBe("rail_unavailable");
    expect(scanForCardMaterial(String(JSON.stringify(err)))).toEqual([]);
  });
});

describe("cvm-2fiat payment.quote", () => {
  test("returns the own-card hand-off instructions for a valid checkout URL", async () => {
    const tools = buildTwoFiatTools(deps());
    const quote = toolByName(tools, "payment.quote");
    const out = (await quote.handler(
      { checkout_url: "https://pay.example.com/ord/abc123", amount: "12.50" },
      { caller: STRANGER_NPUB_HEX },
    )) as Record<string, unknown>;
    expect(out.checkout_url).toBe("https://pay.example.com/ord/abc123");
    expect(String(out.instructions)).toContain("own card");
    expect(String(out.instructions)).toContain("3DS");
  });

  test("refuses a non-https, non-checkout URL", async () => {
    const tools = buildTwoFiatTools(deps());
    const quote = toolByName(tools, "payment.quote");
    for (const bad of ["http://pay.example.com/x", "ftp://x/y", "not a url", ""]) {
      let err: unknown = null;
      try {
        await quote.handler({ checkout_url: bad }, { caller: STRANGER_NPUB_HEX });
      } catch (e) {
        err = e;
      }
      expect(String((err as Error)?.message ?? err)).toContain("checkout_url");
    }
  });
});

describe("cvm-2fiat docs + rail_info", () => {
  test("docs serves the contract verbatim, and it carries the refusal list", async () => {
    const tools = buildTwoFiatTools(deps());
    const docs = toolByName(tools, "docs");
    const out = (await docs.handler({}, { caller: STRANGER_NPUB_HEX })) as Record<string, unknown>;
    expect(out.content ?? out.text ?? out).toBe(CONTRACT_TEXT);
    for (const line of REFUSAL_LIST) {
      expect(CONTRACT_TEXT).toContain(line);
    }
  });

  test("rail_info says what the rail is NOT", async () => {
    const tools = buildTwoFiatTools(deps());
    const info = toolByName(tools, "card.rail_info");
    const out = JSON.stringify(await info.handler({}, { caller: STRANGER_NPUB_HEX }));
    for (const fragment of ["no card-number disclosure", "no payment authorization", "3DS"]) {
      expect(out).toContain(fragment);
    }
  });
});

describe("cvm-2fiat announcement", () => {
  test("the announced content carries the refusal list; no tier tag for a field-less service", () => {
    const emitted = twoFiatAnnouncementContent();
    for (const line of REFUSAL_LIST) {
      expect(emitted.content).toContain(line);
    }
    expect(emitted.tierTag).toBeUndefined(); // unclassified: no cvm:tier:* tag
    expect(emitted.requiredInputs).toBeUndefined();
    expect(emitted.optionalInputs).toBeUndefined();
    // tools announced: exactly the free/owner tools, nothing else
    expect(emitted.tools.sort()).toEqual(
      ["card.rail_info", "payment.quote", "card.balance", "docs"].sort(),
    );
  });
});
