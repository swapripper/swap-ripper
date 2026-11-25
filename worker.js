/**
 * Swap Ripper: cross-chain swaps for AI agents.
 *
 * One Cloudflare Worker that serves:
 *   POST /mcp            MCP server (Streamable HTTP, stateless JSON). Add this URL to any MCP client.
 *   GET  /api/...        Plain REST API for agents that don't speak MCP
 *   GET  /openapi.json   OpenAPI 3.1 spec (for GPT Actions, LangChain, etc.)
 *   GET  /llms.txt       Plain-text guide for LLMs
 *   GET  /               Human landing page
 *
 * Swaps are executed by NEAR Intents (1Click API). Non-custodial: the agent sends funds to a
 * one-time deposit address and receives the output directly. No API key, no private keys,
 * no sign-up for the agent.
 *
 * Settings (Cloudflare dashboard > Worker > Settings > Variables):
 *   FEE_RECIPIENT   your NEAR account, e.g. swap_ripper.near   (plain variable)
 *   FEE_BPS         service fee in basis points, default 30      (plain variable)
 *   ONECLICK_JWT    your partners.near-intents.org key          (SECRET, encrypt it)
 */

const VERSION = "1.5.2";
const NAME = "swap-ripper";
const API = "https://1click.chaindefuser.com";
const MAX_USD = 25000;
const BLOCKED_COUNTRIES = new Set(["CU", "IR", "KP", "SY", "RU", "BY"]); // sanctioned / high-risk

const CHAIN_ALIASES = {
  solana: "sol", sol: "sol", ethereum: "eth", eth: "eth", mainnet: "eth",
  bitcoin: "btc", btc: "btc", near: "near", base: "base", arbitrum: "arb", arb: "arb",
  bsc: "bsc", bnb: "bsc", "bnb chain": "bsc", polygon: "pol", pol: "pol", matic: "pol",
  optimism: "op", op: "op", avalanche: "avax", avax: "avax", tron: "tron", trx: "tron",
  zcash: "zec", zec: "zec", dogecoin: "doge", doge: "doge", xrp: "xrp", ripple: "xrp",
  ton: "ton", sui: "sui", litecoin: "ltc", ltc: "ltc", aptos: "aptos", apt: "aptos",
  stellar: "stellar", xlm: "stellar", cardano: "cardano", ada: "cardano",
  starknet: "starknet", strk: "starknet", gnosis: "gnosis", berachain: "bera", bera: "bera",
  "arbitrum one": "arb", "base mainnet": "base", "bnb smart chain": "bsc", "binance smart chain": "bsc",
  "polygon pos": "pol", "op mainnet": "op", "avalanche c-chain": "avax", "near protocol": "near",
  "eth mainnet": "eth", "ethereum mainnet": "eth", "solana mainnet": "sol", "bitcoin mainnet": "btc",
};

const DESCRIPTION =
  "Swap any token across 25+ blockchains (Bitcoin, Ethereum, Solana, Base, Arbitrum, BNB, Tron, " +
  "NEAR, Zcash, TON, Sui, XRP, Doge and more) in one call. Non-custodial, no API key, no wallet " +
  "connection: get a quote, receive a one-time deposit address, send funds, done. Powered by NEAR " +
  "Intents solver network. Automatic refund if a swap can't complete. Also: fund x402 (HTTP 402) payments " +
  "from any chain, pay exact amounts, gas refuel, and 'pay me in any crypto' links.";

const INSTRUCTIONS =
  "Got an HTTP 402 / x402 'Payment Required' but your funds are on another chain? Pass the 402 response to fund_x402. " +
  "Tip: add referrer='<your NEAR account>' to any call to earn 1/3 of the fee on swaps you route. " +
  "To pay someone an exact amount with whatever you hold, use pay_exact. Out of gas on a chain? Use refuel_gas. " +
  "To get paid by humans or other agents, use create_payment_link. " +
  "Workflow: 1) search_tokens to find exact token+chain (optional; symbols like 'USDC' with chain " +
  "'solana' also work). 2) get_quote for a price (no addresses needed). 3) create_swap with the " +
  "recipient address (on the destination chain) and refund address (on the source chain); it " +
  "returns a deposit address. 4) The agent's wallet sends EXACTLY amount_in of the source token to " +
  "deposit_address on the source chain before the deadline (include deposit_memo if present). " +
  "5) Call get_swap_status with wait_seconds=25 until final=true. Amounts are human-readable decimals " +
  "(e.g. '25.5'), never base units. Never send funds to a deposit address after its deadline.";

// ------------------------------------------------------------------ helpers
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version",
};
const json = (obj, status = 200, extra = {}) =>
  new Response(JSON.stringify(obj, null, 2), {
    status, headers: { "Content-Type": "application/json", ...cors, ...extra },
  });
const text = (body, type = "text/plain", status = 200) =>
  new Response(body, { status, headers: { "Content-Type": `${type}; charset=utf-8`, ...cors } });

class UserError extends Error {}

function cfg(env) {
  return {
    jwt: env.ONECLICK_JWT || "",
    feeTo: String(env.FEE_RECIPIENT || "").trim().toLowerCase(),
    feeBps: Number.parseInt(env.FEE_BPS || "30", 10),
    kv: env.STATS || null, // optional Workers KV binding for referral stats
    origin: "",
  };
}

function headers(c) {
  const h = { "Content-Type": "application/json", Accept: "application/json" };
  if (c.jwt) { h.Authorization = `Bearer ${c.jwt}`; h["X-API-Key"] = c.jwt; }
  return h;
}

// fetch with retries for network errors, 429 and 5xx (never retries 4xx)
async function fetchRetry(url, opts = {}, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, opts);
      if (r.status !== 429 && r.status < 500) return r;
      last = r;
    } catch (e) { last = e; }
    if (i < tries - 1) await new Promise((res) => setTimeout(res, 400 * 2 ** i));
  }
  if (last instanceof Response) return last;
  throw new Error(`swap network unreachable (${last?.message || "timeout"})`);
}

// token list cache (per isolate)
let TOKENS = { at: 0, list: [] };
async function getTokens(c) {
  if (Date.now() - TOKENS.at < 5 * 60 * 1000 && TOKENS.list.length) return TOKENS.list;
  const r = await fetchRetry(`${API}/v0/tokens`, { headers: headers(c) });
  if (!r.ok) throw new Error(`token list unavailable (${r.status})`);
  TOKENS = { at: Date.now(), list: await r.json() };
  return TOKENS.list;
}

const normChain = (ch) => {
  if (!ch) return "";
  const k = String(ch).trim().toLowerCase();
  return CHAIN_ALIASES[k] || k;
};

function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  return d[a.length][b.length];
}
function suggestSymbols(all, sym, ch) {
  const pool = [...new Set(all.filter((t) => !ch || t.blockchain === ch).map((t) => String(t.symbol)))];
  const scored = pool.map((x) => {
    const u = x.toUpperCase();
    let sc = editDistance(u, sym);
    if (u.includes(sym) || sym.includes(u)) sc = Math.min(sc, 1);
    if (u.replace(/^W/, "") === sym.replace(/^W/, "")) sc = 0;
    return [x, sc];
  }).filter(([, sc]) => sc <= 2).sort((a, b) => a[1] - b[1]);
  return scored.slice(0, 5).map(([x]) => x);
}

function shapeToken(t) {
  return {
    symbol: t.symbol, chain: t.blockchain, asset_id: t.assetId, decimals: t.decimals,
    price_usd: t.price ?? null, contract: t.contractAddress ?? null,
  };
}

async function resolveToken(c, symbolOrId, chain) {
  if (!symbolOrId) throw new UserError("token is required");
  const all = await getTokens(c);
  const raw = String(symbolOrId).trim();
  const byId = all.find((t) => t.assetId === raw);
  if (byId) return byId;
  // allow "USDC@sol" or "USDC on solana"
  let sym = raw, ch = chain;
  const m = raw.match(/^(.+?)(?:@|\s+on\s+)(.+)$/i);
  if (m && !ch) { sym = m[1]; ch = m[2]; }
  sym = sym.trim().toUpperCase();
  ch = normChain(ch);
  let cands = all.filter((t) => String(t.symbol).toUpperCase() === sym);
  if (sym === "NEAR") {
    cands = cands.filter((t) => t.blockchain !== "near")
      .concat(all.filter((t) => String(t.symbol).toUpperCase() === "WNEAR" && t.blockchain === "near"));
  }
  if (ch) cands = cands.filter((t) => String(t.blockchain).toLowerCase() === ch);
  if (!cands.length) {
    const chains = [...new Set(all.filter((t) => String(t.symbol).toUpperCase() === sym).map((t) => t.blockchain))];
    if (chains.length) throw new UserError(`${sym} is not available on '${ch}'. Available chains for ${sym}: ${chains.join(", ")}`);
    const sugg = suggestSymbols(all, sym, ch);
    throw new UserError(`Unknown token '${sym}'${ch ? ` on '${ch}'` : ""}.` +
      (sugg.length ? ` Did you mean: ${sugg.join(", ")}?` : " Use search_tokens to find supported tokens."));
  }
  if (cands.length > 1) {
    throw new UserError(`${sym} exists on several chains: ${cands.map((t) => t.blockchain).join(", ")}. ` +
      `Pass the chain (e.g. chain='${cands[0].blockchain}').`);
  }
  return cands[0];
}

function toUnits(amount, decimals) {
  const s = String(amount).trim().replace(/,/g, "");
  if (!/^\d+(\.\d+)?$/.test(s)) throw new UserError(`amount must be a positive decimal like '25.5', got '${amount}'`);
  const [w, f = ""] = s.split(".");
  if (f.length > decimals) throw new UserError(`too many decimal places (max ${decimals})`);
  const units = BigInt(w + f.padEnd(decimals, "0"));
  if (units <= 0n) throw new UserError("amount must be greater than 0");
  return units.toString();
}

