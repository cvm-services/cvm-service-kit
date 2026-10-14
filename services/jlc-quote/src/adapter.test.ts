/**
 * adapter.test.ts — the spawn seam.
 *
 * The adapter is the one place a subprocess is started, so it is also the one
 * place a failure could masquerade as a value. These tests inject a `spawn` and
 * assert that EVERY failure mode comes back as a `BrowserRun` carrying an
 * `error` and NO price — never as a throw the transport would turn into a
 * timeout, and never as a number.
 *
 * No browser is launched, no network is touched, no subprocess is really run.
 */
import { describe, expect, test } from "bun:test";
import { LiveJlcAdapter, liveConfigFromEnv, type SpawnResult } from "./adapter.ts";

const PREPARED = {
  zipPath: "/home/c03rad0r/jlc-quote-inputs/hub_v9.zip",
  origin: "zip_path" as const,
  ephemeral: false,
};

function cfg(stdout: string, over: Partial<SpawnResult> = {}) {
  const calls: string[][] = [];
  const adapter = new LiveJlcAdapter({
    ...liveConfigFromEnv({ HOME: "/home/c03rad0r" }),
    spawn: (cmd, opts) => {
      calls.push(cmd);
      // The three environment requirements, asserted at the seam that must set
      // them — this is where "Xvfb + executable_path" is actually enforced.
      expect(opts.env.DISPLAY).toBe(":99");
      expect(opts.env.JLC_CHROME).toBe("/usr/bin/google-chrome");
      expect(opts.env.JLC_PROFILE).toBe(
        "/home/c03rad0r/.hermes/profiles/manager/state/jlc-browser9",
      );
      expect(opts.cwd).toBe("/home/c03rad0r/repos/jlcpcb-service");
      expect(opts.timeoutMs).toBe(360000);
      return { stdout, stderr: "", exitCode: 0, timedOut: false, ...over };
    },
  });
  return { adapter, calls };
}

const REPORT = JSON.stringify({
  raw_text: "My Account\nCalculated Price\n$32.30\n",
  url: "https://cart.jlcpcb.com/quote",
  authenticated: true,
  session_message: "",
  client_price_usd: 32.3,
  client_error: "",
  error: "",
});

describe("LiveJlcAdapter — the capture seam", () => {
  test("spawns the capture script with the measured environment", async () => {
    const { adapter, calls } = cfg(REPORT);
    const run = await adapter.capture(PREPARED);
    // The script is resolved from THIS service's tree, not from the wrapped
    // client's — the client dir is the child's cwd/PYTHONPATH only. Conflating
    // the two made the child exit 2 with no output (a real bug, now covered).
    const expectedScript = new URL("../tools/capture_page.py", import.meta.url).pathname;
    expect(calls).toEqual([
      [
        "/home/c03rad0r/venvs/pw/bin/python",
        expectedScript,
        PREPARED.zipPath,
        "/home/c03rad0r/repos/jlcpcb-service/snapshots",
      ],
    ]);
    expect(expectedScript).toStartWith("/");
    expect(expectedScript).toContain("services/jlc-quote/tools/capture_page.py");
    expect(run.authenticated).toBe(true);
    expect(run.raw_text).toContain("Calculated Price");
    expect(run.error).toBe("");
  });

  test("a report with no price yields a run with no price — never a default", async () => {
    const loggedOut = JSON.stringify({
      raw_text: "Sign In\n",
      url: "https://jlcpcb.com/",
      authenticated: false,
      session_message: "profile is not authenticated",
      client_price_usd: null,
      client_error: "",
      error: "",
    });
    const { adapter } = cfg(loggedOut);
    const run = await adapter.capture(PREPARED);
    expect(run.authenticated).toBe(false);
    expect(run.client_price_usd).toBeNull();
    expect(run.error).toBe("");
  });
});

describe("LiveJlcAdapter — every failure is a run with an error, never a throw", () => {
  test("non-JSON output becomes an error, not an exception", async () => {
    const { adapter } = cfg("Traceback (most recent call last):\nImportError: no playwright\n", {
      exitCode: 1,
    });
    const run = await adapter.capture(PREPARED);
    expect(run.error).toContain("printed no JSON report");
    expect(run.raw_text).toBe("");
    expect(run.client_price_usd).toBeNull();
  });

  test("a deadline kill becomes an error naming the deadline", async () => {
    const { adapter } = cfg("", { exitCode: null, timedOut: true });
    const run = await adapter.capture(PREPARED);
    expect(run.error).toContain("360s deadline");
    expect(run.client_price_usd).toBeNull();
  });

  test("a spawn that throws becomes an error, not an exception", async () => {
    const adapter = new LiveJlcAdapter({
      ...liveConfigFromEnv({ HOME: "/home/c03rad0r" }),
      spawn: () => {
        throw new Error("ENOENT: python missing");
      },
    });
    const run = await adapter.capture(PREPARED);
    expect(run.error).toContain("could not start the capture subprocess");
    expect(run.error).toContain("ENOENT");
  });

  test("a non-numeric client_price_usd is dropped to null, not forwarded", async () => {
    const { adapter } = cfg(
      JSON.stringify({
        raw_text: "My Account\nCalculated Price\n$32.30\n",
        url: "",
        authenticated: true,
        session_message: "",
        client_price_usd: "32.30",
        client_error: "",
        error: "",
      }),
    );
    const run = await adapter.capture(PREPARED);
    expect(run.client_price_usd).toBeNull();
    // COUNTER-TEST: a real number IS forwarded, so the drop is about the type.
    const { adapter: good } = cfg(REPORT);
    expect((await good.capture(PREPARED)).client_price_usd).toBe(32.3);
  });
});

describe("liveConfigFromEnv — the environment the host was measured with", () => {
  test("defaults are the measured paths, and env overrides win", () => {
    const d = liveConfigFromEnv({ HOME: "/home/c03rad0r" });
    expect(d.pythonBin).toBe("/home/c03rad0r/venvs/pw/bin/python");
    expect(d.chromePath).toBe("/usr/bin/google-chrome");
    expect(d.display).toBe(":99");
    expect(d.inputDir).toBe("/home/c03rad0r/jlc-quote-inputs");
    expect(d.timeoutMs).toBe(360000);
    // The capture script is derived from this module, so a worktree, a deployed
    // checkout and a test run all resolve the same file with no configuration.
    expect(d.captureScript).toContain("services/jlc-quote/tools/capture_page.py");
    expect(d.captureScript).not.toContain("jlcpcb-service");

    const o = liveConfigFromEnv(
      { HOME: "/home/c03rad0r", JLC_DISPLAY: ":1", JLC_CHROME: "/opt/chrome", JLC_TIMEOUT_MS: "90000" },
    );
    expect(o.display).toBe(":1");
    expect(o.chromePath).toBe("/opt/chrome");
    expect(o.timeoutMs).toBe(90000);
    const s = liveConfigFromEnv({ HOME: "/home/c03rad0r", JLC_CAPTURE_SCRIPT: "/srv/x.py" });
    expect(s.captureScript).toBe("/srv/x.py");
  });
});
