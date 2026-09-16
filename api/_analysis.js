// Statistical "stretch" analysis — the sigma rule applied to price.
//
// What this measures: how far the current price sits from its own recent
// average, expressed in standard deviations (sigma). Under the empirical rule
// ~68% of observations fall within 1σ, ~95% within 2σ, ~99.7% within 3σ, so a
// |z| above 2 is a statistically unusual position for the stock to be in.
//
// What this is NOT: a valuation of the business. It says nothing about earnings,
// assets or growth — only where the price sits relative to its own recent
// behaviour. A stock in a strong uptrend can sit above +2σ for weeks without
// being "expensive", and a falling knife can sit below -2σ all the way down.
// Treat it as "statistically stretched", and read it alongside the trend.

export function mean(a) {
  return a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
}
export function stdev(a) {
  if (a.length < 2) return null;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1));
}
const round = (v, d = 2) => (v == null || !Number.isFinite(v) ? null : +v.toFixed(d));

// Classic z-score: (price − rolling mean) / rolling stdev, window includes today.
export function zScore(closes, n) {
  if (closes.length < n) return null;
  const win = closes.slice(-n);
  const m = mean(win), s = stdev(win);
  if (!s) return null;
  return { z: (closes[closes.length - 1] - m) / s, mean: m, sigma: s };
}

// Deviation from a fitted log-linear trend, in units of residual sigma.
// Fairer than an SMA z-score for a trending stock: a steady riser is "at trend"
// here rather than permanently "overbought".
export function trendZ(closes) {
  const n = closes.length;
  if (n < 30) return null;
  const ys = closes.map((c) => Math.log(c));
  const my = mean(ys), mx = (n - 1) / 2;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (i - mx) * (ys[i] - my); den += (i - mx) ** 2; }
  const b = den ? num / den : 0, a = my - b * mx;
  const res = ys.map((y, i) => y - (a + b * i));
  const s = stdev(res);
  if (!s) return null;
  return {
    z: res[n - 1] / s,
    fairValue: Math.exp(a + b * (n - 1)),      // the trend line's value today
    annualDriftPct: (Math.exp(b * 252) - 1) * 100,
  };
}

// Where the current value sits within a historical distribution (0–100).
export function percentileOf(arr, v) {
  if (!arr.length || v == null) return null;
  let c = 0;
  for (const x of arr) if (x <= v) c++;
  return (c / arr.length) * 100;
}

// Trailing-12-month dividend yield at each historical point — the closest thing
// to a genuine "cheap vs its own history" measure available without fundamentals.
// NOTE the inversion: a HIGH yield percentile means the price is low relative to
// the dividends being paid, i.e. cheaper than usual.
export function yieldSeries(weekly, dividends) {
  const YR = 365 * 864e5;
  const out = [];
  for (const p of weekly || []) {
    if (!(p.c > 0)) continue;
    const ttm = (dividends || [])
      .filter((d) => d.exDate <= p.t && d.exDate > p.t - YR)
      .reduce((a, b) => a + b.amount, 0);
    if (ttm > 0) out.push({ t: p.t, y: (ttm / p.c) * 100 });
  }
  return out;
}

// Daily volatility of log returns, drift removed — the input to any honest
// forward range.
export function dailySigma(closes) {
  const rets = [];
  for (let i = 1; i < closes.length; i++) {
    const r = Math.log(closes[i] / closes[i - 1]);
    if (Number.isFinite(r)) rets.push(r);
  }
  if (rets.length < 10) return null;
  const m = mean(rets);
  const cent = rets.map((r) => r - m);
  return Math.sqrt(cent.reduce((a, b) => a + b * b, 0) / (cent.length - 1));
}

// Where the price could plausibly be on each future day if nothing but its own
// volatility acts on it (zero-drift random walk). This is the naive benchmark a
// forecast's own low/high band should be calibrated against — sigma scales with
// the square root of time, so day 7's range is ~2.6x day 1's, not 7x.
export function projectedRange(last, sigma, horizon = 7) {
  if (!(last > 0) || !(sigma > 0)) return null;
  const Z80 = 1.2816, Z50 = 0.6745;
  return Array.from({ length: horizon }, (_, i) => {
    const h = i + 1, sd = sigma * Math.sqrt(h);
    return {
      d: h,
      p10: round(last * Math.exp(-Z80 * sd)),
      p25: round(last * Math.exp(-Z50 * sd)),
      p50: round(last),
      p75: round(last * Math.exp(Z50 * sd)),
      p90: round(last * Math.exp(Z80 * sd)),
    };
  });
}

