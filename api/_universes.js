// Stock universes for the screener and the assistant.
//
// Each category is a curated group of liquid, well-covered names that are
// genuinely comparable — the screener ranks WITHIN a group, so a bank is only
// ever compared with banks. Edit freely: add a category, or change tickers.
// Keep ids stable (the UI and the assistant refer to them) and avoid ETFs here,
// since funds have no fundamentals to rank on.
//
// `profile` picks the factor weights in _screener.js:
//   growth    — quality + growth dominate (tech, semis, cyber)
//   bank      — ROE, P/B, dividends; cash-flow/debt ratios are skipped
//   resources — cyclical: valuation and balance-sheet strength matter more
//   defensive — steady quality, moderate growth, some income
//   blend     — mixed groups (e.g. Singapore blue chips)
export const UNIVERSES = [
  {
    id: 'tech', name: 'Big Tech', profile: 'growth',
    blurb: 'Mega-cap platforms and software',
    tickers: ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META', 'NVDA', 'ORCL', 'CRM', 'ADBE', 'NOW'],
  },
  {
    id: 'semis', name: 'Semiconductors', profile: 'growth',
    blurb: 'Chip designers, foundries and equipment makers',
    tickers: ['NVDA', 'AMD', 'AVGO', 'TSM', 'ASML', 'MU', 'QCOM', 'ARM', 'AMAT', 'LRCX'],
  },
  {
    id: 'cyber', name: 'Cybersecurity', profile: 'growth',
    blurb: 'Security platforms and specialists',
    tickers: ['PANW', 'CRWD', 'FTNT', 'ZS', 'NET', 'S', 'OKTA', 'CHKP', 'QLYS', 'RBRK'],
  },
  {
    id: 'banks_us', name: 'US banks', profile: 'bank',
    blurb: 'Large US money-centre and regional banks',
    tickers: ['JPM', 'BAC', 'WFC', 'C', 'GS', 'MS', 'USB', 'PNC'],
  },
  {
    id: 'banks_sg', name: 'Singapore banks', profile: 'bank',
    blurb: 'The three SGX-listed local banks',
    tickers: ['D05.SI', 'O39.SI', 'U11.SI'],
  },
  {
    id: 'sg_blue', name: 'Singapore blue chips', profile: 'blend',
    blurb: 'Large STI constituents across sectors',
    tickers: ['D05.SI', 'O39.SI', 'U11.SI', 'Z74.SI', 'S68.SI', 'S63.SI', 'BN4.SI', 'C6L.SI', 'F34.SI', 'Y92.SI'],
  },
  {
    id: 'mining', name: 'Minerals & mining', profile: 'resources',
    blurb: 'Diversified miners, copper, lithium and rare earths',
    tickers: ['BHP', 'RIO', 'VALE', 'FCX', 'SCCO', 'TECK', 'MP', 'ALB'],
  },
  {
    id: 'precious', name: 'Precious metals', profile: 'resources',
    blurb: 'Gold and silver miners and royalty companies',
    tickers: ['NEM', 'AEM', 'GFI', 'WPM', 'FNV', 'KGC', 'AU', 'PAAS'],
  },
  {
    id: 'health', name: 'Healthcare & biomedical', profile: 'defensive',
    blurb: 'Pharma, biotech and medical devices',
    tickers: ['LLY', 'NVO', 'JNJ', 'MRK', 'ABBV', 'AMGN', 'VRTX', 'REGN', 'GILD', 'ISRG'],
  },
  {
    id: 'energy', name: 'Energy', profile: 'resources',
    blurb: 'Integrated oil & gas and services',
    tickers: ['XOM', 'CVX', 'COP', 'SHEL', 'TTE', 'BP', 'EOG', 'SLB'],
  },
];

export const universeById = (id) => UNIVERSES.find((u) => u.id === id) || null;

export const categoryList = () =>
  UNIVERSES.map(({ id, name, blurb, profile, tickers }) => ({ id, name, blurb, profile, size: tickers.length, tickers }));
