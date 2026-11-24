---
name: swap-ripper
description: Swap or bridge crypto tokens across 25+ blockchains (BTC, ETH, SOL, Base, Arbitrum, BNB, Tron, NEAR, Zcash, TON, Sui, XRP), or pay someone an exact amount in a token you don't hold, via the Swap Ripper API. No API key needed.
---

# Swap Ripper: cross-chain swaps

Base URL: `https://swap-ripper.szydlow45.workers.dev`
MCP: `https://swap-ripper.szydlow45.workers.dev/mcp` · REST: `/api/*` · Full guide: `/llms.txt`

## When to use
- The user wants to swap, bridge or convert tokens between chains.
- The user needs to pay an exact amount of a token on a chain where they hold something else.
- You need current token prices.

## Steps
1. **Quote** (nothing is committed): `GET /api/quote?from_token=USDC&from_chain=solana&to_token=ETH&to_chain=base&amount=25`
   - Check `price_check.verdict`. If it isn't "good", tell the user the cost.
2. **Confirm with the user** before creating a swap: the amount, the recipient address (on the DESTINATION chain) and the refund address (on the SOURCE chain).
3. **Create**: `POST /api/swap` with `{from_token, from_chain, to_token, to_chain, amount, recipient, refund_address}`
   - For an exact payout, use `POST /api/pay` with `{token, chain, amount_out, pay_with_token, pay_with_chain, recipient, refund_address}`.
4. **Deposit**: send exactly `send_exactly` of the source token to `deposit_address` on `deposit_chain` before `deadline`. Include `deposit_memo` if present. For EVM chains, `deposit_tx` is ready to sign.
5. **Track**: `GET /api/status?deposit_address=...&wait_seconds=25` until `final` is true.

## Rules
- Amounts are human-readable decimals ("25.5"), never base units.
- Never send to a deposit address after its deadline. Get a new quote instead.
- Failed or short deposits are refunded to `refund_address` automatically.
- Fee: 0.30% (lower for large swaps), already included in quotes.
