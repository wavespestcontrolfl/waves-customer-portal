// Tests step B of the Google Local Services lead job (owner 2026-11-23, "do step
// b next"): relabelMatches in services/ads/google-lsa-leads.js and the
// lsaSummary the Ads page reads (services/ads/lsa-summary.js).
// Behavior: a matched call's funnel row is filed as google_lsa only when the
// row is the pipeline's waves_website row FOR THAT CALL; no row -> one is
// created; google_lsa stays; any other source (first touch) and any
// waves_website row without this call's id stay as they are. Everything runs in
// one transaction per lead with the lead locked before its funnel row. A
// database error is logged with the step and code only.
// Regression guarded: a Local Services call counted as an organic website
// call, a web-form lead's channel overwritten, another call's row relabeled.

const mockOps = [];
let mockState = {};

function builder(rawTable, inTrx) {
  const table = rawTable.split(' as ')[0]; // 'ad_service_attribution as asa' -> the table
  const b = {};
  const record = (op) => (...args) => { mockOps.push({ table, op, args, trx: inTrx }); return b; };
  for (const op of ['where', 'whereNot', 'whereNull', 'whereNotNull', 'whereIn', 'select', 'orderBy', 'forUpdate', 'update']) b[op] = jest.fn(record(op));
  b.first = jest.fn((...args) => {
    mockOps.push({ table, op: 'first', args, trx: inTrx });
    const v = mockState.first?.[table];
    return Promise.resolve(typeof v === 'function' ? v() : v);
  });
  b.then = (res, rej) => {
    const rows = mockState.rows?.[table] || [];
    return Promise.resolve(rows).then(res, rej);
  };
  return b;
}
const mockDb = jest.fn((table) => builder(table, false));
mockDb.raw = jest.fn((sql) => ({ raw: sql }));
mockDb.schema = { hasTable: jest.fn() };
mockDb.transaction = jest.fn(async (fn) => {
  if (mockState.txError) throw mockState.txError;
  const trx = (table) => builder(table, true);
  return fn(trx);
});
jest.mock('../models/db', () => mockDb);
jest.mock('../services/logger', () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn() }));
const mockRecord = jest.fn();
jest.mock('../services/ads/call-attribution', () => ({ recordCallPpcAttribution: (...a) => mockRecord(...a) }));
jest.mock('google-ads-api', () => ({ GoogleAdsApi: jest.fn(() => ({ Customer: () => ({ query: jest.fn() }) })) }));

const logger = require('../services/logger');
const Leads = require('../services/ads/google-lsa-leads');
const { lsaSummary, lsaSpend, costPerWon } = require('../services/ads/lsa-summary');
const { relabelAction, relabelInTransaction, relabelMatches } = Leads._private;

const CALL_ID = '11111111-1111-4111-8111-111111111111';
const LSA = { id: 'lsa-1', call_log_id: CALL_ID, lead_id: 'lead-1', customer_id: 'cust-1', lead_created_at: new Date('2026-11-20T19:05:00Z') };
const ops = (table, op, trx) => mockOps.filter((o) => o.table === table && o.op === op && (trx === undefined || o.trx === trx));

beforeEach(() => {
  mockOps.length = 0;
  mockState = {};
  mockRecord.mockReset();
  mockDb.mockClear();
  mockDb.transaction.mockClear();
  logger.error.mockClear();
  logger.warn.mockClear();
});

