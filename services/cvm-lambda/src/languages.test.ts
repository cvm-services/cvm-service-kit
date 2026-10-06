import { describe, expect, test } from "bun:test";
import { resolveLanguage } from "./languages.ts";

describe("resolveLanguage", () => {
  test("python3 wraps via stdin", () => {
    const s = resolveLanguage("python3");
    expect(s.cmd).toBe("sh");
    expect(s.args.join(" ")).toContain("python3");
  });
  test("go sets an offline env", () => {
    const s = resolveLanguage("go");
    expect(s.env.GOPROXY).toBe("off");
    expect(s.args.join(" ")).toContain("go run");
  });
  test("rustc compiles and runs", () => {
    const s = resolveLanguage("rustc");
    expect(s.args.join(" ")).toContain("rustc");
  });
  test("unknown language fails loud", () =>
    expect(() => resolveLanguage("cobol")).toThrow(/unsupported language/));
});
