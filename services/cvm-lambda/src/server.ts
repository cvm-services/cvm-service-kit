import { randomUUID } from "node:crypto";
import {
  CvmServer,
  publishAnnouncement,
  secretKeyFrom,
  pubkeyHexOf,
  type Tool,
} from "../../../src/index.ts";
import { executeOnAdapter } from "./adapter.ts";
import { resolveLanguage } from "./languages.ts";
import { JobManager, type JobResult } from "./jobs.ts";

const RELAYS_DEFAULT = [
  "wss://nostr.mom",
  "wss://relay.primal.net",
  "wss://nos.lol",
  "wss://relay2.contextvm.org",
];

interface Config {
  secretKey: string;
  relays: string[];
  socket: string;
  d: string;
  serviceClass: string;
  priceSats: number;
  maxTimeoutMs: number;
  maxOutputBytes: number;
  jobDb: string;
  announce: boolean;
}

function configFromEnv(env: Record<string, string | undefined>): Config {
  const secretKey = env.SERVER_SECRET_KEY ?? env.SERVER_HEX;
  if (!secretKey) throw new Error("SERVER_SECRET_KEY is required (64 hex chars)");
  return {
    secretKey,
    relays: (env.RELAYS ?? RELAYS_DEFAULT.join(",")).split(",").map((s) => s.trim()).filter(Boolean),
    socket: env.ADAPTER_SOCKET ?? "/run/loom/adapter.sock",
    d: env.ANNOUNCE_D ?? "cvm-lambda-01",
    serviceClass: env.SERVICE_CLASS ?? "compute",
    priceSats: Number(env.PRICE_RUN_CODE_SATS ?? "0"),
    maxTimeoutMs: Number(env.MAX_TIMEOUT_MS ?? "60000"),
    maxOutputBytes: Number(env.MAX_OUTPUT_BYTES ?? "65536"),
    jobDb: env.JOB_DB ?? "/var/lib/loom/cvm-lambda/jobs.sqlite",
    announce: (env.ANNOUNCE ?? "true") !== "false",
  };
}

function truncate(s: string, max: number): { text: string; truncated: boolean } {
  if (s.length <= max) return { text: s, truncated: false };
  return { text: s.slice(0, max), truncated: true };
}

async function runOnce(
  cfg: Config,
  args: Record<string, unknown>,
): Promise<JobResult & { truncated: boolean }> {
  const language = String(args.language ?? "");
  const code = String(args.code ?? "");
  const spec = resolveLanguage(language);
  const timeoutMs = Math.min(
    Number(args.timeout_ms ?? cfg.maxTimeoutMs),
    cfg.maxTimeoutMs,
  );
  const env = { ...spec.env, ...(args.env as Record<string, string> | undefined) };

  const result = await executeOnAdapter(
    cfg.socket,
    {
      identifier: randomUUID(),
      cmd: spec.cmd,
      args: spec.args,
      stdin: code + (args.stdin ? String(args.stdin) : ""),
      env,
    },
    { timeoutMs },
  );

  const out = truncate(result.stdout, cfg.maxOutputBytes);
  const errOut = truncate(result.stderr, cfg.maxOutputBytes);
  return {
    exit_code: result.exitCode,
    stdout: out.text,
    stderr: errOut.text,
    duration_ms: result.durationMs,
    truncated: out.truncated || errOut.truncated,
  };
}

