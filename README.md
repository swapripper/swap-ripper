# ⚡ Swap Ripper: cross-chain swaps, x402 funding, payments and gas for AI agents

**One MCP tool call to swap any token across 25+ blockchains.** Bitcoin, Ethereum, Solana, Base, Arbitrum, BNB, Tron, NEAR, Zcash, TON, Sui, XRP, Doge and more.

No API key. No sign-up. No wallet connection. Non-custodial, with automatic refunds. Powered by the [NEAR Intents](https://near-intents.org) solver network.

```
https://swap-ripper.szydlow45.workers.dev/mcp
```

## Spending limits owners can trust

Owners create a policy (max per payment, max per day, optional allowed chains, tokens and recipients) at **[/limits](https://swap-ripper.szydlow45.workers.dev/limits)** or with `create_spending_policy`, then give their agent a **policy-locked URL** (`/mcp/p/<policy_id>`). Every swap and payment through it is checked first and refused if it breaks a rule, before any payment instructions exist. The private admin key shows the spending log and works as an instant off switch (`set_policy_enabled`). Swap Ripper never holds funds.

## Get paid, with proof

- `create_payment_link` now returns an **invoice_id**. The payer can use any token on any chain; you receive exactly what you asked for.
- Add `webhook_url` and Swap Ripper **POSTs a signed notification** (with the receipt) to your server within minutes of payment: no polling. Verify `X-SwapRipper-Signature` = `sha256=` + HMAC-SHA256(webhook secret, raw body).
- `check_payment` tells you whether the invoice is **unpaid, processing or paid**, with blockchain transaction hashes. Deliver your service only after it's paid. Payments only count if they pay the right recipient, token, chain and full amount.
- `get_receipt` issues a **signed receipt** for any completed swap or payment. `verify_receipt` (or `POST /api/verify`) lets anyone confirm it's genuine and unchanged.

## New: pay anything

Hand the `pay` tool **any** payment request and it pays it exactly, using whatever token you hold on any chain:

- x402 / HTTP 402 invoices (v1 or v2, body or base64 header)
- Solana Pay links (`solana:...?amount=&spl-token=`)
- Ethereum payment links, EIP-681 (`ethereum:0x...@8453?value=` or `/transfer?address=&uint256=`), on Ethereum, Base, Arbitrum, Optimism, BNB, Polygon, Avalanche, Gnosis, Berachain
- Bitcoin links, BIP21 (`bitcoin:bc1...?amount=`)
- Swap Ripper payment links
- Plain text: `send 20 USDC to 0xabc... on base`
- JSON: `{ "to": "0x...", "token": "USDC", "chain": "base", "amount": "20" }`

Call it with only `request` to see what it understood, then add `pay_with_token`, `pay_with_chain` and `refund_address` to get a deposit address. If you already hold the right token, it tells you to pay directly with no fee.

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

## Best price or fastest: you choose

- **Default (`best_price`)**: every swap and payment is quoted on **two networks at once** (NEAR Intents and Relay) and sent through whichever is cheaper for you. If one network is down or can't do a route, the other takes over automatically. The reply's `route_choice` shows both prices.
- **`speed: "fast"`**: routed through Relay, fills in about 1-5 seconds, usually slightly less output. Works on `create_swap`, `pay_exact`, `refuel_gas` and `fund_x402`. Track it with `get_swap_status` and `route: "fast"`.

`get_quote` shows both options side by side (`fast_option`).

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

### Agent frameworks

**ElizaOS** (via the official `@elizaos/plugin-mcp`), in your character file:
```json
{
  "plugins": ["@elizaos/plugin-mcp"],
  "settings": {
    "mcp": { "servers": { "swap-ripper": { "type": "streamable-http", "url": "https://swap-ripper.szydlow45.workers.dev/mcp" } } }
  }
}
```

**LangChain / LangGraph** (`pip install langchain-mcp-adapters`):
```python
from langchain_mcp_adapters.client import MultiServerMCPClient
client = MultiServerMCPClient({"swap-ripper": {"url": "https://swap-ripper.szydlow45.workers.dev/mcp", "transport": "streamable_http"}})
tools = await client.get_tools()   # pass to your agent
```

**OpenAI Agents SDK** (`pip install openai-agents`):
```python
from agents import Agent, Runner
from agents.mcp import MCPServerStreamableHttp
async with MCPServerStreamableHttp(params={"url": "https://swap-ripper.szydlow45.workers.dev/mcp"}) as swap:
    agent = Agent(name="trader", instructions="Use Swap Ripper for swaps and x402 funding.", mcp_servers=[swap])
    print((await Runner.run(agent, "Quote 25 USDC on Solana to ETH on Base")).final_output)
```

**TypeScript (official MCP SDK)**:
```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const client = new Client({ name: "my-agent", version: "1.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL("https://swap-ripper.szydlow45.workers.dev/mcp")));
const res = await client.callTool({ name: "fund_x402", arguments: { payment_required: the402Body } });
```

**Plain HTTP** (no MCP at all):
```bash
curl -s -X POST https://swap-ripper.szydlow45.workers.dev/api/x402 -H 'content-type: application/json' -d '{"payment_required": <the 402 body>}'
```

## Tools

| Tool | What it does |
|---|---|
| `pay` | **Pay anything**: x402 invoices, Solana Pay, EIP-681, Bitcoin links, payment links or plain text, paid with any token. |
| `check_payment` | Did I get paid? Invoice status with transaction proof. |
| `get_receipt` / `verify_receipt` | Signed receipts anyone can verify. |
| `create_spending_policy` / `policy_status` / `set_policy_enabled` | Owner spending limits, log and kill switch. |
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
- **0.20%** service fee, built into every quote (**0.15%** over $10k). Every quote includes a live `best_price_check` against Relay, so you can see the proof.
- **Referral program:** pass `referrer: "yourname.near"` on any call and earn **1/3 of the fee** on every swap you route, paid on-chain automatically. Users pay the same price.

## Safety
- Non-custodial: this service never holds funds. Deposits go to one-time NEAR Intents addresses, and refunds are automatic if a swap can't complete.
- Address sanity checks before any deposit address is issued.
- Not available to sanctioned persons or in sanctioned jurisdictions. Provided as-is. Always double-check addresses.

## Self-host
`worker.js` is a single-file Cloudflare Worker with no dependencies. Set `FEE_RECIPIENT`, `FEE_BPS` and the `ONECLICK_JWT` secret, and optionally bind a KV namespace as `STATS`.

Also for humans: [@IntentsSwapRipperBot](https://t.me/IntentsSwapRipperBot) on Telegram.

MIT License
