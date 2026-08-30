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
function conn({ scheduledService = null, claim = null, updateResult = 1, rootsForCoverage = null, catalog = null, liveVisitProbe = undefined } = {}) {
  if (liveVisitProbe === undefined) liveVisitProbe = scheduledService;
  const writes = [];
  const trx = (table) => {
    const q = { _where: null };
    q.where = (w) => { if (typeof w === 'function') { w.call(q); return q; } q._where = w; return q; };
    q.orWhereNotNull = () => q;
    q.whereNull = (col) => { q._whereNull = col; return q; };
    q.forUpdate = () => q;
    q.first = async () => {
      if (table === 'scheduled_services') return q._whereIn ? liveVisitProbe : scheduledService;
      if (table === 'setup_fee_claims') return claim;
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
      // A failed re-bill mint keeps the record for a human.
      createSpy.mockRejectedValueOnce(new Error('mint down'));
      const failed = conn({ claim, scheduledService: doneParent, liveVisitProbe: null });
      expect(await InvoiceService.restoreRetiredSetupFeeClaimForPrepay('inv-prepay', failed)).toBeNull();
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
  const converter = fs.readFileSync(path.join(__dirname, '..', 'services', 'estimate-converter.js'), 'utf8');
  const invoice = fs.readFileSync(path.join(__dirname, '..', 'services', 'invoice.js'), 'utf8');

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
    expect((renewals.match(/restoreRetiredSetupFeeClaimForPrepay\([a-z]+\.prepay_invoice_id, conn, \{ sourceEstimateId: [a-z]+\.source_estimate_id \|\| null, customerId: [a-z]+\.customer_id \|\| null, coverageServiceType: [a-z]+\.coverage_service_type \|\| null \}\)/g) || []).length).toBe(2);
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
    const CALL_RE = /restoreRetiredSetupFeeClaimForPrepay\((updated|decided)\.prepay_invoice_id, conn, \{ sourceEstimateId: \1\.source_estimate_id \|\| null, customerId: \1\.customer_id \|\| null, coverageServiceType: \1\.coverage_service_type \|\| null \}\)/g;
    const calls = [...renewals.matchAll(CALL_RE)].map((m) => m[1]);
    expect(calls.sort()).toEqual(['decided', 'updated']);
    for (const who of ['updated', 'decided']) {
      const superseded = renewals.indexOf(`restoreSwitchSupersededInvoicesForPrepay(${who}.prepay_invoice_id, conn)`);
      const claim = renewals.indexOf(`restoreRetiredSetupFeeClaimForPrepay(${who}.prepay_invoice_id, conn, { sourceEstimateId: ${who}.source_estimate_id || null, customerId: ${who}.customer_id || null, coverageServiceType: ${who}.coverage_service_type || null })`);
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
    const prepay = conn({ rootsForCoverage: [rodentRoot], claim: { id: 'claim-1' } });
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
    expect(draft.writes).toEqual([
      expect.objectContaining({ table: 'setup_fee_claims', op: 'insert' }),
      expect.objectContaining({ table: 'invoices', op: 'update', where: { id: 'inv-rebill', status: 'draft' }, patch: expect.objectContaining({ status: 'void' }) }),
    ]);
    expect(marker).toBe('[rodent-setup-rebill:inv-prepay]');
    const sent = revivalConn({ stamp: null, rebills: [{ id: 'inv-rebill', status: 'sent', sent_at: '2026-08-30', paid_at: null, payment_recorded_at: null, stripe_payment_intent_id: null }] });
    expect(await InvoiceService.retireRodentSetupObligationForRevivedPrepay(sent, 'inv-prepay')).toMatchObject({ retired: false });
    expect(sent.writes.filter((w) => w.table === 'invoices')).toEqual([]);
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
    expect((renewals.match(/retireRodentSetupObligationForRevivedPrepay\(conn, invoice\.id\)/g) || []).length).toBe(2);
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
