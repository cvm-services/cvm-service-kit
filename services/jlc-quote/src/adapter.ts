/**
 * adapter.ts — the ONLY module that touches a browser, a subprocess or the disk.
 *
 * Everything above it (`parse.ts`, `tools.ts`) is pure and injected, which is
 * what makes the honesty invariants testable without a browser: the tool layer
 * consumes a `BrowserRun` and could not care less whether it came from a live
 * Chrome or from a fixture.
 *
 * THE SEAM IS ONE METHOD. `JlcAdapter.capture()` returns the page text VERBATIM
 * plus the diagnostic facts. It does not return a price. Deciding what the page
 * said is `parse.ts`'s job, in TypeScript, under test — a subprocess must not be
 * the thing that decides whether a price is real.
 *
 * NO CREDENTIAL VALUE IS READ, LOGGED, PRINTED OR RETURNED HERE. The Chrome
 * profile holds the session; this module passes its PATH only.
 */
import type { BrowserRun } from "./types.ts";

/** Exactly one of `zip_path` / `zip_base64` — validated in tools.ts. */
export interface PreparedInput {
  zipPath: string;
  /** Where the zip came from, for the response's provenance line. */
  origin: "zip_path" | "zip_base64";
  /** True when this adapter created the file and should clean it up. */
  ephemeral: boolean;
}

export interface JlcAdapter {
  capture(input: PreparedInput): Promise<BrowserRun>;
}

export interface LiveAdapterConfig {
  /** e.g. /home/<operator>/venvs/pw/bin/python — the Playwright venv, NOT /usr/bin/python3. */
  pythonBin: string;
  /**
   * The checkout of the WRAPPED client (`jlcpcb_client/`). Used as the child's
   * cwd and PYTHONPATH. This is NOT where the capture script lives — see
   * `captureScript`. Conflating the two is a real bug that was hit here: the
   * script is in the SERVICE tree, and pointing at the client repo made the child
   * exit 2 without printing anything.
   */
  clientDir: string;
  /**
   * The capture script itself — this service's own `tools/capture_page.py`,
   * resolved relative to this module so a worktree works without configuration.
   */
  captureScript: string;
  /** Input directory for gerber zips. MUST live outside /tmp. */
  inputDir: string;
  /** Persistent Chrome profile that holds the JLCPCB session. A PATH, not a secret. */
  profileDir: string;
  /** Where raw page text is archived (the evidence that makes a regression diffable). */
  snapshotDir: string;
  /** X display, e.g. ":99" (Xvfb). */
  display: string;
  /** The Chrome binary. Playwright's bundled Chromium is MISSING on this box. */
  chromePath: string;
  timeoutMs: number;
  /** Extra environment for the child (never printed). */
  env?: Record<string, string | undefined>;
  /** Injection point for tests. Defaults to Bun.spawnSync. */
  spawn?: SpawnFn;
}

export interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

export type SpawnFn = (
  cmd: string[],
  opts: { cwd: string; env: Record<string, string | undefined>; timeoutMs: number },
) => SpawnResult;

const EMPTY_RUN: BrowserRun = {
  raw_text: "",
  url: "",
  authenticated: false,
  session_message: "",
  client_price_usd: null,
  client_error: "",
  error: "",
};

/** Default spawn: a synchronously-awaited child with a hard deadline. */
export const defaultSpawn: SpawnFn = (cmd, opts) => {
  const proc = Bun.spawnSync({
    cmd,
    cwd: opts.cwd,
    env: opts.env as Record<string, string>,
    stdout: "pipe",
    stderr: "pipe",
    timeout: opts.timeoutMs,
  });
  const signal = (proc as { signalCode?: string | null }).signalCode ?? null;
  return {
    stdout: proc.stdout?.toString("utf8") ?? "",
    stderr: proc.stderr?.toString("utf8") ?? "",
    exitCode: proc.exitCode,
    // A killed child (SIGTERM/SIGKILL from the deadline) has no exit code.
    timedOut: proc.exitCode === null || signal === "SIGTERM" || proc.exitCode === 124,
  };
};

/**
 * The live adapter. Spawns the wrapped client's capture script.
 *
 * Failure of the browser leg is NOT an exception here: it becomes a
 * `BrowserRun.error`, and the tool layer turns that into a VISIBLE refusal. A
 * throw that unwinds into the transport is how a refusal turns into a timeout,
 * and a timeout reads exactly like "still working".
 */
