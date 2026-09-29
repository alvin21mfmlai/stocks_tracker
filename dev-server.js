// Local dev server: serves index.html and the api/ functions without Vercel.
// Usage:  NVIDIA_API_KEY=nvapi-...  node dev-server.js      (real data)
//         MOCK=1 node dev-server.js                          (synthetic data, offline)
import http from 'node:http';
import { readFileSync } from 'node:fs';

const PORT = process.env.PORT || 3000;
const MOCK = process.env.MOCK === '1';

// ---- mock data (used when MOCK=1, e.g. for offline UI work) ----
function mockChart(symbol, range) {
  const now = Date.now();
  const cfg = { '1d': [78, 5 * 60e3], '5d': [65, 30 * 60e3], '1mo': [22, 864e5], '3mo': [64, 864e5], '6mo': [128, 864e5], '1y': [52, 7 * 864e5], '5y': [60, 30 * 864e5] }[range] || [22, 864e5];
  const [n, step] = cfg;
  const base = symbol === 'D05.SI' ? 43 : 178;
  let v = base * 0.94;
  const points = [];
  let seed = 42 + symbol.length;
  const rnd = () => (seed = (seed * 9301 + 49297) % 233280) / 233280;
  for (let i = 0; i < n; i++) {
    const prev = v;
    v = Math.max(base * 0.8, v * (1 + (rnd() - 0.485) * 0.02));
    const o = prev, c = +v.toFixed(2);
    points.push({
      t: now - (n - i) * step,
      o: +o.toFixed(2), h: +(Math.max(o, c) * (1 + rnd() * 0.004)).toFixed(2),
      l: +(Math.min(o, c) * (1 - rnd() * 0.004)).toFixed(2),
      c, v: Math.round(1e6 * rnd()),
    });
  }
  const price = points[points.length - 1].c;
  return {
    symbol, name: symbol === 'D05.SI' ? 'DBS Group Holdings Ltd' : 'NVIDIA Corporation',
    currency: symbol === 'D05.SI' ? 'SGD' : 'USD',
    exchange: symbol === 'D05.SI' ? 'SES' : 'NasdaqGS',
    price, prevClose: +(points[0].c * 1.002).toFixed(2),
    dayHigh: +(price * 1.01).toFixed(2), dayLow: +(price * 0.985).toFixed(2),
    fiftyTwoWeekHigh: +(base * 1.25).toFixed(2), fiftyTwoWeekLow: +(base * 0.7).toFixed(2),
    marketState: 'REGULAR', range, interval: 'mock', points,
  };
}
const mockNews = (symbol) => {
  const co = symbol === 'D05.SI' ? 'DBS' : symbol === 'O39.SI' ? 'OCBC' : 'NVIDIA';
  const H = 36e5;
  return {
    symbol,
    news: [
      { title: `${co} beats quarterly expectations as demand stays strong`, publisher: 'Reuters', link: 'https://example.com/1', publishedAt: Date.now() - 3 * H },
      { title: 'Analysts raise price targets ahead of earnings season', publisher: 'Bloomberg', link: 'https://example.com/2', publishedAt: Date.now() - 9 * H },
      { title: 'Sector rotation puts spotlight on large caps', publisher: 'CNBC', link: 'https://example.com/3', publishedAt: Date.now() - 26 * H },
      { title: 'Market wrap: stocks drift as investors weigh rate outlook', publisher: 'Yahoo Finance', link: 'https://example.com/4', publishedAt: Date.now() - 3 * 24 * H },
      { title: `${co} announces expanded buyback programme`, publisher: 'Business Times', link: 'https://example.com/5', publishedAt: Date.now() - 8 * 24 * H },
      { title: 'Regulators signal lighter capital requirements for the sector', publisher: 'Financial Times', link: 'https://example.com/6', publishedAt: Date.now() - 14 * 24 * H },
      { title: `${co} lifts full-year guidance after strong first half`, publisher: 'Reuters', link: 'https://example.com/7', publishedAt: Date.now() - 21 * 24 * H },
    ],
  };
};
const mockDividends = (symbol) => {
  const DAY = 864e5;
  const sg = /\.SI$/.test(symbol);
  const gap = sg ? 182 : 91;                       // semi-annual vs quarterly
  const amt = sg ? 0.42 : 0.01;
  const lastAgo = sg ? 4 : 30;                     // SG bank went ex 4 days ago
  const dividends = Array.from({ length: 8 }, (_, i) => ({
    exDate: Date.now() - (lastAgo + (7 - i) * gap) * DAY,
    amount: +(amt * (1 + i * 0.02)).toFixed(4),
  })).sort((a, b) => a.exDate - b.exDate);
  const last = dividends[dividends.length - 1];
  const ttm = dividends.filter((d) => d.exDate > Date.now() - 365 * DAY).reduce((a, b) => a + b.amount, 0);
  const price = sg ? 31.44 : 178;
  return {
    symbol, dividends,
    context: {
      lastExDate: last.exDate, lastAmount: last.amount, daysSinceLastEx: lastAgo,
      typicalAmount: +amt.toFixed(4), ttmTotal: +ttm.toFixed(4),
      yieldPct: +((ttm / price) * 100).toFixed(2),
      cadence: sg ? 'semi-annual' : 'quarterly', medianGapDays: gap,
      nextExDateEst: last.exDate + gap * DAY,
      daysToNextEst: gap - lastAgo,
      history: dividends.slice(-8),
    },
  };
};
const mockFundamentals = (symbol) => {
  if (/^(SLV|GLD|CIBR|XBI|SMH|SLVP)$/.test(symbol)) {
    return { symbol, fundamentals: { symbol, name: symbol + ' ETF', kind: 'fund', currency: 'USD',
      dividend: { yieldPct: 1.1 }, valuation: {}, cash: {}, growth: {}, statements: { income: [], balance: [], cashflow: [] } },
      dividendGrowth: null };
  }
  const B = 1e9;
  return {
    symbol,
    fundamentals: {
      symbol, name: symbol + ' Inc.', kind: 'company', currency: 'USD',
      marketCap: 212 * B, asOfYear: 2025,
      valuation: { trailingPE: 54.2, forwardPE: 41.8, pegRatio: 1.7, priceToBook: 19.4,
        priceToSales: 18.1, enterpriseToEbitda: 46.3, earningsYieldPct: 1.85 },
      cash: { totalCash: 4.3 * B, totalDebt: 0.74 * B, netCash: 3.56 * B,
        operatingCashFlow: 1.42 * B, freeCashFlow: 1.18 * B, fcfMarginPct: 29.4,
        debtToFcfYears: 0.63, currentRatio: 1.75, quickRatio: 1.62, debtToEquity: 21.4 },
      growth: { revenueGrowthPct: 23.6, earningsGrowthPct: 31.2, revenueCagr3yPct: 28.4,
        netIncomeCagr3yPct: 44.1, nextYearRevenueGrowthPct: 20.8, nextYearEarningsGrowthPct: 24.5,
        grossMarginPct: 75.1, operatingMarginPct: 17.9, netMarginPct: 12.4, returnOnEquityPct: 28.7 },
      dividend: { yieldPct: 1.9, rate: 0.84, payoutRatioPct: 41.2, fiveYearAvgYieldPct: 2.4 },
      statements: {
        income: [
          { year: 2025, revenue: 4.01 * B, grossProfit: 3.01 * B, operatingIncome: 0.72 * B, netIncome: 0.50 * B },
          { year: 2024, revenue: 3.24 * B, grossProfit: 2.40 * B, operatingIncome: 0.51 * B, netIncome: 0.33 * B },
          { year: 2023, revenue: 2.61 * B, grossProfit: 1.90 * B, operatingIncome: 0.30 * B, netIncome: 0.17 * B },
          { year: 2022, revenue: 1.90 * B, grossProfit: 1.35 * B, operatingIncome: 0.11 * B, netIncome: 0.05 * B },
        ],
        balance: [{ year: 2025, cash: 4.3 * B, totalAssets: 9.1 * B, totalLiabilities: 6.0 * B, equity: 3.1 * B, longTermDebt: 0.6 * B }],
        cashflow: [
          { year: 2025, operatingCashFlow: 1.42 * B, capex: -0.24 * B, freeCashFlow: 1.18 * B, dividendsPaid: -0.2 * B },
          { year: 2024, operatingCashFlow: 1.10 * B, capex: -0.20 * B, freeCashFlow: 0.90 * B, dividendsPaid: -0.18 * B },
          { year: 2023, operatingCashFlow: 0.82 * B, capex: -0.17 * B, freeCashFlow: 0.65 * B, dividendsPaid: -0.15 * B },
          { year: 2022, operatingCashFlow: 0.55 * B, capex: -0.14 * B, freeCashFlow: 0.41 * B, dividendsPaid: -0.12 * B },
        ],
      },
    },
    dividendGrowth: {
      years: [{ year: 2021, total: 0.62 }, { year: 2022, total: 0.68 }, { year: 2023, total: 0.74 },
              { year: 2024, total: 0.79 }, { year: 2025, total: 0.84 }],
      lastYearGrowthPct: 6.3, cagr3yPct: 7.3, cagr5yPct: null, increaseStreak: 4, cut: false,
    },
  };
};
const mockValuation = (symbol) => ({
  symbol, name: symbol, currency: /\.SI$/.test(symbol) ? 'SGD' : 'USD',
  valuation: {
    price: 31.44, z20: -2.14, z50: -0.86, z200: 0.42,
    sma20: 32.61, sigma20: 0.55, dailySigmaPct: 0.94,
    band20: { lo1: 32.06, hi1: 33.16, lo2: 31.51, hi2: 33.71 },
    trendZ: -1.32, trendFair: 32.18, trendDriftPctPerYear: 11.4, trendGapPct: -2.3,
    pricePercentile1y: 38, dividendYieldPct: 5.34, dividendYieldPercentile: 82,
    daysUsed: 251, composite: -1.73, verdict: 'below its mean',
  },
});
const mockSearch = (q) => ({
  results: [
    { symbol: 'NVDA', name: 'NVIDIA Corporation', exchange: 'NASDAQ', type: 'EQUITY' },
    { symbol: 'D05.SI', name: 'DBS Group Holdings Ltd', exchange: 'SES', type: 'EQUITY' },
    { symbol: 'AAPL', name: 'Apple Inc.', exchange: 'NASDAQ', type: 'EQUITY' },
  ].filter((r) => (r.symbol + r.name).toLowerCase().includes(q.toLowerCase())),
});
const mockForecast = (symbol) => {
  const chart = mockChart(symbol, '3mo');
  const last = chart.price;
  const preds = [];
  let t = chart.points[chart.points.length - 1].t;
  for (let d = 1; d <= 7; d++) {
    const dt = new Date(t);
    do { dt.setUTCDate(dt.getUTCDate() + 1); } while (dt.getUTCDay() === 0 || dt.getUTCDay() === 6);
    t = dt.getTime();
    const price = +(last * (1 + 0.004 * d)).toFixed(2);
    const band = last * 0.011 * Math.sqrt(d);
    preds.push({ d, t, price, low: +(price - band).toFixed(2), high: +(price + band).toFixed(2) });
  }
  return {
    symbol, name: chart.name, currency: chart.currency,
    stats: { last, change1w: 2.1, change1m: 6.8, change3m: 14.2, sma20: +(last * 0.97).toFixed(2), sma50: +(last * 0.93).toFixed(2), dailyVolPct: 2.4, high3m: +(last * 1.02).toFixed(2), low3m: +(last * 0.84).toFixed(2) },
    model: 'mock',
    forecast: {
      outlook: 'bullish', confidence: 'medium',
      summary: 'Price is in a steady uptrend, holding above both the 20- and 50-day moving averages with contained volatility. Momentum favors a continued grind higher toward the recent high.',
      support: +(last * 0.97).toFixed(2), resistance: +(last * 1.02).toFixed(2),
      drivers: ['Sustained trend above 20/50-day SMAs', 'Higher lows over the past month', 'Volatility compressing near highs'],
      risks: ['A close below the 20-day SMA would weaken the setup', 'Broad market pullback'],
      news_impact: 'Recent earnings-beat coverage and raised analyst targets support the bullish tilt; no negative catalysts in the latest headlines.',
      dividend_note: 'The stock went ex-dividend 4 sessions ago, so roughly 0.42 of the recent decline is mechanical rather than a change in sentiment. No further ex-date falls inside this forecast window.',
      fundamental_quality: 'solid',
      fundamental_note: 'Revenue is compounding at 28% over three years with a 29% free-cash-flow margin and net cash on the balance sheet, so the business is funding its own growth. At 54x trailing earnings the price already assumes that continues — the fundamentals justify a tight band but not a cheap multiple.',
      valuation: 'below trend',
      valuation_note: 'At -2.1σ against its 20-day mean the price is statistically stretched low, but only -1.3σ against the rising 1-year trend, so this looks like a pullback within an uptrend rather than a cheap price. A partial drift back toward the 20-day mean is plausible inside the window.',
      predictions: preds,
    },
    generatedAt: Date.now(),
  };
};

