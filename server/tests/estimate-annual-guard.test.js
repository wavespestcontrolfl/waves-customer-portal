const { annualPlanOfferFingerprint } = require('../services/estimate-offer-version');
const { loadAnnualOfferRow, annualOfferVerdict, estimateIdsFromContent, annualHandoffGuard } = require('../services/estimate-annual-guard');

const PLAN_LINE = { service: 'termite_bait', plan: 'annual_protection', stations: 15 };
const QUARTERLY_LINE = { ...PLAN_LINE, plan: 'quarterly' };
const row = (data = { result: { lineItems: [PLAN_LINE] } }, overrides = {}) => ({
  id: 'synthetic-annual', status: 'draft', expires_at: null,
  monthly_total: 0, annual_total: 299, onetime_total: 450, estimate_data: data,
  customer_id: 'cust-1', property_id: 'prop-1', estimate_group_id: null, customer_name: 'Synthetic Customer',
  customer_phone: '9415550100', customer_email: 'synthetic@example.test', address: 'Synthetic property',
  notes: null, show_one_time_option: false, bill_by_invoice: false, waveguard_tier: null,
  service_interest: null, category: null, source: null,
  ...overrides,
});
const delivered = (overrides = {}) => {
  const estimate = row(undefined, overrides);
  estimate.status = 'sent';
  estimate.estimate_data.deliveryState = {
    firstDeliveredAt: '2026-01-01T12:00:00Z',
    annualPlanOfferFingerprint: annualPlanOfferFingerprint(estimate),
  };
  return estimate;
};

const prior = [process.env.GATE_TERMITE_ANNUAL_PLAN, process.env.GATE_CANCEL_FLOW_V2];
beforeEach(() => {
  process.env.GATE_TERMITE_ANNUAL_PLAN = process.env.GATE_CANCEL_FLOW_V2 = 'false';
});
afterAll(() => {
  ['GATE_TERMITE_ANNUAL_PLAN', 'GATE_CANCEL_FLOW_V2'].forEach((key, index) => {
    if (prior[index] === undefined) delete process.env[key]; else process.env[key] = prior[index];
  });
});

// Minimal knex-shaped fake: db('estimates').where({id}).first(...cols) and
// the same chain with .forUpdate() inserted before .first(). Each call is
// recorded on `calls` so tests can assert the table/columns/lock used —
// mirrors the codebase's own first(...cols) idiom (never select().first()).
function fakeDb(rowsById, calls = []) {
  const db = (table) => {
    const call = { table, where: null, first: null, forUpdate: false };
    calls.push(call);
    const builder = {
      where(cond) { call.where = cond; return builder; },
      forUpdate() { call.forUpdate = true; return builder; },
      first: async (...cols) => { call.first = cols; return rowsById[call.where && call.where.id]; },
    };
    return builder;
  };
  return db;
}

describe('annualOfferVerdict', () => {
  test.each([
    ['quarterly row', row({ result: { lineItems: [QUARTERLY_LINE] } }), false],
    ['missing row', null, false],
  ])('%s is never withheld', (_label, r, withheld) => {
    expect(annualOfferVerdict(r)).toEqual({ withheld, reason: withheld ? 'annual_offer_withheld' : null });
  });

  test('annual row with both gates on is not withheld', () => {
    process.env.GATE_TERMITE_ANNUAL_PLAN = 'true';
    process.env.GATE_CANCEL_FLOW_V2 = 'true';
    expect(annualOfferVerdict(row())).toEqual({ withheld: false, reason: null });
  });

  test('annual row, gate off, matching fingerprint is not withheld', () => {
    expect(annualOfferVerdict(delivered())).toEqual({ withheld: false, reason: null });
  });

  test('annual row, gate off, missing fingerprint is withheld', () => {
    const estimate = row();
    expect(annualOfferVerdict(estimate)).toEqual({ withheld: true, reason: 'annual_offer_withheld' });
  });

  test('annual row, gate off, stale fingerprint is withheld', () => {
    const estimate = delivered();
    estimate.estimate_data.deliveryState.annualPlanOfferFingerprint = 'stale-fingerprint';
    expect(annualOfferVerdict(estimate)).toEqual({ withheld: true, reason: 'annual_offer_withheld' });
  });

  test.each(['accepted', 'declined'])('%s status is never withheld even with no delivered fingerprint', (status) => {
    const estimate = row();
    estimate.status = status;
    expect(annualOfferVerdict(estimate)).toEqual({ withheld: false, reason: null });
  });
});

