import { connect } from "node:net";

export interface ExecuteRequest {
  identifier: string;
  cmd: string;
  args: string[];
  stdin: string;
  env: Record<string, string>;
}

export interface ExecuteResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

/**
 * Client for the Loom Firecracker adapter's line-delimited JSON protocol over a
 * Unix socket. See loom-adapter-firecracker src/config.rs for the wire format.
 */
export function executeOnAdapter(
  socketPath: string,
  req: ExecuteRequest,
  opts: { timeoutMs?: number } = {},
): Promise<ExecuteResult> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  return new Promise((resolve, reject) => {
    const sock = connect(socketPath);
    let buf = "";
    let stdout = "";
    let stderr = "";
    let done = false;

    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.destroy();
      fn();
    };

    const timer = setTimeout(
      () => finish(() => reject(new Error(`adapter timeout after ${timeoutMs}ms`))),
      timeoutMs,
    );

    sock.on("connect", () => sock.write(JSON.stringify({ type: "execute", ...req }) + "\n"));
    sock.on("error", (e) => finish(() => reject(e)));
    sock.on("close", () =>
      finish(() => reject(new Error("adapter closed before completion"))),
    );

    sock.on("data", (chunk) => {
      buf += chunk.toString();
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        switch (msg.type) {
          case "started":
            break;
          case "stdout":
            stdout += msg.data ?? "";
            break;
          case "stderr":
            stderr += msg.data ?? "";
            break;
          case "completed":
            finish(() =>
              resolve({
                exitCode: msg.exitCode ?? -1,
                stdout,
                stderr,
                durationMs: msg.duration ?? 0,
              }),
            );
            return; // stop processing this buffer
          case "error":
            finish(() => reject(new Error(msg.error ?? "adapter error")));
            return;
        }
      }
    });
  });
}
