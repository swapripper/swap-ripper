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

const VERSION = "2.1.0";
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
  "Intents solver network. One `pay` tool handles any payment request (x402, Solana Pay, EIP-681, Bitcoin links, plain text). Every quote is checked live against a competing network (proven best price). Automatic refund if a swap can't complete. Also: fund x402 (HTTP 402) payments " +
  "from any chain, pay exact amounts, gas refuel, and 'pay me in any crypto' links.";

const INSTRUCTIONS =
  "Owners can cap an agent's spending with create_spending_policy (policy-locked URL, daily limits, kill switch). " +
  "Selling something? create_payment_link gives you an invoice; check_payment tells you when it's paid; get_receipt gives signed proof. " +
  "Need to pay something? Pass ANY payment request (link, URI, 402 invoice, or plain text) to the pay tool. " +
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
    relayKey: String(env.RELAY_API_KEY || "").trim(),
    relayFeeTo: String(env.RELAY_FEE_TO || "").trim().toLowerCase(),
    receiptSecret: String(env.RECEIPT_SECRET || env.ONECLICK_JWT || "swap-ripper"),
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
function discountText(c) {
  const parts = [`${(c.feeBps / 100).toFixed(2)}% standard`];
  for (const [min, cap] of [...TIERS].reverse()) if (cap < c.feeBps) parts.push(`${(cap / 100).toFixed(2)}% over $${min.toLocaleString("en-US")}`);
  return parts.join(", ");
}
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

// ---- Proven best price: compare every quote with Relay's direct price (no partner fee on their side)
const RELAY_API = "https://api.relay.link";
const RELAY_CHAIN = { eth: 1, base: 8453, arb: 42161, op: 10, bsc: 56, pol: 137, avax: 43114, gnosis: 100,
  bera: 80094, sol: 792703809, btc: 8253038 };
const RELAY_NATIVE = { sol: "11111111111111111111111111111111", btc: "bc1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqmql8k8" };
const RELAY_PLACEHOLDER = { evm: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
  sol: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", btc: "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh" };
function relayCurrency(t) {
  const ch = t.blockchain;
  if (!(ch in RELAY_CHAIN)) return null;
  const nativeSym = { sol: "SOL", btc: "BTC" }[ch] || NATIVE[ch];
  if (String(t.symbol).toUpperCase() === nativeSym && !t.contractAddress) return RELAY_NATIVE[ch] || "0x0000000000000000000000000000000000000000";
  if (ch === "btc") return null;
  return t.contractAddress || null;
}
const relayAddr = (ch, given) => given || (ch === "sol" ? RELAY_PLACEHOLDER.sol : ch === "btc" ? RELAY_PLACEHOLDER.btc : RELAY_PLACEHOLDER.evm);
async function relayDirectOut(src, dst, units, recipient, refund) {
  const oc = relayCurrency(src), dc = relayCurrency(dst);
  if (!oc || !dc) return null;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 3500);
  try {
    const r = await fetch(`${RELAY_API}/quote/v2`, { method: "POST", signal: ctl.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user: relayAddr(src.blockchain, refund), recipient: relayAddr(dst.blockchain, recipient),
        originChainId: RELAY_CHAIN[src.blockchain], destinationChainId: RELAY_CHAIN[dst.blockchain],
        originCurrency: oc, destinationCurrency: dc, amount: units, tradeType: "EXACT_INPUT" }) });
    if (!r.ok) return null;
    const j = await r.json();
    const out = j && j.details && j.details.currencyOut;
    if (!out || !out.amountFormatted) return null;
    return { out: Number(out.amountFormatted), seconds: j.details.timeEstimate ?? null };
  } catch { return null; } finally { clearTimeout(timer); }
}
function marketComparison(dst, ours, oursSeconds, relay, feePct = 0.3) {
  const effectiveBpsNote = feePct;
  if (!relay || !relay.out || !ours) return { checked: false, note: "Relay comparison unavailable for this route right now." };
  const diffPct = ((ours - relay.out) / relay.out) * 100;
  const sym = dst.symbol;
  return {
    checked: true,
    compared_with: "Relay (direct, no partner fee), quoted at the same moment",
    you_get_here: +ours.toPrecision(10),
    relay_direct_gives: +relay.out.toPrecision(10),
    difference_pct: +diffPct.toFixed(3),
    verdict: diffPct >= 0 ? "best_price" : "relay_cheaper",
    summary: diffPct >= 0
      ? `Best price: ${+(ours - relay.out).toPrecision(4)} ${sym} (${diffPct.toFixed(2)}%) more than going direct to Relay.`
      : `Relay direct gives ${+(relay.out - ours).toPrecision(4)} ${sym} (${(-diffPct).toFixed(2)}%) more on this route right now (Swap Ripper includes a ${(effectiveBpsNote)}% service fee). Going direct may be cheaper here.`,
    speed_seconds: { here: oursSeconds ?? null, relay: relay.seconds },
  };
}

