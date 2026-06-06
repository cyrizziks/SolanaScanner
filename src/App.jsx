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

/* ---- tiny concurrency-limited RPC client (browser side, runs in YOUR app) -- */
function makeRpc(endpoint) {
  let id = 0;
  return async function rpc(method, params) {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
    });
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
async function analyze(ca, endpoint, depth, onProgress) {
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
  report.token = {
    decimals,
    supply,
    mintAuthority: info.mintAuthority,        // null = renounced
    freezeAuthority: info.freezeAuthority,    // null = renounced
  };

  // 2) Top holders + %
  step("Fetching top holders…");
  const largest = await rpc("getTokenLargestAccounts", [ca]);
  const tokenAccts = (largest?.value || []).slice(0, 20);
  const ownerLookup = await rpc("getMultipleAccounts", [
    tokenAccts.map((t) => t.address),
    { encoding: "jsonParsed" },
  ]);
  let holders = tokenAccts.map((t, i) => {
    const owner = ownerLookup?.value?.[i]?.data?.parsed?.info?.owner || t.address;
    const amount = Number(t.uiAmount) || 0;
    const known = KNOWN[owner];
    return {
      owner,
      tokenAccount: t.address,
      amount,
      pctSupply: supply ? (amount / supply) * 100 : 0,
      known: known || null,
      isPool: known?.kind === "lp" || known?.kind === "burn",
    };
  });

  // 3) Per-wallet deep read (age + funding source) for top `depth` real holders
  const targets = holders.filter((h) => !h.isPool).slice(0, depth);
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

  // 5) Cluster by shared funder (same wallet funded multiple holders = cluster)
  const byFunder = {};
  targets.forEach((h) => {
    if (!h.funder) return;
    (byFunder[h.funder] = byFunder[h.funder] || []).push(h);
  });
  const clusters = Object.entries(byFunder)
    .filter(([, m]) => m.length > 1)
    .map(([funder, members], i) => ({
      id: i,
      funder,
      members: members.map((m) => m.owner),
      pctSupply: members.reduce((s, m) => s + (m.pctSupply || 0), 0),
      cexLinked: !!KNOWN[funder] && KNOWN[funder].kind === "cex",
    }))
    .sort((a, b) => b.pctSupply - a.pctSupply);
  report.clusters = clusters;

  // 6) Aggregate metrics + anomaly flags
  const real = holders.filter((h) => !h.isPool);
  const top10 = real.slice(0, 10).reduce((s, h) => s + h.pctSupply, 0);
  const top1 = real[0]?.pctSupply || 0;
  const freshCount = targets.filter((h) => (h.ageDays ?? 999) < 2).length;
  const cexCount = holders.filter((h) => h.known?.kind === "cex").length;
  const biggestCluster = clusters[0]?.pctSupply || 0;
  report.holders = holders;
  report.metrics = { top10, top1, freshCount, cexCount, biggestCluster, tokenAgeDays };

  if (report.token.mintAuthority) report.flags.push({ t: "Mint authority is LIVE — supply can be inflated", sev: "high" });
  if (report.token.freezeAuthority) report.flags.push({ t: "Freeze authority is LIVE — your wallet can be frozen", sev: "high" });
  if (top1 > 15) report.flags.push({ t: `Top wallet holds ${pct(top1)} of supply`, sev: top1 > 30 ? "high" : "med" });
  if (top10 > 50) report.flags.push({ t: `Top 10 hold ${pct(top10)} — concentrated`, sev: top10 > 70 ? "high" : "med" });
  if (biggestCluster > 10) report.flags.push({ t: `One funder cluster controls ${pct(biggestCluster)}`, sev: "high" });
  if (freshCount >= 3) report.flags.push({ t: `${freshCount} top holders are <2 days old (sniper/insider pattern)`, sev: "med" });
  const lpBurned = holders.some((h) => h.known?.kind === "burn");
  if (lpBurned) report.flags.push({ t: "LP tokens routed to burn — liquidity likely locked", sev: "good" });

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
  add(`Largest cluster ${pct(m.biggestCluster)}`, m.biggestCluster > 15 ? -16 : m.biggestCluster > 8 ? -8 : +4);
  add(`${m.freshCount} fresh top holders`, m.freshCount >= 4 ? -12 : m.freshCount >= 2 ? -5 : +3);
  add(r.holders.some((h) => h.known?.kind === "burn") ? "LP burned" : "LP burn not detected",
      r.holders.some((h) => h.known?.kind === "burn") ? +10 : -2);

  s = Math.max(0, Math.min(100, Math.round(s)));
  const band = s >= 70 ? "Looks organic" : s >= 45 ? "Mixed signals" : "High risk";
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
  const [depth, setDepth] = useState(15);
  const [ca, setCa] = useState("");
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState("");
  const [err, setErr] = useState("");
  const [report, setReport] = useState(null);
  const [drawer, setDrawer] = useState(null);
  const [showCfg, setShowCfg] = useState(false);
  const [copied, setCopied] = useState("");

  const run = useCallback(async () => {
    const addr = ca.trim();
    if (!addr) return;
    setLoading(true); setErr(""); setReport(null); setProgress("Starting…");
    try {
      const r = await analyze(addr, RPC_PROXY, depth, setProgress);
      setReport(r);
    } catch (e) {
      setErr(e.message || String(e));
    } finally { setLoading(false); }
  }, [ca, depth]);

  const copy = (txt) => { navigator.clipboard?.writeText(txt); setCopied(txt); setTimeout(() => setCopied(""), 1200); };

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
        </div>
        {showCfg && (
          <div style={{ borderTop: "1px solid #1b1d22", background: "#0d0f12" }}>
            <div style={{ maxWidth: 1100, margin: "0 auto", padding: "14px 20px", display: "flex", gap: 14, flexWrap: "wrap", alignItems: "center" }}>
              <label style={{ fontSize: 11, color: "#6b6f78" }}>DEPTH (top holders to deep-trace)</label>
              <input type="number" min={5} max={20} value={depth} onChange={(e) => setDepth(Math.max(5, Math.min(20, +e.target.value || 15)))}
                style={{ width: 70, background: "#0a0b0d", border: "1px solid #2a2d34", color: "#e7e3d8", borderRadius: 8, padding: "9px 12px", fontSize: 12 }} />
              <span style={{ fontSize: 11, color: "#4a4d54" }}>RPC runs through your Netlify function — key stays server-side.</span>
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
      {drawer && <Drawer h={drawer} onClose={() => setDrawer(null)} copy={copy} copied={copied} />}

      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
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
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 18, flexWrap: "wrap" }}>
            <Authority ok={!r.token.mintAuthority} on={<><Unlock size={13} /> Mint live</>} off={<><Lock size={13} /> Mint renounced</>} />
            <Authority ok={!r.token.freezeAuthority} on={<><Snowflake size={13} /> Freeze live</>} off={<><ShieldCheck size={13} /> Freeze renounced</>} />
            {r.holders.some((h) => h.known?.kind === "burn") && (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11, color: "#7ee787", background: "rgba(126,231,135,.1)", border: "1px solid rgba(126,231,135,.3)", borderRadius: 7, padding: "5px 9px" }}><Flame size={13} /> LP burned</span>
            )}
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

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, alignItems: "start" }}>
        {/* cluster graph */}
        <div className="rise" style={{ background: "#0e1014", border: "1px solid #1b1d22", borderRadius: 14, padding: 18 }}>
          <Head icon={Boxes} title="Wallet clusters" sub="grouped by shared funder" />
          <ClusterGraph r={r} onWallet={onWallet} />
          {r.clusters.length === 0 && <div style={{ fontSize: 12, color: "#6b6f78", marginTop: 10 }}>No shared-funder clusters in the analyzed set — holders funded independently (a good sign).</div>}
          {r.clusters.slice(0, 3).map((c) => (
            <div key={c.id} style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "#9aa0ab", marginTop: 8, borderTop: "1px solid #1b1d22", paddingTop: 8 }}>
              <span>Cluster via {short(c.funder)} {c.cexLinked && "· CEX"}</span>
              <span style={{ color: "#ffb454" }}>{c.members.length} wallets · {pct(c.pctSupply)}</span>
            </div>
          ))}
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
              <div style={{ display: "flex", gap: 5, flexWrap: "wrap", justifyContent: "flex-end", width: 200 }}>
                {(h.tags || []).slice(0, 3).map((t, j) => <Tag key={j} t={t} />)}
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
    const real = r.holders.filter((h) => !h.isPool).slice(0, 16);
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

