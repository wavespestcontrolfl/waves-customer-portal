/**
 * The estimate that belongs to a Waves Assessment visit, as the Fast Complete
 * sheet reads it (GATE_ASSESSMENT_FAST_COMPLETE): only relations the code
 * already keeps, one live estimate shown, no pick when there are several, and
 * never the estimate token or a dead estimate's price.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => jest.fn());

const mockPaired = jest.fn();
jest.mock('../services/assessment-estimate-closeout', () => ({
  estimateForAssessment: (...args) => mockPaired(...args),
}));

const { assessmentEstimateSummary } = require('../services/assessment-estimate-summary');

const VISIT = { id: 'visit-1', customer_id: 'cust-1', source_estimate_id: null };
const row = (over = {}) => ({
  id: 'est-1', customer_id: 'cust-1', status: 'sent', archived_at: null, sent_at: '2026-10-03T14:00:00.000Z',
  // A real delivery (HANDOFF_COLS): the sent date comes from here, not sent_at.
  handed_off_at: '2026-10-03T14:05:00.000Z', first_handed_off_at: null, delivered_at_history: [],
  anchor_handed_off_at: null, accept_witness_at: null, expires_at: '2026-12-01T00:00:00.000Z', estimate_data: {},
  created_at: '2026-10-02T14:00:00.000Z', estimate_slug: 'EST-2026-0001', token: 'secret-token',
  monthly_total: '59.00', annual_total: '708.00', onetime_total: '0.00', service_interest: 'Pest', ...over,
});

// A conn whose estimates table answers the two reads the service makes.
function makeConn({ linked = [], rows = [] } = {}) {
  const reads = [];
  const conn = jest.fn((table) => {
    expect(table).toBe('estimates');
    const state = { filters: [] };
    const chain = {
      where: (f) => { state.filters.push(f); return chain; },
      whereRaw: (sql, bind) => { state.raw = { sql, bind }; return chain; },
      whereIn: (_col, ids) => { state.ids = ids; return chain; },
      select: async (cols) => {
        reads.push({ ...state, cols });
        if (state.raw) return linked.map((id) => ({ id }));
        return rows.filter((r) => state.ids.includes(r.id) && state.filters.every((f) => !f.customer_id || f.customer_id === r.customer_id));
      },
    };
    return chain;
  });
  conn.raw = (sql) => ({ raw: sql });
  conn.reads = reads;
  return conn;
}

beforeEach(() => { mockPaired.mockReset(); mockPaired.mockResolvedValue(null); });

describe('assessmentEstimateSummary', () => {
  test('a visit with no customer has no estimate', async () => {
    expect(await assessmentEstimateSummary({ ...VISIT, customer_id: null }, { conn: makeConn() })).toEqual({ state: 'none' });
  });

  test('no linked or paired estimate is "none"', async () => {
    expect(await assessmentEstimateSummary(VISIT, { conn: makeConn() })).toEqual({ state: 'none' });
  });

  test('the estimate linked to this visit by its booking link is the one shown, without the token', async () => {
    const conn = makeConn({ linked: ['est-1'], rows: [row()] });
    const out = await assessmentEstimateSummary(VISIT, { conn });
    expect(out.state).toBe('found');
    expect(out.estimate).toEqual({
      id: 'est-1', slug: 'EST-2026-0001', status: 'sent', sentAt: '2026-10-03T14:05:00.000Z',
      createdAt: '2026-10-02T14:00:00.000Z', monthlyTotal: 59, annualTotal: 708, onetimeTotal: 0,
    });
    expect(JSON.stringify(out)).not.toMatch(/secret-token|token/);
    // The link is read for THIS visit and customer.
    expect(conn.reads[0].raw.bind).toEqual(['visit-1']);
    expect(conn.reads[0].filters).toContainEqual({ customer_id: 'cust-1' });
  });

  test('a draft shows no sent date', async () => {
    const conn = makeConn({ linked: ['est-1'], rows: [row({ status: 'draft', sent_at: null, handed_off_at: null, expires_at: null })] });
    const out = await assessmentEstimateSummary(VISIT, { conn });
    expect(out.estimate.status).toBe('draft');
    expect(out.estimate.sentAt).toBeNull();
  });

  test('the visit source estimate and the sweep pairing are candidates too, and the same estimate counts once', async () => {
    mockPaired.mockResolvedValue({ id: 'est-1' });
    const conn = makeConn({ linked: ['est-1'], rows: [row()] });
    const out = await assessmentEstimateSummary({ ...VISIT, source_estimate_id: 'est-1' }, { conn });
    expect(out.state).toBe('found');
    expect(mockPaired).toHaveBeenCalledWith(conn, expect.objectContaining({ id: 'visit-1' }), expect.any(Object));
  });

  test('the sweep pairing alone (a legacy, unlinked sent estimate) is shown', async () => {
    mockPaired.mockResolvedValue({ id: 'est-2' });
    const conn = makeConn({ rows: [row({ id: 'est-2' })] });
    const out = await assessmentEstimateSummary(VISIT, { conn });
    expect(out.estimate.id).toBe('est-2');
  });

  test.each([['declined'], ['expired']])('a %s estimate is not the live price: "retired", no amount', async (status) => {
    const conn = makeConn({ linked: ['est-1'], rows: [row({ status })] });
    const out = await assessmentEstimateSummary(VISIT, { conn });
    expect(out).toEqual({ state: 'retired', status });
  });

  const NOW = new Date('2026-10-09T15:00:00.000Z');

  test('a sent estimate past expires_at is not live before the sweep flips it, and is not counted toward "ambiguous"', async () => {
    const elapsed = row({ id: 'est-1', expires_at: '2026-10-08T00:00:00.000Z' });
    expect(await assessmentEstimateSummary(VISIT, { conn: makeConn({ linked: ['est-1'], rows: [elapsed] }), now: NOW }))
      .toEqual({ state: 'retired', status: 'expired' });
    const conn = makeConn({ linked: ['est-1', 'est-2'], rows: [elapsed, row({ id: 'est-2' })] });
    const out = await assessmentEstimateSummary(VISIT, { conn, now: NOW });
    expect(out.state).toBe('found');
    expect(out.estimate.id).toBe('est-2');
  });

  test('an accepted estimate past expires_at is still the price', async () => {
    const conn = makeConn({ linked: ['est-1'], rows: [row({ status: 'accepted', expires_at: '2026-10-08T00:00:00.000Z', accept_witness_at: '2026-10-07T12:00:00.000Z' })] });
    const out = await assessmentEstimateSummary(VISIT, { conn, now: NOW });
    expect(out.estimate.status).toBe('accepted');
  });

  test('a suppressed send (sent_at stamped, status sent, no delivery) has no sent date', async () => {
    const conn = makeConn({ linked: ['est-1'], rows: [row({ handed_off_at: null })] });
    const out = await assessmentEstimateSummary(VISIT, { conn, now: NOW });
    expect(out.state).toBe('found');
    expect(out.estimate.sentAt).toBeNull();
  });

  test('a real delivery gives the newest delivery date, not sent_at', async () => {
    const conn = makeConn({ linked: ['est-1'], rows: [row({ delivered_at_history: ['2026-10-05T16:00:00.000Z'] })] });
    const out = await assessmentEstimateSummary(VISIT, { conn, now: NOW });
    expect(out.estimate.sentAt).toBe('2026-10-05T16:00:00.000Z');
  });

  test('an estimate held off the customer surface is not the price', async () => {
    const conn = makeConn({ linked: ['est-1'], rows: [row({ estimate_data: { estimatorEngine: { linkage_invalidated_at: '2026-10-04T00:00:00.000Z' } } })] });
    expect(await assessmentEstimateSummary(VISIT, { conn, now: NOW })).toEqual({ state: 'retired', status: 'withdrawn' });
  });

  test('a failed send is still the staff price, unsent', async () => {
    const conn = makeConn({ linked: ['est-1'], rows: [row({ status: 'send_failed', handed_off_at: null })] });
    const out = await assessmentEstimateSummary(VISIT, { conn, now: NOW });
    expect(out.estimate).toMatchObject({ status: 'send_failed', sentAt: null });
  });

  test('an archived estimate is not the live price', async () => {
    const conn = makeConn({ linked: ['est-1'], rows: [row({ archived_at: '2026-10-05T00:00:00.000Z' })] });
    expect(await assessmentEstimateSummary(VISIT, { conn })).toEqual({ state: 'retired', status: 'archived' });
  });

  test('a dead estimate beside a live one does not hide the live one', async () => {
    const conn = makeConn({ linked: ['est-1', 'est-2'], rows: [row({ id: 'est-1', status: 'declined' }), row({ id: 'est-2', status: 'viewed' })] });
    const out = await assessmentEstimateSummary(VISIT, { conn });
    expect(out.estimate.id).toBe('est-2');
  });

  test('two live candidates have no canonical pick: "ambiguous", no estimate', async () => {
    const conn = makeConn({ linked: ['est-1', 'est-2'], rows: [row({ id: 'est-1' }), row({ id: 'est-2', status: 'draft' })] });
    expect(await assessmentEstimateSummary(VISIT, { conn })).toEqual({ state: 'ambiguous' });
  });

  test('a candidate that belongs to another customer is dropped', async () => {
    const conn = makeConn({ linked: ['est-1'], rows: [row({ customer_id: 'cust-9' })] });
    expect(await assessmentEstimateSummary(VISIT, { conn })).toEqual({ state: 'none' });
  });

  test('a read failure is "unavailable", never a thrown error', async () => {
    const conn = jest.fn(() => { throw new Error('db down'); });
    expect(await assessmentEstimateSummary(VISIT, { conn })).toEqual({ state: 'unavailable' });
  });
});
