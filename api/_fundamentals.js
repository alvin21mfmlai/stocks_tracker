// Company fundamentals from Yahoo's quoteSummary endpoint.
//
// Everything here is REPORTED data (what the company filed) or a ratio derived
// from it — no modelling, no opinion. Three honest limits to keep in mind:
//   * ETFs and funds have no earnings, so most of this comes back null. That is
//     correct, not a failure — `kind` says which case you are in.
//   * Coverage outside the US is thinner. SGX names usually have the headline
//     ratios but sometimes lack full statements.
//   * Figures are as-reported and lag the market by up to a quarter.
import { yahooAuthedJson } from './_yahoo.js';

const MODULES = [
  'price',
  'summaryDetail',
  'defaultKeyStatistics',
  'financialData',
  'earningsTrend',
  'incomeStatementHistory',
  'balanceSheetHistory',
  'cashflowStatementHistory',
].join(',');

// quoteSummary wraps most numbers as {raw, fmt, longFmt}; some are bare.
const raw = (v) => (v && typeof v === 'object' && 'raw' in v ? v.raw : v);
const num = (v) => {
  const n = Number(raw(v));
  return Number.isFinite(n) ? n : null;
};
const pct = (v) => {
  const n = num(v);
  return n == null ? null : +(n * 100).toFixed(2);
};
const r2 = (v) => (v == null || !Number.isFinite(v) ? null : +v.toFixed(2));
const year = (v) => {
  const n = num(v);
  return n ? new Date(n * 1000).getUTCFullYear() : null;
};
const div = (a, b) => (a != null && b ? a / b : null);

