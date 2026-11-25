# ⚡ Swap Ripper: cross-chain swaps, x402 funding, payments and gas for AI agents

**One MCP tool call to swap any token across 25+ blockchains.** Bitcoin, Ethereum, Solana, Base, Arbitrum, BNB, Tron, NEAR, Zcash, TON, Sui, XRP, Doge and more.

No API key. No sign-up. No wallet connection. Non-custodial, with automatic refunds. Powered by the [NEAR Intents](https://near-intents.org) solver network.

```
https://swap-ripper.szydlow45.workers.dev/mcp
```

## New: got an HTTP 402? Pay it from any chain

x402 paywalls usually ask for USDC on Base, but your agent's money is on Solana, Ethereum or Bitcoin. Pass the 402 response to **`fund_x402`**. It accepts x402 v1 or v2, either the JSON body or the base64 `PAYMENT-REQUIRED` header. Swap Ripper then:

1. decodes the invoice and picks a network/token it can fund (testnets are flagged),
2. tops up **your own wallet** on that chain with an exact amount (default ~$5, which covers hundreds of $0.01 calls), paid from any token on any chain,
3. leaves your normal x402 client to sign and pay the invoice, so no custody and no trust in us for the payment itself.

```json
POST /api/x402
{ "payment_required": { "x402Version": 2, "accepts": [ ... ] },
  "pay_with_token": "USDC", "pay_with_chain": "solana",
  "wallet": "0xYourBaseWallet", "refund_address": "YourSolanaAddress" }
```

Call it with only `payment_required` to decode the invoice and get a cost estimate first.

## Connect

**Claude Desktop / Cursor / any MCP client:**
```json
{ "mcpServers": { "swap-ripper": { "url": "https://swap-ripper.szydlow45.workers.dev/mcp" } } }
```

**Claude Code:**
```bash
claude mcp add --transport http swap-ripper https://swap-ripper.szydlow45.workers.dev/mcp
```

**No MCP?** Use the REST API ([OpenAPI spec](https://swap-ripper.szydlow45.workers.dev/openapi.json)) or point your agent at [llms.txt](https://swap-ripper.szydlow45.workers.dev/llms.txt).

## Tools

| Tool | What it does |
|---|---|
| `fund_x402` | **Hit a 402 paywall?** Decode the x402 invoice and fund your wallet on the right chain from any chain. |
| `get_quote` | Live cross-chain price, no addresses needed. Includes a **fair-price check** vs market rates. |
| `quote_from_text` | Plain English: `"25 USDC on solana to ETH on base"` |
| `create_swap` | Lock a quote and get a one-time deposit address. Output lands at the recipient automatically. |
| `pay_exact` | Recipient gets **exactly** N tokens (e.g. 10 USDC on Base), paid with any token you hold. Good for invoices, x402 wallet top-ups and gas. |
| `create_payment_link` | **"Pay me in any crypto" links.** The payer uses any token on any chain, and you receive exactly what you asked for. Good for agents selling services. [Try it](https://swap-ripper.szydlow45.workers.dev/pay) |
| `refuel_gas` | **Gas station.** Get a few dollars of native gas (ETH on Base/Arbitrum/OP, SOL, BNB, POL, AVAX, TRX, TON, SUI…) on any chain, paid with any token. |
| `compare_quotes` | Up to 10 routes in one call, with the best one picked. |
| `get_swap_status` | Track a swap, with `wait_seconds` long-polling so agents make fewer calls. |
| `get_prices` | Free USD prices across 25+ chains. |
| `search_tokens` / `list_chains` | Discovery. |
| `referral_stats` | See what your referrer account has earned. |

Extras: ready-to-sign EVM deposit transactions, typo suggestions ("Did you mean USDC?"), automatic retries, human-readable amounts everywhere.

## Example

```
get_quote { from_token: "USDC", from_chain: "solana", to_token: "ETH", to_chain: "base", amount: "25" }
→ ~0.0148 ETH, ~20s, price_check: "good"

create_swap { ...same, recipient: "0x…", refund_address: "<solana address>" }
→ send 25 USDC to deposit_address on Solana → ETH arrives on Base
```

## Fees and referrals
- **0.30%** service fee, built into every quote. **0.25%** over $1k, **0.15%** over $10k.
- **Referral program:** pass `referrer: "yourname.near"` on any call and earn **1/3 of the fee** on every swap you route, paid on-chain automatically. Users pay the same price.

## Safety
- Non-custodial: this service never holds funds. Deposits go to one-time NEAR Intents addresses, and refunds are automatic if a swap can't complete.
- Address sanity checks before any deposit address is issued.
- Not available to sanctioned persons or in sanctioned jurisdictions. Provided as-is. Always double-check addresses.

## Self-host
`worker.js` is a single-file Cloudflare Worker with no dependencies. Set `FEE_RECIPIENT`, `FEE_BPS` and the `ONECLICK_JWT` secret, and optionally bind a KV namespace as `STATS`.

Also for humans: [@IntentsSwapRipperBot](https://t.me/IntentsSwapRipperBot) on Telegram.

MIT License