// Top picks: deterministic pseudo-scores per ticker, shaped like /api/screener.
const mockScreener = async (id) => {
  const { categoryList, universeById } = await import('./api/_universes.js');
  const { WEIGHTS, METHODOLOGY } = await import('./api/_screener.js');
  if (!id) return { categories: categoryList() };
  const u = universeById(id);
  if (!u) return { error: `unknown category "${id}"` };
  const weights = WEIGHTS[u.profile] || WEIGHTS.blend;
  const seed = (s, k) => { let h = 7; for (const c of s + k) h = (h * 31 + c.charCodeAt(0)) % 9973; return h % 100; };
  const picks = u.tickers.filter((s) => !(id === 'cyber' && s === 'RBRK')).map((symbol) => {
    const factors = {};
    for (const k of ['quality', 'growth', 'value', 'momentum', 'income']) factors[k] = seed(symbol, k);
    let acc = 0, ws = 0;
    for (const [k, w] of Object.entries(weights)) if (w) { acc += w * factors[k]; ws += w; }
    return {
      symbol, name: symbol.replace('.SI', '') + ' Holdings', currency: symbol.endsWith('.SI') ? 'SGD' : 'USD',
      price: 20 + seed(symbol, 'p') * 4.3, bank: u.profile === 'bank', score: Math.round(acc / ws), coverage: seed(symbol, 'c') > 85 ? 0.8 : 1,
      factors,
      highlights: [`return on equity ${10 + seed(symbol, 'r') / 3 | 0}%`, `revenue growth ${seed(symbol, 'g') / 2 | 0}% y/y`],
      watch: factors.value < 40 ? `Value: forward P/E ${20 + seed(symbol, 'v') / 2 | 0}x` : null,
      metrics: { fwdPE: 20 + seed(symbol, 'v') / 2, revGrowth: seed(symbol, 'g') / 2, fcfMargin: seed(symbol, 'f') / 3, roe: 10 + seed(symbol, 'r') / 3, divYield: seed(symbol, 'd') / 25, ret6m: seed(symbol, 'm') - 30, ret12m: seed(symbol, 'n') - 20 },
    };
  }).sort((a, b) => b.score - a.score).map((p, i) => ({ rank: i + 1, ...p }));
  return { category: { id: u.id, name: u.name, blurb: u.blurb, profile: u.profile }, weights, asOf: new Date().toISOString(), picks, failed: id === 'cyber' ? ['RBRK'] : [], methodology: METHODOLOGY };
};

