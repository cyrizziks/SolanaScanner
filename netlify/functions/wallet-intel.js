// netlify/functions/wallet-intel.js
// Persistent wallet intelligence backed by Supabase.
//   op:"sync"  -> record the wallets a scan saw, return merged cross-token intel
//   op:"label" -> save your manual tags / note / flagged for one wallet
//   op:"pnl"   -> record an on-demand PnL reading (smart-money reputation)  (#3)
//
// Talks to Supabase via Postgres functions (record_wallets, label_wallet,
// record_pnl) using the SERVICE ROLE key. That key bypasses RLS and must ONLY
// live in the Netlify env — never in the browser. Requires a signed login token.

import crypto from "node:crypto";

const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_KEY;
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

async function rpc(fn, body) {
  const res = await fetch(`${URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  return res.json();
}

export const handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "POST only" };
  if (!authed(event)) return { statusCode: 401, body: "Unauthorized" };
  if (!URL || !KEY) return { statusCode: 500, body: "Server missing SUPABASE_URL / SUPABASE_SERVICE_KEY" };

  let b;
  try { b = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: "Invalid JSON" }; }

  try {
    if (b.op === "sync") {
      const rows = (b.wallets || []).map((w) => ({ address: w.address, tags: w.tags || [] }));
      const out = await rpc("record_wallets", { p_token: b.token, p_rows: rows });
      return { statusCode: 200, headers: { "content-type": "application/json" }, body: JSON.stringify(out) };
    }
    if (b.op === "label") {
      const out = await rpc("label_wallet", {
        p_address: b.address,
        p_manual: b.manual_tags || [],
        p_note: b.note || "",
        p_flagged: !!b.flagged,
      });
      return { statusCode: 200, headers: { "content-type": "application/json" }, body: JSON.stringify(out) };
    }
    if (b.op === "pnl") {
      const out = await rpc("record_pnl", {
        p_address: b.address,
        p_net_sol: typeof b.net_sol === "number" ? b.net_sol : 0,
        p_early: !!b.early,
      });
      return { statusCode: 200, headers: { "content-type": "application/json" }, body: JSON.stringify(out) };
    }
    return { statusCode: 400, body: "Unknown op" };
  } catch (e) {
    return { statusCode: 502, body: e.message };
  }
};
