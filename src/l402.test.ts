import { describe, expect, test } from "bun:test";
import { fetchWithL402, parseChallengeBody, parseWwwAuthenticate } from "./l402.ts";
import { FakeLnWallet } from "./lnwallet.ts";

describe("parse challenge", () => {
  test("WWW-Authenticate header", () => {
    const ch = parseWwwAuthenticate('L402 macaroon="abc", invoice="lnbc1"');
    expect(ch).toEqual({ macaroon: "abc", invoice: "lnbc1" });
  });
  test("non-L402 header ignored", () => {
    expect(parseWwwAuthenticate('Bearer realm="x"')).toBeNull();
  });
  test("JSON body challenge", () => {
    expect(parseChallengeBody({ macaroon: "m", invoice: "lnbc" })).toEqual({ macaroon: "m", invoice: "lnbc" });
    expect(parseChallengeBody({ token: "m", payreq: "lnbc" })).toEqual({ macaroon: "m", invoice: "lnbc" });
    expect(parseChallengeBody({ nope: 1 })).toBeNull();
  });
});

describe("fetchWithL402", () => {
  test("pays the invoice and replays with authorization", async () => {
    const calls: any[] = [];
    const fetchImpl = async (url: string, init: any) => {
      calls.push({ url, auth: init?.headers?.get?.("authorization") ?? init?.headers?.Authorization });
      if (calls.length === 1) {
        return {
          status: 402,
          ok: false,
          headers: new Headers(),
          text: async () => JSON.stringify({ macaroon: "mac", invoice: "lnbc1n1fake" }),
        } as any;
      }
      return {
        status: 200,
        ok: true,
        headers: new Headers(),
        text: async () => JSON.stringify({ done: true }),
      } as any;
    };
    const wallet = new FakeLnWallet();
    const r = await fetchWithL402("https://api.test/order", {}, wallet, { fetchImpl: fetchImpl as any });
    expect(wallet.paid).toEqual(["lnbc1n1fake"]);
    expect(r.preimage).toBeDefined();
    expect((r.response as any).status).toBe(200);
    expect(r.body).toEqual({ done: true });
  });

  test("non-402 passes through untouched", async () => {
    const fetchImpl = async () =>
      ({ status: 200, ok: true, headers: new Headers(), text: async () => '"x"' }) as any;
    const wallet = new FakeLnWallet();
    const r = await fetchWithL402("https://api.test/x", {}, wallet, { fetchImpl: fetchImpl as any });
    expect(r.body).toBe("x");
    expect(wallet.paid.length).toBe(0);
  });
});
