/**
 * siteone-programs-check — monthly SiteOne savings-programs check.
 * Fakes only: no network, no browser, no database. The alert goes through the
 * real composeAdminAlert rules (headline 60, why 110 / one sentence, forbidden
 * tokens), so a copy that breaks docs/admin-notifications.md fails here.
 */
const { composeAdminAlert } = require('../services/admin-alert-compose');
const mod = require('../services/procurement/siteone-programs-check');
const {
  runSiteOneProgramsCheck, parseDateRange, parseEopPage, parsePromotionsPage, parsePartnersPage, diffPrograms, buildAlertText, SNAPSHOT_KEY,
} = mod;
const siteone = require('../services/procurement/adapters/siteone');
const { loadProgramHistory, oldestKeptMonth, HISTORY_PREFIX } = mod;

const GATE = 'GATE_SITEONE_PROGRAMS_CHECK';
let savedGate;
beforeEach(() => { savedGate = process.env[GATE]; delete process.env[GATE]; });
afterEach(() => { if (savedGate === undefined) delete process.env[GATE]; else process.env[GATE] = savedGate; });

// ---- synthetic page text, shaped like the real pages -------------------------------

const EOP_TEXT = [
  'Early Order Programs',
  'TURF & ORNAMENTAL',
  'Order early and save big on all the turf maintenance products you need.',
  'Select a Program ▼',
  'Turf & Ornamental',
  'Florida Turf Programs',
  'September 1 - February 12, 2027',
  'PEST MANAGEMENT',
  'Order early and save on pest control products.',
  'Select a Program ▼',
  'Pest Management',
  'DEADLINE EXTENDED: July 1 - November 15, 2026',
  'SEED & FERTILITY',
  'Great prices and flexible financing terms.',
  'Select a Program ▼',
  'Seed Program',
  'September 1 - November 30, 2026',
  'Supplier Early Order Programs',
  'Albaugh',
  'Sept. 1 – Dec. 31, 2026',
  'Save on specialty products.',
  'View EOP Offer',
  'BASF',
  'Oct. 1 - Dec. 4, 2026',
  'Order early and save on pest control products.',
  'Select a Program ▼',
  'SePRO',
  'Oct. 1 - December 11, 2026',
  'Save up to 22% during the Early Order Program.',
  'Syngenta',
  'Aug. 1 – Sept. 30, 2026',
  'Take your savings further.',
].join('\n');

const PROMO_TEXT = [
  'Promotions',
  'Order Like a Pro',
  'September 1 - November 20, 2026',
  'Save up to 10%',
  'Save 5% to 10% on select irrigation products.',
  'Portfolio Collection Fresh Picks',
  'Seasonal color picks at special prices.',
  'Now through November 22, 2026',
].join('\n');

const PARTNERS_TEXT = [
  'Available Rewards',
  'Earn points on every purchase.',
  ' 4,321 ',
  ' POINTS',
  'CURRENT YEAR: ENROLLED',
  'Redeem Points',
  ' $23.45',
  'Expiring Soon',
  ' 1,234',
  ' pts',
  'Expires by Dec 31,2026',
].join('\n');

const TURF_TEXT = 'Florida turf offer: save early on fertilizer, herbicide and fungicide when you book by the deadline. '.repeat(30);
const PEST_TEXT = 'Pest management offer: save on termiticide and insecticide.';

const NOW = '2026-10-26T14:00:00Z'; // 10:00 AM ET, ET date 2026-10-26

function fakePage(pages = {}) {
  const st = { url: 'https://www.siteone.com/', visited: [] };
  return {
    st,
    goto: async (u) => { st.visited.push(u); st.url = u; if (pages[u] instanceof Error) throw pages[u]; },
    url: () => st.url,
    evaluate: async () => { const t = pages[st.url]; return typeof t === 'string' ? t : ''; },
    waitForLoadState: async () => {},
  };
}

const PAGES = {
  'https://www.siteone.com/eop': EOP_TEXT,
  'https://www.siteone.com/en/Promotions': PROMO_TEXT,
  'https://www.siteone.com/eop-turf-fl': TURF_TEXT,
  'https://www.siteone.com/eop-pestmanagement': PEST_TEXT,
  'https://www.siteone.com/en/my-account/accountPartnerProgram': PARTNERS_TEXT,
};

