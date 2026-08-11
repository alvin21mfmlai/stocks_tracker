// GET /api/stock?symbol=NVDA&range=1mo  -> quote + price series
import { getChart, sendJson } from './_yahoo.js';

const RANGES = new Set(['1d', '5d', '1mo', '3mo', '6mo', '1y', '2y', '5y']);

export default async function handler(req, res) {
  try {
    const url = new URL(req.url, 'http://x');
    const symbol = (url.searchParams.get('symbol') || '').trim();
    const range = url.searchParams.get('range') || '1mo';
    if (!symbol) return sendJson(res, 400, { error: 'symbol is required' });
    if (!RANGES.has(range)) return sendJson(res, 400, { error: 'invalid range' });
    const data = await getChart(symbol, range);
    // Cache briefly at the edge so refreshes are cheap but still feel live.
    sendJson(res, 200, data, range === '1d' ? 15 : 60);
  } catch (e) {
    sendJson(res, 502, { error: String(e.message || e) });
  }
}
