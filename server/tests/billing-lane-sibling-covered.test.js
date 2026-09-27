/**
 * Sibling-coverage schedule verdict — a per-application accept that combines
 * two recurring programs into ONE same-day slot invoices the RESERVED
 * program's row for the combined total and leaves the PROMOTED program's row
 * deliberately unpriced (estimate-converter.js reservedAcceptPerVisitSplit).
 * closeout-status.js reads this shape as `sibling_first_application`.
 *
 * Prod 2026-09-26: a per-application Silver customer accepted lawn
 * ($56.40/app) + quarterly pest ($97.20/app) into ONE reserved slot. The
 * pest row's invoice ($153.60) covered the trip; the lawn row was left
 * unpriced on purpose. The schedule sheet showed the lawn visit's price as
 * $74.70 (the annual/12 equivalent of monthlyRate — meaningless here) and
 * warned "nothing will bill", both wrong. These pin siblingCoverageForSchedule
 * reusing the SAME sibling-invoice lookup completion uses, so the sheet can
 * never contradict it.
 *
 * Owner decision (narrow + fail closed, after 8 Codex rounds): the server
 * computes ONE canonical verdict — { state, invoiceId, invoiceNumber,
 * amountDue, reason } — built ONLY from siblingInvoiceCoverageVerdict plus
 * invoice-helpers' own collectibility checks (invoiceWithdrawnFromCustomer,
 * payer ownership, credit-applied netting, terminal statuses). Every client
 * surface renders this verdict and nothing else.
 */

jest.mock('../services/estimate-first-application-invoice', () => ({
  findFirstApplicationInvoiceForEstimateService: jest.fn(),
}));

const { findFirstApplicationInvoiceForEstimateService } = require('../services/estimate-first-application-invoice');
const { siblingCoverageForSchedule, siblingInvoiceCoverageVerdict, coveringSiblingInvoice } = require('../services/billing-lane');

// Minimal knex-like stand-in: distinguishes the two 'scheduled_services'
// queries the function issues by their `where` shape — a lookup by id
// (the invoice's owning visit) vs. the same-day/estimate members scan.
function fakeDbConn({ byId = {}, members = [] } = {}) {
  return (table) => {
    if (table !== 'scheduled_services') throw new Error(`unexpected table: ${table}`);
    return {
      where(cond) {
        if (cond && cond.id !== undefined) {
          return { first: async () => byId[cond.id] || null };
        }
        return {
          whereNull: () => ({
            select: async () => members,
          }),
        };
      },
    };
  };
}

const PEST_ROW = {
  id: 'svc-pest',
  service_type: 'Quarterly Pest Control',
  estimated_price: 153.6,
  recurring_template_overrides: { anchored_split_per_visit: 97.2 },
};
const LAWN_ROW = {
  id: 'svc-lawn',
  service_type: 'Every 6 Weeks Lawn Care',
  estimated_price: null,
  recurring_template_overrides: { anchored_split_per_visit: 56.4 },
};

const LAWN_SVC = {
  id: 'svc-lawn',
  customer_id: 'cust-1',
  source_estimate_id: 'est-1',
  scheduled_date: '2026-09-27',
};

afterEach(() => {
  jest.clearAllMocks();
});