// In-memory vendors + system_settings, just enough knex for the check.
function fakeConn({ vendor = { id: 7, name: 'SiteOne', code: 1 }, snapshot = null, settings = {} } = {}) {
  const rows = new Map(Object.entries(settings));
  if (snapshot) rows.set(SNAPSHOT_KEY, snapshot);
  const state = { rows, writes: [], deleted: [], transactions: 0, get snapshot() { return rows.get(SNAPSHOT_KEY) || null; } };
  const make = (table) => {
    const q = { filters: [], order: null, max: null };
    const matching = () => {
      let list = [...rows.entries()].map(([key, value]) => ({ key, value }));
      for (const f of q.filters) list = list.filter(f);
      if (q.order) list.sort((x, y) => (x.key < y.key ? 1 : -1) * (q.order === 'desc' ? 1 : -1));
      return q.max ? list.slice(0, q.max) : list;
    };
    const b = {
      where(...args) {
        if (args.length === 3) { const prefix = args[2].replace(/%$/, ''); q.filters.push((r) => r.key.startsWith(prefix)); } else if (args[0] && args[0].key) q.filters.push((r) => r.key === args[0].key);
        return b;
      },
      whereRaw() { return b; },
      whereIn(_c, keys) { q.filters.push((r) => keys.includes(r.key)); return b; },
      orderBy(_c, dir) { q.order = dir; return b; },
      limit(n) { q.max = n; return b; },
      select() { return b; },
      first() {
        if (table === 'vendors') return Promise.resolve(vendor || undefined);
        return Promise.resolve(matching()[0]);
      },
      insert(row) { b.row = row; return b; },
      onConflict() { return b; },
      merge() { state.writes.push({ table, row: b.row }); rows.set(b.row.key, b.row.value); return Promise.resolve(); },
      del() { const gone = matching().map((r) => r.key); gone.forEach((k) => rows.delete(k)); state.deleted.push(...gone); return Promise.resolve(gone.length); },
      then(res, rej) { return Promise.resolve(matching()).then(res, rej); },
    };
    return b;
  };
  const conn = (table) => make(table);
  conn.fn = { now: () => 'NOW' };
  conn.transaction = async (cb) => { state.transactions += 1; return cb(conn); };
  conn.state = state;
  return conn;
}

function harness({ pages = PAGES, snapshot = null, vendor, signIn, settings } = {}) {
  const conn = fakeConn({ snapshot, vendor, settings });
  const alerts = [];
  const page = fakePage(pages);
  const readSignedIn = jest.fn(signIn || (async (opts, fn) => fn(page)));
  const raise = jest.fn(async (category, spec, opts) => { composeAdminAlert(spec); alerts.push({ category, spec, opts }); return { id: 'n1' }; });
  const getCredentials = jest.fn(async () => ({ email: 'buyer@example.com', password: 'pw' }));
  const deps = { conn, raise, readSignedIn, getCredentials, now: NOW };
  return { conn, alerts, page, readSignedIn, raise, getCredentials, deps };
}

// ---- date parsing -------------------------------------------------------------------

describe('parseDateRange', () => {
  test.each([
    ['September 1 - February 12, 2027', '2026-09-01', '2027-02-12'],
    ['Sept. 1 – Dec. 31, 2026', '2026-09-01', '2026-12-31'],
    ['Sep 1 — Oct 31, 2026', '2026-09-01', '2026-10-31'],
    ['Oct. 1 - December 11, 2026', '2026-10-01', '2026-12-11'],
    ['Aug. 1 – Sept. 30, 2026', '2026-08-01', '2026-09-30'],
    ['October 1 - 31, 2026', '2026-10-01', '2026-10-31'],
    ['December 15, 2026 - January 31, 2027', '2026-12-15', '2027-01-31'],
  ])('%s', (text, start, end) => {
    expect(parseDateRange(text)).toMatchObject({ start, end });
  });

  test('year rollover: a start without a year that would fall after the end takes the year before', () => {
    expect(parseDateRange('November 1 - March 15, 2027')).toMatchObject({ start: '2026-11-01', end: '2027-03-15' });
  });

  test('"Now through <date>" has no start', () => {
    expect(parseDateRange('Now through October 31, 2026')).toEqual({ start: null, end: '2026-10-31', dateText: 'Now through October 31, 2026' });
  });

  test('a range with no year at all is still dated text, with null dates; text without a date is null', () => {
    expect(parseDateRange('Oct. 1 - Dec. 4')).toEqual({ start: null, end: null, dateText: 'Oct. 1 - Dec. 4' });
    expect(parseDateRange('Marketing 5 - 10 items')).toBeNull();
    expect(parseDateRange('Select a Program')).toBeNull();
  });

  test('an impossible day is not a date', () => {
    expect(parseDateRange('February 31 - March 2, 2027')).toMatchObject({ start: null });
  });
});

