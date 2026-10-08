export interface HealthReport {
  status: string;
  [k: string]: unknown;
}

export interface HealthOptions {
  service: string;
  /** Bind port; 0 disables. */
  port: number;
  hostname?: string;
  /** Deployed kit commit (SHA), surfaced on /health so "what is running?" is
   *  answerable without SSH archaeology. */
  commit?: string;
  /** Deployed kit ref (tag/branch/SHA) as pinned in the deploy. */
  ref?: string;
  /** Extra health info (e.g. treasury balance), evaluated per /health request. */
  report?: () => Promise<HealthReport> | HealthReport;
}

/** Pure body builder for /health — exported for tests (no server needed). */
export function buildHealthBody(
  opts: Pick<HealthOptions, "service" | "commit" | "ref">,
  startedAtMs: number,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    service: opts.service,
    uptime_s: Math.floor((Date.now() - startedAtMs) / 1000),
    ...extra,
  };
  if (opts.commit) body.commit = opts.commit;
  if (opts.ref) body.ref = opts.ref;
  return body;
}

/** Tiny loopback HTTP health/metrics server for a wrapper CVM. */
export function startHealthServer(opts: HealthOptions): { stop: () => void } {
  const started = Date.now();
  const server = Bun.serve({
    port: opts.port,
    hostname: opts.hostname ?? "127.0.0.1",
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      if (url.pathname === "/health") {
        let extra: Record<string, unknown> = {};
        if (opts.report) {
          try {
            extra = await opts.report();
          } catch (e: any) {
            extra = { error: String(e?.message ?? e) };
          }
        }
        return Response.json(buildHealthBody(opts, started, extra));
      }
      if (url.pathname === "/metrics") {
        const m = process.memoryUsage();
        const lines = [
          `cvm_uptime_seconds ${Math.floor((Date.now() - started) / 1000)}`,
          `cvm_rss_bytes ${m.rss}`,
          `cvm_heap_used_bytes ${m.heapUsed}`,
        ];
        return new Response(lines.join("\n") + "\n", {
          headers: { "content-type": "text/plain; version=0.0.4" },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  console.error(`[health] listening on 127.0.0.1:${opts.port}`);
  return { stop: () => server.stop(true) };
}
