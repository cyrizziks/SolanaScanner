import React, { useState, useRef, useEffect, useMemo, useCallback } from "react";
import * as d3 from "d3";
import {
  Search, Loader2, ShieldCheck, ShieldAlert, Flame, Snowflake, Lock,
  Unlock, Users, Boxes, Crosshair, Building2, Sparkles, AlertTriangle,
  Copy, Check, ChevronRight, Wallet, Activity, X, Gauge, Cog
} from "lucide-react";

/* ============================================================================
   SolScope — Solana token forensics. Feed it a CA, it reads the chain itself.
   No third-party analysis tools. Only raw RPC data + your own logic.
   ----------------------------------------------------------------------------
   EXTENSION POINTS (need a small backend — Netlify fn + Supabase free tier):
     - persistWalletLabel()  -> store learned wallet categories so they stick
     - deepWalletPnL()       -> cross-token realized/unrealized PnL per wallet
     - exactBundleDetect()   -> same-slot / Jito-bundle buy detection
   They're stubbed below and clearly marked. Everything else is live.
   ========================================================================== */

/* Known on-chain entities. SEED LIST — verify + extend from a source you trust.
   Mislabeling a wallet can skew a buy decision, so treat unverified entries
   as suspect. Burn/program addresses below are stable; CEX entries: VERIFY. */
const KNOWN = {
  "1nc1nerator11111111111111111111111111111111": { label: "Burn / Incinerator", kind: "burn" },
  "11111111111111111111111111111111": { label: "System Program", kind: "system" },
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P": { label: "Pump.fun Program", kind: "lp" },
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8": { label: "Raydium AMM v4", kind: "lp" },
  // --- CEX hot wallets: VERIFY these against a trusted list before trusting labels ---
  "2ojv9BAiHUrvsm9gxDe7fJSzbNZSJcxZvf8dqmWGHG8S": { label: "Binance (verify)", kind: "cex" },
  "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9": { label: "Binance (verify)", kind: "cex" },
  "H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS": { label: "Coinbase (verify)", kind: "cex" },
};

// All RPC goes through your Netlify function so the Helius key stays server-side.
const RPC_PROXY = "/.netlify/functions/rpc";
// Persistent wallet intelligence (Supabase, via Netlify fn). Server-side keys.
const INTEL = "/.netlify/functions/wallet-intel";
const PNL = "/.netlify/functions/pnl";
const IDENTITY = "/.netlify/functions/identity";
const PNL_CACHE = {}; // address -> result, cached for the session to avoid re-spending credits

/* Helius identity category -> our internal kind. */
function categoryKind(cat) {
  if (!cat) return null;
  if (cat === "Centralized Exchange") return "cex";
  if (["DeFi", "Proprietary AMM", "Stake Pool"].includes(cat)) return "lp";
  if (["Exploiter, Hackers & Scams", "Hacker", "Rugger", "Scammer", "Spam"].includes(cat)) return "malicious";
  return null;
}
/* Batch-resolve identities (chunked to Helius's 100-address limit). Best-effort. */
async function fetchIdentities(addresses) {
  const uniq = [...new Set(addresses.filter(Boolean))];
  const map = {};
  for (let i = 0; i < uniq.length; i += 100) {
    try {
      const res = await authedFetch(IDENTITY, { addresses: uniq.slice(i, i + 100) });
      if (res.ok) {
        const arr = await res.json();
        (Array.isArray(arr) ? arr : []).forEach((o) => { if (o && o.address) map[o.address] = { name: o.name, category: o.category, type: o.type }; });
      }
    } catch { /* identity offline — skip */ }
  }
  return map;
}

/* ---- Password gate. The password lives server-side; login returns a SIGNED
   token that the rpc + intel functions verify — so this protects the Helius /
   Supabase endpoints, not just the UI. Single shared password. ---- */
let AUTH_TOKEN = (() => { try { return localStorage.getItem("ss_token") || ""; } catch { return ""; } })();
let onUnauth = () => {};
function setAuth(t) { AUTH_TOKEN = t; try { t ? localStorage.setItem("ss_token", t) : localStorage.removeItem("ss_token"); } catch { /* ignore */ } }
async function authedFetch(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(AUTH_TOKEN ? { authorization: "Bearer " + AUTH_TOKEN } : {}) },
    body: JSON.stringify(body),
  });
  if (res.status === 401) { setAuth(""); onUnauth(); throw new Error("Session expired — please log in again."); }
  return res;
}
async function login(password) {
  try {
    const res = await fetch("/.netlify/functions/login", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }),
    });
    if (!res.ok) return false;
    const { token } = await res.json();
    if (!token) return false;
    setAuth(token); return true;
  } catch { return false; }
}

/* ---- tiny concurrency-limited RPC client (browser side, runs in YOUR app) -- */
function makeRpc(endpoint) {
  let id = 0;
  return async function rpc(method, params) {
    const res = await authedFetch(endpoint, { jsonrpc: "2.0", id: ++id, method, params });
    if (!res.ok) throw new Error(`RPC ${res.status}`);
    const j = await res.json();
    if (j.error) throw new Error(j.error.message || "RPC error");
    return j.result;
  };
}
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try { out[idx] = await fn(items[idx], idx); } catch { out[idx] = null; }
    }
  });
  await Promise.all(workers);
  return out;
}

const short = (a) => (a ? a.slice(0, 4) + "…" + a.slice(-4) : "");
const pct = (x) => (x == null ? "—" : x.toFixed(x < 1 ? 2 : 1) + "%");
const daysAgo = (ts) => (ts ? Math.max(0, (Date.now() / 1000 - ts) / 86400) : null);

/* ============================ ANALYSIS ENGINE ============================== */

/* Bundlers split a buy into many wallets with near-identical balances. Pure
   math on holder amounts we already have — bucket by 3 significant figures and
   surface the biggest group of >=3 lookalikes. Free (no extra calls). */
function detectEqualBalanceClusters(real) {
  const groups = {};
  real.forEach((h) => {
    if (!(h.amount > 0)) return;
    const mag = Math.floor(Math.log10(h.amount));
    const key = (h.amount / 10 ** (mag - 2)).toFixed(0) + "e" + mag; // ~3 sig figs
    (groups[key] = groups[key] || []).push(h);
  });
  return Object.values(groups)
    .filter((g) => g.length >= 3)
    .map((g) => ({ count: g.length, pct: g.reduce((s, h) => s + h.pctSupply, 0), amount: g[0].amount }))
    .sort((a, b) => b.count - a.count);
}

/* Walk the mint's signatures back to genesis (capped) to find the creator =
   fee payer of the first tx. ~2 calls for a fresh token. */
async function findDeployer(rpc, ca) {
  let before, oldest = null, pages = 0, reachedGenesis = false;
  for (;;) {
    const sigs = await rpc("getSignaturesForAddress", [ca, before ? { limit: 1000, before } : { limit: 1000 }]);
    if (!sigs?.length) break;
    oldest = sigs[sigs.length - 1];
    pages++;
    if (sigs.length < 1000) { reachedGenesis = true; break; }
    if (pages >= 5) break; // token too long-lived to trace cheaply
    before = oldest.signature;
  }
  if (!oldest) return null;
  const tx = await rpc("getTransaction", [oldest.signature, { maxSupportedTransactionVersion: 0, encoding: "jsonParsed" }]);
  const k0 = tx?.transaction?.message?.accountKeys?.[0];
  const deployer = typeof k0 === "object" ? k0.pubkey : k0;
  return { deployer, genesisTime: oldest.blockTime, reachedGenesis };
}

/* Pull the true top-N holders. Helius getTokenAccounts (DAS) returns owner +
   amount per token account; we paginate, aggregate by owner, and sort by
   balance. Falls back to top-20 (getTokenLargestAccounts) if DAS is missing. */
