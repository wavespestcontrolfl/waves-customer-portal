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
jest.mock('../services/annual-prepay-renewals', () => ({ syncTermForInvoicePayment: jest.fn(async () => undefined) }));
jest.mock('../routes/admin-customers', () => ({ _private: { lockAndAssertNoAnnualPrepayOverlap: jest.fn(async () => {}) } }));

const fs = require('fs');
const path = require('path');
const InvoiceService = require('../services/invoice');
const plans = require('../services/secure-appointment-plans');
const { retireDirectSetupClaimForPrepay, recordSetupFeeClaimForInvoice, retirePrepayOnBookSetupClaim } = plans;

// Minimal knex-shaped connection: per-table first()/update()/delete()
// answers, every write recorded.
function conn({ scheduledService = null, claim = null, updateResult = 1 } = {}) {
  const writes = [];
  const trx = (table) => {
    const q = { _where: null };
    q.where = (w) => { q._where = w; return q; };
    q.whereNull = (col) => { q._whereNull = col; return q; };
    q.first = async () => {
      if (table === 'scheduled_services') return scheduledService;
      if (table === 'setup_fee_claims') return claim;
      return null;
    };
    q.update = async (patch) => { writes.push({ table, op: 'update', where: q._where, whereNull: q._whereNull, patch }); return updateResult; };
    q.delete = async () => { writes.push({ table, op: 'delete', where: q._where }); return 1; };
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

  test('no fee / no anchor / no invoice → no-op', async () => {
    const trx = conn({ scheduledService: { id: 'svc-parent', pending_setup_fee: '99.00' } });
    expect(await retireDirectSetupClaimForPrepay(trx, { anchorId: 'svc-parent', invoiceId: 'inv-prepay', amount: 0 })).toEqual({ recorded: false, retired: false });
    expect(await retireDirectSetupClaimForPrepay(trx, { anchorId: null, invoiceId: 'inv-prepay', amount: 99 })).toEqual({ recorded: false, retired: false });
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

  test('an estimate-origin series restores nothing (its setup rode the accept invoice, not a stamp)', async () => {
    const c = conn({ claim, scheduledService: { id: 'svc-parent', source_estimate_id: 'est-1', pending_setup_fee: null } });
    expect(await InvoiceService.restoreRetiredSetupFeeClaimForPrepay('inv-prepay', c)).toBeNull();
    expect(c.writes).toEqual([]);
  });

  test('no record for the prepay (nothing was billed) / no prepay id → nothing happens', async () => {
    const c = conn({ claim: null, scheduledService: { id: 'svc-parent', source_estimate_id: null, pending_setup_fee: null } });
    expect(await InvoiceService.restoreRetiredSetupFeeClaimForPrepay('inv-prepay', c)).toBeNull();
    expect(await InvoiceService.restoreRetiredSetupFeeClaimForPrepay(null, c)).toBeNull();
    expect(c.writes).toEqual([]);
  });
});

describe('source contracts — where the lifecycle is wired', () => {
  const renewals = fs.readFileSync(path.join(__dirname, '..', 'services', 'annual-prepay-renewals.js'), 'utf8');
  const schedule = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin-schedule.js'), 'utf8');

  test('BOTH term-cancel branches (true void/refund AND decided-lapse refund) restore the claim right after the superseded-invoice restore', () => {
    const calls = [...renewals.matchAll(/restoreRetiredSetupFeeClaimForPrepay\((updated|decided)\.prepay_invoice_id, conn\)/g)].map((m) => m[1]);
    expect(calls.sort()).toEqual(['decided', 'updated']);
    for (const who of ['updated', 'decided']) {
      const superseded = renewals.indexOf(`restoreSwitchSupersededInvoicesForPrepay(${who}.prepay_invoice_id, conn)`);
      const claim = renewals.indexOf(`restoreRetiredSetupFeeClaimForPrepay(${who}.prepay_invoice_id, conn)`);
      expect(superseded).toBeGreaterThan(-1);
      expect(claim).toBeGreaterThan(superseded);
    }
  });

  test('the Customer 360 mint requires the anchor whenever a setup is billed, runs the service step under its transaction, maps conflicts to 409, and never writes the ledger itself', () => {
    const customers = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin-customers.js'), 'utf8');
    expect(customers).toMatch(/if \(setupFeeAmount > 0 && !setupScheduledServiceId\) \{\s*\n\s*return res\.status\(400\)/);
    expect(customers).toMatch(/if \(setupFeeAmount > 0\) \{\s*\n\s*await require\('\.\.\/services\/secure-appointment-plans'\)\.retirePrepayOnBookSetupClaim\(trx, \{/);
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