// light address sanity checks: catch obvious mistakes before money moves
const ADDR = {
  eth: /^0x[0-9a-fA-F]{40}$/, base: /^0x[0-9a-fA-F]{40}$/, arb: /^0x[0-9a-fA-F]{40}$/,
  bsc: /^0x[0-9a-fA-F]{40}$/, pol: /^0x[0-9a-fA-F]{40}$/, op: /^0x[0-9a-fA-F]{40}$/,
  avax: /^0x[0-9a-fA-F]{40}$/, gnosis: /^0x[0-9a-fA-F]{40}$/, bera: /^0x[0-9a-fA-F]{40}$/,
  sol: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
  btc: /^(bc1[02-9ac-hj-np-z]{11,71}|[13][1-9A-HJ-NP-Za-km-z]{25,34})$/,
  tron: /^T[1-9A-HJ-NP-Za-km-z]{33}$/,
  near: /^([a-z0-9]+[-_])*[a-z0-9]+(\.([a-z0-9]+[-_])*[a-z0-9]+)*$|^[0-9a-f]{64}$/,
  doge: /^[DA9][1-9A-HJ-NP-Za-km-z]{25,34}$/,
};
function checkAddress(addr, chain, label) {
  if (!addr || !String(addr).trim()) throw new UserError(`${label} is required`);
  const re = ADDR[chain];
  if (re && !re.test(String(addr).trim())) {
    throw new UserError(`${label} '${addr}' doesn't look like a valid ${chain} address. ` +
      `It must be an address on the ${chain} chain.`);
  }
  return String(addr).trim();
}

async function oneclick(c, path, body) {
  const r = await fetchRetry(`${API}${path}`, { method: "POST", headers: headers(c), body: JSON.stringify(body) });
  const t = await r.text();
  let j; try { j = JSON.parse(t); } catch { j = { message: t }; }
  if (!r.ok) {
    const m = String(j.message || j.error || r.status);
    const hint = /failed to get quote|no quotes/i.test(m)
      ? " Tips: make sure recipient and refund_address are real wallet addresses (not contracts/programs) on the right chains, try a slightly larger amount, or retry in a moment."
      : "";
    throw new UserError(`swap network: ${m}.${hint}`);
  }
  return j;
}

function quoteBody(c, src, dst, units, recipient, refund, dry, slippageBps, placeholder = false, opts = {}) {
  const body = {
    dry, swapType: opts.exactOutput ? "EXACT_OUTPUT" : "EXACT_INPUT", slippageTolerance: slippageBps,
    originAsset: src.assetId, depositType: "ORIGIN_CHAIN",
    destinationAsset: dst.assetId, amount: units,
    refundTo: refund, refundType: placeholder ? "INTENTS" : "ORIGIN_CHAIN",
    recipient, recipientType: placeholder ? "INTENTS" : "DESTINATION_CHAIN",
    deadline: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    referral: "swapripper", quoteWaitingTimeMs: 3000,
  };
  body.appFees = feeSplit(c, opts.referrer, opts.bps ?? c.feeBps);
  if (!body.appFees.length) delete body.appFees;
  return body;
}

// Referral program: a referrer (any NEAR account) earns 1/3 of the service fee.
// Total fee paid by the user never changes.
const NEAR_ACCT = /^(([a-z0-9]+[-_])*[a-z0-9]+\.)*([a-z0-9]+[-_])*[a-z0-9]+$|^[0-9a-f]{64}$/;
function cleanReferrer(c, r) {
  if (!r) return null;
  const x = String(r).trim().toLowerCase();
  if (x.length < 2 || x.length > 64 || !NEAR_ACCT.test(x)) {
    throw new UserError(`referrer must be a NEAR account like 'myagent.near' (got '${r}')`);
  }
  return x === c.feeTo ? null : x;
}
// Volume discounts: bigger swaps pay less.
const TIERS = [[10000, 15], [1000, 25]]; // [min USD, max bps]
function effectiveBps(c, usd) {
  let bps = c.feeBps;
  for (const [min, cap] of TIERS) if ((usd || 0) >= min) { bps = Math.min(bps, cap); break; }
  return bps;
}
function feeSplit(c, referrer, bps = c.feeBps) {
  if (!c.feeTo || !(bps > 0)) return [];
  const ref = cleanReferrer(c, referrer);
  if (!ref) return [{ recipient: c.feeTo, fee: bps }];
  const refBps = Math.floor(bps / 3);
  return [{ recipient: c.feeTo, fee: bps - refBps }, { recipient: ref, fee: refBps }];
}

// Fair-price check against reference market prices.
function fairness(src, dst, amountIn, amountOut) {
  const ps = Number(src.price || 0), pd = Number(dst.price || 0), ai = Number(amountIn), ao = Number(amountOut);
  if (!ps || !pd || !ai || !ao) return null;
  const marketOut = (ai * ps) / pd;
  const costPct = ((marketOut - ao) / marketOut) * 100;
  return {
    market_rate_out: +marketOut.toPrecision(8),
    total_cost_vs_market_pct: +costPct.toFixed(3),
    verdict: costPct <= 1 ? "good" : costPct <= 3 ? "ok" : "expensive: consider a larger amount or another route",
  };
}

const EVM = { eth: 1, base: 8453, arb: 42161, bsc: 56, pol: 137, op: 10, avax: 43114, gnosis: 100, bera: 80094 };
const NATIVE = { eth: "ETH", base: "ETH", arb: "ETH", op: "ETH", bsc: "BNB", pol: "POL", avax: "AVAX", gnosis: "XDAI", bera: "BERA" };
// Unsigned transaction an EVM wallet can sign to make the deposit. null when not applicable.
function depositTx(src, depositAddress, unitsIn) {
  const chainId = EVM[src.blockchain];
  if (!chainId || !/^0x[0-9a-fA-F]{40}$/.test(depositAddress || "") || !unitsIn) return null;
  const amt = BigInt(unitsIn);
  const native = String(src.symbol).toUpperCase() === NATIVE[src.blockchain];
  if (native) return { chain_id: chainId, to: depositAddress, value: "0x" + amt.toString(16), data: "0x", kind: "native_transfer" };
  const token = src.contractAddress;
  if (!/^0x[0-9a-fA-F]{40}$/.test(token || "")) return null;
  const data = "0xa9059cbb" + depositAddress.slice(2).toLowerCase().padStart(64, "0") + amt.toString(16).padStart(64, "0");
  return { chain_id: chainId, to: token, value: "0x0", data, kind: "erc20_transfer" };
}

function usdCheck(src, amount) {
  const usd = Number(amount) * Number(src.price || 0);
  if (usd && usd > MAX_USD) throw new UserError(`max per swap is $${MAX_USD} (this is ~$${usd.toFixed(0)}). Split it into smaller swaps.`);
  return usd || null;
}

// ------------------------------------------------------------------ tool logic
async function searchTokens(c, a) {
  const all = await getTokens(c);
  const q = String(a.query || "").trim().toUpperCase();
  const ch = normChain(a.chain);
  let res = all.filter((t) =>
    (!q || String(t.symbol).toUpperCase().includes(q)) &&
    (!ch || String(t.blockchain).toLowerCase() === ch));
  res.sort((x, y) => (String(x.symbol).toUpperCase() === q ? -1 : 0) - (String(y.symbol).toUpperCase() === q ? -1 : 0));
  const limit = Math.min(Math.max(Number(a.limit) || 25, 1), 100);
  return { count: res.length, tokens: res.slice(0, limit).map(shapeToken) };
}

async function listChains(c) {
  const all = await getTokens(c);
  const map = {};
  for (const t of all) (map[t.blockchain] ||= []).push(t.symbol);
  return {
    chains: Object.entries(map).sort().map(([chain, syms]) => ({
      chain, token_count: syms.length, examples: [...new Set(syms)].slice(0, 8),
    })),
    aliases: CHAIN_ALIASES,
  };
}

async function getQuote(c, a) {
  const src = await resolveToken(c, a.from_token, a.from_chain);
  const dst = await resolveToken(c, a.to_token, a.to_chain);
  const units = toUnits(a.amount, src.decimals);
  const usd = usdCheck(src, a.amount);
  const slip = clampSlip(a.slippage_bps);
  // Estimate-only: no addresses needed (the operator's NEAR Intents account is used as a placeholder).
  const exact = a.recipient && a.refund_address;
  const placeholder = c.feeTo || "intents.near";
  const recipient = exact ? checkAddress(a.recipient, dst.blockchain, "recipient") : placeholder;
  const refund = exact ? checkAddress(a.refund_address, src.blockchain, "refund_address") : placeholder;
  const q = await oneclick(c, "/v0/quote",
    quoteBody(c, src, dst, units, recipient, refund, true, slip, !exact, { referrer: a.referrer, bps: effectiveBps(c, usd) }));
  const qq = q.quote || {};
  return {
    from: shapeToken(src), to: shapeToken(dst),
    amount_in: qq.amountInFormatted ?? String(a.amount),
    amount_in_usd: qq.amountInUsd ?? usd,
    estimated_amount_out: qq.amountOutFormatted,
    estimated_amount_out_usd: qq.amountOutUsd ?? null,
    minimum_amount_out: qq.minAmountOut ? fmtUnits(qq.minAmountOut, dst.decimals) : null,
    price_check: fairness(src, dst, qq.amountInFormatted ?? a.amount, qq.amountOutFormatted),
    estimated_seconds: qq.timeEstimate ?? null,
    slippage_bps: slip,
    fees: feeInfo(c, a.referrer, usd),
    note: "Estimate only. Call create_swap (or pay_exact) to get a deposit address.",
  };
}

function feeInfo(c, referrer, usd) {
  const bps = effectiveBps(c, usd);
  const split = feeSplit(c, referrer, bps);
  const ref = split.length > 1 ? split[1] : null;
  return {
    service_fee_bps: bps,
    volume_discounts: "0.30% standard, 0.25% for swaps over $1,000, 0.15% over $10,000",
    referrer: ref ? ref.recipient : null,
    referrer_earns_bps: ref ? ref.fee : 0,
    tip: ref ? undefined : "Pass referrer='<your NEAR account>' on any call to earn 1/3 of the fee on swaps you route. Same price for the user.",
  };
}