// ---- page parsers --------------------------------------------------------------------

describe('parseEopPage', () => {
  const programs = parseEopPage(EOP_TEXT);
  const by = (name) => programs.find((p) => p.name === name);

  test('program groups: the name is the line above the dated line', () => {
    expect(by('Florida Turf Programs')).toMatchObject({ source: 'group', start: '2026-09-01', end: '2027-02-12' });
    expect(by('Seed Program')).toMatchObject({ source: 'group', start: '2026-09-01', end: '2026-11-30' });
  });

  test('a "DEADLINE EXTENDED:" prefix is a note, not part of the date or the name', () => {
    expect(by('Pest Management')).toMatchObject({ source: 'group', dateText: 'July 1 - November 15, 2026', end: '2026-11-15', note: 'DEADLINE EXTENDED' });
  });

  test('suppliers after the "Supplier Early Order Programs" heading, en dash and hyphen, with the description line', () => {
    expect(by('Albaugh')).toMatchObject({ source: 'supplier', start: '2026-09-01', end: '2026-12-31', desc: 'Save on specialty products.' });
    expect(by('BASF')).toMatchObject({ source: 'supplier', end: '2026-12-04' });
    expect(by('SePRO')).toMatchObject({ source: 'supplier', end: '2026-12-11' });
    expect(by('Syngenta')).toMatchObject({ source: 'supplier', end: '2026-09-30' });
    expect(programs).toHaveLength(7);
  });

  test('the key is source|name|dateText, normalized, and stable across runs', () => {
    expect(by('BASF').key).toBe('supplier|basf|oct 1 dec 4 2026');
    expect(parseEopPage(EOP_TEXT).map((p) => p.key)).toEqual(programs.map((p) => p.key));
  });

  test('a repeated block (responsive copy) counts once; a page with no dates yields nothing', () => {
    const seed = 'Seed Program\nSeptember 1 - November 30, 2026';
    expect(parseEopPage(EOP_TEXT.replace(seed, `${seed}\n${seed}`))).toHaveLength(7);
    expect(parseEopPage('Sign in to see programs\nLoading')).toEqual([]);
  });
});

describe('parsePromotionsPage', () => {
  const promos = parsePromotionsPage(PROMO_TEXT);

  test('a promotion block with the date right under the title, and its offer line', () => {
    expect(promos.find((p) => p.name === 'Order Like a Pro')).toMatchObject({ source: 'promo', start: '2026-09-01', end: '2026-11-20', desc: 'Save up to 10%' });
  });

  test('"Now through" promotions (date last, description between) keep their title and have no start', () => {
    expect(promos.find((p) => p.name === 'Portfolio Collection Fresh Picks')).toMatchObject({ start: null, end: '2026-11-22' });
    expect(promos).toHaveLength(2);
  });
});

describe('parsePartnersPage', () => {
  test('points, dollar value, expiring points and the expiry date', () => {
    expect(parsePartnersPage(PARTNERS_TEXT)).toEqual({
      available: 4321, dollarValue: 23.45, expiringPoints: 1234, expiresOn: '2026-12-31', status: 'ENROLLED',
    });
  });

  test('no expiring block reads as 0 expiring, no date', () => {
    expect(parsePartnersPage('Available Rewards 500 POINTS Redeem Points $5.00')).toMatchObject({ available: 500, expiringPoints: 0, expiresOn: null });
  });
});

// ---- diff ----------------------------------------------------------------------------