describe('siblingCoverageForSchedule', () => {
  test('reads the reserved sibling invoice as covering the unpriced promoted visit, with a reconciled breakdown', async () => {
    findFirstApplicationInvoiceForEstimateService.mockResolvedValue({
      invoice: {
        id: 'inv-1',
        scheduled_service_id: 'svc-pest',
        invoice_number: 'WPC-TEST-0001',
        status: 'sent',
        total: 153.6,
      },
      liveBeside: null,
    });
    const dbConn = fakeDbConn({
      byId: { 'svc-pest': { id: 'svc-pest', service_type: 'Quarterly Pest Control' } },
      members: [PEST_ROW, LAWN_ROW],
    });

    const { coverage, prediction } = await siblingCoverageForSchedule({ svc: LAWN_SVC, dbConn });

    expect(coverage).toEqual({
      state: 'collect_on_combined_invoice',
      invoiceId: 'inv-1',
      invoiceNumber: 'WPC-TEST-0001',
      amountDue: 153.6,
      reason: null,
    });
    expect(prediction).toMatchObject({
      kind: 'covered_sibling_invoice',
      amount: null,
      invoiceId: 'inv-1',
      invoiceNumber: 'WPC-TEST-0001',
      siblingServiceType: 'Quarterly Pest Control',
    });
    expect(prediction.breakdown).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ serviceType: 'Quarterly Pest Control', amount: 97.2 }),
        expect.objectContaining({ serviceType: 'Every 6 Weeks Lawn Care', amount: 56.4 }),
      ]),
    );
    expect(findFirstApplicationInvoiceForEstimateService).toHaveBeenCalledWith(LAWN_SVC, dbConn);
  });

  // Codex round-7 P1 (mechanism retained, verdict now server-side): the raw
  // invoice status alone told a consumer THAT a sibling invoice exists,
  // never whether it still needs collecting. `amountDue` (total minus
  // credit_applied — invoiceAmountDue, invoice-helpers.js) lets the state
  // machine tell staff exactly what's still owed on THAT invoice.
  test('amountDue nets any account credit already applied to the sibling invoice', async () => {
    findFirstApplicationInvoiceForEstimateService.mockResolvedValue({
      invoice: {
        id: 'inv-1', scheduled_service_id: 'svc-pest', invoice_number: 'WPC-TEST-0001',
        status: 'overdue', total: 153.6, credit_applied: 50,
      },
      liveBeside: null,
    });
    const dbConn = fakeDbConn({
      byId: { 'svc-pest': { id: 'svc-pest', service_type: 'Quarterly Pest Control' } },
    });

    const { coverage } = await siblingCoverageForSchedule({ svc: LAWN_SVC, dbConn });
    expect(coverage).toMatchObject({ state: 'collect_on_combined_invoice', amountDue: 103.6 });
  });

  // Round-8 P1: a credit-applied invoice fully covered (amountDue <= 0) is
  // settled — nothing left to collect — even though the raw status is still
  // an ordinarily-collectible one like 'sent'.
  test('a fully credit-covered sibling invoice (amountDue <= 0) reads settled, not collect', async () => {
    findFirstApplicationInvoiceForEstimateService.mockResolvedValue({
      invoice: {
        id: 'inv-1', scheduled_service_id: 'svc-pest', invoice_number: 'WPC-TEST-0001',
        status: 'sent', total: 153.6, credit_applied: 200,
      },
      liveBeside: null,
    });
    const dbConn = fakeDbConn({ byId: { 'svc-pest': { id: 'svc-pest', service_type: 'Quarterly Pest Control' } } });

    const { coverage } = await siblingCoverageForSchedule({ svc: LAWN_SVC, dbConn });
    expect(coverage).toEqual({ state: 'settled', invoiceId: 'inv-1', invoiceNumber: 'WPC-TEST-0001', amountDue: 0, reason: 'credit_applied' });
  });

  // Round-8 P1: a payer-owned or withdrawn-from-customer sibling invoice is
  // not collectible from THIS customer at all — the payment paths reject
  // those explicitly (invoiceWithdrawnFromCustomer, payer ownership,
  // invoice-helpers.js) — so it reads settled, never "collect on that
  // invoice," even while the invoice itself is still draft/sent.
  test('a payer-owned sibling invoice reads settled, never collectible from the homeowner', async () => {
    findFirstApplicationInvoiceForEstimateService.mockResolvedValue({
      invoice: {
        id: 'inv-1', scheduled_service_id: 'svc-pest', invoice_number: 'WPC-TEST-0001',
        status: 'sent', total: 153.6, payer_id: 'payer-1',
      },
      liveBeside: null,
    });
    const dbConn = fakeDbConn({ byId: { 'svc-pest': { id: 'svc-pest', service_type: 'Quarterly Pest Control' } } });

    const { coverage } = await siblingCoverageForSchedule({ svc: LAWN_SVC, dbConn });
    expect(coverage).toEqual({ state: 'settled', invoiceId: 'inv-1', invoiceNumber: 'WPC-TEST-0001', amountDue: 0, reason: 'payer_billed' });
  });

  test('a sibling invoice withdrawn from the customer (payer_billed: stamp) reads settled', async () => {
    findFirstApplicationInvoiceForEstimateService.mockResolvedValue({
      invoice: {
        id: 'inv-1', scheduled_service_id: 'svc-pest', invoice_number: 'WPC-TEST-0001',
        status: 'sent', total: 153.6, scheduled_send_error: 'payer_billed:payer-1',
      },
      liveBeside: null,
    });
    const dbConn = fakeDbConn({ byId: { 'svc-pest': { id: 'svc-pest', service_type: 'Quarterly Pest Control' } } });

    const { coverage } = await siblingCoverageForSchedule({ svc: LAWN_SVC, dbConn });
    expect(coverage).toEqual({ state: 'settled', invoiceId: 'inv-1', invoiceNumber: 'WPC-TEST-0001', amountDue: 0, reason: 'withdrawn_from_customer' });
  });

  // A paid/prepaid/processing sibling invoice is settled — money already
  // collected or in flight — regardless of amountDue's raw value.
  test('a paid sibling invoice reads settled', async () => {
    findFirstApplicationInvoiceForEstimateService.mockResolvedValue({
      invoice: { id: 'inv-1', scheduled_service_id: 'svc-pest', invoice_number: 'WPC-TEST-0001', status: 'paid', total: 153.6 },
      liveBeside: null,
    });
    const dbConn = fakeDbConn({ byId: { 'svc-pest': { id: 'svc-pest', service_type: 'Quarterly Pest Control' } } });

    const { coverage } = await siblingCoverageForSchedule({ svc: LAWN_SVC, dbConn });
    expect(coverage).toEqual({ state: 'settled', invoiceId: 'inv-1', invoiceNumber: 'WPC-TEST-0001', amountDue: 0, reason: 'invoice_settled' });
  });

  test('omits the breakdown when the anchored splits do not reconcile to the invoice total', async () => {
    findFirstApplicationInvoiceForEstimateService.mockResolvedValue({
      invoice: {
        id: 'inv-1', scheduled_service_id: 'svc-pest', invoice_number: 'WPC-TEST-0001', status: 'sent', total: 200,
      },
      liveBeside: null,
    });
    const dbConn = fakeDbConn({
      byId: { 'svc-pest': { id: 'svc-pest', service_type: 'Quarterly Pest Control' } },
      members: [PEST_ROW, LAWN_ROW], // sums to 153.60, not 200
    });

    const { prediction } = await siblingCoverageForSchedule({ svc: LAWN_SVC, dbConn });
    expect(prediction.kind).toBe('covered_sibling_invoice');
    expect(prediction.breakdown).toBeUndefined();
  });

  // Mirrors the completion predicate exactly: findFirstApplicationInvoiceForEstimateService
  // itself scopes the match to the SAME scheduled_date as the visit passed in,
  // so an unpriced visit whose only source-estimate invoice belongs to a
  // DIFFERENT day's sibling correctly reads as "no match" — never covered.
  test('is not covered when the shared predicate finds no match (different-date sibling)', async () => {
    findFirstApplicationInvoiceForEstimateService.mockResolvedValue({ invoice: null, liveBeside: null });
    const dbConn = fakeDbConn();

    const { coverage, prediction } = await siblingCoverageForSchedule({ svc: LAWN_SVC, dbConn });
    expect(coverage.state).toBe('none');
    expect(prediction).toBeNull();
  });

  // Codex round 5 P2 (mechanism retained): a refunded/terminal match is NOT
  // collapsed to 'none' — resolveScheduledServiceCharge (the mint-side
  // resolver sharing this same lookup) always refuses this exact shape with
  // a 409, so leaving the naive positive prediction in place offered a
  // Charge button that could never succeed. A 'review' verdict tells staff
  // to go resolve it instead.
  test('surfaces a review verdict for a refunded sibling invoice — never a false "covered" or a stale positive amount', async () => {
    findFirstApplicationInvoiceForEstimateService.mockResolvedValue({
      invoice: { id: 'inv-1', scheduled_service_id: 'svc-pest', invoice_number: 'WPC-TEST-0001', status: 'refunded', total: 153.6 },
      liveBeside: null,
    });
    const dbConn = fakeDbConn({ byId: { 'svc-pest': { id: 'svc-pest', service_type: 'Quarterly Pest Control' } } });

    const { coverage, prediction } = await siblingCoverageForSchedule({ svc: LAWN_SVC, dbConn });
    expect(coverage).toEqual({ state: 'review', invoiceId: 'inv-1', invoiceNumber: 'WPC-TEST-0001', amountDue: null, reason: 'terminal_invoice' });
    expect(prediction).toEqual({
      kind: 'sibling_needs_review',
      amount: null,
      conflictStampedPrice: false,
      invoiceId: 'inv-1',
      invoiceNumber: 'WPC-TEST-0001',
    });
  });

  // Round-8 P2: this visit's OWN attached first-application invoice sitting
  // in a terminal state (refunded) also reads 'review' — the raw lookup
  // (siblingInvoiceCoverageVerdict) surfaces a terminal match regardless of
  // WHOSE row it sits on, before its own-visit exclusion, so no special case
  // is needed here for "own invoice, not a sibling's."
  test('surfaces a review verdict for THIS visit\'s own refunded attached invoice (not a sibling\'s)', async () => {
    findFirstApplicationInvoiceForEstimateService.mockResolvedValue({
      invoice: { id: 'inv-1', scheduled_service_id: LAWN_SVC.id, invoice_number: 'WPC-TEST-0001', status: 'refunded', total: 56.4 },
      liveBeside: null,
    });
    const dbConn = fakeDbConn();

    const { coverage, prediction } = await siblingCoverageForSchedule({ svc: LAWN_SVC, dbConn });
    expect(coverage.state).toBe('review');
    expect(prediction.kind).toBe('sibling_needs_review');
  });

  // Codex round 5 P2: the canceled-acceptance-invoice-with-setup-fee shape
  // (siblingInvoiceCoverageVerdict's `canceledSetupFee`) is also review with
  // NO invoice at all — must still surface the review verdict, not 'none',
  // and not throw on the missing invoice.
  test('surfaces a review verdict for a canceled acceptance invoice with no live replacement (no invoice on the verdict)', async () => {
    findFirstApplicationInvoiceForEstimateService.mockResolvedValue({
      invoice: null,
      liveBeside: null,
      canceledSetupFee: { id: 'inv-3', invoice_number: 'WPC-2026-0400', status: 'canceled' },
    });
    const dbConn = fakeDbConn();

    const { coverage, prediction } = await siblingCoverageForSchedule({ svc: LAWN_SVC, dbConn });
    expect(coverage).toEqual({ state: 'review', invoiceId: null, invoiceNumber: null, amountDue: null, reason: 'canceled_setup_fee' });
    expect(prediction).toEqual({
      kind: 'sibling_needs_review',
      amount: null,
      conflictStampedPrice: false,
      invoiceId: null,
      invoiceNumber: null,
    });
  });

  test('never covers a visit against its OWN live (non-terminal) invoice (not a sibling)', async () => {
    findFirstApplicationInvoiceForEstimateService.mockResolvedValue({
      invoice: { id: 'inv-1', scheduled_service_id: LAWN_SVC.id, invoice_number: 'WPC-TEST-0001', status: 'sent', total: 56.4 },
      liveBeside: null,
    });
    const dbConn = fakeDbConn();

    const { coverage, prediction } = await siblingCoverageForSchedule({ svc: LAWN_SVC, dbConn });
    expect(coverage.state).toBe('none');
    expect(prediction).toBeNull();
  });

  test('fails toward "none" (never a false "covered") when there is no source estimate', async () => {
    const { coverage, prediction } = await siblingCoverageForSchedule({ svc: { ...LAWN_SVC, source_estimate_id: null }, dbConn: fakeDbConn() });
    expect(coverage.state).toBe('none');
    expect(prediction).toBeNull();
    expect(findFirstApplicationInvoiceForEstimateService).not.toHaveBeenCalled();
  });

  // Codex round 5 P2 (mechanism retained): a lookup FAILURE is treated
  // exactly like needs_review/'review', not collapsed to 'none' —
  // resolveScheduledServiceCharge refuses to mint for it too, so the naive
  // positive prediction must not survive untouched here either.
  test('surfaces a review verdict (never "none") when the shared lookup throws', async () => {
    findFirstApplicationInvoiceForEstimateService.mockRejectedValue(new Error('db down'));
    const { coverage, prediction } = await siblingCoverageForSchedule({ svc: LAWN_SVC, dbConn: fakeDbConn() });
    expect(coverage).toEqual({ state: 'review', invoiceId: null, invoiceNumber: null, amountDue: null, reason: 'lookup_failed' });
    expect(prediction).toEqual({
      kind: 'sibling_needs_review',
      amount: null,
      conflictStampedPrice: false,
      invoiceId: null,
      invoiceNumber: null,
    });
  });
});

