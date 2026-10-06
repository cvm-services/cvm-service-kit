/**
 * CEP-0001 P11 — refusals are data, not silence. Every refusal a CVM service
 * emits has a stable reason string and a stated remedy. This is the catalogue
 * for this kit; wrappers MUST reuse these codes.
 */
export interface RefusalSpec {
  /** JSON-RPC error code. */
  code: number;
  reason: string;
  /** Human/agent remedy. */
  remedy: string;
}

export const REFUSALS = {
  payment_required: {
    code: -32002,
    reason: "payment_required",
    remedy: "Pay the advertised invoice/Cashu request, then retry the same call with the same order_id.",
  },
  treasury_insufficient: {
    code: -32003,
    reason: "treasury_insufficient",
    remedy: "The provider cannot cover the upstream right now; retry later or use another provider.",
  },
  rate_limited: {
    code: -32004,
    reason: "rate_limited",
    remedy: "Wait retryAfterMs and retry.",
  },
  queue_timeout: {
    code: -32005,
    reason: "queue_timeout",
    remedy: "Executor is at capacity; retry shortly.",
  },
  unknown_tool: {
    code: -32602,
    reason: "unknown_tool",
    remedy: "Call tools/list and use a listed tool name.",
  },
  method_not_found: {
    code: -32601,
    reason: "method_not_found",
    remedy: "Use initialize, tools/list, tools/call or ping.",
  },
  unsupported_language: {
    code: -32602,
    reason: "unsupported_language",
    remedy: "Use one of the languages returned by the availability tool.",
  },
  amount_too_large: {
    code: -32602,
    reason: "amount_too_large",
    remedy: "Reduce the requested amount and retry.",
  },
  upstream_error: {
    code: -32010,
    reason: "upstream_error",
    remedy: "The upstream service failed; retry later.",
  },
} as const satisfies Record<string, RefusalSpec>;

export type RefusalReason = keyof typeof REFUSALS;

export class CvmRefusalError extends Error {
  readonly code: number;
  readonly reason: string;
  constructor(reason: RefusalReason, readonly data: Record<string, unknown> = {}) {
    const spec = REFUSALS[reason];
    super(spec.reason);
    this.name = "CvmRefusalError";
    this.code = spec.code;
    this.reason = spec.reason;
    this.data = { reason: spec.reason, remedy: spec.remedy, ...data };
  }
}

export function refuse(reason: RefusalReason, data?: Record<string, unknown>): never {
  throw new CvmRefusalError(reason, data);
}