describe('relabelAction (pure)', () => {
  test('no funnel row: create one', () => {
    expect(relabelAction(null, LSA)).toEqual({ type: 'create' });
    expect(relabelAction(undefined, LSA)).toEqual({ type: 'create' });
  });

  test('a google_lsa row stays: already_lsa', () => {
    expect(relabelAction({ lead_source: 'google_lsa', source_call_id: null }, LSA)).toEqual({ type: 'keep', result: 'already_lsa' });
  });

  test('a waves_website row from THIS call is relabeled, remembering where it came from', () => {
    expect(relabelAction({ lead_source: 'waves_website', source_call_id: CALL_ID }, LSA))
      .toEqual({ type: 'relabel', from: 'waves_website', result: 'relabeled' });
  });

  test('a waves_website row from another call or from no call is unproven and untouched', () => {
    expect(relabelAction({ lead_source: 'waves_website', source_call_id: 'other' }, LSA)).toEqual({ type: 'keep', result: 'unproven' });
    expect(relabelAction({ lead_source: 'waves_website', source_call_id: null }, LSA)).toEqual({ type: 'keep', result: 'unproven' });
  });

  test('first touch wins: any other source is kept and named in the result', () => {
    for (const source of ['web_form', 'google_ads', 'referral', 'facebook']) {
      expect(relabelAction({ lead_source: source, source_call_id: CALL_ID }, LSA)).toEqual({ type: 'keep', result: `kept_${source}` });
    }
  });

  test('a long source is cut to 40 characters; a missing source reads kept_none', () => {
    const out = relabelAction({ lead_source: 'x'.repeat(60), source_call_id: null }, LSA);
    expect(out.result).toHaveLength(40);
    expect(out.result.startsWith('kept_xxx')).toBe(true);
    expect(relabelAction({ lead_source: null, source_call_id: null }, LSA).result).toBe('kept_none');
  });
});

describe('relabelInTransaction', () => {
  test('relabel: locks the lead then its funnel row, updates the row and records relabeled_from in one transaction', async () => {
    mockState.first = { leads: { id: 'lead-1' }, ad_service_attribution: { id: 'a-1', lead_source: 'waves_website', source_call_id: CALL_ID } };
    const out = await relabelInTransaction((t) => builderFor(t), LSA, null);
    expect(out).toEqual({ result: 'relabeled' });
    // lead lock comes before the funnel row lock
    const order = mockOps.filter((o) => o.op === 'forUpdate').map((o) => o.table);
    expect(order).toEqual(['leads', 'ad_service_attribution']);
    const [attr] = ops('ad_service_attribution', 'update', true);
    expect(attr.args[0]).toMatchObject({ lead_source: 'google_lsa', is_paid: true, lead_source_detail: 'Local Services', attribution_basis: 'lsa_lead_match' });
    expect(attr.args[0].updated_at).toBeInstanceOf(Date);
    const [mark] = ops('lsa_leads', 'update', true);
    expect(mark.args[0]).toMatchObject({ relabel_result: 'relabeled', relabeled_from: 'waves_website' });
    expect(mark.args[0].relabeled_at).toBeInstanceOf(Date);
    expect(mockRecord).not.toHaveBeenCalled();
  });

  test('keep branches write only the lsa_leads mark (no change to the funnel row)', async () => {
    for (const [row, result, from] of [
      [{ id: 'a', lead_source: 'google_lsa', source_call_id: null }, 'already_lsa', null],
      [{ id: 'a', lead_source: 'waves_website', source_call_id: 'other' }, 'unproven', null],
      [{ id: 'a', lead_source: 'web_form', source_call_id: CALL_ID }, 'kept_web_form', null],
    ]) {
      mockOps.length = 0;
      mockState.first = { leads: { id: 'lead-1' }, ad_service_attribution: row };
      const out = await relabelInTransaction((t) => builderFor(t), LSA, null);
      expect(out).toEqual({ result });
      expect(ops('ad_service_attribution', 'update')).toHaveLength(0);
      expect(mockRecord).not.toHaveBeenCalled();
      expect(ops('lsa_leads', 'update')[0].args[0]).toMatchObject({ relabel_result: result, relabeled_from: from });
    }
  });

  test('no funnel row: creates a google_lsa row through the pipeline writer on the transaction, dated by the call', async () => {
    mockState.first = { leads: { id: 'lead-1' }, ad_service_attribution: undefined };
    mockRecord.mockResolvedValue({ recorded: true });
    const startedAt = new Date('2026-11-20T19:04:00Z');
    const out = await relabelInTransaction((t) => builderFor(t), LSA, startedAt);
    expect(out).toEqual({ result: 'created' });
    const arg = mockRecord.mock.calls[0][0];
    expect(arg).toMatchObject({
      customerId: 'cust-1', leadId: 'lead-1', leadSource: 'google_lsa', isPaid: true,
      leadSourceDetail: 'Local Services', leadDate: startedAt, sourceCallId: CALL_ID, attributionBasis: 'lsa_lead_match',
    });
    expect(typeof arg.dbc).toBe('function');
    expect(ops('lsa_leads', 'update')[0].args[0]).toMatchObject({ relabel_result: 'created', relabeled_from: null });
  });

  test('create falls back to the lead time when the call has no start', async () => {
    mockState.first = { leads: { id: 'lead-1' } };
    mockRecord.mockResolvedValue({ recorded: true });
    await relabelInTransaction((t) => builderFor(t), LSA, null);
    expect(mockRecord.mock.calls[0][0].leadDate).toBe(LSA.lead_created_at);
  });

  test('create refused for a transient reason: nothing is marked, so the next run retries', async () => {
    for (const reason of ['no_customer', 'no_lead', 'error', undefined]) {
      mockOps.length = 0;
      mockState.first = { leads: { id: 'lead-1' } };
      mockRecord.mockResolvedValue({ recorded: false, reason });
      const out = await relabelInTransaction((t) => builderFor(t), LSA, null);
      expect(out).toEqual({ retry: reason || 'not_recorded' });
      expect(ops('lsa_leads', 'update')).toHaveLength(0);
    }
  });

  test('create refused because the lead\'s row is not provably this call\'s: final, marked unproven with the code', async () => {
    for (const reason of ['other_source', 'other_call', 'unprovenanced_row', 'web_attributed']) {
      mockOps.length = 0;
      mockState.first = { leads: { id: 'lead-1' } };
      mockRecord.mockResolvedValue({ recorded: false, reason });
      const out = await relabelInTransaction((t) => builderFor(t), LSA, null);
      expect(out).toEqual({ result: 'unproven' });
      const [mark] = ops('lsa_leads', 'update', true);
      expect(mark.args[0]).toMatchObject({ relabel_result: 'unproven', relabeled_from: reason });
      expect(mark.args[0].relabeled_at).toBeInstanceOf(Date);
      expect(ops('ad_service_attribution', 'update')).toHaveLength(0);
    }
  });

  test('a lead that is gone: retry, no write', async () => {
    mockState.first = { leads: undefined };
    const out = await relabelInTransaction((t) => builderFor(t), LSA, null);
    expect(out).toEqual({ retry: 'no_lead' });
    expect(mockOps.some((o) => o.table === 'ad_service_attribution')).toBe(false);
    expect(mockRecord).not.toHaveBeenCalled();
  });
});

