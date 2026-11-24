// Radar scoring, second draft: a snapshot in, a ranked board out.
//
// Every protocol in the snapshot is either waiting for a token or already trading one.
// This file scores only the waiting ones. The score is the snapshot's own arithmetic:
// take the median market-cap-per-TVL of the live protocols in the same category (or the
// global median when the category has too few live names to trust), then let the week's
// growth and the protocol's age bend it. Nothing here names a protocol, so the same
// arithmetic scores every row, and the dashboard can show its working.

export type Proto = {
  slug: string; name: string; category: string | null; chains: string[];
  tvl_usd: number; change_7d: number | null; mcap_usd: number | null;
  listed_at: string | null; gecko_id: string | null; symbol: string | null;
};

export type Snap = {
  as_of: string; source: string; floor_usd: number;
  protocols: Proto[]; watchlist: string[];
};

export type Tuning = {
  min_category_sample: number; multiple_floor: number; multiple_cap: number;
  growth_weight: number; growth_floor: number; growth_cap: number;
  maturity_floor: number; maturity_range: number; maturity_days: number; unknown_age_days: number;
};

// The tuning the dashboard prints and the scorer runs. Key order is the order the
// dashboard's data file carries them in, so keep it.
export const TUNING: Tuning = {
  min_category_sample: 5, multiple_floor: 0.05,
  multiple_cap: 0.5, growth_weight: 0.5,
  growth_floor: -60, growth_cap: 120,
  maturity_floor: 0.6, maturity_range: 0.4,
  maturity_days: 1095, unknown_age_days: 365,
};

export const MODEL_VERSION = 'radar-2'; // the model the dashboard names
export const LIVE_ROWS = 24; // how many traded rows the live view carries

export type CatRate = {
  category: string; sample: number; multiple: number; source: 'category' | 'global';
};

export type PlanStep = { text: string; cost: string; time: string };

export type BoardEntry = {
  rank: number; slug: string; name: string; category: string | null; chains: string[];
  tvl_usd: number; change_7d: number | null; mcap_usd: number | null;
  listed_at: string | null; gecko_id: string | null; symbol: string | null;
  token_status: 'pre-token'; age_days: number | null; implied_value_usd: number;
  model: { multiple: number; multiple_source: 'category' | 'global'; multiple_sample: number;
    growth_pct: number; growth_multiplier: number; maturity_multiplier: number; age_days: number | null; };
  farm_steps: string[]; // the six-step plan, as finished strings
};

export type DashRow = {
  rank: number; slug: string; name: string; category: string | null; chains: string[];
  tvl_usd: number; change_7d: number | null; mcap_usd: number | null;
  listed_at: string | null; age_days: number | null; implied_value_usd: number;
  multiple: number; multiple_source: 'category' | 'global';
  growth_multiplier: number; maturity_multiplier: number;
};

export type TradedRow = {
  slug: string; name: string; category: string | null; chains: string[];
  tvl_usd: number; mcap_usd: number | null; change_7d: number | null;
};

export type DashData = {
  as_of: string; source: string; floor_usd: number; model: Tuning; model_version: string;
  global_multiple: number; multiples: CatRate[];
  watchlist_size: number; board_size: number; early_size: number; live_size: number;
  rows: DashRow[]; live: TradedRow[];
};

export class SnapshotError extends Error { // thrown when the snapshot is not the shape this file scores
  constructor(msg: string) {
    super(msg);
    this.name = 'SnapshotError'; // so a caught error names itself
  }
}

const MS_PER_DAY = 86_400_000;

function numOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback; // finite number, else the fallback
}

function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

// Whole days from the listing date to the snapshot date; null when the listing date
// is missing or unparseable. Dates are read as UTC midnights so time zones never leak in.
export function daysSince(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null; // no listing date, no age
  const end = Date.parse(`${asOf}T00:00:00Z`);
  const start = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(end) || !Number.isFinite(start)) return null;
  return Math.max(0, Math.floor((end - start) / MS_PER_DAY));
}