// ---- Fast mode: route through Relay (~1-5s fills) with the same service fee, paid to RELAY_FEE_TO
const fastEnabled = (c) => !!c.relayKey && /^0x[0-9a-f]{40}$/.test(c.relayFeeTo);
async function relayCall(c, path, init = {}) {
  const r = await fetchRetry(`${RELAY_API}${path}`, { ...init,
    headers: { "Content-Type": "application/json", "x-api-key": c.relayKey, ...(init.headers || {}) } });
  const t = await r.text();
  let j; try { j = JSON.parse(t); } catch { j = { message: t }; }
  if (!r.ok) throw new UserError(`fast network: ${j.message || r.status}`);
  return j;
}
async function fastSwap(c, a, src, dst, units, recipient, refund, exactOutput, bps) {
  if (!fastEnabled(c)) throw new UserError("Fast mode isn't available right now. Leave out speed='fast' to use the best-price route.");
  const oc = relayCurrency(src), dc = relayCurrency(dst);
  if (!oc || !dc) throw new UserError(`Fast mode doesn't support ${src.symbol}@${src.blockchain} -> ${dst.symbol}@${dst.blockchain}. Leave out speed='fast' to use the best-price route.`);
  const body = { user: refund, recipient, originChainId: RELAY_CHAIN[src.blockchain], destinationChainId: RELAY_CHAIN[dst.blockchain],
    originCurrency: oc, destinationCurrency: dc, amount: units, tradeType: exactOutput ? "EXACT_OUTPUT" : "EXACT_INPUT",
    useDepositAddress: true, strict: true, refundTo: refund, appFees: [{ recipient: c.relayFeeTo, fee: String(bps) }] };
  if (a.slippage_bps) body.slippageTolerance = String(clampSlip(a.slippage_bps));
  const j = await relayCall(c, "/quote/v2", { method: "POST", body: JSON.stringify(body) });
  const step = (j.steps || []).find((x) => x.depositAddress) || {};
  const dep = step.depositAddress;
  const d = j.details || {};
  const cin = d.currencyIn || {}, cout = d.currencyOut || {};
  if (!dep || !cin.amountFormatted) throw new UserError("the fast network did not return a deposit address; try again or leave out speed='fast'");
  return { depositAddress: dep, requestId: step.requestId || j.requestId || null,
    amountIn: cin.amount, amountInFormatted: cin.amountFormatted, amountInUsd: cin.amountUsd,
    amountOutFormatted: cout.amountFormatted, amountOutUsd: cout.amountUsd ?? null,
    minAmountOut: cout.minimumAmount ?? null, timeEstimate: d.timeEstimate ?? null };
}
function fastReply(c, a, src, dst, f, recipient, refund) {
  return {
    status: "AWAITING_DEPOSIT",
    route: "fast",
    deposit_address: f.depositAddress,
    deposit_memo: null,
    deposit_chain: src.blockchain,
    send_exactly: f.amountInFormatted,
    send_token: shapeToken(src),
    deadline: null,
    deposit_tx: depositTx(src, f.depositAddress, f.amountIn),
    estimated_amount_out: f.amountOutFormatted,
    estimated_amount_out_usd: f.amountOutUsd,
    minimum_amount_out: f.minAmountOut ? fmtUnits(f.minAmountOut, dst.decimals) : null,
    receive_token: shapeToken(dst),
    recipient, refund_address: refund,
    price_check: fairness(src, dst, f.amountInFormatted, f.amountOutFormatted),
    estimated_seconds: f.timeEstimate,
    fees: feeInfo(c, null, Number(f.amountInUsd) || usdOf(src, f.amountInFormatted)),
    next_steps: [
      `Send exactly ${f.amountInFormatted} ${src.symbol} on ${src.blockchain} to ${f.depositAddress}. Send it soon: fast quotes are short-lived.` +
        (EVM[src.blockchain] ? " deposit_tx is a ready-to-sign transaction for EVM wallets." : ""),
      "Then call get_swap_status with this deposit_address, route='fast' and wait_seconds=25 until final=true.",
      "If anything fails, funds are refunded to refund_address automatically.",
    ],
  };
}
async function fetchFastStatus(c, a) {
  const j = await relayCall(c, `/requests/v3?${new URLSearchParams({ depositAddress: a.deposit_address, limit: "1" })}`);
  const q = (j.requests || [])[0];
  if (!q) return { status: "PENDING_DEPOSIT", route: "fast", final: false, meaning: STATUS_TEXT.PENDING_DEPOSIT };
  const map = { waiting: "PENDING_DEPOSIT", depositing: "KNOWN_DEPOSIT_TX", pending: "PROCESSING", submitted: "PROCESSING",
    success: "SUCCESS", refund: "REFUNDED", failure: "FAILED" };
  const st = map[q.status] || String(q.status || "PROCESSING").toUpperCase();
  const final = ["SUCCESS", "REFUNDED", "FAILED"].includes(st);
  if (st === "SUCCESS" && c.kv) {
    try { const k = `done:${a.deposit_address}`; if (!(await c.kv.get(k))) { await c.kv.put(k, "1"); track(c, "swaps_completed"); } } catch { /* ignore */ }
  }
  const dd = q.data || {};
  return { status: st, route: "fast", final, meaning: STATUS_TEXT[st] || "",
    origin_tx: (dd.inTxs || []).map((x) => x.txHash), destination_tx: (dd.outTxs || []).map((x) => x.txHash),
    fail_reason: dd.failReason || null, updated_at: q.updatedAt ?? null };
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
  const relayP = a._noMarket ? Promise.resolve(null)
    : relayDirectOut(src, dst, units, exact ? recipient : null, exact ? refund : null);
  const q = await oneclick(c, "/v0/quote",
    quoteBody(c, src, dst, units, recipient, refund, true, slip, !exact, { referrer: a.referrer, bps: effectiveBps(c, usd) }));
  const qq = q.quote || {};
  const relay = await relayP;
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
    best_price_check: a._noMarket ? undefined : marketComparison(dst, Number(qq.amountOutFormatted), qq.timeEstimate, relay, effectiveBps(c, usd) / 100),
    fast_option: (!a._noMarket && fastEnabled(c) && relay && relay.out) ? {
      estimated_amount_out: +(relay.out * (1 - effectiveBps(c, usd) / 10000)).toPrecision(10),
      estimated_seconds: relay.seconds,
      how: "Pass speed='fast' to create_swap or pay_exact for a ~seconds fill (usually slightly less output than the best-price route).",
    } : undefined,
    note: "Estimate only. Call create_swap (or pay_exact) to get a deposit address.",
  };
}

function feeInfo(c, referrer, usd) {
  const bps = effectiveBps(c, usd);
  const split = feeSplit(c, referrer, bps);
  const ref = split.length > 1 ? split[1] : null;
  return {
    service_fee_bps: bps,
    volume_discounts: discountText(c),
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

// Smart routing: quote NEAR Intents and Relay at once, use whichever is cheaper for the agent;
// if one network fails, the other takes over. speed='fast' forces Relay.
async function routeSwap(c, a, src, dst, units, recipient, refund, usd, exactOutput) {
  const pol = await enforcePolicy(c, a, src, dst, recipient, Number(usd) || 0);
  const slip = clampSlip(a.slippage_bps);
  const bps = effectiveBps(c, usd);
  const speed = String(a.speed || "").toLowerCase();
  const nearP = () => oneclick(c, "/v0/quote",
    quoteBody(c, src, dst, units, recipient, refund, false, slip, false, { referrer: a.referrer, exactOutput, bps }))
    .then((q) => { const qq = q.quote || {}; if (!qq.depositAddress) throw new UserError("the swap network did not return a deposit address; try again");
      qq.amountInFormatted ??= exactOutput ? null : fmtUnits(units, src.decimals); qq.amountIn ??= exactOutput ? null : units;
      if (exactOutput && !qq.amountInFormatted) throw new UserError("the swap network did not return payment instructions; try again"); return qq; });
  const fastP = () => fastSwap(c, a, src, dst, units, recipient, refund, exactOutput, bps);
  const finish = async (kind, q, choice) => {
    let out;
    if (kind === "fast") {
      await recordSwap(c, null, Number(q.amountInUsd) || usd); track(c, "fast_swaps");
      out = fastReply(c, a, src, dst, q, recipient, refund);
    } else {
      await recordSwap(c, a.referrer, Number(q.amountInUsd) || usd);
      out = depositReply(c, a, src, dst, q, recipient, refund); out.route = "best_price";
    }
    if (choice) out.route_choice = choice;
    await recordPolicySpend(c, pol, Number(usd) || 0, out);
    await rememberDeposit(c, out, { exactOutput, exactText: exactOutput ? `${fmtUnits(units, dst.decimals)} ${dst.symbol} on ${dst.blockchain}` : null, invoice: a.invoice || null });
    if (a.invoice) out.invoice_id = a.invoice;
    out.receipt_hint = "After it completes, get_receipt with this deposit_address returns a signed, verifiable receipt.";
    return out;
  };
  if (speed === "fast") return finish("fast", await fastP());
  const canFast = fastEnabled(c) && relayCurrency(src) && relayCurrency(dst);
  if (!canFast) return finish("near", await nearP());
  // With a referrer, prefer NEAR (referral share is paid there); Relay is only a fallback.
  if (a.referrer) {
    try { return await finish("near", await nearP()); }
    catch (e) { const f = await fastP().catch(() => null); if (f) return finish("fast", f, { chosen: "fast", reason: "primary network couldn't quote this; used the backup network" }); throw e; }
  }
  const [n, f] = await Promise.allSettled([nearP(), fastP()]);
  if (n.status === "rejected" && f.status === "rejected") throw n.reason;
  if (n.status === "rejected") return finish("fast", f.value, { chosen: "fast", reason: "primary network couldn't quote this; used the backup network" });
  if (f.status === "rejected") return finish("near", n.value);
  const nv = n.value, fv = f.value;
  let fastWins, cmp;
  if (exactOutput) {
    const a1 = Number(nv.amountInFormatted), a2 = Number(fv.amountInFormatted);
    fastWins = a2 < a1; cmp = { you_pay_best_price_route: a1, you_pay_fast_route: a2, token: src.symbol };
  } else {
    const o1 = Number(nv.amountOutFormatted), o2 = Number(fv.amountOutFormatted);
    fastWins = o2 > o1; cmp = { you_get_best_price_route: o1, you_get_fast_route: o2, token: dst.symbol };
  }
  const choice = { chosen: fastWins ? "fast" : "best_price", compared: cmp,
    reason: fastWins ? "the fast route was cheaper for this swap, so you get speed and price" : "the best-price route gives you more" };
  return fastWins ? finish("fast", fv, choice) : finish("near", nv, choice);
}

async function createSwap(c, a) {
  const src = await resolveToken(c, a.from_token, a.from_chain);
  const dst = await resolveToken(c, a.to_token, a.to_chain);
  const units = toUnits(a.amount, src.decimals);
  const usd = usdCheck(src, a.amount);
  const recipient = checkAddress(a.recipient, dst.blockchain, "recipient");
  const refund = checkAddress(a.refund_address, src.blockchain, "refund_address");
  return routeSwap(c, a, src, dst, units, recipient, refund, usd, false);
}

// Pay EXACTLY amount_out of a token to someone, funded by any token the agent holds.
async function payExact(c, a) {
  const src = await resolveToken(c, a.pay_with_token, a.pay_with_chain);
  const dst = await resolveToken(c, a.token, a.chain);
  const units = toUnits(a.amount_out, dst.decimals);
  const usd = Number(a.amount_out) * Number(dst.price || 0);
  if (usd && usd > MAX_USD) throw new UserError(`max per payment is $${MAX_USD}`);
  const recipient = checkAddress(a.recipient, dst.blockchain, "recipient");
  const refund = checkAddress(a.refund_address, src.blockchain, "refund_address");
  const out = await routeSwap(c, a, src, dst, units, recipient, refund, usd, true);
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
    slippage_bps: a.slippage_bps, referrer: a.referrer, speed: a.speed, policy_id: a.policy_id });
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
    slippage_bps: a.slippage_bps, referrer: a.referrer, speed: a.speed, policy_id: a.policy_id });
  track(c, "x402_funds");
  out.invoice = invoice;
  out.why = why;
  out.next_steps.push(`When get_swap_status says SUCCESS, your wallet ${a.wallet} holds ${target_str} ${tok.symbol} on ${pick.chain}: retry the original request and let your x402 client pay.`);
  return out;
}

