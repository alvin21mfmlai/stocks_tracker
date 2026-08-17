# Live Stocks — code structure guide

A map of the codebase for making design and code changes. Everything is plain
JavaScript — no framework, no build step, no dependencies.

## The big picture

```
Browser (index.html — everything visual)
   │  fetch()
   ▼
Vercel serverless functions (api/*.js — the backend)
   │
   ├── Yahoo Finance  (quotes, history, search, news — free, no key)
   └── NVIDIA API     (Nemotron forecast — key in env var NVIDIA_API_KEY)
```

The browser never talks to Yahoo or NVIDIA directly — always through your own
`/api/*` endpoints. That's what keeps the NVIDIA key secret and avoids CORS.

## File map

| File | Role |
|---|---|
| `index.html` | The entire frontend: markup, CSS, and JS in one file |
| `api/_yahoo.js` | Shared helpers: fetch from Yahoo (`getChart`, `searchSymbols`, `getNews`) + `sendJson` response helper. The `_` prefix means Vercel does NOT expose it as an endpoint |
| `api/stock.js` | `GET /api/stock?symbol=&range=` → quote + price series |
| `api/search.js` | `GET /api/search?q=` → ticker search results |
| `api/news.js` | `GET /api/news?symbol=` → latest headlines |
| `api/dividends.js` | `GET /api/dividends?symbol=&price=` → ex-dividend history + derived cycle facts |
| `api/forecast.js` | `POST /api/forecast {symbol}` → stats + Nemotron AI forecast |
| `dev-server.js` | Local-only dev server; `MOCK=1` serves synthetic data. Never runs on Vercel |
| `package.json` | Just sets `"type": "module"` (ESM). No dependencies |

## Backend (`api/`)

Each endpoint file exports `default async function handler(req, res)` — Vercel's
convention. All of them delegate the real work to `_yahoo.js` and reply through
`sendJson(res, status, body, cacheSeconds)`, which also sets edge-cache headers
(`s-maxage`): 15s for intraday quotes, 60s for other ranges, 10 min for news,
1 h for search.

`_yahoo.js` internals worth knowing:

- `yahooJson(path)` — tries `query1.finance.yahoo.com` then `query2` as fallback.
  The browser `User-Agent` header is required or Yahoo rejects the request.
- `getChart(symbol, range)` — maps range → interval via the `INTERVALS` table
  (`1d`→5m bars, `1mo`→daily, `1y`→weekly …), normalizes the response into
  `{symbol, name, currency, price, prevClose, …, points: [{t,o,h,l,c,v}]}`.
  This shape is the contract the frontend chart depends on.
- `getNews(symbol)` — per-ticker RSS feed first (reliably scoped to the symbol),
  falling back to the search endpoint filtered by `relatedTickers`. Returns
  `[{title, publisher, link, publishedAt}]` sorted newest first, or `[]` — an
  empty list beats unrelated headlines, which would also poison the prompt.
- `getDividends(symbol)` — pulls the chart API's `events.dividends` stream (no
  key needed), returning `[{exDate, amount}]`. `dividendContext(divs, price)`
  turns that into the facts a forecaster needs: cadence, median gap, trailing-12m
  total and yield, days since the last ex-date, and a **projected** next ex-date
  (last + median gap — a cycle estimate, not a company filing).

`forecast.js` is the most involved:

1. Fetches 3 months of history, news, and dividends in parallel (news and
   dividend failures are ignored — the forecast still runs without them).
2. `buildStats()` computes SMA20/50, 1w/1m/3m changes, daily log-return
   volatility, ranges — plain math, no model.
3. Builds a prompt embedding the stats, last 30 closes, up to 8 headlines, and a
   dividend block — the latter lists the forecast window's actual dates and
   instructs the model to subtract the dividend from predicted closes if an
   ex-date falls inside it, and to discount any recent ex-date drop in the
   history as mechanical rather than bearish. Demands a strict JSON reply
   (outlook, confidence, summary, support/resistance, drivers, risks,
   news_impact, dividend_note, 7 daily predictions).
4. Calls NVIDIA: constants `NVIDIA_URL` and `MODEL` at the top of the file;
   model overridable via env `NVIDIA_MODEL` without a code change.
5. `extractJson()` strips `<think>` reasoning traces and code fences, then
   parses the outermost `{…}`. `normalizePredictions()` validates the numbers,
   clamps bands to ±30%, and assigns real weekday dates via `nextTradingDays()`.

## Frontend (`index.html`)

One file, three blocks: `<style>`, markup, one `<script>` IIFE.

**CSS / theming.** All colors are CSS custom properties defined three times at
the top: light defaults on `:root`, dark via `@media (prefers-color-scheme)`,
and dark again under `:root[data-theme="dark"]` (the manual toggle). To restyle,
change the variables — the rest of the CSS only references roles like
`--surface-1`, `--series-1` (chart line color), `--delta-up/down`, `--wash`
(hover tint). Layout is a CSS grid (`.layout`, chart column + 320px sidebar,
collapsing to one column under 900px).