// Middle value of a sorted list; for an even count this takes the upper middle.
function middle(sorted: number[]): number {
  const at = Math.floor(sorted.length / 2);
  return sorted[at]!;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

// One multiple per category, learned from the live protocols in this snapshot, plus the
// global median across every live protocol. A category with fewer live names than the
// tuning asks for borrows the global median, so a lone outlier never prices a category.
// The global median itself is not clamped; only a category's own median is.
export function categoryRates(
  protocols: Proto[],
  tuning: Tuning = TUNING,
): { byCategory: Map<string, CatRate>; global: number } {
  const traded = protocols.filter((p) => p.mcap_usd !== null && p.tvl_usd > 0);
  const ratios = traded.map((p) => p.mcap_usd! / p.tvl_usd).sort((a, b) => a - b);
  const global = middle(ratios);
  const perCat = new Map<string, number[]>();
  for (const p of traded) {
    const bucketKey = p.category ?? 'Other';
    const bucket = perCat.get(bucketKey) ?? [];
    bucket.push(p.mcap_usd! / p.tvl_usd);
    perCat.set(bucketKey, bucket);
  }
  const byCategory = new Map<string, CatRate>();
  for (const [category, values] of perCat) {
    const ordered = values.sort((a, b) => a - b);
    if (ordered.length >= tuning.min_category_sample) {
      byCategory.set(category, {
        category,
        sample: ordered.length,
        multiple: clamp(middle(ordered), tuning.multiple_floor, tuning.multiple_cap),
        source: 'category',
      });
    } else byCategory.set(category, { category, sample: ordered.length, multiple: global, source: 'global' });
  }
  return { byCategory, global }; // the per-category table and the fallback
}

export function rateFor(
  category: string | null,
  rates: { byCategory: Map<string, CatRate>; global: number },
): CatRate {
  const found = rates.byCategory.get(category ?? 'Other');
  if (found !== undefined) return found; // the category has live names to learn from
  return { category: category ?? 'Other', sample: 0, multiple: rates.global, source: 'global' };
}

export function scoreOne(
  proto: Proto, asOf: string,
  rates: { byCategory: Map<string, CatRate>; global: number },
  tuning: Tuning = TUNING,
): {
  implied: number; multiple: number; multipleSource: 'category' | 'global'; multipleSample: number;
  growthPct: number; growthMult: number; maturityMult: number; age: number | null;
} {
  const age = daysSince(asOf, proto.listed_at);
  const rate = rateFor(proto.category, rates);
  const growthPct = clamp(numOr(proto.change_7d, 0), tuning.growth_floor, tuning.growth_cap);
  const growthMult = 1 + (growthPct / 100) * tuning.growth_weight;
  const aged = age ?? tuning.unknown_age_days;
  const maturityMult =
    tuning.maturity_floor +
    (clamp(aged, 0, tuning.maturity_days) / tuning.maturity_days) * tuning.maturity_range;
  const implied = Math.max(1, Math.round(proto.tvl_usd * rate.multiple * growthMult * maturityMult));
  const scored = {
    implied, multiple: rate.multiple, multipleSource: rate.source, multipleSample: rate.sample,
    growthPct, growthMult, maturityMult, age,
  };
  return scored;
}

// A name ending in a release tag (V2, v2, 2.0 and the like) is a pool of another protocol.
const RELEASE_TAG = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
// Categories that are themselves a wrapped, staked or bridged form of a traded token.
const WRAPPED_CATS = new Set([
  'Bridge',
  'Canonical Bridge',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
  'CEX',
]);
// A whole word in the name that says wrapped or staked.
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i; // whole-word match, any case
// A name that starts with an exchange's own name.
const EXCHANGE_START = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/;

export function isUnlaunched(p: Proto): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null; // no token on record at all
}

// Rankable means unlaunched and not a wrapped, staked or bridged form of a token that
// already trades — the same rule the watchlist was drawn with.
export function canRank(p: Proto): boolean {
  if (!isUnlaunched(p)) return false;
  if (WRAPPED_CATS.has(p.category ?? '')) return false;
  if (RELEASE_TAG.test(p.name)) return false;
  if (WRAPPED_WORD.test(p.name)) return false;
  if (EXCHANGE_START.test(p.name)) return false;
  return true;
}

function firstChain(p: Proto): string {
  const first = p.chains[0];
  return first !== undefined ? first : 'its main chain';
}

