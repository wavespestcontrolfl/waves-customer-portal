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
const { closeOutVisitForIssuedInvoice, retryIssuedInvoiceCloseouts, recordApprovedCloseoutTarget, recordApprovedCloseoutDelivery } = require('../services/invoice-issued-closeout');

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

// The retry sweep: a conn whose candidate query answers one delivered invoice, whose audit reads answer the seeded pin
// rows (written under a claim token) and delivery rows (the claim token and the delivery stamp it left), and whose
// invoice read carries the invoice's current delivery stamp.
const SENT_AT = '2021-03-01T15:00:00Z';
const SENT_MS = new Date(SENT_AT).getTime();
const PIN = 'invoice.send_closeout_target_approved';
const DELIVERED = 'invoice.send_closeout_target_delivered';
const RETIRED = 'invoice.send_closeout_target_retired';
function sweepConn({ pins = [], deliveries = [], retired = [], sentAt = SENT_AT, pinReadFails = false } = {}) {
  const invoice = { id: 'inv-1', invoice_number: 'WPC-2099-0001', status: 'sent', scheduled_service_id: 'visit-live', sent_at: sentAt };
  const candidate = { invoice_id: 'inv-1', invoice_status: 'sent', visit_id: 'visit-live', visit_status: 'pending', own_attempt_parked: false, issued_after_service_day: true };
  const connFor = (table) => {
    const state = { action: null, token: null };
    const rowsOf = () => (state.action === DELIVERED ? deliveries : state.action === RETIRED ? retired.map((claimToken) => ({ claimToken })) : pins)
      .filter((row) => state.token === null || row.claimToken === state.token)
      .map((row) => ({ metadata: row }));
    const b = new Proxy({}, {
      get: (_t, prop) => {
        if (prop === 'then') return (res, rej) => Promise.resolve(table === 'invoices as i' ? [candidate] : table === 'audit_log' && state.action === DELIVERED ? rowsOf() : null).then(res, rej);
        if (prop === 'where') return (arg) => { if (arg && arg.resource_type === 'invoices') state.action = arg.action || null; return b; };
        if (prop === 'whereRaw') return (_sql, bindings) => { if (Array.isArray(bindings) && typeof bindings[0] === 'string') state.token = bindings[0]; return b; };
        if (prop === 'first') {
          return async () => {
            if (table === 'audit_log' && pinReadFails && state.action === PIN) throw new Error('read failed');
            if (table === 'audit_log') return [PIN, DELIVERED, RETIRED].includes(state.action) ? (rowsOf()[0] || null) : null;
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
const pin = (claimToken, approvedTarget) => ({ claimToken, approvedTarget });
const delivered = (claimToken, deliveredAtMs = SENT_MS) => ({ claimToken, deliveredAtMs });

describe('the retry sweep keeps to the target the bar send pinned (bound to the claim that delivered)', () => {
  test('a send that pinned "none" delivered, and the visit became eligible later: the sweep does not close it', async () => {
    const out = await sweep({ pins: [pin('claim-a', 'none')], deliveries: [delivered('claim-a')] });
    expect(out).toMatchObject({ retried: 1, closed: 0 });
    expect(completeScheduledService).not.toHaveBeenCalled();
    expect(recordAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      action: 'visit.completion_on_invoice_issued_refused', metadata: expect.objectContaining({ code: 'approved_target_mismatch' }),
    }));
  });

  test('the visit the card approved still closes', async () => {
    const out = await sweep({ pins: [pin('claim-a', 'visit-live')], deliveries: [delivered('claim-a')] });
    expect(out).toMatchObject({ retried: 1, closed: 1 });
    expect(completeScheduledService).toHaveBeenCalledTimes(1);
  });

  test('an invoice with no pin is retried as before', async () => {
    await expect(sweep()).resolves.toMatchObject({ retried: 1, closed: 1 });
  });

  test('a pin from a bar send whose claim was handed back (retired) is finished: a later page send is judged as always', async () => {
    const out = await sweep({ pins: [pin('claim-failed', 'none')], deliveries: [], retired: ['claim-failed'] });
    expect(out).toMatchObject({ retried: 1, closed: 1 });
    expect(completeScheduledService).toHaveBeenCalledTimes(1);
  });

  test('a pin with no delivery marker and no retirement is unbound: the sweep closes nothing and audits closeout_pin_unbound', async () => {
    const out = await sweep({ pins: [pin('claim-lost-marker', 'none')], deliveries: [] });
    expect(out).toMatchObject({ retried: 0, closed: 0 });
    expect(completeScheduledService).not.toHaveBeenCalled();
    expect(recordAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      action: 'invoice.closeout_pin_unbound', resource_type: 'invoices', resource_id: 'inv-1',
    }));
  });

  test('a pin whose delivery was replaced by a later send (the delivery stamp moved) is ignored', async () => {
    const out = await sweep({ pins: [pin('claim-a', 'none')], deliveries: [delivered('claim-a', SENT_MS - 86400000)] });
    expect(out).toMatchObject({ retried: 1, closed: 1 });
  });

  test('a failed bar send after a delivered one leaves the delivered send\'s pin in force (the newest pin is not the episode)', async () => {
    const out = await sweep({ pins: [pin('claim-failed', 'visit-live'), pin('claim-a', 'none')], deliveries: [delivered('claim-a')] });
    expect(out).toMatchObject({ retried: 1, closed: 0 });
    expect(completeScheduledService).not.toHaveBeenCalled();
  });

  test('a pin that cannot be read skips the invoice; the next pass reads it again', async () => {
    await expect(sweep({ pinReadFails: true, pins: [pin('claim-a', 'none')], deliveries: [delivered('claim-a')] })).resolves.toMatchObject({ retried: 0, closed: 0 });
    expect(completeScheduledService).not.toHaveBeenCalled();
  });
});

describe('the pin rows', () => {
  test('the pin is written inside the caller\'s handle with the claim token and names the confirming admin', async () => {
    const trx = jest.fn();
    await recordApprovedCloseoutTarget('inv-1', 'visit-live', { conn: trx, claimToken: 'claim-a', actorTechnicianId: 'admin-1' });
    expect(recordAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      action: PIN, resource_type: 'invoices', resource_id: 'inv-1', critical: true, trx, actor_type: 'admin', actor_id: 'admin-1',
      metadata: { invoiceId: 'inv-1', approvedTarget: 'visit-live', claimToken: 'claim-a' },
    }));
  });

  test('a delivered claim stamps its delivery row with the claim token and the invoice\'s newest delivery stamp', async () => {
    const stamped = jest.fn((table) => {
      const b = { where: () => b, first: async () => ({ sent_at: SENT_AT, sms_sent_at: '2021-03-01T15:00:05Z', email_sent_at: null }) };
      return b;
    });
    await recordApprovedCloseoutDelivery('inv-1', 'claim-a', { conn: stamped, actorTechnicianId: 'admin-1' });
    expect(recordAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      action: DELIVERED, resource_id: 'inv-1', critical: true, actor_id: 'admin-1',
      metadata: { invoiceId: 'inv-1', claimToken: 'claim-a', deliveredAtMs: SENT_MS + 5000 },
    }));
  });
});
