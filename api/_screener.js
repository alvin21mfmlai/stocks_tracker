// Rules-based stock screener: ranks the stocks in one category against EACH
// OTHER on five factors, using the fundamentals and price history the app
// already fetches.
//
// Why rules and not an LLM: a model asked "what are the best stocks" answers
// from training data that is months stale and cannot show its working. This
// screen uses today's reported numbers, and every score is traceable to the
// metrics behind it.
//
// Why percentiles within the group: absolute thresholds break across sectors
// (a 25 P/E is cheap for software and expensive for a bank). Ranking inside a
// peer group sidesteps that — but it also means the top of a weak group is
// still the top of a weak group. The UI says so.
import { getChart } from './_yahoo.js';
import { getFundamentals } from './_fundamentals.js';
import { universeById } from './_universes.js';

// ---------------------------------------------------------------------------
// Module-scope caches. A warm serverless instance reuses these across calls,
// so the assistant and the Top Picks card share one set of upstream fetches.
// ---------------------------------------------------------------------------
const HOUR = 3600e3;
const caches = { fund: new Map(), chart: new Map(), screen: new Map() };

function memo(map, key, ttl, fn) {
  const hit = map.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.promise;
  const promise = fn().catch((e) => { map.delete(key); throw e; });
  map.set(key, { at: Date.now(), promise });
  return promise;
}

export const cachedFundamentals = (s) => memo(caches.fund, s, 6 * HOUR, () => getFundamentals(s));
// 10 minutes: fresh enough that the assistant's quoted prices are current,
// while the screen result itself is cached separately for an hour.
export const cachedChart = (s) => memo(caches.chart, s, HOUR / 6, () => getChart(s, '1y', '1d'));

