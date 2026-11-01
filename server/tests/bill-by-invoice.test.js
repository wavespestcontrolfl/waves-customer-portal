/**
 * Bill by invoice (owner 2026-10-30, pipeline audit item 1, option A): a visit booked from a won commercial proposal
 * in invoice mode bills by invoice on the agreement's Net term, and Auto Pay never collects it, whatever the
 * customer's own Auto Pay enrollment says. Before this, the completion Auto Pay lanes charged it the day of the
 * visit, the Auto Pay hold kept its reminders off, and the sheets promised the charge.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const {
  billByInvoiceProposal, billByInvoiceEstimateIds, billByInvoiceVisit, billByInvoiceInvoice,
  wonAuthoredProposal, wonProposalInvoice,
} = require('../services/bill-by-invoice');
const {
  resolveExtendedLane, resolvePerApplicationCharge, billByInvoiceDemotedPrediction,
} = require('../services/completion-charge-verdict');

const AUTHORED_PROPOSAL = {
  enabled: true,
  title: 'Bayview Office Proposal',
  buildings: [{
    name: 'Main building',
    lineItems: [{ description: 'Quarterly pest', quantity: 1, unitPrice: 300, frequency: 'quarterly', taxable: true, amount: 300 }],
  }],
  commercialTerms: { paymentTerms: 'net30' },
};
const estimateRow = (extra = {}) => ({
  id: 'est-bbi', status: 'accepted', bill_by_invoice: true, estimate_data: { proposal: AUTHORED_PROPOSAL }, ...extra,
});

// A knex-style fake: where(object) filters rows by equality, whereIn(column, ids) by id, first/select resolve the
// matches. `fail` names a table whose read rejects. `calls` lists the tables actually read.
function fakeConn(tables = {}, { fail = null } = {}) {
  const calls = [];
  const conn = jest.fn((table) => {
    const filters = {};
    let ids = null;
    const rows = () => {
      calls.push(table);
      if (fail === table) return Promise.reject(new Error(`${table} read failed`));
      return Promise.resolve((tables[table] || []).filter((row) => (ids
        ? ids.includes(String(row.id))
        : Object.entries(filters).every(([key, value]) => String(row[key]) === String(value)))));
    };
    const q = {
      where(filter) { if (filter && typeof filter === 'object') Object.assign(filters, filter); return q; },
      whereIn(_column, values) { ids = values.map(String); return q; },
      whereNotIn() { return q; },
      first: () => rows().then((found) => found[0] || null),
      select: () => rows(),
    };
    return q;
  });
  conn.calls = calls;
  return conn;
}

describe('billByInvoiceProposal', () => {
  test('an accepted, authored proposal billed by invoice', () => {
    expect(billByInvoiceProposal(estimateRow())).toMatchObject({ enabled: true });
  });

  test('anything else is not', () => {
    for (const row of [
      estimateRow({ status: 'sent' }), estimateRow({ bill_by_invoice: false }), estimateRow({ bill_by_invoice: null }),
      estimateRow({ estimate_data: { recurring: { services: [] } } }), null, undefined,
    ]) {
      expect(billByInvoiceProposal(row)).toBeNull();
    }
  });
});

describe('billByInvoiceVisit / billByInvoiceInvoice / billByInvoiceEstimateIds', () => {
  const tables = {
    estimates: [estimateRow(), estimateRow({ id: 'est-card', bill_by_invoice: false })],
    scheduled_services: [{ id: 'ss-bbi', source_estimate_id: 'est-bbi' }, { id: 'ss-card', source_estimate_id: 'est-card' }],
    service_records: [{ id: 'sr-bbi', scheduled_service_id: 'ss-bbi' }],
    invoices: [{ id: 'inv-bbi', scheduled_service_id: 'ss-bbi', service_record_id: null }],
  };

  test('the visit row\'s own source_estimate_id decides; a row without the column is read by id', async () => {
    expect(await billByInvoiceVisit(fakeConn(tables), { id: 'ss-x', source_estimate_id: 'est-bbi' })).toBe(true);
    expect(await billByInvoiceVisit(fakeConn(tables), { id: 'ss-x', source_estimate_id: 'est-card' })).toBe(false);
    const conn = fakeConn(tables);
    expect(await billByInvoiceVisit(conn, { id: 'ss-bbi' })).toBe(true);
    expect(conn.calls).toEqual(['scheduled_services', 'estimates']);
  });

  test('a visit with no source estimate reads nothing', async () => {
    const conn = fakeConn(tables);
    expect(await billByInvoiceVisit(conn, { id: 'ss-x', source_estimate_id: null })).toBe(false);
    expect(conn.calls).toEqual([]);
  });

  test('an invoice bills its own visit, else its service record\'s; a bare id is read first', async () => {
    expect(await billByInvoiceInvoice(fakeConn(tables), { id: 'i', scheduled_service_id: 'ss-bbi', service_record_id: null })).toBe(true);
    expect(await billByInvoiceInvoice(fakeConn(tables), { id: 'i', scheduled_service_id: null, service_record_id: 'sr-bbi' })).toBe(true);
    expect(await billByInvoiceInvoice(fakeConn(tables), { id: 'inv-bbi' })).toBe(true);
    expect(await billByInvoiceInvoice(fakeConn(tables), { id: 'i', scheduled_service_id: 'ss-card', service_record_id: null })).toBe(false);
    expect(await billByInvoiceInvoice(fakeConn(tables), { id: 'i', scheduled_service_id: null, service_record_id: null })).toBe(false);
  });

  test('the batch read keeps only such proposals, one read for any number of ids', async () => {
    const conn = fakeConn(tables);
    expect(await billByInvoiceEstimateIds(conn, ['est-bbi', 'est-card', 'est-bbi', null])).toEqual(new Set(['est-bbi']));
    expect(conn.calls).toEqual(['estimates']);
  });

  test('a failed read throws (each caller picks its own direction)', async () => {
    await expect(billByInvoiceVisit(fakeConn(tables, { fail: 'estimates' }), { id: 'ss-bbi', source_estimate_id: 'est-bbi' }))
      .rejects.toThrow('estimates read failed');
  });
});

describe('wonAuthoredProposal / wonProposalInvoice: a won proposal in any billing mode', () => {
  const tables = {
    invoices: [{ id: 'inv-bare', scheduled_service_id: 'ss-card', service_record_id: null }],
    service_records: [{ id: 'rec-1', scheduled_service_id: 'ss-bbi' }],
    scheduled_services: [
      { id: 'ss-bbi', source_estimate_id: 'est-bbi' }, { id: 'ss-card', source_estimate_id: 'est-card' },
      { id: 'ss-open', source_estimate_id: 'est-open' }, { id: 'ss-none', source_estimate_id: null },
    ],
    estimates: [
      estimateRow(), estimateRow({ id: 'est-card', bill_by_invoice: false }), estimateRow({ id: 'est-open', status: 'sent' }),
    ],
  };

  test('accepted and authored, whatever the billing mode; never an open quote, a synthesized or a non-proposal estimate', () => {
    expect(wonAuthoredProposal(estimateRow())).toMatchObject({ enabled: true });
    expect(wonAuthoredProposal(estimateRow({ bill_by_invoice: false }))).toMatchObject({ enabled: true });
    expect(wonAuthoredProposal(estimateRow({ status: 'viewed' }))).toBeNull();
    expect(wonAuthoredProposal(estimateRow({ estimate_data: { proposal: { ...AUTHORED_PROPOSAL, synthesized: true } } }))).toBeNull();
    expect(wonAuthoredProposal(estimateRow({ estimate_data: { services: [] } }))).toBeNull();
    expect(wonAuthoredProposal(null)).toBeNull();
  });

  test('an invoice bills such a visit through its own visit, its service record, or a bare id read first', async () => {
    expect(await wonProposalInvoice(fakeConn(tables), { id: 'i', scheduled_service_id: 'ss-card', service_record_id: null })).toBe(true);
    expect(await wonProposalInvoice(fakeConn(tables), { id: 'i', scheduled_service_id: null, service_record_id: 'rec-1' })).toBe(true);
    expect(await wonProposalInvoice(fakeConn(tables), { id: 'inv-bare' })).toBe(true);
    expect(await wonProposalInvoice(fakeConn(tables), { id: 'i', scheduled_service_id: 'ss-open', service_record_id: null })).toBe(false);
    expect(await wonProposalInvoice(fakeConn(tables), { id: 'i', scheduled_service_id: 'ss-none', service_record_id: null })).toBe(false);
    expect(await wonProposalInvoice(fakeConn(tables), { id: 'i', scheduled_service_id: null, service_record_id: null })).toBe(false);
  });

  test('a failed read throws', async () => {
    await expect(wonProposalInvoice(fakeConn(tables, { fail: 'estimates' }), { id: 'i', scheduled_service_id: 'ss-bbi', service_record_id: null }))
      .rejects.toThrow('estimates read failed');
  });
});

describe('completion-charge-verdict: the Auto Pay lanes skip a Bill-by-invoice visit', () => {
  const gates = require('../config/feature-gates').gates;
  const before = gates.completionAutopayCharge;
  beforeEach(() => { gates.completionAutopayCharge = true; });
  afterAll(() => { gates.completionAutopayCharge = before; });

  const svcFrom = (sourceEstimateId) => ({
    id: 'ss-1', customer_id: 'c-1', source_estimate_id: sourceEstimateId, service_type: 'Commercial Pest Control',
    is_callback: false, estimated_price: 300, cust_monthly_rate: null, cust_billing_mode: null,
  });
  const invoice = { id: 'inv-1', subtotal: 300, total: 321, discount_amount: 0, payer_id: null };
  const tables = { estimates: [estimateRow(), estimateRow({ id: 'est-card', bill_by_invoice: false })] };
  const extended = (svc, conn, strict = false) => resolveExtendedLane({
    svc, invoice, alreadyPaid: false, visitPerformed: true, perApplicationBilling: false,
    apptCardOneTimeCharge: false, apptCardLaneUnresolved: false, customerAutopayActive: true, conn, strict,
  });

  test('extended lane: a card-paid commercial visit is still a candidate at its visit price', async () => {
    const lane = await extended(svcFrom('est-card'), fakeConn(tables));
    expect(lane).toMatchObject({ extendedChargeCandidate: true, extendedLaneAnchor: 300, extendedLaneOverCap: false });
  });

  test('extended lane: a Bill-by-invoice visit is not a candidate, so no anchor or cap is judged', async () => {
    const lane = await extended(svcFrom('est-bbi'), fakeConn(tables));
    expect(lane).toMatchObject({ extendedAutopayCharge: true, extendedChargeCandidate: false, extendedLaneAnchor: null });
  });

  test('extended lane: an unreadable agreement closes the lane; strict callers get the failure', async () => {
    const failing = () => fakeConn(tables, { fail: 'estimates' });
    expect((await extended(svcFrom('est-bbi'), failing())).extendedChargeCandidate).toBe(false);
    await expect(extended(svcFrom('est-bbi'), failing(), true)).rejects.toThrow('estimates read failed');
  });

  test('per-application lane: the billing mode, minus a Bill-by-invoice visit', async () => {
    expect(await resolvePerApplicationCharge({ svc: svcFrom('est-card'), perApplicationBilling: true, conn: fakeConn(tables) })).toBe(true);
    expect(await resolvePerApplicationCharge({ svc: svcFrom('est-bbi'), perApplicationBilling: true, conn: fakeConn(tables) })).toBe(false);
    const conn = fakeConn(tables);
    expect(await resolvePerApplicationCharge({ svc: svcFrom('est-bbi'), perApplicationBilling: false, conn })).toBe(false);
    expect(conn.calls).toEqual([]);
  });

  test('per-application lane: an unreadable agreement charges nothing; strict callers get the failure', async () => {
    const args = { svc: svcFrom('est-bbi'), perApplicationBilling: true };
    expect(await resolvePerApplicationCharge({ ...args, conn: fakeConn(tables, { fail: 'estimates' }) })).toBe(false);
    await expect(resolvePerApplicationCharge({ ...args, conn: fakeConn(tables, { fail: 'estimates' }), strict: true }))
      .rejects.toThrow('estimates read failed');
  });

  test('a sheet\'s promised charge reads as an invoice for a Bill-by-invoice visit, same amount', async () => {
    const promise = { kind: 'auto_charge', amount: 300, conflictStampedPrice: false };
    expect(await billByInvoiceDemotedPrediction(promise, svcFrom('est-bbi'), fakeConn(tables)))
      .toEqual({ kind: 'invoice', amount: 300, conflictStampedPrice: false });
    expect(await billByInvoiceDemotedPrediction(promise, svcFrom('est-card'), fakeConn(tables))).toBe(promise);
    expect(await billByInvoiceDemotedPrediction(promise, svcFrom('est-bbi'), fakeConn(tables, { fail: 'estimates' })))
      .toMatchObject({ kind: 'invoice' });
    const conn = fakeConn(tables);
    const invoiceKind = { kind: 'invoice', amount: 300 };
    expect(await billByInvoiceDemotedPrediction(invoiceKind, svcFrom('est-bbi'), conn)).toBe(invoiceKind);
    expect(await billByInvoiceDemotedPrediction(null, svcFrom('est-bbi'), conn)).toBeNull();
    expect(conn.calls).toEqual([]);
  });
});

describe('every Auto Pay rail asks it (source pins)', () => {
  const read = (rel) => require('fs').readFileSync(require('path').join(__dirname, rel), 'utf8');

  test('completion route: the per-application lane joins the charge only through resolvePerApplicationCharge', () => {
    const route = read('../services/complete-scheduled-service.js');
    expect(route).toContain('const perApplicationCharge = await resolvePerApplicationCharge({ svc, perApplicationBilling });');
    expect(route).not.toContain('(perApplicationBilling || apptCardOneTimeCharge || extendedChargeCandidate)');
    expect(route.match(/\(perApplicationCharge \|\| apptCardOneTimeCharge \|\| extendedChargeCandidate\)/g)).toHaveLength(2);
  });

  test('closeout-sheet charge, hold sweep verdict and card-expiry warning', () => {
    expect(read('../services/visit-completion-payment.js'))
      .toContain("&& !await require('./bill-by-invoice').billByInvoiceInvoice(database, invoice)) {");
    expect(read('../services/invoice-followups.js'))
      .toContain('const candidate = perApplicationCharge || appt.apptCardOneTimeCharge || ext.extendedChargeCandidate;');
    expect(read('../services/annual-prepay-renewals.js'))
      .toContain('&& await resolvePerApplicationCharge({ svc: svcLike, perApplicationBilling, conn, strict: true });');
  });

  test('the reminder ladder never holds such a bill for Auto Pay', () => {
    const followups = read('../services/invoice-followups.js');
    expect(followups).toContain("onAutopay = !await require('./bill-by-invoice').billByInvoiceInvoice(trx, invoice);");
    expect(followups).toContain("&& !await require('./bill-by-invoice').billByInvoiceInvoice(database, invoice);");
    expect(read('../services/visit-completion-packets.js'))
      .toContain("&& !await require('./bill-by-invoice').billByInvoiceInvoice(trx, { id: invoiceId })");
  });

  test('both schedule feeds and the closeout status show an invoice, never a promised charge', () => {
    expect(read('../routes/admin-schedule.js'))
      .toContain('billingLane.prediction = await billByInvoiceDemotedPrediction(billingLane.prediction, svc, db);');
    expect(read('../services/closeout-status.js'))
      .toContain("const shown = inputs.billByInvoice === true && prediction.kind === 'auto_charge' ? { ...prediction, kind: 'invoice' } : prediction;");
  });
});