export class LiveJlcAdapter implements JlcAdapter {
  constructor(private readonly cfg: LiveAdapterConfig) {}

  async capture(input: PreparedInput): Promise<BrowserRun> {
    const spawn = this.cfg.spawn ?? defaultSpawn;
    const cmd = [this.cfg.pythonBin, this.cfg.captureScript, input.zipPath, this.cfg.snapshotDir];

    let res: SpawnResult;
    try {
      res = spawn(cmd, {
        cwd: this.cfg.clientDir,
        env: {
          ...process.env,
          ...this.cfg.env,
          // The browser leg's three real requirements, each of which cost time:
          DISPLAY: this.cfg.display,
          JLC_PROFILE: this.cfg.profileDir,
          JLC_CHROME: this.cfg.chromePath,
          // Make `python -m` / `import jlcpcb_client` work from any cwd.
          PYTHONPATH: this.cfg.clientDir,
          PYTHONDONTWRITEBYTECODE: "1",
        },
        timeoutMs: this.cfg.timeoutMs,
      });
    } catch (e) {
      return {
        ...EMPTY_RUN,
        error: `could not start the capture subprocess: ${(e as Error).message}`,
      };
    }

    if (res.timedOut) {
      return {
        ...EMPTY_RUN,
        error: `the capture subprocess exceeded its ${Math.round(this.cfg.timeoutMs / 1000)}s deadline`,
      };
    }

    // The script prints exactly one JSON object. Anything else means the child
    // died before it could report (a missing venv, a syntax error) — and that is
    // a diagnostic to report, never a value to invent.
    let parsed: Partial<BrowserRun> | null = null;
    try {
      parsed = JSON.parse(res.stdout.trim()) as Partial<BrowserRun>;
    } catch {
      parsed = null;
    }
    if (parsed === null) {
      const detail = (res.stderr || res.stdout).trim().split("\n").slice(-3).join(" | ");
      return {
        ...EMPTY_RUN,
        error:
          `the capture subprocess printed no JSON report (exit ${String(res.exitCode)}): ` +
          (detail ? detail.slice(0, 400) : "no output"),
      };
    }

    return {
      raw_text: typeof parsed.raw_text === "string" ? parsed.raw_text : "",
      url: typeof parsed.url === "string" ? parsed.url : "",
      authenticated: parsed.authenticated === true,
      session_message: typeof parsed.session_message === "string" ? parsed.session_message : "",
      client_price_usd:
        typeof parsed.client_price_usd === "number" && Number.isFinite(parsed.client_price_usd)
          ? parsed.client_price_usd
          : null,
      client_error: typeof parsed.client_error === "string" ? parsed.client_error : "",
      error: typeof parsed.error === "string" ? parsed.error : "",
    };
  }
}

/** Read env into a live config, with the defaults this host was measured with. */
export function liveConfigFromEnv(
  env: Record<string, string | undefined>,
  over: Partial<LiveAdapterConfig> = {},
): LiveAdapterConfig {
  const home = env.HOME ?? "/home/c03rad0r";
  return {
    pythonBin: env.JLC_PYTHON ?? `${home}/venvs/pw/bin/python`,
    clientDir: env.JLC_CLIENT_DIR ?? `${home}/repos/jlcpcb-service`,
    // Resolved from this module, so a git worktree, a deployed checkout and a
    // test run all find the script without configuration.
    captureScript:
      env.JLC_CAPTURE_SCRIPT ??
      new URL("../tools/capture_page.py", import.meta.url).pathname,
    inputDir: env.JLC_INPUT_DIR ?? `${home}/jlc-quote-inputs`,
    profileDir: env.JLC_PROFILE ?? `${home}/.hermes/profiles/manager/state/jlc-browser9`,
    snapshotDir: env.JLC_SNAPSHOT_DIR ?? `${home}/repos/jlcpcb-service/snapshots`,
    display: env.JLC_DISPLAY ?? ":99",
    chromePath: env.JLC_CHROME ?? "/usr/bin/google-chrome",
    timeoutMs: Number(env.JLC_TIMEOUT_MS ?? "360000"),
    ...over,
  };
}
