// POST /api/agent  { messages: [{role, content}], provider?, context? }
//   -> { reply, trace, provider, model, rounds, mode, elapsedMs }
//
// The research assistant. The loop lives in _agent.js; this file only turns
// HTTP into a call and supplies `callLLM` for the chosen provider.
import { sendJson } from './_yahoo.js';
import { runAgent } from './_agent.js';

const PROVIDERS = {
  openai: {
    url: 'https://api.openai.com/v1/chat/completions',
    model: () => process.env.OPENAI_AGENT_MODEL || process.env.OPENAI_MODEL || 'gpt-5',
    key: () => process.env.OPENAI_API_KEY,
    envName: 'OPENAI_API_KEY',
  },
  nvidia: {
    url: 'https://integrate.api.nvidia.com/v1/chat/completions',
    model: () => process.env.NVIDIA_AGENT_MODEL || process.env.NVIDIA_MODEL || 'nvidia/nemotron-3-super-120b-a12b',
    key: () => process.env.NVIDIA_API_KEY,
    envName: 'NVIDIA_API_KEY',
  },
};

async function readBody(req) {
  if (req.body) return typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

// Keep the conversation bounded: recent turns only, plain text only.
function cleanHistory(messages) {
  return (Array.isArray(messages) ? messages : [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .slice(-12)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));
}

function makeCallLLM(provider) {
  const p = PROVIDERS[provider];
  const model = p.model();
  const key = p.key();

  return async function callLLM({ messages, tools, toolChoice, remainingMs }) {
    // Optional knobs that some models reject; dropped on a 400 and retried.
    let extras = provider === 'openai'
      ? { reasoning_effort: process.env.OPENAI_REASONING || 'low' }
      : { temperature: 0.3, chat_template_kwargs: { enable_thinking: process.env.NVIDIA_THINKING === 'full' } };

    for (let attempt = 0; attempt < 3; attempt++) {
      const body = { model, messages, ...extras };
      if (provider === 'openai') body.max_completion_tokens = 4000; else body.max_tokens = 3000;
      if (tools) {
        body.tools = tools;
        if (toolChoice) body.tool_choice = toolChoice;
        if (provider === 'openai') body.parallel_tool_calls = true;
      }
      const timeout = Math.max(5_000, Math.min(remainingMs - 1_500, 40_000));
      let res;
      try {
        res = await fetch(p.url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeout),
        });
      } catch (e) {
        const err = new Error(e.name === 'TimeoutError' ? 'The model took too long to respond.' : `Could not reach ${provider}.`);
        err.status = 504;
        throw err;
      }
      if (res.ok) {
        const j = await res.json();
        return j?.choices?.[0]?.message || { content: '' };
      }
      const text = await res.text();
      // Capacity: brief pause, then retry.
      if ((res.status === 429 || res.status === 503) && attempt < 2 && remainingMs > 15_000) {
        await new Promise((ok) => setTimeout(ok, 1_500));
        continue;
      }
      // A rejected optional parameter: drop the extras and retry with tools intact.
      if (res.status === 400 && Object.keys(extras).length && /reasoning|chat_template|temperature|unsupported|unrecognized/i.test(text)) {
        extras = {};
        continue;
      }
      const err = new Error(`${provider} ${res.status}: ${text.slice(0, 240)}`);
      err.status = res.status;
      throw err;
    }
    const err = new Error(`${provider} is at capacity — try again shortly.`);
    err.status = 503;
    throw err;
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST only' });
  try {
    const body = await readBody(req);
    const history = cleanHistory(body.messages);
    if (!history.length || history[history.length - 1].role !== 'user') {
      return sendJson(res, 400, { error: 'Send at least one user message.' });
    }
    // The assistant needs reliable tool calling, so it prefers OpenAI when a key
    // exists — but honours an explicit choice.
    let provider = body.provider === 'nvidia' || body.provider === 'openai' ? body.provider : null;
    if (!provider) provider = process.env.OPENAI_API_KEY ? 'openai' : 'nvidia';
    if (!PROVIDERS[provider].key()) {
      return sendJson(res, 500, { error: `${PROVIDERS[provider].envName} is not set on the server.` });
    }

    const ctx = body.context && typeof body.context === 'object' ? body.context : {};
    const context = {
      listName: typeof ctx.listName === 'string' ? ctx.listName.slice(0, 60) : null,
      tickers: Array.isArray(ctx.tickers) ? ctx.tickers.filter((t) => typeof t === 'string').slice(0, 20) : [],
      selected: typeof ctx.selected === 'string' ? ctx.selected.slice(0, 20) : null,
    };

    const out = await runAgent({
      messages: history,
      callLLM: makeCallLLM(provider),
      context,
      budgetMs: 52_000,   // vercel.json gives this function 60s
      maxRounds: 5,
    });
    sendJson(res, 200, { ...out, provider, model: PROVIDERS[provider].model() });
  } catch (e) {
    const status = e.status === 429 || e.status === 503 ? 503 : e.status === 504 ? 504 : 502;
    sendJson(res, status, { error: String(e.message || e) });
  }
}
