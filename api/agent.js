// POST /api/agent  { messages: [{role, content}], provider?, context?, state? }
//
// Streams newline-delimited JSON events (application/x-ndjson):
//   {t:'status', text}                        what the assistant is doing
//   {t:'tool', phase:'start'|'end', tool, arg, ok?, ms?}
//   {t:'delta', text} / {t:'reset'}            answer text as it is written
//   {t:'continue', state}                      not finished: POST again with this state
//   {t:'done', reply, trace, provider, model, rounds, steps, elapsedMs}
//   {t:'error', error}
//   {t:'ping'}                                 keep-alive while waiting on the model
// Input errors come back as plain JSON with a 4xx/5xx status before streaming starts.
//
// The loop lives in _agent.js (see the comment there on why it runs in steps);
// this file turns HTTP into steps and supplies a streaming `callLLM`.
import { sendJson } from './_yahoo.js';
import { runAgentStep, sanitizeState } from './_agent.js';

// The assistant gets its own model defaults — deliberately NOT the forecast's
// OPENAI_MODEL / NVIDIA_MODEL. A research turn is 2–3 model calls, so a big
// reasoning model that is fine for one forecast is too slow here.
const PROVIDERS = {
  openai: {
    url: 'https://api.openai.com/v1/chat/completions',
    model: () => process.env.OPENAI_AGENT_MODEL || 'gpt-5.4-mini',
    key: () => process.env.OPENAI_API_KEY,
    envName: 'OPENAI_API_KEY',
  },
  nvidia: {
    url: 'https://integrate.api.nvidia.com/v1/chat/completions',
    model: () => process.env.NVIDIA_AGENT_MODEL || 'nvidia/nemotron-3-super-120b-a12b',
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

// Reads an OpenAI-compatible SSE stream into one message, forwarding text as
// it arrives. Tool-call fragments are stitched together by index.
async function readStream(res, onDelta, signal) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '', content = '';
  const calls = [];
  const take = (line) => {
    if (!line.startsWith('data:')) return false;
    const data = line.slice(5).trim();
    if (data === '[DONE]') return true;
    let j; try { j = JSON.parse(data); } catch { return false; }
    const d = j?.choices?.[0]?.delta || j?.choices?.[0]?.message || {};
    if (typeof d.content === 'string' && d.content) { content += d.content; onDelta?.(d.content); }
    for (const tc of d.tool_calls || []) {
      const i = Number.isInteger(tc.index) ? tc.index : calls.length;
      const slot = calls[i] || (calls[i] = { id: '', type: 'function', function: { name: '', arguments: '' } });
      if (tc.id) slot.id = tc.id;
      const n = tc.function?.name;
      if (n) slot.function.name = !slot.function.name || n.startsWith(slot.function.name) ? n : slot.function.name + n;
      const a = tc.function?.arguments;
      if (a) slot.function.arguments += typeof a === 'string' ? a : JSON.stringify(a);
    }
    return false;
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (take(line)) return { content, tool_calls: calls.filter(Boolean) };
      }
    }
    if (buf.trim()) take(buf.trim());
  } catch (e) {
    // Timed out mid-answer: keep what was written rather than losing it all.
    if (signal?.aborted && content.trim() && !calls.length) {
      return { content: content + '\n\n_(Answer cut off — the model ran out of time. Ask again for the rest.)_' };
    }
    throw e;
  }
  return { content, tool_calls: calls.filter(Boolean) };
}

function makeCallLLM(provider) {
  const p = PROVIDERS[provider];
  const model = p.model();
  const key = p.key();

  return async function callLLM({ messages, tools, toolChoice, remainingMs, onDelta }) {
    // Optional knobs that some models reject; dropped on a 400 and retried.
    let extras = provider === 'openai'
      ? { reasoning_effort: process.env.OPENAI_AGENT_REASONING || 'low' }
      : { temperature: 0.3, chat_template_kwargs: { enable_thinking: process.env.NVIDIA_THINKING === 'full' } };
    let stream = true;
    const deadline = Date.now() + remainingMs;

    for (let attempt = 0; attempt < 4; attempt++) {
      const left = deadline - Date.now();
      const body = { model, messages, stream, ...extras };
      if (provider === 'openai') body.max_completion_tokens = 4000; else body.max_tokens = 3000;
      if (tools) {
        body.tools = tools;
        if (toolChoice) body.tool_choice = toolChoice;
        if (provider === 'openai') body.parallel_tool_calls = true;
      }
      const signal = AbortSignal.timeout(Math.max(5_000, left - 1_500));
      let res;
      try {
        res = await fetch(p.url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: stream ? 'text/event-stream' : 'application/json' },
          body: JSON.stringify(body),
          signal,
        });
      } catch (e) {
        const err = new Error(e.name === 'TimeoutError' ? `The ${provider} model took too long to respond.` : `Could not reach ${provider}.`);
        err.status = 504;
        throw err;
      }
      if (res.ok) {
        const ct = res.headers.get('content-type') || '';
        try {
          if (stream && res.body && !ct.includes('application/json')) return await readStream(res, onDelta, signal);
          const j = await res.json();
          const m = j?.choices?.[0]?.message || { content: '' };
          if (m.content) onDelta?.(m.content);
          return m;
        } catch (e) {
          const err = new Error(signal.aborted ? `The ${provider} model took too long to respond.` : `Lost the connection to ${provider}.`);
          err.status = 504;
          throw err;
        }
      }
      const text = await res.text();
      // Capacity: brief pause, then retry.
      if ((res.status === 429 || res.status === 503) && attempt < 2 && left > 15_000) {
        await new Promise((ok) => setTimeout(ok, 1_500));
        continue;
      }
      if (res.status === 400) {
        // A rejected optional parameter: drop it and retry with tools intact.
        if (Object.keys(extras).length && /reasoning|chat_template|temperature|unsupported|unrecognized/i.test(text) && !/stream/i.test(text)) {
          extras = {};
          continue;
        }
        if (stream && /stream/i.test(text)) { stream = false; continue; }
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
  let body;
  try { body = await readBody(req); } catch { return sendJson(res, 400, { error: 'Invalid JSON body.' }); }

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
  let state = null;
  if (body.state != null) {
    if (JSON.stringify(body.state).length > 400_000) return sendJson(res, 413, { error: 'Conversation state too large — start a new chat.' });
    state = sanitizeState(body.state);
    if (!state) return sendJson(res, 400, { error: 'Invalid continuation state — start a new chat.' });
  }

  const ctx = body.context && typeof body.context === 'object' ? body.context : {};
  const context = {
    listName: typeof ctx.listName === 'string' ? ctx.listName.slice(0, 60) : null,
    tickers: Array.isArray(ctx.tickers) ? ctx.tickers.filter((t) => typeof t === 'string').slice(0, 20) : [],
    selected: typeof ctx.selected === 'string' ? ctx.selected.slice(0, 20) : null,
  };

  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  const emit = (o) => { try { res.write(JSON.stringify(o) + '\n'); } catch { /* client went away */ } };
  const ping = setInterval(() => emit({ t: 'ping' }), 8_000);
  const model = PROVIDERS[provider].model();

  try {
    const out = await runAgentStep({ messages: history, callLLM: makeCallLLM(provider), context, state, emit });
    if (out.done) {
      const { done, ...rest } = out;
      emit({ t: 'done', ...rest, provider, model });
    } else {
      emit({ t: 'continue', state: out.state });
    }
  } catch (e) {
    emit({ t: 'error', error: String(e.message || e), status: e.status || 502 });
  } finally {
    clearInterval(ping);
    res.end();
  }
}