describe('diffPrograms', () => {
  const programs = [...parseEopPage(EOP_TEXT), ...parsePromotionsPage(PROMO_TEXT)];
  const today = '2026-10-26';
  const partners = { available: 4321, dollarValue: 23.45, expiringPoints: 1234, expiresOn: '2026-12-31' };

  test('ended programs are never current, new or ending soon', () => {
    const d = diffPrograms({ programs, prev: { programs: [] }, partners: null, today });
    expect(d.live.map((p) => p.name)).not.toContain('Syngenta'); // ended 2026-09-30
    expect(d.added.map((p) => p.name)).not.toContain('Syngenta');
  });

  test('new = keys absent from the last snapshot', () => {
    const prev = { programs: programs.filter((p) => p.name !== 'BASF' && p.name !== 'SePRO') };
    const d = diffPrograms({ programs, prev, partners: null, today });
    expect(d.added.map((p) => p.name).sort()).toEqual(['BASF', 'SePRO']);
    expect(d.baseline).toBe(false);
  });

  test('ending soon = ends within 30 days (inclusive), not later, not already ended', () => {
    const d = diffPrograms({ programs, prev: { programs }, partners: null, today });
    // Pest Management 2026-11-15, Order Like a Pro 2026-11-20, Fresh Picks 2026-11-22 end by Nov 25; Seed Program ends Nov 30.
    expect(d.endingSoon.map((p) => p.name).sort()).toEqual(['Order Like a Pro', 'Pest Management', 'Portfolio Collection Fresh Picks']);
    const edge = diffPrograms({ programs: [{ key: 'k', name: 'Edge', end: '2026-11-25', source: 'promo' }], prev: { programs: [] }, partners: null, today });
    expect(edge.endingSoon).toHaveLength(1);
    const past = diffPrograms({ programs: [{ key: 'k', name: 'Edge', end: '2026-11-26', source: 'promo' }], prev: { programs: [] }, partners: null, today });
    expect(past.endingSoon).toHaveLength(0);
  });

  test('points window: expiring > 0 and the date within 60 days', () => {
    const inside = (expiresOn, expiringPoints = 1234) => diffPrograms({ programs, prev: { programs }, partners: { ...partners, expiresOn, expiringPoints }, today }).pointsSoon;
    expect(inside('2026-12-25')).toBe(true); // day 60
    expect(inside('2026-12-26')).toBe(false); // day 61
    expect(inside('2026-12-25', 0)).toBe(false);
    expect(inside(null)).toBe(false);
    expect(inside('2026-10-01')).toBe(false); // already expired
  });

  test('first run (no snapshot) is a baseline: everything current is listed as new', () => {
    const d = diffPrograms({ programs, prev: null, partners: null, today });
    expect(d.baseline).toBe(true);
    expect(d.added).toEqual(d.live);
  });
});

// ---- the alert text ------------------------------------------------------------------

describe('buildAlertText', () => {
  const programs = [...parseEopPage(EOP_TEXT), ...parsePromotionsPage(PROMO_TEXT)];
  const partners = { available: 4321, dollarValue: 23.45, expiringPoints: 11867, expiresOn: '2026-12-31' };

  test.each([
    ['new + ending + points', { programs, prev: { programs: programs.slice(0, 3) }, partners }],
    ['baseline', { programs, prev: null, partners }],
    ['points only', { programs, prev: { programs }, partners: { ...partners }, today: '2026-12-01' }],
    ['ending only', { programs, prev: { programs }, partners: null }],
  ])('%s: the headline is 60 or less and the why is one sentence of 110 or less (real compose rules)', (_n, args) => {
    const d = diffPrograms({ today: '2026-10-26', ...args });
    const text = buildAlertText(d, args.partners);
    const composed = composeAdminAlert({
      area: 'Inventory', action: text.action, why: text.why, severity: 'needs-you', link: '/admin/inventory?tab=restock',
      subject: { type: 'check', id: 'siteone-programs' }, doneWhen: 'programs_reviewed', who: 'person',
    });
    expect(composed.headline.length).toBeLessThanOrEqual(60);
    expect(composed.why.length).toBeLessThanOrEqual(110);
  });

  test('says the counts and the points date in plain words', () => {
    const soon = { ...partners, expiresOn: '2026-12-20' };
    const d = diffPrograms({ programs, prev: { programs: programs.slice(0, 3) }, partners: soon, today: '2026-10-26' });
    expect(buildAlertText(d, soon).why).toBe('5 new; 3 end within 30 days; 11,867 points expire Dec 20.');
    const one = diffPrograms({ programs: [{ key: 'k', source: 'supplier', name: 'BASF', end: '2027-01-31' }], prev: { programs: [] }, partners: null, today: '2026-10-26' });
    expect(buildAlertText(one, null).why).toBe('1 new: BASF.');
  });

  test('a long program name list is cut, never over 110', () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ key: `k${i}`, source: 'promo', name: `A very long promotion name number ${i} with many words`, end: '2027-01-01' }));
    const d = diffPrograms({ programs: many, prev: { programs: [] }, partners: null, today: '2026-10-26' });
    expect(buildAlertText(d, null).why.length).toBeLessThanOrEqual(110);
  });
});

