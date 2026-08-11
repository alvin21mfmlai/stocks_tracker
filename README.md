# Live Stocks

A live stock viewer with AI forecasting, powered by Yahoo Finance data and NVIDIA's
`nemotron-3-super-120b-a12b` model.

- Live(ish) quotes and interactive price charts (1D → 5Y) for any ticker
- Default watchlist: **NVDA** and **DBS** (`D05.SI` on SGX) — add more via search
- One-click AI forecast: the last 3 months of price action + computed stats
  (SMAs, volatility, ranges) are sent to Nemotron, which returns an outlook,
  support/resistance levels, drivers, and risks
- Time-series forecast: Nemotron also predicts closing prices for the next
  7 trading days (with a low–high band). They're plotted on the chart as a
  dashed line with a confidence band — switch the horizon with the
  1d / 3d / 5d / 7d buttons in the forecast panel
- Your NVIDIA API key stays server-side in a serverless function — it is never
  exposed to the browser

## Project structure

```
index.html        the whole frontend (no build step)
api/stock.js      GET  /api/stock?symbol=NVDA&range=1mo  → quote + price series
api/search.js     GET  /api/search?q=dbs                 → ticker search
api/forecast.js   POST /api/forecast {symbol}            → Nemotron AI outlook
api/_yahoo.js     shared Yahoo Finance helpers (not exposed as an endpoint)
dev-server.js     local dev server (optional)
```

## Deploy to Vercel (recommended, free)

1. Create a free account at https://vercel.com (sign in with GitHub is easiest).
2. Put this folder in a GitHub repo (or use the CLI below).
3. In Vercel: **Add New → Project → Import** your repo. No build settings needed —
   defaults work (it serves `index.html` and auto-detects the `api/` functions).
4. Before/after the first deploy, open **Project → Settings → Environment Variables**
   and add:
   - `NVIDIA_API_KEY` = your key from https://build.nvidia.com (starts with `nvapi-`)
5. Redeploy if you added the key after the first deploy. Done — your site is live
   at `https://<project>.vercel.app`.

### Or deploy from the command line

```bash
npm i -g vercel
cd live-stocks
vercel                                  # first deploy (accept defaults)
vercel env add NVIDIA_API_KEY           # paste your nvapi-... key, select all environments
vercel --prod
```

## Run locally

```bash
NVIDIA_API_KEY=nvapi-your-key node dev-server.js
# open http://localhost:3000
```

Offline / UI-only mode with synthetic data: `MOCK=1 node dev-server.js`

## Notes

- Quotes come from Yahoo Finance's public chart API and may be delayed
  (typically real-time for US stocks, ~15–20 min for SGX). The page auto-refreshes
  every 60 seconds.
- To change the model, set env var `NVIDIA_MODEL` (defaults to
  `nvidia/nemotron-3-super-120b-a12b`).
- Forecasts are AI-generated commentary on price action only (no news/fundamentals
  are fed in) — for information, not investment advice.
