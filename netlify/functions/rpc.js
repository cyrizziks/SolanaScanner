// netlify/functions/rpc.js
// Thin proxy to Helius. The browser POSTs a JSON-RPC body here; this function
// injects your API key (from the HELIUS_KEY env var) and forwards it.
// The key NEVER reaches the client. Method allowlist blocks abuse.
// Requires a valid signed login token (see login.js).

import crypto from "node:crypto";

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

const ALLOWED = new Set([
  "getAccountInfo",
  "getTokenLargestAccounts",
  "getTokenAccounts",
  "getMultipleAccounts",
  "getTokenAccountsByOwner",
  "getAsset",
  "getAssetsByOwner",
  "getSignaturesForAddress",
  "getTransaction",
  "getTokenSupply",
]);

export const handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "POST only" };
  if (!authed(event)) return { statusCode: 401, body: "Unauthorized" };

  const key = process.env.HELIUS_KEY;
  if (!key) return { statusCode: 500, body: "Server missing HELIUS_KEY env var" };

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: "Invalid JSON" }; }

  if (!ALLOWED.has(body.method))
    return { statusCode: 403, body: `Method not allowed: ${body.method}` };

  try {
    const res = await fetch(`https://mainnet.helius-rpc.com/?api-key=${key}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    return {
      statusCode: res.status,
      headers: { "content-type": "application/json" },
      body: text,
    };
  } catch (e) {
    return { statusCode: 502, body: `Upstream error: ${e.message}` };
  }
};