// A transaction handle for tests that call relabelInTransaction directly.
function builderFor(table) { return builder(table, true); }

describe('relabelMatches', () => {
  test('reads only phone_time matches with every id, not yet done, and handles each lead in its own transaction', async () => {
    mockState.rows = {
      lsa_leads: [LSA, { ...LSA, id: 'lsa-2', call_log_id: 'call-2', lead_id: 'lead-2' }],
      call_log: [{ id: CALL_ID, created_at: new Date('2026-11-20T19:04:00Z'), metadata: {}, duration_seconds: 60 }],
    };
    mockState.first = { leads: { id: 'x' }, ad_service_attribution: { id: 'a', lead_source: 'google_lsa' } };
    const counts = await relabelMatches();
    expect(mockDb.transaction).toHaveBeenCalledTimes(2);
    expect(counts).toEqual({ relabeled: 0, created: 0, kept: 2, retry: 0, failed: 0 });
    const wheres = ops('lsa_leads', 'where').map((o) => o.args);
    expect(wheres[0][0]).toEqual({ match_basis: 'phone_time' });
    expect(ops('lsa_leads', 'whereNotNull').map((o) => o.args[0]).sort()).toEqual(['call_log_id', 'customer_id', 'lead_id']);
    expect(ops('lsa_leads', 'whereNull').map((o) => o.args[0])).toEqual(['relabeled_at']);
    const since = wheres.find((a) => a[0] === 'lead_created_at');
    const ageDays = (Date.now() - since[2].getTime()) / 86400000;
    expect(since[1]).toBe('>=');
    expect(ageDays).toBeGreaterThan(89.9);
    expect(ageDays).toBeLessThan(90.1);
    // the call read is keyed by id
    expect(ops('call_log', 'whereIn')[0].args[0]).toBe('id');
  });

  test('nothing to do: no call_log read, no transaction', async () => {
    mockState.rows = { lsa_leads: [] };
    expect(await relabelMatches()).toEqual({ relabeled: 0, created: 0, kept: 0, retry: 0, failed: 0 });
    expect(mockDb.transaction).not.toHaveBeenCalled();
    expect(ops('call_log', 'whereIn')).toHaveLength(0);
  });

  test('counts relabeled, created and retry leads', async () => {
    mockState.rows = { lsa_leads: [LSA], call_log: [] };
    mockState.first = { leads: { id: 'lead-1' }, ad_service_attribution: { id: 'a', lead_source: 'waves_website', source_call_id: CALL_ID } };
    expect((await relabelMatches()).relabeled).toBe(1);

    mockState.first = { leads: { id: 'lead-1' } };
    mockRecord.mockResolvedValueOnce({ recorded: true });
    expect((await relabelMatches()).created).toBe(1);

    mockRecord.mockResolvedValueOnce({ recorded: false, reason: 'no_customer' });
    const counts = await relabelMatches();
    expect(counts.retry).toBe(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('no_customer'));

    mockRecord.mockResolvedValueOnce({ recorded: false, reason: 'other_source' });
    const final = await relabelMatches();
    expect(final).toMatchObject({ kept: 1, retry: 0 });
  });

  test('a database error is logged as step, code and table only, counted, and the next lead still runs', async () => {
    mockState.rows = { lsa_leads: [LSA, { ...LSA, id: 'lsa-2', lead_id: 'lead-2' }], call_log: [] };
    mockState.first = { leads: { id: 'lead-1' }, ad_service_attribution: { id: 'a', lead_source: 'google_lsa' } };
    mockDb.transaction.mockImplementationOnce(async () => {
      throw Object.assign(new Error('duplicate key value violates unique constraint, Key (consumer_phone)=(+19415550142)'), { code: '23505', table: 'ad_service_attribution' });
    });
    const counts = await relabelMatches();
    expect(counts).toMatchObject({ failed: 1, kept: 1 });
    const logged = logger.error.mock.calls.map((c) => c[0]).join('\n');
    expect(logged).toContain('step relabel');
    expect(logged).toContain('code 23505');
    expect(logged).not.toContain('19415550142');
  });
});

