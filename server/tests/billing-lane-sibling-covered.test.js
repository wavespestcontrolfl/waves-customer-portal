/**
 * Sibling-covered first-application prediction — a per-application accept
 * that combines two recurring programs into ONE same-day slot invoices the
 * RESERVED program's row for the combined total and leaves the PROMOTED
 * program's row deliberately unpriced (estimate-converter.js
 * reservedAcceptPerVisitSplit). closeout-status.js reads this shape as
 * `sibling_first_application`.
 *
 * Prod 2026-09-26: a per-application Silver customer accepted lawn
 * ($56.40/app) + quarterly pest ($97.20/app) into ONE reserved slot. The
 * pest row's invoice ($153.60) covered the trip; the lawn row was left
 * unpriced on purpose. The schedule sheet showed the lawn visit's price as
 * $74.70 (the annual/12 equivalent of monthlyRate — meaningless here) and
 * warned "nothing will bill", both wrong. These pin
 * siblingCoveredCompletionPrediction reusing the SAME sibling-invoice
 * lookup completion uses, so the sheet can never contradict it.
 */

jest.mock('../services/estimate-first-application-invoice', () => ({
  findFirstApplicationInvoiceForEstimateService: jest.fn(),
}));

const { findFirstApplicationInvoiceForEstimateService } = require('../services/estimate-first-application-invoice');
const { siblingCoveredCompletionPrediction, siblingInvoiceCoverageVerdict, coveringSiblingInvoice } = require('../services/billing-lane');

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

describe('siblingCoveredCompletionPrediction', () => {
  test('reads the reserved sibling invoice as covering the unpriced promoted visit, with a reconciled breakdown', async () => {
    findFirstApplicationInvoiceForEstimateService.mockResolvedValue({
      invoice: {
        id: 'inv-1',
        scheduled_service_id: 'svc-pest',
        invoice_number: 'WPC-2026-0505',
        status: 'sent',
        total: 153.6,
      },
      liveBeside: null,
    });
    const dbConn = fakeDbConn({
      byId: { 'svc-pest': { id: 'svc-pest', service_type: 'Quarterly Pest Control' } },
      members: [PEST_ROW, LAWN_ROW],
    });

    const prediction = await siblingCoveredCompletionPrediction({ svc: LAWN_SVC, dbConn });

    expect(prediction).toMatchObject({
      kind: 'covered_sibling_invoice',
      amount: null,
      invoiceId: 'inv-1',
      invoiceNumber: 'WPC-2026-0505',
      invoiceStatus: 'sent',
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

  test('omits the breakdown when the anchored splits do not reconcile to the invoice total', async () => {
    findFirstApplicationInvoiceForEstimateService.mockResolvedValue({
      invoice: {
        id: 'inv-1', scheduled_service_id: 'svc-pest', invoice_number: 'WPC-2026-0505', status: 'sent', total: 200,
      },
      liveBeside: null,
    });
    const dbConn = fakeDbConn({
      byId: { 'svc-pest': { id: 'svc-pest', service_type: 'Quarterly Pest Control' } },
      members: [PEST_ROW, LAWN_ROW], // sums to 153.60, not 200
    });

    const prediction = await siblingCoveredCompletionPrediction({ svc: LAWN_SVC, dbConn });
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

    const prediction = await siblingCoveredCompletionPrediction({ svc: LAWN_SVC, dbConn });
    expect(prediction).toBeNull();
  });

  test('does not read a refunded sibling invoice as covered — that stays a manual-billing alert', async () => {
    findFirstApplicationInvoiceForEstimateService.mockResolvedValue({
      invoice: { id: 'inv-1', scheduled_service_id: 'svc-pest', invoice_number: 'WPC-2026-0505', status: 'refunded', total: 153.6 },
      liveBeside: null,
    });
    const dbConn = fakeDbConn({ byId: { 'svc-pest': { id: 'svc-pest', service_type: 'Quarterly Pest Control' } } });

    const prediction = await siblingCoveredCompletionPrediction({ svc: LAWN_SVC, dbConn });
    expect(prediction).toBeNull();
  });

  test('never covers a visit against its OWN invoice (not a sibling)', async () => {
    findFirstApplicationInvoiceForEstimateService.mockResolvedValue({
      invoice: { id: 'inv-1', scheduled_service_id: LAWN_SVC.id, invoice_number: 'WPC-2026-0505', status: 'sent', total: 56.4 },
      liveBeside: null,
    });
    const dbConn = fakeDbConn();

    const prediction = await siblingCoveredCompletionPrediction({ svc: LAWN_SVC, dbConn });
    expect(prediction).toBeNull();
  });

  test('fails toward null (never a false "covered") when there is no source estimate', async () => {
    const prediction = await siblingCoveredCompletionPrediction({ svc: { ...LAWN_SVC, source_estimate_id: null }, dbConn: fakeDbConn() });
    expect(prediction).toBeNull();
    expect(findFirstApplicationInvoiceForEstimateService).not.toHaveBeenCalled();
  });

  test('fails toward null when the shared lookup throws', async () => {
    findFirstApplicationInvoiceForEstimateService.mockRejectedValue(new Error('db down'));
    const prediction = await siblingCoveredCompletionPrediction({ svc: LAWN_SVC, dbConn: fakeDbConn() });
    expect(prediction).toBeNull();
  });
});

// Codex pre-push P0 (x2): a MINT decision (resolveScheduledServiceCharge,
// admin-schedule.js) must tell "definitely no relevant sibling invoice"
// apart from "a lookup failure" and "a terminal/refunded match" — both of
// which completion's own mint refuses to remint over. siblingCoveredCompletionPrediction's
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

  test('error — the shared lookup throws', async () => {
    findFirstApplicationInvoiceForEstimateService.mockRejectedValue(new Error('db down'));
    expect(await siblingInvoiceCoverageVerdict(LAWN_SVC, {})).toEqual({ status: 'error' });
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
