import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import { resolveDeployedCommit, resolveDeployedRef } from "./start.ts";

describe("deployed commit/ref resolution", () => {
  it("prefers the CVM_COMMIT env override", () => {
    expect(resolveDeployedCommit({ CVM_COMMIT: " deadbeef " })).toBe("deadbeef");
  });

  it("returns undefined when no env var and no marker file", () => {
    // No CVM_COMMIT set; the marker is absent in the repo (it is written at
    // deploy time), so resolution is undefined — health omits the field.
    expect(resolveDeployedCommit({})).toBeUndefined();
    expect(resolveDeployedRef({})).toBeUndefined();
  });

  it("falls back to the repo-root .deployed-sha marker when present", () => {
    // The module-relative fallback resolves to <repo>/.deployed-sha (start.ts
    // lives at services/_shared/). Create it, verify it is picked up, restore.
    const marker = new URL("../../.deployed-sha", import.meta.url).pathname;
    const existed = fs.existsSync(marker);
    if (!existed) fs.writeFileSync(marker, "cafebabe123\n");
    try {
      expect(resolveDeployedCommit({})).toBe("cafebabe123");
    } finally {
      if (!existed) fs.unlinkSync(marker);
    }
  });
});
