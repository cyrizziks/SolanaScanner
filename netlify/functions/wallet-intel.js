// netlify/functions/wallet-intel.js
// Persistent wallet intelligence backed by Supabase.
//   op:"sync"  -> record the wallets a scan saw, return merged cross-token intel
//   op:"label" -> save your manual tags / note / flagged for one wallet
//
// Talks to Supabase via two Postgres functions (record_wallets, label_wallet)
// using the SERVICE ROLE key. That key bypasses RLS and must ONLY live in the
// Netlify env — never in the browser.

const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_KEY;

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
    return { statusCode: 400, body: "Unknown op" };
  } catch (e) {
    return { statusCode: 502, body: e.message };
  }
};
