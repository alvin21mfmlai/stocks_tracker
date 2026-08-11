// POST /api/forecast  { symbol }  -> AI outlook from NVIDIA Nemotron
// Requires env var NVIDIA_API_KEY (set it in Vercel project settings).
import { getChart, sendJson } from './_yahoo.js';

const NVIDIA_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';
const MODEL = process.env.NVIDIA_MODEL || 'nvidia/nemotron-3-super-120b-a12b';

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
  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey) return sendJson(res, 500, { error: 'NVIDIA_API_KEY is not set on the server' });

  try {
    const { symbol } = await readBody(req);
    if (!symbol) return sendJson(res, 400, { error: 'symbol is required' });

    const data = await getChart(symbol, '3mo');
    const stats = buildStats(data);
    const recent = data.points.slice(-30).map((p) => `${new Date(p.t).toISOString().slice(0, 10)}: ${p.c}`).join('\n');

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

Respond with ONLY a JSON object, no other text:
{
  "outlook": "bullish" | "bearish" | "neutral",
  "confidence": "low" | "medium" | "high",
  "summary": "2-3 sentence overall assessment",
  "support": <number, key support level>,
  "resistance": <number, key resistance level>,
  "drivers": ["3-4 short bullet strings: what is driving the price action"],
  "risks": ["2-3 short bullet strings: what could invalidate this outlook"]
}`;

    const r = await fetch(NVIDIA_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: 'user', content: prompt }],
        temperature: 1.0,
        top_p: 0.95,
        max_tokens: 4096,
        stream: false,
      }),
    });

    if (!r.ok) {
      const errText = await r.text();
      return sendJson(res, 502, { error: `NVIDIA API ${r.status}: ${errText.slice(0, 300)}` });
    }
    const out = await r.json();
    const msg = out?.choices?.[0]?.message || {};
    const text = msg.content || msg.reasoning_content || '';
    const parsed = extractJson(text);

    sendJson(res, 200, {
      symbol: data.symbol,
      name: data.name,
      currency: data.currency,
      stats,
      model: MODEL,
      forecast: parsed,
      raw: parsed ? undefined : text.slice(0, 2000),
      generatedAt: Date.now(),
    });
  } catch (e) {
    sendJson(res, 502, { error: String(e.message || e) });
  }
}
