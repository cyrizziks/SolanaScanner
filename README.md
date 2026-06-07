# SolScope

Chain-native Solana token forensics. Paste a contract address; SolScope reads
the chain directly through your own Helius key and scores how organic the token
looks — wallet clusters, snipers, insiders, concentration, and a persistent
memory of every wallet it has ever seen. No third-party analysis tools; all the
scoring logic is yours.

---

## What it does

- **Top-100 holders** by owner (aggregates multiple token accounts per owner),
  with each holder's % of supply.
- **Mint / freeze authority** status and **LP-burn** detection.
- **Known-entity & CEX labeling** from an editable seed map.
- **Wallet clustering** — traces each wallet's funding source; wallets sharing a
  funder are grouped (the bundle/insider tell) and drawn as a force graph.
- **Fresh / sniper detection** — flags holders younger than the token itself.
- **Anomaly flags** — concentration, big clusters, live authorities, etc.
- **Confidence score** with a fully transparent factor breakdown (no black box).
- **Persistent wallet intelligence (Supabase)** — every scan records the wallets
  it sees. A wallet that recurs across many of your scans is surfaced; you can
  flag bad actors, add labels, and write notes that resurface on that wallet in
  every future scan, on any token. Flags dock the score and raise a flag.
- **On-demand trader PnL** — net SOL realized across a wallet's recent swaps,
  computed from real on-chain balance deltas. Profitable wallets get a one-tap
  "good trader" label that the intel layer remembers.
- **Password gate** — single shared password enforced server-side; protects the
  Helius/Supabase endpoints, not just the UI.

Fail-safe: if the intel backend is offline, scans still run. If `getTokenAccounts`
is unavailable, it falls back to top-20 and says so.

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
│   └── App.jsx                 # the whole front-end + analysis engine
└── netlify/functions/
    ├── login.js                # password -> signed token
    ├── rpc.js                  # Helius JSON-RPC proxy (auth-gated)
    ├── wallet-intel.js         # Supabase wallet memory (auth-gated)
    └── pnl.js                  # recent-swap net-SOL PnL (auth-gated)
```

---

## Environment variables (Netlify)

Set all five under **Site configuration → Environment variables**:

| Variable                | What it is                                                        |
|-------------------------|-------------------------------------------------------------------|
| `HELIUS_KEY`            | Your Helius API key. Used by `rpc.js` and `pnl.js`.               |
| `SUPABASE_URL`          | Supabase → Project Settings → API → Project URL.                 |
| `SUPABASE_SERVICE_KEY`  | Supabase → API → **service_role** secret (NOT the anon key).     |
| `SITE_PASSWORD`         | The password typed on the landing page.                          |
| `AUTH_SECRET`           | Long random string used to sign login tokens. Keep it secret.    |

Every key lives only in the Netlify environment — none of them ship to the
browser.

---

## Setup

1. **Push this folder to a GitHub repo.** (On mobile, create files by full path,
   e.g. `netlify/functions/pnl.js`, to auto-create folders.)

2. **Set up the database.** Supabase → **SQL Editor → New query** → paste all of
   `supabase_setup.sql` → **Run**. Creates the `wallet_intel` table and the
   `record_wallets` / `label_wallet` functions. Safe to re-run.

3. **Import to Netlify.** Add new site → Import from Git → pick the repo. Build
   settings auto-fill from `netlify.toml` (build `npm run build`, publish `dist`).

4. **Add the five environment variables** (table above).

5. **Deploy** → then **Deploys → Trigger deploy → Clear cache and deploy site**
   so the functions pick up the env vars. (Env vars don't apply retroactively to
   an existing deploy.)

### Local development

```
npm install
npx netlify dev      # runs the functions + Vite together
```

Plain `npm run dev` won't expose the `/.netlify/functions/*` routes, so the app
can't log in or fetch data — always use `netlify dev` locally.

---

## Security model

- **Helius key** never reaches the client; `rpc.js` and `pnl.js` inject it
  server-side. `rpc.js` also allowlists only the RPC methods the app uses.
- **Supabase service_role key** bypasses row-level security and lives only in
  `wallet-intel.js`. RLS stays on; no public policies are created on purpose.
- **Password gate** is real, not cosmetic: `login.js` checks `SITE_PASSWORD` and
  returns an HMAC-signed token (signed with `AUTH_SECRET`). `rpc.js`,
  `wallet-intel.js`, and `pnl.js` all reject requests without a valid token, so
  reading the JS bundle doesn't grant access to the endpoints. Token lasts 30
  days; the lock icon logs out; any 401 bounces back to the gate.

---

## Using it

- **Settings (top bar):**
  - **Holders** — list size (default 100, up to 200). Cheap; one paginated fetch.
  - **Trace** — how many holders get the deep age + funding-cluster pass
    (default 25, up to 50). ~2 RPC calls per traced wallet, so higher = more
    Helius credits per scan.
- **Holder rows** show %, auto-tags, manual tags, a "seen N×" cross-token badge,
  and a FLAGGED marker. Tap a row to open the wallet drawer.
- **Wallet drawer:**
  - Live age, tx count, funding source, cross-token recurrence.
  - **Your intel** — flag as bad actor, add labels, write a note. All persists.
  - **Trader PnL** — tap *Compute recent PnL* (on demand; uses credits). Positive
    net SOL = profit extracted = your good-trader signal. Negative can just mean
    open positions, not a loss. Results cache for the session.

### Reading PnL correctly

Net SOL is the wallet's actual SOL balance change across its recent swap
transactions (fees included), in **SOL terms**, over a **recent sampled window**
(not lifetime, not USD). Reading the real balance delta avoids buy/sell
direction errors. Bots and MEV wallets will show large positive net SOL — that's
correct (they do extract profit), just not necessarily a trader you'd copy; use
wallet age and swap count to tell them apart.

---

## Known entities

The `KNOWN` map at the top of `src/App.jsx` labels burn, system, and program
addresses (stable, trustworthy) plus a few CEX hot wallets marked `(verify)`.
Verify and extend the CEX entries from a source you trust before relying on
those labels — a mislabel can skew a read.

---

## Roadmap / not yet built

- **Exact bundle detection** — same-slot / Jito-bundle buys at launch. Current
  bundle/insider signal is via shared-funder clustering, which is a heuristic.
- **Batch trader ranking** — run PnL across the whole traced set at once and sort
  the holder list by profitability (currently PnL is per-wallet on demand to
  control credit spend).
- **Per-user accounts** — currently a single shared password; no individual
  logins or per-user revocation.
