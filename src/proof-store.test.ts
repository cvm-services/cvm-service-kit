import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryProofStore, SqliteProofStore } from "./proof-store.ts";

for (const [name, make] of [
  ["MemoryProofStore", () => new MemoryProofStore()],
  ["SqliteProofStore", () => new SqliteProofStore(join(mkdtempSync(join(tmpdir(), "ps-")), "p.sqlite"))],
] as const) {
  describe(name, () => {
    test("add/sum/all/remove round-trip", () => {
      const s = make();
      s.add([{ amount: 10, secret: "a" }, { amount: 20, secret: "b" }]);
      expect(s.sum()).toBe(30);
      expect(s.all().length).toBe(2);
      s.removeBySecrets(["a"]);
      expect(s.sum()).toBe(20);
    });

    test("add is idempotent per secret", () => {
      const s = make();
      s.add([{ amount: 5, secret: "x" }]);
      s.add([{ amount: 5, secret: "x" }]);
      expect(s.sum()).toBe(5);
    });
  });
}