function stakeFor(p: Proto): number {
  if (p.tvl_usd >= 5_000_000_000) return 250; // largest protocols get the largest position
  if (p.tvl_usd >= 1_000_000_000) return 150; // mid-large protocols
  if (p.tvl_usd >= 100_000_000) return 100; // mid protocols
  return 50; // small protocols, small stake
}

function holdFor(age: number | null): number {
  if (age === null) return 30; // unknown age holds the standard window
  if (age < 180) return 60; // young protocols need a longer qualifying window
  if (age < 365) return 45; // under a year old
  return 30; // a year or older
}

function feeFor(chain: string): string {
  const lowered = chain.toLowerCase();
  if (lowered === 'ethereum') return 'about $8–15 of gas on mainnet';
  if (lowered === 'solana') return 'under $0.10 of network fees';
  const cheap = ['base', 'arbitrum', 'optimism', 'polygon', 'blast', 'linea', 'scroll', 'zksync era'];
  if (cheap.includes(lowered)) return 'under $1 of gas'; // rollups and cheap chains
  return 'a few dollars of gas'; // anything else
}

// The farm actions, in the order they are tried: the first rule whose words match the
// category wins. Each rule builds its sentence from the stake, the name and the chain.
type ActionRule = {
  words: string[];
  build: (stake: number, label: string, venue: string) => string;
};

const ACTION_RULES: ActionRule[] = [
  {
    words: ['lend', 'cdp', 'collateral'],
    build: (stake, label, venue) => `Supply $${stake} of USDC to ${label} on ${venue} and keep the position open.`,
  },
  {
    words: ['dex', 'yield', 'leveraged farm'],
    build: (stake, label, venue) => `Provide $${stake} of liquidity to ${label}'s main pool on ${venue} and keep the position open.`,
  },
  {
    words: ['bridge'],
    build: (stake, label, venue) => `Bridge $${stake} of USDC to ${venue} through ${label} and use the bridged funds in its app.`,
  },
  {
    words: ['staking', 'restak'],
    build: (stake, label) => `Stake $${stake} of the chain's staking asset through ${label} and keep the receipt.`,
  },
  {
    words: ['perpetual', 'derivative'],
    build: (stake, label) => `Deposit $${stake} of USDC as margin on ${label} and open one small hedge.`,
  },
  {
    words: ['prediction'],
    build: (stake, label) => `Fund $${stake} and place one market position on ${label}.`,
  },
  {
    words: ['curator', 'allocator'],
    build: (stake, label, venue) => `Deposit $${stake} into a ${label} vault on ${venue} and keep the shares.`,
  },
  {
    words: ['stable'],
    build: (stake, label, venue) => `Mint or deposit $${stake} of the stable asset through ${label} on ${venue}.`,
  },
  {
    words: ['rwa'],
    build: (stake, label, venue) => `Mint $${stake} of the protocol's yield asset on ${venue} and hold it.`,
  },
  {
    words: ['insurance'],
    build: (stake, label, venue) => `Buy $${stake} of cover from ${label} on ${venue} and keep the policy.`,
  },
];

function actionText(p: Proto, stake: number, chain: string): string {
  const cat = (p.category ?? '').toLowerCase();
  for (const rule of ACTION_RULES) {
    if (rule.words.some((w) => cat.includes(w))) return rule.build(stake, p.name, chain);
  }
  return `Deposit $${stake} of USDC into ${p.name} on ${chain} and keep the position open.`;
}

// The weekly habit, by the same category words, in the same order.
const WEEKLY_RULES: Array<{ words: string[]; line: string }> = [
  {
    words: ['lend', 'cdp', 'collateral'],
    line: 'Borrow a small amount against the deposit, then repay it the same week.',
  },
  {
    words: ['dex', 'yield', 'leveraged farm'],
    line: 'Swap a small amount through the pool, or add and remove a little liquidity.',
  },
  { words: ['bridge'], line: 'Bridge a small amount back and forth, or use the bridged funds once in the app.' },
  {
    words: ['perpetual', 'derivative'],
    line: 'Open and close one small position, and keep the margin topped up.',
  },
  { words: ['prediction'], line: 'Place one small market position, or settle one that closed.' },
  {
    words: ['curator', 'allocator'],
    line: "Check the vault's allocation, and add or move a small amount.",
  },
  {
    words: ['rwa', 'stable'],
    line: 'Claim the yield the position earns, or top the position up a little.',
  },
];

