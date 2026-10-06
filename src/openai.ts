import { callHttp, type FetchLike } from "./http.ts";

export interface OpenAiConfig {
  /** e.g. https://api.ppq.ai/v1 */
  baseUrl: string;
  apiKey?: string;
  timeoutMs?: number;
}

function authHeaders(cfg: OpenAiConfig): Record<string, string> {
  return cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {};
}

/** POST /chat/completions (OpenAI-compatible). */
export async function chatCompletions(
  cfg: OpenAiConfig,
  body: Record<string, unknown>,
  fetchImpl?: FetchLike,
): Promise<any> {
  const r = await callHttp(
    {
      method: "POST",
      url: `${cfg.baseUrl}/chat/completions`,
      headers: authHeaders(cfg),
      body,
      timeoutMs: cfg.timeoutMs ?? 120_000,
    },
    {},
    { fetchImpl, substitute: false },
  );
  if (!r.ok) {
    const detail = typeof r.body === "string" ? r.body.slice(0, 300) : JSON.stringify(r.body).slice(0, 300);
    throw new Error(`upstream ${r.status}: ${detail}`);
  }
  return r.body;
}

/** GET /models. */
export async function listModels(cfg: OpenAiConfig, fetchImpl?: FetchLike): Promise<any> {
  const r = await callHttp(
    { url: `${cfg.baseUrl}/models`, headers: authHeaders(cfg), timeoutMs: 30_000 },
    {},
    { fetchImpl, substitute: false },
  );
  if (!r.ok) throw new Error(`upstream ${r.status}`);
  return r.body;
}
