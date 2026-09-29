// The research assistant: an LLM that answers questions about stocks by
// calling the app's own data functions as tools, then writing an answer
// grounded in what those tools returned.
//
// Robustness is the main design concern. OpenAI's tool calling is reliable.
// NVIDIA's endpoint supports it but, with Nemotron 3, intermittently "leaks"
// tool calls into the reply as raw text (<tool_call>…</tool_call>) instead of
// structured tool_calls. So each turn accepts tool calls three ways:
//   1. native `tool_calls` on the message                     (normal path)
//   2. tool-call markup found inside the text content         (the leak)
//   3. a pure text protocol, if the provider rejects `tools`  (fallback)
// The loop itself takes `callLLM` as a parameter so it can be tested with a
// stub, without any network.
import { searchSymbols, getNews, getDividendData } from './_yahoo.js';
import { valuationSummary, dividendGrowth } from './_analysis.js';
import { cachedFundamentals, cachedChart, screenCategory } from './_screener.js';
import { categoryList } from './_universes.js';

// ---------------------------------------------------------------------------
// Tool definitions (OpenAI function-calling schema, also accepted by NVIDIA)
// ---------------------------------------------------------------------------
const sym = { type: 'string', description: 'Ticker as used by Yahoo Finance, e.g. NVDA, PANW, D05.SI (Singapore), BHP' };
const fn = (name, description, properties = {}, required = []) => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } },
});

export const TOOL_DEFS = [
  fn('list_categories', 'List the stock categories the screener can rank (id, name, description, tickers). Call this when unsure which category fits a question.'),
  fn('screen_category',
    'Rank the stocks in one category against each other on quality, growth, value, momentum and income using current reported fundamentals and price history. Returns the top names with a 0-100 score, factor scores, highlights and a watch-out. Use for "best/top stocks" questions.',
    { category: { type: 'string', description: 'Category id from list_categories, e.g. tech, semis, cyber, banks_us, banks_sg, sg_blue, mining, precious, health, energy' },
      top_n: { type: 'integer', description: 'How many to return (1-10, default 5)' } },
    ['category']),
  fn('get_quote', 'Current price, currency, and price returns over 1 day, 1 month, 6 months and 1 year, plus the 52-week range.', { symbol: sym }, ['symbol']),
  fn('get_fundamentals',
    'Company fundamentals as reported: P/E and other multiples, cash and debt, free cash flow, revenue and earnings growth, margins, dividend yield, payout ratio and dividend growth, business description, and the last three years of revenue, net income and free cash flow.',
    { symbol: sym }, ['symbol']),
  fn('get_valuation_stretch',
    'Sigma-rule statistics: how far the price sits from its 20/50/200-day means and its 1-year trend in standard deviations, the 20-day mean with ±1σ/±2σ bands, the 1-year price percentile, and where the dividend yield sits within its own 5-year range. Statistical stretch, not a valuation of the business.',
    { symbol: sym }, ['symbol']),
  fn('get_news', 'The latest news headlines for a ticker, with publisher and age.', { symbol: sym }, ['symbol']),
  fn('search_ticker', 'Find the ticker symbol for a company name, e.g. "Keppel" or "Singtel".', { query: { type: 'string' } }, ['query']),
];

// ---------------------------------------------------------------------------
// Tool implementations — each returns compact JSON; failures come back as
// {error} so the model can see and report them rather than the loop dying.
// ---------------------------------------------------------------------------
const up = (s) => String(s || '').trim().toUpperCase();
const r = (x, d = 2) => (x == null || !Number.isFinite(x) ? null : +x.toFixed(d));
const ago = (t) => {
  if (!t) return null;
  const h = Math.round((Date.now() - t) / 36e5);
  return h < 24 ? `${Math.max(h, 0)}h ago` : `${Math.round(h / 24)}d ago`;
};

