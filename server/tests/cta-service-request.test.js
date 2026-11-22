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

  // The portal offer card is on Home and on Billing (owner 2026-11-21) and
  // each subject names its tab. The identical offer tapped on the second tab
  // must not churn the row or ring the office again.
  describe('sameAskSubjects (one card on two tabs)', () => {
    const BILLING_SUBJECT = 'Add Tree & Shrub Care — requested from portal Billing';
    const TABS = [ARGS.subject, BILLING_SUBJECT];
    const homeRow = (snapshot = ARGS.revisionSnapshot) => ({
      id: 'req-1', source: 'portal_home', subject: ARGS.subject, pricing_revision: JSON.stringify(snapshot),
    });

    test('the identical offer from the second tab is the no-op; the row keeps the first tab', async () => {
      const { db, ops } = fakeDb({ existing: homeRow() });
      const onWrite = jest.fn();
      const outcome = await writeOrRefreshCtaRequest(db, {
        ...ARGS, subject: BILLING_SUBJECT, sameAskSubjects: TABS, onWrite,
      });
      expect(outcome.deduped).toBe(true);
      expect(outcome.request.subject).toBe(ARGS.subject);
      expect(ops.updates).toHaveLength(0);
      expect(ops.inserts).toHaveLength(0);
      expect(onWrite).not.toHaveBeenCalled();
    });

    test('a moved offer from the second tab still refreshes, under the new tab', async () => {
      const { db, ops } = fakeDb({ existing: homeRow({ source: 'portal_home', offer: { serviceKey: 'tree_shrub', option: { perVisit: 80 } } }) });
      const outcome = await writeOrRefreshCtaRequest(db, { ...ARGS, subject: BILLING_SUBJECT, sameAskSubjects: TABS });
      expect(outcome.refreshed).toBe(true);
      expect(ops.updates[0].patch.subject).toBe(BILLING_SUBJECT);
    });

    test('a subject outside the list is still a different ask (the report card)', async () => {
      const { db, ops } = fakeDb({
        existing: { ...homeRow(), source: 'service_report', subject: 'Add Tree & Shrub Care — requested from service report' },
      });
      const outcome = await writeOrRefreshCtaRequest(db, { ...ARGS, subject: BILLING_SUBJECT, sameAskSubjects: TABS });
      expect(outcome.refreshed).toBe(true);
      expect(ops.updates).toHaveLength(1);
    });
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

  test('a refresh from a surface with NO mint hook preserves the minted-estimate linkage (#3391 audit P1)', async () => {
    // Portal-home tap after a report mint: the fresh snapshot carries no
    // mintedEstimate, but wholesale-replacing pricing_revision would erase
    // the pointer — a later report tap would mint a SECOND estimate with no
    // way to archive the first (two live honorable prices).
    const minted = { id: 'est-1', token: 'tok-1', mintedAt: '2026-08-13T00:00:00Z' };
    const { db, ops } = fakeDb({
      existing: {
        id: 'req-1',
        source: 'service_report',
        subject: 'old subject',
        pricing_revision: JSON.stringify({ source: 'service_report', crossSell: {}, mintedEstimate: minted }),
      },
    });
    const outcome = await writeOrRefreshCtaRequest(db, ARGS);
    expect(outcome.refreshed).toBe(true);
    const stored = JSON.parse(ops.updates[0].patch.pricing_revision);
    expect(stored.mintedEstimate).toEqual(minted);
    // The offer snapshot itself is still the fresh one.
    expect(stored.offer).toEqual(ARGS.revisionSnapshot.offer);
  });

  test('onWrite runs inside the transaction on a real write', async () => {
    const { db } = fakeDb();
    const onWrite = jest.fn();
    await writeOrRefreshCtaRequest(db, { ...ARGS, onWrite });
    expect(onWrite).toHaveBeenCalledTimes(1);
  });

  // A public link's tap reads its own eligibility again here (receipt and
  // tracker cards, #8262): inside the transaction, with the customer row
  // locked, before the writer reads or writes anything.
  describe('afterLock hook (a caller\'s second eligibility read)', () => {
    test('runs on the transaction after the customer lock and before the open-row read', async () => {
      const { db, ops } = fakeDb();
      const seen = [];
      const afterLock = jest.fn(async (trx) => {
        seen.push({ isTrx: typeof trx === 'function', lookups: ops.lookups.map((l) => l.table), inserts: ops.inserts.length });
      });
      await writeOrRefreshCtaRequest(db, { ...ARGS, afterLock });
      expect(afterLock).toHaveBeenCalledTimes(1);
      expect(seen).toEqual([{ isTrx: true, lookups: ['customers'], inserts: 0 }]);
      expect(ops.inserts).toHaveLength(1);
    });

    test.each([
      ['no open row', null],
      ['an open row to refresh', { id: 'req-1', source: 'service_report', subject: 'old', pricing_revision: '{}' }],
    ])('a throw writes nothing and reaches the caller (%s)', async (_label, existing) => {
      const { db, ops } = fakeDb({ existing });
      const onWrite = jest.fn();
      const withRow = jest.fn();
      const refused = Object.assign(new Error('tap no longer eligible'), { tapIneligible: true });
      await expect(writeOrRefreshCtaRequest(db, {
        ...ARGS, onWrite, withRow, afterLock: async () => { throw refused; },
      })).rejects.toBe(refused);
      expect(ops.inserts).toHaveLength(0);
      expect(ops.updates).toHaveLength(0);
      expect(onWrite).not.toHaveBeenCalled();
      expect(withRow).not.toHaveBeenCalled();
    });
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
