// POST /api/forecast  { symbol }  -> AI outlook from NVIDIA Nemotron
// Requires env var NVIDIA_API_KEY (set it in Vercel project settings).
import { getChart, getNews, sendJson } from './_yahoo.js';
 
const NVIDIA_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';
const MODEL = process.env.NVIDIA_MODEL || 'nvidia/nemotron-3-super-120b-a12b';
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-5.5';
 
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
  return {
    last: round2(last),
    change1w: round2(pct(last, closes[closes.length - 6] ?? closes[0])),
    change1m: round2(pct(last, closes[closes.length - 22] ?? closes[0])),
    change3m: round2(pct(last, closes[0])),
    sma20: round2(sma(closes, 20)),
    sma50: round2(sma(closes, 50)),
    dailyVolPct: round2(dailyVol),
    high3m: round2(Math.max(...closes)),
    low3m: round2(Math.min(...closes)),
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
 
    const [data, news] = await Promise.all([
      getChart(symbol, '3mo'),
      getNews(symbol).catch(() => []),   // news is best-effort; forecast still works without it
    ]);
    const stats = buildStats(data);
    const recent = data.points.slice(-30).map((p) => `${new Date(p.t).toISOString().slice(0, 10)}: ${p.c}`).join('\n');
    const newsBlock = news.length
      ? '\nRecent news headlines (newest first):\n' + news.slice(0, 8).map((n) => {
          const age = n.publishedAt ? Math.round((Date.now() - n.publishedAt) / 36e5) : null;
          return `- [${n.publisher}${age != null ? `, ${age < 24 ? age + 'h' : Math.round(age / 24) + 'd'} ago` : ''}] ${n.title}`;
        }).join('\n') + '\n'
      : '';
 
    const prompt = `You are an equity analyst. Analyze this stock and give a short-term (1-2 week) outlook.
 
Stock: ${data.name} (${data.symbol}), ${data.exchange}, currency ${data.currency}
Current price: ${stats.last}
Performance: 1w ${stats.change1w}%, 1m ${stats.change1m}%, 3m ${stats.change3m}%
20-day SMA: ${stats.sma20} | 50-day SMA: ${stats.sma50}
Daily volatility: ${stats.dailyVolPct}%
3-month range: ${stats.low3m} - ${stats.high3m}
52-week range: ${stats.fiftyTwoWeekLow} - ${stats.fiftyTwoWeekHigh}
 
Last 30 daily closes:
${recent}
${newsBlock}
Weigh both the price action AND the news headlines in your analysis. If a headline is significant (earnings, guidance, regulation, M&A), let it influence the outlook and predictions.
 
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
        if (mode === 'effort') body.reasoning_effort = process.env.OPENAI_REASONING || 'medium';
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