export async function getFundamentals(symbol) {
  const j = await yahooAuthedJson(
    `/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=${MODULES}`
  );
  const r = j?.quoteSummary?.result?.[0];
  if (!r) throw new Error('no quoteSummary result');

  const price = r.price || {};
  const sd = r.summaryDetail || {};
  const ks = r.defaultKeyStatistics || {};
  const fd = r.financialData || {};
  const quoteType = price.quoteType || '';
  const isFund = /ETF|MUTUALFUND|INDEX/i.test(quoteType);

  // ---- statements: newest first, trimmed to what a forecaster can use ----
  const income = (r.incomeStatementHistory?.incomeStatementHistory || []).map((s) => ({
    year: year(s.endDate),
    revenue: num(s.totalRevenue),
    grossProfit: num(s.grossProfit),
    operatingIncome: num(s.operatingIncome),
    netIncome: num(s.netIncome),
  })).filter((s) => s.year);

  const balance = (r.balanceSheetHistory?.balanceSheetStatements || []).map((s) => ({
    year: year(s.endDate),
    cash: num(s.cash),
    totalAssets: num(s.totalAssets),
    totalLiabilities: num(s.totalLiab),
    equity: num(s.totalStockholderEquity),
    longTermDebt: num(s.longTermDebt),
  })).filter((s) => s.year);

  const cashflow = (r.cashflowStatementHistory?.cashflowStatements || []).map((s) => {
    const op = num(s.totalCashFromOperatingActivities);
    const capex = num(s.capitalExpenditures);          // reported negative
    return {
      year: year(s.endDate),
      operatingCashFlow: op,
      capex,
      freeCashFlow: op != null && capex != null ? op + capex : null,
      dividendsPaid: num(s.dividendsPaid),
    };
  }).filter((s) => s.year);

  // ---- growth: prefer the trailing statements, fall back to Yahoo's figure ----
  const cagr = (series, key) => {
    const vals = series.map((s) => s[key]).filter((v) => v != null && v > 0);
    if (vals.length < 2) return null;
    const newest = vals[0], oldest = vals[vals.length - 1], yrs = vals.length - 1;
    return r2((Math.pow(newest / oldest, 1 / yrs) - 1) * 100);
  };
  const est = (r.earningsTrend?.trend || []).find((t) => t.period === '+1y') || {};

  const revenue = income[0]?.revenue ?? null;
  const fcf = cashflow[0]?.freeCashFlow ?? num(fd.freeCashflow);
  const marketCap = num(price.marketCap) ?? num(sd.marketCap);

  const out = {
    symbol: price.symbol || symbol,
    name: price.longName || price.shortName || symbol,
    kind: isFund ? 'fund' : 'company',
    currency: price.currency || null,
    marketCap,
    asOfYear: income[0]?.year ?? null,

    valuation: {
      trailingPE: r2(num(sd.trailingPE) ?? num(ks.trailingPE)),
      forwardPE: r2(num(sd.forwardPE) ?? num(ks.forwardPE)),
      pegRatio: r2(num(ks.pegRatio)),
      priceToBook: r2(num(ks.priceToBook)),
      priceToSales: r2(num(sd.priceToSalesTrailing12Months)),
      enterpriseToEbitda: r2(num(ks.enterpriseToEbitda)),
      // Earnings yield is the inverse of P/E — directly comparable with the
      // dividend yield and with bond yields, which a bare P/E is not.
      earningsYieldPct: (() => {
        const pe = num(sd.trailingPE) ?? num(ks.trailingPE);
        return pe && pe > 0 ? r2(100 / pe) : null;
      })(),
    },

    cash: {
      totalCash: num(fd.totalCash),
      totalDebt: num(fd.totalDebt),
      netCash: (() => {
        const c = num(fd.totalCash), d = num(fd.totalDebt);
        return c != null && d != null ? c - d : null;
      })(),
      operatingCashFlow: num(fd.operatingCashflow) ?? cashflow[0]?.operatingCashFlow ?? null,
      freeCashFlow: fcf,
      fcfMarginPct: r2(div(fcf, revenue) == null ? null : div(fcf, revenue) * 100),
      // How many years of free cash flow would clear the debt — a blunt but
      // very readable solvency check.
      debtToFcfYears: (() => {
        const d = num(fd.totalDebt);
        return d != null && fcf && fcf > 0 ? r2(d / fcf) : null;
      })(),
      currentRatio: r2(num(fd.currentRatio)),
      quickRatio: r2(num(fd.quickRatio)),
      debtToEquity: r2(num(fd.debtToEquity)),
    },

    growth: {
      revenueGrowthPct: pct(fd.revenueGrowth),
      earningsGrowthPct: pct(fd.earningsGrowth),
      revenueCagr3yPct: cagr(income, 'revenue'),
      netIncomeCagr3yPct: cagr(income, 'netIncome'),
      nextYearRevenueGrowthPct: pct(est.revenueEstimate?.growth),
      nextYearEarningsGrowthPct: pct(est.earningsEstimate?.growth),
      grossMarginPct: pct(fd.grossMargins),
      operatingMarginPct: pct(fd.operatingMargins),
      netMarginPct: pct(fd.profitMargins),
      returnOnEquityPct: pct(fd.returnOnEquity),
    },

    dividend: {
      yieldPct: pct(sd.dividendYield),
      rate: num(sd.dividendRate),
      payoutRatioPct: pct(sd.payoutRatio),
      fiveYearAvgYieldPct: r2(num(sd.fiveYearAvgDividendYield)),
    },

    statements: { income, balance, cashflow },
  };
  return out;
}

