# SolScope

Chain-native Solana token forensics. Paste a contract address; SolScope reads
the chain directly through your own Helius key, identifies the wallets involved,
and scores how organic the token looks — concentration, clusters, snipers,
insiders, sellability traps, and a persistent memory of every wallet it sees.
All scoring logic is yours; third-party data is used only as labels/reference.

---

## What it does

**Distribution & holders**
- True **top-100 holders** by owner (aggregates multiple token accounts per owner).
- Top-1 / top-10 concentration, total holder count.
- **Supply split**: liquidity vs burned vs top wallets vs untracked tail.

**Who the wallets are**
- **Helius Wallet Identity** lookup on every holder + funder: labels CEX, DeFi,
  market makers, KOLs, and malicious actors (scammer / rugger / hacker). Names
  show on holder rows and in the drawer.
- **Known-entity map** (`KNOWN` in App.jsx) for burn/program addresses, used
  alongside the identity API.

**Coordination & insiders**
- **Wallet clustering** by funding source, typed as **CEX** (shown, not
  penalized unless dominant), **fresh** (coordinated distribution — penalized),
  or **funded** (aged shared-funder — mild).
- **Equal-balance bundle** heuristic — near-identical holder balances.
- **Fresh / sniper detection** — holders younger than the token.
- **Deployer trace** — finds the creator and how much they still hold.

**Sellability / rug traps (from the mint — free)**
- Mint & freeze authority status, LP-burn detection.
- Token program + **Token-2022 extensions**: transfer tax, transfer hook,
  permanent delegate, default-frozen, non-transferable.

**Memory & profitability**
- **Persistent wallet intelligence (Supabase)** — records wallets across scans;
  cross-token recurrence is surfaced, and your manual flags/labels/notes
  resurface on that wallet on every future token.
- **On-demand trader PnL** — net SOL across a wallet's recent swaps; profitable
  wallets get a one-tap "good trader" label that the memory layer remembers.

**Access**
- **Password gate** — single shared password enforced server-side; protects the
  Helius/Supabase endpoints, not just the UI.

Everything is fail-safe: if identity or intel backends are unavailable, the scan
still runs on the rest of the logic.

---

## How the confidence score works

Starts at **50**. Each signal adds or subtracts, then it's clamped to 0–100.
The "Why this score" panel lists the exact factors for that token. Main movers:

| Signal | Effect |
| --- | --- |
| Mint / freeze renounced | + (live authorities penalized) |
| Top-1 / top-10 concentration | − past ~15% / ~50% |
| Fresh-wallet clusters | − scaled by supply controlled **and** count |
| CEX clusters | shown; − only if they hold a large share (>20%) |
| Other shared-funder clusters | − mild, only if sizable |
| Equal-balance wallets | − coordinated-distribution penalty |
| Deployer still holding | − scaled by % held |
| Transfer tax / hook | − scaled |
| Malicious-labeled holders | − up to 45 |
| Flagged / serial wallets (your memory) | − |
| LP burned | + |

**Hard floor:** non-transferable, permanent-delegate, or default-frozen tokens
are capped at **12** ("Likely unsellable") regardless of everything else.

---

## File layout

```
solscope/
├── index.html
├── package.json
├── vite.config.js
├── netlify.toml
├── supabase_setup.sql          # paste into Supabase SQL editor (one time)
├── src/
│   ├── main.jsx
│   └── App.jsx                 # front-end + analysis engine
└── netlify/functions/
    ├── login.js                # password -> signed token
    ├── rpc.js                  # Helius JSON-RPC proxy (auth-gated)
    ├── identity.js             # Helius batch wallet-identity (auth-gated)
    ├── wallet-intel.js         # Supabase wallet memory (auth-gated)
    └── pnl.js                  # recent-swap net-SOL PnL (auth-gated)
```

---

## Environment variables (Netlify)

Set all five under **Site configuration → Environment variables**:

