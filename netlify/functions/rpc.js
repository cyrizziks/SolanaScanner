// netlify/functions/rpc.js
// Thin proxy to Helius. The browser POSTs a JSON-RPC body here; this function
// injects your API key (from the HELIUS_KEY env var) and forwards it.
// The key NEVER reaches the client. Method allowlist blocks abuse.

const ALLOWED = new Set([
  "getAccountInfo",
  "getTokenLargestAccounts",
  "getTokenAccounts",
  "getMultipleAccounts",
  "getSignaturesForAddress",
  "getTransaction",
  "getTokenSupply",
]);

export const handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "POST only" };

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