**JS state** (top of the script): `watchlist` (persisted to localStorage key
`ls_watchlist`; new `DEFAULTS` entries merge in via the `ls_seeded` key),
`selected` (current symbol), `range`, `chartData` (last loaded series),
`wlCache` (per-symbol 1-month series powering sidebar rows + sparklines),
`fc` + `fcHorizon` (AI predictions and how many days are drawn), `mc` (cached
Monte Carlo cone), `newsItems` (headlines, also used for chart pins), `opts`
(chart display toggles, persisted as `ls_chartopts`), `FC_RANGES` (which ranges
show the forecast overlay and cone).

**Browser storage keys**: `ls_watchlist`, `ls_seeded`, `ls_provider`,
`ls_chartopts`, `ls_fclog` (the forecast track record).

**JS sections**, in file order, each marked with a `// ---------- name ----------`
comment:

- `theme` — the toggle button; sets `data-theme` and re-renders the chart so SVG
  colors update.
- `api` — tiny `fetch` wrapper + error banner (`showErr`).
- `quote header + tiles` — `renderQuote(d)` fills the name, price, change line,
  and the stat tiles row.
- `chart` — the heart of the UI. `renderChart(d)` builds the whole SVG as a
  string, in strict back-to-front order: gridlines + y labels → volatility cone
  → price marks (line+area, or candles) → volume panel → AI forecast line and
  "today" divider → x labels → crosshair + transparent hover rect → news pins
  (last, so they sit above the hover layer and can take their own mouse
  events). Geometry constants (`pad`, panel heights, tick counts) are at the top
  of the function; the price panel keeps a fixed height and the SVG grows when
  the volume panel is on. It re-renders wholesale on resize, theme change, range
  change and option toggles — cheap, because it's one innerHTML assignment.
- `computeCone()` — bootstrap Monte Carlo: resamples the stock's own de-meaned
  daily log returns 2,000 times over 7 trading days and takes percentiles. Drift
  is removed on purpose, so the cone's centre is a flat random walk — the naive
  baseline the AI line is meant to be judged against. Computed once per data
  load (in `loadSelected`) and cached in `mc`, so re-renders stay stable.
- `track record` — `logForecast()` appends each forecast to `ls_fclog`;
  `renderTrack()` fetches 6 months of actual closes per logged symbol, matches
  each prediction to the nearest real trading day (within 2.5 days, and only
  after the forecast was made), then aggregates direction accuracy, median
  absolute % error per horizon bucket, and band coverage.
- `ranges` — the 1D…5Y buttons.
- `watchlist` — `renderWatchlist()` (cards from `quoteCache`), click-to-select,
  ✕-to-remove, `refreshWatchlistQuotes()`.
- `search` — debounced (300ms) dropdown; picking a result adds to watchlist and
  selects it.
- `news` — `loadNews()` fills the news card; guards against the user switching
  stocks mid-fetch.
- `forecast` — button handler POSTs `/api/forecast`, `renderForecast(j)` builds
  the panel (badges, summary, news impact, levels, drivers/risks, horizon
  chips, predicted closes). Sets `fc` so the chart overlay appears;
  auto-switches to the 1M range if on an intraday view.
- `load & refresh` — `loadSelected()` is the main entry point; timers at the
  bottom: quotes/chart every 60s, news every 5 min.

Conventions: `esc()` for anything user- or API-supplied injected into HTML;
`fmt()` for number display; rendering is "rebuild the section's innerHTML from
state" throughout — no virtual DOM, no partial updates.

## Where to change common things

| Change | Where |
|---|---|
| Colors / dark mode | CSS variables at top of `index.html` (`--series-1` price, `--series-2` news pins) |
| Cone horizon / simulation count | `computeCone(d, horizon, sims)` defaults |
| Cone percentile bands | the two `band(...)` calls in `renderChart` |
| News pin clustering distance | the `< 16` pixel test in the marks loop |
| Default chart toggles | the `opts` object (users' choices override via `ls_chartopts`) |
| Track-record horizon buckets | `buckets` in `renderTrack()` |
| Default watchlist | `DEFAULTS` array (state section) — only affects fresh browsers; localStorage wins |
| Chart size, paddings, tick count | constants at top of `renderChart()` |
| Available time ranges | `RANGES` (frontend) + `INTERVALS` (`_yahoo.js`) + `RANGES` allowlist (`api/stock.js`) |
| Refresh cadence | `setInterval` calls at the bottom of the script |
| Model / endpoint | top of `api/forecast.js`, or env `NVIDIA_MODEL` |
| Forecast prompt & JSON schema | the `prompt` template in `api/forecast.js` (keep the JSON field names in sync with `renderForecast()`) |
| Forecast horizon options | `[1, 3, 5, 7]` in `renderForecast()`; days requested is in the prompt |
| Which ranges show the overlay | `FC_RANGES` |
| Headline count fed to the model | `news.slice(0, 8)` in `api/forecast.js` |

## Gotchas

- The forecast panel and `api/forecast.js` share a contract: the JSON field
  names in the prompt must match what `renderForecast()` reads. Change both.
- `_`-prefixed files in `api/` are helpers; anything else becomes a public
  endpoint automatically.
- The watchlist you see in your own browser comes from localStorage, not
  `DEFAULTS` — clear the `ls_watchlist` key to re-test defaults.
- `dev-server.js` mock mode intercepts `/api/*` before the real modules, so
  mock shapes must mirror the real API responses when you add fields.
- Yahoo's endpoints are unofficial: no auth, but keep the User-Agent header and
  the query1/query2 fallback, and be gentle with request rates.