describe('loadAnnualOfferRow', () => {
  test('selects id/status/expires_at/estimate_data plus every fingerprint column', async () => {
    const calls = [];
    const db = fakeDb({ 'est-1': row() }, calls);
    const result = await loadAnnualOfferRow(db, 'est-1');
    expect(result).toEqual(row());
    expect(calls).toHaveLength(1);
    expect(calls[0].table).toBe('estimates');
    expect(calls[0].where).toEqual({ id: 'est-1' });
    expect(calls[0].forUpdate).toBe(false);
    expect(calls[0].first).toEqual(expect.arrayContaining([
      'id', 'status', 'expires_at', 'estimate_data',
      'customer_id', 'property_id', 'estimate_group_id', 'customer_name', 'customer_phone',
      'customer_email', 'address', 'notes', 'monthly_total', 'annual_total', 'onetime_total',
      'show_one_time_option', 'bill_by_invoice', 'waveguard_tier', 'service_interest', 'category', 'source',
    ]));
  });

  test('forUpdate: true locks the row', async () => {
    const calls = [];
    const db = fakeDb({ 'est-1': row() }, calls);
    await loadAnnualOfferRow(db, 'est-1', { forUpdate: true });
    expect(calls[0].forUpdate).toBe(true);
  });

  test('default forUpdate is false (no lock) when the option is omitted', async () => {
    const calls = [];
    const db = fakeDb({ 'est-1': row() }, calls);
    await loadAnnualOfferRow(db, 'est-1');
    expect(calls[0].forUpdate).toBe(false);
  });
});

describe('annualHandoffGuard', () => {
  test('a single withheld estimate blocks with its id', async () => {
    const db = fakeDb({ 'est-1': row() });
    const verdict = await annualHandoffGuard({ db, estimateIds: ['est-1'] })();
    expect(verdict).toEqual({ blocked: true, reason: 'annual_offer_withheld', estimateId: 'est-1' });
  });

  test('all delivered estimates are not blocked', async () => {
    const db = fakeDb({ 'est-1': delivered(), 'est-2': delivered({ id: 'est-2' }) });
    const verdict = await annualHandoffGuard({ db, estimateIds: ['est-1', 'est-2'] })();
    expect(verdict).toEqual({ blocked: false, reason: null, estimateId: null });
  });

  test('blocks on any one withheld id among several, without reading ids after it', async () => {
    const calls = [];
    const db = fakeDb({ 'est-1': delivered(), 'est-2': row({ result: { lineItems: [PLAN_LINE] } }), 'est-3': delivered({ id: 'est-3' }) }, calls);
    const verdict = await annualHandoffGuard({ db, estimateIds: ['est-1', 'est-2', 'est-3'] })();
    expect(verdict).toEqual({ blocked: true, reason: 'annual_offer_withheld', estimateId: 'est-2' });
    expect(calls.map((c) => c.where.id)).toEqual(['est-1', 'est-2']);
  });

  test('a single estimateId (not an array) is accepted', async () => {
    const db = fakeDb({ 'est-1': row() });
    const verdict = await annualHandoffGuard({ db, estimateIds: 'est-1' })();
    expect(verdict.blocked).toBe(true);
  });

  test('null/undefined ids are ignored, an empty id list is never blocked', async () => {
    const db = fakeDb({});
    expect(await annualHandoffGuard({ db, estimateIds: [null, undefined] })()).toEqual({ blocked: false, reason: null, estimateId: null });
    expect(await annualHandoffGuard({ db, estimateIds: [] })()).toEqual({ blocked: false, reason: null, estimateId: null });
  });

  test('an unknown/missing estimate id is not this guard\'s job — not blocked', async () => {
    const db = fakeDb({});
    const verdict = await annualHandoffGuard({ db, estimateIds: ['does-not-exist'] })();
    expect(verdict).toEqual({ blocked: false, reason: null, estimateId: null });
  });

  test('a loader error propagates out of the guard rather than being treated as allowed', async () => {
    const db = () => ({
      where() { return this; },
      forUpdate() { return this; },
      first: async () => { throw new Error('connection lost'); },
    });
    await expect(annualHandoffGuard({ db, estimateIds: ['est-1'] })()).rejects.toThrow('connection lost');
  });
});