function depositReply(c, a, src, dst, qq, recipient, refund) {
  return {
    status: "AWAITING_DEPOSIT",
    deposit_address: qq.depositAddress,
    deposit_memo: qq.depositMemo || null,
    deposit_chain: src.blockchain,
    send_exactly: qq.amountInFormatted,
    send_token: shapeToken(src),
    deadline: qq.deadline ?? null,
    deposit_tx: depositTx(src, qq.depositAddress, qq.amountIn),
    estimated_amount_out: qq.amountOutFormatted,
    estimated_amount_out_usd: qq.amountOutUsd ?? null,
    minimum_amount_out: qq.minAmountOut ? fmtUnits(qq.minAmountOut, dst.decimals) : null,
    receive_token: shapeToken(dst),
    recipient, refund_address: refund,
    price_check: fairness(src, dst, qq.amountInFormatted, qq.amountOutFormatted),
    estimated_seconds: qq.timeEstimate ?? null,
    fees: feeInfo(c, a.referrer, Number(qq.amountInUsd) || usdOf(src, qq.amountInFormatted)),
    next_steps: [
      `Send exactly ${qq.amountInFormatted} ${src.symbol} on ${src.blockchain} to ${qq.depositAddress}` +
        (qq.depositMemo ? ` with memo ${qq.depositMemo}` : "") + ` before ${qq.deadline ?? "the deadline"}.` +
        (EVM[src.blockchain] ? " deposit_tx is a ready-to-sign transaction for EVM wallets." : ""),
      "Then call get_swap_status with this deposit_address and wait_seconds=25 until final=true.",
      "If the deposit is short or late, funds are refunded to refund_address automatically.",
    ],
  };
}

async function createSwap(c, a) {
  const src = await resolveToken(c, a.from_token, a.from_chain);
  const dst = await resolveToken(c, a.to_token, a.to_chain);
  const units = toUnits(a.amount, src.decimals);
  const usd = usdCheck(src, a.amount);
  const slip = clampSlip(a.slippage_bps);
  const recipient = checkAddress(a.recipient, dst.blockchain, "recipient");
  const refund = checkAddress(a.refund_address, src.blockchain, "refund_address");
  const q = await oneclick(c, "/v0/quote",
    quoteBody(c, src, dst, units, recipient, refund, false, slip, false, { referrer: a.referrer, bps: effectiveBps(c, usd) }));
  const qq = q.quote || {};
  if (!qq.depositAddress) throw new UserError("the swap network did not return a deposit address; try again");
  qq.amountInFormatted ??= String(a.amount);
  qq.amountIn ??= units;
  await recordSwap(c, a.referrer, Number(qq.amountInUsd) || usd);
  return depositReply(c, a, src, dst, qq, recipient, refund);
}

// Pay EXACTLY amount_out of a token to someone, funded by any token the agent holds.
async function payExact(c, a) {
  const src = await resolveToken(c, a.pay_with_token, a.pay_with_chain);
  const dst = await resolveToken(c, a.token, a.chain);
  const units = toUnits(a.amount_out, dst.decimals);
  const usd = Number(a.amount_out) * Number(dst.price || 0);
  if (usd && usd > MAX_USD) throw new UserError(`max per payment is $${MAX_USD}`);
  const slip = clampSlip(a.slippage_bps);
  const recipient = checkAddress(a.recipient, dst.blockchain, "recipient");
  const refund = checkAddress(a.refund_address, src.blockchain, "refund_address");
  const q = await oneclick(c, "/v0/quote",
    quoteBody(c, src, dst, units, recipient, refund, false, slip, false, { referrer: a.referrer, exactOutput: true, bps: effectiveBps(c, usd) }));
  const qq = q.quote || {};
  if (!qq.depositAddress || !qq.amountInFormatted) throw new UserError("the swap network did not return payment instructions; try again");
  await recordSwap(c, a.referrer, Number(qq.amountInUsd) || usd);
  const out = depositReply(c, a, src, dst, qq, recipient, refund);
  out.recipient_receives_exactly = `${a.amount_out} ${dst.symbol} on ${dst.blockchain}`;
  return out;
}

const usdOf = (t, amt) => (Number(amt) * Number(t.price || 0)) || null;

// ---- Gas station: get native gas on any chain, paid with any token
const GAS_NATIVE = { eth: "ETH", base: "ETH", arb: "ETH", op: "ETH", bsc: "BNB", pol: "POL", avax: "AVAX",
  gnosis: "XDAI", bera: "BERA", sol: "SOL", tron: "TRX", ton: "TON", sui: "SUI" };
async function refuelGas(c, a) {
  const chain = normChain(a.chain);
  const sym = GAS_NATIVE[chain];
  if (!sym) throw new UserError(`refuel_gas supports: ${Object.keys(GAS_NATIVE).join(", ")}. For other chains use pay_exact.`);
  const all = await getTokens(c);
  const native = all.find((t) => t.blockchain === chain && String(t.symbol).toUpperCase() === sym);
  if (!native || !native.price) throw new UserError(`native ${sym} on ${chain} isn't available right now`);
  const usd = Math.min(Math.max(Number(a.usd_amount) || 3, 1), 50);
  const amt = (usd / Number(native.price)).toFixed(Math.min(native.decimals, 8)).replace(/0+$/, "").replace(/\.$/, "");
  const out = await payExact(c, { token: sym, chain, amount_out: amt, pay_with_token: a.pay_with_token,
    pay_with_chain: a.pay_with_chain, recipient: a.recipient, refund_address: a.refund_address,
    slippage_bps: a.slippage_bps, referrer: a.referrer });
  out.gas = { chain, token: sym, amount: amt, approx_usd: usd };
  return out;
}

// ---- x402: read a "402 Payment Required" invoice and fund the agent's wallet on the right chain
const X402_NET = {
  base: "base", ethereum: "eth", mainnet: "eth", arbitrum: "arb", "arbitrum-one": "arb", optimism: "op",
  polygon: "pol", avalanche: "avax", bsc: "bsc", gnosis: "gnosis", berachain: "bera", solana: "sol",
  "solana-mainnet": "sol", "eip155:8453": "base", "eip155:1": "eth", "eip155:42161": "arb", "eip155:10": "op",
  "eip155:137": "pol", "eip155:43114": "avax", "eip155:56": "bsc", "eip155:100": "gnosis", "eip155:80094": "bera",
  "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp": "sol",
};
const X402_TESTNET = /sepolia|fuji|amoy|devnet|testnet|eip155:84532|eip155:11155111|eip155:43113|eip155:80002|solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1/i;
function parsePaymentRequired(input) {
  let v = input;
  if (typeof v === "string") {
    const s = v.trim();
    try { v = JSON.parse(s); } catch {
      try { v = JSON.parse(atob(s.replace(/-/g, "+").replace(/_/g, "/"))); } catch {
        throw new UserError("payment_required must be the 402 response body (JSON), or the base64 PAYMENT-REQUIRED header value.");
      }
    }
  }
  if (Array.isArray(v)) v = { accepts: v };
  if (v && !v.accepts && (v.payTo || v.pay_to)) v = { accepts: [v] };
  const accepts = (v && Array.isArray(v.accepts) ? v.accepts : []).map((e) => ({
    scheme: e.scheme || "exact",
    network: String(e.network || ""),
    asset: String(e.asset || e.token || ""),
    amount: String(e.maxAmountRequired ?? e.amount ?? e.price ?? ""),
    pay_to: e.payTo || e.pay_to || null,
    description: e.description || (v.resource && v.resource.description) || null,
    resource: (typeof e.resource === "string" ? e.resource : null) || (v.resource && v.resource.url) || null,
  }));
  if (!accepts.length) throw new UserError("No payment options found. Pass the full 402 body (it has an 'accepts' list).");
  return { version: v.x402Version ?? null, accepts };
}
async function resolveX402(c, e) {
  if (X402_TESTNET.test(e.network)) return { ...e, ok: false, why: "testnet: test tokens are free from a faucet, nothing to buy" };
  const chain = X402_NET[e.network.toLowerCase()] || X402_NET[e.network];
  if (!chain) return { ...e, ok: false, why: `network '${e.network}' not supported` };
  const all = await getTokens(c);
  const evm = /^0x/i.test(e.asset);
  const tok = all.find((t) => t.blockchain === chain && t.contractAddress &&
    (evm ? String(t.contractAddress).toLowerCase() === e.asset.toLowerCase() : t.contractAddress === e.asset));
  if (!tok) return { ...e, chain, ok: false, why: `token ${e.asset} on ${chain} not supported` };
  if (!/^\d+$/.test(e.amount)) return { ...e, chain, ok: false, why: "invalid amount" };
  return { ...e, chain, token: tok, ok: true, amount_human: fmtUnits(e.amount, tok.decimals) };
}
async function fundX402(c, a) {
  const pr = parsePaymentRequired(a.payment_required);
  const opts = await Promise.all(pr.accepts.map((e) => resolveX402(c, e)));
  const usable = opts.filter((o) => o.ok);
  const summary = opts.map((o) => ({ network: o.network, chain: o.chain || null, token: o.token ? o.token.symbol : o.asset,
    amount: o.amount_human || o.amount, pay_to: o.pay_to, supported: o.ok, reason: o.ok ? undefined : o.why }));
  if (!usable.length) throw new UserError("None of this invoice's payment options can be funded: " +
    summary.map((s) => `${s.network}: ${s.reason}`).join("; "));
  const want = normChain(a.prefer_network ? (X402_NET[String(a.prefer_network).toLowerCase()] || a.prefer_network) : null);
  const holdChain = normChain(a.pay_with_chain);
  const pick = usable.find((o) => want && o.chain === want) || usable.find((o) => o.chain === holdChain) ||
    usable.find((o) => o.chain === "base") || usable[0];
  const tok = pick.token;
  const price = Number(tok.price || 0);
  // Fund a small balance once (default ~$5) so many future 402 payments need no swap at all.
  const minUsd = Math.min(Math.max(Number(a.top_up_usd) || 5, 1), 500);
  const need = Number(pick.amount_human);
  let target = need;
  const stable = price && Math.abs(price - 1) < 0.03; // USDC/USDT: $5 means 5 tokens
  if (price && need * price < minUsd) target = stable ? minUsd : minUsd / price;
  const target_str = target.toFixed(Math.min(tok.decimals, 6)).replace(/0+$/, "").replace(/\.$/, "");
  const invoice = {
    pays_for: pick.description || pick.resource || null,
    network: pick.network, chain: pick.chain, token: shapeToken(tok),
    required_per_call: pick.amount_human, merchant_pay_to: pick.pay_to, scheme: pick.scheme,
    top_up_amount: target_str,
    covers_about: need > 0 ? Math.floor(target / need) + " calls at this price" : null,
    all_options: summary,
  };
  const why = "x402 payments are signed by YOUR wallet on the invoice's chain, so Swap Ripper tops up your wallet there " +
    "(exact amount, from any token on any chain). Then your x402 client pays the invoice as normal.";
  if (holdChain === pick.chain && a.pay_with_token &&
      String(a.pay_with_token).toUpperCase() === String(tok.symbol).toUpperCase()) {
    return { invoice, no_swap_needed: true, message: `You already hold ${tok.symbol} on ${pick.chain}. Pay the invoice directly with your x402 client.` };
  }
  if (!a.pay_with_token || !a.wallet || !a.refund_address) {
    let estimate = null;
    if (a.pay_with_token) {
      try {
        const q = await getQuote(c, { from_token: a.pay_with_token, from_chain: a.pay_with_chain, to_token: tok.assetId,
          amount: "1", referrer: a.referrer });
        const rate = Number(q.estimated_amount_out) || 0;
        if (rate) estimate = { pay_about: +(target / rate * 1.01).toPrecision(6), pay_token: q.from.symbol, pay_chain: q.from.chain };
      } catch { /* estimate is best-effort */ }
    }
    return { invoice, why, estimate,
      next_step: "Call fund_x402 again with pay_with_token, pay_with_chain, wallet (your address on " + pick.chain +
        ") and refund_address (your address on the chain you pay from) to get a deposit address." };
  }
  const out = await payExact(c, { token: tok.assetId, amount_out: target_str, pay_with_token: a.pay_with_token,
    pay_with_chain: a.pay_with_chain, recipient: a.wallet, refund_address: a.refund_address,
    slippage_bps: a.slippage_bps, referrer: a.referrer });
  track(c, "x402_funds");
  out.invoice = invoice;
  out.why = why;
  out.next_steps.push(`When get_swap_status says SUCCESS, your wallet ${a.wallet} holds ${target_str} ${tok.symbol} on ${pick.chain}: retry the original request and let your x402 client pay.`);
  return out;
}

