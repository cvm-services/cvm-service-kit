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
  // NOTE: there is deliberately NO `tier` field. The tier tag is computed from
  // the declared required/optional inputs (see resolveTier in announce.ts) and
  // a caller-supplied tier would let a service understate what it collects —
  // the one lie a reader cannot detect (CEP-draft-0001 P15).
}
