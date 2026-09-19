const { annualPlanOfferFingerprint } = require('../services/estimate-offer-version');
const { loadAnnualOfferRow, annualOfferVerdict, estimateIdsFromContent, annualHandoffGuard, rewriteWithheldEstimateLinks, withheldLinkPolicyForTemplate, LONG_LINK_TOKEN_RE } = require('../services/estimate-annual-guard');
const { ESTIMATE_TOKEN_RE } = require('../routes/estimate-public');

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
    const db = fakeContentDb({ estimates: [{ id: 'est-1', token: 'abc123tokenfifteen' }] }, calls);
    const ids = await estimateIdsFromContent(db, [
      'View your estimate: https://portal.wavespestcontrol.com/estimate/abc123tokenfifteen?utm=sms&ref=1).',
    ]);
    expect(ids).toEqual(['est-1']);
    expect(calls).toEqual(['estimates']);
  });

  test('a short code whose entity_type is estimates resolves entity_id directly, without a second query', async () => {
    const calls = [];
    const db = fakeContentDb({
      shortCodes: [{ code: 'k3j9code', target_url: 'https://portal.wavespestcontrol.com/estimate/abc123tokenfifteen', entity_type: 'estimates', entity_id: 'est-42' }],
    }, calls);
    const ids = await estimateIdsFromContent(db, ['You can view your estimate here: https://portal.wavespestcontrol.com/l/k3j9code']);
    expect(ids).toEqual(['est-42']);
    // entity_type already answered it — no second (estimates) query needed.
    expect(calls).toEqual(['short_codes']);
  });

  test('a short code minted for something else whose target_url is itself a long estimate link resolves via the re-scan', async () => {
    const calls = [];
    const db = fakeContentDb({
      estimates: [{ id: 'est-77', token: 'longtoken1fifteen' }],
      shortCodes: [{ code: 'xyz9', target_url: 'https://portal.wavespestcontrol.com/estimate/longtoken1fifteen', entity_type: null, entity_id: null }],
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
    const db = fakeContentDb({ estimates: [{ id: 'est-1', token: 'solotoken1fifteen' }] }, calls);
    const ids = await estimateIdsFromContent(db, 'https://portal.wavespestcontrol.com/estimate/solotoken1fifteen');
    expect(ids).toEqual(['est-1']);
  });

  test('multiple long tokens and short codes across several texts are deduped into one id set', async () => {
    const calls = [];
    const db = fakeContentDb({
      estimates: [{ id: 'est-1', token: 'tok1fifteencharsx' }, { id: 'est-2', token: 'tok2fifteencharsx' }],
      shortCodes: [{ code: 'sc1code', target_url: 'https://portal.wavespestcontrol.com/estimate/tok1fifteencharsx', entity_type: 'estimates', entity_id: 'est-1' }],
    }, calls);
    const ids = await estimateIdsFromContent(db, [
      'https://portal.wavespestcontrol.com/estimate/tok1fifteencharsx and again https://portal.wavespestcontrol.com/estimate/tok1fifteencharsx',
      'https://portal.wavespestcontrol.com/l/sc1code',
      'https://portal.wavespestcontrol.com/estimate/tok2fifteencharsx',
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

describe('LONG_LINK_TOKEN_RE mirrors the canonical ESTIMATE_TOKEN_RE exactly (Codex round 2 on #4608, P1)', () => {
  // Extract whatever LONG_LINK_TOKEN_RE captures when the sample is embedded
  // as a long link followed by a non-charset stopper (a space) — mirrors
  // real usage (a token never sits at the very end of a message with
  // nothing after it in practice, but the stopper also proves the charset
  // boundary is exact either way).
  function extractedToken(sample) {
    LONG_LINK_TOKEN_RE.lastIndex = 0;
    const match = LONG_LINK_TOKEN_RE.exec(`https://portal.wavespestcontrol.com/estimate/${sample} `);
    return match ? match[1] : null;
  }

  test.each([
    ['abcdefghij12345', 'exactly 15 chars, alnum only (minimum valid length)'],
    ['a'.repeat(64), '64 chars (maximum valid length)'],
    ['a'.repeat(65), '65 chars — over the max, invalid'],
    ['short', 'under 15 chars, invalid'],
    ['abc_def-ghi_jkl_mno', 'contains both _ and - as interior content, valid'],
    ['trailing-dash-token-', 'ends in -, valid content per the canonical gate'],
    ['trailing_underscore_', 'ends in _, valid content per the canonical gate'],
    ['has spaces in it here', 'contains a space, invalid'],
    ['has.dots.in.it.here12', 'contains a dot, invalid'],
  ])('%j (%s): extraction parity with ESTIMATE_TOKEN_RE', (sample) => {
    const canonicalAccepts = ESTIMATE_TOKEN_RE.test(sample);
    const extracted = extractedToken(sample);
    if (canonicalAccepts) {
      // The guard's regex must capture the token WHOLE — no truncation of
      // valid `_`/`-` content — exactly what the public gate would accept.
      expect(extracted).toBe(sample);
    } else {
      // An invalid sample (too short/long, or containing a character
      // outside the canonical charset) must never be captured whole either
      // — either no match at all, or a match that stops short of the full
      // (invalid) string.
      expect(extracted).not.toBe(sample);
    }
  });
});

// ── Group expansion (Codex round 2 on #4608, P1) ──────────────────────────
// A small but faithful in-memory knex stand-in supporting exactly the chain
// pricing-authority-gate.js's applyLinkVisibleSiblingScope uses (whereIn /
// whereNotIn / whereNull / whereRaw / nested where+orWhere / orWhereIn),
// PLUS loadAnnualOfferRow's own where({id}).first(...cols) shape — the same
// db instance serves both the per-id verdict loop and the group-sibling
// query. Each builder method returns a NEW builder wrapping an updated row
// predicate (AND by default; the nested-callback forms compose true
// AND/OR), so the same composition knex itself does is reproduced exactly
// for this fixed, known query shape — not a general-purpose knex emulator.
function fakeGroupDb(rows, calls = []) {
  const allRows = () => rows;
  const makeBuilder = (pred = () => true) => {
    const builder = {
      _pred: pred,
      where(arg) {
        if (typeof arg === 'function') {
          const result = arg(makeBuilder(() => true));
          return makeBuilder((row) => pred(row) && result._pred(row));
        }
        return makeBuilder((row) => pred(row) && Object.entries(arg).every(([k, v]) => row[k] === v));
      },
      orWhere(...args) {
        if (typeof args[0] === 'function') {
          const result = args[0](makeBuilder(() => true));
          return makeBuilder((row) => pred(row) || result._pred(row));
        }
        const [col, op, val] = args.length === 3 ? args : [args[0], '=', args[1]];
        const cmp = { '>': (a, b) => a > b, '<': (a, b) => a < b, '>=': (a, b) => a >= b, '<=': (a, b) => a <= b, '=': (a, b) => a === b }[op];
        return makeBuilder((row) => {
          if (pred(row)) return true;
          const rv = row[col];
          if (rv == null) return false;
          const a = rv instanceof Date ? rv : new Date(rv);
          const b = val instanceof Date ? val : new Date(val);
          return cmp(a.getTime(), b.getTime());
        });
      },
      whereIn(col, arr) { return makeBuilder((row) => pred(row) && arr.includes(row[col])); },
      orWhereIn(col, arr) { return makeBuilder((row) => pred(row) || arr.includes(row[col])); },
      whereNotIn(col, arr) { return makeBuilder((row) => pred(row) && !arr.includes(row[col])); },
      whereNull(col) { return makeBuilder((row) => pred(row) && row[col] == null); },
      whereRaw() { return builder; }, // no-op AND-true: test fixtures never set the invalidation markers
      forUpdate() { return builder; },
      first: async (..._cols) => allRows().filter(pred)[0] || null,
      select: async (..._cols) => allRows().filter(pred),
    };
    return builder;
  };
  return (table) => {
    calls.push(table);
    if (table !== 'estimates') throw new Error(`fakeGroupDb: unexpected table ${table}`);
    return makeBuilder();
  };
}

describe('annualHandoffGuard group expansion (Codex round 2 on #4608, P1)', () => {
  test('anchor delivered + a link-visible sibling withheld -> blocked on the sibling', async () => {
    const anchor = delivered({ id: 'anchor-1', estimate_group_id: 'grp-1' });
    const sibling = row(undefined, {
      id: 'sibling-withheld', estimate_group_id: 'grp-1', archived_at: null,
      status: 'sent', expires_at: null, // live + unexpired -> link-visible
    });
    const calls = [];
    const db = fakeGroupDb([anchor, sibling], calls);

    const verdict = await annualHandoffGuard({ db, estimateIds: ['anchor-1'] })();

    expect(verdict).toEqual({ blocked: true, reason: 'annual_offer_withheld', estimateId: 'sibling-withheld' });
  });

  test('anchor delivered + a NON-visible (draft) sibling with a stale fingerprint -> allowed', async () => {
    const anchor = delivered({ id: 'anchor-1', estimate_group_id: 'grp-2' });
    const draftSibling = row(undefined, {
      id: 'sibling-draft', estimate_group_id: 'grp-2', archived_at: null,
      status: 'draft', // draft is never link-visible (not live, not terminal)
    });
    const calls = [];
    const db = fakeGroupDb([anchor, draftSibling], calls);

    const verdict = await annualHandoffGuard({ db, estimateIds: ['anchor-1'] })();

    expect(verdict).toEqual({ blocked: false, reason: null, estimateId: null });
  });

  test('anchor delivered + an ARCHIVED sibling with a stale fingerprint -> allowed', async () => {
    const anchor = delivered({ id: 'anchor-1', estimate_group_id: 'grp-3' });
    const archivedSibling = row(undefined, {
      id: 'sibling-archived', estimate_group_id: 'grp-3', archived_at: new Date('2026-01-01T00:00:00Z'),
      status: 'sent',
    });
    const db = fakeGroupDb([anchor, archivedSibling]);

    const verdict = await annualHandoffGuard({ db, estimateIds: ['anchor-1'] })();

    expect(verdict).toEqual({ blocked: false, reason: null, estimateId: null });
  });

  test('anchor delivered + an EXPIRED-live sibling (status sent/viewed but expires_at in the past) with a stale fingerprint -> allowed', async () => {
    const anchor = delivered({ id: 'anchor-1', estimate_group_id: 'grp-4' });
    const expiredSibling = row(undefined, {
      id: 'sibling-expired', estimate_group_id: 'grp-4', archived_at: null,
      status: 'sent', expires_at: new Date('2020-01-01T00:00:00Z'),
    });
    const db = fakeGroupDb([anchor, expiredSibling]);

    const verdict = await annualHandoffGuard({ db, estimateIds: ['anchor-1'] })();

    expect(verdict).toEqual({ blocked: false, reason: null, estimateId: null });
  });

  test('a TERMINAL (declined) sibling is link-visible but never withheld itself (annualPlanPublicReplayBlocked exempts accepted/declined) -> allowed', async () => {
    const anchor = delivered({ id: 'anchor-1', estimate_group_id: 'grp-5' });
    const declinedSibling = row(undefined, {
      id: 'sibling-declined', estimate_group_id: 'grp-5', archived_at: null,
      status: 'declined', // terminal -> link-visible, but never withheld regardless of fingerprint
    });
    const db = fakeGroupDb([anchor, declinedSibling]);

    const verdict = await annualHandoffGuard({ db, estimateIds: ['anchor-1'] })();

    expect(verdict).toEqual({ blocked: false, reason: null, estimateId: null });
  });

  test('no estimate_group_id on any base row -> single-row path unchanged, no extra query', async () => {
    const calls = [];
    const db = fakeDb({ 'est-1': delivered({ id: 'est-1' }) }, calls);

    const verdict = await annualHandoffGuard({ db, estimateIds: ['est-1'] })();

    expect(verdict).toEqual({ blocked: false, reason: null, estimateId: null });
    // Exactly one call: loadAnnualOfferRow's own where({id}).first(...) for
    // the base id — no group-sibling query at all.
    expect(calls).toHaveLength(1);
    expect(calls[0].where).toEqual({ id: 'est-1' });
  });
});

describe('rewriteWithheldEstimateLinks (Codex round 3 on #4608, P1 PRRT_kwDOR3YQi86j8Ydp, over-blocking)', () => {
  test('a withheld estimate link is rewritten to the bare portal-home URL, and its id is reported', async () => {
    const withheldRow = row(undefined, { id: 'est-withheld', token: 'withheld-token-a12345' });
    const db = fakeGroupDb([withheldRow]);
    const html = '<p>View it: https://portal.wavespestcontrol.com/estimate/withheld-token-a12345</p>';
    const text = 'https://portal.wavespestcontrol.com/estimate/withheld-token-a12345';

    const result = await rewriteWithheldEstimateLinks({ db, html, text });

    expect(result.rewrittenIds).toEqual(['est-withheld']);
    expect(result.html).toBe('<p>View it: https://portal.wavespestcontrol.com</p>');
    expect(result.text).toBe('https://portal.wavespestcontrol.com');
  });

  test('a delivered (not withheld) estimate link is left untouched', async () => {
    const deliveredRow = delivered({ id: 'est-delivered', token: 'delivered-token-b123456' });
    const db = fakeGroupDb([deliveredRow]);
    const html = '<p>https://portal.wavespestcontrol.com/estimate/delivered-token-b123456</p>';

    const result = await rewriteWithheldEstimateLinks({ db, html, text: '' });

    expect(result.rewrittenIds).toEqual([]);
    expect(result.html).toBe(html);
  });

  test('an anchor link is rewritten when its OWN offer is fine but a link-visible group sibling is withheld', async () => {
    const anchor = delivered({ id: 'anchor-2', estimate_group_id: 'grp-rw-1', token: 'anchor-token-c1234567' });
    const sibling = row(undefined, {
      id: 'sibling-withheld-2', estimate_group_id: 'grp-rw-1', archived_at: null,
      status: 'sent', expires_at: null, token: 'sibling-token-never-linked',
    });
    const db = fakeGroupDb([anchor, sibling]);
    const html = '<p>https://portal.wavespestcontrol.com/estimate/anchor-token-c1234567</p>';

    const result = await rewriteWithheldEstimateLinks({ db, html, text: '' });

    // The anchor's own link is what gets rewritten — the sibling's token
    // never appeared in the content at all, so there is nothing of its own
    // to swap; visiting the anchor's link is what exposes the sibling.
    expect(result.rewrittenIds).toEqual(['anchor-2']);
    expect(result.html).toBe('<p>https://portal.wavespestcontrol.com</p>');
  });

  test('no estimate link in the content: no rewrite, no query', async () => {
    const calls = [];
    const db = fakeGroupDb([], calls);

    const result = await rewriteWithheldEstimateLinks({ db, html: '<p>Hi Sam!</p>', text: 'Hi Sam!' });

    expect(result).toEqual({ html: '<p>Hi Sam!</p>', text: 'Hi Sam!', rewrittenIds: [] });
    expect(calls).toHaveLength(0);
  });

  test('multiple withheld links in the same content are all rewritten, deduped by id', async () => {
    const withheldRow = row(undefined, { id: 'est-dup', token: 'dup-token-d1234567890' });
    const db = fakeGroupDb([withheldRow]);
    const html = '<p>https://portal.wavespestcontrol.com/estimate/dup-token-d1234567890</p>';
    const text = 'Same one again: https://portal.wavespestcontrol.com/estimate/dup-token-d1234567890';

    const result = await rewriteWithheldEstimateLinks({ db, html, text });

    expect(result.rewrittenIds).toEqual(['est-dup']);
    expect(result.html).toBe('<p>https://portal.wavespestcontrol.com</p>');
    expect(result.text).toBe('Same one again: https://portal.wavespestcontrol.com');
  });

  // Pre-push audit P1 (d9b71d84bb round 10): short_codes rows this fixture
  // combines fakeGroupDb (estimates, for annualHandoffGuard's own per-id
  // lookups) with a plain whereIn/select stub (short_codes) — routed by
  // table, same pattern as the content-derivation describe block above.
  function fakeRewriteDb({ estimates = [], shortCodes = [] } = {}) {
    const estimatesDb = fakeGroupDb(estimates);
    return (table) => {
      if (table === 'short_codes') {
        return {
          whereIn(col, vals) {
            return { select: async () => shortCodes.filter((r) => vals.includes(r[col])) };
          },
        };
      }
      return estimatesDb(table);
    };
  }

  test('a short code minted for something else whose target_url is itself a withheld estimate link is rewritten too (mirrors estimateIdsFromContent\'s own target_url rescan)', async () => {
    const withheldRow = row(undefined, { id: 'est-target-url', token: 'target-url-token-e12345' });
    const db = fakeRewriteDb({
      estimates: [withheldRow],
      shortCodes: [{
        code: 'xyz9code', entity_type: null, entity_id: null,
        target_url: 'https://portal.wavespestcontrol.com/estimate/target-url-token-e12345',
      }],
    });
    const html = '<p>View it: https://portal.wavespestcontrol.com/l/xyz9code</p>';
    const text = 'https://portal.wavespestcontrol.com/l/xyz9code';

    const result = await rewriteWithheldEstimateLinks({ db, html, text });

    expect(result.rewrittenIds).toEqual(['est-target-url']);
    expect(result.html).toBe('<p>View it: https://portal.wavespestcontrol.com</p>');
    expect(result.text).toBe('https://portal.wavespestcontrol.com');
  });

  test('a short code minted for something else whose target_url resolves to a DELIVERED estimate is left untouched', async () => {
    const deliveredRow = delivered({ id: 'est-target-url-ok', token: 'target-url-token-f123456' });
    const db = fakeRewriteDb({
      estimates: [deliveredRow],
      shortCodes: [{
        code: 'abc1code', entity_type: null, entity_id: null,
        target_url: 'https://portal.wavespestcontrol.com/estimate/target-url-token-f123456',
      }],
    });
    const html = '<p>https://portal.wavespestcontrol.com/l/abc1code</p>';

    const result = await rewriteWithheldEstimateLinks({ db, html, text: '' });

    expect(result.rewrittenIds).toEqual([]);
    expect(result.html).toBe(html);
  });

  test('a short code for something else entirely (target_url carries no estimate link) is left alone, no crash', async () => {
    const db = fakeRewriteDb({
      shortCodes: [{ code: 'inv1code', entity_type: 'invoices', entity_id: 'inv-1', target_url: 'https://portal.wavespestcontrol.com/pay/invoice-1' }],
    });
    const html = 'Pay here: https://portal.wavespestcontrol.com/l/inv1code';

    const result = await rewriteWithheldEstimateLinks({ db, html, text: '' });

    expect(result.rewrittenIds).toEqual([]);
    expect(result.html).toBe(html);
  });
});

describe('withheldLinkPolicyForTemplate (round 9 structural fix, P1: template-keyed rewrite at the provider)', () => {
  test('deposit.receipt resolves to "rewrite" — the deposit is owed regardless of the annual offer\'s own state', () => {
    expect(withheldLinkPolicyForTemplate('deposit.receipt')).toBe('rewrite');
  });

  test('invoice.receipt resolves to "rewrite" — same payment-receipt precedent', () => {
    expect(withheldLinkPolicyForTemplate('invoice.receipt')).toBe('rewrite');
  });

  test('every other template key resolves to the default "refuse"', () => {
    expect(withheldLinkPolicyForTemplate('service.visit_summary')).toBe('refuse');
    expect(withheldLinkPolicyForTemplate('invoice.sent')).toBe('refuse');
    expect(withheldLinkPolicyForTemplate('payment.autopay_enabled')).toBe('refuse');
    expect(withheldLinkPolicyForTemplate('estimate.follow_up')).toBe('refuse');
  });

  test('a missing/blank/non-string templateKey resolves to "refuse", never throws', () => {
    expect(withheldLinkPolicyForTemplate(undefined)).toBe('refuse');
    expect(withheldLinkPolicyForTemplate(null)).toBe('refuse');
    expect(withheldLinkPolicyForTemplate('')).toBe('refuse');
  });
});