const mockAgent = () => ({
  reply: [
    'Here are the top five from the **Semiconductors** screen, ranked on quality, growth, value and momentum:',
    '',
    '| # | Ticker | Score | Why it ranks |',
    '|---|---|---|---|',
    '| 1 | `NVDA` | 78 | 62% FCF margin, revenue +94% y/y |',
    '| 2 | `AVGO` | 71 | strong 12-month momentum, ROE 38% |',
    '| 3 | `TSM` | 68 | forward P/E 19x, revenue +31% |',
    '| 4 | `ASML` | 61 | best quality in group |',
    '| 5 | `AMD` | 55 | growth strong, valuation stretched |',
    '',
    '#### What to weigh',
    '- `NVDA` is priced for continued growth — it is **+2.1σ** above its 1-year trend.',
    '- `TSM` is the cheapest of the five on forward earnings.',
    '',
    '_Screen of reported numbers, not personalised advice._',
  ].join('\n'),
  trace: [
    { tool: 'screen_category', arg: 'semis', ok: true, ms: 2140 },
    { tool: 'get_valuation_stretch', arg: 'NVDA', ok: true, ms: 610 },
    { tool: 'get_quote', arg: 'TSM', ok: true, ms: 320 },
  ],
  rounds: 2, mode: 'native', elapsedMs: 6400, provider: 'openai', model: 'gpt-5.4-mini (mock)',
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.end(readFileSync(new URL('./index.html', import.meta.url)));
    }
    if (url.pathname.startsWith('/api/')) {
      if (MOCK) {
        res.setHeader('Content-Type', 'application/json');
        if (url.pathname === '/api/stock') return res.end(JSON.stringify(mockChart(url.searchParams.get('symbol'), url.searchParams.get('range') || '1mo')));
        if (url.pathname === '/api/search') return res.end(JSON.stringify(mockSearch(url.searchParams.get('q') || '')));
        if (url.pathname === '/api/news') return res.end(JSON.stringify(mockNews(url.searchParams.get('symbol') || 'NVDA')));
        if (url.pathname === '/api/dividends') return res.end(JSON.stringify(mockDividends(url.searchParams.get('symbol') || 'NVDA')));
        if (url.pathname === '/api/valuation') return res.end(JSON.stringify(mockValuation(url.searchParams.get('symbol') || 'NVDA')));
        if (url.pathname === '/api/fundamentals') return res.end(JSON.stringify(mockFundamentals(url.searchParams.get('symbol') || 'NVDA')));
        if (url.pathname === '/api/screener') return res.end(JSON.stringify(await mockScreener(url.searchParams.get('category'))));
        if (url.pathname === '/api/agent') {
          // Mimics the real protocol: step 1 streams tool progress and returns
          // `continue`; step 2 streams the answer text and returns `done`.
          const chunks = []; for await (const c of req) chunks.push(c);
          let body = {}; try { body = JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch {}
          res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
          const emit = (o) => res.write(JSON.stringify(o) + '\n');
          const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));
          const m = mockAgent();
          const q = String((body.messages || []).slice(-1)[0]?.content || '');
          if (/connection drop/i.test(q) && !body.state && !globalThis.__mockDropped) {
            globalThis.__mockDropped = true;             // exercises the browser's one-retry path
            emit({ t: 'status', text: 'Thinking…' }); await wait(400);
            return res.end();
          }
          if (!body.state) {
            emit({ t: 'status', text: 'Thinking…' }); await wait(500);
            emit({ t: 'status', text: 'Fetching data…' });
            for (const t of m.trace) emit({ t: 'tool', phase: 'start', tool: t.tool, arg: t.arg });
            for (const t of m.trace) { await wait(350); emit({ t: 'tool', phase: 'end', ...t }); }
            emit({ t: 'continue', state: { work: [], round: 1, trace: m.trace, t0: Date.now() - 2000, steps: 1 } });
            return res.end();
          }
          emit({ t: 'status', text: 'Writing the answer…' }); await wait(300);
          for (let i = 0; i < m.reply.length; i += 24) { emit({ t: 'delta', text: m.reply.slice(i, i + 24) }); await wait(25); }
          emit({ t: 'done', ...m, steps: 2 });
          return res.end();
        }
        if (url.pathname === '/api/forecast') {
          const chunks = []; for await (const c of req) chunks.push(c);
          let symbol = 'NVDA';
          try { symbol = JSON.parse(Buffer.concat(chunks).toString() || '{}').symbol || 'NVDA'; } catch {}
          return setTimeout(() => res.end(JSON.stringify(mockForecast(symbol))), 600);
        }
      }
      const name = url.pathname.slice('/api/'.length).replace(/[^a-z]/g, '');
      const mod = await import(`./api/${name}.js`);
      return mod.default(req, res);
    }
    res.statusCode = 404; res.end('Not found');
  } catch (e) {
    res.statusCode = 500; res.end(JSON.stringify({ error: String(e.message || e) }));
  }
});
server.listen(PORT, () => console.log(`Live Stocks dev server → http://localhost:${PORT}  ${MOCK ? '(MOCK data)' : '(real data)'}`));