// ---- Payment links: humans or agents get paid exactly N tokens; payer uses any token
async function createPaymentLink(c, a) {
  const dst = await resolveToken(c, a.token, a.chain);
  const to = checkAddress(a.recipient, dst.blockchain, "recipient");
  if (a.amount !== undefined && a.amount !== null && a.amount !== "") toUnits(a.amount, dst.decimals);
  const p = new URLSearchParams({ to, token: dst.symbol, chain: dst.blockchain });
  if (a.amount) p.set("amount", String(a.amount));
  if (a.label) p.set("label", String(a.label).slice(0, 80));
  const ref = a.referrer ? cleanReferrer(c, a.referrer) : null;
  if (ref) p.set("ref", ref);
  const url = `${c.origin}/pay?${p}`;
  track(c, "links_created");
  return {
    payment_link: url,
    receives: `${a.amount ? a.amount + " " : ""}${dst.symbol} on ${dst.blockchain}`,
    recipient: to,
    how_it_works: "Share the link. The payer picks any token on any chain; the recipient receives exactly this token. Non-custodial, auto-refund to the payer if anything fails.",
    markdown: `[Pay${a.amount ? " " + a.amount + " " + dst.symbol : ""} with any crypto](${url})`,
  };
}

// ---- anonymous usage counters (per day, counts only; no IPs or addresses stored)
let PENDING = null; // set per request to ctx.waitUntil
function track(c, event) {
  if (!c.kv) return;
  const day = new Date().toISOString().slice(0, 10);
  const job = (async () => {
    try {
      const k = `d:${day}`;
      const cur = JSON.parse((await c.kv.get(k)) || "{}");
      cur[event] = (cur[event] || 0) + 1;
      await c.kv.put(k, JSON.stringify(cur), { expirationTtl: 60 * 60 * 24 * 400 });
    } catch { /* never break requests */ }
  })();
  if (PENDING) PENDING(job);
}

async function usageStats(c, days = 14) {
  if (!c.kv) return { enabled: false };
  const out = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    const v = await c.kv.get(`d:${d}`);
    if (v) out.push({ day: d, ...JSON.parse(v) });
  }
  const totals = {};
  for (const r of out) for (const [k, v] of Object.entries(r)) if (k !== "day") totals[k] = (totals[k] || 0) + v;
  let all = { swaps: 0, usd: 0 };
  try { all = JSON.parse((await c.kv.get("total")) || '{"swaps":0,"usd":0}'); } catch {}
  return { enabled: true, window_days: days, totals, by_day: out, all_time_swaps_created: all.swaps, all_time_volume_usd: all.usd };
}

// ---- referral stats (optional Workers KV binding named STATS)
async function recordSwap(c, referrer, usd) {
  if (!c.kv) return;
  track(c, "swaps_created");
  let ref = null;
  try { ref = cleanReferrer(c, referrer); } catch { /* ignore */ }
  const keys = ["total", ...(ref ? [`ref:${ref}`] : [])];
  await Promise.all(keys.map(async (k) => {
    try {
      const cur = JSON.parse((await c.kv.get(k)) || '{"swaps":0,"usd":0}');
      cur.swaps += 1; cur.usd = +(cur.usd + (Number(usd) || 0)).toFixed(2); cur.last = new Date().toISOString();
      await c.kv.put(k, JSON.stringify(cur));
    } catch { /* stats must never break swaps */ }
  }));
}

async function referralStats(c, a) {
  const ref = cleanReferrer(c, a.referrer);
  if (!ref) throw new UserError("referrer is required, e.g. 'myagent.near'");
  if (!c.kv) return { referrer: ref, note: "Stats storage not enabled on this server yet. Your referral fees are still paid on-chain automatically." };
  const st = JSON.parse((await c.kv.get(`ref:${ref}`)) || '{"swaps":0,"usd":0}');
  const share = Math.floor(c.feeBps / 3) / 10000;
  return {
    referrer: ref, swaps_created: st.swaps, volume_usd: st.usd, last_swap: st.last || null,
    estimated_earnings_usd: +(st.usd * share).toFixed(2),
    note: "Counts swaps created with your referrer (some may not have been funded). Fees are paid on-chain to your NEAR account automatically.",
  };
}

// ---- plain-English quote
async function quoteFromText(c, a) {
  const t = String(a.request || "").trim();
  const m = t.match(/(?:swap|convert|exchange|trade|send|bridge)?\s*([\d.,]+)\s*\$?([A-Za-z0-9.@]+)(?:\s+(?:on|from|@)\s+([A-Za-z][A-Za-z0-9 -]*?))?\s+(?:to|for|into|->|=>)\s+\$?([A-Za-z0-9.@]+)(?:\s+(?:on|@)\s+([A-Za-z][A-Za-z0-9 -]*?))?\s*[.!?]?$/i);
  if (!m) throw new UserError("Couldn't parse that. Try: '25 USDC on solana to ETH on base'.");
  const [, amount, from, fromChain, to, toChain] = m;
  return getQuote(c, { from_token: from, from_chain: fromChain, to_token: to, to_chain: toChain,
    amount: amount.replace(/,/g, ""), referrer: a.referrer });
}

async function getPrices(c, a) {
  const all = await getTokens(c);
  let syms = a.symbols;
  if (typeof syms === "string") syms = syms.split(",");
  syms = (syms || []).map((x) => String(x).trim().toUpperCase()).filter(Boolean);
  const ch = normChain(a.chain);
  const rows = all.filter((t) => (!syms.length || syms.includes(String(t.symbol).toUpperCase()) ||
      (syms.includes("NEAR") && t.symbol === "wNEAR")) && (!ch || t.blockchain === ch))
    .map((t) => ({ symbol: t.symbol, chain: t.blockchain, price_usd: t.price ?? null, updated: t.priceUpdatedAt ?? null }));
  return { count: rows.length, prices: rows.slice(0, 200), source: "NEAR Intents token feed (free, no key)" };
}

async function compareQuotes(c, a) {
  let routes = a.routes;
  if (typeof routes === "string") { try { routes = JSON.parse(routes); } catch { routes = null; } }
  if (!Array.isArray(routes) || !routes.length) throw new UserError("routes must be a non-empty array of {from_token, from_chain, to_token, to_chain, amount}");
  if (routes.length > 10) throw new UserError("max 10 routes per call");
  const results = await Promise.allSettled(routes.map((r) => getQuote(c, { ...r, referrer: r.referrer ?? a.referrer })));
  const out = results.map((r, i) => r.status === "fulfilled"
    ? { route: i, ok: true, ...pick(r.value) }
    : { route: i, ok: false, error: r.reason?.message || String(r.reason) });
  const best = out.filter((x) => x.ok && x.estimated_amount_out_usd)
    .sort((x, y) => Number(y.estimated_amount_out_usd) - Number(x.estimated_amount_out_usd))[0];
  return { results: out, best_route_by_usd_out: best ? best.route : null };
}
const pick = (q) => ({
  from: `${q.from.symbol}@${q.from.chain}`, to: `${q.to.symbol}@${q.to.chain}`, amount_in: q.amount_in,
  estimated_amount_out: q.estimated_amount_out, estimated_amount_out_usd: q.estimated_amount_out_usd,
  price_check: q.price_check, estimated_seconds: q.estimated_seconds,
});