export const TOOL_IMPLS = {
  async list_categories() {
    return { categories: categoryList() };
  },

  async screen_category({ category, top_n }) {
    const n = Math.max(1, Math.min(10, Number(top_n) || 5));
    try {
      const s = await screenCategory(String(category || '').trim());
      const active = Object.entries(s.weights).filter(([, w]) => w > 0).map(([k]) => k);
      return {
        category: s.category,
        factorWeights: s.weights,
        ranked: s.picks.slice(0, n).map((p) => ({
          rank: p.rank, symbol: p.symbol, name: p.name, price: p.price, currency: p.currency, score: p.score,
          factors: Object.fromEntries(active.map((k) => [k, p.factors[k]])),
          highlights: p.highlights, watch: p.watch, metrics: p.metrics, dataCoverage: p.coverage,
        })),
        outOf: s.picks.length,
        unavailable: s.failed,
        note: 'Scores are within-group percentiles (0-100) on reported numbers; they rank peers, not absolute merit.',
      };
    } catch (e) {
      return { error: e.message, availableCategories: categoryList().map((c) => c.id) };
    }
  },

  async get_quote({ symbol }) {
    const s = up(symbol);
    const c = await cachedChart(s);
    const pts = c.points || [];
    const closes = pts.map((p) => p.c);
    const last = c.price ?? closes[closes.length - 1];
    const at = (n) => closes[Math.max(0, closes.length - 1 - n)];
    const chg = (base) => (base ? r(((last / base) - 1) * 100) : null);
    return {
      symbol: c.symbol, name: c.name, currency: c.currency, exchange: c.exchange,
      price: r(last), marketState: c.marketState,
      change1dPct: chg(c.prevClose ?? at(1)), change1mPct: chg(at(21)), change6mPct: chg(at(126)), change1yPct: chg(closes[0]),
      high52w: r(c.fiftyTwoWeekHigh), low52w: r(c.fiftyTwoWeekLow),
      pctBelow52wHigh: c.fiftyTwoWeekHigh ? r(((c.fiftyTwoWeekHigh - last) / c.fiftyTwoWeekHigh) * 100) : null,
      lastBarDate: pts.length ? new Date(pts[pts.length - 1].t).toISOString().slice(0, 10) : null,
    };
  },

  async get_fundamentals({ symbol }) {
    const s = up(symbol);
    const [f, dd] = await Promise.all([
      cachedFundamentals(s),
      getDividendData(s).catch(() => ({ dividends: [] })),
    ]);
    if (f.kind === 'fund') {
      return { symbol: f.symbol, name: f.name, kind: 'fund', note: 'ETF/fund — no earnings, cash flow or balance sheet of its own.', dividendYieldPct: f.dividend?.yieldPct ?? null };
    }
    const g = dividendGrowth(dd.dividends);
    return {
      symbol: f.symbol, name: f.name, currency: f.currency, marketCap: f.marketCap, latestFiscalYear: f.asOfYear,
      profile: f.profile ? { ...f.profile, summary: (f.profile.summary || '').slice(0, 320) || null } : null,
      valuation: f.valuation, cash: f.cash, growth: f.growth, dividend: f.dividend,
      dividendGrowth: g ? { lastYearGrowthPct: g.lastYearGrowthPct, cagr3yPct: g.cagr3yPct, cagr5yPct: g.cagr5yPct, increaseStreakYears: g.increaseStreak, cutInWindow: g.cut } : null,
      recentYears: (f.statements?.income || []).slice(0, 3).map((i) => {
        const cf = (f.statements.cashflow || []).find((x) => x.year === i.year) || {};
        return { year: i.year, revenue: i.revenue, netIncome: i.netIncome, freeCashFlow: cf.freeCashFlow ?? null };
      }),
      note: 'As reported; can lag the market by up to a quarter.',
    };
  },

  async get_valuation_stretch({ symbol }) {
    const s = up(symbol);
    const [c, dd] = await Promise.all([cachedChart(s), getDividendData(s).catch(() => ({ dividends: [], weekly: [] }))]);
    const v = valuationSummary(c.points, dd.weekly, dd.dividends);
    if (!v) return { symbol: s, error: 'not enough price history' };
    return {
      symbol: s, price: v.price, sma20: v.sma20, band20: v.band20,
      zVs20dMean: v.z20, zVs50dMean: v.z50, zVs200dMean: v.z200,
      zVsTrend: v.trendZ, trendFitR2: v.trendR2, trendReliable: v.trendReliable, gapToTrendPct: v.trendGapPct,
      trendDriftPctPerYear: v.trendDriftPctPerYear, pricePercentile1y: v.pricePercentile1y,
      dividendYieldPct: v.dividendYieldPct, dividendYieldPercentile5y: v.dividendYieldPercentile,
      composite: v.composite, verdict: v.verdict,
      note: 'Statistical stretch only. |z|>2 is unusual (~5% of days) but not a timing signal; in a strong trend price can stay stretched.',
    };
  },

  async get_news({ symbol }) {
    const items = await getNews(up(symbol), 6);
    return { symbol: up(symbol), headlines: items.map((n) => ({ title: n.title, publisher: n.publisher, age: ago(n.publishedAt) })) };
  },

  async search_ticker({ query }) {
    const res = await searchSymbols(String(query || ''));
    return { results: res.slice(0, 6) };
  },
};

