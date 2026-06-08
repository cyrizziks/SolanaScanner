// netlify/functions/flow.js
// Recent buy/sell flow (#2) + trade authenticity (#6) for ONE token, in SOL.
//
// Pulls the token mint's recent SWAP transactions from Helius Enhanced
// Transactions and, for each SOL-denominated swap, classifies it:
//   BUY  = token is in the swap's outputs AND SOL came in   (nativeInput)
//   SELL = token is in the swap's inputs  AND SOL went out  (nativeOutput)
// We sum SOL volume per side, count unique traders, and count "round-trips"
// (wallets that BOTH bought and sold in the sample) as a wash-trading tell.
//
// Honest about sampling: this is the most recent ~N swaps, which may span
// minutes (active token) or days (quiet one). spanStart/spanEnd are returned so
// the UI states the exact window. token<->token hops (no SOL leg) are skipped —
// they don't reveal SOL pressure. Same auth + pattern as pnl.js. Uses HELIUS_KEY.

import crypto from "node:crypto";

const KEY = process.env.HELIUS_KEY;
const SECRET = process.env.AUTH_SECRET;
const PAGES = 5;   // ~500 most recent swaps — strong signal, modest credits
const PER = 100;

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

export const handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "POST only" };
  if (!authed(event)) return { statusCode: 401, body: "Unauthorized" };
  if (!KEY) return { statusCode: 500, body: "Server missing HELIUS_KEY" };

  let b;
  try { b = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: "Invalid JSON" }; }
  const mint = b.mint;
  if (!mint) return { statusCode: 400, body: "Missing mint" };

  try {
    let before = "";
    let buySol = 0, sellSol = 0, buys = 0, sells = 0;
    let tMin = Infinity, tMax = 0, sampled = 0, capped = false;
    const bought = new Set(), sold = new Set();

    for (let p = 0; p < PAGES; p++) {
      const url = `https://api.helius.xyz/v0/addresses/${mint}/transactions`
        + `?api-key=${KEY}&limit=${PER}&type=SWAP${before ? `&before=${before}` : ""}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Helius ${res.status}`);
      const txs = await res.json();
      if (!Array.isArray(txs) || txs.length === 0) break;

      for (const tx of txs) {
        sampled++;
        const ts = tx.timestamp || 0;
        if (ts) { tMin = Math.min(tMin, ts); tMax = Math.max(tMax, ts); }
        const sw = tx.events?.swap;
        if (!sw) continue;
        const outHas = (sw.tokenOutputs || []).some((t) => t.mint === mint);
        const inHas = (sw.tokenInputs || []).some((t) => t.mint === mint);
        const trader = sw.nativeInput?.account || sw.nativeOutput?.account || tx.feePayer || "";
        if (outHas && sw.nativeInput?.amount) {
          buySol += Number(sw.nativeInput.amount) / 1e9; buys++; if (trader) bought.add(trader);
        } else if (inHas && sw.nativeOutput?.amount) {
          sellSol += Number(sw.nativeOutput.amount) / 1e9; sells++; if (trader) sold.add(trader);
        }
      }

      before = txs[txs.length - 1]?.signature || "";
      if (txs.length < PER) break;
      if (p === PAGES - 1) capped = true;
    }

    let roundTrips = 0;
    bought.forEach((a) => { if (sold.has(a)) roundTrips++; });
    const uniqueTraders = new Set([...bought, ...sold]).size;

    return {
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        buySol, sellSol, netSol: buySol - sellSol,
        buys, sells,
        uniqueBuyers: bought.size, uniqueSellers: sold.size, uniqueTraders, roundTrips,
        spanStart: tMin === Infinity ? null : tMin, spanEnd: tMax || null,
        sampled, capped,
      }),
    };
  } catch (e) {
    return { statusCode: 502, body: e.message };
  }
};
