// Shared CTA service-request writer — one open-request slot per
// (customer, service) ACROSS surfaces (report card + portal home), so the
// same service tapped on two surfaces refreshes one row instead of minting
// two rows and two staff bells (codex pre-push P1 on the portal lane).

const { writeOrRefreshCtaRequest, CTA_REQUEST_SOURCES } = require('../services/cta-service-request');

function fakeDb({ existing = null } = {}) {
  const ops = { updates: [], inserts: [], lookups: [] };
  const trx = (table) => {
    const q = {
      where(criteria) { ops.lookups.push({ table, criteria }); return q; },
      whereIn(col, values) { ops.lookups.push({ table, whereIn: { [col]: values } }); return q; },
      whereNotIn() { return q; },
      orderBy() { return q; },
      forUpdate() { return q; },
      first: async () => (table === 'customers' ? { id: 'cust-1' } : existing),
      update: async (patch) => { ops.updates.push({ table, patch }); return 1; },
      insert: (row) => ({ returning: async () => { ops.inserts.push(row); return [row]; } }),
    };
    return q;
  };
  return { db: { transaction: (fn) => fn(trx) }, ops };
}

const ARGS = {
  customerId: 'cust-1',
  requestedService: 'tree_shrub',
  source: 'portal_home',
  subject: 'Add Tree & Shrub Care — requested from portal home',
  description: 'desc',
  revisionSnapshot: { source: 'portal_home', offer: { serviceKey: 'tree_shrub' } },
};

describe('writeOrRefreshCtaRequest', () => {
  test('the open-row lookup spans every CTA source', async () => {
    const { db, ops } = fakeDb();
    await writeOrRefreshCtaRequest(db, ARGS);
    const span = ops.lookups.find((l) => l.whereIn);
    expect(span.whereIn.source).toEqual(CTA_REQUEST_SOURCES);
    expect(CTA_REQUEST_SOURCES).toEqual(expect.arrayContaining(['service_report', 'portal_home']));
  });

  test('no open row → inserts with the tapping surface as source', async () => {
    const { db, ops } = fakeDb();
    const outcome = await writeOrRefreshCtaRequest(db, ARGS);
    expect(outcome.request).toBeTruthy();
    expect(ops.inserts).toHaveLength(1);
    expect(ops.inserts[0].source).toBe('portal_home');
    expect(ops.updates).toHaveLength(0);
  });

  test('an open row from the OTHER surface refreshes — never a second row', async () => {
    const { db, ops } = fakeDb({
      existing: {
        id: 'req-1',
        source: 'service_report',
        subject: 'Add Tree & Shrub Care — requested from service report',
        pricing_revision: JSON.stringify({ source: 'service_report', crossSell: {} }),
      },
    });
    const outcome = await writeOrRefreshCtaRequest(db, ARGS);
    expect(outcome.refreshed).toBe(true);
    expect(ops.inserts).toHaveLength(0);
    expect(ops.updates).toHaveLength(1);
    expect(ops.updates[0].patch.subject).toBe(ARGS.subject);
  });

  test('identical snapshot + subject is a pure no-op and never calls onWrite', async () => {
    const { db, ops } = fakeDb({
      existing: {
        id: 'req-1',
        source: 'portal_home',
        subject: ARGS.subject,
        pricing_revision: JSON.stringify(ARGS.revisionSnapshot),
      },
    });
    const onWrite = jest.fn();
    const outcome = await writeOrRefreshCtaRequest(db, { ...ARGS, onWrite });
    expect(outcome).toEqual({ deduped: true });
    expect(ops.updates).toHaveLength(0);
    expect(ops.inserts).toHaveLength(0);
    expect(onWrite).not.toHaveBeenCalled();
  });

  test('onWrite runs inside the transaction on a real write', async () => {
    const { db } = fakeDb();
    const onWrite = jest.fn();
    await writeOrRefreshCtaRequest(db, { ...ARGS, onWrite });
    expect(onWrite).toHaveBeenCalledTimes(1);
  });
});