| Variable                | What it is                                                       |
|-------------------------|------------------------------------------------------------------|
| `HELIUS_KEY`            | Helius API key. Used by `rpc.js`, `identity.js`, `pnl.js`.       |
| `SUPABASE_URL`          | Supabase → Project Settings → API → Project URL.                |
| `SUPABASE_SERVICE_KEY`  | Supabase → API → **service_role** secret (NOT the anon key).    |
| `SITE_PASSWORD`         | Password typed on the landing page.                             |
| `AUTH_SECRET`           | Long random string used to sign login tokens. Keep it secret.   |

None of these ship to the browser.

---

## Setup

1. **Push this folder to a GitHub repo.** (On mobile, create files by full path,
   e.g. `netlify/functions/identity.js`, to auto-create folders.)
2. **Database:** Supabase → SQL Editor → New query → paste all of
   `supabase_setup.sql` → Run. Safe to re-run.
3. **Import to Netlify:** Add new site → Import from Git. Build settings auto-fill
   from `netlify.toml`.
4. **Add the five environment variables** above.
5. **Deploy**, then **Deploys → Trigger deploy → Clear cache and deploy site**
   (env vars don't apply retroactively to an existing deploy).

### Local development

```
npm install
npx netlify dev      # runs functions + Vite together
```

Plain `npm run dev` won't expose `/.netlify/functions/*`, so login/data calls
fail — always use `netlify dev` locally.

---

## Security model

- **Helius key** never reaches the client; the functions inject it server-side.
  `rpc.js` allowlists only the RPC methods the app uses.
- **Supabase service_role key** lives only in `wallet-intel.js`. RLS stays on;
  no public policies are created on purpose.
- **Password gate** is real, not cosmetic: `login.js` returns an HMAC-signed
  token (signed with `AUTH_SECRET`); `rpc.js`, `identity.js`, `wallet-intel.js`,
  and `pnl.js` all reject requests without a valid token. Token lasts 30 days;
  the lock icon logs out; any 401 returns to the gate.

---

## Using it

- **Settings (top bar):**
  - **Holders** — list size (default 100, up to 200). Cheap.
  - **Trace** — how many holders get the deep age + funding-cluster pass
    (default 25, up to 50). ~2 RPC calls per traced wallet.
- **Holder rows** show %, identity name, malicious/flagged chips, a "seen N×"
  cross-token badge, and your manual tags. Tap a row for the drawer.
- **Wallet drawer:** identity, live age, tx count, funding source, cross-token
  recurrence; **Your intel** (flag bad actor, labels, notes — all persist); and
  **Trader PnL** (on-demand; net SOL over recent swaps; one-tap good-trader tag).

### Reading PnL

Net SOL = the wallet's actual SOL balance change across its recent swap
transactions (fees included), in **SOL terms**, over a **recent sampled window**
(not lifetime, not USD). Positive = profit extracted. Negative can mean open
positions, not necessarily a loss. Bots/MEV show large positive net SOL — use
age and swap count to tell them apart.

---

## Approximations & limits (read this)

- **Liquidity** in the split only counts pools identified by the identity API or
  `KNOWN` map; an unlabeled pool can make liquidity read low. Burn is reliable.
- **Identity** is strong for established entities but won't know brand-new
  wallets — it complements the fresh-wallet/funding heuristics, not replaces them.
- **Deployer** is traced to genesis only for reasonably young tokens (capped
  pagination); long-lived tokens show "estimate."
- **Clusters** only span the **Trace** depth — raise it to map more of the holders.
- **Bundle detection** is heuristic (shared funder + equal balances), not
  exact same-slot/Jito detection yet.

---

## Roadmap

- **Exact bundle detection** — same-slot / Jito-bundle buys at launch.
- **Batch trader ranking** — run PnL across the traced set and sort holders by it.
- **Per-user accounts** — currently a single shared password.
