/**
 * The per-application setup claim (scheduled_services.pending_setup_fee) vs.
 * a PREPAY that bills the same setup as its own line (codex #3591 r34 P1).
 *
 * A direct rodent series can hold the claim an earlier secure-plan
 * per-application selection stamped; the on-site switch (and the secure
 * prepay) then bill the setup on the prepay invoice. What must hold:
 *   • the mint RETIRES the positive claim (exact-value CAS) and ledgers the
 *     fee against the prepay in the immutable setup_fee_claims table;
 *   • a claim mid-mint (negative stamp) refuses instead of racing;
 *   • a later void/refund of that prepay RESTORES the claim from the ledger
 *     record, one-shot, onto a still-direct series with a NULL stamp only;
 *   • both term-cancel branches run the restore after the superseded-invoice
 *     restore, and no admin route writes the ledger.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/invoice-followups', () => ({
  stopSequence: jest.fn(async () => undefined),
  resumeSequence: jest.fn(async () => undefined),
  scheduleForInvoice: jest.fn(async () => undefined),
}));
jest.mock('../services/stripe', () => ({ assertNoInvoiceChargeReconciliationPending: jest.fn(async () => undefined) }));
jest.mock('../services/annual-prepay-renewals', () => ({
  ...jest.requireActual('../services/annual-prepay-renewals'),
  syncTermForInvoicePayment: jest.fn(async () => undefined),
}));
jest.mock('../routes/admin-customers', () => ({ _private: { lockAndAssertNoAnnualPrepayOverlap: jest.fn(async () => {}) } }));
// The coverage-series obligation runs the shared qualifying-keys loader;
// mocked so the fake connection never has to serve the tier query.
let mockQualifyingKeys = async () => [];
jest.mock('../services/waveguard-existing-services', () => ({
  ...jest.requireActual('../services/waveguard-existing-services'),
  loadExistingQualifyingServiceKeys: (...args) => mockQualifyingKeys(...args),
}));

const fs = require('fs');
const path = require('path');
const InvoiceService = require('../services/invoice');
const plans = require('../services/secure-appointment-plans');
const { retireDirectSetupClaimForPrepay, recordSetupFeeClaimForInvoice, retirePrepayOnBookSetupClaim, findDirectRodentSetupObligationForCoverage, retireCoverageOnlySetupClaim } = plans;

// Minimal knex-shaped connection: per-table first()/update()/delete()
// answers, every write recorded.
function conn({ scheduledService = null, claim = null, updateResult = 1, rootsForCoverage = null, catalog = null, liveVisitProbe = undefined, siblingClaim = null, prepayTerm = null, invoice = null } = {}) {
  if (liveVisitProbe === undefined) liveVisitProbe = scheduledService;
  const writes = [];
  const trx = (table) => {
    const q = { _where: null };
    q.where = (w) => { if (typeof w === 'function') { w.call(q); return q; } q._where = w; return q; };
    q.whereNot = () => q;
    q.orWhere = () => q;
    q.orWhereNotNull = () => q;
    q.whereNull = (col) => { q._whereNull = col; return q; };
    q.forUpdate = () => q;
    q.first = async () => {
      if (table === 'scheduled_services') return q._whereIn ? liveVisitProbe : scheduledService;
      if (table === 'setup_fee_claims') return q._where && 'scheduled_service_id' in q._where ? siblingClaim : claim;
      if (table === 'annual_prepay_terms') return prepayTerm;
      if (table === 'invoices') return invoice;
      if (table === 'services') return catalog;
      // The realignment rollout instant — every root fixture below was
      // created AFTER it (post-rollout direct series owe the live fee).
      if (table === 'knex_migrations') return { migration_time: '2026-08-29T18:30:00.000Z' };
      return null;
    };
        q.update = async (patch) => { writes.push({ table, op: 'update', where: q._where, whereNull: q._whereNull, patch }); return updateResult; };
    q.delete = async () => { writes.push({ table, op: 'delete', where: q._where }); return 1; };
    q.whereNotIn = () => q;
    q.whereIn = () => { q._whereIn = true; return q; };
    q.orderBy = () => q;
    q.select = async () => (table === 'scheduled_services' ? (rootsForCoverage || []) : []);
    q.insert = (row) => {
      writes.push({ table, op: 'insert', row });
      const p = Promise.resolve([{}]);
      p.onConflict = (col) => { writes[writes.length - 1].onConflict = col; return { ignore: async () => 1 }; };
      return p;
    };
    return q;
  };
  trx.writes = writes;
  return trx;
}

describe('retireDirectSetupClaimForPrepay — the mint side', () => {
  test('a POSITIVE claim: ledger the fee against the prepay, then retire the stamp by exact-value CAS', async () => {
    const trx = conn({ scheduledService: { id: 'svc-parent', pending_setup_fee: '99.00' } });
    const out = await retireDirectSetupClaimForPrepay(trx, { anchorId: 'svc-parent', invoiceId: 'inv-prepay', amount: 99 });
    expect(out).toEqual({ recorded: true, retired: true });
    expect(trx.writes).toEqual([
      expect.objectContaining({ table: 'setup_fee_claims', op: 'insert', onConflict: 'invoice_id', row: { invoice_id: 'inv-prepay', scheduled_service_id: 'svc-parent', amount: 99 } }),
      expect.objectContaining({ table: 'scheduled_services', op: 'update', where: { id: 'svc-parent', pending_setup_fee: '99.00' }, patch: expect.objectContaining({ pending_setup_fee: null }) }),
    ]);
  });

  test('NO claim on the parent: the fee still ledgers (restore key) and nothing is cleared', async () => {
    const trx = conn({ scheduledService: { id: 'svc-parent', pending_setup_fee: null } });
    const out = await retireDirectSetupClaimForPrepay(trx, { anchorId: 'svc-parent', invoiceId: 'inv-prepay', amount: 79 });
    expect(out).toEqual({ recorded: true, retired: false });
    expect(trx.writes.map((w) => `${w.table}:${w.op}`)).toEqual(['setup_fee_claims:insert']);
  });

  test('a claim MID-MINT (negative stamp) refuses the switch as a 409 conflict and writes nothing', async () => {
    const trx = conn({ scheduledService: { id: 'svc-parent', pending_setup_fee: '-99.00' } });
    await expect(retireDirectSetupClaimForPrepay(trx, { anchorId: 'svc-parent', invoiceId: 'inv-prepay', amount: 99 }))
      .rejects.toMatchObject({ switchConflict: true, message: expect.stringMatching(/completion in progress/) });
    expect(trx.writes).toEqual([]);
  });

  test('amount 0 (waived WaveGuard class): nothing ledgered, but a positive claim is still CAS-cleared and a negative one still refuses (codex #3591 r40 P1)', async () => {
    const trx = conn({ scheduledService: { id: 'svc-parent', pending_setup_fee: '99.00' } });
    expect(await retireDirectSetupClaimForPrepay(trx, { anchorId: 'svc-parent', invoiceId: 'inv-prepay', amount: 0 })).toEqual({ recorded: false, retired: true });
    expect(trx.writes).toEqual([
      expect.objectContaining({ table: 'scheduled_services', op: 'update', where: { id: 'svc-parent', pending_setup_fee: '99.00' }, patch: expect.objectContaining({ pending_setup_fee: null }) }),
    ]);
    const busy = conn({ scheduledService: { id: 'svc-parent', pending_setup_fee: '-99.00' } });
    await expect(retireDirectSetupClaimForPrepay(busy, { anchorId: 'svc-parent', invoiceId: 'inv-prepay', amount: 0 }))
      .rejects.toMatchObject({ switchConflict: true });
    expect(busy.writes).toEqual([]);
  });

  test('no anchor / no invoice → no-op', async () => {
    const trx = conn({ scheduledService: { id: 'svc-parent', pending_setup_fee: '99.00' } });
    expect(await retireDirectSetupClaimForPrepay(trx, { anchorId: null, invoiceId: 'inv-prepay', amount: 99 })).toEqual({ recorded: false, retired: false });
    expect(await retireDirectSetupClaimForPrepay(trx, { anchorId: 'svc-parent', invoiceId: null, amount: 99 })).toEqual({ recorded: false, retired: false });
    expect(await recordSetupFeeClaimForInvoice(trx, { invoiceId: null, anchorId: 'svc-parent', amount: 99 })).toBe(false);
    expect(trx.writes).toEqual([]);
  });
});

describe('settlement + stamp probes for the booking route (codex #3591 r64/r65 P1)', () => {
  const { settledSetupClaimForInvoice, settledSetupClaimForEstimate, stampedSetupForVisit, anchorSetupFeeClaim } = plans;
  test('settledSetupClaimForInvoice / ForEstimate read the immutable ledger; the estimate path resolves through the winning term', async () => {
    const claimRow = { id: 'claim-1', scheduled_service_id: null, amount: '99.00' };
    expect(await settledSetupClaimForInvoice(conn({ claim: claimRow }), 'inv-prepay')).toEqual(claimRow);
    expect(await settledSetupClaimForInvoice(conn({ claim: claimRow }), null)).toBeNull();
    expect(await settledSetupClaimForEstimate(conn({ claim: claimRow, prepayTerm: { prepay_invoice_id: 'inv-prepay' }, invoice: { status: 'sent' } }), 'est-1')).toEqual(claimRow);
    // No term for the estimate (standard accept won the race) = no settlement.
    expect(await settledSetupClaimForEstimate(conn({ claim: claimRow, prepayTerm: null }), 'est-1')).toBeNull();
    // A VOIDED/REFUNDED prepay keeps its anchor-less claim for recovery —
    // that is an open obligation, never a settlement (codex #3591 r68 P1).
    for (const status of ['void', 'refunded', 'cancelled']) {
      expect(await settledSetupClaimForEstimate(conn({ claim: claimRow, prepayTerm: { prepay_invoice_id: 'inv-prepay' }, invoice: { status } }), 'est-1')).toBeNull();
    }
    expect(await settledSetupClaimForEstimate(conn({ claim: claimRow, prepayTerm: { prepay_invoice_id: 'inv-prepay' }, invoice: null }), 'est-1')).toBeNull();
  });
  test('estimateSetupCarriedElsewhere: a live stamp or a claim on ANOTHER root of the estimate blocks a second stamp (codex #3591 r66 P1)', async () => {
    const { estimateSetupCarriedElsewhere } = plans;
    expect(await estimateSetupCarriedElsewhere(conn({ rootsForCoverage: [{ id: 'root-a', pending_setup_fee: '99.00', status: 'confirmed' }] }), 'est-1', 'root-new')).toBe(true);
    // A DEAD series (cancelled, no live children) can never consume its
    // stamp — the replacement series must carry the setup (codex #3591 r67 P1)…
    expect(await estimateSetupCarriedElsewhere(conn({ rootsForCoverage: [{ id: 'root-a', pending_setup_fee: '99.00', status: 'cancelled' }], scheduledService: null }), 'est-1', 'root-new')).toBe(false);
    // …unless a live child can still complete it.
    expect(await estimateSetupCarriedElsewhere(conn({ rootsForCoverage: [{ id: 'root-a', pending_setup_fee: '99.00', status: 'completed' }], scheduledService: { id: 'child-live' } }), 'est-1', 'root-new')).toBe(true);
    // A collected claim on a dead root still counts (billed once already).
    expect(await estimateSetupCarriedElsewhere(conn({ rootsForCoverage: [{ id: 'root-a', pending_setup_fee: null, status: 'cancelled' }], claim: { id: 'claim-a' } }), 'est-1', 'root-new')).toBe(true);
    expect(await estimateSetupCarriedElsewhere(conn({ rootsForCoverage: [{ id: 'root-a', pending_setup_fee: null }], claim: { id: 'claim-a' } }), 'est-1', 'root-new')).toBe(true);
    expect(await estimateSetupCarriedElsewhere(conn({ rootsForCoverage: [{ id: 'root-a', pending_setup_fee: null }], claim: null }), 'est-1', 'root-new')).toBe(false);
    expect(await estimateSetupCarriedElsewhere(conn({ rootsForCoverage: [] }), 'est-1', 'root-new')).toBe(false);
    expect(await estimateSetupCarriedElsewhere(conn(), null)).toBe(false);
  });
  test('anchorSetupFeeClaim fills only an EMPTY anchor; stampedSetupForVisit reads the positive anchor stamp', async () => {
    const c = conn({ updateResult: 1 });
    expect(await anchorSetupFeeClaim(c, { claimId: 'claim-1', anchorId: 'svc-parent' })).toBe(true);
    expect(c.writes).toEqual([expect.objectContaining({ table: 'setup_fee_claims', op: 'update', where: { id: 'claim-1' }, whereNull: 'scheduled_service_id', patch: { scheduled_service_id: 'svc-parent' } })]);
    expect(await anchorSetupFeeClaim(conn(), { claimId: null, anchorId: 'svc-parent' })).toBe(false);
    const stamped = conn({ scheduledService: { id: 'svc-parent', customer_id: 'cust-1', recurring_parent_id: null, pending_setup_fee: '99.00', service_type: 'Rodent Bait Stations', service_id: null } });
    expect(await stampedSetupForVisit(stamped, { id: 'svc-parent' })).toBe(99);
    const bare = conn({ scheduledService: { id: 'svc-parent', customer_id: 'cust-1', recurring_parent_id: null, pending_setup_fee: null, service_type: 'Rodent Bait Stations', service_id: null } });
    expect(await stampedSetupForVisit(bare, { id: 'svc-parent' })).toBeNull();
  });
});

describe('retirePrepayOnBookSetupClaim — the Customer 360 / prepay-on-book mint (codex #3591 r36 P1)', () => {
  const visit = { id: 'svc-child', customer_id: 'cust-1', recurring_parent_id: 'svc-parent', source_estimate_id: null };
  let owedSpy;
  beforeEach(() => { owedSpy = jest.spyOn(plans, 'resolveDirectRodentSetupObligation').mockResolvedValue(99); });
  afterEach(() => owedSpy.mockRestore());

  test('re-derives the setup from the series ANCHOR (must be this customer\'s), then ledgers + retires like the switch', async () => {
    const trx = conn({ scheduledService: visit });
    // The anchor read (recorded stamp) comes from the same first(); make the
    // parent read return the visit row (stamp-less) — the ledger row is the
    // observable outcome.
    const out = await retirePrepayOnBookSetupClaim(trx, { customerId: 'cust-1', scheduledServiceId: 'svc-child', invoiceId: 'inv-prepay', amount: 99 });
    expect(out).toEqual({ recorded: true, retired: false });
    expect(owedSpy).toHaveBeenCalledWith(trx, { id: 'svc-parent' });
    expect(trx.writes).toEqual([
      expect.objectContaining({ table: 'setup_fee_claims', op: 'insert', row: { invoice_id: 'inv-prepay', scheduled_service_id: 'svc-parent', amount: 99 } }),
    ]);
  });

  test('a fee with no anchor, another customer\'s series, or a preview/mint mismatch refuses (409-class) before any write', async () => {
    await expect(retirePrepayOnBookSetupClaim(conn({ scheduledService: visit }), { customerId: 'cust-1', scheduledServiceId: null, invoiceId: 'inv-prepay', amount: 99 }))
      .rejects.toMatchObject({ switchConflict: true, message: expect.stringMatching(/requires scheduledServiceId/) });
    const foreign = conn({ scheduledService: { ...visit, customer_id: 'cust-2' } });
    await expect(retirePrepayOnBookSetupClaim(foreign, { customerId: 'cust-1', scheduledServiceId: 'svc-child', invoiceId: 'inv-prepay', amount: 99 }))
      .rejects.toMatchObject({ switchConflict: true, message: expect.stringMatching(/does not belong/) });
    owedSpy.mockResolvedValue(0);
    const drifted = conn({ scheduledService: visit });
    await expect(retirePrepayOnBookSetupClaim(drifted, { customerId: 'cust-1', scheduledServiceId: 'svc-child', invoiceId: 'inv-prepay', amount: 99 }))
      .rejects.toMatchObject({ switchConflict: true, message: expect.stringMatching(/changed since the preview/) });
    expect(foreign.writes).toEqual([]);
    expect(drifted.writes).toEqual([]);
  });

  test('no fee → no-op (a pest / member prepay never touches the ledger)', async () => {
    const trx = conn({ scheduledService: visit });
    expect(await retirePrepayOnBookSetupClaim(trx, { customerId: 'cust-1', scheduledServiceId: null, invoiceId: 'inv-prepay', amount: 0 })).toEqual({ recorded: false, retired: false });
    expect(owedSpy).not.toHaveBeenCalled();
    expect(trx.writes).toEqual([]);
  });
});

describe('restoreRetiredSetupFeeClaimForPrepay — the void/refund side', () => {
  const claim = { id: 'claim-1', scheduled_service_id: 'svc-parent', amount: '99.00' };

  test('re-stamps the direct series parent from the ledger record and consumes the record (one-shot)', async () => {
    const c = conn({ claim, scheduledService: { id: 'svc-parent', source_estimate_id: null, pending_setup_fee: null } });
    const out = await InvoiceService.restoreRetiredSetupFeeClaimForPrepay('inv-prepay', c);
    expect(out).toEqual({ scheduledServiceId: 'svc-parent', amount: 99 });
    expect(c.writes).toEqual([
      expect.objectContaining({ table: 'scheduled_services', op: 'update', where: { id: 'svc-parent' }, whereNull: 'pending_setup_fee', patch: expect.objectContaining({ pending_setup_fee: 99 }) }),
      expect.objectContaining({ table: 'setup_fee_claims', op: 'delete', where: { id: 'claim-1' } }),
    ]);
  });

  test('a live or mid-mint stamp is never overwritten — and the record is kept for a human', async () => {
    const c = conn({ claim, scheduledService: { id: 'svc-parent', source_estimate_id: null, pending_setup_fee: '-99.00' }, updateResult: 0 });
    expect(await InvoiceService.restoreRetiredSetupFeeClaimForPrepay('inv-prepay', c)).toBeNull();
    expect(c.writes.map((w) => w.op)).toEqual(['update']);
  });

  test('an ESTIMATE-origin series restores too — the ledger record is the provenance (estimate-accept prepay billed the setup; codex #3591 r37 P1)', async () => {
    const c = conn({ claim, scheduledService: { id: 'svc-parent', source_estimate_id: 'est-1', pending_setup_fee: null } });
    expect(await InvoiceService.restoreRetiredSetupFeeClaimForPrepay('inv-prepay', c)).toEqual({ scheduledServiceId: 'svc-parent', amount: 99 });
    expect(c.writes.map((w) => w.op)).toEqual(['update', 'delete']);
  });

  test('an ANCHOR-LESS record (prepay accept before any series existed) restores onto the rodent root resolved from the term\'s source estimate; with no root the record is kept (codex #3591 r39 P1)', async () => {
    const anchorless = { id: 'claim-1', scheduled_service_id: null, amount: '99.00' };
    const c = conn({
      claim: anchorless,
      scheduledService: { id: 'root-rb', source_estimate_id: 'est-1', pending_setup_fee: null },
      rootsForCoverage: [
        { id: 'root-pest', service_type: 'Quarterly Pest Control', service_id: null },
        { id: 'root-rb', service_type: 'Rodent Bait Stations', service_id: null },
      ],
    });
    expect(await InvoiceService.restoreRetiredSetupFeeClaimForPrepay('inv-prepay', c, { sourceEstimateId: 'est-1' }))
      .toEqual({ scheduledServiceId: 'root-rb', amount: 99 });
    expect(c.writes).toEqual([
      expect.objectContaining({ table: 'scheduled_services', op: 'update', where: { id: 'root-rb' }, whereNull: 'pending_setup_fee' }),
      expect.objectContaining({ table: 'setup_fee_claims', op: 'delete', where: { id: 'claim-1' } }),
    ]);
    // No rodent root yet / no estimate to resolve from → nothing written, record kept.
    const noRoot = conn({ claim: anchorless, rootsForCoverage: [{ id: 'root-pest', service_type: 'Quarterly Pest Control', service_id: null }] });
    expect(await InvoiceService.restoreRetiredSetupFeeClaimForPrepay('inv-prepay', noRoot, { sourceEstimateId: 'est-1' })).toBeNull();
    expect(noRoot.writes).toEqual([]);
    const noEstimate = conn({ claim: anchorless });
    expect(await InvoiceService.restoreRetiredSetupFeeClaimForPrepay('inv-prepay', noEstimate)).toBeNull();
    expect(noEstimate.writes).toEqual([]);
    // A Customer 360 prepay sold before any series existed: the term's
    // coverage names the direct series renewals seeded afterwards (codex #3591 r41 P1).
    const byCoverage = conn({
      claim: anchorless,
      scheduledService: { id: 'root-rb', source_estimate_id: null, pending_setup_fee: null },
      rootsForCoverage: [
        { id: 'root-pest', service_type: 'Quarterly Pest Control', service_id: null, source_estimate_id: null },
        { id: 'root-rb', service_type: 'Rodent Bait Stations', service_id: null, source_estimate_id: null },
      ],
    });
    expect(await InvoiceService.restoreRetiredSetupFeeClaimForPrepay('inv-prepay', byCoverage, { customerId: 'cust-1', coverageServiceType: 'Rodent Bait Stations' }))
      .toEqual({ scheduledServiceId: 'root-rb', amount: 99 });
    expect(byCoverage.writes.map((w) => w.op)).toEqual(['update', 'delete']);
  });

  test('AMBIGUOUS anchors refuse: two live rodent roots on the estimate (or matching the coverage) keep the record anchor-less and page (codex #3591 r61 P1)', async () => {
    const anchorless = { id: 'claim-1', scheduled_service_id: null, amount: '99.00' };
    // Two live rodent roots linked to the same estimate: first-returned
    // ordering must not pick the anchor — nothing is written, record kept.
    const twoEstimateRoots = conn({
      claim: anchorless,
      rootsForCoverage: [
        { id: 'root-rb-1', service_type: 'Rodent Bait Stations', service_id: null },
        { id: 'root-rb-2', service_type: 'Rodent Bait Stations', service_id: null },
      ],
    });
    expect(await InvoiceService.restoreRetiredSetupFeeClaimForPrepay('inv-prepay', twoEstimateRoots, { sourceEstimateId: 'est-1' })).toBeNull();
    expect(twoEstimateRoots.writes).toEqual([]);
    // Same rule on the coverage path — and the ambiguity refuses even
    // though only one root would win a first-match scan.
    const twoCoverageRoots = conn({
      claim: anchorless,
      rootsForCoverage: [
        { id: 'root-rb-1', service_type: 'Rodent Bait Stations', service_id: null, source_estimate_id: null },
        { id: 'root-rb-2', service_type: 'Rodent Bait Stations', service_id: null, source_estimate_id: null },
      ],
    });
    expect(await InvoiceService.restoreRetiredSetupFeeClaimForPrepay('inv-prepay', twoCoverageRoots, { customerId: 'cust-1', coverageServiceType: 'Rodent Bait Stations' })).toBeNull();
    expect(twoCoverageRoots.writes).toEqual([]);
    // One rodent root among non-rodent siblings still restores (unchanged).
    const oneAmongMany = conn({
      claim: anchorless,
      scheduledService: { id: 'root-rb', source_estimate_id: 'est-1', pending_setup_fee: null },
      rootsForCoverage: [
        { id: 'root-pest', service_type: 'Quarterly Pest Control', service_id: null },
        { id: 'root-rb', service_type: 'Rodent Bait Stations', service_id: null },
        { id: 'root-lawn', service_type: 'Monthly Lawn Care', service_id: null },
      ],
    });
    expect(await InvoiceService.restoreRetiredSetupFeeClaimForPrepay('inv-prepay', oneAmongMany, { sourceEstimateId: 'est-1' }))
      .toEqual({ scheduledServiceId: 'root-rb', amount: 99 });
  });

  test('re-stamp and record consume run inside ONE transaction on a plain connection, with the record locked (codex #3591 r40 P1)', async () => {
    const inner = conn({ claim, scheduledService: { id: 'svc-parent', source_estimate_id: null, pending_setup_fee: null } });
    const outer = () => { throw new Error('the plain connection must not be used for the writes'); };
    outer.transaction = jest.fn(async (cb) => cb(inner));
    expect(await InvoiceService.restoreRetiredSetupFeeClaimForPrepay('inv-prepay', outer)).toEqual({ scheduledServiceId: 'svc-parent', amount: 99 });
    expect(outer.transaction).toHaveBeenCalledTimes(1);
    expect(inner.writes.map((w) => w.op)).toEqual(['update', 'delete']);
    // An existing transaction is reused, never nested.
    const trx = conn({ claim, scheduledService: { id: 'svc-parent', source_estimate_id: null, pending_setup_fee: null } });
    trx.isTransaction = true;
    trx.transaction = jest.fn();
    expect(await InvoiceService.restoreRetiredSetupFeeClaimForPrepay('inv-prepay', trx)).toEqual({ scheduledServiceId: 'svc-parent', amount: 99 });
    expect(trx.transaction).not.toHaveBeenCalled();
  });

  test('a refund after the series is DONE re-bills the setup as a collectible draft instead of stamping an inert root (codex #3591 r43 P1)', async () => {
    const doneParent = { id: 'svc-parent', customer_id: 'cust-1', source_estimate_id: null, pending_setup_fee: null, status: 'completed' };
    const createSpy = jest.spyOn(InvoiceService, 'create').mockResolvedValue({ id: 'inv-rebill', invoice_number: 'WPC-2026-0500' });
    try {
      const c = conn({ claim, scheduledService: doneParent, liveVisitProbe: null });
      expect(await InvoiceService.restoreRetiredSetupFeeClaimForPrepay('inv-prepay', c))
        .toEqual({ scheduledServiceId: 'svc-parent', amount: 99, reInvoiceId: 'inv-rebill' });
      expect(createSpy).toHaveBeenCalledTimes(1);
      expect(createSpy.mock.calls[0][0]).toMatchObject({
        customerId: 'cust-1',
        lineItems: [expect.objectContaining({ description: 'Bait Station Setup — one-time setup fee', unit_price: 99 })],
      });
      // Record consumed, and NO stamp was written on the dead root.
      expect(c.writes.filter((w) => w.table === 'scheduled_services')).toEqual([]);
      expect(c.writes.filter((w) => w.table === 'setup_fee_claims')).toEqual([
        expect.objectContaining({ op: 'delete', where: { id: 'claim-1' } }),
      ]);
      // A live child keeps the ordinary stamp path.
      createSpy.mockClear();
      const live = conn({ claim, scheduledService: doneParent, liveVisitProbe: { id: 'child-live' } });
      expect(await InvoiceService.restoreRetiredSetupFeeClaimForPrepay('inv-prepay', live)).toEqual({ scheduledServiceId: 'svc-parent', amount: 99 });
      expect(createSpy).not.toHaveBeenCalled();
      // A failed re-bill mint FAILS the reversal so it retries (codex #3591 r47 local P0).
      createSpy.mockRejectedValueOnce(new Error('mint down'));
      const failed = conn({ claim, scheduledService: doneParent, liveVisitProbe: null });
      await expect(InvoiceService.restoreRetiredSetupFeeClaimForPrepay('inv-prepay', failed)).rejects.toThrow('mint down');
      expect(failed.writes).toEqual([]);
    } finally {
      createSpy.mockRestore();
    }
  });

  test('no record for the prepay (nothing was billed) / no prepay id → nothing happens', async () => {
    const c = conn({ claim: null, scheduledService: { id: 'svc-parent', source_estimate_id: null, pending_setup_fee: null } });
    expect(await InvoiceService.restoreRetiredSetupFeeClaimForPrepay('inv-prepay', c)).toBeNull();
    expect(await InvoiceService.restoreRetiredSetupFeeClaimForPrepay(null, c)).toBeNull();
    expect(c.writes).toEqual([]);
  });
});

describe('findDirectRodentSetupObligationForCoverage — the Customer 360 dialog names only a coverage type (codex #3591 r37 P1)', () => {
  const rodentRoot = { id: 'root-rb', customer_id: 'cust-1', service_type: 'Rodent Bait Stations', service_id: null, source_estimate_id: null, recurring_parent_id: null, created_at: '2026-09-01T12:00:00.000Z', status: 'confirmed' };
  const pestRoot = { id: 'root-pest', customer_id: 'cust-1', service_type: 'Quarterly Pest Control', service_id: null, source_estimate_id: null, recurring_parent_id: null, created_at: '2026-09-01T12:00:00.000Z', status: 'confirmed' };
  beforeEach(() => { mockQualifyingKeys = async () => ['rodent_bait']; });

  test('a live direct rodent series matching the coverage, on a non-member account, owes the setup — anchor + amount returned', async () => {
    const c = conn({ rootsForCoverage: [pestRoot, rodentRoot] });
    expect(await findDirectRodentSetupObligationForCoverage(c, { customerId: 'cust-1', coverageServiceType: 'Rodent Bait Stations' }))
      .toEqual({ anchorId: 'root-rb', amount: 99 });
  });

  test('a CANCELLED rodent root whose later child is still live is STILL the series — its obligation is reported, never a second anchor-less setup (codex #3591 r68 P1)', async () => {
    const cancelledRoot = { ...rodentRoot, status: 'cancelled' };
    // Live child present (the whereIn probe) → the root still counts.
    const withChild = conn({ rootsForCoverage: [cancelledRoot], scheduledService: { id: 'root-rb', customer_id: 'cust-1', recurring_parent_id: null, pending_setup_fee: null, created_at: '2026-09-01T12:00:00.000Z', source_estimate_id: null }, liveVisitProbe: { id: 'child-live' } });
    expect(await findDirectRodentSetupObligationForCoverage(withChild, { customerId: 'cust-1', coverageServiceType: 'Rodent Bait Stations' }))
      .toEqual({ anchorId: 'root-rb', amount: 99 });
    // No live child → the dead root is skipped (falls through to the no-root rule as before).
    const dead = conn({ rootsForCoverage: [cancelledRoot], liveVisitProbe: null });
    expect(await findDirectRodentSetupObligationForCoverage(dead, { customerId: 'cust-1', coverageServiceType: 'Rodent Bait Stations' }))
      .toEqual({ anchorId: null, amount: 99 });
  });

  test('TWO live direct rodent roots that both owe their setup → refused (switchConflict) with both anchors, never the first one alone (codex #3591 r67 P1)', async () => {
    const secondRoot = { ...rodentRoot, id: 'root-rb-2' };
    const c = conn({ rootsForCoverage: [rodentRoot, secondRoot] });
    const err = await findDirectRodentSetupObligationForCoverage(c, { customerId: 'cust-1', coverageServiceType: 'Rodent Bait Stations' }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.switchConflict).toBe(true);
    expect(err.ambiguousSetupSeries).toEqual(['root-rb', 'root-rb-2']);
    expect(err.message).toMatch(/prepay one series at a time/);
    // The route surfaces it as a 409 (not a retryable 503) on both dialogs.
    const adminCustomers = require('fs').readFileSync(require('path').join(__dirname, '..', 'routes', 'admin-customers.js'), 'utf8');
    expect((adminCustomers.match(/if \(lookupErr\.switchConflict\) \{\s+return res\.status\(409\)\.json\(\{ error: lookupErr\.message, setupFeeRequired: true, ambiguousSetupSeries: lookupErr\.ambiguousSetupSeries \|\| null \}\);/g) || []).length).toBe(2);
  });

  test('coverage naming another family, a member account, or no customer/coverage → null', async () => {
    const c = conn({ rootsForCoverage: [pestRoot, rodentRoot] });
    expect(await findDirectRodentSetupObligationForCoverage(c, { customerId: 'cust-1', coverageServiceType: 'Quarterly Pest Control' })).toBeNull();
    mockQualifyingKeys = async () => ['rodent_bait', 'pest_control'];
    expect(await findDirectRodentSetupObligationForCoverage(c, { customerId: 'cust-1', coverageServiceType: 'Rodent Bait Stations' })).toBeNull();
    expect(await findDirectRodentSetupObligationForCoverage(c, { customerId: null, coverageServiceType: 'Rodent Bait Stations' })).toBeNull();
  });

  test('NO series root yet: a rodent coverage on a non-member account owes the setup ANCHOR-LESS; a pest coverage, a member account, or an existing estimate-origin rodent root → null (codex #3591 r41 P1)', async () => {
    const none = conn({ rootsForCoverage: [] });
    expect(await findDirectRodentSetupObligationForCoverage(none, { customerId: 'cust-1', coverageServiceType: 'Rodent Bait Stations' }))
      .toEqual({ anchorId: null, amount: 99 });
    expect(await findDirectRodentSetupObligationForCoverage(none, { customerId: 'cust-1', coverageServiceType: 'Quarterly Pest Control' })).toBeNull();
    mockQualifyingKeys = async () => ['pest_control'];
    expect(await findDirectRodentSetupObligationForCoverage(none, { customerId: 'cust-1', coverageServiceType: 'Rodent Bait Stations' })).toBeNull();
    mockQualifyingKeys = async () => ['rodent_bait'];
    const estimateRoot = conn({ rootsForCoverage: [{ ...rodentRoot, source_estimate_id: 'est-1' }] });
    expect(await findDirectRodentSetupObligationForCoverage(estimateRoot, { customerId: 'cust-1', coverageServiceType: 'Rodent Bait Stations' })).toBeNull();
  });

  test('retireCoverageOnlySetupClaim re-derives under the mint, refuses drift (anchor appeared / amount moved / waived), and ledgers the claim anchor-less', async () => {
    const c = conn({ rootsForCoverage: [] });
    expect(await retireCoverageOnlySetupClaim(c, { customerId: 'cust-1', coverageServiceType: 'Rodent Bait Stations', invoiceId: 'inv-prepay', amount: 99 }))
      .toEqual({ recorded: true, retired: false });
    expect(c.writes).toEqual([
      expect.objectContaining({ table: 'setup_fee_claims', op: 'insert', row: { invoice_id: 'inv-prepay', scheduled_service_id: null, amount: 99 } }),
    ]);
    await expect(retireCoverageOnlySetupClaim(conn({ rootsForCoverage: [] }), { customerId: 'cust-1', coverageServiceType: 'Rodent Bait Stations', invoiceId: 'inv-prepay', amount: 79 }))
      .rejects.toMatchObject({ switchConflict: true, message: expect.stringMatching(/changed since the preview/) });
    await expect(retireCoverageOnlySetupClaim(conn({ rootsForCoverage: [rodentRoot] }), { customerId: 'cust-1', coverageServiceType: 'Rodent Bait Stations', invoiceId: 'inv-prepay', amount: 99 }))
      .rejects.toMatchObject({ switchConflict: true, message: expect.stringMatching(/series now exists/) });
    mockQualifyingKeys = async () => ['pest_control'];
    await expect(retireCoverageOnlySetupClaim(conn({ rootsForCoverage: [] }), { customerId: 'cust-1', coverageServiceType: 'Rodent Bait Stations', invoiceId: 'inv-prepay', amount: 99 }))
      .rejects.toMatchObject({ switchConflict: true, message: expect.stringMatching(/no longer owed/) });
  });

  test('a COMPLETED root with live children is still the series (no second setup); a dead completed root is not; a stale-labeled LINKED bait root matches by catalog (codex #3591 r42 P1)', async () => {
    mockQualifyingKeys = async () => ['rodent_bait'];
    // Estimate-origin root whose first visit completed, children live → accept decided → null.
    const liveKids = conn({ rootsForCoverage: [{ ...rodentRoot, status: 'completed', source_estimate_id: 'est-1' }], scheduledService: { id: 'child-1' } });
    expect(await findDirectRodentSetupObligationForCoverage(liveKids, { customerId: 'cust-1', coverageServiceType: 'Rodent Bait Stations' })).toBeNull();
    // Same root, no live child → dead series → the coverage is new → owed anchor-less.
    const dead = conn({ rootsForCoverage: [{ ...rodentRoot, status: 'completed', source_estimate_id: 'est-1' }], scheduledService: null });
    expect(await findDirectRodentSetupObligationForCoverage(dead, { customerId: 'cust-1', coverageServiceType: 'Rodent Bait Stations' })).toEqual({ anchorId: null, amount: 99 });
    // Linked to the bait program, wearing a stale "Pest Control" label → matches rodent coverage by catalog, owes on its own anchor.
    const stale = conn({ rootsForCoverage: [{ ...rodentRoot, service_type: 'Quarterly Pest Control', service_id: 'svc-rb' }], catalog: { service_key: 'rodent_bait_quarterly', name: 'Rodent Bait Stations' } });
    expect(await findDirectRodentSetupObligationForCoverage(stale, { customerId: 'cust-1', coverageServiceType: 'Rodent Bait Stations' })).toEqual({ anchorId: 'root-rb', amount: 99 });
    // …and it does NOT match pest coverage despite the label.
    expect(await findDirectRodentSetupObligationForCoverage(stale, { customerId: 'cust-1', coverageServiceType: 'Quarterly Pest Control' })).toBeNull();
  });

  test('a PRE-rollout direct root (grandfathered signup, no stamp) never acquires the live fee (codex #3591 r42 P1)', async () => {
    mockQualifyingKeys = async () => [];
    const old = conn({ rootsForCoverage: [{ ...rodentRoot, created_at: '2026-03-01T12:00:00.000Z' }] });
    expect(await findDirectRodentSetupObligationForCoverage(old, { customerId: 'cust-1', coverageServiceType: 'Rodent Bait Stations' })).toBeNull();
  });

  test('a RESCHEDULED root with live children is still the series; an estimate-origin root with a RESTORED positive stamp reports that claim (codex #3591 r44 P1)', async () => {
    mockQualifyingKeys = async () => ['rodent_bait'];
    // Legacy customer-reschedule marked the ESTIMATE-origin root; children
    // live → the series exists → null (never a second setup). A DIRECT
    // rescheduled root still owes on its own anchor (first test above).
    const resched = conn({ rootsForCoverage: [{ ...rodentRoot, status: 'rescheduled', source_estimate_id: 'est-1' }], scheduledService: { id: 'child-1' } });
    expect(await findDirectRodentSetupObligationForCoverage(resched, { customerId: 'cust-1', coverageServiceType: 'Rodent Bait Stations' })).toBeNull();
    // Same root with NO live child → dead series → new coverage → anchor-less obligation.
    const reschedDead = conn({ rootsForCoverage: [{ ...rodentRoot, status: 'rescheduled', source_estimate_id: 'est-1' }], scheduledService: null });
    expect(await findDirectRodentSetupObligationForCoverage(reschedDead, { customerId: 'cust-1', coverageServiceType: 'Rodent Bait Stations' })).toEqual({ anchorId: null, amount: 99 });
    // Estimate-origin root whose refunded prepay re-stamped it → the restored claim IS the obligation.
    const restored = conn({ rootsForCoverage: [{ ...rodentRoot, source_estimate_id: 'est-1', pending_setup_fee: '99.00' }] });
    expect(await findDirectRodentSetupObligationForCoverage(restored, { customerId: 'cust-1', coverageServiceType: 'Rodent Bait Stations' }))
      .toEqual({ anchorId: 'root-rb', amount: 99 });
    // …and the shared resolver honors it too (the C360 mint re-derives through it).
    const resolverConn = conn({ scheduledService: { ...rodentRoot, source_estimate_id: 'est-1', pending_setup_fee: '99.00' } });
    expect(await plans.resolveDirectRodentSetupObligation(resolverConn, { id: 'root-rb' })).toBe(99);
  });

  test('a failing lookup propagates (the mint refuses retryably, never reads it as a waiver)', async () => {
    const c = conn({ rootsForCoverage: [rodentRoot] });
    mockQualifyingKeys = async () => { throw new Error('db down'); };
    await expect(findDirectRodentSetupObligationForCoverage(c, { customerId: 'cust-1', coverageServiceType: 'Rodent Bait Stations' })).rejects.toThrow('db down');
  });
});

describe('source contracts — where the lifecycle is wired', () => {
  const booking = fs.readFileSync(path.join(__dirname, '..', 'routes', 'booking.js'), 'utf8');

  test('the admin booking stamp covers accept-on-book failure paths and is RETIRED when acceptance lands (codex #3591 r61+r62 P1)', () => {
    const adminSchedule = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin-schedule.js'), 'utf8');
    // r61 exempted every linkedEstimateId from the transaction-time stamp; r62
    // showed the acceptance runs post-commit and deliberately leaves the
    // appointment standing when the attach loses a race or accept throws — so
    // accept-on-book series stamp too, and only an ALREADY-ACCEPTED linked
    // estimate (its accept billed the setup decision) skips.
    expect(adminSchedule).toMatch(/if \(isRecurring && \(!linkedEstimateId \|\| acceptEstimateOnBook\)\) \{\s+const \{ resolveDirectRodentSetupObligation \} = require\('\.\.\/services\/secure-appointment-plans'\);/);
    // The stamp is recorded for the post-commit acceptance to retire…
    expect(adminSchedule).toMatch(/directRodentSetupStamp = owedSetup;/);
    // A PREVIOUSLY accepted estimate booked afterward stamps its DISCLOSED
    // figure unless settled (term claim) or carried by another of its
    // series (codex #3591 r66 P1) — the standard Mark Won never billed it.
    expect(adminSchedule).toMatch(/\} else if \(isRecurring && linkedEstimateId\) \{[\s\S]*?plans\.isRodentBaitProgramKey\(await plans\.authoritativeServiceKey\(trx, svc\)\)[\s\S]*?const disclosed = frozenRodentBaitSetupAmount\(linkedEstimate\?\.estimate_data \|\| \{\}\);\s+if \(disclosed > 0\s+&& !\(await plans\.settledSetupClaimForEstimate\(trx, linkedEstimateId\)\)\s+&& !\(await plans\.estimateSetupCarriedElsewhere\(trx, linkedEstimateId, svc\.id\)\)\) \{\s+await trx\('scheduled_services'\)\s+\.where\(\{ id: svc\.id \}\)\s+\.whereNull\('pending_setup_fee'\)\s+\.update\(\{ pending_setup_fee: disclosed, updated_at: new Date\(\) \}\);/);
    // …and BOTH acceptance-success paths (main accept and the overlap-race
    // standard downgrade) retire it, CAS'd on the exact stamped amount.
    expect(adminSchedule).toMatch(/await retireRodentSetupStampAfterAcceptance\(acceptResult\);/);
    expect(adminSchedule).toMatch(/await retireRodentSetupStampAfterAcceptance\(retryResult\);/);
    // …but only when the acceptance SETTLED the setup (codex #3591 r64 P1):
    // a standard verbal win converts with skipSetupInvoice, so the stamp
    // stays for the first completion; settlement evidence = the prepay
    // mint's setup_fee_claims row on the acceptance invoice, or the
    // estimate's explicit rodent-setup waiver. A settled anchor-less claim
    // is anchored to the booked series.
    // Ledger reads/writes go through the service (the route never touches
    // setup_fee_claims itself — same rule the switch route's contract pins).
    // A race-lost acceptance (alreadyAccepted, no conversion) resolves the
    // WINNER's claim through the estimate's term; the waiver is the estimate's
    // DISCLOSED figure (engine result), not the wizard-only setupFeeQuote
    // (codex #3591 r65 P1). A disclosed-but-unbilled setup keeps the stamp,
    // aligned to the disclosed figure.
    expect(adminSchedule).toMatch(/const rodentSetupSettledByAcceptance = async \(acceptResult\) => \{[\s\S]*?acceptResult\?\.alreadyAccepted\s+\? await settledSetupClaimForEstimate\(db, linkedEstimateId\)\s+: await settledSetupClaimForInvoice\(db, acceptResult\?\.conversion\?\.draftInvoiceId \|\| null\);[\s\S]*?const disclosed = frozenRodentBaitSetupAmount\(linkedEstimate\?\.estimate_data \|\| \{\}\);\s+return disclosed > 0 \? \{ disclosed \} : \{ waived: 'estimate_disclosed_no_setup' \};/);
    expect(adminSchedule).toMatch(/const settled = await rodentSetupSettledByAcceptance\(acceptResult\);\s+if \(settled\.disclosed\) \{[\s\S]*?\.update\(\{ pending_setup_fee: settled\.disclosed, updated_at: new Date\(\) \}\);[\s\S]*?return;\s+\}\s+const retired = await db\('scheduled_services'\)/);
    expect(adminSchedule).toMatch(/if \(settled\.claim && !settled\.claim\.scheduled_service_id\) \{[\s\S]*?await anchorSetupFeeClaim\(db, \{ claimId: settled\.claim\.id, anchorId: svc\.id \}\);/);
    expect(adminSchedule.includes("('setup_fee_claims')")).toBe(false);
    expect(adminSchedule).toMatch(/const retired = await db\('scheduled_services'\)\s+\.where\(\{ id: svc\.id, pending_setup_fee: directRodentSetupStamp \}\)\s+\.update\(\{ pending_setup_fee: null/);
    // A retire failure must warn about the double-bill hazard, never fail silently.
    expect(adminSchedule).toMatch(/retireRodentSetupStampAfterAcceptance = async \(acceptResult\) => \{[\s\S]*?bookingWarnings\.push\('The estimate acceptance covered the bait-station setup/);
    // A ZERO-row CAS is the consumed/refrozen-stamp race, not success (codex
    // #3591 r63 P1): it must warn and leave the local stamp un-cleared.
    const retireBody = adminSchedule.slice(adminSchedule.indexOf('const retireRodentSetupStampAfterAcceptance = async'), adminSchedule.indexOf('await retireRodentSetupStampAfterAcceptance(acceptResult);'));
    expect(retireBody).toMatch(/if \(Number\(retired\) !== 1\) \{[\s\S]*?logger\.error\([\s\S]*?bookingWarnings\.push\('The estimate acceptance covered the bait-station setup, but the booking-time setup stamp had already been consumed or changed[\s\S]*?return;\s*\}\s*directRodentSetupStamp = 0;/);
  });

  const converter = fs.readFileSync(path.join(__dirname, '..', 'services', 'estimate-converter.js'), 'utf8');
  const invoice = fs.readFileSync(path.join(__dirname, '..', 'services', 'invoice.js'), 'utf8');

  test('public accept: strict waiver re-check, setup in both commercial prepay tax blends, and a ledgered claim on the standard invoice (codex #3591 r68 P1)', () => {
    const estimatePublic = fs.readFileSync(path.join(__dirname, '..', 'routes', 'estimate-public.js'), 'utf8');
    expect(estimatePublic).toMatch(/loadExistingQualifyingServiceKeys\(db, estimate\.customer_id, \{ strict: true \}\) \|\| \[\];\s+setupWaiverStale = /);
    expect(estimatePublic).toMatch(/resolveCommercialPrepayTaxRate\(recurring, \{\s+prepayDiscountApplied: prepayResolved\.discount > 0,\s+baseRate: opts\.prepayBaseRate,\s+taxableOneTimeAmount: rodentSetupDueToday,\s+\}\)/);
    expect(estimatePublic).toMatch(/resolveCommercialPrepayTaxRate\(recurringSvcList, \{ prepayDiscountApplied: resolved\.discount > 0, baseRate: prepayDisplayBaseRate, taxableOneTimeAmount: acknowledgedRodentSetup \}\)/);
    expect(estimatePublic).toMatch(/invoiceIdResult = inv\.id;[\s\S]*?if \(acceptedRodentSetupAmount > 0\) \{[\s\S]*?await plans\.recordSetupFeeClaimForInvoice\(trx, \{\s+invoiceId: inv\.id,\s+anchorId: acceptRodentRoot \? acceptRodentRoot\.id : null,\s+amount: acceptedRodentSetupAmount,\s+\}\);/);
  });

  test('the discount-rules missing-row insert carries EVERY validated field of the edit (codex #3591 r67 P1)', () => {
    const pricingConfig = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin-pricing-config.js'), 'utf8');
    expect(pricingConfig).toMatch(/if \(!ruleUpdated && req\.params\.serviceKey === 'rodent_bait'\) \{\s+await trx\('service_discount_rules'\)\.insert\(\{\s+service_key: 'rodent_bait',\s+tier_qualifier: true,\s+exclude_from_pct_discount: false,\s+\.\.\.updates,\s+\}\);/);
  });

  test('booking re-reads the canonical qualifying families under the stamp lock and waives on any OTHER family (codex #3591 r37 P1)', () => {
    const at = booking.indexOf("const rodentSetupQuote = estData?.setupFeeQuote?.kind === 'rodent_bait_setup';");
    const queued = booking.indexOf('const queuedElsewhere = await sp(', at);
    const reload = booking.indexOf('loadExistingQualifyingServiceKeys(sp, custId)', at);
    expect(at).toBeGreaterThan(-1);
    expect(reload).toBeGreaterThan(at);
    expect(reload).toBeLessThan(queued);
    expect(booking.slice(reload, queued)).toMatch(/\.filter\(\(key\) => key !== 'rodent_bait'\)[\s\S]*retireOrWaiveDraft\('existing_member'\)/);
  });

  test('the estimate-accept prepay ledgers the billed rodent setup on the scheduled rodent root, inside the accept transaction (codex #3591 r37 P1)', () => {
    expect(converter).toMatch(/if \(billingTerm === 'prepay_annual' && draftInvoiceId && frozenRodentBaitSetupAmount\(estimateData\) > 0\) \{/);
    expect(converter).toMatch(/recordSetupFeeClaimForInvoice\(database, \{\s*invoiceId: draftInvoiceId,\s*anchorId: rodentRoot \? rodentRoot\.id : null,/);
    // …and the restore resolves an anchor-less record from the term's source estimate (codex #3591 r39 P1).
    const renewals = fs.readFileSync(path.join(__dirname, '..', 'services', 'annual-prepay-renewals.js'), 'utf8');
    expect((renewals.match(/restoreRetiredSetupFeeClaimForPrepay\([a-z]+\.prepay_invoice_id, (?:conn|t), \{ sourceEstimateId: [a-z]+\.source_estimate_id \|\| null, customerId: [a-z]+\.customer_id \|\| null, coverageServiceType: [a-z]+\.coverage_service_type \|\| null \}\)/g) || []).length).toBe(2);
    // …and the restore no longer refuses an estimate-origin parent.
    expect(invoice).not.toMatch(/if \(!parent \|\| parent\.source_estimate_id\) return null;/);
  });

  test('the Customer 360 mint derives the coverage series\' obligation when the dialog omits the setup and refuses with the figure + anchor (codex #3591 r37 P1)', () => {
    const customers = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin-customers.js'), 'utf8');
    const mintAt = customers.indexOf("router.post('/:id/annual-prepay-invoice'");
    const derive = customers.indexOf('findDirectRodentSetupObligationForCoverage(db, { customerId: customer.id, coverageServiceType })', mintAt);
    const refuse = customers.indexOf('setupFeeRequired: true,', derive);
    const trxAt = customers.indexOf('await db.transaction(async (trx) => {', mintAt);
    expect(derive).toBeGreaterThan(mintAt);
    expect(refuse).toBeGreaterThan(derive);
    expect(refuse).toBeLessThan(trxAt);
    // Runs whenever no setup is billed — an anchor with a zero amount still revalidates (codex #3591 r43 P2).
    expect(customers.slice(mintAt, trxAt)).toMatch(/if \(!\(setupFeeAmount > 0\)\) \{/);
  });

  const renewals = fs.readFileSync(path.join(__dirname, '..', 'services', 'annual-prepay-renewals.js'), 'utf8');
  const schedule = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin-schedule.js'), 'utf8');

  test('BOTH term-cancel branches (true void/refund AND decided-lapse refund) restore the claim right after the superseded-invoice restore', () => {
    // Each branch hands the term's source estimate along so an anchor-less
    // record can resolve its rodent root at restore time (codex #3591 r39 P1).
    const CALL_RE = /restoreRetiredSetupFeeClaimForPrepay\((updated|decided)\.prepay_invoice_id, (?:conn|t), \{ sourceEstimateId: \1\.source_estimate_id \|\| null, customerId: \1\.customer_id \|\| null, coverageServiceType: \1\.coverage_service_type \|\| null \}\)/g;
    const calls = [...renewals.matchAll(CALL_RE)].map((m) => m[1]);
    expect(calls.sort()).toEqual(['decided', 'updated']);
    for (const who of ['updated', 'decided']) {
      const superseded = renewals.indexOf(`restoreSwitchSupersededInvoicesForPrepay(${who}.prepay_invoice_id, ${who === 'updated' ? 't' : 'conn'})`);
      const claim = renewals.indexOf(`restoreRetiredSetupFeeClaimForPrepay(${who}.prepay_invoice_id, ${who === 'updated' ? 't' : 'conn'}, { sourceEstimateId: ${who}.source_estimate_id || null, customerId: ${who}.customer_id || null, coverageServiceType: ${who}.coverage_service_type || null })`);
      expect(superseded).toBeGreaterThan(-1);
      expect(claim).toBeGreaterThan(superseded);
    }
  });

  test('the Customer 360 mint requires the anchor whenever a setup is billed, runs the service step under its transaction, maps conflicts to 409, and never writes the ledger itself', () => {
    const customers = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin-customers.js'), 'utf8');
    // Anchored → the anchored retire; anchor-less (new rodent prepay, no
    // series yet — codex #3591 r41 P1) → the coverage-derived retire.
    expect(customers).toMatch(/if \(setupScheduledServiceId\) \{\s*\n\s*await plans\.retirePrepayOnBookSetupClaim\(trx, \{/);
    expect(customers).toMatch(/\} else \{[\s\S]{0,400}await plans\.retireCoverageOnlySetupClaim\(trx, \{\s*\n\s*customerId: customer\.id,\s*\n\s*coverageServiceType,/);
    expect(customers).not.toMatch(/setupFeeAmount requires scheduledServiceId/);
    const mintAt = customers.indexOf("router.post('/:id/annual-prepay-invoice'");
    const claimAt = customers.indexOf('retirePrepayOnBookSetupClaim(trx', mintAt);
    const conflictAt = customers.indexOf('if (err && err.switchConflict) return res.status(409)', claimAt);
    expect(claimAt).toBeGreaterThan(mintAt);
    expect(conflictAt).toBeGreaterThan(claimAt);
    expect(customers.includes("('setup_fee_claims')")).toBe(false);
    // The preview hands the mint the anchor beside the setup, never alone.
    expect(schedule).toMatch(/\.\.\.\(pricing\.prepay\.setupAmount > 0 && input\.anchorVisit\?\.id \? \{ scheduledServiceId: String\(input\.anchorVisit\.id\) \} : \{\}\),/);
  });

  test('the switch route retires the claim through the service, only for a DIRECT series with a billed setup, and never writes the ledger itself', () => {
    expect(schedule).toMatch(/if \(switchSetupFee > 0 && !target\.estimateId\) \{\s*\n\s*await require\('\.\.\/services\/secure-appointment-plans'\)\.retireDirectSetupClaimForPrepay\(trx, \{/);
    expect(schedule.includes("('setup_fee_claims')")).toBe(false);
  });
});

describe('restoreRodentSetupObligationForReversedInvoice — a voided/refunded STANDARD invoice puts the setup back (codex #3591 r44 P1)', () => {
  const setupInvoice = (over = {}) => ({
    id: 'inv-std', customer_id: 'cust-1', scheduled_service_id: null,
    line_items: [
      { description: 'Bait Station Setup — one-time setup fee', quantity: 1, unit_price: 99, amount: 99 },
      { description: 'First service application', quantity: 1, unit_price: 128, amount: 128 },
    ],
    ...over,
  });
  const rodentRoot = { id: 'root-rb', service_type: 'Rodent Bait Stations', service_id: null, recurring_parent_id: null };
  beforeEach(() => { mockQualifyingKeys = async () => []; });

  test('re-stamps the customer\'s live rodent root by CAS; a linked visit resolves through its root first', async () => {
    const c = conn({ rootsForCoverage: [{ id: 'root-pest', service_type: 'Quarterly Pest Control', service_id: null }, rodentRoot], claim: null, scheduledService: { id: 'root-rb', status: 'confirmed' } });
    expect(await InvoiceService.restoreRodentSetupObligationForReversedInvoice(c, setupInvoice()))
      .toEqual({ scheduledServiceId: 'root-rb', amount: 99 });
    expect(c.writes).toEqual([
      expect.objectContaining({ table: 'scheduled_services', op: 'update', whereNull: 'pending_setup_fee', patch: expect.objectContaining({ pending_setup_fee: 99 }) }),
    ]);
    const linked = conn({ scheduledService: rodentRoot, claim: null });
    expect(await InvoiceService.restoreRodentSetupObligationForReversedInvoice(linked, setupInvoice({ scheduled_service_id: 'child-x' })))
      .toEqual({ scheduledServiceId: 'root-rb', amount: 99 });
  });

  test('no setup line / a prepay invoice (claims-ledger row) / occupied stamp / no rodent root → no write', async () => {
    const noLine = conn({ rootsForCoverage: [rodentRoot], claim: null });
    expect(await InvoiceService.restoreRodentSetupObligationForReversedInvoice(noLine, setupInvoice({ line_items: [{ description: 'First service application', amount: 128 }] }))).toBeNull();
    expect(noLine.writes).toEqual([]);
    const prepay = conn({ rootsForCoverage: [rodentRoot], claim: { id: 'claim-1' }, prepayTerm: { id: 'term-1' } });
    expect(await InvoiceService.restoreRodentSetupObligationForReversedInvoice(prepay, setupInvoice())).toBeNull();
    expect(prepay.writes).toEqual([]);
    const occupied = conn({ rootsForCoverage: [rodentRoot], claim: null, updateResult: 0, scheduledService: { id: 'root-rb', status: 'confirmed' } });
    expect(await InvoiceService.restoreRodentSetupObligationForReversedInvoice(occupied, setupInvoice())).toBeNull();
    const noRoot = conn({ rootsForCoverage: [{ id: 'root-pest', service_type: 'Quarterly Pest Control', service_id: null }], claim: null });
    expect(await InvoiceService.restoreRodentSetupObligationForReversedInvoice(noRoot, setupInvoice())).toBeNull();
    expect(noRoot.writes).toEqual([]);
  });

  test('wired into the void transition and the refund TRANSITION WINNER (source contract, codex #3591 r45 P1)', () => {
    const invoiceSrc = fs.readFileSync(path.join(__dirname, '..', 'services', 'invoice.js'), 'utf8');
    const creditSrc = fs.readFileSync(path.join(__dirname, '..', 'services', 'customer-credit.js'), 'utf8');
    const voidAt = invoiceSrc.indexOf('async voidInvoice(id) {');
    const flipAt = invoiceSrc.indexOf('.update({ status: "void", updated_at: new Date() })', voidAt);
    const restoreAt = invoiceSrc.indexOf('restoreRodentSetupObligationForReversedInvoice(trx, updated)', flipAt);
    expect(restoreAt).toBeGreaterThan(flipAt);
    // Refunds terminalize inside returnAppliedCreditOnRefund; the restore
    // rides its !alreadyTerminal winner under the same row lock.
    const winnerAt = creditSrc.indexOf('if (!alreadyTerminal) {');
    const creditRestoreAt = creditSrc.indexOf("require('./invoice').restoreRodentSetupObligationForReversedInvoice(trx, inv)");
    expect(winnerAt).toBeGreaterThan(-1);
    expect(creditRestoreAt).toBeGreaterThan(winnerAt);
    // The locked read carries every column the restore needs.
    expect(creditSrc).toMatch(/first\('id', 'customer_id', 'invoice_number', 'status', 'credit_applied', 'line_items', 'scheduled_service_id'\)/);
  });

  test('a reversed STANDARD invoice on a DEAD series re-bills as a draft instead of stamping an inert root (codex #3591 r45 P1)', async () => {
    const createSpy = jest.spyOn(InvoiceService, 'create').mockResolvedValue({ id: 'inv-rebill-std', invoice_number: 'WPC-2026-0501' });
    try {
      const c = conn({ rootsForCoverage: [rodentRoot], claim: null, scheduledService: { id: 'root-rb', status: 'completed' }, liveVisitProbe: null });
      expect(await InvoiceService.restoreRodentSetupObligationForReversedInvoice(c, setupInvoice()))
        .toEqual({ scheduledServiceId: 'root-rb', amount: 99, reInvoiceId: 'inv-rebill-std' });
      expect(createSpy.mock.calls[0][0]).toMatchObject({
        customerId: 'cust-1',
        lineItems: [expect.objectContaining({ description: 'Bait Station Setup — one-time setup fee', unit_price: 99 })],
      });
      expect(c.writes.filter((w) => w.table === 'scheduled_services')).toEqual([]);
    } finally {
      createSpy.mockRestore();
    }
  });
});

describe('retireRodentSetupObligationForRevivedPrepay — a re-paid/revived prepay disarms the restored claim (codex #3591 r45 local P0)', () => {
  const prepayInvoiceRow = {
    id: 'inv-prepay', customer_id: 'cust-1', scheduled_service_id: null,
    line_items: [
      { description: 'Rodent Bait Stations - Annual Prepay', unit_price: 486.4, amount: 486.4 },
      { description: 'Bait Station Setup — one-time setup fee', unit_price: 99, amount: 99 },
    ],
  };
  const rodentRoot = { id: 'root-rb', service_type: 'Rodent Bait Stations', service_id: null, recurring_parent_id: null };
  function revivalConn({ stamp = '99.00', invoiceRow = prepayInvoiceRow, rebills = [] } = {}) {
    const c = conn({ rootsForCoverage: [rodentRoot], scheduledService: { id: 'root-rb', pending_setup_fee: stamp } });
    const inner = c;
    const wrapped = (table) => {
      const q = inner(table);
      if (table === 'invoices') {
        q.first = async () => invoiceRow;
        q.select = async () => rebills;
      }
      return q;
    };
    wrapped.writes = inner.writes;
    return wrapped;
  }

  test('re-ledgers the claim and CAS-retires the restored positive stamp', async () => {
    const c = revivalConn();
    expect(await InvoiceService.retireRodentSetupObligationForRevivedPrepay(c, 'inv-prepay'))
      .toEqual({ scheduledServiceId: 'root-rb', amount: 99, retired: true });
    expect(c.writes).toEqual([
      expect.objectContaining({ table: 'setup_fee_claims', op: 'insert', onConflict: 'invoice_id', row: { invoice_id: 'inv-prepay', scheduled_service_id: 'root-rb', amount: 99 } }),
      expect.objectContaining({ table: 'scheduled_services', op: 'update', where: { id: 'root-rb', pending_setup_fee: '99.00' }, patch: expect.objectContaining({ pending_setup_fee: null }) }),
    ]);
  });

  test('no restored stamp → record only; a completion mid-claim (negative stamp, read FOR UPDATE) FAILS the revival so the sync retries (codex #3591 r46 P1); no setup line → no-op', async () => {
    const clean = revivalConn({ stamp: null });
    expect(await InvoiceService.retireRodentSetupObligationForRevivedPrepay(clean, 'inv-prepay')).toMatchObject({ retired: false });
    expect(clean.writes.map((w) => w.table)).toEqual(['setup_fee_claims']);
    const busy = revivalConn({ stamp: '-99.00' });
    await expect(InvoiceService.retireRodentSetupObligationForRevivedPrepay(busy, 'inv-prepay'))
      .rejects.toThrow(/completion mid-claim/);
    expect(busy.writes.filter((w) => w.op === 'update')).toEqual([]);
    const noSetup = revivalConn({ invoiceRow: { ...prepayInvoiceRow, line_items: [{ description: 'Annual Prepay', amount: 486.4 }] } });
    expect(await InvoiceService.retireRodentSetupObligationForRevivedPrepay(noSetup, 'inv-prepay')).toBeNull();
    expect(noSetup.writes).toEqual([]);
  });

  test('a dead-series replacement draft is VOIDED on revival; a sent/paid replacement pages a human instead (codex #3591 r46 P1)', async () => {
    const marker = InvoiceService.rodentSetupRebillMarker('inv-prepay');
    const draft = revivalConn({ stamp: null, rebills: [{ id: 'inv-rebill', status: 'draft', sent_at: null, paid_at: null, payment_recorded_at: null, stripe_payment_intent_id: null }] });
    expect(await InvoiceService.retireRodentSetupObligationForRevivedPrepay(draft, 'inv-prepay')).toMatchObject({ retired: false });
    // The marker sweep runs FIRST (r47: independent of a live anchor).
    expect(draft.writes).toEqual([
      expect.objectContaining({ table: 'invoices', op: 'update', where: { id: 'inv-rebill', status: 'draft' }, patch: expect.objectContaining({ status: 'void' }) }),
      expect.objectContaining({ table: 'setup_fee_claims', op: 'insert' }),
    ]);
    expect(marker).toBe('[rodent-setup-rebill:inv-prepay]');
    // SENT-but-unpaid is voided too (codex #3591 r49 local P0): a live pay
    // link on the duplicate is a double charge waiting.
    const sent = revivalConn({ stamp: null, rebills: [{ id: 'inv-rebill', status: 'sent', sent_at: '2026-08-30', paid_at: null, payment_recorded_at: null, stripe_payment_intent_id: null }] });
    expect(await InvoiceService.retireRodentSetupObligationForRevivedPrepay(sent, 'inv-prepay')).toMatchObject({ retired: false });
    expect(sent.writes.filter((w) => w.table === 'invoices' && w.patch?.status === 'void')).toHaveLength(1);
    // Money attached → paged, never auto-voided.
    const paid = revivalConn({ stamp: null, rebills: [{ id: 'inv-rebill', status: 'paid', sent_at: '2026-08-30', paid_at: '2026-08-30', payment_recorded_at: null, stripe_payment_intent_id: null }] });
    expect(await InvoiceService.retireRodentSetupObligationForRevivedPrepay(paid, 'inv-prepay')).toMatchObject({ retired: false });
    expect(paid.writes.filter((w) => w.table === 'invoices')).toEqual([]);
  });

  test('anchor-less restore lookups keep RESCHEDULED roots (source contract, codex #3591 r46 P1)', () => {
    const invoiceSrc = fs.readFileSync(path.join(__dirname, '..', 'services', 'invoice.js'), 'utf8');
    const lockedAt = invoiceSrc.indexOf('_restoreRetiredSetupFeeClaimLocked(conn, prepayInvoiceId');
    const section = invoiceSrc.slice(lockedAt, invoiceSrc.indexOf('const parent = await conn("scheduled_services")', lockedAt));
    expect(section).not.toMatch(/whereNotIn\("status", \["cancelled", "canceled", "rescheduled"\]\)/);
    // Both re-bill mints carry the machine marker the revival sweep voids by.
    expect((invoiceSrc.match(/rodentSetupRebillMarker\(/g) || []).length).toBeGreaterThanOrEqual(3);
  });

  test('wired into BOTH term revival transitions (source contract)', () => {
    const renewals = fs.readFileSync(path.join(__dirname, '..', 'services', 'annual-prepay-renewals.js'), 'utf8');
    // Both revivals run inside a transaction closure now (r52): the flip
    // and the cleanup commit together, on the closure's handle.
    expect((renewals.match(/retireRodentSetupObligationForRevivedPrepay\(t, invoice\.id\)/g) || []).length).toBe(2);
    expect((renewals.match(/typeof conn\.transaction === 'function' && !conn\.isTransaction/g) || []).length).toBe(3); // revivals + cancel branch (r53)
  });
});

describe('compact mirrors persist EXPLICIT rodent posture (codex #3591 r45 local P0)', () => {
  test('public-quote and the automated-lead mirror both write true/false posture for new-model rows', () => {
    const publicQuote = fs.readFileSync(path.join(__dirname, '..', 'routes', 'public-quote.js'), 'utf8');
    expect(publicQuote).toMatch(/tierQualifier: item\.tierQualifier !== false && item\.countsTowardWaveGuardTier !== false,/);
    expect(publicQuote).toMatch(/excludeFromPctDiscount: item\.excludeFromPctDiscount === true \|\| item\.waveGuardDiscountEligible === false,/);
    const { _test } = require('../services/lead-estimate-automation');
    const freeze = _test?.rodentEligibilityFreeze;
    if (freeze) {
      expect(freeze({ service: 'rodent_bait', perApplicationBilled: true, stations: 5 }))
        .toMatchObject({ tierQualifier: true, countsTowardWaveGuardTier: true, excludeFromPctDiscount: false, waveGuardDiscountEligible: true });
      expect(freeze({ service: 'rodent_bait', perApplicationBilled: true, tierQualifier: false }))
        .toMatchObject({ tierQualifier: false, excludeFromPctDiscount: false });
    } else {
      const lead = fs.readFileSync(path.join(__dirname, '..', 'services', 'lead-estimate-automation.js'), 'utf8');
      expect(lead).toMatch(/tierQualifier: !nonQualifying,/);
      expect(lead).toMatch(/waveGuardDiscountEligible: !pctExcluded,/);
    }
  });
});

describe('retireRodentSetupObligationForReinstatedInvoice — a bounced refund retires the refunded-transition side effects (codex #3591 r47 local P0)', () => {
  const stdInvoice = (over = {}) => ({
    id: 'inv-std', customer_id: 'cust-1', scheduled_service_id: null,
    line_items: [
      { description: 'Bait Station Setup — one-time setup fee', unit_price: 99, amount: 99 },
      { description: 'First service application', unit_price: 128, amount: 128 },
    ],
    ...over,
  });
  const rodentRoot = { id: 'root-rb', service_type: 'Rodent Bait Stations', service_id: null, recurring_parent_id: null };
  function reinstConn({ stamp = '99.00', invoiceRow = stdInvoice(), claimRow = null, rebills = [], prepayTerm = null } = {}) {
    const inner = conn({ rootsForCoverage: [rodentRoot], scheduledService: { id: 'root-rb', pending_setup_fee: stamp }, claim: claimRow, prepayTerm });
    const wrapped = (table) => {
      const q = inner(table);
      if (table === 'invoices') {
        q.first = async () => invoiceRow;
        q.select = async () => rebills;
      }
      return q;
    };
    wrapped.writes = inner.writes;
    return wrapped;
  }

  test('an exact-value restored stamp is CAS-cleared; a different stamp is left and paged; a draft re-bill is voided', async () => {
    const c = reinstConn();
    expect(await InvoiceService.retireRodentSetupObligationForReinstatedInvoice(c, 'inv-std')).toEqual({ retired: true, voidedRebills: 0 });
    expect(c.writes).toEqual([
      expect.objectContaining({ table: 'scheduled_services', op: 'update', where: { id: 'root-rb', pending_setup_fee: '99.00' }, patch: expect.objectContaining({ pending_setup_fee: null }) }),
    ]);
    const other = reinstConn({ stamp: '79.00' });
    expect(await InvoiceService.retireRodentSetupObligationForReinstatedInvoice(other, 'inv-std')).toEqual({ retired: false, voidedRebills: 0 });
    expect(other.writes.filter((w) => w.table === 'scheduled_services')).toEqual([]);
    const withRebill = reinstConn({ stamp: null, rebills: [{ id: 'inv-rebill', status: 'draft', sent_at: null, paid_at: null, payment_recorded_at: null, stripe_payment_intent_id: null }] });
    expect(await InvoiceService.retireRodentSetupObligationForReinstatedInvoice(withRebill, 'inv-std')).toEqual({ retired: false, voidedRebills: 1 });
    expect(withRebill.writes).toEqual([
      expect.objectContaining({ table: 'invoices', op: 'update', patch: expect.objectContaining({ status: 'void' }) }),
    ]);
  });

  test('a renamed/repriced completion invoice still retires from its immutable claim (amount + anchor), never the edited line (codex #3591 r64 P1)', async () => {
    const edited = reinstConn({
      invoiceRow: stdInvoice({ line_items: [{ description: 'Station install (edited)', unit_price: 50, amount: 50 }] }),
      claimRow: { id: 'claim-c', amount: '99.00', scheduled_service_id: 'root-rb' },
    });
    expect(await InvoiceService.retireRodentSetupObligationForReinstatedInvoice(edited, 'inv-std')).toEqual({ retired: true, voidedRebills: 0 });
    expect(edited.writes).toEqual([
      expect.objectContaining({ table: 'scheduled_services', op: 'update', where: { id: 'root-rb', pending_setup_fee: '99.00' }, patch: expect.objectContaining({ pending_setup_fee: null }) }),
    ]);
    // The edited line's $50 must not decide: with the claim at $99 and a $99 stamp the CAS matches; the line alone would have paged.
    const lineOnly = reinstConn({ invoiceRow: stdInvoice({ line_items: [{ description: 'Bait Station Setup — one-time setup fee', unit_price: 50, amount: 50 }] }) });
    expect(await InvoiceService.retireRodentSetupObligationForReinstatedInvoice(lineOnly, 'inv-std')).toEqual({ retired: false, voidedRebills: 0 });
  });

  test('a prepay invoice (claims-ledger row) and a no-setup-line invoice are no-ops', async () => {
    const prepay = reinstConn({ claimRow: { id: 'claim-1' }, prepayTerm: { id: 'term-1' } });
    expect(await InvoiceService.retireRodentSetupObligationForReinstatedInvoice(prepay, 'inv-std')).toBeNull();
    expect(prepay.writes).toEqual([]);
    const plain = reinstConn({ invoiceRow: stdInvoice({ line_items: [{ description: 'First service application', amount: 128 }] }) });
    expect(await InvoiceService.retireRodentSetupObligationForReinstatedInvoice(plain, 'inv-std')).toBeNull();
    expect(plain.writes).toEqual([]);
  });

  test('wired into every webhook flip that LEAVES refunded (source contract)', () => {
    const webhookSrc = fs.readFileSync(path.join(__dirname, '..', 'routes', 'stripe-webhook.js'), 'utf8');
    expect((webhookSrc.match(/retireRodentSetupObligationForReinstatedInvoice\(trx, /g) || []).length).toBe(3);
  });
});

describe('r47 wiring — commercial bait, anchor-less revival sweep, unvoid retire (codex #3591 r47 P1)', () => {
  const plansMod = require('../services/secure-appointment-plans');

  test('commercial bait programs are setup-bearing (never member-waived); tier qualification untouched', async () => {
    expect(plansMod.isRodentBaitProgramKey('rodent_bait')).toBe(true);
    expect(plansMod.isRodentBaitProgramKey('commercial_rodent_bait')).toBe(true);
    expect(plansMod.isRodentBaitProgramKey('rodent_trapping')).toBe(false);
    // A commercial bait root owes even when the account has other families.
    mockQualifyingKeys = async () => ['pest_control'];
    const commercialRoot = { id: 'root-crb', customer_id: 'cust-1', service_type: 'Commercial Rodent Bait Stations', service_id: null, source_estimate_id: null, recurring_parent_id: null, created_at: '2026-09-01T12:00:00.000Z', status: 'confirmed' };
    const c = conn({ scheduledService: commercialRoot });
    expect(await plansMod.resolveDirectRodentSetupObligation(c, { id: 'root-crb' })).toBe(99);
    // New commercial coverage with no root → owed anchor-less too.
    const none = conn({ rootsForCoverage: [] });
    expect(await findDirectRodentSetupObligationForCoverage(none, { customerId: 'cust-1', coverageServiceType: 'Commercial Rodent Bait Stations' }))
      .toEqual({ anchorId: null, amount: 99 });
  });

  test('a revived prepay with NO live anchor (cancelled series) still sweeps + voids the replacement draft and re-ledgers anchor-less', async () => {
    mockQualifyingKeys = async () => ['rodent_bait'];
    const prepayInvoiceRow = {
      id: 'inv-prepay', customer_id: 'cust-1', scheduled_service_id: null,
      line_items: [{ description: 'Bait Station Setup — one-time setup fee', unit_price: 99, amount: 99 }],
    };
    const inner = conn({ rootsForCoverage: [], scheduledService: null });
    const wrapped = (table) => {
      const q = inner(table);
      if (table === 'invoices') {
        q.first = async () => prepayInvoiceRow;
        q.select = async () => [{ id: 'inv-rebill', status: 'draft', sent_at: null, paid_at: null, payment_recorded_at: null, stripe_payment_intent_id: null }];
      }
      return q;
    };
    wrapped.writes = inner.writes;
    expect(await InvoiceService.retireRodentSetupObligationForRevivedPrepay(wrapped, 'inv-prepay'))
      .toEqual({ scheduledServiceId: null, amount: 99, retired: false });
    expect(wrapped.writes).toEqual([
      expect.objectContaining({ table: 'invoices', op: 'update', patch: expect.objectContaining({ status: 'void' }) }),
      expect.objectContaining({ table: 'setup_fee_claims', op: 'insert', row: { invoice_id: 'inv-prepay', scheduled_service_id: null, amount: 99 } }),
    ]);
  });

  test('unvoid retires the restored setup state, gated on the setup line (source contract)', () => {
    const invoiceSrc = fs.readFileSync(path.join(__dirname, '..', 'services', 'invoice.js'), 'utf8');
    const unvoidAt = invoiceSrc.indexOf('async unvoidInvoice(id) {');
    const gateAt = invoiceSrc.indexOf('Bait Station Setup — one-time setup fee', unvoidAt);
    const callAt = invoiceSrc.indexOf('retireRodentSetupObligationForReinstatedInvoice(trx, id, { strict: true })', unvoidAt);
    expect(gateAt).toBeGreaterThan(unvoidAt);
    expect(callAt).toBeGreaterThan(gateAt);
  });
});

describe('r48 local audit — catalog-first coverage identity + fee-free mint TOCTOU (codex #3591 r48 local P0)', () => {
  test('selectSecurePlan mints coverage from the CATALOG name; the fee-free mint re-derives under the transaction (source contracts)', () => {
    const plansSrc = fs.readFileSync(path.join(__dirname, '..', 'services', 'secure-appointment-plans.js'), 'utf8');
    const covAt = plansSrc.indexOf('let coverageServiceType = visit.service_type;');
    const catalogAt = plansSrc.indexOf("await db('services').where({ id: visit.service_id }).first('name')", covAt);
    expect(covAt).toBeGreaterThan(-1);
    expect(catalogAt).toBeGreaterThan(covAt);
    const customersSrc = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin-customers.js'), 'utf8');
    const trxAt = customersSrc.indexOf('await db.transaction(async (trx) => {', customersSrc.indexOf("router.post('/:id/annual-prepay-invoice'"));
    const guardAt = customersSrc.indexOf('.findDirectRodentSetupObligationForCoverage(trx, { customerId: customer.id, coverageServiceType })', trxAt);
    expect(trxAt).toBeGreaterThan(-1);
    expect(guardAt).toBeGreaterThan(trxAt);
    expect(customersSrc.slice(guardAt - 600, guardAt)).toMatch(/if \(!\(setupFeeAmount > 0\)\) \{/);
  });
});

describe('r48 — completion claims restore, in-flight/sibling reconciliation, commercial staff routing (codex #3591 r48 P1)', () => {
  const stdInvoice = (over = {}) => ({
    id: 'inv-completion', customer_id: 'cust-1', scheduled_service_id: null,
    line_items: [{ description: 'Bait Station Setup — one-time setup fee', unit_price: 99, amount: 99 }],
    ...over,
  });
  const rodentRoot = { id: 'root-rb', service_type: 'Rodent Bait Stations', service_id: null, recurring_parent_id: null };
  function revConn({ stamp = null, claimRow = { id: 'claim-c' }, termBacked = null, siblings = [], invoiceRow = stdInvoice(), liveVisitProbe = { id: 'child-live' }, siblingInvoice = null } = {}) {
    const writes = [];
    const trx = (table) => {
      const q = { _where: null };
      q.where = (w) => { if (typeof w === 'function') { w.call(q); return q; } q._where = { ...(q._where || {}), ...(typeof w === 'object' ? w : {}) }; return q; };
      q.whereNot = () => q; q.orWhere = () => q; q.whereNull = (col) => { q._whereNull = col; return q; }; q.forUpdate = () => q;
      q.whereNotIn = () => q; q.whereIn = () => { q._whereIn = true; return q; }; q.orderBy = () => q; q.orWhereNotNull = () => q;
      q.first = async () => {
        if (table === 'setup_fee_claims') return q._where && q._where.scheduled_service_id ? (siblings[0] || null) : claimRow;
        if (table === 'annual_prepay_terms') return termBacked;
        if (table === 'scheduled_services') return q._whereIn ? liveVisitProbe : { id: 'root-rb', pending_setup_fee: stamp, status: 'confirmed' };
        if (table === 'invoices') return q._where && q._where.id && q._where.id !== invoiceRow.id ? siblingInvoice : invoiceRow;
        return null;
      };
      q.select = async () => (table === 'scheduled_services' ? [rodentRoot] : []);
      q.update = async (patch) => { writes.push({ table, op: 'update', where: q._where, whereNull: q._whereNull, patch }); return 1; };
      q.delete = async () => { writes.push({ table, op: 'delete', where: q._where }); return 1; };
      q.insert = (row) => { writes.push({ table, op: 'insert', row }); const p = Promise.resolve([{}]); p.onConflict = () => ({ ignore: async () => 1 }); return p; };
      return q;
    };
    trx.writes = writes;
    return trx;
  }

  test('a reversed COMPLETION invoice (claim record, no term) restores the stamp and consumes the record; a term-backed prepay still skips', async () => {
    mockQualifyingKeys = async () => [];
    const c = revConn();
    expect(await InvoiceService.restoreRodentSetupObligationForReversedInvoice(c, stdInvoice()))
      .toEqual({ scheduledServiceId: 'root-rb', amount: 99 });
    // The record is consumed AFTER the successful re-stamp (r53: ambiguity keeps the evidence).
    expect(c.writes.map((w) => `${w.table}:${w.op}`)).toEqual(['scheduled_services:update', 'setup_fee_claims:delete']);
    const prepay = revConn({ termBacked: { id: 'term-1' } });
    expect(await InvoiceService.restoreRodentSetupObligationForReversedInvoice(prepay, stdInvoice())).toBeNull();
    expect(prepay.writes).toEqual([]);
  });

  test('reinstating over a completion mid-claim THROWS; a sibling claim refuses strict (unvoid) and pages non-strict (webhook)', async () => {
    mockQualifyingKeys = async () => [];
    await expect(InvoiceService.retireRodentSetupObligationForReinstatedInvoice(revConn({ stamp: '-99.00', claimRow: null }), 'inv-completion'))
      .rejects.toThrow(/completion mid-claim/);
    // A sibling WITH money attached refuses strict; unpaid siblings are
    // auto-voided in both modes (codex #3591 r49 local P0).
    const paidSibling = { id: 'inv-other', status: 'paid', paid_at: '2026-08-30', payment_recorded_at: null, stripe_payment_intent_id: null };
    await expect(InvoiceService.retireRodentSetupObligationForReinstatedInvoice(
      revConn({ stamp: null, claimRow: null, siblings: [{ id: 'claim-x', invoice_id: 'inv-other' }], siblingInvoice: paidSibling }), 'inv-completion', { strict: true },
    )).rejects.toThrow(/already collected/);
    const unpaidSibling = { id: 'inv-other', status: 'sent', paid_at: null, payment_recorded_at: null, stripe_payment_intent_id: null };
    const autoVoid = revConn({ stamp: null, claimRow: null, siblings: [{ id: 'claim-x', invoice_id: 'inv-other' }], siblingInvoice: unpaidSibling });
    expect(await InvoiceService.retireRodentSetupObligationForReinstatedInvoice(autoVoid, 'inv-completion')).toMatchObject({ retired: false });
    expect(autoVoid.writes.some((w) => w.table === 'invoices' && w.patch?.status === 'void')).toBe(true);
    expect(autoVoid.writes.some((w) => w.table === 'setup_fee_claims' && w.op === 'delete')).toBe(true);
    const paged = revConn({ stamp: null, claimRow: null, siblings: [{ id: 'claim-x', invoice_id: 'inv-other' }], siblingInvoice: paidSibling });
    expect(await InvoiceService.retireRodentSetupObligationForReinstatedInvoice(paged, 'inv-completion')).toMatchObject({ retired: false });
    expect(paged.writes.filter((w) => w.table === 'invoices')).toEqual([]);
  });

  test('revival voids an untouched DRAFT completion setup invoice on the same anchor and consumes its claim', async () => {
    mockQualifyingKeys = async () => ['rodent_bait'];
    const prepayRow = { id: 'inv-prepay', customer_id: 'cust-1', scheduled_service_id: null, line_items: [{ description: 'Bait Station Setup — one-time setup fee', amount: 99 }] };
    const writes = [];
    const trx = (table) => {
      const q = { _where: null };
      q.where = (w) => { if (typeof w === 'function') { w.call(q); return q; } q._where = { ...(q._where || {}), ...(typeof w === 'object' ? w : {}) }; return q; };
      q.whereNot = () => q; q.orWhere = () => q; q.whereNull = () => q; q.forUpdate = () => q; q.whereNotIn = () => q; q.whereIn = () => q; q.orderBy = () => q; q.orWhereNotNull = () => q;
      q.first = async () => {
        if (table === 'invoices') return q._where && q._where.id === 'inv-comp-draft'
          ? { id: 'inv-comp-draft', status: 'draft', sent_at: null, paid_at: null, payment_recorded_at: null, stripe_payment_intent_id: null }
          : prepayRow;
        if (table === 'scheduled_services') return { id: 'root-rb', pending_setup_fee: null };
        if (table === 'knex_migrations') return { migration_time: '2026-08-29T18:30:00.000Z' };
        return null;
      };
      q.select = async () => {
        if (table === 'setup_fee_claims') return [{ id: 'claim-comp', invoice_id: 'inv-comp-draft' }];
        if (table === 'scheduled_services') return [{ ...rodentRoot, customer_id: 'cust-1', source_estimate_id: null, created_at: '2026-09-01T12:00:00.000Z', status: 'confirmed' }];
        return [];
      };
      q.update = async (patch) => { writes.push({ table, op: 'update', where: q._where, patch }); return 1; };
      q.delete = async () => { writes.push({ table, op: 'delete', where: q._where }); return 1; };
      q.insert = (row) => { writes.push({ table, op: 'insert', row }); const p = Promise.resolve([{}]); p.onConflict = () => ({ ignore: async () => 1 }); return p; };
      return q;
    };
    trx.writes = writes;
    const out = await InvoiceService.retireRodentSetupObligationForRevivedPrepay(trx, 'inv-prepay');
    expect(out).toMatchObject({ scheduledServiceId: 'root-rb', amount: 99 });
    expect(writes.some((w) => w.table === 'invoices' && w.op === 'update' && w.patch.status === 'void')).toBe(true);
    expect(writes.some((w) => w.table === 'setup_fee_claims' && w.op === 'delete' && w.where.id === 'claim-comp')).toBe(true);
  });
});

describe('r50 — statement anchors, guarded-void claim preservation, collected-prepay enforcement (codex #3591 r50 P1)', () => {
  test('a payer-statement-accrued duplicate is money-anchored (paged, never direct-voided); a lost guarded void keeps the claim', async () => {
    const invoiceSrc = fs.readFileSync(path.join(__dirname, '..', 'services', 'invoice.js'), 'utf8');
    // Every duplicate read selects payer_statement_id and every moneyAttached check consults it.
    expect((invoiceSrc.match(/payer_statement_id/g) || []).length).toBeGreaterThanOrEqual(6);
    // Claim deletes are gated on the guarded void's affected-row count.
    expect((invoiceSrc.match(/sibVoided === 1/g) || []).length).toBe(2); // revival + reinstate
    expect(invoiceSrc).toMatch(/const sibVoided = await conn\("invoices"\)/);
    expect(invoiceSrc).toMatch(/gained a payment anchor mid-void/);
  });

  test('the recorded-collected prepay route derives, 409s, re-derives in-trx, ledgers, and carves the setup out of the coverage basis (source contract)', () => {
    const customersSrc = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin-customers.js'), 'utf8');
    const routeAt = customersSrc.indexOf("router.post('/:id/annual-prepay', requireAdmin");
    expect(routeAt).toBeGreaterThan(-1);
    const deriveAt = customersSrc.indexOf('.findDirectRodentSetupObligationForCoverage(db, { customerId: customer.id, coverageServiceType })', routeAt);
    const trxAt = customersSrc.indexOf('await db.transaction(async (trx) => {', routeAt);
    const guardAt = customersSrc.indexOf('.findDirectRodentSetupObligationForCoverage(trx, { customerId: customer.id, coverageServiceType })', trxAt);
    const ledgerAt = customersSrc.indexOf('retireCoverageOnlySetupClaim(trx, {', trxAt);
    const carveAt = customersSrc.indexOf('collectedSetupShare', trxAt);
    expect(deriveAt).toBeGreaterThan(routeAt);
    expect(deriveAt).toBeLessThan(trxAt);
    expect(guardAt).toBeGreaterThan(trxAt);
    expect(ledgerAt).toBeGreaterThan(trxAt);
    expect(carveAt).toBeGreaterThan(trxAt);
    expect(customersSrc.slice(routeAt, trxAt)).toMatch(/setupFeeRequired: true/);
  });
});

describe('r51 local audit — ambiguous multi-series anchors stay untouched (codex #3591 r51 local P0)', () => {
  test('a customer with TWO rodent roots: the fallback resolves NO anchor (reversal pages, revival re-ledgers anchor-less)', async () => {
    mockQualifyingKeys = async () => ['rodent_bait'];
    const twoRoots = [
      { id: 'root-a', service_type: 'Rodent Bait Stations', service_id: null, recurring_parent_id: null },
      { id: 'root-b', service_type: 'Rodent Bait Stations', service_id: null, recurring_parent_id: null },
    ];
    const reversal = conn({ rootsForCoverage: twoRoots, claim: null, scheduledService: { id: 'x', status: 'confirmed' } });
    expect(await InvoiceService.restoreRodentSetupObligationForReversedInvoice(reversal, {
      id: 'inv-std', customer_id: 'cust-1', scheduled_service_id: null,
      line_items: [{ description: 'Bait Station Setup — one-time setup fee', amount: 99 }],
    })).toBeNull();
    expect(reversal.writes.filter((w) => w.table === 'scheduled_services')).toEqual([]);
  });
});

describe('r54 local audit — the street-scoped preview endpoint rides the canonical evidence resolver (codex #3591 r54 local P1)', () => {
  test('?street= routes through resolveCustomerQualifyingEvidence (normalized comparison), account-wide otherwise (source contract)', () => {
    const customersSrc = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin-customers.js'), 'utf8');
    const routeAt = customersSrc.indexOf("router.get('/:id/waveguard-qualifying-services'");
    const section = customersSrc.slice(routeAt, routeAt + 2000);
    expect(section).toMatch(/resolveCustomerQualifyingEvidence\(db, \{/);
    expect(section).toMatch(/address: street,/);
    expect(section).toMatch(/evidence\?\.tierKeys/);
    expect(section).not.toMatch(/streetScope = \{ estimateStreet: street/);
  });
});
