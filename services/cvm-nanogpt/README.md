# cvm-nanogpt — AI chat over ContextVM (reseller)

Wraps NanoGPT's OpenAI-compatible API (`https://nano-gpt.com/api/v1`) as a CVM
service. Tools: `chat` (paid per call), `models` (free), `availability`.

## Config (env)

| Var | Meaning |
|---|---|
| `SERVER_SECRET_KEY` | 64-hex CVM signing key |
| `NANOGPT_API_KEY` | funded NanoGPT key (reseller) |
| `NANOGPT_BASE` | default `https://nano-gpt.com/api/v1` |
| `DEFAULT_MODEL` | default model id |
| `PRICE_CHAT_SATS` | fixed client price per chat call |
| `PAYMENT_MODE` / `CASHU_MINT_URL` | client payment rail |
| `RATE_CAPACITY` / `RATE_REFILL_PER_SEC` | per-caller limit |

NanoGPT also supports x402 with a `lightning-l402` scheme and an MCP endpoint;
the funded-key path is used here for predictable reseller pricing.

## Run (dev)

```bash
SERVER_SECRET_KEY=$(openssl rand -hex 32) \
NANOGPT_API_KEY=... PRICE_CHAT_SATS=5 \
bun services/cvm-nanogpt/src/server.ts
```

Status: code + tests complete; live needs a funded `NANOGPT_API_KEY`.
