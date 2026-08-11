// GET /api/search?q=dbs  -> ticker search
import { searchSymbols, sendJson } from './_yahoo.js';

export default async function handler(req, res) {
  try {
    const url = new URL(req.url, 'http://x');
    const q = (url.searchParams.get('q') || '').trim();
    if (q.length < 1) return sendJson(res, 200, { results: [] });
    const results = await searchSymbols(q);
    sendJson(res, 200, { results }, 3600);
  } catch (e) {
    sendJson(res, 502, { error: String(e.message || e) });
  }
}
