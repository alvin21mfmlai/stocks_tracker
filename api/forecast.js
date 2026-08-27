// POST /api/forecast  { symbol }  -> AI outlook from NVIDIA Nemotron
// Requires env var NVIDIA_API_KEY (set it in Vercel project settings).
import { getChart, getNews, getDividendData, dividendContext, sendJson } from './_yahoo.js';
import { valuationSummary, dailySigma, projectedRange } from './_analysis.js';

const NVIDIA_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';
const MODEL = process.env.NVIDIA_MODEL || 'nvidia/nemotron-3-super-120b-a12b';
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-5';

function pct(a, b) { return b ? ((a - b) / b) * 100 : 0; }
function sma(arr, n) {
  if (arr.length < n) return null;
  const s = arr.slice(-n).reduce((x, y) => x + y, 0);
  return s / n;
}
function round2(x) { return x == null ? null : Math.round(x * 100) / 100; }

function buildStats(data) {
  const closes = data.points.map((p) => p.c);
  const last = closes[closes.length - 1];
  const rets = [];
  for (let i = 1; i < closes.length; i++) rets.push(Math.log(closes[i] / closes[i - 1]));
  const mean = rets.reduce((a, b) => a + b, 0) / (rets.length || 1);
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length > 1 ? rets.length - 1 : 1);
  const dailyVol = Math.sqrt(variance) * 100;
  const win3m = closes.slice(-64);
  return {
    last: round2(last),
    change1w: round2(pct(last, closes[closes.length - 6] ?? closes[0])),
    change1m: round2(pct(last, closes[closes.length - 22] ?? closes[0])),
    change3m: round2(pct(last, closes[closes.length - 64] ?? closes[0])),
    change1y: round2(pct(last, closes[0])),
    sma20: round2(sma(closes, 20)),
    sma50: round2(sma(closes, 50)),
    sma200: round2(sma(closes, 200)),
    dailyVolPct: round2(dailyVol),
    high3m: round2(Math.max(...win3m)),
    low3m: round2(Math.min(...win3m)),
    fiftyTwoWeekHigh: round2(data.fiftyTwoWeekHigh),
    fiftyTwoWeekLow: round2(data.fiftyTwoWeekLow),
  };
}

// Next n trading days (Mon-Fri) after a given timestamp, as ms timestamps.
function nextTradingDays(fromTs, n) {
  const out = [];
  const d = new Date(fromTs);
  while (out.length < n) {
    d.setUTCDate(d.getUTCDate() + 1);
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) out.push(d.getTime());
  }
  return out;
}

// Validate + normalize model predictions; attach real trading-day timestamps.
function normalizePredictions(parsed, lastPoint, lastClose) {
  const raw = Array.isArray(parsed?.predictions) ? parsed.predictions : [];
  const nums = raw
    .map((p) => ({ d: Number(p.d), price: Number(p.price), low: Number(p.low), high: Number(p.high) }))
    .filter((p) => Number.isFinite(p.d) && Number.isFinite(p.price) && p.price > 0)
    .sort((a, b) => a.d - b.d)
    .slice(0, 7);
  if (!nums.length) return [];
  const days = nextTradingDays(lastPoint.t, nums.length);
  return nums.map((p, i) => {
    let lo = Number.isFinite(p.low) ? p.low : p.price;
    let hi = Number.isFinite(p.high) ? p.high : p.price;
    if (lo > hi) [lo, hi] = [hi, lo];
    // Sanity clamp: reject bands wider than ±30% of the last close.
    const cap = lastClose * 0.3;
    lo = Math.max(lo, p.price - cap);
    hi = Math.min(hi, p.price + cap);
    return { d: p.d, t: days[i], price: round2(p.price), low: round2(Math.min(lo, p.price)), high: round2(Math.max(hi, p.price)) };
  });
}

