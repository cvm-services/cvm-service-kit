#!/usr/bin/env python3
"""Smoke-test the Loom adapter: run python/node/go/rustc snippets in the microVM."""
import json
import socket
import sys

SOCK = sys.argv[1] if len(sys.argv) > 1 else "/run/loom/adapter.sock"


def execute(identifier, cmd, args, stdin, env=None):
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(180)
    s.connect(SOCK)
    s.sendall(
        (
            json.dumps(
                {
                    "type": "execute",
                    "identifier": identifier,
                    "cmd": cmd,
                    "args": args,
                    "stdin": stdin,
                    "env": env or {},
                }
            )
            + "\n"
        ).encode()
    )
    out, err, code, buf = "", "", None, b""
    while True:
        chunk = s.recv(4096)
        if not chunk:
            break
        buf += chunk
        while b"\n" in buf:
            line, buf = buf.split(b"\n", 1)
            if not line.strip():
                continue
            m = json.loads(line)
            if m["type"] == "stdout":
                out += m["data"]
            elif m["type"] == "stderr":
                err += m["data"]
            elif m["type"] == "completed":
                s.close()
                return m.get("exitCode"), out, err, m.get("duration", 0)
            elif m["type"] == "error":
                s.close()
                raise RuntimeError(m.get("error"))
    s.close()
    return code, out, err, 0


CASES = [
    ("python3", "sh", ["-c", "cat > /tmp/m.py; exec python3 -u /tmp/m.py"], "print(1+1)"),
    ("node", "sh", ["-c", "cat > /tmp/m.js; exec node /tmp/m.js"], "console.log(2+2)"),
    ("go", "sh", ["-c", "cat > /tmp/main.go && cd /tmp && exec go run main.go"],
     "package main\nimport \"fmt\"\nfunc main(){fmt.Println(3+3)}"),
    ("rustc", "sh", ["-c", "cat > /tmp/m.rs && rustc -O -o /tmp/m /tmp/m.rs && exec /tmp/m"],
     "fn main(){println!(\"{}\", 4+4)}"),
]

GO_ENV = {"HOME": "/tmp", "GOPATH": "/tmp/go", "GOCACHE": "/tmp/go-cache", "GOPROXY": "off"}

fails = 0
for name, cmd, args, code in CASES:
    env = GO_ENV if name == "go" else {"HOME": "/tmp"}
    try:
        rc, out, err, dur = execute(name, cmd, args, code, env)
        ok = rc == 0 and out.strip() != ""
        print(f"[{'PASS' if ok else 'FAIL'}] {name}: rc={rc} dur={dur}ms out={out.strip()!r} err={err.strip()[:120]!r}")
        fails += 0 if ok else 1
    except Exception as e:  # noqa: BLE001
        print(f"[FAIL] {name}: {e}")
        fails += 1

sys.exit(1 if fails else 0)