function verdictFor(z) {
  if (z == null) return null;
  if (z <= -2) return 'stretched low (≈2σ below its mean)';
  if (z <= -1) return 'below its mean';
  if (z < 1) return 'near its mean';
  if (z < 2) return 'above its mean';
  return 'stretched high (≈2σ above its mean)';
}

// Pulls it all together. `points` should be DAILY bars, ideally ~1 year.
export function valuationSummary(points, weekly, dividends) {
  const closes = (points || []).map((p) => p.c).filter((c) => c > 0);
  if (closes.length < 25) return null;
  const last = closes[closes.length - 1];
  const z20 = zScore(closes, 20), z50 = zScore(closes, 50), z200 = zScore(closes, 200);
  const tr = trendZ(closes.slice(-252));
  const win1y = closes.slice(-252);
  const ys = yieldSeries(weekly, dividends);
  const curY = ys.length ? ys[ys.length - 1].y : null;
  const yieldPct = ys.length >= 26 ? percentileOf(ys.map((o) => o.y), curY) : null;

  // Blend the two most meaningful stretch measures when both exist.
  const parts = [z20 ? z20.z : null, tr ? tr.z : null].filter((v) => v != null);
  const composite = parts.length ? mean(parts) : null;

  return {
    price: round(last),
    z20: z20 ? round(z20.z) : null,
    z50: z50 ? round(z50.z) : null,
    z200: z200 ? round(z200.z) : null,
    sma20: z20 ? round(z20.mean) : null,
    sigma20: z20 ? round(z20.sigma) : null,
    band20: z20 ? {
      lo1: round(z20.mean - z20.sigma), hi1: round(z20.mean + z20.sigma),
      lo2: round(z20.mean - 2 * z20.sigma), hi2: round(z20.mean + 2 * z20.sigma),
    } : null,
    dailySigmaPct: round((dailySigma(closes) || 0) * 100),
    trendZ: tr ? round(tr.z) : null,
    trendFair: tr ? round(tr.fairValue) : null,
    trendDriftPctPerYear: tr ? round(tr.annualDriftPct, 1) : null,
    trendGapPct: tr ? round(((last - tr.fairValue) / tr.fairValue) * 100, 1) : null,
    pricePercentile1y: round(percentileOf(win1y, last), 0),
    dividendYieldPct: round(curY),
    dividendYieldPercentile: round(yieldPct, 0),
    daysUsed: closes.length,
    composite: round(composite),
    verdict: verdictFor(composite),
  };
}

// Dividend growth from the ex-dividend history we already fetch.
// Grouped by calendar year of the ex-date, which is a good proxy but can be
// distorted when a company shifts its payment timing across a year boundary —
// hence the `cut` flag rather than a bare "growth is negative" reading.
export function dividendGrowth(dividends, now = Date.now()) {
  if (!Array.isArray(dividends) || dividends.length < 2) return null;
  const byYear = new Map();
  for (const d of dividends) {
    if (!d || !d.exDate || !(d.amount > 0)) continue;
    const y = new Date(d.exDate).getUTCFullYear();
    byYear.set(y, (byYear.get(y) || 0) + d.amount);
  }
  const currentYear = new Date(now).getUTCFullYear();
  // The running year is incomplete, so it would fake a cut — leave it out.
  const series = [...byYear.entries()]
    .filter(([y]) => y < currentYear)
    .sort((a, b) => a[0] - b[0])
    .map(([year, total]) => ({ year, total: round(total, 4) }));
  if (series.length < 2) return null;

  const cagrOver = (n) => {
    if (series.length < n + 1) return null;
    const end = series[series.length - 1].total;
    const start = series[series.length - 1 - n].total;
    return start > 0 && end > 0 ? round((Math.pow(end / start, 1 / n) - 1) * 100) : null;
  };
  const last = series[series.length - 1].total;
  const prev = series[series.length - 2].total;

  let increaseStreak = 0;
  for (let i = series.length - 1; i > 0; i--) {
    if (series[i].total > series[i - 1].total) increaseStreak++;
    else break;
  }
  const cut = series.some((s, i) => i > 0 && s.total < series[i - 1].total * 0.999);

  return {
    years: series,
    lastYearGrowthPct: prev > 0 ? round(((last - prev) / prev) * 100) : null,
    cagr3yPct: cagrOver(3),
    cagr5yPct: cagrOver(5),
    increaseStreak,
    cut,
  };
}