describe('lsaSummary', () => {
  const campaigns = [
    { campaign_type: 'google_lsa', last30d: { spend: 70.005 } },
    { campaign_type: 'google_lsa', last30d: { spend: 30 } },
    { campaign_type: 'SEARCH', last30d: { spend: 999 } },
  ];

  test('lsaSpend counts only Local Services campaign rows; costPerWon is null with nothing booked', () => {
    expect(lsaSpend(campaigns)).toBe(100.01);
    expect(lsaSpend(undefined)).toBe(0);
    expect(costPerWon(100, 0)).toBeNull();
    expect(costPerWon(100, 3)).toBe(33.33);
  });

  test('builds the numbers over [since, until) Eastern days', async () => {
    mockDb.schema.hasTable.mockResolvedValue(true);
    mockState.first = {
      lsa_leads: { leads: '4', charged: '3', matched: '3' },
      ad_service_attribution: { booked: '2', recurring: '1' },
    };
    const out = await lsaSummary(campaigns, { since: '2026-10-24', until: '2026-11-23' });
    expect(out).toEqual({ leads: 4, charged: 3, matched: 3, booked: 2, recurring: 1, spend: 100.01, costPerWon: 50.01 });
    const created = ops('lsa_leads', 'where').map((o) => o.args);
    expect(created[0][0]).toBe('lead_created_at');
    expect(created[0][2].toISOString()).toBe('2026-10-24T04:00:00.000Z');
    expect(created[1][2].toISOString()).toBe('2026-11-23T05:00:00.000Z');
    expect(ops('ad_service_attribution', 'where')[0].args[0]).toEqual({ 'asa.lead_source': 'google_lsa' });
    expect(ops('ad_service_attribution', 'whereIn')[0].args).toEqual(['asa.funnel_stage', ['booked', 'completed']]);
    const sql = mockDb.raw.mock.calls.map((c) => c[0]).join('\n');
    expect(sql).toContain("credit_state, '') <> 'CREDITED'");
    expect(sql).toContain("match_basis IN ('phone_time', 'phone_customer')");
    expect(sql).toContain('asa.is_recurring IS TRUE');
  });

  test('booked and recurring go through the caller\'s lead exclusions; the lead count does not', async () => {
    mockDb.schema.hasTable.mockResolvedValue(true);
    mockState.first = { lsa_leads: { leads: '1', charged: '0', matched: '0' }, ad_service_attribution: { booked: '1', recurring: '0' } };
    const excludeRows = jest.fn((qb) => qb);
    await lsaSummary(campaigns, { since: '2026-10-24', until: '2026-11-23', excludeRows });
    expect(excludeRows).toHaveBeenCalledTimes(1);
    expect(mockDb.mock.calls.map((c) => c[0])).toContain('ad_service_attribution as asa');
  });

  test('no booked jobs: costPerWon is null', async () => {
    mockDb.schema.hasTable.mockResolvedValue(true);
    mockState.first = { lsa_leads: { leads: '1', charged: '1', matched: '0' }, ad_service_attribution: { booked: '0', recurring: '0' } };
    const out = await lsaSummary(campaigns, { since: '2026-10-24', until: '2026-11-23' });
    expect(out.booked).toBe(0);
    expect(out.costPerWon).toBeNull();
  });

  test('a missing table returns null and a failed read returns null without a row value in the log', async () => {
    mockDb.schema.hasTable.mockResolvedValue(false);
    expect(await lsaSummary(campaigns, { since: '2026-10-24', until: '2026-11-23' })).toBeNull();

    mockDb.schema.hasTable.mockRejectedValue(Object.assign(new Error('boom (+19415550142)'), { code: '42P01' }));
    expect(await lsaSummary(campaigns, { since: '2026-10-24', until: '2026-11-23' })).toBeNull();
    const logged = logger.warn.mock.calls.map((c) => c[0]).join('\n');
    expect(logged).toContain('42P01');
    expect(logged).not.toContain('19415550142');
  });
});