async function fetchTopHolders(rpc, ca, decimals, maxHolders, step) {
  const byOwner = {};
  const MAX_PAGES = 15; // ~15k accounts ceiling — plenty to find the real whales
  let page = 1, pages = 0, truncated = false, total = 0;
  try {
    for (;;) {
      const r = await rpc("getTokenAccounts", { mint: ca, page, limit: 1000, options: { showZeroBalance: false } });
      const accts = r?.token_accounts || [];
      accts.forEach((a) => {
        const amt = Number(a.amount) / 10 ** decimals;
        if (amt > 0) byOwner[a.owner] = (byOwner[a.owner] || 0) + amt;
      });
      pages++; total += accts.length;
      if (accts.length < 1000) break;
      if (pages >= MAX_PAGES) { truncated = true; break; }
      page++;
      step(`Fetching holders… ${total}+`);
    }
    const owners = Object.keys(byOwner);
    if (!owners.length) throw new Error("empty");
    const sorted = owners.map((o) => ({ owner: o, amount: byOwner[o] }))
      .sort((a, b) => b.amount - a.amount).slice(0, maxHolders);
    return { list: sorted, truncated, distinctOwners: owners.length };
  } catch {
    const largest = await rpc("getTokenLargestAccounts", [ca]);
    const accts = (largest?.value || []).slice(0, 20);
    const lookup = await rpc("getMultipleAccounts", [accts.map((t) => t.address), { encoding: "jsonParsed" }]);
    const list = accts.map((t, i) => ({
      owner: lookup?.value?.[i]?.data?.parsed?.info?.owner || t.address,
      amount: Number(t.uiAmount) || 0,
    }));
    return { list, truncated: false, distinctOwners: list.length, fallback: true };
  }
}

async function analyze(ca, endpoint, holdersN, traceDepth, onProgress) {
  const rpc = makeRpc(endpoint);
  const report = { ca, flags: [], warnings: [] };
  const step = (s) => onProgress && onProgress(s);

  // 1) Mint metadata + authorities
  step("Reading mint account…");
  const acc = await rpc("getAccountInfo", [ca, { encoding: "jsonParsed" }]);
  const info = acc?.value?.data?.parsed?.info;
  if (!info) throw new Error("Not a valid SPL mint, or RPC returned nothing.");
  const decimals = info.decimals ?? 0;
  const supply = Number(info.supply) / 10 ** decimals;
  const SYS = "11111111111111111111111111111111";
  const isSet = (a) => a && a !== SYS;
  const exts = info.extensions || [];
  const extState = (name) => exts.find((e) => e.extension === name)?.state;
  const fee = extState("transferFeeConfig");
  const feeBps = fee ? Number(fee.newerTransferFee?.transferFeeBasisPoints ?? fee.olderTransferFee?.transferFeeBasisPoints ?? 0) : 0;
  report.token = {
    decimals,
    supply,
    mintAuthority: info.mintAuthority,        // null = renounced
    freezeAuthority: info.freezeAuthority,    // null = renounced
    program: acc.value?.owner === "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" ? "token-2022" : "spl-token",
    ext: {
      feeBps,
      feeMutable: fee ? isSet(fee.transferFeeConfigAuthority) : false,
      permanentDelegate: isSet(extState("permanentDelegate")?.delegate) ? extState("permanentDelegate").delegate : null,
      transferHook: isSet(extState("transferHook")?.programId) ? extState("transferHook").programId : null,
      defaultFrozen: extState("defaultAccountState")?.accountState === "frozen",
      nonTransferable: !!exts.find((e) => e.extension === "nonTransferable"),
    },
  };

  // 2) True top-N holders (Helius DAS getTokenAccounts: paginate + aggregate)
  step("Fetching top holders…");
  const { list, truncated, distinctOwners, fallback } =
    await fetchTopHolders(rpc, ca, decimals, holdersN, step);
  let holders = list.map((h) => {
    const known = KNOWN[h.owner];
    return {
      owner: h.owner,
      amount: h.amount,
      pctSupply: supply ? (h.amount / supply) * 100 : 0,
      known: known || null,
      isPool: known?.kind === "lp" || known?.kind === "burn",
    };
  });
  report.holderCount = distinctOwners;
  report.truncated = truncated;
  if (fallback) report.warnings.push("getTokenAccounts unavailable on this RPC — showing top 20 only. Needs a Helius endpoint.");
  if (truncated) report.warnings.push(`Token has many holders — ranked the largest ~15k accounts. Deep tail not counted.`);

  // 2b) Resolve holder identities (CEX / DeFi / market maker / malicious) via Helius.
  step("Identifying known wallets…");
  const idMap = await fetchIdentities(holders.map((h) => h.owner));
  holders = holders.map((h) => {
    const id = idMap[h.owner] || null;
    let known = h.known; // static KNOWN map wins (burn/program/seed)
    let kind = known?.kind || null;
    if (!known && id) {
      const k = categoryKind(id.category);
      known = { label: id.name || id.category, kind: k || "label" };
      kind = k;
    }
    return { ...h, identity: id, known, isPool: kind === "lp" || kind === "burn", malicious: kind === "malicious" };
  });

  // 3) Per-wallet deep read (age + funding) for the top `traceDepth` real holders
  const targets = holders.filter((h) => !h.isPool).slice(0, traceDepth);
  step(`Tracing ${targets.length} wallets (age + funding)…`);
  await pool(targets, 3, async (h) => {
    const sigs = await rpc("getSignaturesForAddress", [h.owner, { limit: 1000 }]);
    if (!sigs?.length) return;
    h.txCount = sigs.length;
    const oldest = sigs[sigs.length - 1];
    h.firstSeen = oldest.blockTime;
    h.ageDays = daysAgo(oldest.blockTime);
    // funding source: parse the oldest tx for a SOL transfer into this wallet
    try {
      const tx = await rpc("getTransaction", [
        oldest.signature,
        { maxSupportedTransactionVersion: 0, encoding: "jsonParsed" },
      ]);
      const ix = tx?.transaction?.message?.instructions || [];
      const transfer = ix.find(
        (x) => x.parsed?.type === "transfer" && x.parsed?.info?.destination === h.owner
      );
      h.funder = transfer?.parsed?.info?.source
        || tx?.transaction?.message?.accountKeys?.[0]?.pubkey
        || tx?.transaction?.message?.accountKeys?.[0];
    } catch { /* leave funder undefined */ }
  });

  // 4) Classify each wallet (in-session, transparent rules; persist via backend)
  const tokenAgeDays = Math.min(...targets.map((t) => t.ageDays ?? Infinity).filter(Number.isFinite));
  holders = holders.map((h) => ({ ...h, tags: classify(h, tokenAgeDays) }));

  // 4b) Persistent wallet intelligence (Supabase). Best-effort — records the
  //     wallets seen and pulls back cross-token history + your manual labels.
  //     If the intel backend is offline, the scan still works fully.
  step("Syncing wallet intelligence…");
  try {
    const realH = holders.filter((h) => !h.isPool);
    const res = await authedFetch(INTEL, {
      op: "sync",
      token: ca,
      wallets: realH.map((h) => ({ address: h.owner, tags: h.tags })),
    });
    if (res.ok) {
      const rows = await res.json();
      const map = {};
      (Array.isArray(rows) ? rows : []).forEach((r) => { map[r.address] = r; });
      holders = holders.map((h) => {
        const r = map[h.owner];
        return r
          ? { ...h, intel: {
              tokensSeen: (r.tokens_seen || []).length,
              manualTags: r.manual_tags || [],
              note: r.note || "",
              flagged: !!r.flagged,
              lastSeen: r.last_seen,
            } }
          : h;
      });
    }
  } catch { /* intel offline — continue */ }

  // 5) Cluster by shared funder (same wallet funded multiple holders = cluster)
  const funderIds = await fetchIdentities(targets.map((t) => t.funder).filter((f) => f && !idMap[f]));
  Object.assign(idMap, funderIds);
  const isCex = (addr) => idMap[addr]?.category === "Centralized Exchange" || (KNOWN[addr] && KNOWN[addr].kind === "cex");
  const byFunder = {};
  targets.forEach((h) => {
    if (!h.funder) return;
    (byFunder[h.funder] = byFunder[h.funder] || []).push(h);
  });
  const clusters = Object.entries(byFunder)
    .filter(([, m]) => m.length > 1)
    .map(([funder, members], i) => {
      const cexLinked = isCex(funder);
      const freshMembers = members.filter((m) => (m.ageDays ?? 999) < 2).length;
      const pctSupply = members.reduce((s, m) => s + (m.pctSupply || 0), 0);
      const kind = cexLinked ? "cex" : (freshMembers / members.length >= 0.5 ? "fresh" : "funded");
      return { id: i, funder, members: members.map((m) => m.owner), count: members.length, freshMembers, pctSupply, cexLinked, kind };
    })
    .sort((a, b) => b.pctSupply - a.pctSupply);
  report.clusters = clusters;

  // 5b) Deployer trace + equal-balance bundle + supply split (cheap)
  step("Tracing deployer…");
  let deployer = null;
  try {
    const d = await findDeployer(rpc, ca);
    if (d?.deployer) {
      const inSet = holders.find((h) => h.owner === d.deployer);
      let dpct = inSet ? inSet.pctSupply : null;
      if (dpct == null) {
        try {
          const r = await rpc("getTokenAccountsByOwner", [d.deployer, { mint: ca }, { encoding: "jsonParsed" }]);
          const bal = (r?.value || []).reduce((s, a) => s + (a.data?.parsed?.info?.tokenAmount?.uiAmount || 0), 0);
          dpct = supply ? (bal / supply) * 100 : 0;
        } catch { dpct = null; }
      }
      deployer = { address: d.deployer, pct: dpct, reachedGenesis: d.reachedGenesis };
    }
  } catch { /* deployer trace failed */ }
  report.deployer = deployer;

  const equalClusters = detectEqualBalanceClusters(holders.filter((h) => !h.isPool));
  report.equalCluster = equalClusters[0] || null;

  const liquidityPct = holders.filter((h) => h.known?.kind === "lp").reduce((s, h) => s + h.pctSupply, 0);
  const burnPct = holders.filter((h) => h.known?.kind === "burn").reduce((s, h) => s + h.pctSupply, 0);
  const walletsPct = holders.filter((h) => !h.isPool).reduce((s, h) => s + h.pctSupply, 0);
  report.split = { liquidityPct, burnPct, walletsPct, tailPct: Math.max(0, 100 - liquidityPct - burnPct - walletsPct) };

  // 6) Aggregate metrics + anomaly flags
  const real = holders.filter((h) => !h.isPool);
  const top10 = real.slice(0, 10).reduce((s, h) => s + h.pctSupply, 0);
  const top1 = real[0]?.pctSupply || 0;
  const freshCount = targets.filter((h) => (h.ageDays ?? 999) < 2).length;
  const cexCount = holders.filter((h) => h.known?.kind === "cex").length;
  const biggestCluster = clusters[0]?.pctSupply || 0;
  const freshClusters = clusters.filter((c) => c.kind === "fresh");
  const freshClusterPct = freshClusters.reduce((s, c) => s + c.pctSupply, 0);
  const freshClusterCount = freshClusters.length;
  const cexClusterPct = clusters.filter((c) => c.kind === "cex").reduce((s, c) => s + c.pctSupply, 0);
  const otherClusterPct = clusters.filter((c) => c.kind === "funded").reduce((s, c) => s + c.pctSupply, 0);
  const flaggedCount = holders.filter((h) => h.intel?.flagged).length;
  const serialCount = holders.filter((h) => !h.isPool && (h.intel?.tokensSeen || 0) >= 4).length;
  const deployerPct = deployer?.pct ?? null;
  const equalCount = report.equalCluster?.count || 0;
  const maliciousCount = holders.filter((h) => h.malicious).length;
  report.holders = holders;
  report.metrics = { top10, top1, freshCount, cexCount, biggestCluster, freshClusterPct, freshClusterCount, cexClusterPct, otherClusterPct, tokenAgeDays, flaggedCount, serialCount, deployerPct, equalCount, maliciousCount };

  // sellability / Token-2022 hazards (read from the mint — free)
  const ex = report.token.ext;
  if (maliciousCount) report.flags.push({ t: `${maliciousCount} holder(s) labeled malicious (scammer / rugger / hacker) by Helius`, sev: "high" });
  if (ex.nonTransferable) report.flags.push({ t: "Non-transferable token — it cannot be sold at all", sev: "high" });
  if (ex.permanentDelegate) report.flags.push({ t: "Permanent delegate set — someone can seize or burn your tokens", sev: "high" });
  if (ex.defaultFrozen) report.flags.push({ t: "Accounts default to FROZEN — classic honeypot setup", sev: "high" });
  if (ex.transferHook) report.flags.push({ t: "Transfer hook present — custom code runs on every transfer, can block sells", sev: "med" });
  if (ex.feeBps > 0) report.flags.push({ t: `Transfer tax ${(ex.feeBps / 100).toFixed(2)}%${ex.feeMutable ? " (authority can raise it)" : ""}`, sev: ex.feeBps >= 1000 ? "high" : "med" });

  if (report.token.mintAuthority) report.flags.push({ t: "Mint authority is LIVE — supply can be inflated", sev: "high" });
  if (report.token.freezeAuthority) report.flags.push({ t: "Freeze authority is LIVE — your wallet can be frozen", sev: "high" });
  if (top1 > 15) report.flags.push({ t: `Top wallet holds ${pct(top1)} of supply`, sev: top1 > 30 ? "high" : "med" });
  if (top10 > 50) report.flags.push({ t: `Top 10 hold ${pct(top10)} — concentrated`, sev: top10 > 70 ? "high" : "med" });
  if (freshClusterPct > 8 || freshClusterCount >= 3) report.flags.push({ t: `${freshClusterCount} fresh-wallet cluster(s) control ${pct(freshClusterPct)} — coordinated distribution`, sev: freshClusterPct > 15 ? "high" : "med" });
  if (otherClusterPct > 12) report.flags.push({ t: `Shared-funder clusters control ${pct(otherClusterPct)}`, sev: "med" });
  if (cexClusterPct > 25) report.flags.push({ t: `CEX-funded wallets hold ${pct(cexClusterPct)} (shown, not penalized unless dominant)`, sev: "med" });
  if (equalCount >= 4) report.flags.push({ t: `${equalCount} wallets hold near-identical balances (possible bundle)`, sev: (report.equalCluster?.pct || 0) > 5 ? "high" : "med" });
  if (deployerPct != null && deployerPct > 5) report.flags.push({ t: `Deployer still holds ${pct(deployerPct)}`, sev: deployerPct > 15 ? "high" : "med" });
  if (deployerPct != null && deployerPct < 0.5) report.flags.push({ t: "Deployer holds ~0% — already exited their position", sev: "med" });
  if (deployer && !deployer.reachedGenesis) report.warnings.push("Deployer is an estimate — long token history, didn't trace fully to genesis.");
  if (freshCount >= 3) report.flags.push({ t: `${freshCount} top holders are <2 days old (sniper/insider pattern)`, sev: "med" });
  const lpBurned = holders.some((h) => h.known?.kind === "burn");
  if (lpBurned) report.flags.push({ t: "LP tokens routed to burn — liquidity likely locked", sev: "good" });
  if (flaggedCount) report.flags.push({ t: `${flaggedCount} holder(s) you've flagged as bad actors`, sev: "high" });
  if (serialCount >= 2) report.flags.push({ t: `${serialCount} wallets recur across 4+ of your past scans`, sev: "med" });

  // ---- backend-only signals (stubbed) ----
  report.bundle = exactBundleDetect();      // heuristic placeholder
  report.pnlAvailable = false;              // deepWalletPnL() needs backend

  // 7) Confidence score (transparent, weighted, 0–100)
  report.score = scoreToken(report);
  step("done");
  return report;
}

