// netlify/functions/login.js
// Checks the shared password (SITE_PASSWORD) and, if correct, returns a signed
// token. The token is an HMAC of its own expiry using AUTH_SECRET — it can't be
// forged without the secret, and rpc.js / wallet-intel.js verify it the same way.

import crypto from "node:crypto";

const PW = process.env.SITE_PASSWORD;
const SECRET = process.env.AUTH_SECRET;
const TTL_DAYS = 30;

const sign = (exp) => crypto.createHmac("sha256", SECRET).update(String(exp)).digest("hex");

export const handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "POST only" };
  if (!PW || !SECRET) return { statusCode: 500, body: "Server missing SITE_PASSWORD / AUTH_SECRET" };

  let b;
  try { b = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: "Invalid JSON" }; }

  const given = Buffer.from(String(b.password || ""));
  const real = Buffer.from(PW);
  const ok = given.length === real.length && crypto.timingSafeEqual(given, real);
  if (!ok) return { statusCode: 401, body: "Wrong password" };

  const exp = Date.now() + TTL_DAYS * 86400000;
  const token = `${exp}.${sign(exp)}`;
  return { statusCode: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) };
};
