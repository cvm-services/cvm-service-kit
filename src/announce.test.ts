import { describe, expect, test } from "bun:test";
import { announcementTags, computeTier } from "./announce.ts";
import type { CvmServerOptions } from "./types.ts";

const serverInfo: CvmServerOptions = {
  secretKey: "00".repeat(32),
  relays: [],
  name: "cvm-lambda",
  tools: [
    {
      definition: {
        name: "run_code",
        description: "run",
        inputSchema: {},
        priceSats: 10,
      },
      handler: () => ({}),
    },
  ],
};

describe("computeTier", () => {
  test("empty fields → none", () => expect(computeTier([])).toBe("none"));
  test("email → contact", () => expect(computeTier(["email"])).toBe("contact"));
  test("max wins", () => expect(computeTier(["email", "address"])).toBe("fulfilment"));
  test("unknown field fails loud", () =>
    expect(() => computeTier(["wat"])).toThrow(/unknown input field/));
});

describe("announcementTags", () => {
  test("publishes class, d, cap and no g", () => {
    const tags = announcementTags(
      { d: "lambda-01", serviceClass: "compute", requiredInputs: [], optionalInputs: [] },
      serverInfo,
    );
    const has = (n: string, v: string) => tags.some((t) => t[0] === n && t[1] === v);
    expect(has("d", "lambda-01")).toBe(true);
    expect(has("t", "cvm:service:compute")).toBe(true);
    expect(has("cap", "tool:run_code")).toBe(true);
    expect(has("t", "cvm:req:none")).toBe(true);
    expect(has("t", "cvm:tier:none")).toBe(true);
    expect(tags.some((t) => t[0] === "g")).toBe(false);
  });

  test("does not invent a tier when appetite is unknown", () => {
    const tags = announcementTags({ d: "x", serviceClass: "compute" }, serverInfo);
    expect(tags.some((t) => t[0] === "t" && t[1].startsWith("cvm:tier:"))).toBe(false);
  });
});

describe("the tier is COMPUTED, never supplied", () => {
  // A caller that could pass its own tier could understate what the service
  // collects (CEP-draft-0001 P15): this is the one lie a reader cannot detect,
  // because the reader recomputes from the same declared fields. The type must
  // not be able to express a tier, and the emitter must not read one.
  test("a caller-supplied tier is ignored: the recomputed tier is emitted", () => {
    const tags = announcementTags(
      {
        d: "lie-01",
        serviceClass: "compute",
        requiredInputs: ["email"],
        // @ts-expect-error tier is not part of the announce vocabulary — the emitter computes it
        tier: "none",
      },
      serverInfo,
    );
    const has = (n: string, v: string) => tags.some((t) => t[0] === n && t[1] === v);
    // email recomputes to contact; the supplied "none" must not appear
    expect(has("t", "cvm:tier:contact")).toBe(true);
    expect(has("t", "cvm:tier:none")).toBe(false);
  });
});
