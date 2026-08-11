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
    v = Math.max(base * 0.8, v * (1 + (rnd() - 0.485) * 0.02));
    points.push({ t: now - (n - i) * step, o: v * 0.999, h: v * 1.004, l: v * 0.996, c: +v.toFixed(2), v: Math.round(1e6 * rnd()) });
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
const mockSearch = (q) => ({
  results: [
    { symbol: 'NVDA', name: 'NVIDIA Corporation', exchange: 'NASDAQ', type: 'EQUITY' },
    { symbol: 'D05.SI', name: 'DBS Group Holdings Ltd', exchange: 'SES', type: 'EQUITY' },
    { symbol: 'AAPL', name: 'Apple Inc.', exchange: 'NASDAQ', type: 'EQUITY' },
  ].filter((r) => (r.symbol + r.name).toLowerCase().includes(q.toLowerCase())),
});
const mockForecast = (symbol) => ({
  symbol, name: symbol, currency: 'USD',
  stats: { last: 181.4, change1w: 2.1, change1m: 6.8, change3m: 14.2, sma20: 176.3, sma50: 168.9, dailyVolPct: 2.4, high3m: 184.2, low3m: 152.1 },
  model: 'mock',
  forecast: {
    outlook: 'bullish', confidence: 'medium',
    summary: 'Price is in a steady uptrend, holding above both the 20- and 50-day moving averages with contained volatility. Momentum favors a continued grind higher toward the recent high.',
    support: 176.3, resistance: 184.2,
    drivers: ['Sustained trend above 20/50-day SMAs', 'Higher lows over the past month', 'Volatility compressing near highs'],
    risks: ['A close below the 20-day SMA would weaken the setup', 'Broad market pullback'],
  },
  generatedAt: Date.now(),
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
        if (url.pathname === '/api/forecast') return setTimeout(() => res.end(JSON.stringify(mockForecast('NVDA'))), 600);
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