// ---- the run -------------------------------------------------------------------------

describe('runSiteOneProgramsCheck', () => {
  test('gate off (unset or not truthy): skipped before any DB read or browser launch', async () => {
    const h = harness();
    const throwingConn = new Proxy(() => { throw new Error('db touched'); }, { get() { throw new Error('db touched'); } });
    await expect(runSiteOneProgramsCheck({ ...h.deps, conn: throwingConn })).resolves.toEqual({ skipped: 'gated' });
    process.env[GATE] = 'false';
    await expect(runSiteOneProgramsCheck({ ...h.deps, conn: throwingConn })).resolves.toEqual({ skipped: 'gated' });
    expect(h.readSignedIn).not.toHaveBeenCalled();
    expect(h.getCredentials).not.toHaveBeenCalled();
    expect(h.raise).not.toHaveBeenCalled();
  });

  test('gate is read at call time', async () => {
    const h = harness();
    await expect(runSiteOneProgramsCheck(h.deps)).resolves.toEqual({ skipped: 'gated' });
    process.env[GATE] = 'true';
    const r = await runSiteOneProgramsCheck(h.deps);
    expect(r.skipped).toBeUndefined();
    expect(r.programs).toBeGreaterThan(0);
  });

  describe('gate on', () => {
    beforeEach(() => { process.env[GATE] = 'true'; });

    test('first run: baseline alert with the whole list in the detail, and a snapshot is saved', async () => {
      const h = harness();
      const r = await runSiteOneProgramsCheck(h.deps);
      expect(r).toMatchObject({ baseline: true, notified: true });
      expect(h.alerts).toHaveLength(1);
      const { spec, opts, category } = h.alerts[0];
      expect(category).toBe('system');
      expect(spec).toMatchObject({ area: 'Inventory', severity: 'needs-you', who: 'person' });
      expect(spec.action).toMatch(/SiteOne programs/);
      expect(opts.dedupeKey).toBe('siteone-programs:2026-10');
      expect(opts.detail).toContain('FIRST CHECK');
      expect(opts.detail).toContain('Florida Turf Programs');
      expect(opts.detail).toContain('Albaugh');
      expect(opts.detail).toContain('Portfolio Collection Fresh Picks');
      expect(opts.detail).toContain('Partners'.toUpperCase());
      expect(opts.detail).toContain('1,234 expire Dec 31');
      expect(opts.detail).toContain('https://www.siteone.com/eop');
      // offer text is kept to ~1,200 chars
      const turf = opts.detail.split('\n').find((l) => l.startsWith('Florida turf:'));
      expect(turf.length).toBeLessThanOrEqual('Florida turf: '.length + 1200);
      expect(turf).toContain('Florida turf offer');
      expect(h.conn.state.writes[0].row).toMatchObject({ key: SNAPSHOT_KEY, category: 'procurement' });
      expect(JSON.parse(h.conn.state.snapshot)).toMatchObject({ takenAt: '2026-10-26T14:00:00.000Z', points: { expiringPoints: 1234 } });
      expect(JSON.parse(h.conn.state.snapshot).programs).toHaveLength(r.programs);
    });

    test('reads only the five SiteOne pages, by navigation; the vendor login comes from the SiteOne vendor row', async () => {
      const h = harness();
      await runSiteOneProgramsCheck(h.deps);
      expect(h.getCredentials).toHaveBeenCalledWith(h.conn, 7);
      expect(h.page.st.visited).toEqual([
        'https://www.siteone.com/eop',
        'https://www.siteone.com/en/Promotions',
        'https://www.siteone.com/eop-turf-fl',
        'https://www.siteone.com/eop-pestmanagement',
        'https://www.siteone.com/en/my-account/accountPartnerProgram',
      ]);
    });

    test('second run, unchanged site: nothing new, but things still ending ring', async () => {
      const first = harness();
      await runSiteOneProgramsCheck(first.deps);
      const second = harness({ snapshot: first.conn.state.snapshot });
      const r = await runSiteOneProgramsCheck(second.deps);
      expect(r).toMatchObject({ baseline: false, added: 0, notified: true });
      expect(second.alerts[0].opts.detail).not.toContain('NEW (');
      expect(second.alerts[0].opts.detail).toContain('ENDING WITHIN 30 DAYS');
    });

    test('no bell when nothing is new, nothing ends within 30 days and no points expire within 60', async () => {
      const first = harness();
      await runSiteOneProgramsCheck(first.deps);
      const quietPartners = PARTNERS_TEXT.replace('Dec 31,2026', 'Jun 30,2027');
      const quietEop = EOP_TEXT.replace('July 1 - November 15, 2026', 'July 1 - January 15, 2027');
      const quietPromo = PROMO_TEXT.replace('November 20', 'January 20').replace('November 22', 'January 22');
      const pages = { ...PAGES, 'https://www.siteone.com/eop': quietEop, 'https://www.siteone.com/en/Promotions': quietPromo, 'https://www.siteone.com/en/my-account/accountPartnerProgram': quietPartners };
      // Re-seed the snapshot from the quiet pages so only "no change" is under test.
      const seed = harness({ pages });
      await runSiteOneProgramsCheck(seed.deps);
      const again = harness({ pages, snapshot: seed.conn.state.snapshot });
      const r = await runSiteOneProgramsCheck(again.deps);
      expect(r).toMatchObject({ added: 0, endingSoon: 0, pointsSoon: false, notified: false });
      expect(again.raise).not.toHaveBeenCalled();
      expect(again.conn.state.writes.map((w) => w.row.key)).toContain(SNAPSHOT_KEY); // the snapshot is still refreshed
    });

    test('a new program since last month rings with the new count', async () => {
      const first = harness();
      await runSiteOneProgramsCheck(first.deps);
      const withNew = EOP_TEXT.replace('Syngenta\nAug. 1', 'Corteva\nNov. 1 – Dec. 20, 2026\nNew offer.\nSyngenta\nAug. 1');
      const h = harness({ snapshot: first.conn.state.snapshot, pages: { ...PAGES, 'https://www.siteone.com/eop': withNew } });
      const r = await runSiteOneProgramsCheck(h.deps);
      expect(r.added).toBe(1);
      expect(h.alerts[0].spec.action).toBe('review 1 new SiteOne program');
      expect(h.alerts[0].spec.why).toBe('1 new; 3 end within 30 days.');
      expect(h.alerts[0].opts.detail).toMatch(/NEW \(1\)\n- \[Supplier EOP\] Corteva/);
    });

    test('promotions page unreadable: last month\'s promotions are carried, not reported new or gone; the warning is in the detail', async () => {
      const first = harness();
      await runSiteOneProgramsCheck(first.deps);
      const pages = { ...PAGES, 'https://www.siteone.com/en/Promotions': new Error('timeout') };
      const h = harness({ snapshot: first.conn.state.snapshot, pages });
      const r = await runSiteOneProgramsCheck(h.deps);
      expect(r.added).toBe(0);
      expect(r.warnings.join(' ')).toMatch(/Promotions page/);
      const saved = JSON.parse(h.conn.state.snapshot);
      expect(saved.programs.filter((p) => p.source === 'promo')).toHaveLength(2);
      expect(h.alerts[0].opts.detail).toContain('NOT READ THIS RUN');
    });

    test('failure: /eop shows 0 programs → throws, one failure alert, no snapshot write', async () => {
      const h = harness({ pages: { ...PAGES, 'https://www.siteone.com/eop': 'Sign in to see your programs' } });
      await expect(runSiteOneProgramsCheck(h.deps)).rejects.toThrow(/0 programs/);
      expect(h.alerts).toHaveLength(1);
      expect(h.alerts[0].spec).toMatchObject({ area: 'System', action: 'SiteOne programs check failed' });
      expect(h.alerts[0].opts.detail).toMatch(/0 programs/);
      expect(h.conn.state.writes).toHaveLength(0);
    });

    test.each([
      ['login fails', { signIn: async () => { throw new Error('siteone login failed: boom'); } }, /login failed/],
      ['browser unavailable', { signIn: async () => { throw new Error('siteone bot: playwright unavailable'); } }, /playwright unavailable/],
      ['no SiteOne vendor row', { vendor: null }, /vendor row/],
    ])('failure: %s → throws, one failure alert, no snapshot write', async (_n, opts, re) => {
      const h = harness(opts);
      await expect(runSiteOneProgramsCheck(h.deps)).rejects.toThrow(re);
      expect(h.alerts).toHaveLength(1);
      expect(h.alerts[0].spec.action).toBe('SiteOne programs check failed');
      expect(h.alerts[0].opts.dedupeKey).toBe('siteone-programs-failed:2026-10');
      expect(h.conn.state.writes).toHaveLength(0);
    });

    test('a page that bounces to the sign-in form is a failure, not an empty list', async () => {
      const h = harness({
        signIn: async (o, fn) => {
          const page = fakePage(PAGES);
          page.goto = async () => { page.st.url = 'https://www.siteone.com/en/login'; };
          return fn(page);
        },
      });
      await expect(runSiteOneProgramsCheck(h.deps)).rejects.toThrow(/sign-in form/);
      expect(h.conn.state.writes).toHaveLength(0);
    });

    test('the alert not saving keeps the old snapshot (so the new programs ring next time) and fails the run', async () => {
      const h = harness();
      h.raise.mockImplementation(async (cat, spec) => { composeAdminAlert(spec); return spec.action === 'SiteOne programs check failed' ? { id: 'f' } : null; });
      await expect(runSiteOneProgramsCheck(h.deps)).rejects.toThrow(/not saved/);
      expect(h.conn.state.writes).toHaveLength(0);
    });

    test('the failure alert itself failing does not hide the original error', async () => {
      const h = harness({ signIn: async () => { throw new Error('siteone login failed: boom'); } });
      h.raise.mockRejectedValue(new Error('alert store down'));
      await expect(runSiteOneProgramsCheck(h.deps)).rejects.toThrow(/login failed/);
    });
  });
});