// The exclusion fragment the campaigns route hands to lsaSummary is the one the
// dashboard's channel ROI uses (admin-ads.js applyAttributionExclusions).
describe('the route\'s lead exclusions', () => {
  test('soft-deleted leads and the internal test name drop out, through left joins', () => {
    jest.isolateModules(() => {
      jest.doMock('../middleware/admin-auth', () => ({ adminAuthenticate: (q, r, n) => n(), requireAdmin: (q, r, n) => n() }));
      const { applyAttributionExclusions, LSA_SUMMARY_EXCLUDE } = require('../routes/admin-ads');
      const calls = [];
      const qb = {};
      for (const m of ['leftJoin', 'whereRaw']) qb[m] = (...a) => { calls.push([m, ...a]); return qb; };
      expect(applyAttributionExclusions(qb, LSA_SUMMARY_EXCLUDE)).toBe(qb);
      expect(calls.filter((c) => c[0] === 'leftJoin').map((c) => c[1])).toEqual(['leads as l', 'customers as c']);
      const raws = calls.filter((c) => c[0] === 'whereRaw').map((c) => c[1]).join('\n');
      expect(raws).toContain('l.deleted_at IS NULL');
      expect(raws).toContain("LOWER(COALESCE(l.first_name, '')");
      expect(raws).toContain("LOWER(COALESCE(c.first_name, '')");
      expect(LSA_SUMMARY_EXCLUDE.internalNames).toContain('adam martinez');
    });
  });
});