// Table-routed fake for estimateIdsFromContent's two possible queries:
// estimates (.whereIn('token', ...).select('id')) and short_codes
// (.whereIn('code', ...).select(...)). Each db(table) call is recorded on
// `calls` so tests can assert exactly how many queries ran (or none).
function fakeContentDb({ estimates = [], shortCodes = [] } = {}, calls = []) {
  return (table) => {
    calls.push(table);
    const builder = {
      whereIn(col, vals) {
        builder.select = async () => {
          const source = table === 'short_codes' ? shortCodes : estimates;
          return source.filter((r) => vals.includes(r[col]));
        };
        return builder;
      },
    };
    return builder;
  };
}

describe('estimateIdsFromContent', () => {
  test('long link with a query string and trailing punctuation resolves its token', async () => {
    const calls = [];
    const db = fakeContentDb({ estimates: [{ id: 'est-1', token: 'abc123token' }] }, calls);
    const ids = await estimateIdsFromContent(db, [
      'View your estimate: https://portal.wavespestcontrol.com/estimate/abc123token?utm=sms&ref=1).',
    ]);
    expect(ids).toEqual(['est-1']);
    expect(calls).toEqual(['estimates']);
  });

  test('a short code whose entity_type is estimates resolves entity_id directly, without a second query', async () => {
    const calls = [];
    const db = fakeContentDb({
      shortCodes: [{ code: 'k3j9code', target_url: 'https://portal.wavespestcontrol.com/estimate/abc123token', entity_type: 'estimates', entity_id: 'est-42' }],
    }, calls);
    const ids = await estimateIdsFromContent(db, ['You can view your estimate here: https://portal.wavespestcontrol.com/l/k3j9code']);
    expect(ids).toEqual(['est-42']);
    // entity_type already answered it — no second (estimates) query needed.
    expect(calls).toEqual(['short_codes']);
  });

  test('a short code minted for something else whose target_url is itself a long estimate link resolves via the re-scan', async () => {
    const calls = [];
    const db = fakeContentDb({
      estimates: [{ id: 'est-77', token: 'longtoken1' }],
      shortCodes: [{ code: 'xyz9', target_url: 'https://portal.wavespestcontrol.com/estimate/longtoken1', entity_type: null, entity_id: null }],
    }, calls);
    const ids = await estimateIdsFromContent(db, ['https://portal.wavespestcontrol.com/l/xyz9']);
    expect(ids).toEqual(['est-77']);
    expect(calls).toEqual(['short_codes', 'estimates']);
  });

  test('a short code for something else entirely (target_url carries no estimate link) is ignored', async () => {
    const calls = [];
    const db = fakeContentDb({
      shortCodes: [{ code: 'inv1code', target_url: 'https://portal.wavespestcontrol.com/pay/invoice-1', entity_type: 'invoices', entity_id: 'inv-1' }],
    }, calls);
    const ids = await estimateIdsFromContent(db, ['Pay here: https://portal.wavespestcontrol.com/l/inv1code']);
    expect(ids).toEqual([]);
    // The short code resolved to a non-estimate entity and its target has no
    // estimate link either — no estimates query needed.
    expect(calls).toEqual(['short_codes']);
  });

  test('no links at all in any text runs NO query', async () => {
    const calls = [];
    const db = fakeContentDb({}, calls);
    const ids = await estimateIdsFromContent(db, ['Hi Sam, your technician is on the way!', undefined, null, '']);
    expect(ids).toEqual([]);
    expect(calls).toEqual([]);
  });

  test('a single non-array texts argument is accepted', async () => {
    const calls = [];
    const db = fakeContentDb({ estimates: [{ id: 'est-1', token: 'solotoken1' }] }, calls);
    const ids = await estimateIdsFromContent(db, 'https://portal.wavespestcontrol.com/estimate/solotoken1');
    expect(ids).toEqual(['est-1']);
  });

  test('multiple long tokens and short codes across several texts are deduped into one id set', async () => {
    const calls = [];
    const db = fakeContentDb({
      estimates: [{ id: 'est-1', token: 'tok1' }, { id: 'est-2', token: 'tok2' }],
      shortCodes: [{ code: 'sc1code', target_url: 'https://portal.wavespestcontrol.com/estimate/tok1', entity_type: 'estimates', entity_id: 'est-1' }],
    }, calls);
    const ids = await estimateIdsFromContent(db, [
      'https://portal.wavespestcontrol.com/estimate/tok1 and again https://portal.wavespestcontrol.com/estimate/tok1',
      'https://portal.wavespestcontrol.com/l/sc1code',
      'https://portal.wavespestcontrol.com/estimate/tok2',
    ]);
    expect(ids.slice().sort()).toEqual(['est-1', 'est-2']);
    expect(calls).toEqual(['short_codes', 'estimates']);
  });
});

