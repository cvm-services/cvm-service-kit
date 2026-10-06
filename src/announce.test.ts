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