// ---- Universal pay: hand it ANY payment request, pay it with ANY token
const EVM_BY_ID = Object.fromEntries(Object.entries(EVM).map(([k, v]) => [String(v), k]));
function sciToUnits(v) {
  // "2.014e18" or "1500000" -> BigInt string (base units)
  const s = String(v).trim();
  const m = s.match(/^(\d+)(?:\.(\d+))?(?:[eE]\+?(\d+))?$/);
  if (!m) throw new UserError(`can't read amount '${v}'`);
  const [, w, f = "", e = "0"] = m;
  const exp = Number(e);
  if (f.length > exp) throw new UserError(`amount '${v}' is not a whole number of base units`);
  return BigInt(w + f.padEnd(exp, "0")).toString();
}
function guessChainFromAddress(addr) {
  const a = String(addr || "");
  if (/^0x[0-9a-fA-F]{40}$/.test(a)) return null; // EVM: chain must be stated
  if (/^(bc1|[13])[a-zA-HJ-NP-Z0-9]{25,62}$/.test(a)) return "btc";
  if (/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(a)) return "tron";
  if (/\.near$/.test(a) || /^[0-9a-f]{64}$/.test(a)) return "near";
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a)) return "sol";
  return null;
}
async function tokenByContract(c, chain, contract) {
  const all = await getTokens(c);
  const evm = /^0x/i.test(contract);
  return all.find((t) => t.blockchain === chain && t.contractAddress &&
    (evm ? String(t.contractAddress).toLowerCase() === String(contract).toLowerCase() : t.contractAddress === contract)) || null;
}
// Returns { kind, to, token, chain, amount (human), label } or { kind: 'x402', payment_required }
async function parsePaymentRequest(c, req) {
  let r = req;
  if (r && typeof r === "object") {
    if (r.accepts || r.x402Version || r.payTo) return { kind: "x402", payment_required: r };
    if (r.to || r.recipient) return { kind: "json", to: r.to || r.recipient, token: r.token, chain: r.chain, amount: r.amount != null ? String(r.amount) : null, label: r.label || r.memo || null };
    throw new UserError("Couldn't understand the payment object. Pass {to, token, chain, amount}, a 402 body, a payment link or plain text.");
  }
  r = String(r || "").trim();
  if (!r) throw new UserError("request is required: a payment link, URI, 402 invoice, or text like 'send 20 USDC to 0x... on base'");
  // JSON / base64 x402
  if (r.startsWith("{")) { try { return parsePaymentRequest(c, JSON.parse(r)); } catch (e) { if (e instanceof UserError) throw e; } }
  if (/^[A-Za-z0-9+/=_-]{40,}$/.test(r) && !/^0x/.test(r)) {
    try { const j = JSON.parse(atob(r.replace(/-/g, "+").replace(/_/g, "/"))); if (j && (j.accepts || j.x402Version)) return { kind: "x402", payment_required: j }; } catch { /* not base64 json */ }
  }
  // Swap Ripper (or compatible) payment link
  if (/^https?:\/\//i.test(r)) {
    let u; try { u = new URL(r); } catch { throw new UserError("That link isn't a valid URL."); }
    const q = u.searchParams;
    if (u.pathname.replace(/\/$/, "").endsWith("/pay") && q.get("to")) {
      return { kind: "payment_link", to: q.get("to"), token: q.get("token"), chain: q.get("chain"), amount: q.get("amount"), label: q.get("label"), invoice: q.get("inv") };
    }
    throw new UserError("This link isn't a payment request I recognize. Supported: Swap Ripper /pay links, solana:, ethereum:, bitcoin: URIs, x402 invoices, or plain text.");
  }
  // Solana Pay: solana:<recipient>?amount=&spl-token=&label=
  let m = r.match(/^solana:([1-9A-HJ-NP-Za-km-z]{32,44})(\?.*)?$/i);
  if (m) {
    const q = new URLSearchParams((m[2] || "").slice(1));
    const mint = q.get("spl-token");
    let token = "SOL";
    if (mint) { const t = await tokenByContract(c, "sol", mint); if (!t) throw new UserError(`Solana token ${mint} isn't supported.`); token = t.assetId; }
    return { kind: "solana_pay", to: m[1], token, chain: "sol", amount: q.get("amount"), label: q.get("label") || q.get("message") };
  }
  // EIP-681: ethereum:<addr>[@chainId][/transfer]?value=|address=&uint256=
  m = r.match(/^ethereum:(?:pay-)?(0x[0-9a-fA-F]{40})(?:@(\d+))?(?:\/([a-zA-Z]+))?(\?.*)?$/i);
  if (m) {
    const [, target, cid = "1", fn, qs] = m;
    const chain = EVM_BY_ID[cid];
    if (!chain) throw new UserError(`EVM chain id ${cid} isn't supported. Supported: ${Object.entries(EVM).map(([k, v]) => `${k}=${v}`).join(", ")}`);
    const q = new URLSearchParams((qs || "").slice(1));
    if (fn && fn.toLowerCase() === "transfer") {
      const tok = await tokenByContract(c, chain, target);
      if (!tok) throw new UserError(`Token ${target} on ${chain} isn't supported.`);
      const to = q.get("address");
      if (!to) throw new UserError("ERC-20 payment link is missing the recipient (address=...).");
      const units = q.get("uint256");
      return { kind: "eip681", to, token: tok.assetId, chain, amount: units ? fmtUnits(sciToUnits(units), tok.decimals) : null };
    }
    const all = await getTokens(c);
    const nat = all.find((t) => t.blockchain === chain && String(t.symbol).toUpperCase() === NATIVE[chain] && !t.contractAddress);
    if (!nat) throw new UserError(`Native ${NATIVE[chain]} on ${chain} isn't available.`);
    const v = q.get("value");
    return { kind: "eip681", to: target, token: nat.assetId, chain, amount: v ? fmtUnits(sciToUnits(v), nat.decimals) : null };
  }
  // BIP21: bitcoin:<addr>?amount=0.001
  m = r.match(/^bitcoin:([a-zA-Z0-9]{25,90})(\?.*)?$/i);
  if (m) {
    const q = new URLSearchParams((m[2] || "").slice(1));
    return { kind: "bip21", to: m[1], token: "BTC", chain: "btc", amount: q.get("amount"), label: q.get("label") || q.get("message") };
  }
  // Plain English: "send 20 USDC to 0xabc on base", "pay 0.01 BTC to bc1...", "20 USDC on base to 0x..."
  m = r.match(/^(?:please\s+)?(?:send|pay|transfer|give)?\s*([\d.,]+)\s*\$?([A-Za-z0-9.]+)(?:\s+(?:on|@)\s+([A-Za-z][A-Za-z0-9 -]*?))?\s+to\s+(\S+)(?:\s+(?:on|@)\s+([A-Za-z][A-Za-z0-9 -]*?))?\s*[.!]?$/i);
  if (m) {
    const [, amt, sym, ch1, to, ch2] = m;
    return { kind: "text", to, token: sym, chain: ch1 || ch2 || null, amount: amt.replace(/,/g, "") };
  }
  throw new UserError("Couldn't understand that payment request. Try: 'send 20 USDC to 0x... on base', a solana:/ethereum:/bitcoin: link, a Swap Ripper /pay link, or a 402 invoice.");
}
async function payAnything(c, a) {
  const p = await parsePaymentRequest(c, a.request);
  if (p.kind === "x402") {
    const out = await fundX402(c, { ...a, payment_required: p.payment_required });
    return { understood: { kind: "x402 invoice" }, ...out };
  }
  const chain = normChain(p.chain) || guessChainFromAddress(p.to);
  if (!chain) throw new UserError(`Which chain is ${p.to} on? Add 'on base' (or ethereum, arbitrum, polygon, bsc...) to the request.`);
  if (!p.token) throw new UserError("The request doesn't say which token to pay. Add the token, e.g. 'send 20 USDC to ...'.");
  const dst = await resolveToken(c, p.token, chain);
  const to = checkAddress(p.to, dst.blockchain, "recipient");
  const understood = { kind: p.kind, pay_to: to, token: dst.symbol, chain: dst.blockchain, amount: p.amount || null, label: p.label || null };
  if (!p.amount && !a.amount) return { understood, needs: "amount", message: "This request has no amount. Call pay again with amount='...'." };
  const amount = String(a.amount || p.amount);
  toUnits(amount, dst.decimals);
  understood.amount = amount;
  if (!a.pay_with_token) {
    return { understood, message: "Got it. To pay, call pay again with pay_with_token (what you hold), pay_with_chain and refund_address (your address on that chain).",
      tip: `If you already hold ${dst.symbol} on ${dst.blockchain}, just send ${amount} ${dst.symbol} to ${to} directly: no swap, no fee.` };
  }
  const src = await resolveToken(c, a.pay_with_token, a.pay_with_chain);
  if (src.assetId === dst.assetId) {
    if (a.policy_id) await enforcePolicy(c, a, src, dst, to, Number(amount) * Number(dst.price || 0));
    return { understood, no_swap_needed: true, message: `You already hold ${dst.symbol} on ${dst.blockchain}. Send ${amount} ${dst.symbol} to ${to} directly: no swap, no fee.` };
  }
  const out = await payExact(c, { token: dst.assetId, amount_out: amount, pay_with_token: src.assetId, recipient: to,
    refund_address: a.refund_address, slippage_bps: a.slippage_bps, referrer: a.referrer, speed: a.speed, policy_id: a.policy_id,
    invoice: p.invoice && INV_ID.test(p.invoice) ? p.invoice : undefined });
  track(c, "pay_requests");
  return { understood, ...out };
}

