// netlify/functions/flow.js
// Recent buy/sell flow (#2) + trade authenticity (#6) for ONE token, in SOL.
//
// Pulls the token mint's recent SWAP transactions from Helius Enhanced
// Transactions. For each, the SIGNER (tx.feePayer) is the trader; direction =
// how the signer's balance of THIS token changed (accountData.tokenBalanceChanges,
// fall back to top-level tokenTransfers). The SOL leg = the signer's
// nativeBalanceChange (same proven method as pnl.js), falling back to wrapped-SOL
// transfers when the trade settled in WSOL. We do NOT rely on events.swap — it's
// empty/pool-attributed for pump.fun and Jupiter-routed swaps.
//
// We sum SOL volume per side, count unique traders, and count "round-trips"
// (wallets that BOTH bought and sold in the sample) as a wash-trading tell.
//
// Honest about sampling: this is the most recent ~N swaps, which may span
// minutes (active token) or days (quiet one). spanStart/spanEnd are returned so
// the UI states the exact window. Same auth + pagination pattern as pnl.js. Uses HELIUS_KEY.

import crypto from "node:crypto";

const KEY = process.env.HELIUS_KEY;
const SECRET = process.env.AUTH_SECRET;
const WSOL = "So11111111111111111111111111111111111111112";
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

        const trader = tx.feePayer;
        if (!trader) continue;

        // Direction = how the SIGNER's balance of THIS token changed.
        // Prefer accountData.tokenBalanceChanges (authoritative), fall back to
        // top-level tokenTransfers. (events.swap is unreliable for pump/Jupiter.)
        let ourDelta = 0;
        for (const ad of tx.accountData || []) {
          for (const tb of ad.tokenBalanceChanges || []) {
            if (tb.userAccount === trader && tb.mint === mint && tb.rawTokenAmount?.tokenAmount != null) {
              ourDelta += Number(tb.rawTokenAmount.tokenAmount) / 10 ** (tb.rawTokenAmount.decimals || 0);
            }
          }
        }
        if (ourDelta === 0) {
          for (const tt of tx.tokenTransfers || []) {
            if (tt.mint !== mint) continue;
            if (tt.toUserAccount === trader) ourDelta += Number(tt.tokenAmount) || 0;
            else if (tt.fromUserAccount === trader) ourDelta -= Number(tt.tokenAmount) || 0;
          }
        }
        if (ourDelta === 0) continue; // this swap didn't move the token for the signer

        // SOL leg = signer's native balance change (same proven method as pnl.js);
        // if native is ~0 (settled in wrapped SOL), fall back to WSOL transfers.
        let nativeDelta = 0;
        for (const ad of tx.accountData || []) {
          if (ad.account === trader && typeof ad.nativeBalanceChange === "number") nativeDelta += ad.nativeBalanceChange / 1e9;
        }
        let solDelta = nativeDelta;
        if (Math.abs(nativeDelta) < 0.001) {
          let wsol = 0;
          for (const tt of tx.tokenTransfers || []) {
            if (tt.mint !== WSOL) continue;
            if (tt.toUserAccount === trader) wsol += Number(tt.tokenAmount) || 0;
            else if (tt.fromUserAccount === trader) wsol -= Number(tt.tokenAmount) || 0;
          }
          if (wsol) solDelta = wsol;
        }

        if (ourDelta > 0) { buys++; bought.add(trader); buySol += Math.max(0, -solDelta); }
        else { sells++; sold.add(trader); sellSol += Math.max(0, solDelta); }
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
