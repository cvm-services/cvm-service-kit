import type { AnnounceOptions, CvmServerOptions } from "./types.ts";
import type { CvmServer } from "./transport.ts";

const TIER_RANK: Record<string, number> = {
  none: 0,
  financial: 1,
  contact: 2,
  fulfilment: 3,
  legal: 4,
  sensitive: 5,
};

/**
 * Recompute the maximum input tier from the declared fields.
 * Uses a conservative built-in field register; unknown fields fail loud,
 * because a tier tag that disagrees with the field list is a spec violation
 * (CEP-draft-0001 P15).
 */
export const FIELD_TIER: Record<string, keyof typeof TIER_RANK> = {
  none: "none",
  // financial
  amount: "financial",
  payment: "financial",
  mint: "financial",
  // contact
  email: "contact",
  phone: "contact",
  npub: "contact",
  // fulfilment
  address: "fulfilment",
  location: "fulfilment",
  coordinates: "fulfilment",
  // legal
  name: "legal",
  real_name: "legal",
  // sensitive
  id: "sensitive",
  seed: "sensitive",
  private_key: "sensitive",
};

export function computeTier(fields: string[]): string {
  if (fields.length === 0) return "none";
  let max = 0;
  let which = "none";
  for (const f of fields) {
    const t = FIELD_TIER[f];
    if (!t) {
      throw new Error(
        `unknown input field '${f}': add it to FIELD_TIER or pass an explicit tier`,
      );
    }
    if (TIER_RANK[t] > max) {
      max = TIER_RANK[t];
      which = t;
    }
  }
  return which;
}

function inputTags(opts: AnnounceOptions): string[][] {
  const tags: string[][] = [];
  const req = opts.requiredInputs;
  const opt = opts.optionalInputs;
  if ((req === undefined || req.length === 0) && (!opt || opt.length === 0)) {
    // Explicit "needs nothing" only when at least one of the arrays was given.
    if (req !== undefined || opt !== undefined) tags.push(["t", "cvm:req:none"]);
  }
  for (const f of req ?? []) tags.push(["t", `cvm:req:${f}`]);
  for (const f of opt ?? []) tags.push(["t", `cvm:opt:${f}`]);
  return tags;
}

function resolveTier(opts: AnnounceOptions): string | undefined {
  if (opts.tier) return opts.tier;
  if (opts.requiredInputs === undefined && opts.optionalInputs === undefined) {
    return undefined; // unknown appetite: publish no tier tag
  }
  return computeTier([...(opts.requiredInputs ?? []), ...(opts.optionalInputs ?? [])]);
}

/** Build the tag set for the kind-11316 server announcement. */
export function announcementTags(opts: AnnounceOptions, serverInfo: CvmServerOptions): string[][] {
  const tags: string[][] = [
    ["d", opts.d],
    ["t", `cvm:service:${opts.serviceClass}`],
    ["name", serverInfo.name],
  ];
  for (const kw of opts.keywords ?? []) tags.push(["t", kw]);
  for (const gh of opts.geohashes ?? []) tags.push(["g", gh]);
  if (opts.url) tags.push(["r", opts.url]);
  for (const reg of opts.registries ?? []) tags.push(["a", reg]);
  for (const t of serverInfo.tools) {
    if (typeof t.definition.priceSats === "number") {
      tags.push(["cap", `tool:${t.definition.name}`, String(t.definition.priceSats), "sats"]);
    }
  }
  for (const m of opts.pmi ?? []) tags.push(["pmi", m]);
  tags.push(...inputTags(opts));
  const tier = resolveTier(opts);
  if (tier) tags.push(["t", `cvm:tier:${tier}`]);
  return tags;
}

/**
 * Publish CEP-6 announcements: kind 11316 (server) and 11317 (tools list).
 * Both are replaceable, tagged with the same `d` slug.
 */
export async function publishAnnouncement(
  server: CvmServer,
  opts: AnnounceOptions,
  serverInfo: CvmServerOptions,
): Promise<{ server: unknown; tools: unknown }> {
  const tags = announcementTags(opts, serverInfo);
  const content = JSON.stringify({
    name: serverInfo.name,
    about: opts.about ?? "",
    class: `cvm:service:${opts.serviceClass}`,
  });
  const serverEvent = await server.publish({ kind: 11316, content, tags });

  const toolsContent = JSON.stringify({
    tools: serverInfo.tools.map((t) => ({
      name: t.definition.name,
      description: t.definition.description,
      inputSchema: t.definition.inputSchema,
    })),
  });
  const toolsEvent = await server.publish({
    kind: 11317,
    content: toolsContent,
    tags: [
      ["d", opts.d],
      ["t", `cvm:service:${opts.serviceClass}`],
    ],
  });
  return { server: serverEvent, tools: toolsEvent };
}
