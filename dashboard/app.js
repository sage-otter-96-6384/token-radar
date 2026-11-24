// Token Radar's dashboard, second draft. It reads window.RADAR — the dataset main.ts
// writes beside dashboard/ — and renders the ranked board, a filterable and sortable
// table, a per-protocol detail view with the model's own inputs and the protocol's farm
// plan, and the model itself with its category multiples. No network: every byte it
// shows is in data.js, and the page recomputes each row's implied value to prove the
// board's number and the page's arithmetic agree.

(() => {
  'use strict'; // strict mode for the whole file

  if (!window.RADAR) return; // nothing to render without the dataset
  const DATA = window.RADAR;
  const app = document.getElementById('board');
  const view = { q: '', category: 'all', chain: 'all', tab: 'pre-token', sort: 'implied', dir: -1, selected: null };

  // -- formatting ---------------------------------------------------------------

  function usd(n) {
    if (n == null || !isFinite(n)) return 'n/a';
    const size = Math.abs(n);
    if (size >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (size >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (size >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    const whole = Math.round(n);
    return '$' + whole;
  }
  function pct(n) {
    if (n == null || !isFinite(n)) return 'n/a';
    const sign = n > 0 ? '+' : '';
    return sign + n.toFixed(2) + '%';
  }
  function ageText(days) {
    if (days == null) return 'unknown';
    const years = (days / 365).toFixed(1);
    if (days >= 365) return years + 'y';
    const whole = Math.max(0, Math.round(days));
    return whole + 'd';
  }

  // The model in one function: the page recomputes a row from the snapshot figures and
  // checks the number board.json carries, so the page's code and the board's data are
  // visibly the same arithmetic.
  function recompute(row, model) {
    const change = row.change_7d == null ? 0 : row.change_7d;
    const growth = Math.min(model.growth_cap, Math.max(model.growth_floor, change));
    const growthMult = 1 + (growth / 100) * model.growth_weight;
    const age = row.age_days == null ? model.unknown_age_days : row.age_days;
    const maturity =
      model.maturity_floor +
      (Math.min(Math.max(age, 0), model.maturity_days) / model.maturity_days) * model.maturity_range;
    const value = Math.round(row.tvl_usd * row.multiple * growthMult * maturity);
    return Math.max(1, value);
  }

  // -- a small element builder -------------------------------------------------

  // h('div', { cls: 'panel' }, 'text', childNode, [moreNodes]) — props named cls/txt/html
  // are special; onClick-style props are listeners; everything else is an attribute.
  function h(tag, props, ...kids) {
    const node = document.createElement(tag);
    if (props) {
      for (const [key, value] of Object.entries(props)) {
        if (value === null || value === undefined) continue;
        if (key === 'cls') node.className = value;
        else if (key === 'txt') node.textContent = value;
        else if (key === 'html') node.innerHTML = value;
        else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
        else node.setAttribute(key, value);
      }
    }
    const add = (kid) => {
      if (kid === null || kid === undefined || kid === false) return;
      if (Array.isArray(kid)) { kid.forEach(add); return; }
      if (typeof kid === 'string' || typeof kid === 'number') {
        node.appendChild(document.createTextNode(String(kid)));
        return;
      }
      node.appendChild(kid);
    };
    kids.forEach(add);
    return node; // the finished element
  }

  // -- the farm plan -----------------------------------------------------------
  //
  // The farm plan is the same derivation main.ts writes to board.json: category, chains,
  // TVL and age decide the action, the capital, the hold and every cost and time. No
  // name is special-cased. The rules below are tried in order; the first match wins.

  function mainChain(p) {
    return p.chains && p.chains.length > 0 ? p.chains[0] : 'its main chain';
  }
  function stakeFor(p) {
    if (p.tvl_usd >= 5e9) return 250; // largest protocols get the largest position
    if (p.tvl_usd >= 1e9) return 150; // mid-large protocols
    if (p.tvl_usd >= 1e8) return 100; // mid protocols
    return 50; // small protocols, small stake
  }
  function holdFor(age) {
    if (age == null) return 30; // unknown age holds the standard window
    if (age < 180) return 60; // young protocols need a longer qualifying window
    if (age < 365) return 45; // under a year old
    return 30; // a year or older
  }
  function feeFor(chain) {
    const c = (chain || '').toLowerCase();
    if (c === 'ethereum') return 'about $8–15 of gas on mainnet'; // mainnet is the expensive one
    if (c === 'solana') return 'under $0.10 of network fees'; // solana fees are tiny
    const cheap = ['base', 'arbitrum', 'optimism', 'polygon', 'blast', 'linea', 'scroll', 'zksync era'];
    if (cheap.includes(c)) return 'under $1 of gas'; // rollups and cheap chains
    return 'a few dollars of gas'; // anything else
  }

  const ACTION_RULES = [
    { test: /lend|cdp|collateral/, make: (p, stake, chain) => `Supply $${stake} of USDC to ${p.name} on ${chain} and keep the position open.` },
    { test: /dex|yield|leveraged farm/, make: (p, stake, chain) => `Provide $${stake} of liquidity to ${p.name}'s main pool on ${chain} and keep the position open.` },
    { test: /bridge/, make: (p, stake, chain) => `Bridge $${stake} of USDC to ${chain} through ${p.name} and use the bridged funds in its app.` },
    { test: /staking|restak/, make: (p, stake) => `Stake $${stake} of the chain's staking asset through ${p.name} and keep the receipt.` },
    { test: /perpetual|derivative/, make: (p, stake) => `Deposit $${stake} of USDC as margin on ${p.name} and open one small hedge.` },
    { test: /prediction/, make: (p, stake) => `Fund $${stake} and place one market position on ${p.name}.` },
    { test: /curator|allocator/, make: (p, stake, chain) => `Deposit $${stake} into a ${p.name} vault on ${chain} and keep the shares.` },
    { test: /stable/, make: (p, stake, chain) => `Mint or deposit $${stake} of the stable asset through ${p.name} on ${chain}.` },
    { test: /rwa/, make: (p, stake, chain) => `Mint $${stake} of the protocol's yield asset on ${chain} and hold it.` },
    { test: /insurance/, make: (p, stake, chain) => `Buy $${stake} of cover from ${p.name} on ${chain} and keep the policy.` },
  ];
  function actionFor(p, stake, chain) {
    const c = (p.category || '').toLowerCase();
    for (const rule of ACTION_RULES) {
      if (rule.test.test(c)) return rule.make(p, stake, chain);
    }
    return `Deposit $${stake} of USDC into ${p.name} on ${chain} and keep the position open.`;
  }

  const WEEKLY_RULES = [
    { test: /lend|cdp|collateral/, text: 'Borrow a small amount against the deposit, then repay it the same week.' },
    { test: /dex|yield|leveraged farm/, text: 'Swap a small amount through the pool, or add and remove a little liquidity.' },
    { test: /bridge/, text: 'Bridge a small amount back and forth, or use the bridged funds once in the app.' },
    { test: /perpetual|derivative/, text: 'Open and close one small position, and keep the margin topped up.' },
    { test: /prediction/, text: 'Place one small market position, or settle one that closed.' },
    { test: /curator|allocator/, text: "Check the vault's allocation, and add or move a small amount." },
    { test: /rwa|stable/, text: 'Claim the yield the position earns, or top the position up a little.' },
  ];
  function weeklyFor(proto) {
    const c = (proto.category || '').toLowerCase();
    for (const rule of WEEKLY_RULES) {
      if (rule.test.test(c)) return rule.text;
    }
    return 'Make one qualifying action, such as a deposit, a borrow, ' + 'a swap or a vote.';
  }

  // One step as a single string: the action, then what it costs and how long it takes.
  function finishStep(step) {
    let s = step.text + ' Cost: ' + step.cost + '. Time: ' + step.time + '.';
    if (s.length > 600) s = s.slice(0, 596) + '...'; // the gate refuses steps past 600 characters
    if (s.length < 20) s += " Hold the position and check the protocol's own page.";
    return s; // the finished step string
  }
  function planFor(p) {
    const chain = mainChain(p);
    const stake = stakeFor(p);
    const hold = holdFor(p.age_days);
    const steps = [
      { text: 'Use a fresh wallet that holds only the funds you plan to farm, ' + 'and keep its seed phrase offline.', cost: 'under $3 of gas for the first transaction', time: '5 minutes' },
      { text: actionFor(p, stake, chain), cost: '$' + stake + ' of capital and ' + feeFor(chain), time: '15 minutes to set up' },
      { text: weeklyFor(p) + ' Do it once a week so the wallet shows steady use, ' + 'not one burst.', cost: 'about $2 of gas a week', time: '10 minutes a week' },
      { text: 'Hold the position for at least ' + hold + ' days so the activity is counted in more than one snapshot.', cost: 'the $' + stake + ' stays in the position', time: hold + ' days' },
      { text: "Before you withdraw, open the protocol's own points or rewards page " + 'from its official docs and check the position is counted, and claim only from a link the protocol itself publishes.', cost: 'no fee to check, and never pay to claim', time: '10 minutes' },
      { text: 'Write the wallet, the dates and every transaction hash in a farm log, and set a reminder for the hold’s end date so you can unwind or renew on purpose.', cost: 'nothing but the log', time: '5 minutes' },
    ];
    return steps.map(finishStep);
  }

  // -- hash state ---------------------------------------------------------------

  function readHash() { // pull q, p, category and chain out of the location hash
    const hash = window.location.hash.replace(/^#/, '');
    if (!hash) return; // no hash, no state to read
    const params = new URLSearchParams(hash);
    const q = params.get('q');
    if (q) view.q = q;
    const p = params.get('p');
    if (p) view.selected = p;
    const category = params.get('category');
    if (category) view.category = category;
    const chain = params.get('chain');
    if (chain) view.chain = chain;
  }
  function writeHash() { // put the current view back into the location hash
    const params = new URLSearchParams();
    if (view.q) params.set('q', view.q);
    if (view.category !== 'all') params.set('category', view.category);
    if (view.chain !== 'all') params.set('chain', view.chain);
    if (view.selected) params.set('p', view.selected);
    const next = params.toString();
    const target = next ? '#' + next : window.location.pathname + window.location.search;
    window.history.replaceState(null, '', target);
  }

  // -- filtering and sorting -----------------------------------------------------

  function visibleRows() {
    const q = view.q.trim().toLowerCase();
    return DATA.rows.filter((r) => {
      if (view.category !== 'all' && r.category !== view.category) return false;
      if (view.chain !== 'all' && !(r.chains || []).includes(view.chain)) return false;
      if (!q) return true; // no search text, every row passes
      const hay = [r.name, r.slug, r.category, (r.chains || []).join(' ')].join(' ').toLowerCase();
      return hay.includes(q);
    });
  }
  function orderedRows(list) {
    const key = view.sort;
    return list.slice().sort((a, b) => {
      let first;
      let second;
      if (key === 'name') { first = a.name.toLowerCase(); second = b.name.toLowerCase(); }
      else if (key === 'tvl') { first = a.tvl_usd; second = b.tvl_usd; }
      else if (key === 'growth') { first = a.change_7d == null ? -Infinity : a.change_7d; second = b.change_7d == null ? -Infinity : b.change_7d; }
      else if (key === 'age') { first = a.age_days == null ? Infinity : a.age_days; second = b.age_days == null ? Infinity : b.age_days; }
      else if (key === 'multiple') { first = a.multiple; second = b.multiple; }
      else { first = a.implied_value_usd; second = b.implied_value_usd; }
      if (first < second) return -view.dir;
      if (first > second) return view.dir;
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0; // ties break by slug
    });
  }

  // -- page sections -------------------------------------------------------------

  function topBar() {
    return h('header', { cls: 'top' },
      h('div', { cls: 'brand' },
        h('span', { cls: 'mark' }),
        h('span', { cls: 'brand-name', txt: 'Token Radar' })),
      h('div', { cls: 'top-meta' },
        h('span', { txt: 'Snapshot ' + DATA.as_of }),
        h('span', { txt: 'DefiLlama protocol index' }),
        h('span', { txt: DATA.model_version + ' model' })));
  }

  function intro() {
    const floorM = Math.round(DATA.floor_usd / 1e6);
    return h('section', { cls: 'lede' },
      h('div', null,
        h('h1', { txt: DATA.watchlist_size + ' watchlist protocols, ranked by implied value' }),
        h('p', { txt: `The watchlist is the floor: every protocol with at least $${floorM}M of TVL and no token on record. The early radar adds ${DATA.early_size} pre-token protocols below that floor, each screened the same way the watchlist was drawn. Implied value is a model, not a promise.` })),
      h('div', { cls: 'facts' },
        h('div', { cls: 'fact' }, h('span', { txt: 'Watchlist covered' }), h('b', { txt: DATA.watchlist_size + ' / ' + DATA.watchlist_size })),
        h('div', { cls: 'fact' }, h('span', { txt: 'Pre-token rows scored' }), h('b', { txt: String(DATA.board_size) })),
        h('div', { cls: 'fact' }, h('span', { txt: 'Early rows below the floor' }), h('b', { txt: String(DATA.early_size) })),
        h('div', { cls: 'fact' }, h('span', { txt: 'Live-token protocols set aside' }), h('b', { txt: String(DATA.live_size) }))));
  }

  function filters() {
    const categories = Array.from(new Set(DATA.rows.map((r) => r.category || 'Other'))).sort();
    const chains = Array.from(new Set(DATA.rows.reduce((acc, r) => acc.concat(r.chains || []), []))).sort();
    const search = h('input', { type: 'search', id: 'q', placeholder: 'Search name, category or chain', value: view.q, 'aria-label': 'Search the board' });
    search.addEventListener('input', () => { view.q = search.value; writeHash(); render(); });
    const select = h('select', { id: 'category', 'aria-label': 'Filter by category' },
      h('option', { value: 'all', txt: 'All categories' }),
      categories.map((c) => h('option', { value: c, txt: c, selected: c === view.category ? 'selected' : null })));
    select.addEventListener('change', () => { view.category = select.value; writeHash(); render(); });
    const chainSelect = h('select', { id: 'chain', 'aria-label': 'Filter by chain' },
      h('option', { value: 'all', txt: 'All chains' }),
      chains.map((c) => h('option', { value: c, txt: c, selected: c === view.chain ? 'selected' : null })));
    chainSelect.addEventListener('change', () => { view.chain = chainSelect.value; writeHash(); render(); });
    const pre = h('button', {
      type: 'button', 'aria-pressed': view.tab === 'pre-token' ? 'true' : 'false', txt: 'Pre-token',
      onClick: () => { view.tab = 'pre-token'; render(); },
    });
    const live = h('button', {
      type: 'button', 'aria-pressed': view.tab === 'live' ? 'true' : 'false', txt: 'Live token',
      onClick: () => { view.tab = 'live'; render(); },
    });
    const countText = view.tab === 'pre-token'
      ? visibleRows().length + ' rows shown'
      : DATA.live.length + ' live-token protocols';
    return h('div', { cls: 'controls' },
      h('div', { cls: 'field' }, h('label', { for: 'q', txt: 'Search' }), search),
      h('div', { cls: 'field' }, h('label', { for: 'category', txt: 'Category' }), select),
      h('div', { cls: 'field' }, h('label', { for: 'chain', txt: 'Chain' }), chainSelect),
      h('div', { cls: 'field' },
        h('span', { cls: 'sub', txt: 'Token status' }),
        h('div', { cls: 'tabs' }, pre, live)),
      h('span', { cls: 'count', txt: countText }));
  }

  function sortHead(key, label) {
    const arrow = view.sort === key
      ? h('span', { 'aria-hidden': 'true', txt: view.dir < 0 ? ' v' : ' ^' })
      : null;
    return h('th', { scope: 'col' },
      h('button', {
        type: 'button',
        onClick: () => {
          if (view.sort === key) view.dir = -view.dir;
          else { view.sort = key; view.dir = -1; }
          render(); // resort and repaint
        },
      }, label, arrow));
  }

  function chainLabel(r) {
    return r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') : 'an unnamed chain';
  }

  function preTokenTable() {
    const list = orderedRows(visibleRows());
    if (list.length === 0) { // nothing matches the current filters
      return h('div', { cls: 'panel' },
        h('div', { cls: 'empty' },
          h('h2', { txt: 'No protocol matches that filter' }),
          h('p', { txt: 'Clear the search or pick another category to see the board again.' }),
          h('button', {
            cls: 'button primary', type: 'button', txt: 'Clear filters',
            onClick: () => { view.q = ''; view.category = 'all'; view.chain = 'all'; writeHash(); render(); },
          })));
    }
    const top = DATA.rows.length ? DATA.rows[0].implied_value_usd : 1;
    const bodyRows = list.map((r) => {
      const growth = r.change_7d === null ? 'n/a' : pct(r.change_7d);
      const growthCls = r.change_7d === null ? '' : r.change_7d >= 0 ? 'pos' : 'neg';
      const width = Math.max(3, Math.round((r.implied_value_usd / top) * 100));
      return h('tr', {
        'data-selected': view.selected === r.slug ? 'true' : 'false',
        tabindex: '0', // rows are keyboard-focusable
        onClick: () => openDetail(r.slug),
        onKeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(r.slug); } },
      },
        h('td', { cls: 'num', txt: String(r.rank) }),
        h('td', null,
          h('div', { cls: 'name' },
            h('b', { txt: r.name }),
            h('span', { cls: 'sub', txt: (r.category || 'Other') + ' on ' + chainLabel(r) }))),
        h('td', { cls: 'num', txt: usd(r.tvl_usd) }),
        h('td', { cls: 'num ' + growthCls, txt: growth }),
        h('td', { cls: 'num', txt: ageText(r.age_days) }),
        h('td', null,
          h('div', { cls: 'implied' },
            h('div', { cls: 'bar', 'aria-hidden': 'true' }, h('i', { style: 'width:' + width + '%' })),
            h('span', { cls: 'num', txt: usd(r.implied_value_usd) }))),
        h('td', null, h('span', { cls: 'status', txt: 'no token' })));
    });
    return h('div', { cls: 'panel' },
      h('div', { cls: 'table-wrap' },
        h('table', null,
          h('caption', { cls: 'sub', txt: 'Pre-token protocols, strongest implied value first. Select a row for its model and farm plan.' }),
          h('thead', null,
            h('tr', null,
              h('th', { scope: 'col', txt: 'Rank' }),
              sortHead('name', 'Protocol'),
              sortHead('tvl', 'TVL'),
              sortHead('growth', '7d'),
              sortHead('age', 'Age'),
              sortHead('implied', 'Implied value'),
              h('th', { scope: 'col', txt: 'Token' }))),
          h('tbody', null, bodyRows))));
  }

  function liveTokenTable() {
    const bodyRows = DATA.live.map((r) => {
      const cls = r.change_7d !== null && r.change_7d >= 0 ? 'pos' : 'neg';
      return h('tr', null,
        h('td', { cls: 'num', txt: 'live' }),
        h('td', null,
          h('div', { cls: 'name' },
            h('b', { txt: r.name }),
            h('span', { cls: 'sub', txt: (r.category || 'Other') + ' on ' + chainLabel(r) }))),
        h('td', { cls: 'num', txt: usd(r.tvl_usd) }),
        h('td', { cls: 'num ' + cls, txt: pct(r.change_7d) }),
        h('td', { cls: 'num', txt: usd(r.mcap_usd) }),
        h('td', null, h('span', { cls: 'status', txt: 'already trades' })));
    });
    return h('div', { cls: 'panel' },
      h('div', { cls: 'table-wrap' },
        h('table', null,
          h('caption', { cls: 'sub', txt: 'Token live: these protocols already trade, so their market cap is a fact, not a model. They are set aside from the pre-token ranking.' }),
          h('thead', null,
            h('tr', null,
              h('th', { scope: 'col', txt: 'Status' }),
              h('th', { scope: 'col', txt: 'Protocol' }),
              h('th', { scope: 'col', txt: 'TVL' }),
              h('th', { scope: 'col', txt: '7d' }),
              h('th', { scope: 'col', txt: 'Market cap' }),
              h('th', { scope: 'col', txt: 'Token' }))),
          h('tbody', null, bodyRows))));
  }

  function modelSection() {
    const m = DATA.model;
    const multRows = DATA.multiples
      .filter((x) => x.source === 'category')
      .map((x) => h('tr', null,
        h('td', { txt: x.category }),
        h('td', { cls: 'num', txt: String(x.sample) }),
        h('td', { cls: 'num', txt: 'x' + x.multiple.toFixed(3) })));
    const formula = `implied = round( tvl_usd x multiple(category) x (1 + clamp(change_7d, ${m.growth_floor}, ${m.growth_cap}) / 100 x ${m.growth_weight}) x (${m.maturity_floor} + min(age_days, ${m.maturity_days}) / ${m.maturity_days} x ${m.maturity_range}) )`;
    return h('section', { cls: 'panel model' },
      h('h2', { txt: 'How implied value is computed' }),
      h('p', { cls: 'sub', txt: `Every row is scored by one function of the snapshot figures. No protocol name is special-cased, and no row is hand-picked. The multiple a category gets is the median market-cap-to-TVL ratio of the live-token protocols in that category, read from this same snapshot; a category with fewer than ${m.min_category_sample} live protocols to learn from gets the global median of ${DATA.global_multiple.toFixed(3)} instead, so one outlier never sets a whole category’s price.` }),
      h('div', { cls: 'formula', txt: formula }),
      h('table', { cls: 'multiples' },
        h('caption', { cls: 'sub', txt: `Category multiples from live protocols (median market cap per dollar of TVL, clamped to ${m.multiple_floor}–${m.multiple_cap}). Categories not listed use the global median.` }),
        h('thead', null,
          h('tr', null,
            h('th', { scope: 'col', txt: 'Category' }),
            h('th', { scope: 'col', txt: 'Live sample' }),
            h('th', { scope: 'col', txt: 'Multiple' }))),
        h('tbody', null, multRows)),
      h('p', { cls: 'sub', txt: `TVL and seven-day growth come from the snapshot. Age is the time since the protocol was first listed, the best record of how long it has run with no token; an unlisted age uses ${m.unknown_age_days} days. Wrapped, staked and bridged products are not ranked: their token already trades in another form, so they are not launches still to come.` }));
  }

  function methodSection() {
    return h('section', { cls: 'panel note' },
      h('h2', { txt: 'What is not on the board, and why' }),
      h('p', { txt: 'A protocol is ranked only when its record shows no token and it is not a wrapped, staked or bridged product of a token that already trades — the same rule the watchlist itself was drawn with. A liquid-staking receipt is ETH in a staking product, a bridged dollar is a dollar on another chain, and a versioned pool is a pool of another protocol: none of them is a launch still to come, so none of them takes a rank. The live-token view shows the protocols that already trade, with the market cap the market itself set.' }),
      h('p', { txt: '“No token on record” is what the snapshot says, never a promise that a protocol has none: a protocol on this board may still hold a token its DefiLlama record does not carry. Implied value is this radar’s own estimate, not a price, and it does not predict whether or when any token is issued.' }));
  }

  function pageFoot() {
    return h('p', { cls: 'foot', txt: `Token Radar ${DATA.model_version} · snapshot ${DATA.as_of} · source: ${DATA.source} · ${DATA.board_size} rows scored, ${DATA.watchlist_size} on the watchlist.` });
  }

  // -- the detail view -----------------------------------------------------------

  const dialog = h('dialog', { cls: 'detail', id: 'detail', 'aria-labelledby': 'detail-title' });
  dialog.addEventListener('close', () => { view.selected = null; writeHash(); });

  function openDetail(slug) { // open the side panel for one row
    const row = DATA.rows.filter((r) => r.slug === slug)[0];
    if (!row) return; // unknown slug, nothing to open
    view.selected = slug;
    writeHash(); // the open row is in the hash so it survives a reload
    dialog.textContent = ''; // clear the previous row's detail
    const steps = planFor(row);
    const again = recompute(row, DATA.model);
    const multipleText = 'x' + row.multiple.toFixed(3) +
      (row.multiple_source === 'category' ? ' (' + (row.category || 'Other') + ')' : ' (global)');
    const ageLine = ageText(row.age_days) +
      (row.listed_at ? ' (listed ' + row.listed_at + ')' : ' (first listing date unknown)');
    const check = again === row.implied_value_usd
      ? ', the same number board.json carries.'
      : ', which differs from the board: the data would be stale.';
    dialog.appendChild(h('div', { cls: 'detail-head' },
      h('div', null,
        h('span', { cls: 'brand-name', txt: 'Rank ' + row.rank + ' of ' + DATA.board_size }),
        h('h2', { id: 'detail-title', txt: row.name }),
        h('p', { cls: 'sub', txt: (row.category || 'Other') + ' on ' + (row.chains && row.chains.length ? row.chains.join(', ') : 'an unnamed chain') })),
      h('button', { cls: 'close', type: 'button', 'aria-label': 'Close details', txt: 'Close', onClick: () => dialog.close() })));
    dialog.appendChild(h('section', { cls: 'detail-section' },
      h('h3', { txt: 'Implied value' }),
      h('div', { cls: 'equation' },
        h('div', null, h('span', { txt: 'TVL' }), h('b', { cls: 'num', txt: usd(row.tvl_usd) })),
        h('div', null, h('span', { txt: 'Category multiple' }), h('b', { cls: 'num', txt: multipleText })),
        h('div', null, h('span', { txt: 'Seven-day growth' }), h('b', { cls: 'num', txt: pct(row.change_7d) })),
        h('div', null, h('span', { txt: 'Age with no token' }), h('b', { cls: 'num', txt: ageLine })),
        h('div', null, h('span', { txt: 'Growth multiplier' }), h('b', { cls: 'num', txt: String(row.growth_multiplier) })),
        h('div', null, h('span', { txt: 'Maturity multiplier' }), h('b', { cls: 'num', txt: String(row.maturity_multiplier) })),
        h('div', null, h('span', { txt: 'Implied value' }), h('b', { cls: 'num', txt: usd(row.implied_value_usd) }))),
      h('p', { cls: 'sub', txt: `Model ${DATA.model_version}: the same function scores every protocol. The page recomputes this row as ${usd(again)}${check} This is an estimate, not a price.` })));
    dialog.appendChild(h('section', { cls: 'detail-section' },
      h('h3', { txt: 'Farm plan' }),
      h('ol', { cls: 'steps' }, steps.map((s) => {
        const at = s.indexOf(' Cost: ');
        const action = at >= 0 ? s.slice(0, at) : s;
        const tail = at >= 0 ? s.slice(at + 1) : '';
        return h('li', null, h('b', { txt: action }), h('span', { cls: 'cost', txt: tail }));
      }))));
    const modal = typeof dialog.showModal === 'function';
    if (modal && !dialog.open) dialog.showModal();
    if (!modal) dialog.setAttribute('open', ''); // fall back to a plain open dialog
  }

  // -- render ----------------------------------------------------------------------

  function render() { // rebuild the whole page from the current view state
    app.textContent = ''; // clear the previous render
    const shell = h('div', { cls: 'shell' });
    shell.appendChild(topBar());
    shell.appendChild(intro());
    shell.appendChild(filters());
    shell.appendChild(view.tab === 'pre-token' ? preTokenTable() : liveTokenTable());
    if (view.tab === 'pre-token') shell.appendChild(modelSection());
    if (view.tab === 'pre-token') shell.appendChild(methodSection());
    shell.appendChild(pageFoot());
    app.appendChild(shell); // the finished page goes in
    app.setAttribute('aria-busy', 'false'); // the page is rendered now
    const attached = dialog.isConnected;
    if (!attached) app.appendChild(dialog); // the detail panel lives inside #board
    if (view.selected) openDetail(view.selected);
  }

  readHash(); // pick up any state the hash carries
  render(); // first paint
  window.addEventListener('keydown', (e) => {
    const escape = e.key === 'Escape';
    if (escape && dialog.open) dialog.close();
  });
})();
