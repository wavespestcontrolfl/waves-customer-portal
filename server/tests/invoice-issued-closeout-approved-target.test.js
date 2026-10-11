/**
 * The Intelligence Bar charge carries the visit its card said the paid-invoice closeout would
 * complete (PaymentIntent metadata approved_closeout_target). The closeout runs only for that
 * visit: a different live visit is left open, audited as approved_target_mismatch, and the
 * webhook rings an admin bell. A payment with no approved target (the Invoices page) is unchanged.
 * Synthetic ids only.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => true) }));
jest.mock('../services/audit-log', () => ({ recordAuditEvent: jest.fn(async () => true) }));
jest.mock('../services/scheduled-invoice-mint', () => ({ assertScheduledInvoiceNotPacketOwned: jest.fn(async () => {}) }));
jest.mock('../services/service-completion-profiles', () => ({ resolveCompletionProfileForScheduledService: jest.fn(async () => ({})) }));
jest.mock('../services/complete-scheduled-service', () => ({
  completeScheduledService: jest.fn(async () => ({ status: 200, body: { success: true } })),
}));

const fs = require('fs');
const path = require('path');
const { recordAuditEvent } = require('../services/audit-log');
const { completeScheduledService } = require('../services/complete-scheduled-service');
const { closeOutVisitForIssuedInvoice } = require('../services/invoice-issued-closeout');

const rows = {
  invoices: { id: 'inv-1', invoice_number: 'WPC-2099-0001', status: 'paid', scheduled_service_id: 'visit-live', paid_at: '2021-03-01T15:00:00Z' },
  scheduled_services: { id: 'visit-live', status: 'pending', scheduled_date: '2020-01-01' },
};
// A conn whose every read answers the one seeded row for its table (none for any other table).
const conn = (table) => {
  const b = new Proxy({}, {
    get: (_t, prop) => {
      if (prop === 'then') return (res, rej) => Promise.resolve(null).then(res, rej);
      if (prop === 'first') return async () => rows[table] || null;
      return () => b;
    },
  });
  return b;
};
const run = (extra = {}) => closeOutVisitForIssuedInvoice({ invoiceId: 'inv-1', trigger: 'paid', conn, today: '2099-01-01', ...extra });

beforeEach(() => jest.clearAllMocks());

describe('closeOutVisitForIssuedInvoice with an approved target', () => {
  test('a payment with no approved target closes the linked visit as before', async () => {
    await expect(run()).resolves.toMatchObject({ closed: true, visitId: 'visit-live' });
    expect(completeScheduledService).toHaveBeenCalledTimes(1);
  });

  test('the approved visit is the live one: it closes', async () => {
    await expect(run({ approvedTarget: 'visit-live' })).resolves.toMatchObject({ closed: true, visitId: 'visit-live' });
    expect(completeScheduledService).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['another visit was approved', 'visit-other'],
    ['the card said no visit would close', 'none'],
  ])('%s: the live visit stays open, the refusal is audited as approved_target_mismatch, nothing is completed', async (_label, approvedTarget) => {
    const out = await run({ approvedTarget });
    expect(out).toMatchObject({ closed: false, reason: 'approved_target_mismatch', visitId: 'visit-live', approvedTarget, invoiceId: 'inv-1', audited: true });
    expect(completeScheduledService).not.toHaveBeenCalled();
    expect(recordAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      action: 'visit.completion_on_invoice_issued_refused', resource_id: 'visit-live',
      metadata: expect.objectContaining({ code: 'approved_target_mismatch', invoiceId: 'inv-1' }),
    }));
  });

  test('the retry sweeps leave a mismatch alone (a person decides): the code is not a transient refusal', () => {
    const source = fs.readFileSync(path.join(__dirname, '../services/invoice-issued-closeout.js'), 'utf8');
    const transient = source.slice(source.indexOf('function isTransientRefusal'), source.indexOf('}', source.indexOf('function isTransientRefusal')));
    expect(transient).not.toMatch(/approved_target/);
    expect(transient).toMatch(/code\.startsWith\('visit_'\)/);
  });
});

describe('the payment_intent.succeeded handler', () => {
  const webhook = fs.readFileSync(path.join(__dirname, '../routes/stripe-webhook.js'), 'utf8');

  test('passes the PaymentIntent\'s approved target to the closeout and rings an admin bell on a mismatch', () => {
    expect(webhook).toMatch(/closeOutVisitAfterPaidInvoice\(piId, \{ approvedTarget: paymentIntent\.metadata\?\.approved_closeout_target \|\| null \}\)/);
    expect(webhook).toMatch(/closeOutVisitForIssuedInvoice\(\{ invoiceId: paid\.id, trigger: 'paid', approvedTarget \}\)/);
    expect(webhook).toMatch(/out\.reason === 'approved_target_mismatch'\) await bellApprovedTargetMismatch\(piId, out\)/);
    const bell = webhook.slice(webhook.indexOf('async function bellApprovedTargetMismatch'), webhook.indexOf('async function scheduleReviewAfterPaidInvoice'));
    expect(bell).toMatch(/triggerNotification\('internal_admin_alert'/);
    expect(bell).toMatch(/approved_target_mismatch for PI/);
  });

  test('a combined (multi-invoice) settlement carries no approved target, so it behaves as before', () => {
    expect(webhook).toMatch(/closeOutVisitAfterPaidInvoice\(piId, \{ invoiceId: settledId \}\)/);
  });
});