// ---- month-by-month history ---------------------------------------------------------------

describe('program history', () => {
  beforeEach(() => { process.env[GATE] = 'true'; });
  const monthRow = (m, extra = {}) => JSON.stringify({ version: 1, takenAt: `${m}-01T13:00:00.000Z`, programs: [{ key: `k-${m}`, name: `P ${m}` }], points: null, ...extra });

  test('a successful run writes the latest row AND a row for this month, same JSON, in one transaction', async () => {
    const h = harness();
    await runSiteOneProgramsCheck(h.deps);
    const latest = h.conn.state.rows.get(SNAPSHOT_KEY);
    expect(h.conn.state.rows.get(`${HISTORY_PREFIX}2026-10`)).toBe(latest);
    expect(JSON.parse(latest)).toMatchObject({ takenAt: '2026-10-26T14:00:00.000Z', points: { available: 4321 } });
    expect(JSON.parse(latest).programs.length).toBeGreaterThan(0);
    expect(h.conn.state.transactions).toBe(1);
    expect(`${HISTORY_PREFIX}2026-10`.length).toBeLessThanOrEqual(100); // system_settings.key is varchar(100)
    expect(h.conn.state.writes.every((w) => w.row.category === 'procurement')).toBe(true);
  });

  test('a run in the same month overwrites that month; a failed run writes no history', async () => {
    const first = harness();
    await runSiteOneProgramsCheck(first.deps);
    const bad = harness({ settings: Object.fromEntries(first.conn.state.rows), pages: { ...PAGES, 'https://www.siteone.com/eop': 'nothing' } });
    const before = new Map(bad.conn.state.rows);
    await expect(runSiteOneProgramsCheck(bad.deps)).rejects.toThrow();
    expect(bad.conn.state.rows).toEqual(before);
    expect(bad.conn.state.writes).toHaveLength(0);
  });

  test('keeps 24 months: older month rows are deleted in the same write, newer ones and the latest row stay', async () => {
    const settings = {};
    // 2024-11 is the 24th month counting 2026-10 (inside); 2024-10 and older are outside.
    for (const m of ['2024-07', '2024-09', '2024-10', '2024-11', '2025-03', '2026-09']) settings[`${HISTORY_PREFIX}${m}`] = monthRow(m);
    const h = harness({ settings });
    await runSiteOneProgramsCheck(h.deps);
    const kept = [...h.conn.state.rows.keys()].filter((k) => k.startsWith(HISTORY_PREFIX)).map((k) => k.slice(HISTORY_PREFIX.length)).sort();
    expect(kept).toEqual(['2024-11', '2025-03', '2026-09', '2026-10']);
    expect(h.conn.state.deleted.sort()).toEqual([`${HISTORY_PREFIX}2024-07`, `${HISTORY_PREFIX}2024-09`, `${HISTORY_PREFIX}2024-10`]);
    expect(h.conn.state.rows.has(SNAPSHOT_KEY)).toBe(true);
  });

  test('oldestKeptMonth counts this month as one of the 24', () => {
    expect(oldestKeptMonth('2026-10')).toBe('2024-11');
    expect(oldestKeptMonth('2026-12')).toBe('2025-01');
    expect(oldestKeptMonth('2026-01')).toBe('2024-02');
  });

  test('loadProgramHistory: newest first, month + takenAt + programs + points, the latest row is not a month', async () => {
    const conn = fakeConn({
      snapshot: monthRow('2026-10'),
      settings: {
        [`${HISTORY_PREFIX}2026-08`]: monthRow('2026-08'),
        [`${HISTORY_PREFIX}2026-10`]: monthRow('2026-10', { points: { available: 9, expiringPoints: 0, expiresOn: null } }),
        [`${HISTORY_PREFIX}2026-09`]: monthRow('2026-09'),
        [`${HISTORY_PREFIX}2026-07`]: 'not json',
      },
    });
    const history = await loadProgramHistory(conn, { months: 12 });
    expect(history.map((h) => h.month)).toEqual(['2026-10', '2026-09', '2026-08']);
    expect(history[0]).toEqual({ month: '2026-10', takenAt: '2026-10-01T13:00:00.000Z', programs: [{ key: 'k-2026-10', name: 'P 2026-10' }], points: { available: 9, expiringPoints: 0, expiresOn: null } });
    expect(history[1].points).toBeNull();
  });

  test('loadProgramHistory honors the months limit', async () => {
    const settings = {};
    for (const m of ['2026-05', '2026-06', '2026-07', '2026-08']) settings[`${HISTORY_PREFIX}${m}`] = monthRow(m);
    const history = await loadProgramHistory(fakeConn({ settings }), { months: 2 });
    expect(history.map((h) => h.month)).toEqual(['2026-08', '2026-07']);
  });
});

