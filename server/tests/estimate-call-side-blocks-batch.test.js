/**
 * callSideBlocksForEstimates is the list form of callSideBlockForEstimateData
 * (the /data gate's call-side verdict). The admin Pipeline cards use it to
 * decide whether the staff preview can render a row, so for every row it must
 * answer exactly what the per-row guard answers, with a constant number of
 * reads for the whole page. Both run here on the same in-memory tables.
 * Synthetic data only.
 */
const { callSideBlockForEstimateData, callSideBlocksForEstimates } = require('../utils/estimate-claim-sql');

// A small in-memory stand-in for the knex calls both guards make.
function fakeDb(tables, { failOn = null } = {}) {
  const reads = [];
  const dbc = (table) => {
    const filters = [];
    let order = null;
    const rows = () => {
      if (failOn === table) throw new Error(`${table} unavailable`);
      let out = (tables[table] || []).filter((row) => filters.every((f) => f(row)));
      if (order) {
        const [col, dir] = order;
        out = [...out].sort((a, b) => (dir === 'desc' ? -1 : 1) * (Date.parse(a[col]) - Date.parse(b[col])));
      }
      return out;
    };
    const b = {
      where(obj) { for (const [k, v] of Object.entries(obj)) filters.push((row) => String(row[k]) === String(v)); return b; },
      whereIn(col, vals) { const set = new Set(vals.map(String)); filters.push((row) => set.has(String(row[col]))); return b; },
      whereNull(col) { filters.push((row) => row[col] == null); return b; },
      orderBy(col, dir) { order = [col, dir]; return b; },
      select() { reads.push(table); return Promise.resolve().then(rows); },
      first() { reads.push(table); return Promise.resolve().then(() => rows()[0]); },
    };
    return b;
  };
  dbc.reads = reads;
  return dbc;
}

const CALL = { processing_token: null, processing_status: 'completed', extraction_attempts: 1, created_at: '2026-10-01T00:00:00Z' };
// what the list passes: { id, status, data } with data the parsed estimate_data
const estimate = (id, data, status = 'sent') => ({ id, status, data });
const engine = (callLogId, extra = {}) => ({ estimatorEngine: { callLogId }, ...extra });

const TABLES = {
  call_log: [
    { id: 'call-ok', ...CALL, metadata: {} },
    { id: 'call-blocked', ...CALL, metadata: { estimator_draft_block: { reason: 'wrong_identity' } } },
    { id: 'call-busy', ...CALL, processing_token: 'tok-1', metadata: {} },
    { id: 'call-sid', ...CALL, twilio_call_sid: 'CA1', metadata: {} },
    { id: 'call-stamp', ...CALL, metadata: { lead_id: 'lead-stamp' } },
    { id: 'call-stamp-gone', ...CALL, metadata: { lead_id: 'lead-deleted' } },
    { id: 'call-bad-md', ...CALL, metadata: '{not json' },
  ],
  leads: [
    { id: 'lead-old', twilio_call_sid: 'CA1', created_at: '2026-10-01T00:00:00Z', deleted_at: null },
    { id: 'lead-new', twilio_call_sid: 'CA1', created_at: '2026-10-02T00:00:00Z', deleted_at: null },
    { id: 'lead-stamp', twilio_call_sid: null, created_at: '2026-10-01T00:00:00Z', deleted_at: null },
    { id: 'lead-deleted', twilio_call_sid: null, created_at: '2026-10-01T00:00:00Z', deleted_at: '2026-10-03T00:00:00Z' },
  ],
};

const ROWS = [
  estimate('no-call', { sendSnapshot: {} }),
  estimate('call-ok', engine('call-ok')),
  estimate('missing', engine('call-nope')),
  estimate('verdict', engine('call-blocked')),
  estimate('in-flight', engine('call-busy')),
  // the newest live lead owning the sid is lead-new
  estimate('sid-current', engine('call-sid', { lead_id: 'lead-new', lead_linkage: 'sid' })),
  estimate('sid-moved', engine('call-sid', { lead_id: 'lead-old', lead_linkage: 'sid' })),
  estimate('stamp-current', engine('call-stamp', { lead_id: 'lead-stamp', lead_linkage: 'stamp' })),
  estimate('stamp-deleted', engine('call-stamp-gone', { lead_id: 'lead-deleted', lead_linkage: 'stamp' })),
  // not durably linked: no live-linkage comparison
  estimate('unlinked-lead', engine('call-sid', { lead_id: 'lead-old' })),
  estimate('bad-metadata', engine('call-bad-md')),
];

async function perRow(dbc, row) {
  return callSideBlockForEstimateData(dbc, row.data, { estimateStatus: row.status });
}

describe('callSideBlocksForEstimates matches callSideBlockForEstimateData', () => {
  it.each(ROWS.map((row) => [row.id, row]))('%s', async (_id, row) => {
    const single = await perRow(fakeDb(TABLES), row);
    const batch = (await callSideBlocksForEstimates(fakeDb(TABLES), [row])).get(row.id) || null;
    expect(batch).toBe(single);
  });

  it('judges a whole page with one call_log read and at most two leads reads', async () => {
    const dbc = fakeDb(TABLES);
    const blocks = await callSideBlocksForEstimates(dbc, ROWS);
    for (const row of ROWS) expect(blocks.get(row.id) || null).toBe(await perRow(fakeDb(TABLES), row));
    // every branch is exercised
    expect(Object.fromEntries(blocks)).toEqual({
      missing: 'call_missing',
      verdict: 'wrong_identity',
      'in-flight': 'call_reprocessing',
      'sid-moved': 'call_linkage_changed',
      'stamp-deleted': 'call_linkage_changed',
      'bad-metadata': 'call_verdict_unavailable',
    });
    expect(dbc.reads.filter((t) => t === 'call_log')).toHaveLength(1);
    expect(dbc.reads.filter((t) => t === 'leads').length).toBeLessThanOrEqual(2);
  });

  it('fails closed like the per-row guard when a read fails', async () => {
    for (const failOn of ['call_log', 'leads']) {
      const row = ROWS.find((r) => r.id === (failOn === 'leads' ? 'sid-current' : 'call-ok'));
      expect(await perRow(fakeDb(TABLES, { failOn }), row)).toBe('call_verdict_unavailable');
      expect((await callSideBlocksForEstimates(fakeDb(TABLES, { failOn }), [row])).get(row.id)).toBe('call_verdict_unavailable');
    }
  });

  it('makes no read when no row was drafted from a call', async () => {
    const dbc = fakeDb(TABLES);
    expect((await callSideBlocksForEstimates(dbc, [ROWS[0]])).size).toBe(0);
    expect(dbc.reads).toEqual([]);
  });
});
