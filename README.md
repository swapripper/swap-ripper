# ⚡ Swap Ripper: cross-chain swaps for AI agents

**One MCP tool call to swap any token across 25+ blockchains.** Bitcoin, Ethereum, Solana, Base, Arbitrum, BNB, Tron, NEAR, Zcash, TON, Sui, XRP, Doge and more.

No API key. No sign-up. No wallet connection. Non-custodial, with automatic refunds. Powered by the [NEAR Intents](https://near-intents.org) solver network.

```
https://swap-ripper.szydlow45.workers.dev/mcp
```

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
| `get_quote` | Live cross-chain price, no addresses needed. Includes a **fair-price check** vs market rates. |
| `quote_from_text` | Plain English: `"25 USDC on solana to ETH on base"` |
| `create_swap` | Lock a quote and get a one-time deposit address. Output lands at the recipient automatically. |
| `pay_exact` | Recipient gets **exactly** N tokens (e.g. 10 USDC on Base), paid with any token you hold. Good for invoices, x402 wallet top-ups and gas. |
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