async function swapStatus(c, a) {
  if (!a.deposit_address) throw new UserError("deposit_address is required");
  const wait = Math.min(Math.max(Number(a.wait_seconds) || 0, 0), 25);
  const until = Date.now() + wait * 1000;
  let res = await fetchStatus(c, a);
  const first = res.status;
  while (!res.final && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 3000));
    res = await fetchStatus(c, a);
    if (res.status !== first) break;
  }
  if (!res.final) res.hint = "Not final yet. Call again with wait_seconds=25.";
  return res;
}

async function fetchStatus(c, a) {
  const p = new URLSearchParams({ depositAddress: a.deposit_address });
  if (a.deposit_memo) p.set("depositMemo", a.deposit_memo);
  const r = await fetchRetry(`${API}/v0/status?${p}`, { headers: headers(c) });
  const t = await r.text();
  let j; try { j = JSON.parse(t); } catch { j = { message: t }; }
  if (!r.ok) throw new UserError(`status unavailable: ${j.message || r.status}`);
  const d = j.swapDetails || {};
  const done = { SUCCESS: true, REFUNDED: true, FAILED: true }[j.status] || false;
  if (j.status === "SUCCESS" && c.kv) {
    try {
      const k = `done:${a.deposit_address}`;
      if (!(await c.kv.get(k))) { await c.kv.put(k, "1"); track(c, "swaps_completed"); }
    } catch { /* ignore */ }
  }
  return {
    status: j.status,
    final: done,
    meaning: STATUS_TEXT[j.status] || "",
    amount_in: d.amountInFormatted ?? null,
    amount_out: d.amountOutFormatted ?? null,
    amount_out_usd: d.amountOutUsd ?? null,
    refunded_amount: d.refundedAmountFormatted ?? null,
    origin_tx: (d.originChainTxHashes || []).map((x) => x.explorerUrl || x.hash),
    destination_tx: (d.destinationChainTxHashes || []).map((x) => x.explorerUrl || x.hash),
    updated_at: j.updatedAt ?? null,
  };
}

const STATUS_TEXT = {
  PENDING_DEPOSIT: "Waiting for the deposit to arrive.",
  KNOWN_DEPOSIT_TX: "Deposit transaction seen, waiting for confirmation.",
  PROCESSING: "Deposit received; solvers are executing the swap.",
  SUCCESS: "✅ Swap complete. Funds delivered to the recipient. Nice work.",
  INCOMPLETE_DEPOSIT: "Deposit was less than required. Send the remainder before the deadline, or it will be refunded automatically.",
  REFUNDED: "Swap could not complete, but no harm done: funds were returned to the refund address. You can safely try again with a fresh quote.",
  FAILED: "Swap failed; funds should be refunded.",
};

function clampSlip(v) {
  const n = Number.parseInt(v ?? "100", 10);
  if (Number.isNaN(n)) return 100;
  return Math.min(Math.max(n, 10), 500);
}
function fmtUnits(units, decimals) {
  const s = String(units).padStart(decimals + 1, "0");
  const w = s.slice(0, s.length - decimals), f = s.slice(s.length - decimals).replace(/0+$/, "");
  return f ? `${w}.${f}` : w;
}

// ------------------------------------------------------------------ MCP tool definitions
const REFERRER = { type: "string", description: "Optional: your NEAR account (e.g. 'myagent.near'). You earn 1/3 of the service fee on every swap routed with it. The user pays the same." };
const TOKEN_PROPS = {
  from_token: { type: "string", description: "Token to send: symbol ('USDC', 'ETH', 'BTC'), 'SYMBOL@chain', 'SYMBOL on chain', or an asset_id from search_tokens." },
  from_chain: { type: "string", description: "Chain the token is sent from, e.g. 'solana', 'base', 'ethereum', 'bitcoin'. Needed when the symbol exists on several chains." },
  to_token: { type: "string", description: "Token to receive (same formats as from_token)." },
  to_chain: { type: "string", description: "Chain to receive on." },
  amount: { type: "string", description: "Amount of from_token to send, as a human-readable decimal string, e.g. '25' or '0.015'. Not base units." },
  slippage_bps: { type: "integer", description: "Max slippage in basis points (default 100 = 1%, range 10-500)." },
  referrer: REFERRER,
};
const ADDR_PROPS = {
  recipient: { type: "string", description: "Address that receives the output, ON THE DESTINATION CHAIN." },
  refund_address: { type: "string", description: "Address for automatic refunds, ON THE SOURCE CHAIN. Usually the sending wallet." },
};

const TOOLS = [
  {
    name: "get_quote",
    title: "Get a cross-chain swap quote",
    description: "Live price for swapping any token to any token across 25+ chains (BTC, ETH, SOL, Base, Arbitrum, BNB, Tron, NEAR, Zcash, TON, Sui, XRP...). No addresses or keys needed, nothing committed. Includes a price_check against market rates so you can tell if the quote is fair.",
    inputSchema: { type: "object", required: ["from_token", "to_token", "amount"], properties: {
      ...TOKEN_PROPS,
      recipient: { type: "string", description: "Optional (with refund_address): destination address, for an exact quote." },
      refund_address: { type: "string", description: "Optional (with recipient): refund address on the source chain." },
    } },
    annotations: { readOnlyHint: true, openWorldHint: true },
    run: getQuote,
  },
  {
    name: "create_swap",
    title: "Swap tokens across chains",
    description: "Lock a quote and get a one-time deposit address. Send exactly `send_exactly` of the source token there and the output lands at `recipient` automatically, usually in under a minute. Non-custodial, no API key, no wallet connection, automatic refund on failure. For EVM sources, `deposit_tx` is a ready-to-sign transaction.",
    inputSchema: { type: "object", required: ["from_token", "to_token", "amount", "recipient", "refund_address"], properties: { ...TOKEN_PROPS, ...ADDR_PROPS } },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    run: createSwap,
  },
  {
    name: "pay_exact",
    title: "Pay an exact amount with any token",
    description: "Make sure a recipient gets EXACTLY a set amount (e.g. 10 USDC on Base), paid with whatever token and chain you hold (e.g. SOL on Solana). Ideal for paying invoices, topping up an x402/agent wallet, or funding gas on another chain. Returns the exact amount to send and a deposit address.",
    inputSchema: { type: "object", required: ["token", "amount_out", "pay_with_token", "recipient", "refund_address"], properties: {
      token: { type: "string", description: "Token the recipient must receive, e.g. 'USDC'." },
      chain: { type: "string", description: "Chain the recipient receives on, e.g. 'base'." },
      amount_out: { type: "string", description: "Exact amount the recipient must receive, e.g. '10'." },
      pay_with_token: { type: "string", description: "Token you will pay with, e.g. 'SOL'." },
      pay_with_chain: { type: "string", description: "Chain you pay from, e.g. 'solana'." },
      slippage_bps: TOKEN_PROPS.slippage_bps,
      ...ADDR_PROPS,
      referrer: REFERRER,
    } },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    run: payExact,
  },
  {
    name: "fund_x402",
    title: "Got HTTP 402? Fund your x402 wallet from any chain",
    description: "Hit a '402 Payment Required' (x402) paywall but your funds are on another chain or token? Paste the 402 response (body JSON or base64 PAYMENT-REQUIRED header, x402 v1 or v2). Swap Ripper reads the invoice, picks the right network and token (e.g. USDC on Base), and tops up YOUR wallet there with an exact amount, paid from any token on any chain (SOL, ETH, BTC, USDC on Solana...). Default top-up ~$5 so dozens of future 402 calls need no swap. Call with only payment_required to decode the invoice and see options; add pay_with_token, wallet and refund_address to get a deposit address.",
    inputSchema: { type: "object", required: ["payment_required"], properties: {
      payment_required: { description: "The 402 response body (object or JSON string) or the base64 PAYMENT-REQUIRED header value.", anyOf: [{ type: "string" }, { type: "object" }] },
      wallet: { type: "string", description: "YOUR address on the invoice's network (the wallet your x402 client signs with)." },
      pay_with_token: { type: "string", description: "Token you hold and will pay with, e.g. 'SOL' or 'USDC'." },
      pay_with_chain: { type: "string", description: "Chain you pay from, e.g. 'solana'." },
      refund_address: { type: "string", description: "Your address on the paying chain, for automatic refunds." },
      top_up_usd: { type: "number", description: "Minimum top-up in USD (1-500, default 5). The invoice amount is used if larger." },
      prefer_network: { type: "string", description: "Optional: which of the invoice's networks to fund, e.g. 'base' or 'solana'." },
      slippage_bps: TOKEN_PROPS.slippage_bps,
      referrer: REFERRER,
    } },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    run: fundX402,
  },
  {
    name: "create_payment_link",
    title: "Create a 'pay me in any crypto' link",
    description: "Create a shareable payment link (like an invoice). The payer can pay with ANY token on ANY chain; the recipient receives exactly the token you choose (e.g. 50 USDC on Base). Great for agents that sell services to humans or other agents. No account needed.",
    inputSchema: { type: "object", required: ["token", "recipient"], properties: {
      token: { type: "string", description: "Token to receive, e.g. 'USDC'." },
      chain: { type: "string", description: "Chain to receive on, e.g. 'base'." },
      amount: { type: "string", description: "Optional fixed amount, e.g. '50'. Leave empty to let the payer choose." },
      recipient: { type: "string", description: "Your address on that chain." },
      label: { type: "string", description: "Optional note shown to the payer, e.g. 'Invoice #12' (max 80 chars)." },
      referrer: REFERRER,
    } },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: createPaymentLink,
  },
  {
    name: "refuel_gas",
    title: "Gas station: get gas on any chain",
    description: "Stuck without gas? Get a small amount of the native gas token (ETH on Base/Arbitrum/Optimism/Ethereum, SOL, BNB, POL, AVAX, TRX, TON, SUI...) delivered to any address, paid with whatever token you hold on any chain. Default $3 worth.",
    inputSchema: { type: "object", required: ["chain", "recipient", "pay_with_token", "refund_address"], properties: {
      chain: { type: "string", description: "Chain that needs gas, e.g. 'base', 'solana', 'arbitrum'." },
      recipient: { type: "string", description: "Address that needs gas, on that chain." },
      usd_amount: { type: "number", description: "How much gas in USD (1-50, default 3)." },
      pay_with_token: { type: "string", description: "Token you pay with, e.g. 'USDC'." },
      pay_with_chain: { type: "string", description: "Chain you pay from, e.g. 'solana'." },
      refund_address: { type: "string", description: "Your address on the paying chain, for automatic refunds." },
      slippage_bps: TOKEN_PROPS.slippage_bps,
      referrer: REFERRER,
    } },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    run: refuelGas,
  },
  {
    name: "quote_from_text",
    title: "Quote from plain English",
    description: "Get a quote from a plain-English request like '25 USDC on solana to ETH on base' or 'swap 0.1 BTC for SOL'. Same output as get_quote.",
    inputSchema: { type: "object", required: ["request"], properties: {
      request: { type: "string", description: "e.g. '25 USDC on solana to ETH on base'" },
      referrer: REFERRER,
    } },
    annotations: { readOnlyHint: true, openWorldHint: true },
    run: quoteFromText,
  },
  {
    name: "referral_stats",
    title: "Check your referral earnings",
    description: "See how many swaps and how much volume your referrer account has routed, and estimated earnings. Fees are paid on-chain to your NEAR account automatically.",
    inputSchema: { type: "object", required: ["referrer"], properties: { referrer: REFERRER } },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: referralStats,
  },
  {
    name: "get_swap_status",
    title: "Track a swap (can wait for you)",
    description: "Check a swap by deposit address. Set wait_seconds (up to 25) and the server waits for the status to change before answering, so you need fewer calls. Statuses: PENDING_DEPOSIT, PROCESSING, SUCCESS, INCOMPLETE_DEPOSIT, REFUNDED, FAILED. `final=true` means done.",
    inputSchema: { type: "object", required: ["deposit_address"], properties: {
      deposit_address: { type: "string", description: "deposit_address returned by create_swap or pay_exact." },
      deposit_memo: { type: "string", description: "deposit_memo, if one was returned." },
      wait_seconds: { type: "integer", description: "0-25. Server-side wait for a status change (long-poll)." },
    } },
    annotations: { readOnlyHint: true, openWorldHint: true },
    run: swapStatus,
  },
  {
    name: "compare_quotes",
    title: "Compare up to 10 swap routes at once",
    description: "Quote up to 10 routes in a single call (e.g. pay with USDC on Solana vs USDC on Base vs ETH) and get the best one by USD output. Saves round trips.",
    inputSchema: { type: "object", required: ["routes"], properties: {
      routes: { type: "array", maxItems: 10, description: "List of {from_token, from_chain, to_token, to_chain, amount}.",
        items: { type: "object", required: ["from_token", "to_token", "amount"], properties: {
          from_token: TOKEN_PROPS.from_token, from_chain: TOKEN_PROPS.from_chain,
          to_token: TOKEN_PROPS.to_token, to_chain: TOKEN_PROPS.to_chain, amount: TOKEN_PROPS.amount } } },
      referrer: REFERRER,
    } },
    annotations: { readOnlyHint: true, openWorldHint: true },
    run: compareQuotes,
  },
  {
    name: "get_prices",
    title: "Free multi-chain token prices",
    description: "Free USD prices for tokens across 25+ chains in one call. No API key, no rate-limit sign-up. Filter by symbols (e.g. ['BTC','ETH','SOL']) and/or chain.",
    inputSchema: { type: "object", properties: {
      symbols: { type: "array", items: { type: "string" }, description: "Symbols to price. Empty = all." },
      chain: { type: "string", description: "Optional chain filter." },
    } },
    annotations: { readOnlyHint: true, openWorldHint: true },
    run: getPrices,
  },
  {
    name: "search_tokens",
    title: "Search supported tokens",
    description: "Find supported tokens by symbol and/or chain. Returns symbol, chain, asset_id, decimals, contract and USD price.",
    inputSchema: { type: "object", properties: {
      query: { type: "string", description: "Symbol or part of it, e.g. 'USDC'. Empty = all." },
      chain: { type: "string", description: "Optional chain filter, e.g. 'solana', 'base'." },
      limit: { type: "integer", description: "Max results (1-100, default 25)." },
    } },
    annotations: { readOnlyHint: true, openWorldHint: true },
    run: searchTokens,
  },
  {
    name: "list_chains",
    title: "List supported blockchains",
    description: "Every supported blockchain with example tokens and accepted chain-name aliases.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true, openWorldHint: true },
    run: listChains,
  },
];
const TOOL_MAP = Object.fromEntries(TOOLS.map((t) => [t.name, t]));
const publicTools = () => TOOLS.map(({ run, ...t }) => t);

