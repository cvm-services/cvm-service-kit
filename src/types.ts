export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [k: string]: JsonValue };

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** CEP-8 price in sats for one call, advertised as ["cap","tool:<name>",N,"sats"]. */
  priceSats?: number;
}

export interface ToolHandlerContext {
  /** Nostr pubkey (hex) of the caller. */
  caller: string;
}

export type ToolHandler = (
  args: Record<string, unknown>,
  ctx: ToolHandlerContext,
) => Promise<unknown> | unknown;

export interface Tool {
  definition: ToolDefinition;
  handler: ToolHandler;
}

export interface RelayLike {
  publish(event: unknown): Promise<unknown>;
  subscribe(
    filters: unknown[],
    opts: {
      onevent: (event: any) => void;
      oneose?: () => void;
      onclose?: (reasons: string[]) => void;
    },
  ): { close: (reason?: string) => void };
  close?: () => void;
}

export interface CvmServerOptions {
  /** 32-byte secret key as hex (64 chars) or Uint8Array. */
  secretKey: string | Uint8Array;
  relays: string[];
  name: string;
  version?: string;
  tools: Tool[];
  /** Optional explicit announce so tools/list and the 11317 event agree. */
  onLog?: (line: string) => void;
  /** Per-relay publish deadline in ms (default 10s). A relay whose publish()
   * never settles is logged and dropped instead of blocking the others. */
  publishTimeoutMs?: number;
}

export interface AnnounceOptions {
  /** Stable, human-meaningful slug, published as the "d" tag. */
  d: string;
  /** Short lowercase class token, published as t=cvm:service:<class>. */
  serviceClass: string;
  about?: string;
  /** Extra plain "t" words for humans. */
  keywords?: string[];
  /** Geohash precisions (>=2). Omit entirely for location-less services. */
  geohashes?: string[];
  /** Docs/endpoint URL. */
  url?: string;
  /** Pinned registry claims: a-tag values "30000:<curator-hex>:<slug>". */
  registries?: string[];
  /** CEP-8 payment method identifiers. */
  pmi?: string[];
  /** Required input fields (P15). Omit for unknown; use [] to declare none. */
  requiredInputs?: string[];
  optionalInputs?: string[];
  /** Explicit input tier (none|financial|contact|fulfilment|legal|sensitive).
   * If omitted it is recomputed from the declared fields. */
  tier?: string;
}