/* In-session wallet classifier. Pure rules so you can see WHY a tag applied.
   Persisted/learned version lives in your backend (persistWalletLabel). */
function classify(h, tokenAgeDays) {
  const tags = [];
  if (h.known) tags.push(h.known.label);
  if (h.isPool) return tags.length ? tags : ["Liquidity"];
  if ((h.ageDays ?? 999) < 2) tags.push("Fresh");
  if (Number.isFinite(tokenAgeDays) && (h.ageDays ?? 999) <= tokenAgeDays + 0.02) tags.push("Sniper?");
  if (h.funder && KNOWN[h.funder]?.kind === "cex") tags.push("CEX-funded");
  if (h.pctSupply > 5) tags.push("Whale");
  if ((h.txCount ?? 0) > 800) tags.push("High-activity");
  if (!tags.length) tags.push("Holder");
  return tags;
}

/* Transparent scoring. Each factor adds/subtracts; breakdown shown in UI. */
function scoreToken(r) {
  const m = r.metrics, t = r.token;
  const factors = [];
  let s = 50;
  const add = (label, v) => { s += v; factors.push({ label, v }); };

  add(t.mintAuthority ? "Mint authority live" : "Mint renounced", t.mintAuthority ? -22 : +14);
  add(t.freezeAuthority ? "Freeze authority live" : "Freeze renounced", t.freezeAuthority ? -18 : +8);
  add(`Top-1 holder ${pct(m.top1)}`, m.top1 > 30 ? -20 : m.top1 > 15 ? -10 : +6);
  add(`Top-10 ${pct(m.top10)}`, m.top10 > 70 ? -18 : m.top10 > 50 ? -8 : +6);
  // Fresh-wallet clusters = coordinated distribution → penalize by supply + count
  if (m.freshClusterPct > 0 || m.freshClusterCount > 0)
    add(`Fresh clusters ${pct(m.freshClusterPct)} (${m.freshClusterCount})`, -Math.min(32, Math.round(m.freshClusterPct * 1.6) + 4 * m.freshClusterCount));
  // Other shared-funder clusters (aged, non-CEX): mild, only if sizable
  if (m.otherClusterPct > 8) add(`Shared-funder clusters ${pct(m.otherClusterPct)}`, -Math.min(12, Math.round(m.otherClusterPct / 2)));
  // CEX clusters: shown, only docked if they hold a large share
  if (m.cexClusterPct > 20) add(`CEX clusters ${pct(m.cexClusterPct)}`, m.cexClusterPct > 35 ? -14 : -6);
  add(`${m.freshCount} fresh top holders`, m.freshCount >= 4 ? -12 : m.freshCount >= 2 ? -5 : +3);
  add(r.holders.some((h) => h.known?.kind === "burn") ? "LP burned" : "LP burn not detected",
      r.holders.some((h) => h.known?.kind === "burn") ? +10 : -2);
  if (m.flaggedCount) add(`${m.flaggedCount} flagged wallet(s)`, -Math.min(40, 20 * m.flaggedCount));
  if (m.maliciousCount) add(`${m.maliciousCount} malicious-labeled holder(s)`, -Math.min(45, 25 * m.maliciousCount));
  if (m.serialCount >= 2) add(`${m.serialCount} serial wallets`, -Math.min(20, 6 * m.serialCount));

  const ex = t.ext || {};
  if (ex.feeBps > 0) add(`Transfer tax ${(ex.feeBps / 100).toFixed(1)}%`, -Math.min(20, Math.round(ex.feeBps / 50)));
  if (ex.transferHook) add("Transfer hook", -15);
  if (m.deployerPct != null && m.deployerPct > 5) add(`Deployer holds ${pct(m.deployerPct)}`, -Math.min(25, Math.round(m.deployerPct)));
  if (m.equalCount >= 4) add(`${m.equalCount} equal-balance wallets`, -Math.min(18, m.equalCount));

  s = Math.max(0, Math.min(100, Math.round(s)));

  // Hard floor: tokens that may be impossible to sell / can be seized.
  const fatal = ex.nonTransferable || ex.permanentDelegate || ex.defaultFrozen;
  if (fatal) { s = Math.min(s, 12); factors.push({ label: "Sellability hazard — capped", v: 0 }); }

  const band = fatal ? "Likely unsellable" : s >= 70 ? "Looks organic" : s >= 45 ? "Mixed signals" : "High risk";
  return { value: s, band, factors };
}