// ------------------------------------------------------------------ MCP JSON-RPC
async function handleRpc(msg, c) {
  const { id, method, params = {} } = msg || {};
  const isNote = id === undefined || id === null;
  const ok = (result) => ({ jsonrpc: "2.0", id, result });
  const err = (code, message) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

  if (!msg || msg.jsonrpc !== "2.0" || typeof method !== "string") return err(-32600, "Invalid Request");
  if (method.startsWith("notifications/")) return null;

  switch (method) {
    case "initialize":
      track(c, "mcp_connects");
      return ok({
        protocolVersion: params.protocolVersion || "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: NAME, title: "Swap Ripper: cross-chain swaps", version: VERSION },
        instructions: INSTRUCTIONS,
      });
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: publicTools() });
    case "tools/call": {
      const tool = TOOL_MAP[params.name];
      if (!tool) return err(-32602, `Unknown tool: ${params.name}`);
      track(c, `tool:${tool.name}`);
      try {
        const out = await tool.run(c, params.arguments || {});
        return ok({ content: [{ type: "text", text: JSON.stringify(out, null, 2) }], structuredContent: out, isError: false });
      } catch (e) {
        const message = e instanceof UserError ? e.message : `Temporary error: ${e.message}. Try again shortly.`;
        return ok({ content: [{ type: "text", text: message }], isError: true });
      }
    }
    case "resources/list": return ok({ resources: [] });
    case "prompts/list": return ok({ prompts: [] });
    default:
      return isNote ? null : err(-32601, `Method not found: ${method}`);
  }
}

async function handleMcp(request, c) {
  if (request.method === "GET") {
    return json({ error: "This MCP server uses stateless Streamable HTTP. POST JSON-RPC to this URL." }, 405, { Allow: "POST" });
  }
  if (request.method === "DELETE") return new Response(null, { status: 204, headers: cors });
  let body;
  try { body = await request.json(); } catch {
    return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
  }
  if (Array.isArray(body)) {
    const out = (await Promise.all(body.map((m) => handleRpc(m, c)))).filter(Boolean);
    return out.length ? json(out) : new Response(null, { status: 202, headers: cors });
  }
  const res = await handleRpc(body, c);
  return res ? json(res) : new Response(null, { status: 202, headers: cors });
}

// ------------------------------------------------------------------ REST
async function handleRest(request, url, c) {
  const route = url.pathname.replace(/^\/api\/?/, "");
  let args = Object.fromEntries(url.searchParams);
  if (request.method === "POST") {
    try { args = { ...args, ...(await request.json()) }; } catch { /* empty body ok */ }
  }
  const map = { tokens: "search_tokens", chains: "list_chains", quote: "get_quote", swap: "create_swap", pay: "pay_exact", status: "get_swap_status", prices: "get_prices", compare: "compare_quotes", text: "quote_from_text", referrals: "referral_stats", link: "create_payment_link", gas: "refuel_gas", x402: "fund_x402" };
  const tool = TOOL_MAP[map[route]];
  if (tool) track(c, `rest:${route}`);
  if (!tool) return json({ error: "Unknown endpoint", endpoints: Object.keys(map).map((k) => `/api/${k}`) }, 404);
  if (["swap", "pay", "compare", "gas", "x402"].includes(route) && request.method !== "POST") return json({ error: `Use POST for /api/${route}` }, 405);
  try { return json(await tool.run(c, args)); }
  catch (e) { return json({ error: e.message }, e instanceof UserError ? 400 : 502); }
}

function openapi(origin) {
  const q = (name, required, desc) => ({ name, in: "query", required, schema: { type: "string" }, description: desc });
  const tp = TOKEN_PROPS;
  const post = (opId, summary, schema) => ({ post: { operationId: opId, summary,
    requestBody: { required: true, content: { "application/json": { schema } } }, responses: { 200: { description: "OK" }, 400: { description: "Fixable input error with explanation" } } } });
  const t = (n) => TOOL_MAP[n].inputSchema;
  return {
    openapi: "3.1.0",
    info: { title: "Swap Ripper: cross-chain swaps for AI agents", version: VERSION, description: DESCRIPTION },
    servers: [{ url: origin }],
    paths: {
      "/api/quote": { get: { operationId: "getQuote", summary: "Live cross-chain quote with fair-price check (no commitment)",
        parameters: ["from_token", "from_chain", "to_token", "to_chain", "amount", "slippage_bps", "referrer"].map((k) => q(k, ["from_token", "to_token", "amount"].includes(k), tp[k]?.description)),
        responses: { 200: { description: "Quote" } } } },
      "/api/swap": post("createSwap", "Create swap, get deposit address", t("create_swap")),
      "/api/pay": post("payExact", "Recipient gets an exact amount, paid with any token", t("pay_exact")),
      "/api/compare": post("compareQuotes", "Compare up to 10 routes", t("compare_quotes")),
      "/api/x402": post("fundX402", "Decode an HTTP 402 (x402) invoice and fund your wallet on its chain from any chain", t("fund_x402")),
      "/api/status": { get: { operationId: "getSwapStatus", summary: "Swap status (optional long-poll)",
        parameters: [q("deposit_address", true), q("deposit_memo", false), q("wait_seconds", false, "0-25 server-side wait")], responses: { 200: { description: "Status" } } } },
      "/api/prices": { get: { operationId: "getPrices", summary: "Free multi-chain token prices",
        parameters: [q("symbols", false, "Comma-separated, e.g. BTC,ETH,SOL"), q("chain", false)], responses: { 200: { description: "Prices" } } } },
      "/api/tokens": { get: { operationId: "searchTokens", summary: "Search supported tokens",
        parameters: [q("query", false), q("chain", false), q("limit", false)], responses: { 200: { description: "Tokens" } } } },
      "/api/text": { get: { operationId: "quoteFromText", summary: "Quote from plain English",
        parameters: [q("request", true, "e.g. '25 USDC on solana to ETH on base'"), q("referrer", false)], responses: { 200: { description: "Quote" } } } },
      "/api/referrals": { get: { operationId: "referralStats", summary: "Referral earnings",
        parameters: [q("referrer", true, "Your NEAR account")], responses: { 200: { description: "Stats" } } } },
      "/api/chains": { get: { operationId: "listChains", summary: "List supported chains", responses: { 200: { description: "Chains" } } } },
    },
  };
}

