# Announce readiness — second-key harness evidence (pre-flip), 2026-10-08

Board card: `t_968d7179` — "announce the three silent services after their
second-key harness passes and verify discovery".

Ordering rule under test (card): *announce only after the service can honestly
serve. Do not flip ANNOUNCE for a service whose paid path is still fake.*

## Method

- Harness: the kit's own `tools/cvm-call.ts` — a fresh client key per call
  (never the server key), gift-wrapped kind-1059 JSON-RPC over
  `wss://nostr.mom,wss://relay.primal.net` (announced-relay subset).
- Read-back: `nak req -k 11316 -k 11317 -a <pubkey>` against three relays.
- Control: `cvm-lambda` (ANNOUNCE=true since deploy) must be FOUND by the same
  query — proving absence for the other three is a real absence, not a
  query-method artifact.
- Server identities (public keys from unit journals):
  - cvm-sms4sats `72a45409ef798d4050e5cba4407928e97d92cd377af8bafe0a23d3552fba2954`
  - cvm-ppq `d019e601bb063895d9af8b05d1e8bdca241148cefdeeac90d72ac0eded72ac17`
  - cvm-nanogpt `bf443127b81011c3bc228daf506e90b6a858f86e9a0518b61acdb5fcd4cb70d8`
  - cvm-lambda (control) `e3cc68060448fb92522e87ed7bd91973e2896eae9f744389d0b6890975b4d805`

## Harness results (raw replies in `harness-pre/`)

| service | call | result |
|---|---|---|
| sms4sats | `tools/list` | 5 tools (availability, list_services, catalog, create_sms_order, order_status) |
| sms4sats | `availability` | `{"status":"ok","treasury_balance_sats":1000000}` — **the FakeLnWallet 1M default: the treasury is FAKE** (old code, no NWC_URL) |
| sms4sats | `catalog {country:us, service:tg}` | `{"items":[],"updatedAt":"2026-10-08T12:41:57Z"}` — empty (live API route mismatch on the deployed old code) |
| sms4sats | `chat` (wrong tool) | `-32602 unknown tool: chat` — correct refusal |
| ppq | `tools/list` | 4 tools (chat, models, availability, balance) |
| ppq | `availability` | `{"status":"unconfigured","service":"ppq","price_sats":5}` |
| ppq | `models` | **no reply** (server crashed while replying — journal shows the transport `reasons?.join` TypeError; see below) |
| ppq | `chat` unpaid | `-32002 payment_required` (orderId, cashu testnut invoice, pmi bitcoin-cashu) — gate refuses honestly |
| nanogpt | `tools/list` | 3 tools (chat, models, availability) |
| nanogpt | `availability` | `{"status":"unconfigured","service":"nanogpt","price_sats":5}` |
| nanogpt | `models` | 68,949-byte reply — **641 models listed WITHOUT an API key** (public catalogue) |
| nanogpt | `chat` unpaid | `-32002 payment_required` — gate refuses honestly |

## Read-back (negative control included) — `readback-pre/`

| service | primal | relay2.orangesync | nostr.mom |
|---|---|---|---|
| sms4sats | 0 | 0 | 0 |
| ppq | 0 | 0 | 0 |
| nanogpt | 0 | 0 | 0 |
| **lambda (control)** | **2** (11316+11317) | **2** | 0 |

Lambda's live 11316 tag set (reference shape): `d=cvm-lambda-01`,
`t=cvm:service:compute`, `name`, keyword `t` tags, `cap tool:run_code 2 sats`,
`pmi bitcoin-cashu`, `t=cvm:req:none`, `t=cvm:tier:none`. No `g` geohash tags
(services have no fixed location — allowed: "omit entirely for no fixed
location").

## Fulfilment gate — per service verdict

The card's ordering: flip ANNOUNCE **only** when the harness passes AND the
service can honestly serve its announced surface.

| service | transport | free surface | paid surface | verdict |
|---|---|---|---|---|
| cvm-sms4sats | answers, but crashes on relay-close (old code) | availability lies (`ok` + fake 1M sats); catalog empty | treasury rail absent (no NWC_URL; `TREASURY_BACKEND=fake`); `create_sms_order` cannot pay upstream | **DO NOT ANNOUNCE — paid path fake** (exactly the card's forbidden case) |
| cvm-ppq | crash-looping (`reasons?.join` TypeError, restart counter climbing) | availability `unconfigured` | `chat` needs `PPQ_API_KEY`: none deployed; local fleet key is DEAD (PPQ balance $0.00, disabled 2026-08-20) | **DO NOT ANNOUNCE — upstream dead** |
| cvm-nanogpt | answers; `models` exceeds some relays' size limits (131,585-byte gift wrap rejected; 68,949 delivered via another relay) | availability `unconfigured`; models works keyless | `chat` needs `NANOGPT_API_KEY`: none deployed, none found in the fleet vaults | **DO NOT ANNOUNCE — paid tool cannot fulfil** |

## Registry feed (cvm.orangesync.tech) — why they are missing

The collector reads `relay.damus.io` + `relay2.orangesync.tech` (catalog.json
`collector.relays`). Even if the three services announced, the dashboard drops
them: the `curators.json` allow-list contains only cvm-lambda + venue + nosms
provider keys. **The three publisher npubs are not allow-listed**:

- sms4sats `npub1w2j9gz000xx5q589ewjyq7fga97e9nfh0tut4ls2y0f42ta6992q2clvhc`
- ppq `npub16qv7vqdmqcuftkd03vzar69aegjpzjxwlhh2eyxh9tqwmmtj4stsuqg9s3`
- nanogpt `npub1hazrzfaczqgu80pz3kh4qm5sk65937rwngz33ds6ek6le4xtwrvqdwg7sz`

Required `cvm-registry` follow-up (link when created): add these three as
`role: provider` entries in `curators.json` **in the same change** that flips
their ANNOUNCE.

## Box state (blocker for ANY redeploy, incl. the crash fixes)

`testserver2` (vps2, 23.182.128.51) still runs the pre-pinned-deploy copy:

- `/home/debian/cvm-service-kit` has **no `.git`**, no `.deployed-sha` — the
  transport crash-loop fix (PR #4), honest rail_unavailable (PR #6/#9),
  cashu-ts v4 treasury (PR #3) and pinned checkout (PR #8) are NOT deployed.
- The units crash on relay-close (`TypeError: reasons?.join is not a function`)
  — observed live for cvm-ppq and cvm-sms4sats during this harness run.
- All three `-health.timer` checks fail: sms4sats reports the fake
  `treasury_backend=fake` balance as ok; ppq/nanogpt report `unconfigured`.

Redeploy requires the vault secret the current playbook DEMANDS for sms4sats
(`cvm_service_require_secrets: [NWC_URL]` — deploy fails loudly without it).
Operator action needed (fleet vault): `bao kv put secret/fleet/cvm-nwc
nwc_url='<nostr+walletconnect://…>'` — and for the AI services,
`PPQ_API_KEY`/`NANOGPT_API_KEY` in the same store once funded.

## Conclusion

**Zero ANNOUNCE flips.** All three services fail the card's fulfilment gate
today. The honest deliverable is this evidence + the readiness changes in this
PR (see commit list): the drift-pin repair, the per-service readiness gate in
the playbook (announce stays false; the flip lands only with its rail wired),
and the registry allow-list entries staged for the moment the rails are real.