/* ---- BACKEND STUBS — wire these to a Netlify fn + Supabase to make real ---- */
function exactBundleDetect() {
  // Real version: pull pool-creation slot, find same-slot buys / Jito bundles.
  return { detected: null, note: "Exact bundle detection needs a backend (same-slot buy scan)." };
}
// async function deepWalletPnL(wallet) { /* cross-token realized PnL via tx history */ }
// async function persistWalletLabel(wallet, label) { /* POST to your DB so it sticks */ }

/* ================================== UI ===================================== */
const SEV = {
  high: { c: "#ff5d5d", b: "rgba(255,93,93,.12)", bd: "rgba(255,93,93,.35)" },
  med:  { c: "#ffb454", b: "rgba(255,180,84,.12)", bd: "rgba(255,180,84,.32)" },
  good: { c: "#7ee787", b: "rgba(126,231,135,.12)", bd: "rgba(126,231,135,.32)" },
};

export default function App() {
  const [holdersN, setHoldersN] = useState(100);
  const [depth, setDepth] = useState(25);
  const [ca, setCa] = useState("");
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState("");
  const [err, setErr] = useState("");
  const [report, setReport] = useState(null);
  const [drawer, setDrawer] = useState(null);
  const [showCfg, setShowCfg] = useState(false);
  const [copied, setCopied] = useState("");
  const [authed, setAuthed] = useState(!!AUTH_TOKEN);

  const run = useCallback(async () => {
    const addr = ca.trim();
    if (!addr) return;
    setLoading(true); setErr(""); setReport(null); setProgress("Starting…");
    try {
      const r = await analyze(addr, RPC_PROXY, holdersN, depth, setProgress);
      setReport(r);
    } catch (e) {
      setErr(e.message || String(e));
    } finally { setLoading(false); }
  }, [ca, holdersN, depth]);

  const copy = (txt) => { navigator.clipboard?.writeText(txt); setCopied(txt); setTimeout(() => setCopied(""), 1200); };

  const updateIntel = useCallback((address, intel) => {
    setReport((r) => r ? { ...r, holders: r.holders.map((x) => x.owner === address ? { ...x, intel } : x) } : r);
    setDrawer((d) => (d && d.owner === address ? { ...d, intel } : d));
  }, []);

  // any 401 from a protected function kicks us back to the gate
  useEffect(() => { onUnauth = () => setAuthed(false); return () => { onUnauth = () => {}; }; }, []);

  if (!authed) return <Landing onAuthed={() => setAuthed(true)} />;

  return (
    <div style={{ minHeight: "100vh", background: "#0a0b0d", color: "#e7e3d8", fontFamily: "'IBM Plex Mono', ui-monospace, monospace" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Archivo:wght@600;800&family=IBM+Plex+Mono:wght@400;500;600&display=swap');
        *{box-sizing:border-box}
        .display{font-family:'Archivo',sans-serif;letter-spacing:-.02em}
        .grid-bg{background-image:linear-gradient(rgba(255,255,255,.025) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.025) 1px,transparent 1px);background-size:34px 34px}
        .glow{box-shadow:0 0 0 1px rgba(212,255,71,.18),0 0 40px -12px rgba(212,255,71,.5)}
        .scan{animation:scan 1.1s linear infinite}
        @keyframes scan{0%{transform:translateY(-100%)}100%{transform:translateY(2200%)}}
        .rise{animation:rise .5s cubic-bezier(.2,.7,.2,1) both}
        @keyframes rise{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
        .bar{transition:width .8s cubic-bezier(.2,.7,.2,1)}
        button{font-family:inherit;cursor:pointer}
        input{font-family:inherit}
        ::selection{background:#d4ff47;color:#0a0b0d}
        .node:hover circle{stroke:#d4ff47;stroke-width:2px}
      `}</style>

      {/* top bar */}
      <div style={{ position: "sticky", top: 0, zIndex: 20, borderBottom: "1px solid #1b1d22", background: "rgba(10,11,13,.85)", backdropFilter: "blur(10px)" }}>
        <div style={{ maxWidth: 1100, margin: "0 auto", padding: "14px 20px", display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{ width: 30, height: 30, borderRadius: 7, background: "#d4ff47", display: "grid", placeItems: "center", color: "#0a0b0d" }}>
            <Crosshair size={18} strokeWidth={2.5} />
          </div>
          <div className="display" style={{ fontSize: 19, fontWeight: 800 }}>SOLSCOPE<span style={{ color: "#d4ff47" }}>.</span></div>
          <span style={{ fontSize: 11, color: "#6b6f78", letterSpacing: ".08em" }}>CHAIN-NATIVE TOKEN FORENSICS</span>
          <div style={{ flex: 1 }} />
          <button onClick={() => setShowCfg((v) => !v)} style={{ display: "flex", alignItems: "center", gap: 6, background: "transparent", color: "#9aa0ab", border: "1px solid #2a2d34", borderRadius: 8, padding: "7px 11px", fontSize: 12 }}>
            <Cog size={14} /> Settings
          </button>
          <button onClick={() => { setAuth(""); setAuthed(false); }} title="Lock" style={{ display: "flex", alignItems: "center", background: "transparent", color: "#9aa0ab", border: "1px solid #2a2d34", borderRadius: 8, padding: "7px 9px" }}>
            <Lock size={14} />
          </button>
        </div>
        {showCfg && (
          <div style={{ borderTop: "1px solid #1b1d22", background: "#0d0f12" }}>
            <div style={{ maxWidth: 1100, margin: "0 auto", padding: "14px 20px", display: "flex", gap: 14, flexWrap: "wrap", alignItems: "center" }}>
              <label style={{ fontSize: 11, color: "#6b6f78" }}>HOLDERS (list size)</label>
              <input type="number" min={20} max={200} value={holdersN} onChange={(e) => setHoldersN(Math.max(20, Math.min(200, +e.target.value || 100)))}
                style={{ width: 76, background: "#0a0b0d", border: "1px solid #2a2d34", color: "#e7e3d8", borderRadius: 8, padding: "9px 12px", fontSize: 12 }} />
              <label style={{ fontSize: 11, color: "#6b6f78" }}>TRACE (deep age+funding)</label>
              <input type="number" min={5} max={50} value={depth} onChange={(e) => setDepth(Math.max(5, Math.min(50, +e.target.value || 25)))}
                style={{ width: 76, background: "#0a0b0d", border: "1px solid #2a2d34", color: "#e7e3d8", borderRadius: 8, padding: "9px 12px", fontSize: 12 }} />
              <span style={{ fontSize: 11, color: "#4a4d54" }}>Higher TRACE = deeper clustering but more Helius credits/scan.</span>
            </div>
          </div>
        )}
      </div>

      {/* hero / search */}
      <div className="grid-bg">
        <div style={{ maxWidth: 1100, margin: "0 auto", padding: "56px 20px 30px", textAlign: "center" }}>
          <div className="display" style={{ fontSize: 40, fontWeight: 800, lineHeight: 1.05 }}>
            Drop a contract.<br /><span style={{ color: "#d4ff47" }}>See who's really holding.</span>
          </div>
          <p style={{ color: "#8a8f99", fontSize: 13, maxWidth: 520, margin: "16px auto 30px" }}>
            Reads the chain directly — clusters, snipers, insiders, concentration — and scores how organic it looks. No third-party verdicts.
          </p>
          <div style={{ display: "flex", gap: 10, maxWidth: 680, margin: "0 auto" }} className={loading ? "" : "glow"}>
            <div style={{ flex: 1, position: "relative", display: "flex", alignItems: "center", background: "#101216", border: "1px solid #2a2d34", borderRadius: 12, padding: "0 14px" }}>
              <Search size={18} color="#6b6f78" />
              <input
                value={ca} onChange={(e) => setCa(e.target.value)} spellCheck={false}
                onKeyDown={(e) => e.key === "Enter" && run()}
                placeholder="Paste Solana token contract address (CA)…"
                style={{ flex: 1, background: "transparent", border: "none", outline: "none", color: "#e7e3d8", padding: "16px 12px", fontSize: 14 }}
              />
            </div>
            <button onClick={run} disabled={loading}
              style={{ background: loading ? "#2a2d34" : "#d4ff47", color: "#0a0b0d", border: "none", borderRadius: 12, padding: "0 24px", fontWeight: 600, fontSize: 14, display: "flex", alignItems: "center", gap: 8 }}>
              {loading ? <Loader2 size={18} className="scan" style={{ animation: "spin 1s linear infinite" }} /> : <Activity size={18} />}
              {loading ? "Scanning" : "Analyze"}
            </button>
          </div>
          {loading && <div style={{ marginTop: 16, fontSize: 12, color: "#d4ff47" }}>{progress}</div>}
          {err && <div style={{ marginTop: 16, fontSize: 12, color: "#ff5d5d" }}>⚠ {err}</div>}
        </div>
      </div>

      {report && <Report r={report} onWallet={setDrawer} copy={copy} copied={copied} />}
      {!report && !loading && <Empty />}
      {drawer && <Drawer h={drawer} onClose={() => setDrawer(null)} copy={copy} copied={copied} onUpdate={updateIntel} />}

      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  );
}

function Landing({ onAuthed }) {
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const submit = async () => {
    if (!pw.trim() || busy) return;
    setBusy(true); setErr("");
    const ok = await login(pw.trim());
    setBusy(false);
    if (ok) onAuthed(); else setErr("Incorrect password.");
  };
  return (
    <div style={{ minHeight: "100vh", background: "#0a0b0d", color: "#e7e3d8", fontFamily: "'IBM Plex Mono', ui-monospace, monospace", display: "flex", alignItems: "center", justifyContent: "center", padding: 20, position: "relative", overflow: "hidden" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Archivo:wght@600;800&family=IBM+Plex+Mono:wght@400;500;600&display=swap');
        *{box-sizing:border-box} .display{font-family:'Archivo',sans-serif;letter-spacing:-.02em}
        ::selection{background:#d4ff47;color:#0a0b0d} @keyframes spin{to{transform:rotate(360deg)}}
        @keyframes rise{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
      `}</style>
      <div style={{ position: "absolute", inset: 0, opacity: .6, backgroundImage: "linear-gradient(rgba(255,255,255,.025) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.025) 1px,transparent 1px)", backgroundSize: "34px 34px" }} />
      <div style={{ position: "absolute", top: "-20%", left: "50%", transform: "translateX(-50%)", width: 480, height: 480, background: "radial-gradient(circle, rgba(212,255,71,.10), transparent 60%)" }} />
      <div style={{ position: "relative", width: "min(380px,100%)", textAlign: "center", animation: "rise .5s cubic-bezier(.2,.7,.2,1) both" }}>
        <div style={{ width: 48, height: 48, borderRadius: 12, background: "#d4ff47", display: "grid", placeItems: "center", color: "#0a0b0d", margin: "0 auto 18px" }}>
          <Crosshair size={27} strokeWidth={2.5} />
        </div>
        <div className="display" style={{ fontSize: 30, fontWeight: 800 }}>SOLSCOPE<span style={{ color: "#d4ff47" }}>.</span></div>
        <div style={{ fontSize: 11, color: "#6b6f78", letterSpacing: ".12em", marginTop: 7 }}>CHAIN-NATIVE TOKEN FORENSICS</div>
        <div style={{ fontSize: 12, color: "#8a8f99", marginTop: 18, lineHeight: 1.5 }}>This instance is private. Enter the password to continue.</div>
        <div style={{ marginTop: 22, display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, background: "#101216", border: `1px solid ${err ? "#ff5d5d" : "#2a2d34"}`, borderRadius: 12, padding: "0 14px" }}>
            <Lock size={16} color="#6b6f78" />
            <input type="password" value={pw} autoFocus onChange={(e) => { setPw(e.target.value); setErr(""); }} onKeyDown={(e) => e.key === "Enter" && submit()}
              placeholder="Password" style={{ flex: 1, background: "transparent", border: "none", outline: "none", color: "#e7e3d8", padding: "15px 8px", fontSize: 14, fontFamily: "inherit" }} />
          </div>
          <button onClick={submit} disabled={busy}
            style={{ background: busy ? "#2a2d34" : "#d4ff47", color: "#0a0b0d", border: "none", borderRadius: 12, padding: "14px", fontWeight: 600, fontSize: 14, display: "flex", alignItems: "center", justifyContent: "center", gap: 8, cursor: "pointer", fontFamily: "inherit" }}>
            {busy ? <Loader2 size={17} style={{ animation: "spin 1s linear infinite" }} /> : <ShieldCheck size={17} />} {busy ? "Checking" : "Enter"}
          </button>
          {err && <div style={{ fontSize: 12, color: "#ff5d5d" }}>{err}</div>}
        </div>
      </div>
    </div>
  );
}

function Empty() {
  return (
    <div style={{ maxWidth: 1100, margin: "0 auto", padding: "10px 20px 80px", display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))", gap: 14 }}>
      {[
        [Boxes, "Cluster map", "Wallets sharing a funder get grouped — same-source supply is the bundle/insider tell."],
        [Crosshair, "Snipers & fresh", "Top holders younger than the token itself get flagged."],
        [Building2, "CEX mapping", "Known exchange & program wallets labeled and separated from real holders."],
        [Gauge, "Confidence score", "Every factor shown — no black box. You see exactly why."],
      ].map(([I, t, d], i) => (
        <div key={i} className="rise" style={{ animationDelay: `${i * 60}ms`, background: "#0e1014", border: "1px solid #1b1d22", borderRadius: 12, padding: 18 }}>
          <I size={20} color="#d4ff47" />
          <div className="display" style={{ marginTop: 12, fontSize: 15, fontWeight: 600 }}>{t}</div>
          <div style={{ marginTop: 6, fontSize: 12, color: "#8a8f99", lineHeight: 1.5 }}>{d}</div>
        </div>
      ))}
    </div>
  );
}

function Report({ r, onWallet, copy, copied }) {
  const s = r.score;
  const col = s.value >= 70 ? "#7ee787" : s.value >= 45 ? "#ffb454" : "#ff5d5d";
  return (
    <div style={{ maxWidth: 1100, margin: "0 auto", padding: "10px 20px 90px" }}>
      {/* header row */}
      <div className="rise" style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 14, marginBottom: 14 }}>
        {/* token id card */}
        <div style={{ background: "#0e1014", border: "1px solid #1b1d22", borderRadius: 14, padding: 20 }}>
          <div style={{ fontSize: 11, color: "#6b6f78", letterSpacing: ".1em" }}>CONTRACT</div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}>
            <span style={{ fontSize: 14 }}>{short(r.ca)}</span>
            <button onClick={() => copy(r.ca)} style={{ background: "transparent", border: "none", color: "#6b6f78", padding: 4 }}>
              {copied === r.ca ? <Check size={14} color="#7ee787" /> : <Copy size={14} />}
            </button>
          </div>
          <div style={{ display: "flex", gap: 22, marginTop: 18, flexWrap: "wrap" }}>
            <Stat label="SUPPLY" value={Intl.NumberFormat("en", { notation: "compact" }).format(r.token.supply)} />
            <Stat label="TOP-1" value={pct(r.metrics.top1)} />
            <Stat label="TOP-10" value={pct(r.metrics.top10)} />
            <Stat label="FRESH" value={r.metrics.freshCount} />
            <Stat label="HOLDERS" value={Intl.NumberFormat("en", { notation: "compact" }).format(r.holderCount || r.holders.length) + (r.truncated ? "+" : "")} />
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 18, flexWrap: "wrap" }}>
            <Authority ok={!r.token.mintAuthority} on={<><Unlock size={13} /> Mint live</>} off={<><Lock size={13} /> Mint renounced</>} />
            <Authority ok={!r.token.freezeAuthority} on={<><Snowflake size={13} /> Freeze live</>} off={<><ShieldCheck size={13} /> Freeze renounced</>} />
            {r.token.program === "token-2022" && (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11, color: "#a78bfa", background: "rgba(167,139,250,.1)", border: "1px solid rgba(167,139,250,.3)", borderRadius: 7, padding: "5px 9px" }}>Token-2022</span>
            )}
            {r.token.ext?.feeBps > 0 && (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11, color: "#ffb454", background: "rgba(255,180,84,.1)", border: "1px solid rgba(255,180,84,.3)", borderRadius: 7, padding: "5px 9px" }}>{(r.token.ext.feeBps / 100).toFixed(1)}% tax</span>
            )}
            {r.holders.some((h) => h.known?.kind === "burn") && (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11, color: "#7ee787", background: "rgba(126,231,135,.1)", border: "1px solid rgba(126,231,135,.3)", borderRadius: 7, padding: "5px 9px" }}><Flame size={13} /> LP burned</span>
            )}
          </div>

          {/* supply split */}
          {r.split && (
            <div style={{ marginTop: 18 }}>
              <div style={{ display: "flex", height: 8, borderRadius: 99, overflow: "hidden", background: "#16181d" }}>
                {r.split.liquidityPct > 0 && <div style={{ width: `${r.split.liquidityPct}%`, background: "#5b8def" }} title="liquidity" />}
                {r.split.burnPct > 0 && <div style={{ width: `${r.split.burnPct}%`, background: "#7ee787" }} title="burned" />}
                <div style={{ width: `${r.split.walletsPct}%`, background: "#d4ff47" }} title="wallets" />
                <div style={{ flex: 1, background: "#2a2d34" }} title="untracked tail" />
              </div>
              <div style={{ display: "flex", gap: 14, marginTop: 8, flexWrap: "wrap", fontSize: 10, color: "#8a8f99" }}>
                <Legend c="#5b8def" t={`Liquidity ${pct(r.split.liquidityPct)}`} />
                <Legend c="#7ee787" t={`Burned ${pct(r.split.burnPct)}`} />
                <Legend c="#d4ff47" t={`Top wallets ${pct(r.split.walletsPct)}`} />
                <Legend c="#2a2d34" t={`Tail ${pct(r.split.tailPct)}`} />
              </div>
              <div style={{ fontSize: 9, color: "#4a4d54", marginTop: 4 }}>Liquidity reflects pools identified via the entity map.</div>
            </div>
          )}

          {/* deployer */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 16, fontSize: 12, color: "#8a8f99" }}>
            <Boxes size={13} color="#6b6f78" />
            <span>Deployer</span>
            {r.deployer ? (
              <>
                <span style={{ color: "#e7e3d8" }}>{short(r.deployer.address)}</span>
                <span style={{ color: r.deployer.pct == null ? "#6b6f78" : r.deployer.pct > 5 ? "#ff5d5d" : r.deployer.pct < 0.5 ? "#ffb454" : "#7ee787" }}>
                  {r.deployer.pct == null ? "· holding unknown" : `· holds ${pct(r.deployer.pct)}`}
                </span>
              </>
            ) : <span style={{ color: "#6b6f78" }}>· not traced</span>}
          </div>
        </div>
        {/* confidence gauge */}
        <div style={{ background: "#0e1014", border: "1px solid #1b1d22", borderRadius: 14, padding: 20, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
          <Gauge size={16} color="#6b6f78" />
          <div className="display" style={{ fontSize: 56, fontWeight: 800, color: col, lineHeight: 1, marginTop: 8 }}>{s.value}</div>
          <div style={{ fontSize: 12, color: col, marginTop: 4 }}>{s.band}</div>
          <div style={{ width: "100%", height: 6, background: "#1b1d22", borderRadius: 99, marginTop: 14, overflow: "hidden" }}>
            <div className="bar" style={{ width: `${s.value}%`, height: "100%", background: col }} />
          </div>
          <div style={{ fontSize: 10, color: "#6b6f78", marginTop: 8 }}>confidence it's organic</div>
        </div>
      </div>

      {/* flags */}
      {r.flags.length > 0 && (
        <div className="rise" style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 14 }}>
          {r.flags.map((f, i) => {
            const sv = SEV[f.sev] || SEV.med;
            return (
              <span key={i} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: sv.c, background: sv.b, border: `1px solid ${sv.bd}`, borderRadius: 8, padding: "8px 11px" }}>
                {f.sev === "good" ? <ShieldCheck size={14} /> : <AlertTriangle size={14} />} {f.t}
              </span>
            );
          })}
        </div>
      )}

      {r.warnings?.length > 0 && (
        <div style={{ marginBottom: 14, fontSize: 11, color: "#6b6f78", lineHeight: 1.6 }}>
          {r.warnings.map((w, i) => <div key={i}>· {w}</div>)}
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, alignItems: "start" }}>
        {/* cluster graph */}
        <div className="rise" style={{ background: "#0e1014", border: "1px solid #1b1d22", borderRadius: 14, padding: 18 }}>
          <Head icon={Boxes} title="Wallet clusters" sub="grouped by shared funder" />
          <ClusterGraph r={r} onWallet={onWallet} />
          {r.clusters.length === 0 && <div style={{ fontSize: 12, color: "#6b6f78", marginTop: 10 }}>No shared-funder clusters in the analyzed set — holders funded independently (a good sign).</div>}
          {r.clusters.slice(0, 6).map((c) => {
            const ck = c.kind === "cex" ? { c: "#5b8def", t: "CEX" } : c.kind === "fresh" ? { c: "#ff5d5d", t: "FRESH" } : { c: "#ffb454", t: "funded" };
            return (
              <div key={c.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12, color: "#9aa0ab", marginTop: 8, borderTop: "1px solid #1b1d22", paddingTop: 8 }}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                  <span style={{ fontSize: 9, color: ck.c, border: `1px solid ${ck.c}44`, background: `${ck.c}14`, borderRadius: 5, padding: "1px 5px" }}>{ck.t}</span>
                  via {short(c.funder)}
                </span>
                <span style={{ color: ck.c }}>{c.count} wallets · {pct(c.pctSupply)}</span>
              </div>
            );
          })}
        </div>

        {/* score breakdown */}
        <div className="rise" style={{ background: "#0e1014", border: "1px solid #1b1d22", borderRadius: 14, padding: 18 }}>
          <Head icon={Gauge} title="Why this score" sub="every factor, nothing hidden" />
          {s.factors.map((f, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 0", borderBottom: i < s.factors.length - 1 ? "1px solid #16181d" : "none" }}>
              <span style={{ flex: 1, fontSize: 12, color: "#c5c8cf" }}>{f.label}</span>
              <span style={{ fontSize: 12, fontWeight: 600, color: f.v >= 0 ? "#7ee787" : "#ff5d5d" }}>{f.v >= 0 ? "+" : ""}{f.v}</span>
            </div>
          ))}
          <div style={{ marginTop: 12, padding: 10, background: "#0a0b0d", borderRadius: 8, fontSize: 11, color: "#6b6f78", lineHeight: 1.5 }}>
            <Sparkles size={12} style={{ verticalAlign: "-2px" }} /> Deep PnL & exact bundle detection unlock once you wire the backend stubs.
          </div>
        </div>
      </div>

      {/* holders table */}
      <div className="rise" style={{ background: "#0e1014", border: "1px solid #1b1d22", borderRadius: 14, padding: 18, marginTop: 14 }}>
        <Head icon={Users} title="Top holders" sub="tap a row for detail" />
        <div style={{ marginTop: 6 }}>
          {r.holders.map((h, i) => (
            <button key={i} onClick={() => onWallet(h)}
              style={{ width: "100%", display: "flex", alignItems: "center", gap: 12, background: "transparent", border: "none", borderBottom: i < r.holders.length - 1 ? "1px solid #16181d" : "none", padding: "11px 4px", textAlign: "left", color: "#e7e3d8" }}>
              <span style={{ width: 22, fontSize: 11, color: "#6b6f78" }}>{i + 1}</span>
              <span style={{ width: 92, fontSize: 12 }}>{short(h.owner)}</span>
              <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 8 }}>
                <div style={{ flex: 1, height: 5, background: "#1b1d22", borderRadius: 99, overflow: "hidden", maxWidth: 160 }}>
                  <div className="bar" style={{ width: `${Math.min(100, h.pctSupply * 2)}%`, height: "100%", background: h.isPool ? "#5b8def" : h.pctSupply > 15 ? "#ff5d5d" : "#d4ff47" }} />
                </div>
                <span style={{ fontSize: 12, width: 52 }}>{pct(h.pctSupply)}</span>
              </div>
              <div style={{ display: "flex", gap: 5, flexWrap: "wrap", justifyContent: "flex-end", width: 200, alignItems: "center" }}>
                {h.malicious && <Tag t="MALICIOUS" />}
                {h.identity?.name && !h.malicious && (
                  <span style={{ fontSize: 10, color: "#5b8def", border: "1px solid #5b8def44", background: "#5b8def14", borderRadius: 6, padding: "2px 7px", whiteSpace: "nowrap", maxWidth: 110, overflow: "hidden", textOverflow: "ellipsis" }}>{h.identity.name}</span>
                )}
                {h.intel?.flagged && <Tag t="FLAGGED" />}
                {(h.intel?.tokensSeen || 0) > 1 && (
                  <span style={{ fontSize: 10, color: "#a78bfa", border: "1px solid #a78bfa40", background: "#a78bfa14", borderRadius: 6, padding: "2px 7px", whiteSpace: "nowrap" }}>seen {h.intel.tokensSeen}×</span>
                )}
                {(h.intel?.manualTags || []).slice(0, 1).map((t, j) => <Tag key={"m" + j} t={t} />)}
                {!h.identity?.name && (h.tags || []).slice(0, 2).map((t, j) => <Tag key={j} t={t} />)}
              </div>
              <ChevronRight size={15} color="#3a3d44" />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function ClusterGraph({ r, onWallet }) {
  const ref = useRef(null);
  const nodes = useMemo(() => {
    const real = r.holders.filter((h) => !h.isPool && h.ageDays != null).slice(0, 40);
    return real.map((h) => ({ id: h.owner, r: 6 + Math.sqrt(h.pctSupply) * 4, h, group: h.funder || h.owner }));
  }, [r]);
  const links = useMemo(() => {
    const out = [];
    const byG = {};
    nodes.forEach((n) => { (byG[n.group] = byG[n.group] || []).push(n); });
    Object.values(byG).forEach((g) => { for (let i = 1; i < g.length; i++) out.push({ source: g[0].id, target: g[i].id }); });
    return out;
  }, [nodes]);

  useEffect(() => {
    const W = ref.current?.clientWidth || 420, H = 300;
    const sim = d3.forceSimulation(nodes)
      .force("charge", d3.forceManyBody().strength(-90))
      .force("center", d3.forceCenter(W / 2, H / 2))
      .force("collide", d3.forceCollide().radius((d) => d.r + 4))
      .force("link", d3.forceLink(links).id((d) => d.id).distance(40).strength(.6))
      .stop();
    for (let i = 0; i < 280; i++) sim.tick();
    nodes.forEach((n) => { n.x = Math.max(n.r, Math.min(W - n.r, n.x)); n.y = Math.max(n.r, Math.min(H - n.r, n.y)); });
    setTick((t) => t + 1);
  }, [nodes, links]);
  const [, setTick] = useState(0);

  const color = (h) => h.known?.kind === "cex" ? "#5b8def" : (h.ageDays ?? 999) < 2 ? "#ffb454" : h.pctSupply > 15 ? "#ff5d5d" : "#d4ff47";

  return (
    <svg ref={ref} width="100%" height="300" style={{ display: "block", marginTop: 8 }}>
      {links.map((l, i) => (
        <line key={i} x1={l.source.x} y1={l.source.y} x2={l.target.x} y2={l.target.y} stroke="#2a2d34" strokeWidth="1" />
      ))}
      {nodes.map((n, i) => (
        <g key={i} className="node" style={{ cursor: "pointer" }} onClick={() => onWallet(n.h)} transform={`translate(${n.x || 0},${n.y || 0})`}>
          <circle r={n.r} fill={color(n.h)} fillOpacity="0.85" stroke="#0e1014" strokeWidth="1.5" />
        </g>
      ))}
    </svg>
  );
}

function Drawer({ h, onClose, copy, copied, onUpdate }) {
  const [intel, setIntel] = useState(h.intel || { manualTags: [], note: "", flagged: false, tokensSeen: 0 });
  const [tagInput, setTagInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [pnl, setPnl] = useState(PNL_CACHE[h.owner] || null);
  const [pnlBusy, setPnlBusy] = useState(false);

  const computePnl = async () => {
    setPnlBusy(true);
    try {
      const res = await authedFetch(PNL, { address: h.owner });
      if (res.ok) { const data = await res.json(); PNL_CACHE[h.owner] = data; setPnl(data); }
      else setPnl({ error: true });
    } catch { setPnl({ error: true }); }
    setPnlBusy(false);
  };

  const persist = async (next) => {
    const merged = { ...intel, ...next };
    setIntel(merged); setSaving(true);
    try {
      const res = await authedFetch(INTEL, { op: "label", address: h.owner, manual_tags: merged.manualTags, note: merged.note, flagged: merged.flagged });
      if (res.ok) onUpdate && onUpdate(h.owner, merged);
    } catch { /* offline */ }
    setSaving(false);
  };
  const addTag = () => { const t = tagInput.trim(); if (!t) return; persist({ manualTags: [...new Set([...(intel.manualTags || []), t])] }); setTagInput(""); };
  const removeTag = (t) => persist({ manualTags: (intel.manualTags || []).filter((x) => x !== t) });

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 40, background: "rgba(0,0,0,.5)", display: "flex", justifyContent: "flex-end" }}>
      <div onClick={(e) => e.stopPropagation()} className="rise"
        style={{ width: "min(420px,100%)", background: "#0e1014", borderLeft: "1px solid #1b1d22", padding: 22, overflowY: "auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ display: "flex", alignItems: "center", gap: 8 }}><Wallet size={18} color="#d4ff47" /><span className="display" style={{ fontWeight: 600 }}>Wallet</span></span>
          <button onClick={onClose} style={{ background: "transparent", border: "none", color: "#6b6f78" }}><X size={18} /></button>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 16, fontSize: 13, wordBreak: "break-all" }}>
          {h.owner}
          <button onClick={() => copy(h.owner)} style={{ background: "transparent", border: "none", color: "#6b6f78" }}>{copied === h.owner ? <Check size={14} color="#7ee787" /> : <Copy size={14} />}</button>
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 14 }}>{(h.tags || []).map((t, i) => <Tag key={i} t={t} big />)}</div>

        <div style={{ marginTop: 20, display: "grid", gap: 1, background: "#1b1d22", border: "1px solid #1b1d22", borderRadius: 10, overflow: "hidden" }}>
          {h.identity?.name && <Row k="Identity" v={`${h.identity.name}${h.identity.category ? " · " + h.identity.category : ""}`} />}
          <Row k="Supply held" v={pct(h.pctSupply)} />
          <Row k="Balance" v={Intl.NumberFormat("en", { notation: "compact" }).format(h.amount)} />
          <Row k="Wallet age" v={h.ageDays != null ? `${h.ageDays.toFixed(1)} d` : "—"} />
          <Row k="Tx count" v={h.txCount ?? "—"} />
          <Row k="Funded by" v={h.funder ? short(h.funder) : "—"} />
          <Row k="Seen in your scans" v={(intel.tokensSeen || 0) + " token(s)"} />
          <Row k="Net SOL (recent swaps)" v={pnl && typeof pnl.netSol === "number" ? (pnl.netSol >= 0 ? "+" : "") + pnl.netSol.toFixed(2) + " ◎" : "tap below"} muted={!pnl || typeof pnl.netSol !== "number"} />
        </div>

        {/* deep PnL — on demand, costs Helius credits */}
        <div style={{ marginTop: 18, padding: 14, background: "#0a0b0d", border: "1px solid #1b1d22", borderRadius: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Activity size={14} color="#d4ff47" />
            <span className="display" style={{ fontWeight: 600, fontSize: 13 }}>Trader PnL</span>
            <span style={{ fontSize: 10, color: "#6b6f78", marginLeft: "auto" }}>recent swaps · SOL</span>
          </div>

          {!pnl && (
            <button onClick={computePnl} disabled={pnlBusy}
              style={{ marginTop: 12, width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 7, padding: "10px", borderRadius: 8, fontSize: 12, fontWeight: 600, border: "1px solid #2a2d34", background: "transparent", color: pnlBusy ? "#6b6f78" : "#d4ff47" }}>
              {pnlBusy ? <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} /> : <Activity size={14} />} {pnlBusy ? "Reading swap history…" : "Compute recent PnL (uses credits)"}
            </button>
          )}

          {pnl?.error && <div style={{ marginTop: 12, fontSize: 12, color: "#ff5d5d" }}>Couldn't read swap history for this wallet.</div>}

          {pnl && typeof pnl.netSol === "number" && (
            <div style={{ marginTop: 12 }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                <span className="display" style={{ fontSize: 30, fontWeight: 800, color: pnl.netSol > 0 ? "#7ee787" : pnl.netSol < 0 ? "#ff5d5d" : "#9aa0ab" }}>
                  {pnl.netSol >= 0 ? "+" : ""}{pnl.netSol.toFixed(2)} ◎
                </span>
                <span style={{ fontSize: 11, color: "#6b6f78" }}>{pnl.swaps} swaps · {pnl.tokensTraded} tokens{pnl.capped ? " · sampled" : ""}</span>
              </div>
              <div style={{ marginTop: 8, fontSize: 11, color: "#6b6f78", lineHeight: 1.5 }}>
                Net SOL across recent swap txs (fees included). Positive = extracted profit. Negative can just mean open positions — not necessarily losing.
              </div>
              {pnl.netSol > 1 && pnl.swaps >= 10 && !(intel.manualTags || []).includes("good trader") && (
                <button onClick={() => persist({ manualTags: [...new Set([...(intel.manualTags || []), "good trader"])] })}
                  style={{ marginTop: 10, width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 7, padding: "9px", borderRadius: 8, fontSize: 12, fontWeight: 600, border: "1px solid rgba(126,231,135,.4)", background: "rgba(126,231,135,.12)", color: "#7ee787" }}>
                  <ShieldCheck size={14} /> Tag as good trader
                </button>
              )}
            </div>
          )}
        </div>

        {/* learned intelligence — persists across every future scan */}
        <div style={{ marginTop: 18, padding: 14, background: "#0a0b0d", border: "1px solid #1b1d22", borderRadius: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Sparkles size={14} color="#d4ff47" />
            <span className="display" style={{ fontWeight: 600, fontSize: 13 }}>Your intel</span>
            {saving && <Loader2 size={13} className="scan" style={{ animation: "spin 1s linear infinite", marginLeft: "auto", color: "#6b6f78" }} />}
          </div>

          <button onClick={() => persist({ flagged: !intel.flagged })}
            style={{ marginTop: 12, width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 7, padding: "9px", borderRadius: 8, fontSize: 12, fontWeight: 600,
              border: `1px solid ${intel.flagged ? "#ff5d5d" : "#2a2d34"}`, background: intel.flagged ? "rgba(255,93,93,.14)" : "transparent", color: intel.flagged ? "#ff5d5d" : "#9aa0ab" }}>
            <ShieldAlert size={14} /> {intel.flagged ? "Flagged as bad actor" : "Flag as bad actor"}
          </button>

          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 12 }}>
            {(intel.manualTags || []).map((t, i) => (
              <span key={i} onClick={() => removeTag(t)} style={{ cursor: "pointer", fontSize: 11, color: "#d4ff47", border: "1px solid #d4ff4740", background: "#d4ff4714", borderRadius: 6, padding: "4px 8px", display: "inline-flex", alignItems: "center", gap: 5 }}>
                {t} <X size={11} />
              </span>
            ))}
          </div>
          <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
            <input value={tagInput} onChange={(e) => setTagInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addTag()}
              placeholder="add a label (e.g. insider, good trader)…"
              style={{ flex: 1, background: "#0e1014", border: "1px solid #2a2d34", color: "#e7e3d8", borderRadius: 8, padding: "9px 11px", fontSize: 12, outline: "none" }} />
            <button onClick={addTag} style={{ background: "#d4ff47", color: "#0a0b0d", border: "none", borderRadius: 8, padding: "0 14px", fontWeight: 600, fontSize: 12 }}>Add</button>
          </div>
          <textarea value={intel.note || ""} onChange={(e) => setIntel({ ...intel, note: e.target.value })} onBlur={() => persist({})}
            placeholder="note (saved on blur)…" rows={2}
            style={{ marginTop: 10, width: "100%", resize: "vertical", background: "#0e1014", border: "1px solid #2a2d34", color: "#e7e3d8", borderRadius: 8, padding: "9px 11px", fontSize: 12, outline: "none" }} />
          <div style={{ marginTop: 8, fontSize: 10, color: "#4a4d54" }}>Tags & flags resurface on this wallet in every future scan, on any token.</div>
        </div>
      </div>
    </div>
  );
}

/* small bits */
const Stat = ({ label, value }) => (
  <div><div style={{ fontSize: 10, color: "#6b6f78", letterSpacing: ".1em" }}>{label}</div><div style={{ fontSize: 17, marginTop: 3 }}>{value}</div></div>
);
const Legend = ({ c, t }) => (
  <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}><span style={{ width: 8, height: 8, borderRadius: 2, background: c }} />{t}</span>
);
const Head = ({ icon: I, title, sub }) => (
  <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
    <I size={16} color="#d4ff47" />
    <span className="display" style={{ fontWeight: 600, fontSize: 14 }}>{title}</span>
    <span style={{ fontSize: 11, color: "#6b6f78" }}>· {sub}</span>
  </div>
);
const Row = ({ k, v, muted }) => (
  <div style={{ display: "flex", justifyContent: "space-between", padding: "11px 13px", background: "#0e1014" }}>
    <span style={{ fontSize: 12, color: "#8a8f99" }}>{k}</span>
    <span style={{ fontSize: 12, color: muted ? "#6b6f78" : "#e7e3d8", fontStyle: muted ? "italic" : "normal" }}>{v}</span>
  </div>
);
const Authority = ({ ok, on, off }) => (
  <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11, color: ok ? "#7ee787" : "#ff5d5d", background: ok ? "rgba(126,231,135,.1)" : "rgba(255,93,93,.1)", border: `1px solid ${ok ? "rgba(126,231,135,.3)" : "rgba(255,93,93,.3)"}`, borderRadius: 7, padding: "5px 9px" }}>
    {ok ? off : on}
  </span>
);
function Tag({ t, big }) {
  const map = { "MALICIOUS": "#ff3b3b", "FLAGGED": "#ff5d5d", "Fresh": "#ffb454", "Sniper?": "#ff5d5d", "Whale": "#ff8fb1", "CEX-funded": "#5b8def", "High-activity": "#a78bfa" };
  const c = map[t] || (t.includes("verify") || t.includes("Binance") || t.includes("Coinbase") ? "#5b8def" : "#8a8f99");
  return <span style={{ fontSize: big ? 12 : 10, color: c, border: `1px solid ${c}40`, background: `${c}14`, borderRadius: 6, padding: big ? "5px 9px" : "2px 7px", whiteSpace: "nowrap" }}>{t}</span>;
}
