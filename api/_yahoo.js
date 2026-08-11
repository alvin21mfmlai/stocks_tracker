// Shared helpers for fetching stock data from Yahoo Finance (server-side).
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const HOSTS = ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com'];

async function yahooJson(path) {
  let lastErr;
  for (const host of HOSTS) {
    try {
      const r = await fetch(host + path, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
      if (!r.ok) { lastErr = new Error(`Yahoo HTTP ${r.status}`); continue; }
      return await r.json();
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('Yahoo fetch failed');
}

// range -> sensible interval
const INTERVALS = { '1d': '5m', '5d': '30m', '1mo': '1d', '3mo': '1d', '6mo': '1d', '1y': '1wk', '2y': '1wk', '5y': '1mo' };

export async function getChart(symbol, range = '1mo') {
  const interval = INTERVALS[range] || '1d';
  const j = await yahooJson(
    `/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}&includePrePost=false&events=div%2Csplit`
  );
  const res = j?.chart?.result?.[0];
  if (!res) {
    const desc = j?.chart?.error?.description || 'No data returned';
    throw new Error(desc);
  }
  const meta = res.meta || {};
  const ts = res.timestamp || [];
  const q = res.indicators?.quote?.[0] || {};
  const points = [];
  for (let i = 0; i < ts.length; i++) {
    const c = q.close?.[i];
    if (c == null) continue;
    points.push({
      t: ts[i] * 1000,
      o: q.open?.[i] ?? null,
      h: q.high?.[i] ?? null,
      l: q.low?.[i] ?? null,
      c: Number(c.toFixed(4)),
      v: q.volume?.[i] ?? null,
    });
  }
  return {
    symbol: meta.symbol || symbol,
    name: meta.longName || meta.shortName || symbol,
    currency: meta.currency || '',
    exchange: meta.fullExchangeName || meta.exchangeName || '',
    price: meta.regularMarketPrice ?? (points.length ? points[points.length - 1].c : null),
    prevClose: meta.chartPreviousClose ?? meta.previousClose ?? null,
    dayHigh: meta.regularMarketDayHigh ?? null,
    dayLow: meta.regularMarketDayLow ?? null,
    fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh ?? null,
    fiftyTwoWeekLow: meta.fiftyTwoWeekLow ?? null,
    marketState: meta.marketState || '',
    range,
    interval,
    points,
  };
}

export async function searchSymbols(q) {
  const j = await yahooJson(
    `/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=8&newsCount=0&listsCount=0`
  );
  return (j?.quotes || [])
    .filter((x) => x.symbol && (x.quoteType === 'EQUITY' || x.quoteType === 'ETF' || x.quoteType === 'INDEX'))
    .map((x) => ({
      symbol: x.symbol,
      name: x.longname || x.shortname || x.symbol,
      exchange: x.exchDisp || x.exchange || '',
      type: x.quoteType,
    }));
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n));
}

export async function getNews(symbol, count = 8) {
  // Primary source: Yahoo's per-ticker RSS feed — reliably scoped to the symbol
  // (the search endpoint does fuzzy text matching and returns unrelated wire
  // stories for tickers it can't match well, e.g. many non-US symbols).
  try {
    const r = await fetch(
      `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(symbol)}&region=US&lang=en-US`,
      { headers: { 'User-Agent': UA } }
    );
    if (r.ok) {
      const xml = await r.text();
      const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)]
        .map((m) => {
          const block = m[1];
          const pick = (tag) => {
            const mm = block.match(new RegExp(`<${tag}[^>]*>(?:\\s*<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>\\s*)?<\\/${tag}>`));
            return mm ? mm[1].trim() : '';
          };
          const pub = pick('pubDate');
          return {
            title: decodeEntities(pick('title')),
            publisher: decodeEntities(pick('source')) || 'Yahoo Finance',
            link: pick('link'),
            publishedAt: pub ? (Date.parse(pub) || null) : null,
          };
        })
        .filter((n) => n.title && n.link);
      if (items.length) {
        return items.sort((a, b) => (b.publishedAt || 0) - (a.publishedAt || 0)).slice(0, count);
      }
    }
  } catch {}

  // Fallback: search endpoint, but ONLY items explicitly tagged with this
  // ticker via relatedTickers. An empty list beats unrelated headlines.
  const j = await yahooJson(
    `/v1/finance/search?q=${encodeURIComponent(symbol)}&quotesCount=0&newsCount=${count * 3}&listsCount=0`
  );
  const want = symbol.toUpperCase();
  return (j?.news || [])
    .filter((n) => Array.isArray(n.relatedTickers) && n.relatedTickers.some((t) => String(t).toUpperCase() === want))
    .map((n) => ({
      title: n.title || '',
      publisher: n.publisher || '',
      link: n.link || '',
      publishedAt: n.providerPublishTime ? n.providerPublishTime * 1000 : null,
    }))
    .filter((n) => n.title)
    .sort((a, b) => (b.publishedAt || 0) - (a.publishedAt || 0))
    .slice(0, count);
}

export function sendJson(res, status, body, cacheSeconds = 0) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (cacheSeconds > 0) res.setHeader('Cache-Control', `s-maxage=${cacheSeconds}, stale-while-revalidate=30`);
  res.end(JSON.stringify(body));
}