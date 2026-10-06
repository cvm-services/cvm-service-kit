/**
 * Maps a user-facing language to the command the guest runs. Code is fed on
 * stdin and written to a temp file by `sh -c`, so the adapter needs no changes
 * for arbitrary-code execution.
 */
export interface LanguageSpec {
  /** Adapter `cmd`. */
  cmd: string;
  /** Adapter `args`. */
  args: string[];
  /** Guest env additions. */
  env: Record<string, string>;
}

const WRAP = (file: string, run: string) =>
  `cat > ${file} && ${run}`;

export const LANGUAGES: Record<string, LanguageSpec> = {
  python: {
    cmd: "sh",
    args: ["-c", WRAP("/tmp/main.py", "exec python3 -u /tmp/main.py")],
    env: { PYTHONUNBUFFERED: "1" },
  },
  python3: {
    cmd: "sh",
    args: ["-c", WRAP("/tmp/main.py", "exec python3 -u /tmp/main.py")],
    env: { PYTHONUNBUFFERED: "1" },
  },
  node: {
    cmd: "sh",
    args: ["-c", WRAP("/tmp/main.js", "exec node /tmp/main.js")],
    env: {},
  },
  javascript: {
    cmd: "sh",
    args: ["-c", WRAP("/tmp/main.js", "exec node /tmp/main.js")],
    env: {},
  },
  bash: {
    cmd: "sh",
    args: ["-c", WRAP("/tmp/main.sh", "exec bash /tmp/main.sh")],
    env: {},
  },
  sh: {
    cmd: "sh",
    args: ["-c", WRAP("/tmp/main.sh", "exec sh /tmp/main.sh")],
    env: {},
  },
  go: {
    cmd: "sh",
    args: [
      "-c",
      "cat > /tmp/main.go && cd /tmp && exec go run main.go",
    ],
    env: {
      HOME: "/tmp",
      GOPATH: "/tmp/go",
      GOCACHE: "/tmp/go-cache",
      GOFLAGS: "-mod=mod",
      GOPROXY: "off",
    },
  },
  rust: {
    cmd: "sh",
    args: [
      "-c",
      "cat > /tmp/main.rs && rustc -O -o /tmp/main /tmp/main.rs && exec /tmp/main",
    ],
    env: { HOME: "/tmp" },
  },
  rustc: {
    cmd: "sh",
    args: [
      "-c",
      "cat > /tmp/main.rs && rustc -O -o /tmp/main /tmp/main.rs && exec /tmp/main",
    ],
    env: { HOME: "/tmp" },
  },
};

export function resolveLanguage(name: string): LanguageSpec {
  const spec = LANGUAGES[name.toLowerCase()];
  if (!spec) {
    throw new Error(
      `unsupported language '${name}'; supported: ${Object.keys(LANGUAGES).join(", ")}`,
    );
  }
  return spec;
}