function llmsTxt(origin, c) {
  return `# Swap Ripper: cross-chain swaps for AI agents

> ${DESCRIPTION}

- Service fee: ${c.feeBps / 100}%, built into quotes, with volume discounts (0.25% over $1k, 0.15% over $10k). No API key. No sign-up. Non-custodial.
- Referral program: pass referrer=<your NEAR account> on any call and earn 1/3 of the fee on swaps you route. Same price for the user.

## Connect
- MCP (Streamable HTTP, no auth): ${origin}/mcp
- REST: ${origin}/api/{quote,text,swap,pay,x402,gas,link,compare,status,prices,tokens,chains,referrals}
- OpenAPI: ${origin}/openapi.json
- A2A agent card: ${origin}/.well-known/agent.json

## Tools
${TOOLS.map((t) => `- ${t.name}: ${t.description}`).join("\n")}

## Workflow
${INSTRUCTIONS}

## Examples
- Quote: GET ${origin}/api/quote?from_token=USDC&from_chain=solana&to_token=ETH&to_chain=base&amount=25
- Swap: POST ${origin}/api/swap {"from_token":"USDC","from_chain":"solana","to_token":"ETH","to_chain":"base","amount":"25","recipient":"0x...","refund_address":"<solana address>","referrer":"myagent.near"}
- Pay exactly 10 USDC on Base with SOL: POST ${origin}/api/pay {"token":"USDC","chain":"base","amount_out":"10","pay_with_token":"SOL","pay_with_chain":"solana","recipient":"0x...","refund_address":"<solana address>"}
- Got HTTP 402 (x402)? Decode it: POST ${origin}/api/x402 {"payment_required": <the 402 body>}. Fund it from Solana: add "pay_with_token":"USDC","pay_with_chain":"solana","wallet":"0x<your base wallet>","refund_address":"<solana address>"
- Track: GET ${origin}/api/status?deposit_address=...&wait_seconds=25

## Terms
Not available to sanctioned persons or in sanctioned jurisdictions. No illegal funds. Provided as-is.
Crypto sent to a wrong address cannot be recovered; refunds go to refund_address automatically.
`;
}

function agentCard(origin) {
  return {
    name: "Swap Ripper",
    description: DESCRIPTION,
    url: `${origin}/mcp`,
    version: VERSION,
    provider: { organization: "Swap Ripper", url: origin },
    documentationUrl: `${origin}/llms.txt`,
    capabilities: { streaming: false, pushNotifications: false },
    defaultInputModes: ["application/json"],
    defaultOutputModes: ["application/json"],
    interfaces: { mcp: `${origin}/mcp`, rest: `${origin}/api`, openapi: `${origin}/openapi.json` },
    skills: TOOLS.map((t) => ({ id: t.name, name: t.title, description: t.description,
      tags: ["crypto", "swap", "cross-chain", "bridge", "defi", "payments", "x402", "near-intents"] })),
  };
}

const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7c3aed"/><stop offset="1" stop-color="#06b6d4"/></linearGradient></defs><rect width="64" height="64" rx="14" fill="url(#g)"/><path d="M36 8 18 36h12l-4 20 20-30H34z" fill="#fff"/></svg>`;

function serverJson(origin) {
  return {
    $schema: "https://static.modelcontextprotocol.io/schemas/2025-09-29/server.schema.json",
    name: "io.github.swapripper/swap-ripper",
    title: "Swap Ripper",
    description: "Cross-chain token swaps across 25+ blockchains for AI agents. Non-custodial, no API key.",
    version: VERSION,
    icons: [{ src: `${origin}/icon.svg`, mimeType: "image/svg+xml", sizes: ["any"] }],
    remotes: [{ type: "streamable-http", url: `${origin}/mcp` }],
  };
}

