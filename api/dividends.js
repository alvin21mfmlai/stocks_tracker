// GET /api/dividends?symbol=O39.SI&price=31.44
// Dividend history + derived cycle facts (last ex-date, estimated next one).
import { getDividends, dividendContext, sendJson } from './_yahoo.js';

export default async function handler(req, res) {
  try {
    const url = new URL(req.url, 'http://x');
    const symbol = (url.searchParams.get('symbol') || '').trim();
    if (!symbol) return sendJson(res, 400, { error: 'symbol is required' });
    const price = Number(url.searchParams.get('price')) || null;
    const divs = await getDividends(symbol);
    sendJson(res, 200, { symbol, dividends: divs, context: dividendContext(divs, price) }, 21600);
  } catch (e) {
    sendJson(res, 502, { error: String(e.message || e) });
  }
}
