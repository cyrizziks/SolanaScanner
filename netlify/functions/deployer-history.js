// netlify/functions/deployer-history.js
// On-demand: what ELSE has this deployer launched, and did those tokens die? (#4)
// A serial rugger is the single clearest avoid signal — one hit here outweighs
// a dozen holder heuristics.
//
// Method (deliberately a SAMPLE, surfaced as such): walk the deployer's recent
// signatures, fetch a capped number of the underlying transactions, detect SPL
// initializeMint / initializeMint2 instructions (top-level AND inner — pump.fun
// mints via CPI) to collect mints this wallet created, then price each via
// Helius getAsset. price ~0 / no asset = likely dead/rugged. Capped to stay
// cheap; not an exhaustive history. Same auth pattern as the others.

import crypto from "node:crypto";

const KEY = process.env.HELIUS_KEY;
const SECRET = process.env.AUTH_SECRET;
const SIG_PAGES = 3;   // up to ~3000 signatures scanned for candidates
const MAX_TX = 60;     // cap getTransaction calls (newest-first; recent launches matter most)
const CONC = 4;

function authed(event) {
  if (!SECRET) return false;
  const h = event.headers.authorization || event.headers.Authorization || "";
  const token = h.replace(/^Bearer\s+/i, "");
  const [exp, sig] = token.split(".");
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const expect = crypto.createHmac("sha256", SECRET).update(String(exp)).digest("hex");
  const a = Buffer.from(sig), b = Buffer.from(expect);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function rpc(method, params) {
  const res = await fetch(`https://mainnet.helius-rpc.com/?api-key=${KEY}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await res.json();
  if (j.error) throw new Error(j.error.message || "RPC error");
  return j.result;
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try { out[idx] = await fn(items[idx], idx); } catch { out[idx] = null; }
    }
  });
  await Promise.all(workers);
  return out;
}

export const handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "POST only" };
  if (!authed(event)) return { statusCode: 401, body: "Unauthorized" };
  if (!KEY) return { statusCode: 500, body: "Server missing HELIUS_KEY" };

  let b;
  try { b = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: "Invalid JSON" }; }
  const deployer = b.deployer;
  const exclude = b.exclude || "";   // the current token — don't report it back
  if (!deployer) return { statusCode: 400, body: "Missing deployer" };

  try {
    // 1) collect recent signatures
    let before, sigs = [];
    for (let p = 0; p < SIG_PAGES; p++) {
      const batch = await rpc("getSignaturesForAddress", [deployer, before ? { limit: 1000, before } : { limit: 1000 }]);
      if (!batch?.length) break;
      sigs = sigs.concat(batch);
      if (batch.length < 1000) break;
      before = batch[batch.length - 1].signature;
    }
    const scanned = sigs.length;
    const sample = sigs.slice(0, MAX_TX);   // newest first

    // 2) detect mint creations in the sampled txs (top-level + inner instructions)
    const found = new Set();
    await pool(sample, CONC, async (s) => {
      const tx = await rpc("getTransaction", [s.signature, { maxSupportedTransactionVersion: 0, encoding: "jsonParsed" }]);
      const top = tx?.transaction?.message?.instructions || [];
      const inner = (tx?.meta?.innerInstructions || []).flatMap((i) => i.instructions || []);
      [...top, ...inner].forEach((x) => {
        const ty = x.parsed?.type;
        const m = x.parsed?.info?.mint;
        if ((ty === "initializeMint" || ty === "initializeMint2") && m && m !== exclude) found.add(m);
      });
    });

    // 3) price each candidate → dead if no price
    const mints = [...found];
    const priced = (await pool(mints, CONC, async (m) => {
      try {
        const asset = await rpc("getAsset", { id: m, displayOptions: { showFungible: true } });
        const price = asset?.token_info?.price_info?.price_per_token ?? null;
        const name = asset?.content?.metadata?.name || asset?.token_info?.symbol || null;
        return { mint: m, name, price, dead: price == null || price <= 0 };
      } catch { return { mint: m, name: null, price: null, dead: true }; }
    })).filter(Boolean);

    const deadCount = priced.filter((p) => p.dead).length;
    return {
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        scanned, sampledTx: sample.length,
        priorMints: priced, priorCount: priced.length, deadCount,
        capped: scanned > MAX_TX,
      }),
    };
  } catch (e) {
    return { statusCode: 502, body: e.message };
  }
};
