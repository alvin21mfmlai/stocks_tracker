# Live Stocks

A live stock viewer with AI forecasting, powered by Yahoo Finance data and NVIDIA's
`nemotron-3-super-120b-a12b` model.

- Live(ish) quotes and interactive price charts (1D → 5Y) for any ticker —
  line or candlestick, with an optional volume panel
- **Volatility cone**: a Monte Carlo probability fan (50% / 80% bands) built by
  resampling the stock's own recent daily returns, drawn behind the AI forecast
  so you can see whether the model's call is bold or just tracking the drift
- **News pins on the chart**: headlines appear as markers at their publication
  date — hover to read, click to open
- **Forecast track record**: every forecast is logged in your browser and scored
  against what actually happened (direction accuracy, median price error by
  horizon, how often the real close landed inside the predicted band)
- Watchlist rows show a 30-day sparkline alongside the price
- Default watchlist: **NVDA** and **DBS** (`D05.SI` on SGX) — add more via search
- One-click AI forecast: the last 3 months of price action + computed stats
  (SMAs, volatility, ranges) are sent to Nemotron, which returns an outlook,
  support/resistance levels, drivers, and risks
- Time-series forecast: Nemotron also predicts closing prices for the next
  7 trading days (with a low–high band). They're plotted on the chart as a
  dashed line with a confidence band — switch the horizon with the
  1d / 3d / 5d / 7d buttons in the forecast panel
- Latest news headlines for the selected stock (via Yahoo Finance), shown below
  the chart and fed into the AI forecast — the model weighs headlines alongside
  price action and reports their impact in a "News impact" section
- Your NVIDIA API key stays server-side in a serverless function — it is never
  exposed to the browser

## Project structure

```
index.html        the whole frontend (no build step)
api/stock.js      GET  /api/stock?symbol=NVDA&range=1mo  → quote + price series
api/search.js     GET  /api/search?q=dbs                 → ticker search
api/news.js       GET  /api/news?symbol=NVDA             → latest headlines
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
- To change the NVIDIA model, set env var `NVIDIA_MODEL` (defaults to
  `nvidia/nemotron-3-super-120b-a12b`). `NVIDIA_THINKING=off` disables the
  model's reasoning trace for faster responses.
- OpenAI as an alternative provider: add env var `OPENAI_API_KEY` and users can
  pick NVIDIA or OpenAI with the toggle in the forecast panel. `OPENAI_MODEL`
  overrides the default (`gpt-5-mini`); `OPENAI_REASONING` sets reasoning effort
  (default `low`). Note: OpenAI calls are billed to your account — every visitor
  who clicks "Generate forecast" with OpenAI selected spends your credit.
- Forecasts are AI-generated commentary on price action only (no news/fundamentals
  are fed in) — for information, not investment advice.
