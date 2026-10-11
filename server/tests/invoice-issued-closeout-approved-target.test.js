/**
 * The Intelligence Bar send carries the visit its card said the send's closeout would complete.
 * The closeout runs only for that visit: a different live visit is left open and audited as
 * approved_target_mismatch. The send writes that target on the invoice inside its claim, and the
 * daily retry sweep keeps to it. A send with no approved target (the Invoices page) is unchanged.
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
const { closeOutVisitForIssuedInvoice, retryIssuedInvoiceCloseouts, recordApprovedCloseoutTarget } = require('../services/invoice-issued-closeout');

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
    expect(out).toMatchObject({ closed: false, reason: 'approved_target_mismatch', visitId: 'visit-live', approvedTarget, audited: true });
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

// The retry sweep: a conn whose candidate query answers one delivered invoice, whose pin read answers `pin`
// (a metadata object, or none) and whose invoice read carries the delivery stamp.
const SENT_AT = '2021-03-01T15:00:00Z';
function sweepConn({ pin = null, sentAt = SENT_AT, pinReadFails = false } = {}) {
  const invoice = { id: 'inv-1', invoice_number: 'WPC-2099-0001', status: 'sent', scheduled_service_id: 'visit-live', sent_at: sentAt };
  const candidate = { invoice_id: 'inv-1', invoice_status: 'sent', visit_id: 'visit-live', visit_status: 'pending', own_attempt_parked: false, issued_after_service_day: true };
  const connFor = (table) => {
    const state = { pinRead: false };
    const b = new Proxy({}, {
      get: (_t, prop) => {
        if (prop === 'then') return (res, rej) => Promise.resolve(table === 'invoices as i' ? [candidate] : null).then(res, rej);
        if (prop === 'where') return (arg) => { if (arg && arg.resource_type === 'invoices') state.pinRead = true; return b; };
        if (prop === 'first') {
          return async () => {
            if (table === 'audit_log' && state.pinRead && pinReadFails) throw new Error('read failed');
            if (table === 'audit_log') return state.pinRead && pin ? { metadata: pin } : null;
            if (table === 'invoices') return invoice;
            return rows[table] || null;
          };
        }
        return () => b;
      },
    });
    return b;
  };
  connFor.raw = (sql) => sql;
  return connFor;
}
const sweep = (opts) => retryIssuedInvoiceCloseouts({ conn: sweepConn(opts), today: '2099-01-01' });

describe('the retry sweep keeps to the target the bar send pinned', () => {
  test('a send that pinned "none" delivered, and the visit became eligible later: the sweep does not close it', async () => {
    const out = await sweep({ pin: { approvedTarget: 'none', priorDeliveredAtMs: null } });
    expect(out).toMatchObject({ retried: 1, closed: 0 });
    expect(completeScheduledService).not.toHaveBeenCalled();
    expect(recordAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      action: 'visit.completion_on_invoice_issued_refused', metadata: expect.objectContaining({ code: 'approved_target_mismatch' }),
    }));
  });

  test('the visit the card approved still closes', async () => {
    const out = await sweep({ pin: { approvedTarget: 'visit-live', priorDeliveredAtMs: null } });
    expect(out).toMatchObject({ retried: 1, closed: 1 });
    expect(completeScheduledService).toHaveBeenCalledTimes(1);
  });

  test('an invoice with no pin is retried as before', async () => {
    await expect(sweep()).resolves.toMatchObject({ retried: 1, closed: 1 });
  });

  test('a pin from a claim that delivered nothing is ignored (the delivery stamps did not move past it)', async () => {
    const stamp = new Date(SENT_AT).getTime();
    await expect(sweep({ pin: { approvedTarget: 'none', priorDeliveredAtMs: stamp } })).resolves.toMatchObject({ retried: 1, closed: 1 });
  });

  test('a pin that cannot be read skips the invoice; the next pass reads it again', async () => {
    await expect(sweep({ pinReadFails: true })).resolves.toMatchObject({ retried: 0, closed: 0 });
    expect(completeScheduledService).not.toHaveBeenCalled();
  });
});

describe('recordApprovedCloseoutTarget', () => {
  test('writes the pin as an audit row on the invoice, inside the caller\'s handle, with the delivery stamp the claim saw', async () => {
    const trx = jest.fn();
    await recordApprovedCloseoutTarget('inv-1', 'visit-live', { conn: trx, priorInvoice: { sent_at: SENT_AT, sms_sent_at: null, email_sent_at: null } });
    expect(recordAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      action: 'invoice.send_closeout_target_approved', resource_type: 'invoices', resource_id: 'inv-1', critical: true, trx,
      metadata: { invoiceId: 'inv-1', approvedTarget: 'visit-live', priorDeliveredAtMs: new Date(SENT_AT).getTime() },
    }));
  });
});
