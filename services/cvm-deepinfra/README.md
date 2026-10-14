# cvm-deepinfra — DeepInfra inference + cost quote over ContextVM

Wraps DeepInfra (`https://api.deepinfra.com/v1/openai`, OpenAI-compatible) as a
CVM service. Default model **`deepseek-ai/DeepSeek-V4.1-Flash`**.

Tools:

| Tool | Paid | Purpose |
|---|---|---|
| `chat` | yes | Chat completion (paid per call). |
| `models` | no | List the provider catalog. |
| `availability` | no | Configured + price + default model. |
| `balance` | no | Account status. **DeepInfra exposes no balance endpoint** (verified 2026-10-12: `/v1/user/balance`, `/v1/balance`, `/v1/usage` all 404) — reports `/v1/me`. |
| `cost_quote` | no | Price a token estimate at the list rates × service tier (`flex` = −20%, best-effort). |
| `topup` | no | Payment handoff URL + amount guidance. **Human step** — creation/charging is a card/3DS action and cannot be automated. |

## Config (env)

| Var | Meaning |
|---|---|
| `SERVER_SECRET_KEY` | 64-hex CVM signing key |
| `DEEPINFRA_API_KEY` | funded DeepInfra key (reseller) |
| `DEEPINFRA_BASE` | default `https://api.deepinfra.com/v1/openai` |
| `DEEPINFRA_SERVICE_TIER` | default service tier for `chat` (`standard`\|`flex`\|`priority`) |
| `DEFAULT_MODEL` | default `deepseek-ai/DeepSeek-V4.1-Flash` |
| `PRICE_CHAT_SATS` | fixed client price per chat call |
| `PAYMENT_MODE` / `CASHU_MINT_URL` | client payment rail |
| `DEEPINFRA_BILLING_URL` | default `https://deepinfra.com/dash/billing` |

## Run (dev)

```bash
SERVER_SECRET_KEY=$(openssl rand -hex 32) \
DEEPINFRA_API_KEY=... PRICE_CHAT_SATS=5 \
bun services/cvm-deepinfra/src/server.ts
```

## Tests

```bash
deno test --allow-read tests/deepinfra_quote_test.ts
```

Status: code + quote tests complete. Live needs a funded `DEEPINFRA_API_KEY`
(the fleet's own lane is funded; this resell lane is separate).
