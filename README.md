# SolScope — deploy

Chain-native Solana token forensics. Paste a CA, it reads the chain through
your own Helius key (server-side) and scores how organic the token looks.

## Files
```
solscope/
├── index.html
├── package.json
├── vite.config.js
├── netlify.toml
├── src/
│   ├── main.jsx
│   └── App.jsx          ← the analyzer
└── netlify/functions/
    └── rpc.js           ← proxies Helius; key stays server-side
```

## Deploy (Netlify)

1. Push this folder to a GitHub repo (or drag-drop into Netlify, but Git is
   better since it builds + bundles the function for you).
2. In Netlify: **Add new site → Import from Git** → pick the repo.
   Build settings auto-fill from `netlify.toml` (build `npm run build`,
   publish `dist`).
3. **Site settings → Environment variables → Add:**
   - Key:  `HELIUS_KEY`
   - Value: your Helius API key
4. Deploy. Done.

> Local dev: `npm install` then `npx netlify dev` (runs the function + Vite
> together). Plain `npm run dev` won't have the `/.netlify/functions/rpc`
> route.

## Security
- The key lives ONLY in the Netlify env var. It never ships to the browser.
- Rotate the key in the Helius dashboard if it's ever been exposed.
- `rpc.js` allowlists exactly the 6 methods the app uses — nothing else gets
  proxied.

## Tuning
- **Settings → Depth**: how many real holders get deep-traced (age + funding).
  Higher = more thorough, more Helius credits per scan.
- Verify/extend the `KNOWN` entity map at the top of `App.jsx`. The burn and
  program addresses are solid; the CEX entries are marked `(verify)`.

## Backend stubs (next phase)
In `App.jsx`, clearly marked:
- `deepWalletPnL()` — per-wallet realized/unrealized PnL (cross-token tx replay)
- `exactBundleDetect()` — same-slot / Jito-bundle buy detection
- `persistWalletLabel()` — makes "wallet learning" persist across scans

These want a small DB (Supabase free tier) + a couple more functions.
