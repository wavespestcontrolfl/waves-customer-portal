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
    expect(outcome.deduped).toBe(true);
    // The existing row rides the dedupe outcome (click-to-estimate lane):
    // the mint hook resolves its previously minted estimate from it.
    expect(outcome.request?.id).toBe('req-1');
    expect(ops.updates).toHaveLength(0);
    expect(ops.inserts).toHaveLength(0);
    expect(onWrite).not.toHaveBeenCalled();
  });

  test('a stored mintedEstimate linkage does NOT break the dedupe match', async () => {
    // The mint hook stamps pricing_revision.mintedEstimate AFTER the
    // snapshot is stored; the freshly recomputed snapshot never carries it.
    // If the compare saw it, every repeat tap on a minted offer would churn
    // the row and supersede a perfectly valid estimate.
    const { db, ops } = fakeDb({
      existing: {
        id: 'req-1',
        source: 'portal_home',
        subject: ARGS.subject,
        pricing_revision: JSON.stringify({
          ...ARGS.revisionSnapshot,
          mintedEstimate: { id: 'est-1', token: 'tok', mintedAt: '2026-08-13T00:00:00Z' },
        }),
      },
    });
    const outcome = await writeOrRefreshCtaRequest(db, ARGS);
    expect(outcome.deduped).toBe(true);
    expect(ops.updates).toHaveLength(0);
    expect(ops.inserts).toHaveLength(0);
  });

  test('onWrite runs inside the transaction on a real write', async () => {
    const { db } = fakeDb();
    const onWrite = jest.fn();
    await writeOrRefreshCtaRequest(db, { ...ARGS, onWrite });
    expect(onWrite).toHaveBeenCalledTimes(1);
  });

  describe('withRow hook (click-to-estimate seam)', () => {
    test('fires on an insert with the written row and no prior revision', async () => {
      const { db } = fakeDb();
      const withRow = jest.fn();
      await writeOrRefreshCtaRequest(db, { ...ARGS, withRow });
      expect(withRow).toHaveBeenCalledTimes(1);
      const [, ctx] = withRow.mock.calls[0];
      expect(ctx.deduped).toBe(false);
      expect(ctx.refreshed).toBe(false);
      expect(ctx.priorPricingRevision).toBeNull();
      expect(ctx.row).toBeTruthy();
    });

    test('fires on a refresh with the PRE-call pricing_revision (the row write already replaced the stored snapshot)', async () => {
      const priorRevision = {
        source: 'service_report',
        crossSell: {},
        mintedEstimate: { id: 'est-old', token: 'tok-old' },
      };
      const { db } = fakeDb({
        existing: {
          id: 'req-1',
          source: 'service_report',
          subject: 'old subject',
          pricing_revision: JSON.stringify(priorRevision),
        },
      });
      const withRow = jest.fn();
      const outcome = await writeOrRefreshCtaRequest(db, { ...ARGS, withRow });
      expect(outcome.refreshed).toBe(true);
      const [, ctx] = withRow.mock.calls[0];
      expect(ctx.refreshed).toBe(true);
      expect(ctx.priorPricingRevision).toEqual(priorRevision);
    });

    test('fires on the dedupe no-op too — a repeat tap must reach the mint', async () => {
      const { db } = fakeDb({
        existing: {
          id: 'req-1',
          source: 'portal_home',
          subject: ARGS.subject,
          pricing_revision: JSON.stringify(ARGS.revisionSnapshot),
        },
      });
      const withRow = jest.fn();
      const onWrite = jest.fn();
      const outcome = await writeOrRefreshCtaRequest(db, { ...ARGS, withRow, onWrite });
      expect(outcome.deduped).toBe(true);
      expect(withRow).toHaveBeenCalledTimes(1);
      expect(withRow.mock.calls[0][1].deduped).toBe(true);
      expect(onWrite).not.toHaveBeenCalled();
    });

    test('a withRow throw propagates so the transaction rolls back the row write with it', async () => {
      const { db } = fakeDb();
      const withRow = jest.fn().mockRejectedValue(new Error('mint failed'));
      await expect(writeOrRefreshCtaRequest(db, { ...ARGS, withRow })).rejects.toThrow('mint failed');
    });
  });
});
