// GET /api/valuation?symbol=D05.SI
// Sigma-rule "stretch" analysis: where the price sits relative to its own
// recent behaviour, in standard deviations, plus a dividend-yield percentile.
import { getChart, getDividendData, sendJson } from './_yahoo.js';
import { valuationSummary } from './_analysis.js';

export default async function handler(req, res) {
  try {
    const url = new URL(req.url, 'http://x');
    const symbol = (url.searchParams.get('symbol') || '').trim();
    if (!symbol) return sendJson(res, 400, { error: 'symbol is required' });

    const [chart, divData] = await Promise.all([
      getChart(symbol, '1y', '1d'),                       // daily bars, not weekly
      getDividendData(symbol).catch(() => ({ dividends: [], weekly: [] })),
    ]);
    const valuation = valuationSummary(chart.points, divData.weekly, divData.dividends);
    if (!valuation) return sendJson(res, 200, { symbol, valuation: null, note: 'not enough history' });

    sendJson(res, 200, {
      symbol: chart.symbol, name: chart.name, currency: chart.currency, valuation,
    }, 900);
  } catch (e) {
    sendJson(res, 502, { error: String(e.message || e) });
  }
}
