import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeOnAdapter } from "./adapter.ts";

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

function fakeAdapter(socketPath: string, messages: any[]): Promise<void> {
  return new Promise((resolve) => {
    const srv = createServer((sock) => {
      sock.once("data", () => {
        for (const m of messages) sock.write(JSON.stringify(m) + "\n");
        sock.end();
      });
    });
    servers.push(srv);
    srv.listen(socketPath, () => resolve());
  });
}

describe("executeOnAdapter", () => {
  test("collects stdout/stderr and exit code", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loom-"));
    const sock = join(dir, "adapter.sock");
    await fakeAdapter(sock, [
      { type: "started" },
      { type: "stdout", data: "hello " },
      { type: "stdout", data: "world\n" },
      { type: "stderr", data: "warn\n" },
      { type: "completed", exitCode: 0, duration: 42 },
    ]);
    const r = await executeOnAdapter(sock, {
      identifier: "t",
      cmd: "sh",
      args: ["-c", "echo"],
      stdin: "",
      env: {},
    });
    expect(r).toEqual({ exitCode: 0, stdout: "hello world\n", stderr: "warn\n", durationMs: 42 });
  });

  test("adapter error rejects", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loom-"));
    const sock = join(dir, "adapter.sock");
    await fakeAdapter(sock, [{ type: "error", error: "boom" }]);
    await expect(
      executeOnAdapter(sock, { identifier: "t", cmd: "sh", args: [], stdin: "", env: {} }),
    ).rejects.toThrow(/boom/);
  });
});
