# cvm-ppq — pay-per-query AI over ContextVM (reseller)

Wraps PayPerQ (`https://api.ppq.ai/v1`, OpenAI-compatible) as a CVM service.
Tools: `chat` (paid), `models` (free), `balance` (upstream credit), `availability`.

## Config (env)

| Var | Meaning |
|---|---|
| `SERVER_SECRET_KEY` | 64-hex CVM signing key |
| `PPQ_API_KEY` | funded PPQ key (reseller) |
| `PPQ_BASE` | default `https://api.ppq.ai/v1` |
| `DEFAULT_MODEL` | default model id |
| `PRICE_CHAT_SATS` | fixed client price per chat call |
| `PAYMENT_MODE` / `CASHU_MINT_URL` | client payment rail |

PPQ accepts `Authorization: Bearer sk-<key>`; the real prepaid balance is
`POST /credits/balance` (USD). No OpenAI billing endpoints exist.

## Run (dev)

```bash
SERVER_SECRET_KEY=$(openssl rand -hex 32) \
PPQ_API_KEY=... PRICE_CHAT_SATS=5 \
bun services/cvm-ppq/src/server.ts
```

Status: code + tests complete; live needs a funded `PPQ_API_KEY`.