// ---------------------------------------------------------------------------
// Leaked / text-protocol tool-call parsing
// ---------------------------------------------------------------------------
const safeJSON = (s) => {
  if (s && typeof s === 'object') return s;
  try { return JSON.parse(s); } catch { return null; }
};

// Accepts both formats seen in the wild:
//   <tool_call>{"name": "...", "arguments": {...}}</tool_call>
//   <tool_call><function=NAME><parameter=K>V</parameter></function></tool_call>
// (the second is also accepted without the <tool_call> wrapper).
export function parseTextToolCalls(text) {
  const calls = [];
  if (!text) return { calls, cleaned: '' };
  let cleaned = text;

  const blocks = [...text.matchAll(/<tool_call>([\s\S]*?)<\/tool_call>/g)];
  for (const m of blocks) {
    const inner = m[1].trim();
    const j = safeJSON(inner);
    if (j && j.name) {
      calls.push({ name: String(j.name), args: safeJSON(j.arguments) || j.arguments || j.parameters || {} });
    } else {
      calls.push(...parseXmlFunctions(inner));
    }
    cleaned = cleaned.replace(m[0], '');
  }
  if (!blocks.length && /<function=/.test(text)) {
    calls.push(...parseXmlFunctions(text));
    cleaned = cleaned.replace(/<function=[\s\S]*?<\/function>/g, '');
  }
  return { calls: calls.filter((c) => c.name), cleaned: cleaned.trim() };
}

function parseXmlFunctions(s) {
  const out = [];
  for (const f of s.matchAll(/<function=([\w.-]+)>([\s\S]*?)<\/function>/g)) {
    const args = {};
    for (const p of f[2].matchAll(/<parameter=([\w.-]+)>([\s\S]*?)<\/parameter>/g)) {
      const v = p[2].trim();
      args[p[1]] = /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v;
    }
    out.push({ name: f[1], args });
  }
  return out;
}

const stripThink = (s) => String(s || '')
  .replace(/<think>[\s\S]*?<\/think>/g, '')
  .replace(/^[\s\S]*?<\/think>/, '')           // unmatched close = reasoning spilled in
  .trim();

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------
export function systemPrompt({ today, context = {}, maxRounds, textProtocol = false }) {
  const ctx = [];
  if (context.listName && Array.isArray(context.tickers) && context.tickers.length) {
    ctx.push(`The user's active watchlist ("${context.listName}"): ${context.tickers.slice(0, 20).join(', ')}.`);
  }
  if (context.selected) ctx.push(`They are currently viewing ${context.selected} on the chart.`);

  let p = `You are the research assistant inside "Live Stocks", the user's personal stock-tracking app. Today is ${today}.
${ctx.join(' ')}

How to work:
- Use the tools for every figure you state — prices, returns, ratios, rankings, headlines. Never quote a price, multiple or growth rate from memory: your training data is months out of date and the user will act on what you say.
- Call independent tools together in one turn (e.g. get_fundamentals for three banks at once). You have at most ${maxRounds} rounds of tool use, so plan before calling.
- For "which stocks to buy / top picks / best stocks" questions: use screen_category for the relevant categories (call list_categories first if unsure; if no sector is named, pick two or three sensible ones and say which). Then check fundamentals, stretch or news on the leading names where it adds something. Present a ranked shortlist with the evidence for each (the score plus one to three concrete metrics), the main risk for each, and what would change the view. Make clear the screen ranks stocks against their own peer group on reported numbers.
- You provide research, not personalised financial advice: you don't know the user's goals, time horizon, tax position or existing holdings. Say that once, in one short line at the end of buy/sell-style answers. Do not lecture, hedge every sentence, or decline to engage, and never promise returns.
- If a tool fails or a value is missing, say so plainly and work with what you have. Never invent numbers.
- Style: lead with the answer, be concise, use a short markdown table for comparisons and bullets for reasons. Write every ticker in backticks, e.g. \`NVDA\`, \`D05.SI\` — the app turns them into links.
- Singapore-listed tickers end in .SI (DBS D05.SI, OCBC O39.SI, UOB U11.SI). State currencies when comparing across markets.`;

  if (textProtocol) {
    p += `

Tool protocol: native function calling is unavailable in this session. To call tools, reply ONLY with one or more blocks of exactly this form:
<tool_call>{"name": "get_quote", "arguments": {"symbol": "NVDA"}}</tool_call>
Results come back in <tool_result> blocks. When you have enough information, write the final answer with no tool_call blocks.
Available tools:
${TOOL_DEFS.map((t) => `- ${t.function.name}(${Object.keys(t.function.parameters.properties).join(', ')}): ${t.function.description}`).join('\n')}`;
  }
  return p;
}