// ---- the adapter helper ----------------------------------------------------------------

describe('adapters/siteone readSignedIn', () => {
  const creds = { email: 'buyer@example.com', password: 'pw' };
  const resolveHostIps = async () => ['203.0.113.10'];

  test('exported next to place()', () => {
    expect(typeof siteone.readSignedIn).toBe('function');
    expect(typeof siteone.place).toBe('function');
  });

  test('no stored login → refused before the browser launches', async () => {
    const launchBrowser = jest.fn();
    await expect(siteone.readSignedIn({ credentials: null, launchBrowser, resolveHostIps }, async () => 1)).rejects.toMatchObject({ refuse: 'no_credentials' });
    expect(launchBrowser).not.toHaveBeenCalled();
  });

  test('no browser library → run-level error, fn never runs', async () => {
    const fn = jest.fn();
    await expect(siteone.readSignedIn({ credentials: creds, launchBrowser: null, resolveHostIps }, fn)).rejects.toMatchObject({ runLevel: true });
    expect(fn).not.toHaveBeenCalled();
  });

  test('browser setup failing after launch still closes Chromium', async () => {
    const browser = { newContext: async () => { throw new Error('context boom'); }, close: jest.fn(async () => {}) };
    const fn = jest.fn();
    await expect(siteone.readSignedIn({ credentials: creds, launchBrowser: async () => browser, resolveHostIps }, fn)).rejects.toMatchObject({ runLevel: true });
    expect(browser.close).toHaveBeenCalledTimes(1);
    expect(fn).not.toHaveBeenCalled();
  });
});
