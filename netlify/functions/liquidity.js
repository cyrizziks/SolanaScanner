// netlify/functions/liquidity.js
// Real exit liquidity / slippage for a token, via Jupiter's Quote API.  (#1)
//
// WHY JUPITER: you trade on Jupiter, which is an AGGREGATOR — it routes a sell
// across whatever pools (Raydium, PumpSwap, Meteora, the pump.fun curve, …)
// give the best fill. A Jupiter quote is therefore the *true* "what would I
// actually get if I sold X right now" number, across every venue at once — not
// a single-pool approximation. It's raw routing data (like Helius price), not a
// third-party verdict, so it fits the "no third-party analysis" rule.
//
// The client sends probe sizes as TOKEN RAW AMOUNTS (it sizes them by supply
// fraction so this works even when price is unknown for brand-new tokens). For
// each probe we quote  token -> wSOL  and report SOL out + price impact + the
// AMMs the route used. Auth-gated so it can't be abused as an open proxy.
//
// Jupiter's public quote endpoint needs no key but IS rate-limited; probes are
// capped. priceImpactPct comes back as a decimal fraction string ("0.0123") —
// we convert to percent (×100).

import crypto from "node:crypto";

const SECRET = process.env.AUTH_SECRET;
const WSOL = "So11111111111111111111111111111111111111112";
const QUOTE = "https://quote-api.jup.ag/v6/quote";
const MAX_PROBES = 6;

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

  let b;
  try { b = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: "Invalid JSON" }; }
  const mint = b.mint;
  const probes = Array.isArray(b.probes) ? b.probes.slice(0, MAX_PROBES) : [];
  if (!mint || !probes.length) return { statusCode: 400, body: "Missing mint or probes" };

  try {
    const results = [];
    for (const raw of probes) {
      const amount = String(Math.max(1, Math.floor(Number(raw) || 0)));
      const url = `${QUOTE}?inputMint=${mint}&outputMint=${WSOL}&amount=${amount}`
        + `&slippageBps=50&swapMode=ExactIn&onlyDirectRoutes=false`;
      try {
        const res = await fetch(url, { headers: { accept: "application/json" } });
        if (!res.ok) { results.push({ rawIn: amount, routable: false, status: res.status }); continue; }
        const q = await res.json();
        if (!q || !q.outAmount) { results.push({ rawIn: amount, routable: false }); continue; }
        const venues = [...new Set((q.routePlan || []).map((r) => r.swapInfo?.label).filter(Boolean))];
        results.push({
          rawIn: amount,
          routable: true,
          outSol: Number(q.outAmount) / 1e9,
          impactPct: q.priceImpactPct != null ? Number(q.priceImpactPct) * 100 : null,
          venues,
        });
      } catch { results.push({ rawIn: amount, routable: false }); }
    }
    const routable = results.some((r) => r.routable);
    return {
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ routable, probes: results }),
    };
  } catch (e) {
    return { statusCode: 502, body: e.message };
  }
};
