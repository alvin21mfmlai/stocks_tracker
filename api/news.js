// GET /api/news?symbol=NVDA  -> latest news headlines for a ticker
import { getNews, sendJson } from './_yahoo.js';

export default async function handler(req, res) {
  try {
    const url = new URL(req.url, 'http://x');
    const symbol = (url.searchParams.get('symbol') || '').trim();
    if (!symbol) return sendJson(res, 400, { error: 'symbol is required' });
    const news = await getNews(symbol, 8);
    sendJson(res, 200, { symbol, news }, 600);
  } catch (e) {
    sendJson(res, 502, { error: String(e.message || e) });
  }
}
