/**
 * The web tile's atomic revision check: the evidence stamp (service record identity + the canonical assessment the
 * insight cards derive from), read under row locks in the write transaction.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/service-report/report-data', () => ({ loadLinkedLawnAssessment: jest.fn() }));
jest.mock('../services/tree-shrub-assessment', () => ({ loadLinkedTreeShrubAssessment: jest.fn() }));

const { loadLinkedLawnAssessment } = require('../services/service-report/report-data');
const { loadLinkedTreeShrubAssessment } = require('../services/tree-shrub-assessment');
const { tileEvidence, tileEvidenceUnchanged } = require('../services/service-report/web-actions');

const SERVICE = { id: 's1', customer_id: 'c1' };
const RECORD = { id: 's1', customer_id: 'c1', scheduled_service_id: 'ss1', service_id: null, property_id: null, service_date: '2026-10-20', is_callback: false, structured_notes: null, report_template_version: 'service_report_v1', service_line: 'lawn', service_type: 'Lawn Care' };

function fakeKnex({ record = RECORD, rows = {} } = {}) {
  const calls = [];
  const knex = (table) => {
    const q = {
      where() { return q; },
      forUpdate() { calls.push(`lock:${table}`); return q; },
      first: async () => { calls.push(`read:${table}`); return table === 'service_records' ? record : (rows[table] || undefined); },
    };
    return q;
  };
  return { knex, calls };
}

describe('tileEvidence', () => {
  beforeEach(() => jest.clearAllMocks());

  test('a lawn report stamps the service record and the canonical lawn assessment; locks take the service row first', async () => {
    loadLinkedLawnAssessment.mockResolvedValue({ id: 'a1' });
    const { knex, calls } = fakeKnex({ rows: { lawn_assessments: { id: 'a1', score: 80 } } });
    const evidence = await tileEvidence(SERVICE, 'lawn', knex, { lock: true });
    expect(evidence).toEqual({ callback: false, internalOnly: false, stamp: expect.stringMatching(/^[a-f0-9]{32}$/) });
    expect(calls).toEqual(['lock:service_records', 'read:service_records', 'lock:lawn_assessments', 'read:lawn_assessments']);
    expect(loadLinkedLawnAssessment).toHaveBeenCalledWith(RECORD, knex, { failClosed: true }); // the locked row, not the caller's copy
    // without lock:true nothing is locked
    const unlocked = fakeKnex({ rows: { lawn_assessments: { id: 'a1', score: 80 } } });
    await tileEvidence(SERVICE, 'lawn', unlocked.knex);
    expect(unlocked.calls.some((c) => c.startsWith('lock:'))).toBe(false);
  });

  test('a tree & shrub report stamps tree_shrub_assessments', async () => {
    loadLinkedTreeShrubAssessment.mockResolvedValue({ id: 't1' });
    const { knex, calls } = fakeKnex({ rows: { tree_shrub_assessments: { id: 't1', overall_score: 70 } } });
    expect(await tileEvidence(SERVICE, 'tree_shrub', knex, { lock: true })).toBeTruthy();
    expect(calls).toContain('lock:tree_shrub_assessments');
    expect(loadLinkedTreeShrubAssessment).toHaveBeenCalledWith(RECORD, knex, { strict: true });
  });

  test('any column of the assessment row moves the stamp (rows are hashed whole, no updated_at needed); an identical row does not', async () => {
    loadLinkedLawnAssessment.mockResolvedValue({ id: 'a1' });
    const stampFor = async (row) => (await tileEvidence(SERVICE, 'lawn', fakeKnex({ rows: { lawn_assessments: row } }).knex)).stamp;
    const base = await stampFor({ id: 'a1', weed_coverage: 10 });
    expect(await stampFor({ id: 'a1', weed_coverage: 10 })).toBe(base);
    expect(await stampFor({ id: 'a1', weed_coverage: 40 })).not.toBe(base);
    expect(await stampFor({ id: 'a1', weed_coverage: 10, updated_at: 'x' })).not.toBe(base);
  });

  test('the canonical assessment is resolved from the LOCKED row, never from the preflight copy', async () => {
    loadLinkedLawnAssessment.mockResolvedValue(null);
    const stale = { id: 's1', customer_id: 'c1', scheduled_service_id: 'ss-OLD' };
    await tileEvidence(stale, 'lawn', fakeKnex({ record: { ...RECORD, scheduled_service_id: 'ss-NEW' } }).knex);
    expect(loadLinkedLawnAssessment.mock.calls[0][0]).toMatchObject({ scheduled_service_id: 'ss-NEW' });
  });

  test.each([
    ['scheduled service relinked', { scheduled_service_id: 'ss2' }],
    ['customer relinked', { customer_id: 'c2' }],
    ['service id relinked', { service_id: 'x9' }],
    ['property relinked', { property_id: 'p9' }],
    ['service date moved', { service_date: '2026-10-21' }],
  ])('linkage change (%s) moves the stamp', async (_name, change) => {
    loadLinkedLawnAssessment.mockResolvedValue(null);
    const base = await tileEvidence(SERVICE, 'lawn', fakeKnex().knex);
    const moved = await tileEvidence(SERVICE, 'lawn', fakeKnex({ record: { ...RECORD, ...change } }).knex);
    expect(moved.stamp).not.toBe(base.stamp);
  });

  test('a different canonical assessment, or none, changes the stamp', async () => {
    const rows = { lawn_assessments: { id: 'a1' } };
    loadLinkedLawnAssessment.mockResolvedValue({ id: 'a1' });
    const one = await tileEvidence(SERVICE, 'lawn', fakeKnex({ rows }).knex);
    loadLinkedLawnAssessment.mockResolvedValue({ id: 'a2' });
    const two = await tileEvidence(SERVICE, 'lawn', fakeKnex({ rows: { lawn_assessments: { id: 'a2' } } }).knex);
    loadLinkedLawnAssessment.mockResolvedValue(null);
    const none = await tileEvidence(SERVICE, 'lawn', fakeKnex().knex);
    expect(new Set([one.stamp, two.stamp, none.stamp]).size).toBe(3);
  });

  test('callback and internal-only come from the service record', async () => {
    loadLinkedLawnAssessment.mockResolvedValue(null);
    const callback = await tileEvidence(SERVICE, 'lawn', fakeKnex({ record: { ...RECORD, is_callback: true } }).knex);
    expect(callback.callback).toBe(true);
    const shadow = await tileEvidence(SERVICE, 'lawn', fakeKnex({ record: { ...RECORD, structured_notes: JSON.stringify({ typedReportDelivery: 'shadow' }) } }).knex);
    expect(shadow.internalOnly).toBe(true);
    const sent = await tileEvidence(SERVICE, 'lawn', fakeKnex({ record: { ...RECORD, structured_notes: { typedReportDelivery: 'auto_send' } } }).knex);
    expect(sent.internalOnly).toBe(false);
  });

  test('a line with no assessment source, or a record that is gone, has no evidence; a failed read throws', async () => {
    expect(await tileEvidence(SERVICE, 'pest', fakeKnex().knex)).toBeNull();
    expect(await tileEvidence(SERVICE, 'lawn', fakeKnex({ record: null }).knex)).toBeNull();
    loadLinkedLawnAssessment.mockRejectedValue(new Error('db down'));
    await expect(tileEvidence(SERVICE, 'lawn', fakeKnex().knex)).rejects.toThrow('db down');
  });
});

describe('tileEvidenceUnchanged', () => {
  const ok = { stamp: 'x', callback: false, internalOnly: false };
  test('only an identical stamp on a visit that is still neither a callback nor internal-only passes', () => {
    expect(tileEvidenceUnchanged(ok, { ...ok })).toBe(true);
    expect(tileEvidenceUnchanged(ok, { ...ok, stamp: 'y' })).toBe(false);
    expect(tileEvidenceUnchanged(ok, { ...ok, callback: true })).toBe(false);
    expect(tileEvidenceUnchanged(ok, { ...ok, internalOnly: true })).toBe(false);
    expect(tileEvidenceUnchanged(null, ok)).toBe(false);
    expect(tileEvidenceUnchanged(ok, null)).toBe(false);
  });
});