const FINAL_NUDGE = 'You are out of tool budget. Write the final answer now from the data already gathered — no more tool calls. Note any gaps.';

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------
async function runTool(impls, name, args, timeoutMs) {
  const impl = impls[name];
  if (!impl) return { error: `unknown tool "${name}"` };
  let timer;
  try {
    return await Promise.race([
      impl(args || {}),
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('tool timed out')), timeoutMs); }),
    ]);
  } catch (e) {
    return { error: String(e.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

const shortArgs = (a) => (a ? (a.symbol || a.category || a.query || '') : '');

export async function runAgent({
  messages, callLLM, tools = TOOL_IMPLS, context = {},
  budgetMs = 50_000, maxRounds = 5, maxCallsPerRound = 6, today = new Date().toISOString().slice(0, 10),
}) {
  const started = Date.now();
  const elapsed = () => Date.now() - started;
  const trace = [];
  let textMode = false;
  let switchedMode = false;

  const convo = [{ role: 'system', content: systemPrompt({ today, context, maxRounds }) }, ...messages];

  for (let round = 0; round < maxRounds; round++) {
    const remaining = budgetMs - elapsed();
    const finalRound = round === maxRounds - 1 || remaining < 14_000;
    if (finalRound && round > 0) convo.push({ role: 'user', content: FINAL_NUDGE });

    let msg;
    try {
      msg = await callLLM({
        messages: convo,
        tools: textMode ? null : TOOL_DEFS,
        toolChoice: textMode ? null : (finalRound && round > 0 ? 'none' : 'auto'),
        remainingMs: remaining,
      });
    } catch (e) {
      // The provider refused `tools` outright: switch to the text protocol once.
      if (!textMode && !switchedMode && [400, 404, 422].includes(e.status)) {
        textMode = true; switchedMode = true;
        convo[0] = { role: 'system', content: systemPrompt({ today, context, maxRounds, textProtocol: true }) };
        round--;
        continue;
      }
      throw e;
    }

    const content = stripThink(msg?.content);
    let calls = [];
    let native = false;
    let cleaned = content;
    if (Array.isArray(msg?.tool_calls) && msg.tool_calls.length) {
      native = true;
      calls = msg.tool_calls.map((tc) => ({ id: tc.id, name: tc.function?.name, args: safeJSON(tc.function?.arguments) || {} }));
    } else {
      const parsed = parseTextToolCalls(content);
      calls = parsed.calls;
      cleaned = parsed.cleaned;
    }
    // A plain answer — or the last round, where any further tool requests are
    // ignored and whatever prose the model wrote becomes the reply.
    if (!calls.length || finalRound) {
      return {
        reply: cleaned || 'I could not put an answer together within the time limit — try a narrower question.',
        trace, rounds: round + 1, mode: textMode ? 'text' : 'native', elapsedMs: elapsed(),
      };
    }

    // Execute this round's calls in parallel.
    const toRun = calls.slice(0, maxCallsPerRound);
    const toolTimeout = Math.max(5_000, Math.min(20_000, budgetMs - elapsed() - 10_000));
    const results = await Promise.all(toRun.map(async (c) => {
      const t0 = Date.now();
      const out = await runTool(tools, c.name, c.args, toolTimeout);
      trace.push({ tool: c.name, arg: shortArgs(c.args), ok: !out?.error, ms: Date.now() - t0 });
      return out;
    }));

    if (native) {
      convo.push({ role: 'assistant', content: msg.content ?? null, tool_calls: msg.tool_calls });
      msg.tool_calls.forEach((tc, i) => {
        const out = i < toRun.length ? results[i] : { error: 'skipped: too many tool calls in one turn — ask again if still needed' };
        convo.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(out) });
      });
    } else {
      convo.push({ role: 'assistant', content: content || '(calling tools)' });
      convo.push({
        role: 'user',
        content: 'Tool results:\n' + toRun.map((c, i) =>
          `<tool_result name="${c.name}">${JSON.stringify(results[i])}</tool_result>`).join('\n')
          + '\nContinue: call more tools only if genuinely needed, otherwise write the final answer.',
      });
    }
  }

  // Loop exhausted without a plain answer (defensive — the final round forbids tools).
  return { reply: 'I ran out of steps before finishing — try a narrower question.', trace, rounds: maxRounds, mode: textMode ? 'text' : 'native', elapsedMs: elapsed() };
}
