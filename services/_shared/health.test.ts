import { describe, expect, it } from "bun:test";
import { buildHealthBody } from "./health.ts";

describe("buildHealthBody", () => {
  it("includes commit and ref when provided", () => {
    const body = buildHealthBody(
      { service: "cvm-nanogpt", commit: "b523c9c90f3aac4a8acf394ada78ec42101e936d", ref: "v0.2.0" },
      Date.now() - 5000,
    );
    expect(body.service).toBe("cvm-nanogpt");
    expect(body.commit).toBe("b523c9c90f3aac4a8acf394ada78ec42101e936d");
    expect(body.ref).toBe("v0.2.0");
    expect(body.uptime_s).toBeGreaterThanOrEqual(4);
  });

  it("omits commit/ref when absent (legacy deploys report no SHA)", () => {
    const body = buildHealthBody({ service: "cvm-sms4sats" }, Date.now());
    expect(body.service).toBe("cvm-sms4sats");
    expect(body.commit).toBeUndefined();
    expect(body.ref).toBeUndefined();
  });

  it("merges the per-service report fields", () => {
    const body = buildHealthBody(
      { service: "cvm-sms4sats", commit: "abc123" },
      Date.now(),
      { status: "ok", treasury_balance_sats: 42 },
    );
    expect(body.status).toBe("ok");
    expect(body.treasury_balance_sats).toBe(42);
    expect(body.commit).toBe("abc123");
  });

  it("does not let a report field clobber the commit", () => {
    const body = buildHealthBody(
      { service: "x", commit: "sha-from-deploy" },
      Date.now(),
      { commit: "spoofed" } as Record<string, unknown>,
    );
    expect(body.commit).toBe("sha-from-deploy");
  });
});