// Run fn over items with at most `n` in flight — gentle on Yahoo's rate limits.
export async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  const worker = async () => {
    while (i < items.length) {
      const k = i++;
      out[k] = await fn(items[k], k);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

// ---------------------------------------------------------------------------
// Factors. Each metric is [key, direction]: +1 higher is better, -1 lower is.
// ---------------------------------------------------------------------------
export const FACTORS = {
  quality:  [['roe', 1], ['opMargin', 1], ['netMargin', 1], ['fcfMargin', 1], ['debtToFcf', -1]],
  growth:   [['revGrowth', 1], ['rev3y', 1], ['epsGrowth', 1], ['nextRevGrowth', 1]],
  value:    [['fwdPE', -1], ['evEbitda', -1], ['peg', -1], ['pb', -1]],
  momentum: [['ret6m', 1], ['ret12m', 1]],
  income:   [['divYield', 1], ['yieldVs5y', 1]],
};

export const WEIGHTS = {
  growth:    { quality: 0.30, growth: 0.30, value: 0.20, momentum: 0.20, income: 0.00 },
  bank:      { quality: 0.30, growth: 0.15, value: 0.25, momentum: 0.10, income: 0.20 },
  resources: { quality: 0.30, growth: 0.10, value: 0.30, momentum: 0.20, income: 0.10 },
  defensive: { quality: 0.30, growth: 0.25, value: 0.20, momentum: 0.15, income: 0.10 },
  blend:     { quality: 0.30, growth: 0.20, value: 0.20, momentum: 0.15, income: 0.15 },
};

const isBankLike = (f) => /bank|credit services|capital markets/i.test(f?.profile?.industry || '')
  || /financial/i.test(f?.profile?.sector || '') && /bank/i.test(f?.name || '');

// Turn one stock's raw data into the flat metric set the factors read.
export function extractMetrics(f, chart) {
  const m = {};
  const bank = isBankLike(f);
  const v = f?.valuation || {}, c = f?.cash || {}, g = f?.growth || {}, d = f?.dividend || {};

  m.roe = g.returnOnEquityPct ?? null;
  m.netMargin = g.netMarginPct ?? null;
  // Debt is a bank's raw material, so cash-flow and leverage ratios mislead.
  m.opMargin = bank ? null : g.operatingMarginPct ?? null;
  m.fcfMargin = bank ? null : c.fcfMarginPct ?? null;
  m.debtToFcf = bank ? null : (c.debtToFcfYears ?? (c.freeCashFlow != null && c.freeCashFlow <= 0 && c.totalDebt > 0 ? Infinity : null));

  m.revGrowth = g.revenueGrowthPct ?? null;
  m.rev3y = g.revenueCagr3yPct ?? null;
  m.epsGrowth = g.earningsGrowthPct ?? null;
  m.nextRevGrowth = g.nextYearRevenueGrowthPct ?? null;

  // Lower-is-better multiples: a zero or negative value means losses (or
  // negative growth for PEG), which is the worst case, not a bargain.
  const worstIfNonPositive = (x) => (x == null ? null : x <= 0 ? Infinity : x);
  m.fwdPE = worstIfNonPositive(v.forwardPE ?? v.trailingPE ?? null);
  m.evEbitda = bank ? null : worstIfNonPositive(v.enterpriseToEbitda ?? null);
  m.peg = bank ? null : worstIfNonPositive(v.pegRatio ?? null);
  m.pb = bank ? worstIfNonPositive(v.priceToBook ?? null) : null;

  const closes = (chart?.points || []).map((p) => p.c).filter((x) => x > 0);
  const last = closes[closes.length - 1];
  const back = (n) => closes[Math.max(0, closes.length - 1 - n)];
  m.ret6m = closes.length > 100 ? ((last / back(126)) - 1) * 100 : null;
  m.ret12m = closes.length > 200 ? ((last / closes[0]) - 1) * 100 : null;

  // A company that pays nothing has a yield of zero — that is data, not a gap.
  m.divYield = f && f.kind === 'company' ? (d.yieldPct ?? 0) : null;
  m.yieldVs5y = d.yieldPct != null && d.fiveYearAvgYieldPct != null ? d.yieldPct - d.fiveYearAvgYieldPct : null;
  m.payout = d.payoutRatioPct ?? null;

  return { metrics: m, bank, price: last ?? null };
}

// Percentile of each value within the group (0 worst … 100 best), ties averaged.
export function percentiles(values, dir) {
  const idx = values.map((v, i) => [v, i]).filter(([v]) => v != null && !Number.isNaN(v));
  const out = new Array(values.length).fill(null);
  if (!idx.length) return out;
  if (idx.length === 1) { out[idx[0][1]] = 50; return out; }
  idx.sort((a, b) => (dir > 0 ? a[0] - b[0] : b[0] - a[0]));   // worst → best
  let k = 0;
  while (k < idx.length) {
    let j = k;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[k][0]) j++;
    const rank = (k + j) / 2;                                    // average rank for ties
    for (let t = k; t <= j; t++) out[idx[t][1]] = (rank / (idx.length - 1)) * 100;
    k = j + 1;
  }
  return out;
}

const r = (x, d = 1) => (x == null || !Number.isFinite(x) ? null : +x.toFixed(d));

// Human-readable description of one metric, used for highlights / watch-outs.
function describe(key, val) {
  if (val == null) return null;
  if (!Number.isFinite(val)) {
    return ({ fwdPE: 'loss-making (no positive earnings multiple)', evEbitda: 'negative EBITDA',
      peg: 'no positive growth-adjusted P/E', pb: 'negative book value',
      debtToFcf: 'debt with negative free cash flow' })[key] || null;
  }
  const s = (x) => `${x > 0 ? '+' : ''}${r(x)}%`;
  return ({
    roe: `ROE ${r(val)}%`, opMargin: `operating margin ${r(val)}%`, netMargin: `net margin ${r(val)}%`,
    fcfMargin: `FCF margin ${r(val)}%`, debtToFcf: `debt = ${r(val)} yrs of free cash flow`,
    revGrowth: `revenue ${s(val)} YoY`, rev3y: `revenue ${s(val)}/yr over 3 yrs`,
    epsGrowth: `earnings ${s(val)} YoY`, nextRevGrowth: `analysts expect revenue ${s(val)} next year`,
    fwdPE: `forward P/E ${r(val)}`, evEbitda: `EV/EBITDA ${r(val)}`, peg: `PEG ${r(val, 2)}`, pb: `P/B ${r(val, 2)}`,
    ret6m: `${s(val)} over 6 months`, ret12m: `${s(val)} over 12 months`,
    divYield: `dividend yield ${r(val, 2)}%`, yieldVs5y: `yield ${val >= 0 ? r(val, 2) + ' pts above' : r(-val, 2) + ' pts below'} its 5-yr average`,
  })[key] || null;
}

const FACTOR_LABEL = { quality: 'Quality', growth: 'Growth', value: 'Value', momentum: 'Momentum', income: 'Income' };

// Pure scoring: rows = [{symbol, name, currency, f, chart}] → ranked picks.
export function scoreGroup(rows, profile = 'blend') {
  const weights = WEIGHTS[profile] || WEIGHTS.blend;
  const ex = rows.map((row) => ({ ...row, ...extractMetrics(row.f, row.chart) }));

  // Metric percentiles across the whole group.
  const pctByMetric = {};
  for (const list of Object.values(FACTORS)) {
    for (const [key, dir] of list) {
      if (pctByMetric[key]) continue;
      pctByMetric[key] = percentiles(ex.map((e) => e.metrics[key]), dir);
    }
  }

  const scored = ex.map((e, i) => {
    const factors = {}, best = {}, worst = {};
    for (const [fname, list] of Object.entries(FACTORS)) {
      const vals = list.map(([key]) => [key, pctByMetric[key][i]]).filter(([, p]) => p != null);
      factors[fname] = vals.length ? vals.reduce((a, [, p]) => a + p, 0) / vals.length : null;
      if (vals.length) {
        best[fname] = vals.reduce((a, b) => (b[1] > a[1] ? b : a))[0];
        worst[fname] = vals.reduce((a, b) => (b[1] < a[1] ? b : a))[0];
      }
    }
    // An uncovered dividend is a real risk to the income case.
    if (factors.income != null && e.metrics.payout != null && e.metrics.payout > 100) factors.income *= 0.6;

    let wsum = 0, acc = 0, wAll = 0;
    for (const [fname, w] of Object.entries(weights)) {
      if (!w) continue;
      wAll += w;
      if (factors[fname] == null) continue;
      acc += w * factors[fname]; wsum += w;
    }
    const score = wsum ? acc / wsum : null;

    // Strengths: best-scoring weighted factors, each with its best metric.
    const ranked = Object.entries(factors)
      .filter(([fname, s]) => s != null && weights[fname] > 0)
      .sort((a, b) => b[1] - a[1]);
    const highlights = ranked.filter(([, s]) => s >= 60).slice(0, 2)
      .map(([fname]) => describe(best[fname], e.metrics[best[fname]]))
      .filter(Boolean);
    const weakest = ranked.length ? ranked[ranked.length - 1] : null;
    const watch = weakest && weakest[1] <= 40
      ? `${FACTOR_LABEL[weakest[0]]}: ${describe(worst[weakest[0]], e.metrics[worst[weakest[0]]]) || 'weakest in group'}`
      : null;

    return {
      symbol: e.symbol,
      name: e.name,
      currency: e.currency,
      price: r(e.price, 2),
      bank: e.bank,
      score: r(score, 0),
      coverage: r(wAll ? wsum / wAll : 0, 2),
      factors: Object.fromEntries(Object.entries(factors).map(([k, v]) => [k, r(v, 0)])),
      highlights,
      watch,
      metrics: {
        fwdPE: Number.isFinite(e.metrics.fwdPE) ? r(e.metrics.fwdPE) : (e.metrics.fwdPE === Infinity ? 'loss' : null),
        revGrowth: r(e.metrics.revGrowth), fcfMargin: r(e.metrics.fcfMargin), roe: r(e.metrics.roe),
        divYield: r(e.metrics.divYield, 2), ret6m: r(e.metrics.ret6m), ret12m: r(e.metrics.ret12m),
      },
    };
  });

  return scored
    .filter((s) => s.score != null)
    .sort((a, b) => b.score - a.score || b.coverage - a.coverage)
    .map((s, i) => ({ rank: i + 1, ...s }));
}

export const METHODOLOGY =
  'Each stock is ranked against the others in its group on five factors — quality (ROE, margins, free-cash-flow '
  + 'margin, debt vs cash flow), growth (revenue and earnings growth, analyst next-year estimates), value (forward P/E, '
  + 'EV/EBITDA, PEG; P/B for banks), momentum (6- and 12-month price return) and income (dividend yield and its '
  + 'level vs the 5-year average). Each metric becomes a within-group percentile, factors average their metrics, '
  + 'and the score is a weighted blend tuned to the sector. It is a screen of reported numbers, not a '
  + 'recommendation: it does not know your goals, and the top of a weak group is still in a weak group.';

// Full pipeline for one category, cached for an hour per warm instance.
export async function screenCategory(id) {
  const u = universeById(id);
  if (!u) throw new Error(`unknown category "${id}"`);
  return memo(caches.screen, id, HOUR, async () => {
    const failed = [];
    const rows = await pool(u.tickers, 4, async (symbol) => {
      const [f, chart] = await Promise.all([
        cachedFundamentals(symbol).catch(() => null),
        cachedChart(symbol).catch(() => null),
      ]);
      if (!f && !chart) { failed.push(symbol); return null; }
      if (f && f.kind === 'fund') return null;           // funds have nothing to rank
      return {
        symbol, f, chart,
        name: f?.name || chart?.name || symbol,
        currency: f?.currency || chart?.currency || null,
      };
    });
    const picks = scoreGroup(rows.filter(Boolean), u.profile);
    return {
      category: { id: u.id, name: u.name, blurb: u.blurb, profile: u.profile },
      weights: WEIGHTS[u.profile] || WEIGHTS.blend,
      asOf: new Date().toISOString(),
      picks,
      failed,
      methodology: METHODOLOGY,
    };
  });
}