function Drawer({ h, onClose, copy, copied }) {
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
          <Row k="Supply held" v={pct(h.pctSupply)} />
          <Row k="Balance" v={Intl.NumberFormat("en", { notation: "compact" }).format(h.amount)} />
          <Row k="Wallet age" v={h.ageDays != null ? `${h.ageDays.toFixed(1)} d` : "—"} />
          <Row k="Tx count" v={h.txCount ?? "—"} />
          <Row k="Funded by" v={h.funder ? short(h.funder) : "—"} />
          <Row k="Realized PnL" v="backend" muted />
        </div>
        <div style={{ marginTop: 16, fontSize: 11, color: "#6b6f78", lineHeight: 1.6 }}>
          Profitability & full trade history need the deep-PnL backend (cross-token tx replay). The age, funding, and activity above are read live from the chain.
        </div>
      </div>
    </div>
  );
}

/* small bits */
const Stat = ({ label, value }) => (
  <div><div style={{ fontSize: 10, color: "#6b6f78", letterSpacing: ".1em" }}>{label}</div><div style={{ fontSize: 17, marginTop: 3 }}>{value}</div></div>
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
  const map = { "Fresh": "#ffb454", "Sniper?": "#ff5d5d", "Whale": "#ff8fb1", "CEX-funded": "#5b8def", "High-activity": "#a78bfa" };
  const c = map[t] || (t.includes("verify") || t.includes("Binance") || t.includes("Coinbase") ? "#5b8def" : "#8a8f99");
  return <span style={{ fontSize: big ? 12 : 10, color: c, border: `1px solid ${c}40`, background: `${c}14`, borderRadius: 6, padding: big ? "5px 9px" : "2px 7px", whiteSpace: "nowrap" }}>{t}</span>;
}