function landing(origin, c) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Swap Ripper: cross-chain swaps for AI agents (MCP)</title>
<meta name="description" content="${DESCRIPTION}">
<link rel="alternate" type="text/plain" href="/llms.txt" title="llms.txt"><link rel="icon" href="/icon.svg" type="image/svg+xml">
<style>:root{color-scheme:light dark}body{font:16px/1.6 system-ui,sans-serif;max-width:780px;margin:40px auto;padding:0 20px}
code,pre{background:rgba(127,127,127,.15);border-radius:6px}pre{padding:12px;overflow:auto}code{padding:2px 5px}
h1{margin-bottom:0}.sub{opacity:.75;margin-top:4px}.tag{display:inline-block;border:1px solid rgba(127,127,127,.4);border-radius:99px;padding:1px 10px;margin:2px;font-size:13px}
table{border-collapse:collapse;width:100%}td{padding:6px 8px;border-top:1px solid rgba(127,127,127,.25);vertical-align:top}</style></head><body>
<h1>⚡ Swap Ripper</h1><p class="sub">Cross-chain swaps for AI agents, in one tool call.</p>
<p>${DESCRIPTION}</p>
<p><span class="tag">MCP</span><span class="tag">REST + OpenAPI</span><span class="tag">A2A card</span><span class="tag">No API key</span><span class="tag">Non-custodial</span><span class="tag">Auto-refund</span><span class="tag">${c.feeBps / 100}% fee, lower for big swaps</span><span class="tag">Referral rewards</span></p>
<h2>Connect in 10 seconds</h2><pre>${origin}/mcp</pre>
<pre>{ "mcpServers": { "swap-ripper": { "url": "${origin}/mcp" } } }</pre>
<h2>What agents can do</h2><table>${TOOLS.map((t) => `<tr><td><code>${t.name}</code></td><td>${t.description}</td></tr>`).join("")}</table>
<h2>Got HTTP 402? Pay it from any chain</h2><p>x402 paywalls usually want USDC on Base, but your agent's money is on Solana, Ethereum or Bitcoin? Pass the 402 response to <code>fund_x402</code>. It reads the invoice and tops up your wallet on the right chain with an exact amount, paid with whatever you hold. Fund once (~$5) and dozens of future 402 calls need no swap.</p>
<h2>Get paid in any crypto</h2><p>Make a payment link in seconds: your customer pays with whatever coin they hold, and you receive exactly the token you want. <a href="/pay"><b>Create a payment link →</b></a></p>
<h2>Gas station</h2><p>Out of gas on Base, Arbitrum, Solana or 10 other chains? <code>refuel_gas</code> delivers a few dollars of native gas to any address, paid with any token.</p>
<h2>Earn by routing swaps</h2><p>Pass <code>referrer: "yourname.near"</code> on any call. You earn <b>1/3 of the fee</b> on every swap you route, paid automatically on-chain. Users pay the same price.</p>
<h2>REST</h2><pre>GET  ${origin}/api/quote?from_token=USDC&from_chain=solana&to_token=ETH&to_chain=base&amount=25
POST ${origin}/api/swap      POST ${origin}/api/pay      POST ${origin}/api/x402      POST ${origin}/api/compare
GET  ${origin}/api/status?deposit_address=...&wait_seconds=25
GET  ${origin}/api/prices?symbols=BTC,ETH,SOL</pre>
<p><a href="/openapi.json">OpenAPI</a> · <a href="/llms.txt">llms.txt</a> · <a href="/.well-known/agent.json">Agent card</a> · <a href="/server.json">MCP registry entry</a> · Humans: <a href="https://t.me/IntentsSwapRipperBot">Telegram bot</a></p>
<p style="font-size:13px;opacity:.7">Powered by NEAR Intents. Not available to sanctioned persons or jurisdictions. Provided as-is; double-check addresses.</p>
</body></html>`;
}

// ------------------------------------------------------------------ payment page (/pay)
const esc = (x) => String(x ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
const PAY_WITH = [
  ["USDC", "sol"], ["USDC", "base"], ["USDC", "eth"], ["USDC", "arb"], ["USDT", "tron"], ["USDT", "eth"],
  ["ETH", "eth"], ["ETH", "base"], ["ETH", "arb"], ["SOL", "sol"], ["BTC", "btc"], ["BNB", "bsc"],
  ["NEAR", "near"], ["ZEC", "zec"], ["DOGE", "doge"], ["XRP", "xrp"], ["TRX", "tron"], ["TON", "ton"], ["SUI", "sui"],
];

function payPage(origin, q) {
  const cfgJson = JSON.stringify({ to: q.get("to") || "", token: q.get("token") || "", chain: q.get("chain") || "",
    amount: q.get("amount") || "", label: q.get("label") || "", ref: q.get("ref") || "", payWith: PAY_WITH })
    .replace(/</g, "\\u003c");
  const builder = !q.get("to");
  const title = builder ? "Create a crypto payment link" : `Pay ${esc(q.get("amount") || "")} ${esc(q.get("token") || "")}`.replace(/\s+/g, " ");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · Swap Ripper</title>
<meta name="description" content="Pay with any crypto on any chain. The recipient gets exactly what they asked for. Non-custodial, auto-refund.">
<style>:root{color-scheme:light dark;--b:rgba(127,127,127,.35)}*{box-sizing:border-box}
body{font:16px/1.5 system-ui,sans-serif;max-width:520px;margin:32px auto;padding:0 16px}
.card{border:1px solid var(--b);border-radius:14px;padding:20px;margin:14px 0}
h1{font-size:22px;margin:0 0 4px}.sub{opacity:.7;margin:0 0 10px;font-size:14px}
label{display:block;font-size:13px;opacity:.8;margin:12px 0 4px}
input,select,button{font:inherit;width:100%;padding:10px 12px;border-radius:10px;border:1px solid var(--b);background:transparent;color:inherit}
button{background:#5b5bf0;color:#fff;border:none;margin-top:16px;cursor:pointer;font-weight:600}button:disabled{opacity:.5}
.big{font-size:28px;font-weight:700}.mono{font-family:ui-monospace,monospace;word-break:break-all;font-size:14px;background:rgba(127,127,127,.12);padding:10px;border-radius:8px}
.row{display:flex;gap:8px;align-items:center}.row .mono{flex:1}.copy{width:auto;margin:0;padding:8px 12px;font-size:13px}
.ok{color:#1a9b4b;font-weight:600}.err{color:#d33}.muted{opacity:.65;font-size:13px}.hide{display:none}
.steps{font-size:14px;padding-left:18px}</style></head><body>
<div id="app"></div>
<p class="muted">Powered by <a href="/">Swap Ripper</a> on NEAR Intents · Non-custodial: funds go straight to the recipient, with automatic refund if anything fails. Not available in sanctioned jurisdictions.</p>
<script>
const C = ${cfgJson};
const $ = (h) => { const d = document.createElement("div"); d.innerHTML = h; return d.firstElementChild; };
const app = document.getElementById("app");
const e = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const copyBtn = (v) => '<button class="copy" data-v="' + e(v) + '">Copy</button>';
document.addEventListener("click", (ev) => { const b = ev.target.closest(".copy"); if (b) { navigator.clipboard.writeText(b.dataset.v); b.textContent = "Copied ✓"; setTimeout(() => b.textContent = "Copy", 1500); } });
const opts = C.payWith.map(([s, ch]) => '<option value="' + s + '|' + ch + '">' + s + ' on ' + ch + '</option>').join("") + '<option value="other">Other…</option>';

if (!C.to) {
  app.append($('<div class="card"><h1>⚡ Get paid in any crypto</h1><p class="sub">Make a link. Your customer pays with whatever coin they have, and you receive exactly the token you want.</p>' +
    '<label>Receive token</label><input id="t" value="USDC"><label>Receive on chain</label><input id="ch" value="base">' +
    '<label>Your address on that chain</label><input id="to" placeholder="0x... / your wallet address">' +
    '<label>Amount (optional, leave empty to let the payer choose)</label><input id="am" placeholder="50">' +
    '<label>Note shown to payer (optional)</label><input id="lb" placeholder="Invoice #12">' +
    '<button id="mk">Create payment link</button><div id="out"></div></div>'));
  document.getElementById("mk").onclick = async () => {
    const out = document.getElementById("out"); out.innerHTML = "Creating…";
    const body = { token: t.value, chain: ch.value, recipient: to.value.trim(), amount: am.value.trim(), label: lb.value.trim() };
    const r = await fetch("/api/link?" + new URLSearchParams(body)); const j = await r.json();
    out.innerHTML = j.error ? '<p class="err">' + e(j.error) + '</p>' :
      '<label>Your link</label><div class="row"><div class="mono">' + e(j.payment_link) + '</div>' + copyBtn(j.payment_link) + '</div><p class="muted">Send it to anyone. You receive ' + e(j.receives) + '.</p>';
  };
} else {
  app.append($('<div class="card"><p class="sub">' + (C.label ? e(C.label) : "Payment request") + '</p>' +
    '<div class="big">' + (C.amount ? e(C.amount) + ' ' : '') + e(C.token) + '</div><p class="sub">to ' + e(C.to.slice(0, 8)) + '…' + e(C.to.slice(-6)) + ' on ' + e(C.chain) + '</p>' +
    (C.amount ? '' : '<label>Amount of ' + e(C.token) + ' to send</label><input id="am" placeholder="25">') +
    '<label>Pay with</label><select id="pw">' + opts + '</select>' +
    '<input id="pwo" class="hide" placeholder="SYMBOL@chain, e.g. PEPE@eth" style="margin-top:8px">' +
    '<label>Your refund address (on the chain you pay from)</label><input id="rf" placeholder="Only used if the payment can\\'t complete">' +
    '<button id="go">Get payment address</button><div id="out"></div></div>'));
  pw.onchange = () => pwo.classList.toggle("hide", pw.value !== "other");
  document.getElementById("go").onclick = async () => {
    const out = document.getElementById("out"), btn = document.getElementById("go");
    let [ps, pc] = pw.value === "other" ? pwo.value.split("@") : pw.value.split("|");
    const amount = C.amount || (document.getElementById("am") || {}).value;
    if (!amount) { out.innerHTML = '<p class="err">Enter an amount.</p>'; return; }
    btn.disabled = true; out.innerHTML = "<p>Finding the best price…</p>";
    const body = { token: C.token, chain: C.chain, amount_out: amount, pay_with_token: ps, pay_with_chain: pc, recipient: C.to, refund_address: rf.value.trim() };
    if (C.ref) body.referrer = C.ref;
    const r = await fetch("/api/pay", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json(); btn.disabled = false;
    if (j.error) { out.innerHTML = '<p class="err">' + e(j.error) + '</p>'; return; }
    btn.classList.add("hide");
    out.innerHTML = '<label>Send exactly</label><div class="row"><div class="mono big" style="font-size:20px">' + e(j.send_exactly) + ' ' + e(j.send_token.symbol) + '</div>' + copyBtn(j.send_exactly) + '</div>' +
      '<p class="muted">on the <b>' + e(j.deposit_chain) + '</b> network</p>' +
      '<label>To this one-time address</label><div class="row"><div class="mono">' + e(j.deposit_address) + '</div>' + copyBtn(j.deposit_address) + '</div>' +
      (j.deposit_memo ? '<label>Memo (required)</label><div class="row"><div class="mono">' + e(j.deposit_memo) + '</div>' + copyBtn(j.deposit_memo) + '</div>' : '') +
      '<p class="muted">Send before ' + e(new Date(j.deadline).toLocaleString()) + '. Recipient gets exactly ' + e(amount) + ' ' + e(C.token) + '.</p>' +
      '<p id="st" class="sub">⏳ Waiting for your payment…</p>';
    const st = document.getElementById("st");
    const poll = async () => {
      try {
        const s = await (await fetch("/api/status?" + new URLSearchParams({ deposit_address: j.deposit_address, deposit_memo: j.deposit_memo || "", wait_seconds: 20 }))).json();
        if (s.status === "SUCCESS") { st.innerHTML = '<span class="ok">✅ Paid! The recipient received ' + e(amount) + ' ' + e(C.token) + '.</span>'; return; }
        if (s.status === "REFUNDED" || s.status === "FAILED") { st.innerHTML = '<span class="err">' + e(s.meaning) + '</span>'; return; }
        if (s.status === "PROCESSING" || s.status === "KNOWN_DEPOSIT_TX") st.textContent = "🔄 Payment received, delivering…";
        if (s.status === "INCOMPLETE_DEPOSIT") st.textContent = "⚠️ " + s.meaning;
      } catch {}
      setTimeout(poll, 3000);
    };
    poll();
  };
}
</script></body></html>`;
}

// ------------------------------------------------------------------ entry
export default {
  async fetch(request, env, ctx) {
    PENDING = ctx && ctx.waitUntil ? (p) => ctx.waitUntil(p) : null;
    const url = new URL(request.url);
    const origin = url.origin;
    const c = cfg(env);
    c.origin = origin;
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    const country = request.cf && request.cf.country;
    if (country && BLOCKED_COUNTRIES.has(country) && url.pathname !== "/") {
      return json({ error: "This service is not available in your region." }, 451);
    }

    const path = url.pathname.replace(/\/+$/, "") || "/";
    try {
      if (path === "/mcp" || (path === "/" && request.method === "POST")) return await handleMcp(request, c);
      if (path.startsWith("/api")) return await handleRest(request, url, c);
      if (path === "/openapi.json") { track(c, "view:openapi"); return json(openapi(origin)); }
      if (path === "/llms.txt") { track(c, "view:llms"); return text(llmsTxt(origin, c)); }
      if (path === "/stats") return json(await usageStats(c, Math.min(Number(url.searchParams.get("days")) || 14, 60)));
      if (path === "/.well-known/mcp.json" || path === "/.well-known/mcp") {
        return json({ name: NAME, version: VERSION, description: DESCRIPTION, transport: "streamable-http", url: `${origin}/mcp` });
      }
      if (path === "/.well-known/agent.json" || path === "/.well-known/agent-card.json") { track(c, "view:agent_card"); return json(agentCard(origin)); }
      if (path === "/server.json") return json(serverJson(origin));
      if (path === "/icon.svg" || path === "/favicon.svg" || path === "/favicon.ico") return new Response(ICON_SVG, { headers: { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=86400", ...cors } });
      if (path === "/health") return json({ ok: true, version: VERSION, fee_bps: c.feeBps, fee_recipient_set: !!c.feeTo, api_key_set: !!c.jwt });
      if (path === "/") { track(c, "view:home"); return text(landing(origin, c), "text/html"); }
      if (path === "/pay") { track(c, url.searchParams.get("to") ? "view:pay_link" : "view:pay_builder"); return text(payPage(origin, url.searchParams), "text/html"); }
      return json({ error: "Not found" }, 404);
    } catch (e) {
      return json({ error: `Internal error: ${e.message}` }, 500);
    }
  },
};