// ---- Owner spending limits: policy-locked connections the agent can't exceed
const POL_ID = /^pol_[a-z0-9]{14}$/;
const randId = (prefix, n) => prefix + Array.from(crypto.getRandomValues(new Uint8Array(n)), (x) => "abcdefghijkmnpqrstuvwxyz23456789"[x % 32]).join("");
async function sha256hex(t) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t));
  return Array.from(new Uint8Array(d), (x) => x.toString(16).padStart(2, "0")).join("");
}
const today = () => new Date().toISOString().slice(0, 10);
const listArg = (v) => (Array.isArray(v) ? v : typeof v === "string" && v.trim() ? v.split(",") : []).map((x) => String(x).trim()).filter(Boolean);
async function loadPolicy(c, id) {
  if (!POL_ID.test(String(id || ""))) throw new UserError("policy_id looks wrong (it starts with 'pol_').");
  if (!c.kv) throw new UserError("spending limits are unavailable right now");
  const raw = await c.kv.get(`pol:${id}`);
  if (!raw) throw new UserError("policy not found");
  return JSON.parse(raw);
}
async function createSpendingPolicy(c, a) {
  if (!c.kv) throw new UserError("spending limits are unavailable right now");
  const perPay = Number(a.max_per_payment_usd), perDay = Number(a.max_per_day_usd);
  if (!(perPay > 0) || !(perDay > 0)) throw new UserError("max_per_payment_usd and max_per_day_usd are required (positive numbers, in USD).");
  if (perPay > MAX_USD || perDay > MAX_USD * 10) throw new UserError("limits are too high");
  const chains = listArg(a.allowed_chains).map(normChain);
  const tokens = listArg(a.allowed_tokens).map((x) => x.toUpperCase());
  const recipients = listArg(a.allowed_recipients);
  const days = Math.min(Math.max(Number(a.expires_in_days) || 365, 1), 365);
  const id = randId("pol_", 14), adminKey = randId("adm_", 24);
  const pol = { id, label: a.label ? String(a.label).slice(0, 60) : null, max_per_payment_usd: perPay, max_per_day_usd: perDay,
    allowed_chains: chains, allowed_tokens: tokens, allowed_recipients: recipients, enabled: true,
    created_at: new Date().toISOString(), expires_at: new Date(Date.now() + days * 864e5).toISOString(), admin_hash: await sha256hex(adminKey) };
  await c.kv.put(`pol:${id}`, JSON.stringify(pol), { expirationTtl: (days + 30) * 86400 });
  track(c, "policies_created");
  return {
    policy_id: id,
    agent_mcp_url: `${c.origin}/mcp/p/${id}`,
    agent_rest_base: `${c.origin}/api/p/${id}/`,
    admin_key: adminKey,
    limits: publicPolicy(pol),
    how_to_use: [
      "Give your agent ONLY agent_mcp_url (instead of the normal /mcp URL). Every swap and payment through it is checked against these limits first.",
      "Keep admin_key private: it's the only way to see the spending log and to switch spending off (set_policy_enabled). It is shown once and cannot be recovered.",
      "Swap Ripper never holds funds: limits work by refusing to create payment instructions that break the rules.",
    ],
  };
}
function publicPolicy(p) {
  return { label: p.label, max_per_payment_usd: p.max_per_payment_usd, max_per_day_usd: p.max_per_day_usd,
    allowed_chains: p.allowed_chains.length ? p.allowed_chains : "any", allowed_tokens: p.allowed_tokens.length ? p.allowed_tokens : "any",
    allowed_recipients: p.allowed_recipients.length ? p.allowed_recipients : "any", enabled: p.enabled, expires_at: p.expires_at };
}
async function enforcePolicy(c, a, src, dst, recipient, usd) {
  if (!a.policy_id) return null;
  const p = await loadPolicy(c, a.policy_id);
  const no = (why) => { throw new UserError(`Blocked by your owner's spending policy: ${why}`); };
  if (!p.enabled) no("spending is switched off for this agent.");
  if (Date.parse(p.expires_at) < Date.now()) no("the policy has expired.");
  if (!(usd > 0)) no("the USD value of this payment can't be determined, so it can't be checked against your limits.");
  if (usd > p.max_per_payment_usd) no(`this is ~$${usd.toFixed(2)}, over the $${p.max_per_payment_usd} per-payment limit.`);
  if (p.allowed_chains.length && (!p.allowed_chains.includes(src.blockchain) || !p.allowed_chains.includes(dst.blockchain)))
    no(`only these chains are allowed: ${p.allowed_chains.join(", ")}.`);
  if (p.allowed_tokens.length && !p.allowed_tokens.includes(String(dst.symbol).toUpperCase()))
    no(`only these tokens can be sent: ${p.allowed_tokens.join(", ")}.`);
  if (p.allowed_recipients.length) {
    const r = String(recipient), ok = p.allowed_recipients.some((x) => (/^0x/i.test(x) ? x.toLowerCase() === r.toLowerCase() : x === r));
    if (!ok) no("this recipient isn't on the approved list.");
  }
  const spent = Number((await c.kv.get(`pspend:${p.id}:${today()}`)) || 0);
  if (spent + usd > p.max_per_day_usd) no(`today's total would be ~$${(spent + usd).toFixed(2)}, over the $${p.max_per_day_usd} daily limit ($${Math.max(p.max_per_day_usd - spent, 0).toFixed(2)} left today).`);
  return { p, spent };
}
async function recordPolicySpend(c, pol, usd, out) {
  if (!pol) return;
  try {
    const key = `pspend:${pol.p.id}:${today()}`;
    const spent = Number((await c.kv.get(key)) || 0) + usd;
    await c.kv.put(key, String(+spent.toFixed(2)), { expirationTtl: 3 * 86400 });
    const lk = `plog:${pol.p.id}`;
    const log = JSON.parse((await c.kv.get(lk)) || "[]");
    log.unshift({ at: new Date().toISOString(), usd: +usd.toFixed(2), send: `${out.send_exactly} ${out.send_token && out.send_token.symbol}@${out.deposit_chain}`,
      receive: out.recipient_receives_exactly || `${out.estimated_amount_out} ${out.receive_token && out.receive_token.symbol}@${out.receive_token && out.receive_token.chain}`,
      recipient: out.recipient, deposit_address: out.deposit_address, route: out.route });
    await c.kv.put(lk, JSON.stringify(log.slice(0, 50)), { expirationTtl: 400 * 86400 });
    out.policy = { policy_id: pol.p.id, spent_today_usd: +spent.toFixed(2), left_today_usd: +Math.max(pol.p.max_per_day_usd - spent, 0).toFixed(2),
      note: "Counted when payment instructions are issued." };
  } catch { /* never break payments over bookkeeping */ }
}
async function policyStatus(c, a) {
  const p = await loadPolicy(c, a.policy_id);
  const spent = Number((await c.kv.get(`pspend:${p.id}:${today()}`)) || 0);
  const out = { policy_id: p.id, limits: publicPolicy(p), spent_today_usd: spent, left_today_usd: +Math.max(p.max_per_day_usd - spent, 0).toFixed(2) };
  if (a.admin_key) {
    if ((await sha256hex(String(a.admin_key))) !== p.admin_hash) throw new UserError("admin_key is wrong");
    out.log = JSON.parse((await c.kv.get(`plog:${p.id}`)) || "[]");
  }
  return out;
}
async function setPolicyEnabled(c, a) {
  const p = await loadPolicy(c, a.policy_id);
  if (!a.admin_key || (await sha256hex(String(a.admin_key))) !== p.admin_hash) throw new UserError("admin_key is wrong");
  p.enabled = a.enabled === true || a.enabled === "true";
  await c.kv.put(`pol:${p.id}`, JSON.stringify(p), { expirationTtl: Math.max(Math.ceil((Date.parse(p.expires_at) - Date.now()) / 1000) + 30 * 86400, 86400) });
  return { policy_id: p.id, enabled: p.enabled, message: p.enabled ? "Spending is ON for this agent (within its limits)." : "Spending is OFF. Every payment through this policy is refused until you switch it back on." };
}