function weeklyText(p: Proto): string {
  const cat = (p.category ?? '').toLowerCase();
  for (const rule of WEEKLY_RULES) {
    if (rule.words.some((w) => cat.includes(w))) return rule.line;
  }
  return ['Make one qualifying action, such as a deposit,', ' a borrow, a swap or a vote.'].join('');
}

// One step as a single string: the action, then what it costs and how long it takes.
export function renderStep(step: PlanStep): string {
  let s = step.text + ' Cost: ' + step.cost + '. Time: ' + step.time + '.';
  if (s.length > 600) s = s.slice(0, 596) + '...'; // the gate refuses steps past 600 characters
  if (s.length < 20) s += " Hold the position and check the protocol's own page.";
  return s; // the finished step string
}

// Six steps per protocol, all derived from its own record — category, first chain, TVL
// and age — never from a hand-written list of names.
export function planFor(p: Proto, age: number | null): PlanStep[] {
  const chain = firstChain(p);
  const stake = stakeFor(p);
  const hold = holdFor(age);
  const steps: PlanStep[] = [
    {
      text: [
        'Use a fresh wallet that holds only the funds you plan to farm,',
        ' and keep its seed phrase offline.',
      ].join(''),
      cost: 'under $3 of gas for the first transaction', time: '5 minutes',
    },
    {
      text: actionText(p, stake, chain),
      cost: `$${stake} of capital and ${feeFor(chain)}`, time: '15 minutes to set up',
    },
    {
      text: `${weeklyText(p)} Do it once a week so the wallet shows steady use, not one burst.`,
      cost: 'about $2 of gas a week', time: '10 minutes a week',
    },
    {
      text: [
        `Hold the position for at least ${hold} days`,
        ' so the activity is counted in more than one snapshot.',
      ].join(''),
      cost: `the $${stake} stays in the position`, time: `${hold} days`,
    },
    {
      text: [
        "Before you withdraw, open the protocol's own points or rewards page from its official docs",
        ' and check the position is counted, and claim only from a link the protocol itself publishes.',
      ].join(''),
      cost: 'no fee to check, and never pay to claim', time: '10 minutes',
    },
    {
      text: [
        'Write the wallet, the dates and every transaction hash in a farm log,',
        " and set a reminder for the hold's end date so you can unwind or renew on purpose.",
      ].join(''),
      cost: 'nothing but the log', time: '5 minutes',
    },
  ];
  return steps;
}

function indexBySlug(protocols: Proto[]): Map<string, Proto> {
  const bySlug = new Map<string, Proto>();
  for (const p of protocols) bySlug.set(p.slug, p);
  return bySlug;
}

// The board: every watchlist slug first (the floor, never the ceiling), then every
// rankable protocol below the floor. Ranked strongest first; a tie breaks on slug.
export function scoreBoard(snapshot: Snap, tuning: Tuning = TUNING): BoardEntry[] {
  const rates = categoryRates(snapshot.protocols, tuning);
  const index = indexBySlug(snapshot.protocols);
  const picked = new Map<string, Proto>();
  for (const slug of snapshot.watchlist) { // watchlist rows are never dropped
    const found = index.get(slug);
    if (found !== undefined) picked.set(slug, found);
  }
  for (const p of snapshot.protocols) { // then the early radar below the floor
    const belowFloor = p.tvl_usd < snapshot.floor_usd;
    if (!picked.has(p.slug) && canRank(p) && belowFloor) picked.set(p.slug, p);
  }
  const scored = [...picked.values()].map((proto) => ({ proto, ...scoreOne(proto, snapshot.as_of, rates, tuning) }));
  scored.sort(
    (a, b) => b.implied - a.implied || (a.proto.slug < b.proto.slug ? -1 : a.proto.slug > b.proto.slug ? 1 : 0),
  );
  return scored.map((s, pos) => ({
    rank: pos + 1, slug: s.proto.slug, name: s.proto.name, category: s.proto.category,
    chains: s.proto.chains, tvl_usd: s.proto.tvl_usd, change_7d: s.proto.change_7d,
    mcap_usd: s.proto.mcap_usd, listed_at: s.proto.listed_at, gecko_id: s.proto.gecko_id,
    symbol: s.proto.symbol, token_status: 'pre-token' as const, age_days: s.age,
    implied_value_usd: s.implied, model: {
      multiple: s.multiple, multiple_source: s.multipleSource, multiple_sample: s.multipleSample,
      growth_pct: s.growthPct, growth_multiplier: round4(s.growthMult),
      maturity_multiplier: round4(s.maturityMult), age_days: s.age,
    },
    farm_steps: planFor(s.proto, s.age).map(renderStep),
  }));
}