export function buildTools(cfg: Config, jobs: JobManager): Tool[] {
  const runCode: Tool = {
    definition: {
      name: "run_code",
      description:
        "Run a code snippet in an isolated Firecracker microVM and return stdout/stderr/exit code.",
      priceSats: cfg.priceSats > 0 ? cfg.priceSats : undefined,
      inputSchema: {
        type: "object",
        required: ["language", "code"],
        properties: {
          language: { type: "string", description: "python3|node|bash|go|rustc" },
          code: { type: "string" },
          stdin: { type: "string" },
          env: { type: "object", additionalProperties: { type: "string" } },
          timeout_ms: { type: "number" },
        },
      },
    },
    handler: (args) => runOnce(cfg, args),
  };

  const submitJob: Tool = {
    definition: {
      name: "submit_job",
      description: "Queue a code snippet for asynchronous execution; returns a job id.",
      inputSchema: {
        type: "object",
        required: ["language", "code"],
        properties: {
          language: { type: "string" },
          code: { type: "string" },
          stdin: { type: "string" },
          env: { type: "object", additionalProperties: { type: "string" } },
          timeout_ms: { type: "number" },
        },
      },
    },
    handler: (args, ctx) => {
      const id = jobs.submit(ctx.caller, String(args.language ?? ""));
      void jobs.run(id, () => runOnce(cfg, args));
      return { job_id: id, status: "queued" };
    },
  };

  const jobStatus: Tool = {
    definition: {
      name: "job_status",
      description: "Return the status of a submitted job.",
      inputSchema: {
        type: "object",
        required: ["job_id"],
        properties: { job_id: { type: "string" } },
      },
    },
    handler: (args) => {
      const j = jobs.get(String(args.job_id ?? ""));
      if (!j) return { error: "unknown job_id" };
      return { job_id: j.id, status: j.status, exit_code: j.exitCode, error: j.error };
    },
  };

  const jobResult: Tool = {
    definition: {
      name: "job_result",
      description: "Return the result of a completed job.",
      inputSchema: {
        type: "object",
        required: ["job_id"],
        properties: { job_id: { type: "string" } },
      },
    },
    handler: (args) => {
      const j = jobs.get(String(args.job_id ?? ""));
      if (!j) return { error: "unknown job_id" };
      if (j.status !== "succeeded" && j.status !== "failed") {
        return { job_id: j.id, status: j.status };
      }
      return {
        job_id: j.id,
        status: j.status,
        exit_code: j.exitCode,
        stdout: j.stdout,
        stderr: j.stderr,
        duration_ms: j.durationMs,
        error: j.error,
      };
    },
  };

  const availability: Tool = {
    definition: {
      name: "availability",
      description: "Report which languages and limits the service can currently serve.",
      inputSchema: { type: "object", properties: {} },
    },
    handler: () => ({
      status: "ok",
      languages: ["python3", "node", "bash", "go", "rustc"],
      max_timeout_ms: cfg.maxTimeoutMs,
      max_output_bytes: cfg.maxOutputBytes,
      price_sats: cfg.priceSats,
    }),
  };

  return [runCode, submitJob, jobStatus, jobResult, availability];
}

async function main() {
  const cfg = configFromEnv(process.env);
  const sk = secretKeyFrom(cfg.secretKey);
  const jobs = new JobManager(cfg.jobDb);
  const tools = buildTools(cfg, jobs);

  const server = new CvmServer({
    secretKey: sk,
    relays: cfg.relays,
    name: "cvm-lambda",
    tools,
    onLog: (l) => console.error(`[cvm-lambda] ${l}`),
  });

  await server.start();
  console.log(`[cvm-lambda] pubkey: ${pubkeyHexOf(sk)}`);
  console.log(`[cvm-lambda] adapter: ${cfg.socket}`);

  if (cfg.announce) {
    await publishAnnouncement(
      server,
      {
        d: cfg.d,
        serviceClass: cfg.serviceClass,
        about: "Serverless code execution in Firecracker microVMs.",
        keywords: ["code", "compute", "sandbox", "lambda"],
        requiredInputs: [],
        optionalInputs: [],
        pmi: ["bitcoin-cashu", "bitcoin-lightning-bolt11"],
      },
      { secretKey: sk, relays: cfg.relays, name: "cvm-lambda", tools },
    );
    console.log("[cvm-lambda] announced 11316/11317");
  }

  const shutdown = () => {
    server.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (import.meta.main) {
  main().catch((e) => {
    console.error("FATAL:", e);
    process.exit(1);
  });
}