// ---- Invoices, payment checks and signed receipts
const INV_TTL = 60 * 60 * 24 * 180, DEP_TTL = 60 * 60 * 24 * 120;
const INV_ID = /^inv_[a-z0-9]{12}$/;
function newInvoiceId() {
  const b = crypto.getRandomValues(new Uint8Array(12));
  return "inv_" + Array.from(b, (x) => "abcdefghijkmnpqrstuvwxyz23456789"[x % 32]).join("");
}
async function rememberDeposit(c, out, extra) {
  if (!c.kv || !out.deposit_address) return;
  const rec = { deposit_address: out.deposit_address, deposit_memo: out.deposit_memo || null, route: out.route || "best_price",
    created_at: new Date().toISOString(), send: { amount: out.send_exactly, token: out.send_token }, receive: { estimated: out.estimated_amount_out,
    exact: extra.exactOutput ? (extra.exactText || out.recipient_receives_exactly || null) : null, token: out.receive_token }, recipient: out.recipient,
    refund_address: out.refund_address, fee_bps: out.fees && out.fees.service_fee_bps, invoice: extra.invoice };
  try {
    await c.kv.put(`dep:${out.deposit_address}`, JSON.stringify(rec), { expirationTtl: DEP_TTL });
    if (extra.invoice && INV_ID.test(extra.invoice)) {
      const raw = await c.kv.get(`inv:${extra.invoice}`);
      if (raw) { const v = JSON.parse(raw);
        if (depositMatchesInvoice(rec, v)) {
          v.deposits = [out.deposit_address, ...(v.deposits || [])].slice(0, 20);
          await c.kv.put(`inv:${extra.invoice}`, JSON.stringify(v), { expirationTtl: INV_TTL });
        } }
    }
  } catch { /* bookkeeping must never break payments */ }
}
// A payment only counts toward an invoice if it pays the invoice's recipient, in its token and chain,
// and (if the invoice has an amount) exactly that amount.
function depositMatchesInvoice(rec, v) {
  if (!rec || !v || !rec.receive || !rec.receive.token) return false;
  const sameAddr = (x, y) => (/^0x/i.test(String(x)) ? String(x).toLowerCase() === String(y).toLowerCase() : String(x) === String(y));
  if (!sameAddr(rec.recipient, v.to)) return false;
  if (String(rec.receive.token.symbol).toUpperCase() !== String(v.token).toUpperCase() || rec.receive.token.chain !== v.chain) return false;
  if (v.amount) {
    if (!rec.receive.exact) return false;
    const got = Number(String(rec.receive.exact).split(" ")[0]);
    if (!(got >= Number(v.amount))) return false;
  }
  return true;
}
async function hmacHex(secret, msg) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode("receipt:" + secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg));
  return Array.from(new Uint8Array(sig), (x) => x.toString(16).padStart(2, "0")).join("");
}
const canon = (o) => JSON.stringify(o, Object.keys(o).sort());
async function checkPayment(c, a) {
  const id = String(a.invoice_id || "").trim();
  if (!INV_ID.test(id)) throw new UserError("invoice_id looks wrong. It starts with 'inv_' and comes from create_payment_link.");
  if (!c.kv) throw new UserError("invoice tracking is unavailable right now");
  const raw = await c.kv.get(`inv:${id}`);
  if (!raw) throw new UserError("invoice not found (it may have expired after 180 days)");
  const v = JSON.parse(raw);
  const payments = [];
  for (const dep of (v.deposits || []).slice(0, 10)) {
    let rec = null; try { rec = JSON.parse((await c.kv.get(`dep:${dep}`)) || "null"); } catch { rec = null; }
    if (!depositMatchesInvoice(rec, v)) continue;
    try { const st = await fetchStatus(c, { deposit_address: dep, deposit_memo: rec.deposit_memo || undefined, route: rec.route === "fast" ? "fast" : undefined }); payments.push({ deposit_address: dep, status: st.status, final: st.final, amount_out: st.amount_out ?? null, destination_tx: st.destination_tx || [] }); }
    catch { payments.push({ deposit_address: dep, status: "UNKNOWN" }); }
  }
  const paid = payments.find((p) => p.status === "SUCCESS");
  const processing = payments.find((p) => ["PROCESSING", "KNOWN_DEPOSIT_TX"].includes(p.status));
  const status = paid ? "paid" : processing ? "processing" : "unpaid";
  return {
    invoice_id: id, status, paid: !!paid,
    invoice: { to: v.to, token: v.token, chain: v.chain, amount: v.amount || null, label: v.label || null, created_at: v.created_at, payment_link: v.link },
    payments,
    receipt_hint: paid ? `get_receipt with deposit_address=${paid.deposit_address} returns a signed receipt.` : undefined,
    note: "Tracks payments made through this invoice's Swap Ripper link or the pay tool. A payer who sends the token directly (no swap) won't show here; check the recipient wallet for those.",
  };
}
async function getReceipt(c, a) {
  const dep = String(a.deposit_address || "").trim();
  if (!dep) throw new UserError("deposit_address is required");
  let rec = null;
  if (c.kv) { try { rec = JSON.parse((await c.kv.get(`dep:${dep}`)) || "null"); } catch { rec = null; } }
  const st = await fetchStatus(c, { deposit_address: dep, deposit_memo: a.deposit_memo || (rec && rec.deposit_memo) || undefined, route: rec && rec.route === "fast" ? "fast" : undefined });
  if (st.status !== "SUCCESS") return { deposit_address: dep, status: st.status, final: st.final, message: st.final ? "This payment didn't complete, so there is no receipt. See status for details." : "Not complete yet. Receipts are issued once status is SUCCESS. Try get_swap_status with wait_seconds=25." };
  const receipt = {
    issuer: "Swap Ripper", version: 1, deposit_address: dep, route: (rec && rec.route) || st.route || "best_price", status: "SUCCESS",
    paid_amount: st.amount_in ?? (rec && rec.send && rec.send.amount) ?? null, paid_token: rec && rec.send && rec.send.token ? `${rec.send.token.symbol}@${rec.send.token.chain}` : null,
    received_amount: st.amount_out ?? (rec && (rec.receive.exact || rec.receive.estimated)) ?? null,
    received_token: rec && rec.receive && rec.receive.token ? `${rec.receive.token.symbol}@${rec.receive.token.chain}` : null,
    recipient: (rec && rec.recipient) || null, invoice_id: (rec && rec.invoice) || null,
    origin_tx: (st.origin_tx || []).join(" "), destination_tx: (st.destination_tx || []).join(" "),
    service_fee_bps: (rec && rec.fee_bps) ?? null, created_at: (rec && rec.created_at) || null, issued_at: new Date().toISOString(),
  };
  const signature = await hmacHex(c.receiptSecret, canon(receipt));
  return { receipt, signature, verify: `POST ${c.origin}/api/verify with {"receipt": <receipt>, "signature": "<signature>"} to confirm it is genuine and unchanged.` };
}
async function verifyReceipt(c, a) {
  let r = a.receipt;
  if (typeof r === "string") { try { r = JSON.parse(r); } catch { throw new UserError("receipt must be the receipt object (or its JSON)"); } }
  if (!r || typeof r !== "object" || !a.signature) throw new UserError("pass receipt and signature exactly as get_receipt returned them");
  const good = await hmacHex(c.receiptSecret, canon(r));
  return { valid: good === String(a.signature).trim().toLowerCase(), message: good === String(a.signature).trim().toLowerCase() ? "Genuine Swap Ripper receipt, unchanged." : "NOT valid: the receipt was changed or the signature is wrong." };
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
  let invoice_id = null;
  if (c.kv) {
    invoice_id = newInvoiceId(); p.set("inv", invoice_id);
    try { await c.kv.put(`inv:${invoice_id}`, JSON.stringify({ to, token: dst.symbol, chain: dst.blockchain, amount: a.amount || null,
      label: a.label ? String(a.label).slice(0, 80) : null, created_at: new Date().toISOString(), link: `${c.origin}/pay?${p}`, deposits: [] }), { expirationTtl: INV_TTL }); }
    catch { invoice_id = null; p.delete("inv"); }
  }
  const url = `${c.origin}/pay?${p}`;
  track(c, "links_created");
  return {
    payment_link: url,
    invoice_id,
    check_payment: invoice_id ? `Call check_payment with invoice_id='${invoice_id}' any time to see if it's paid.` : undefined,
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
  const results = await Promise.allSettled(routes.map((r) => getQuote(c, { ...r, referrer: r.referrer ?? a.referrer, _noMarket: true })));
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
  if (String(a.route || "").toLowerCase() === "fast") return fetchFastStatus(c, a);
  if (!a.route && fastEnabled(c)) {
    try { return await fetchNearStatus(c, a); }
    catch (e) { try { const f = await fetchFastStatus(c, a); if (f.status !== "PENDING_DEPOSIT") return f; } catch { /* ignore */ } throw e; }
  }
  return fetchNearStatus(c, a);
}
async function fetchNearStatus(c, a) {
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
const SPEED = { type: "string", enum: ["best_price", "fast"], description: "Optional. Default 'best_price': Swap Ripper quotes two networks at once and uses whichever is cheaper for you (and the other if one fails); the reply's route_choice shows both. 'fast' forces the ~seconds Relay route." };
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
    name: "pay",
    title: "Pay anything: hand it any bill",
    description: "One tool for any payment request. Pass whatever you were asked to pay: an x402 / HTTP 402 invoice, a Swap Ripper payment link, a Solana Pay link (solana:...), an Ethereum payment link (ethereum:..., EIP-681, any supported EVM chain), a Bitcoin link (bitcoin:...), plain text like 'send 20 USDC to 0xabc... on base', or {to, token, chain, amount}. Swap Ripper works out who gets what, then pays it EXACTLY using whatever token you hold on any chain. Call with only `request` to see what it understood; add pay_with_token, pay_with_chain and refund_address to get a deposit address.",
    inputSchema: { type: "object", required: ["request"], properties: {
      request: { description: "The payment request: link, URI, 402 body, plain text, or {to, token, chain, amount}.", anyOf: [{ type: "string" }, { type: "object" }] },
      amount: { type: "string", description: "Only if the request has no amount: how much the recipient should get." },
      pay_with_token: { type: "string", description: "Token you hold and will pay with, e.g. 'SOL', 'USDC', 'ETH'." },
      pay_with_chain: { type: "string", description: "Chain you pay from, e.g. 'solana'." },
      refund_address: { type: "string", description: "Your address on the paying chain, for automatic refunds." },
      wallet: { type: "string", description: "x402 only: YOUR address on the invoice's network (your x402 client signs from it)." },
      speed: SPEED,
      slippage_bps: TOKEN_PROPS.slippage_bps,
      referrer: REFERRER,
    } },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    run: payAnything,
  },
  {
    name: "get_quote",
    title: "Get a cross-chain swap quote",
    description: "Live price for swapping any token to any token across 25+ chains (BTC, ETH, SOL, Base, Arbitrum, BNB, Tron, NEAR, Zcash, TON, Sui, XRP...). No addresses or keys needed, nothing committed. Includes a price_check against market rates and a best_price_check that quotes a competing network (Relay) at the same moment, so you can see proof you are getting the better deal.",
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
    inputSchema: { type: "object", required: ["from_token", "to_token", "amount", "recipient", "refund_address"], properties: { ...TOKEN_PROPS, ...ADDR_PROPS, speed: SPEED } },
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
      speed: SPEED,
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
      speed: SPEED,
      referrer: REFERRER,
    } },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    run: fundX402,
  },
  {
    name: "create_payment_link",
    title: "Create a 'pay me in any crypto' link",
    description: "Create a shareable payment link that is also a trackable invoice. The payer can pay with ANY token on ANY chain; you receive exactly the token you choose (e.g. 50 USDC on Base). Returns an invoice_id: call check_payment to see when it is paid, then get_receipt for signed proof. Great for agents that sell services to humans or other agents. No account needed.",
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
    name: "check_payment",
    title: "Did I get paid? Check an invoice",
    description: "Check whether an invoice (from create_payment_link) has been paid. Returns unpaid / processing / paid, every payment attempt with its status and blockchain transaction, and how to get a signed receipt. Use it to deliver your service only after you've been paid.",
    inputSchema: { type: "object", required: ["invoice_id"], properties: {
      invoice_id: { type: "string", description: "The invoice_id returned by create_payment_link (starts with 'inv_')." },
    } },
    annotations: { readOnlyHint: true, openWorldHint: true },
    run: checkPayment,
  },
  {
    name: "get_receipt",
    title: "Signed receipt for a completed payment",
    description: "Get a clean, digitally signed receipt for a completed swap or payment: what was paid, what was received, by whom, on which chains, with transaction hashes and the fee. Share it with your owner, a seller or another agent; anyone can confirm it's genuine with verify_receipt.",
    inputSchema: { type: "object", required: ["deposit_address"], properties: {
      deposit_address: { type: "string", description: "The deposit_address of the swap or payment." },
      deposit_memo: { type: "string", description: "deposit_memo, if one was returned." },
    } },
    annotations: { readOnlyHint: true, openWorldHint: true },
    run: getReceipt,
  },
  {
    name: "verify_receipt",
    title: "Check a receipt is genuine",
    description: "Confirm that a Swap Ripper receipt is genuine and unchanged. Pass the receipt object and signature exactly as get_receipt returned them.",
    inputSchema: { type: "object", required: ["receipt", "signature"], properties: {
      receipt: { description: "The receipt object (or its JSON text).", anyOf: [{ type: "object" }, { type: "string" }] },
      signature: { type: "string", description: "The signature string." },
    } },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: verifyReceipt,
  },
  {
    name: "create_spending_policy",
    title: "Owner: set spending limits for an agent",
    description: "For agent OWNERS. Create spending limits (max per payment, max per day, optional allowed chains, tokens and recipients) and get a policy-locked connection URL to give your agent. Every swap and payment through that URL is checked first and refused if it breaks a rule. Also returns a private admin_key for the spending log and an off switch. Swap Ripper never holds funds.",
    inputSchema: { type: "object", required: ["max_per_payment_usd", "max_per_day_usd"], properties: {
      max_per_payment_usd: { type: "number", description: "Largest single payment allowed, in USD, e.g. 20." },
      max_per_day_usd: { type: "number", description: "Total allowed per UTC day, in USD, e.g. 100." },
      allowed_chains: { description: "Optional list of chains money may move on, e.g. ['base','solana']. Empty = any.", anyOf: [{ type: "array", items: { type: "string" } }, { type: "string" }] },
      allowed_tokens: { description: "Optional list of tokens the agent may send, e.g. ['USDC']. Empty = any.", anyOf: [{ type: "array", items: { type: "string" } }, { type: "string" }] },
      allowed_recipients: { description: "Optional list of addresses the agent may pay. Empty = any.", anyOf: [{ type: "array", items: { type: "string" } }, { type: "string" }] },
      label: { type: "string", description: "Optional name, e.g. 'research agent'." },
      expires_in_days: { type: "integer", description: "1-365, default 365." },
    } },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    run: createSpendingPolicy,
  },
  {
    name: "policy_status",
    title: "Check spending limits and today's spend",
    description: "See a spending policy's limits, how much was spent today and how much is left. Owners who pass admin_key also get the spending log (last 50 payments).",
    inputSchema: { type: "object", required: ["policy_id"], properties: {
      policy_id: { type: "string", description: "The policy_id (starts with 'pol_')." },
      admin_key: { type: "string", description: "Owner only: the admin_key, to include the spending log." },
    } },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: policyStatus,
  },
  {
    name: "set_policy_enabled",
    title: "Owner: switch an agent's spending on or off",
    description: "Owner kill switch. enabled=false instantly blocks every swap and payment through the policy; enabled=true turns it back on. Requires admin_key.",
    inputSchema: { type: "object", required: ["policy_id", "admin_key", "enabled"], properties: {
      policy_id: { type: "string" }, admin_key: { type: "string" }, enabled: { type: "boolean" },
    } },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: setPolicyEnabled,
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
      speed: SPEED,
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
      route: { type: "string", enum: ["best_price", "fast"], description: "Pass 'fast' if the swap was created with speed='fast' (the reply says route='fast')." },
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
const POLICY_LOCKED_BLOCK = new Set(["create_spending_policy", "set_policy_enabled"]);
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
        const args = { ...(params.arguments || {}) };
        if (c.policyId) {
          args.policy_id = c.policyId;
          if (POLICY_LOCKED_BLOCK.has(tool.name)) throw new UserError("This connection is locked to a spending policy; that tool isn't available here.");
        }
        const out = await tool.run(c, args);
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
  const map = { tokens: "search_tokens", chains: "list_chains", quote: "get_quote", swap: "create_swap", pay: "pay_exact", status: "get_swap_status", prices: "get_prices", compare: "compare_quotes", text: "quote_from_text", referrals: "referral_stats", link: "create_payment_link", invoice: "check_payment", receipt: "get_receipt", verify: "verify_receipt", limits: "create_spending_policy", policy: "policy_status", policy_enabled: "set_policy_enabled", gas: "refuel_gas", x402: "fund_x402", payany: "pay" };
  const tool = TOOL_MAP[map[route]];
  if (tool) track(c, `rest:${route}`);
  if (!tool) return json({ error: "Unknown endpoint", endpoints: Object.keys(map).map((k) => `/api/${k}`) }, 404);
  if (["swap", "pay", "compare", "gas", "x402", "payany", "verify", "limits", "policy_enabled"].includes(route) && request.method !== "POST") return json({ error: `Use POST for /api/${route}` }, 405);
  if (c.policyId) {
    if (POLICY_LOCKED_BLOCK.has(tool.name)) return json({ error: "This connection is locked to a spending policy; that endpoint isn't available here." }, 403);
    args.policy_id = c.policyId;
  }
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
      "/api/payany": post("payAnything", "Pay ANY payment request (x402, Solana Pay, EIP-681, BIP21, payment link, plain text) with any token", t("pay")),
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

- Service fee: ${discountText(c)}, built into quotes. No API key. No sign-up. Non-custodial.
- Referral program: pass referrer=<your NEAR account> on any call and earn 1/3 of the fee on swaps you route. Same price for the user.

## Connect
- MCP (Streamable HTTP, no auth): ${origin}/mcp
- REST: ${origin}/api/{payany,quote,text,swap,pay,x402,gas,link,compare,status,prices,tokens,chains,referrals}
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
- Pay anything: POST ${origin}/api/payany {"request":"send 20 USDC to 0x... on base","pay_with_token":"SOL","pay_with_chain":"solana","refund_address":"<solana address>"} (also accepts solana:, ethereum:, bitcoin: links, payment links and 402 bodies)
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
<h2>Spending limits owners can trust</h2><p>Owners set limits (per payment, per day, chains, tokens, recipients) and give their agent a policy-locked URL. Anything over the limits is refused before payment instructions exist, with a spending log and an instant off switch. <a href="/limits"><b>Set limits for your agent →</b></a></p>
<h2>Get paid, with proof</h2><p>Payment links are trackable invoices: <code>check_payment</code> tells a selling agent when it has been paid, and <code>get_receipt</code> issues a signed receipt that anyone can verify with <code>verify_receipt</code>. Deliver only after you are paid.</p>
<h2>Pay anything</h2><p>Hand the <code>pay</code> tool any bill: an x402 invoice, a Solana Pay or Ethereum payment link, a Bitcoin link, a payment link, or just "send 20 USDC to 0x… on Base". It works out who gets what and pays it exactly with whatever you hold, on any chain.</p>
<h2>Best price or fastest: your choice</h2><p>By default every swap and payment is quoted on two networks at once and sent through whichever is cheaper for you, with automatic failover if one is down. Need it now? Pass <code>speed: "fast"</code> for fills in seconds.</p>
<h2>Proven best price</h2><p>Every quote is checked live against Relay at the same moment, and the result is in the answer (<code>best_price_check</code>). No trust needed: agents see exactly how much more they get, or if going direct would be cheaper.</p>
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

function limitsPage() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Set spending limits for your AI agent · Swap Ripper</title><link rel="icon" href="/icon.svg" type="image/svg+xml">
<meta name="description" content="Cap what your AI agent can spend in crypto: per payment, per day, chains, tokens, recipients. Instant off switch. Non-custodial.">
<style>:root{color-scheme:light dark;--b:rgba(127,127,127,.35)}*{box-sizing:border-box}body{font:16px/1.5 system-ui,sans-serif;max-width:560px;margin:32px auto;padding:0 16px}
.card{border:1px solid var(--b);border-radius:14px;padding:20px;margin:14px 0}h1{font-size:24px;margin:0 0 4px}h2{font-size:18px;margin:0 0 8px}.sub{opacity:.7;margin:0 0 10px;font-size:14px}
label{display:block;font-size:13px;opacity:.8;margin:12px 0 4px}input,button{font:inherit;width:100%;padding:10px 12px;border-radius:10px;border:1px solid var(--b);background:transparent;color:inherit}
button{background:#5b5bf0;color:#fff;border:none;margin-top:16px;cursor:pointer;font-weight:600}button.sec{background:transparent;color:inherit;border:1px solid var(--b)}
.mono{font-family:ui-monospace,monospace;word-break:break-all;font-size:13px;background:rgba(127,127,127,.12);padding:10px;border-radius:8px}.row{display:flex;gap:8px}.row>*{flex:1}
.warn{background:rgba(255,170,0,.15);border-radius:8px;padding:10px;font-size:14px}.err{color:#d33}.ok{color:#1a9b4b;font-weight:600}.muted{opacity:.65;font-size:13px}table{width:100%;font-size:13px;border-collapse:collapse}td{border-top:1px solid var(--b);padding:4px}</style></head><body>
<h1>🛡️ Spending limits for your AI agent</h1><p class="sub">Your agent gets a special connection URL. Any swap or payment that breaks your rules is refused before payment instructions are even created. Swap Ripper never holds your money.</p>
<div class="card"><h2>1. Set the limits</h2>
<div class="row"><div><label>Max per payment (USD)</label><input id="pp" type="number" min="1" value="20"></div><div><label>Max per day (USD)</label><input id="pd" type="number" min="1" value="100"></div></div>
<label>Allowed chains (optional, comma separated)</label><input id="ch" placeholder="e.g. base, solana">
<label>Allowed tokens to send (optional)</label><input id="tk" placeholder="e.g. USDC">
<label>Allowed recipients (optional addresses, comma separated)</label><input id="rc" placeholder="leave empty to allow any">
<label>Name (optional)</label><input id="lb" placeholder="e.g. research agent">
<button id="mk">Create limits</button><div id="out"></div></div>
<div class="card"><h2>2. Check spending or switch it off</h2>
<label>Policy ID</label><input id="sid" placeholder="pol_..."><label>Admin key</label><input id="sak" placeholder="adm_..." type="password">
<div class="row"><button class="sec" id="st">Show spending</button><button class="sec" id="off">Switch OFF</button><button class="sec" id="on">Switch ON</button></div><div id="sout"></div></div>
<p class="muted"><a href="/">Swap Ripper</a> · Limits apply to swaps and payments made through the policy URL. Spending is counted when payment instructions are issued.</p>
<script>
const e=(s)=>String(s??"").replace(/[&<>"']/g,(c)=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const post=async(p,b)=>(await fetch(p,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(b)})).json();
const v=(id)=>document.getElementById(id).value.trim();
document.getElementById("mk").onclick=async()=>{const o=document.getElementById("out");o.innerHTML="<p>Creating…</p>";
 const j=await post("/api/limits",{max_per_payment_usd:Number(v("pp")),max_per_day_usd:Number(v("pd")),allowed_chains:v("ch"),allowed_tokens:v("tk"),allowed_recipients:v("rc"),label:v("lb")});
 if(j.error){o.innerHTML='<p class="err">'+e(j.error)+'</p>';return;}
 document.getElementById("sid").value=j.policy_id;
 o.innerHTML='<p class="ok">Done.</p><label>Give your agent this MCP URL (instead of the normal one)</label><div class="mono">'+e(j.agent_mcp_url)+'</div>'+
 '<label>Policy ID</label><div class="mono">'+e(j.policy_id)+'</div><label>Admin key: save it now, it is shown only once</label><div class="mono">'+e(j.admin_key)+'</div>'+
 '<p class="warn">Keep the admin key private. It is the only way to see the log and switch spending off.</p>';};
const show=(j)=>{const o=document.getElementById("sout");if(j.error){o.innerHTML='<p class="err">'+e(j.error)+'</p>';return;}
 let h='<p>'+(j.limits?('Spent today: <b>$'+e(j.spent_today_usd)+'</b> · left: <b>$'+e(j.left_today_usd)+'</b> · '+(j.limits.enabled?'<span class="ok">ON</span>':'<span class="err">OFF</span>')):e(j.message))+'</p>';
 if(j.log&&j.log.length)h+='<table>'+j.log.map(x=>'<tr><td>'+e(x.at.slice(0,16).replace("T"," "))+'</td><td>$'+e(x.usd)+'</td><td>'+e(x.receive)+'</td></tr>').join("")+'</table>';
 else if(j.log)h+='<p class="muted">No payments yet.</p>';o.innerHTML=h;};
document.getElementById("st").onclick=async()=>show(await (await fetch("/api/policy?"+new URLSearchParams({policy_id:v("sid"),admin_key:v("sak")}))).json());
document.getElementById("off").onclick=async()=>show(await post("/api/policy_enabled",{policy_id:v("sid"),admin_key:v("sak"),enabled:false}));
document.getElementById("on").onclick=async()=>show(await post("/api/policy_enabled",{policy_id:v("sid"),admin_key:v("sak"),enabled:true}));
</script></body></html>`;
}

function payPage(origin, q) {
  const cfgJson = JSON.stringify({ to: q.get("to") || "", token: q.get("token") || "", chain: q.get("chain") || "",
    amount: q.get("amount") || "", label: q.get("label") || "", ref: q.get("ref") || "", inv: /^inv_[a-z0-9]{12}$/.test(q.get("inv") || "") ? q.get("inv") : "", payWith: PAY_WITH })
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
    if (C.inv) body.invoice = C.inv;
    const r = await fetch("/api/pay", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json(); btn.disabled = false;
    if (j.error) { out.innerHTML = '<p class="err">' + e(j.error) + '</p>'; return; }
    btn.classList.add("hide");
    out.innerHTML = '<label>Send exactly</label><div class="row"><div class="mono big" style="font-size:20px">' + e(j.send_exactly) + ' ' + e(j.send_token.symbol) + '</div>' + copyBtn(j.send_exactly) + '</div>' +
      '<p class="muted">on the <b>' + e(j.deposit_chain) + '</b> network</p>' +
      '<label>To this one-time address</label><div class="row"><div class="mono">' + e(j.deposit_address) + '</div>' + copyBtn(j.deposit_address) + '</div>' +
      (j.deposit_memo ? '<label>Memo (required)</label><div class="row"><div class="mono">' + e(j.deposit_memo) + '</div>' + copyBtn(j.deposit_memo) + '</div>' : '') +
      '<p class="muted">' + (j.deadline ? 'Send before ' + e(new Date(j.deadline).toLocaleString()) : 'Send it right away') + '. Recipient gets exactly ' + e(amount) + ' ' + e(C.token) + '.</p>' +
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
      const pm = path.match(/^\/(mcp|api)\/p\/(pol_[a-z0-9]{14})(\/.*)?$/);
      if (pm) {
        try { await loadPolicy(c, pm[2]); } catch (e) { return json({ error: e.message }, 404); }
        c.policyId = pm[2];
        if (pm[1] === "mcp") return await handleMcp(request, c);
        const u2 = new URL(url); u2.pathname = "/api" + (pm[3] || "/");
        return await handleRest(request, u2, c);
      }
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
      if (path === "/limits") { track(c, "view:limits"); return text(limitsPage(), "text/html"); }
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
