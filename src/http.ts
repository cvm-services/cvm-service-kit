/** Declarative tool→HTTP bridge for wrapping third-party REST APIs. */

export interface HttpSpec {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  /** URL template; `{name}` is substituted from the tool arguments. */
  url: string;
  /** Query params; values are templates and substituted. */
  query?: Record<string, string | number>;
  headers?: Record<string, string>;
  /** JSON body template; string values inside are substituted. */
  body?: unknown;
  timeoutMs?: number;
}

export interface HttpResult {
  status: number;
  ok: boolean;
  body: any;
  raw: string;
}

function subst(value: string, args: Record<string, unknown>): string {
  return value.replace(/\{(\w+)\}/g, (_m, k) =>
    args[k] === undefined || args[k] === null ? "" : String(args[k]),
  );
}

function substDeep(value: unknown, args: Record<string, unknown>): unknown {
  if (typeof value === "string") return subst(value, args);
  if (Array.isArray(value)) return value.map((v) => substDeep(v, args));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = substDeep(v, args);
    return out;
  }
  return value;
}

export type FetchLike = (url: string, init?: any) => Promise<Response>;

export async function callHttp(
  spec: HttpSpec,
  args: Record<string, unknown>,
  opts: { fetchImpl?: FetchLike; signal?: AbortSignal } = {},
): Promise<HttpResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = new URL(subst(spec.url, args));
  for (const [k, v] of Object.entries(spec.query ?? {})) {
    url.searchParams.set(k, subst(String(v), args));
  }

  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(spec.headers ?? {})) headers[k] = subst(v, args);

  const method = spec.method ?? "GET";
  let body: string | undefined;
  if (spec.body !== undefined && method !== "GET") {
    body = JSON.stringify(substDeep(spec.body, args));
    if (!Object.keys(headers).some((h) => h.toLowerCase() === "content-type")) {
      headers["Content-Type"] = "application/json";
    }
  }

  const controller = new AbortController();
  const timer = spec.timeoutMs
    ? setTimeout(() => controller.abort(), spec.timeoutMs)
    : undefined;
  try {
    const res = await fetchImpl(url.toString(), {
      method,
      headers,
      body,
      signal: opts.signal ?? controller.signal,
    });
    const raw = await res.text();
    let parsed: any = raw;
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      /* keep raw text */
    }
    return { status: res.status, ok: res.ok, body: parsed, raw };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Read a dot-path out of a response body, e.g. "data.0.code". */
export function pick(body: any, path: string): unknown {
  return path.split(".").reduce<any>((acc, key) => {
    if (acc === undefined || acc === null) return undefined;
    const idx = Number(key);
    return Number.isInteger(idx) ? acc[idx] : acc[key];
  }, body);
}