// Compact, human-readable lines for the forecast prompt. Keeping this beside the
// normalizer means the prompt and the UI can never drift apart on units.
export function fundamentalsBlock(f, divGrowth) {
  if (!f) return '';
  const money = (v) => {
    if (v == null) return 'n/a';
    const a = Math.abs(v);
    if (a >= 1e12) return (v / 1e12).toFixed(2) + 'T';
    if (a >= 1e9) return (v / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return (v / 1e6).toFixed(1) + 'M';
    return String(v);
  };
  const p = (v, suffix = '%') => (v == null ? 'n/a' : v + suffix);

  if (f.kind === 'fund') {
    return `
Fundamentals: ${f.symbol} is a fund/ETF, so it has no earnings, cash flow or balance sheet of its own. Do not reason about P/E, margins or debt for it — judge it on price action, the sector it tracks, and its distribution yield (${p(f.dividend.yieldPct)}).
`;
  }

  const v = f.valuation, c = f.cash, g = f.growth, d = f.dividend;
  const inc = f.statements.income.slice(0, 4);
  const cf = f.statements.cashflow.slice(0, 4);
  const stmtLines = inc.length
    ? inc.map((s) => {
        const m = cf.find((x) => x.year === s.year) || {};
        return `  ${s.year}: revenue ${money(s.revenue)}, net income ${money(s.netIncome)}, operating CF ${money(m.operatingCashFlow)}, free CF ${money(m.freeCashFlow)}`;
      }).join('\n')
    : '  (statements unavailable for this listing)';

  return `
Company fundamentals (as reported, currency ${f.currency || '?'}; latest fiscal year ${f.asOfYear ?? 'n/a'}):
- Valuation: trailing P/E ${v.trailingPE ?? 'n/a'}, forward P/E ${v.forwardPE ?? 'n/a'}, PEG ${v.pegRatio ?? 'n/a'}, P/B ${v.priceToBook ?? 'n/a'}, P/S ${v.priceToSales ?? 'n/a'}, EV/EBITDA ${v.enterpriseToEbitda ?? 'n/a'}; earnings yield ${p(v.earningsYieldPct)}
- Cash & balance sheet: cash ${money(c.totalCash)}, debt ${money(c.totalDebt)}, net cash ${money(c.netCash)}; operating CF ${money(c.operatingCashFlow)}, free CF ${money(c.freeCashFlow)} (FCF margin ${p(c.fcfMarginPct)}); debt ÷ FCF ${c.debtToFcfYears ?? 'n/a'} years; current ratio ${c.currentRatio ?? 'n/a'}, debt/equity ${c.debtToEquity ?? 'n/a'}
- Growth & profitability: revenue ${p(g.revenueGrowthPct)} YoY (3y CAGR ${p(g.revenueCagr3yPct)}), earnings ${p(g.earningsGrowthPct)} YoY (3y CAGR ${p(g.netIncomeCagr3yPct)}); analyst next-year revenue ${p(g.nextYearRevenueGrowthPct)}, earnings ${p(g.nextYearEarningsGrowthPct)}; gross margin ${p(g.grossMarginPct)}, operating margin ${p(g.operatingMarginPct)}, net margin ${p(g.netMarginPct)}, ROE ${p(g.returnOnEquityPct)}
- Dividend: yield ${p(d.yieldPct)} (5y average ${p(d.fiveYearAvgYieldPct)}), payout ratio ${p(d.payoutRatioPct)}${divGrowth ? `; per-share dividend growth ${p(divGrowth.lastYearGrowthPct)} last year, ${p(divGrowth.cagr3yPct)} 3y CAGR, ${p(divGrowth.cagr5yPct)} 5y CAGR; ${divGrowth.increaseStreak} consecutive yearly increase(s)${divGrowth.cut ? ' — NOTE: the payout has been cut at some point in this window' : ''}` : ''}
- Last fiscal years:
${stmtLines}

How to use fundamentals in a 1–2 week forecast:
* Fundamentals set the BACKDROP, not the timing. Over 7 trading days price is driven by flow, news and positioning; a cheap multiple does not make a stock rise this week, and an expensive one does not make it fall.
* Use them to size the RISK around your prediction rather than its direction: a company with heavy debt relative to free cash flow, negative free cash flow, or a payout ratio above ~100% deserves a wider band; one with net cash and steady free cash flow deserves a tighter one.
* Where fundamentals and the statistical stretch DISAGREE, say so explicitly in fundamental_note — e.g. price stretched low but earnings and cash flow still growing, versus price stretched low with deteriorating revenue (the second is not a bargain).
* Compare forward P/E with trailing P/E: forward well below trailing means the market expects earnings to rise; well above means it expects them to fall. Same for the analyst next-year figures.
* Do not invent numbers that are marked n/a, and do not treat as-reported annual figures as current news — they can be up to a quarter stale.
`;
}
