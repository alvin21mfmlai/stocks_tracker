// GET /api/screener                 -> list of categories
// GET /api/screener?category=semis  -> stocks in that category ranked by the screen
import { sendJson } from './_yahoo.js';
import { categoryList } from './_universes.js';
import { screenCategory } from './_screener.js';

export default async function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  const id = (url.searchParams.get('category') || '').trim();
  if (!id) return sendJson(res, 200, { categories: categoryList() }, 86400);
  try {
    const result = await screenCategory(id);
    // Fundamentals move quarterly and prices daily — an hour at the edge is plenty.
    sendJson(res, 200, result, result.picks.length ? 3600 : 0);
  } catch (e) {
    sendJson(res, /unknown category/.test(e.message) ? 400 : 502, { error: String(e.message || e) });
  }
}
