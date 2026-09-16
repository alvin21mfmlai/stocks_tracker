// GET /api/fundamentals?symbol=PANW
// P/E and other multiples, cash flow and balance-sheet strength, growth rates,
// dividend growth, and the last few years of statements.
import { getDividendData, sendJson } from './_yahoo.js';
import { getFundamentals } from './_fundamentals.js';
import { dividendGrowth } from './_analysis.js';

export default async function handler(req, res) {
  try {
    const url = new URL(req.url, 'http://x');
    const symbol = (url.searchParams.get('symbol') || '').trim();
    if (!symbol) return sendJson(res, 400, { error: 'symbol is required' });

    const [fundamentals, divData] = await Promise.all([
      getFundamentals(symbol),
      getDividendData(symbol).catch(() => ({ dividends: [], weekly: [] })),
    ]);

    // Reported figures change quarterly at most — cache hard.
    sendJson(res, 200, {
      symbol: fundamentals.symbol,
      fundamentals,
      dividendGrowth: dividendGrowth(divData.dividends),
    }, 21600);
  } catch (e) {
    // Fundamentals are an enrichment: report the failure plainly so the UI can
    // say "unavailable" instead of looking broken.
    sendJson(res, 200, { symbol: null, fundamentals: null, dividendGrowth: null, error: String(e.message || e) });
  }
}