// The live-token protocols, richest first, for the dashboard's traded view.
export function tradedRows(snapshot: Snap): TradedRow[] {
  const traded = snapshot.protocols.filter((p) => !isUnlaunched(p) && p.category !== 'CEX');
  traded.sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd);
  return traded.slice(0, LIVE_ROWS).map((p) => ({
    slug: p.slug, name: p.name, category: p.category, chains: p.chains,
    tvl_usd: p.tvl_usd, mcap_usd: p.mcap_usd, change_7d: p.change_7d,
  }));
}

function compactRow(row: BoardEntry): DashRow {
  const compact: DashRow = {
    rank: row.rank, slug: row.slug, name: row.name, category: row.category, chains: row.chains,
    tvl_usd: row.tvl_usd, change_7d: row.change_7d, mcap_usd: row.mcap_usd,
    listed_at: row.listed_at, age_days: row.age_days, implied_value_usd: row.implied_value_usd,
    multiple: row.model.multiple, multiple_source: row.model.multiple_source,
    growth_multiplier: row.model.growth_multiplier, maturity_multiplier: row.model.maturity_multiplier,
  };
  return compact;
}

// Everything the dashboard renders, from one snapshot.
export function buildDashboardData(snapshot: Snap, tuning: Tuning = TUNING): { board: BoardEntry[]; radar: DashData } {
  const board = scoreBoard(snapshot, tuning);
  const live = tradedRows(snapshot);
  const rates = categoryRates(snapshot.protocols, tuning);
  const early = board.filter((r) => !snapshot.watchlist.includes(r.slug)).length; // rows below the floor
  const rateList = [...rates.byCategory.values()].sort((a, b) =>
    a.category < b.category ? -1 : a.category > b.category ? 1 : 0,
  );
  const radar: DashData = {
    as_of: snapshot.as_of, // the snapshot's own date
    // The snapshot's source line carries a URL; the page renders with no network, so the
    // address is cut before the string ships in data.js. What stays is where the figures
    // came from: "DefiLlama, fetched <timestamp>".
    source: snapshot.source.replace(/\s*https?:\/\/\S+/, '').trim(), // strip the address
    floor_usd: snapshot.floor_usd, model: tuning, model_version: MODEL_VERSION,
    global_multiple: round4(rates.global), multiples: rateList,
    watchlist_size: snapshot.watchlist.length, board_size: board.length,
    early_size: early, live_size: live.length,
    rows: board.map(compactRow), live,
  };
  const out = { board, radar };
  return out;
}