describe('annualHandoffGuard content derivation (Codex round 1 on #4608, P1)', () => {
  // Proves the composer manual SMS (admin-communications.js) and
  // composer-customer-links.js need NO code change: their body carries only
  // a short link, no explicit estimateId — the guard still resolves and
  // blocks a withheld estimate through it, purely from the short_codes
  // entity_type/entity_id the composer's own mint already stamps.
  test('a short code row with entity_type "estimates" resolves to a withheld estimate — blocked, no explicit id needed', async () => {
    const withheldRow = row(); // annual plan, no delivered fingerprint -> withheld
    const calls = [];
    const shortCodesDb = fakeContentDb({
      shortCodes: [{ code: 'compose1', target_url: 'https://portal.wavespestcontrol.com/estimate/synthetic-token', entity_type: 'estimates', entity_id: withheldRow.id }],
    }, calls);
    // annualHandoffGuard's per-id loop uses loadAnnualOfferRow's
    // where({id}).first(...) shape — union the two fake db behaviors so one
    // db instance answers both the content-derivation queries and the
    // per-id row lookups the guard makes afterward.
    const loaderDb = fakeDb({ [withheldRow.id]: withheldRow });
    const db = (table) => (table === 'short_codes' ? shortCodesDb(table) : loaderDb(table));

    const verdict = await annualHandoffGuard({
      db, estimateIds: [], texts: ['You can view your estimate here: https://portal.wavespestcontrol.com/l/compose1'],
    })();

    expect(verdict).toEqual({ blocked: true, reason: 'annual_offer_withheld', estimateId: withheldRow.id });
  });

  test('the same short code resolving to a DELIVERED estimate is never blocked', async () => {
    const deliveredRow = delivered();
    const shortCodesDb = fakeContentDb({
      shortCodes: [{ code: 'compose2', target_url: 'https://portal.wavespestcontrol.com/estimate/synthetic-token', entity_type: 'estimates', entity_id: deliveredRow.id }],
    });
    const loaderDb = fakeDb({ [deliveredRow.id]: deliveredRow });
    const db = (table) => (table === 'short_codes' ? shortCodesDb(table) : loaderDb(table));

    const verdict = await annualHandoffGuard({
      db, estimateIds: [], texts: ['You can view your estimate here: https://portal.wavespestcontrol.com/l/compose2'],
    })();

    expect(verdict).toEqual({ blocked: false, reason: null, estimateId: null });
  });

  test('an explicit estimateId is a UNION with content derivation, not a replacement', async () => {
    const explicitWithheld = row(undefined, { id: 'explicit-withheld' });
    const contentDelivered = delivered({ id: 'content-delivered' });
    const shortCodesDb = fakeContentDb({
      shortCodes: [{ code: 'union1', target_url: '', entity_type: 'estimates', entity_id: 'content-delivered' }],
    });
    const loaderDb = fakeDb({ 'explicit-withheld': explicitWithheld, 'content-delivered': contentDelivered });
    const db = (table) => (table === 'short_codes' ? shortCodesDb(table) : loaderDb(table));

    // The content link alone resolves to a delivered (not withheld)
    // estimate, but the caller ALSO passed an explicit withheld id — the
    // union still blocks on it.
    const verdict = await annualHandoffGuard({
      db, estimateIds: ['explicit-withheld'], texts: ['https://portal.wavespestcontrol.com/l/union1'],
    })();

    expect(verdict).toEqual({ blocked: true, reason: 'annual_offer_withheld', estimateId: 'explicit-withheld' });
  });
});
