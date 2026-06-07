// netlify/functions/pnl.js
// Recent realized PnL for one wallet, in SOL terms.
//
// Approach (deliberately robust over "accurate-looking"): we pull the wallet's
// recent SWAP transactions from Helius's Enhanced Transactions API and sum the
// wallet's OWN native (SOL) balance change across them. Reading the real
// on-chain balance delta avoids buy/sell direction sign errors entirely.
//
//   netSol > 0  -> wallet has pulled SOL out of its trading = profit taken
//   netSol < 0  -> net SOL deployed; may be holding open positions, not "loss"
//
// Caveats surfaced in the UI: SOL terms (not USD), recent/sampled (not lifetime),
// fees included. Requires a valid signed login token. Uses HELIUS_KEY.

import crypto from "node:crypto";

const KEY = process.env.HELIUS_KEY;
const SECRET = process.env.AUTH_SECRET;
const PAGES = 2;   // ~200 most recent swaps — enough signal without burning credits
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
  const addr = b.address;
  if (!addr) return { statusCode: 400, body: "Missing address" };

  try {
    let before = "";
    let lamports = 0;
    let swaps = 0;
    let capped = false;
    const mints = new Set();

    for (let p = 0; p < PAGES; p++) {
      const url = `https://api.helius.xyz/v0/addresses/${addr}/transactions`
        + `?api-key=${KEY}&limit=${PER}&type=SWAP${before ? `&before=${before}` : ""}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Helius ${res.status}`);
      const txs = await res.json();
      if (!Array.isArray(txs) || txs.length === 0) break;

      for (const tx of txs) {
        swaps++;
        for (const ad of tx.accountData || []) {
          if (ad.account === addr && typeof ad.nativeBalanceChange === "number") {
            lamports += ad.nativeBalanceChange;
          }
          for (const tbc of ad.tokenBalanceChanges || []) {
            if (tbc.userAccount === addr && tbc.mint) mints.add(tbc.mint);
          }
        }
      }

      before = txs[txs.length - 1]?.signature || "";
      if (txs.length < PER) break;
      if (p === PAGES - 1) capped = true;
    }

    return {
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ netSol: lamports / 1e9, swaps, tokensTraded: mints.size, capped }),
    };
  } catch (e) {
    return { statusCode: 502, body: e.message };
  }
};