// The snapshot out of a file's text, refused unless it is the shape this file scores.
export function readSnapshot(text: string): Snap {
  let raw: unknown; // the parsed JSON, checked piece by piece below
  try { raw = JSON.parse(text); } catch {
    throw new SnapshotError('snapshot text is not valid JSON'); // unparseable input
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new SnapshotError('snapshot text is not a JSON object');
  }
  const doc = raw as Record<string, unknown>;
  if (typeof doc.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(doc.as_of)) {
    throw new SnapshotError('snapshot is missing its as_of date');
  }
  if (typeof doc.source !== 'string') throw new SnapshotError('snapshot is missing its source line');
  if (typeof doc.floor_usd !== 'number' || !Number.isSafeInteger(doc.floor_usd) || doc.floor_usd <= 0) {
    throw new SnapshotError('snapshot is missing a usable floor_usd');
  }
  if (!Array.isArray(doc.protocols)) throw new SnapshotError('snapshot is missing its protocols array');
  if (!Array.isArray(doc.watchlist) || doc.watchlist.some((s) => typeof s !== 'string')) {
    throw new SnapshotError('snapshot is missing its watchlist of slugs');
  }
  const protocols = doc.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) {
      throw new SnapshotError(`snapshot protocol ${i} is not an object`);
    }
    const entry = v as Record<string, unknown>;
    if (
      typeof entry.slug !== 'string' ||
      typeof entry.name !== 'string' ||
      typeof entry.tvl_usd !== 'number' ||
      !Number.isFinite(entry.tvl_usd)
    ) {
      throw new SnapshotError(`snapshot protocol ${i} has no slug, name or TVL`);
    }
    const cleaned = {
      slug: entry.slug, name: entry.name,
      category: typeof entry.category === 'string' ? entry.category : null,
      chains: Array.isArray(entry.chains)
        ? entry.chains.filter((c): c is string => typeof c === 'string')
        : [],
      tvl_usd: entry.tvl_usd,
      change_7d: typeof entry.change_7d === 'number' && Number.isFinite(entry.change_7d) ? entry.change_7d : null,
      mcap_usd: typeof entry.mcap_usd === 'number' && Number.isFinite(entry.mcap_usd) ? entry.mcap_usd : null,
      listed_at: typeof entry.listed_at === 'string' ? entry.listed_at : null,
      gecko_id: typeof entry.gecko_id === 'string' ? entry.gecko_id : null,
      symbol: typeof entry.symbol === 'string' ? entry.symbol : null,
    };
    return cleaned;
  });
  const snap: Snap = {
    as_of: doc.as_of, source: doc.source, floor_usd: doc.floor_usd,
    protocols, watchlist: doc.watchlist as string[],
  };
  return snap;
}

// Why a board is not one the gate will take, or null: coverage, ranks, order, one shared
// implied value, and farm steps.
export function checkBoard(board: BoardEntry[], snapshot: Snap): string | null {
  const present = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !present.has(s));
  if (missing.length > 0) {
    const shown = missing.slice(0, 5).join(', ');
    return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${shown}`;
  }
  const orderedRanks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < orderedRanks.length; i++) {
    if (orderedRanks[i] !== i + 1) return `rank ${i + 1} is ${orderedRanks[i]}`;
  }
  for (let i = 1; i < board.length; i++) {
    if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) {
      return `row ${i + 1} outranks row ${i} on implied value`;
    }
  }
  const first = board[0]!.implied_value_usd;
  const last = board[board.length - 1]!.implied_value_usd;
  if (board.length >= 2 && first === last) {
    return `all ${board.length} rows share the same implied value $${first}: a board that ranks nothing by value is not a ranking`;
  }
  for (const entry of board) {
    if (entry.farm_steps.length < 3 || entry.farm_steps.length > 12) {
      return `${entry.slug} has ${entry.farm_steps.length} farm steps`;
    }
    for (const s of entry.farm_steps) {
      if (s.length < 20 || s.length > 600) return `${entry.slug} has a farm step of ${s.length} characters`;
    }
    if (!Number.isSafeInteger(entry.implied_value_usd) || entry.implied_value_usd <= 0) {
      return `${entry.slug} has implied value ${entry.implied_value_usd}`;
    }
  }
  return null; // nothing wrong with this board
}

// The dashboard's whole dataset as one script: no fetch, no network.
export function dashboardScript(radar: DashData): string {
  const payload = JSON.stringify(radar);
  return 'window.RADAR=' + payload + ';\n';
}

// Backwards-compatible names for the entry program's imports.
export {
  buildDashboardData as buildRadar,
  checkBoard as boardIssue,
  dashboardScript as dataScript,
  readSnapshot as parseSnapshot,
  scoreBoard as buildBoard,
  TUNING as MODEL,
};
export type { Proto as SnapshotProtocol, Snap as Snapshot, Tuning as ModelConstants, BoardEntry as BoardRow, DashRow as RadarRow, TradedRow as LiveRow, DashData as RadarData, CatRate as CategoryMultiple, PlanStep as FarmStep };