// Codex pre-push P0 (x2): a MINT decision (resolveScheduledServiceCharge,
// admin-schedule.js) must tell "definitely no relevant sibling invoice"
// apart from "a lookup failure" and "a terminal/refunded match" — both of
// which completion's own mint refuses to remint over. siblingCoverageForSchedule's
// display-safe wrapper (coveringSiblingInvoice) collapses all three
// non-covered cases to null on purpose (advisory, never toward a false
// "covered"); the verdict function underneath must NOT collapse them the
// same way, so a write caller can refuse instead of bill.
describe('siblingInvoiceCoverageVerdict', () => {
  test('covered — a live sibling invoice', async () => {
    findFirstApplicationInvoiceForEstimateService.mockResolvedValue({
      invoice: { id: 'inv-1', scheduled_service_id: 'svc-pest', status: 'sent', total: 153.6 },
      liveBeside: null,
    });
    expect(await siblingInvoiceCoverageVerdict(LAWN_SVC, {})).toEqual({
      status: 'covered',
      invoice: { id: 'inv-1', scheduled_service_id: 'svc-pest', status: 'sent', total: 153.6 },
    });
  });

  test('none — no match at all', async () => {
    findFirstApplicationInvoiceForEstimateService.mockResolvedValue({ invoice: null, liveBeside: null });
    expect(await siblingInvoiceCoverageVerdict(LAWN_SVC, {})).toEqual({ status: 'none' });
  });

  test('none — a match naming this visit\'s OWN row (not a sibling)', async () => {
    findFirstApplicationInvoiceForEstimateService.mockResolvedValue({
      invoice: { id: 'inv-1', scheduled_service_id: LAWN_SVC.id, status: 'sent', total: 56.4 },
      liveBeside: null,
    });
    expect(await siblingInvoiceCoverageVerdict(LAWN_SVC, {})).toEqual({ status: 'none' });
  });

  test('needs_review — a terminal/refunded match, carrying any live replacement as liveBeside', async () => {
    findFirstApplicationInvoiceForEstimateService.mockResolvedValue({
      invoice: { id: 'inv-1', scheduled_service_id: 'svc-pest', status: 'refunded', total: 153.6 },
      liveBeside: { id: 'inv-2', scheduled_service_id: 'svc-pest', status: 'sent', total: 153.6 },
    });
    expect(await siblingInvoiceCoverageVerdict(LAWN_SVC, {})).toEqual({
      status: 'needs_review',
      invoice: { id: 'inv-1', scheduled_service_id: 'svc-pest', status: 'refunded', total: 153.6 },
      liveBeside: { id: 'inv-2', scheduled_service_id: 'svc-pest', status: 'sent', total: 153.6 },
    });
  });

  // Codex round-2 P0: the shared lookup deliberately returns a refunded
  // match ahead of any live replacement REGARDLESS of whose row it sits
  // on (no reliable refund-event clock), with the live replacement riding
  // along as `liveBeside`. The own-visit check ("just my own row, not a
  // sibling") must NOT be evaluated before the terminal-status check — an
  // own-visit REFUNDED match discarded as "none" would also discard a
  // live SIBLING invoice riding beside it, letting a write caller mint
  // the acceptance fee for a trip that sibling's live invoice already
  // covers.
  test('needs_review — a REFUNDED match naming this visit\'s OWN row, with a live SIBLING invoice riding as liveBeside', async () => {
    findFirstApplicationInvoiceForEstimateService.mockResolvedValue({
      invoice: { id: 'inv-1', scheduled_service_id: LAWN_SVC.id, status: 'refunded', total: 56.4 },
      liveBeside: { id: 'inv-2', scheduled_service_id: 'svc-pest', status: 'sent', total: 153.6 },
    });
    expect(await siblingInvoiceCoverageVerdict(LAWN_SVC, {})).toEqual({
      status: 'needs_review',
      invoice: { id: 'inv-1', scheduled_service_id: LAWN_SVC.id, status: 'refunded', total: 56.4 },
      liveBeside: { id: 'inv-2', scheduled_service_id: 'svc-pest', status: 'sent', total: 153.6 },
    });
  });

  test('error — the shared lookup throws', async () => {
    findFirstApplicationInvoiceForEstimateService.mockRejectedValue(new Error('db down'));
    expect(await siblingInvoiceCoverageVerdict(LAWN_SVC, {})).toEqual({ status: 'error' });
  });

  // Codex round-6 P1 (pre-push): `noWait` rides through to the shared
  // lookup ONLY when the caller passes it (the schedule mint's own recheck,
  // which already holds the estimate.deposit.ledger lock and must fail
  // fast rather than block into a deadlock against
  // withInvoiceDepositSettlement's invoice-row-then-ledger-lock order). A
  // NOWAIT lock-busy failure is just another lookup failure here.
  test('passes lockRows/noWait through to the shared lookup exactly as given', async () => {
    findFirstApplicationInvoiceForEstimateService.mockResolvedValue({ invoice: null, liveBeside: null });
    const trx = {};
    await siblingInvoiceCoverageVerdict(LAWN_SVC, trx, { lockRows: true, noWait: true });
    expect(findFirstApplicationInvoiceForEstimateService).toHaveBeenCalledWith(
      LAWN_SVC, trx, { lockRows: true, noWait: true },
    );
  });

  test('a NOWAIT lock-busy failure reads as a plain lookup error, not a crash', async () => {
    const busy = new Error('could not obtain lock on row');
    busy.code = '55P03';
    findFirstApplicationInvoiceForEstimateService.mockRejectedValue(busy);
    expect(await siblingInvoiceCoverageVerdict(LAWN_SVC, {}, { lockRows: true, noWait: true }))
      .toEqual({ status: 'error' });
  });

  // Codex pre-push P0 (round 2): the lookup's null-invoice return is NOT
  // always "no relevant match" — it also carries canceledSetupFee when a
  // canceled acceptance invoice included the one-time setup fee with no
  // live replacement. Losing that here would let a write caller mint only
  // the per-visit/per-application charge and silently drop the fee
  // completion itself parks for manual billing instead.
  test('needs_review — a canceled acceptance invoice carrying the setup fee, with no live replacement', async () => {
    findFirstApplicationInvoiceForEstimateService.mockResolvedValue({
      invoice: null,
      liveBeside: null,
      canceledSetupFee: { id: 'inv-3', invoice_number: 'WPC-2026-0400', status: 'canceled' },
    });
    expect(await siblingInvoiceCoverageVerdict(LAWN_SVC, {})).toEqual({
      status: 'needs_review',
      invoice: null,
      canceledSetupFee: { id: 'inv-3', invoice_number: 'WPC-2026-0400', status: 'canceled' },
    });
  });

  test('none — a null invoice with no canceledSetupFee either', async () => {
    findFirstApplicationInvoiceForEstimateService.mockResolvedValue({ invoice: null, liveBeside: null });
    expect(await siblingInvoiceCoverageVerdict(LAWN_SVC, {})).toEqual({ status: 'none' });
  });

  test('coveringSiblingInvoice (the display-safe wrapper) still collapses needs_review/error to null', async () => {
    findFirstApplicationInvoiceForEstimateService.mockResolvedValue({
      invoice: { id: 'inv-1', scheduled_service_id: 'svc-pest', status: 'refunded', total: 153.6 },
      liveBeside: null,
    });
    expect(await coveringSiblingInvoice(LAWN_SVC, {})).toBeNull();
    findFirstApplicationInvoiceForEstimateService.mockRejectedValue(new Error('db down'));
    expect(await coveringSiblingInvoice(LAWN_SVC, {})).toBeNull();
  });
});
