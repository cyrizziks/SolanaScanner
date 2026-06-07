// netlify/functions/identity.js
// Batch wallet-identity lookup via Helius. Takes up to 100 addresses, returns
// each one's known identity (Centralized Exchange, DeFi, Market Maker, Rugger,
// Scammer, etc). Auth-gated; uses HELIUS_KEY. This is label data, not analysis.

import crypto from "node:crypto";

const KEY = process.env.HELIUS_KEY;
const SECRET = process.env.AUTH_SECRET;

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
  const addresses = (b.addresses || []).slice(0, 100);
  if (!addresses.length) return { statusCode: 200, headers: { "content-type": "application/json" }, body: "[]" };

  try {
    const res = await fetch(`https://api.helius.xyz/v1/wallet/batch-identity?api-key=${KEY}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ addresses }),
    });
    if (!res.ok) return { statusCode: 200, headers: { "content-type": "application/json" }, body: "[]" }; // beta API — degrade quietly
    const text = await res.text();
    return { statusCode: 200, headers: { "content-type": "application/json" }, body: text };
  } catch (e) {
    return { statusCode: 200, headers: { "content-type": "application/json" }, body: "[]" };
  }
};