function extractJson(text) {
  // Strip reasoning traces and code fences, then find the outermost JSON object.
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/```(?:json)?/g, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try { return JSON.parse(cleaned.slice(start, end + 1)); } catch { return null; }
}

async function readBody(req) {
  if (req.body) return typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST only' });

  try {
    const { symbol, provider: reqProvider } = await readBody(req);
    if (!symbol) return sendJson(res, 400, { error: 'symbol is required' });
    const provider = reqProvider === 'openai' ? 'openai' : 'nvidia';
    const providerName = provider === 'openai' ? 'OpenAI' : 'NVIDIA';
    const apiUrl = provider === 'openai' ? OPENAI_URL : NVIDIA_URL;
    const usedModel = provider === 'openai' ? OPENAI_MODEL : MODEL;
    const apiKey = provider === 'openai' ? process.env.OPENAI_API_KEY : process.env.NVIDIA_API_KEY;
    if (!apiKey) {
      return sendJson(res, 500, {
        error: `${provider === 'openai' ? 'OPENAI_API_KEY' : 'NVIDIA_API_KEY'} is not set on the server`,
      });
    }

    // A full year of DAILY bars: needed for the 200-day sigma window and a
    // meaningful trend fit. The prompt still only quotes the last 30 closes.
    const [data, news, divData] = await Promise.all([
      getChart(symbol, '1y', '1d'),
      getNews(symbol).catch(() => []),                                   // best-effort
      getDividendData(symbol).catch(() => ({ dividends: [], weekly: [] })),
    ]);
    const stats = buildStats(data);
    const div = dividendContext(divData.dividends, stats.last);
    const val = valuationSummary(data.points, divData.weekly, divData.dividends);
    const recent = data.points.slice(-30).map((p) => `${new Date(p.t).toISOString().slice(0, 10)}: ${p.c}`).join('\n');
    const valBlock = val ? `
Statistical position (sigma rule — how far price sits from its own mean, in standard deviations):
- 20-day mean (the average): ${val.sma20} | 1σ = ${val.sigma20}
- 20-day bands: ±1σ = ${val.band20 ? `${val.band20.lo1} (lower) – ${val.band20.hi1} (upper)` : 'n/a'} | ±2σ = ${val.band20 ? `${val.band20.lo2} (lower) – ${val.band20.hi2} (upper)` : 'n/a'}
- vs 20-day mean: ${val.z20 ?? 'n/a'}σ
- vs 50-day mean: ${val.z50 ?? 'n/a'}σ | vs 200-day mean: ${val.z200 ?? 'n/a'}σ
- vs fitted 1-year log-trend: ${val.trendZ ?? 'n/a'}σ (trend value today ${val.trendFair ?? 'n/a'}, price is ${val.trendGapPct ?? 'n/a'}% away from it; trend drift ${val.trendDriftPctPerYear ?? 'n/a'}%/yr; fit quality R² ${val.trendR2 ?? 'n/a'}${val.trendReliable === false ? ' — POOR FIT, a straight line does not describe this year well, so treat this trend reading as unreliable and lean on the 20/50-day figures' : ''})
- Price sits at the ${val.pricePercentile1y ?? 'n/a'}th percentile of the last year
${val.dividendYieldPercentile != null ? `- Trailing dividend yield ${val.dividendYieldPct}%, which is the ${val.dividendYieldPercentile}th percentile of its own 5-year range (HIGHER percentile = price low relative to dividends = cheaper than usual)` : ''}
- Composite read: ${val.verdict}

How to use this:
* Under the empirical (sigma) rule ~68% of observations fall within 1σ, ~95% within 2σ. So |z| > 2 means the price is in an unusual position relative to its own recent behaviour.
* This is a STATISTICAL STRETCH measure, not a valuation of the business — it says nothing about earnings, assets or growth. Do not call a stock "undervalued" on this basis alone; say "statistically stretched low" or similar.
* Mean reversion is NOT automatic. In a strong trend a stock can hold above +2σ for weeks, and a deteriorating one can keep making new lows below -2σ. Weigh the z-scores against the direction of the 200-day mean and the trend drift before predicting a snap back.
* The trend-residual z is usually the fairer read for a trending stock; the 20-day z is the better read for a range-bound one.
` : '';

    const iso = (t) => new Date(t).toISOString().slice(0, 10);
    // The forecast window in real dates, so the model can place an ex-date inside it.
    const horizonDates = (() => {
      const out = [], dt = new Date(data.points[data.points.length - 1].t);
      while (out.length < 7) {
        dt.setUTCDate(dt.getUTCDate() + 1);
        const wd = dt.getUTCDay();
        if (wd !== 0 && wd !== 6) out.push(iso(dt.getTime()));
      }
      return out;
    })();

    // The naive volatility-only envelope for each forecast day. Handing this to
    // the model gives its low/high bands something to be calibrated against —
    // without it, stated ranges came back wildly over- and under-confident.
    const sigmaD = dailySigma(data.points.map((p) => p.c));
    const projected = projectedRange(stats.last, sigmaD, 7);
    const projBlock = projected ? `
Statistically plausible range for each forecast day (this stock's own daily volatility of ${round2(sigmaD * 100)}%/day, zero drift — the naive benchmark). Note the range widens with the SQUARE ROOT of time, so day 7 is only ~2.6x as wide as day 1, not 7x:
${projected.map((p, i) => `- Day ${p.d} (${horizonDates[i]}): 50% chance between ${p.p25} and ${p.p75}; 80% chance between ${p.p10} and ${p.p90}`).join('\n')}

CALIBRATION RULES — apply these to the numbers you output:
* Your "low" and "high" for each day must be broadly consistent with the 80% range above. A much narrower band claims more precision than this stock's volatility supports; a much wider one is uninformative. Widen the band as the horizon grows.
* Your "price" for each day is your call about WHERE INSIDE that range the stock lands. Putting it outside the 80% range is allowed, but only with a stated reason (a news catalyst, an ex-dividend adjustment, or a strong established trend) — say so in valuation_note.
* Anchor support/resistance to real levels: the 20-day mean, the ±1σ/±2σ band edges, the 3-month range and the 52-week range above, rather than round numbers.
* Sanity check before answering: does your day-7 price imply a move this stock plausibly makes in 7 sessions given ${round2(sigmaD * 100)}% daily volatility? If not, pull it back toward the range.
` : '';

    const divBlock = div ? `
Dividend context (${data.currency}):
- Pays ${div.cadence || 'irregularly'}${div.medianGapDays ? ` (~every ${div.medianGapDays} days)` : ''}
- Most recent ex-dividend date: ${iso(div.lastExDate)}, amount ${div.lastAmount} (${div.daysSinceLastEx} days ago)
- Typical recent amount: ${div.typicalAmount} | Trailing 12m total: ${div.ttmTotal}${div.yieldPct != null ? ` (~${div.yieldPct}% yield)` : ''}
- Estimated NEXT ex-dividend date: ${div.nextExDateEst ? iso(div.nextExDateEst) : 'unknown'}${div.daysToNextEst != null ? ` (~${div.daysToNextEst} days away)` : ''} — projected from the payment cycle, not a company filing, so treat it as approximate
- Past ex-dates: ${div.history.map((h) => `${iso(h.exDate)} (${h.amount})`).join(', ')}

CRITICAL — dividend arithmetic:
* On an ex-dividend date the share price mechanically drops by roughly the dividend amount. This is not sentiment and not a trend.
* The forecast window covers these trading days: ${horizonDates.join(', ')}. If the estimated ex-date falls on or near any of them, SUBTRACT about ${div.typicalAmount} from your predicted closes from that day onward, and explain it in dividend_note.
* If an ex-date occurred within the last ~10 sessions (see above), part of the recent decline in the price history is that mechanical drop — do not read it as bearish momentum.
` : '';

    const newsBlock = news.length
      ? '\nRecent news headlines (newest first):\n' + news.slice(0, 8).map((n) => {
          const age = n.publishedAt ? Math.round((Date.now() - n.publishedAt) / 36e5) : null;
          return `- [${n.publisher}${age != null ? `, ${age < 24 ? age + 'h' : Math.round(age / 24) + 'd'} ago` : ''}] ${n.title}`;
        }).join('\n') + '\n'
      : '';

    const prompt = `You are an equity analyst. Analyze this stock and give a short-term (1-2 week) outlook.

Stock: ${data.name} (${data.symbol}), ${data.exchange}, currency ${data.currency}
Current price: ${stats.last}
Performance: 1w ${stats.change1w}%, 1m ${stats.change1m}%, 3m ${stats.change3m}%, 1y ${stats.change1y}%
20-day SMA: ${stats.sma20} | 50-day SMA: ${stats.sma50} | 200-day SMA: ${stats.sma200}
Daily volatility: ${stats.dailyVolPct}%
3-month range: ${stats.low3m} - ${stats.high3m}
52-week range: ${stats.fiftyTwoWeekLow} - ${stats.fiftyTwoWeekHigh}

Last 30 daily closes:
${recent}
${valBlock}${projBlock}${divBlock}${newsBlock}
Weigh the price action, the statistical position, the dividend calendar AND the news headlines. If a headline is significant (earnings, guidance, regulation, M&A), let it influence the outlook and predictions.

Respond with ONLY a JSON object, no other text:
{
  "outlook": "bullish" | "bearish" | "neutral",
  "confidence": "low" | "medium" | "high",
  "summary": "2-3 sentence overall assessment",
  "support": <number, key support level>,
  "resistance": <number, key resistance level>,
  "drivers": ["3-4 short bullet strings: what is driving the price action"],
  "risks": ["2-3 short bullet strings: what could invalidate this outlook"],
  "news_impact": "1-2 sentences: how the recent headlines affect this outlook (omit or null if no news was provided)",
  "dividend_note": "1-2 sentences: whether an ex-dividend date falls in the forecast window and how you adjusted the predicted prices for it, or how a recent ex-date distorted the price history (null if no dividend data was provided)",
  "valuation": "stretched low" | "below trend" | "near trend" | "above trend" | "stretched high",
  "valuation_note": "1-2 sentences citing the actual sigma numbers: where the price sits statistically, whether you expect mean reversion inside the forecast window, and why (or why not, if the trend argues against it). Null if no statistical position was provided.",
  "predictions": [
    {"d": 1, "price": <predicted close after 1 trading day>, "low": <plausible low>, "high": <plausible high>},
    {"d": 2, "price": ..., "low": ..., "high": ...},
    ... one entry for each of the next 7 trading days (d = 1 to 7)
  ]
}
The predicted low/high band should widen with the horizon, consistent with the stock's daily volatility of ${stats.dailyVolPct}%. Keep predictions realistic — small daily moves anchored to the current price and trend.`;

    // Nemotron 3 Super is a REASONING model: by default it generates a long
    // hidden thinking trace before the answer, which on the free shared
    // endpoint regularly takes 40s+ and blows the serverless time limit.
    // Strategy: try with a capped thinking budget first, fall back to
    // thinking-off (much faster), then to a plain request (in case the
    // endpoint rejects the reasoning-control parameters). All inside a hard
    // time budget so WE always answer clean JSON before the platform kills
    // the function (a platform timeout sends the browser an HTML error page).
    const makeBody = (mode) => {
      if (provider === 'openai') {
        // GPT-5-family models: use max_completion_tokens, leave sampling params
        // at defaults (non-default temperature is rejected by reasoning models).
        const body = {
          model: OPENAI_MODEL,
          messages: [{ role: 'user', content: prompt }],
          max_completion_tokens: 4096,
        };
        if (mode === 'effort') body.reasoning_effort = process.env.OPENAI_REASONING || 'low';
        return body;                           // 'plain' = no reasoning params (for non-reasoning models)
      }
      const body = {
        model: MODEL,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 4096,
        stream: false,
        temperature: 1.0,
        top_p: 0.95,
      };
      if (mode === 'budget') {
        body.chat_template_kwargs = { enable_thinking: true };
        body.reasoning_budget = 2048;          // cap hidden thinking tokens
      } else if (mode === 'fast') {
        body.chat_template_kwargs = { enable_thinking: false };
        body.temperature = 0.2;                // low temp recommended when thinking is off
      }
      return body;                             // 'plain' = no reasoning-control params
    };
    const PLAN = provider === 'openai'
      ? ['effort', 'plain']
      : process.env.NVIDIA_THINKING === 'off' ? ['fast', 'plain']
      : process.env.NVIDIA_THINKING === 'full' ? ['plain']
      : ['budget', 'fast', 'plain'];

    const TOTAL_BUDGET_MS = 50_000;   // stay under vercel.json maxDuration (60s)
    const started = Date.now();
    let r = null, errText = '', timedOut = false;
    for (const mode of PLAN) {
      const remaining = TOTAL_BUDGET_MS - (Date.now() - started);
      if (remaining < 8_000) { timedOut = true; break; }  // not enough time left for a real attempt
      try {
        r = await fetch(apiUrl, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(makeBody(mode)),
          signal: AbortSignal.timeout(Math.min(remaining - 2_000, 35_000)),
        });
      } catch {
        // Abort = this attempt ran out of time; try the next (faster) mode.
        timedOut = true; r = null;
        continue;
      }
      if (r.ok) break;
      errText = await r.text();
      if (r.status === 400 || r.status === 422) continue;  // params not supported → simpler body
      if (r.status === 503 || r.status === 429) {          // capacity → brief pause, then next mode
        await new Promise((ok) => setTimeout(ok, 1500));
        continue;
      }
      break; // real error (bad key, bad model id, …) — don't retry
    }

    if (!r || !r.ok) {
      const busy = r && (r.status === 503 || r.status === 429);
      return sendJson(res, 502, {
        error: !r
          ? (timedOut
              ? 'The model took too long to respond — try again.'
              : `Could not reach the ${providerName} API. Try again.`)
          : busy
            ? `The ${providerName} endpoint is busy or rate-limited right now (${r.status}). This is temporary — try again in a minute.`
            : `${providerName} API ${r.status}: ${errText.slice(0, 300)}`,
      });
    }
    const out = await r.json();
    const msg = out?.choices?.[0]?.message || {};
    const text = msg.content || msg.reasoning_content || '';
    const parsed = extractJson(text);
    if (parsed) {
      const lastPoint = data.points[data.points.length - 1];
      parsed.predictions = normalizePredictions(parsed, lastPoint, stats.last);
    }

    sendJson(res, 200, {
      symbol: data.symbol,
      name: data.name,
      currency: data.currency,
      stats,
      newsUsed: news.slice(0, 8).length,
      dividends: div,
      valuation: val,
      projected,
      provider,
      model: usedModel,
      forecast: parsed,
      raw: parsed ? undefined : text.slice(0, 2000),
      generatedAt: Date.now(),
    });
  } catch (e) {
    sendJson(res, 502, { error: String(e.message || e) });
  }
}
