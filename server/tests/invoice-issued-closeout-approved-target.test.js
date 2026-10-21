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
const { closeOutVisitForIssuedInvoice, retryIssuedInvoiceCloseouts, recordApprovedCloseoutTarget, recordApprovedCloseoutDelivery, pinDecisionFor, approvedVisitChanged } = require('../services/invoice-issued-closeout');

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
const PAID_AT = '2021-03-02T16:30:00Z';
const PAID_TOKEN = `paid:${new Date(PAID_AT).getTime()}`;
const PIN = 'invoice.send_closeout_target_approved';
const DELIVERED = 'invoice.send_closeout_target_delivered';
const RETIRED = 'invoice.send_closeout_target_retired';
function sweepConn({ pins = [], deliveries = [], retired = [], sentAt = SENT_AT, pinReadFails = false, liveStatus = 'sent', liveClaimToken = null, candidateStatus = 'sent' } = {}) {
  const invoice = { id: 'inv-1', invoice_number: 'WPC-2099-0001', status: liveStatus, send_claim_token: liveClaimToken, scheduled_service_id: 'visit-live', sent_at: sentAt, paid_at: PAID_AT };
  const candidate = { invoice_id: 'inv-1', invoice_status: candidateStatus, visit_id: 'visit-live', visit_status: 'pending', own_attempt_parked: false, issued_after_service_day: true };
  const connFor = (table) => {
    const state = { action: null, token: null };
    const rowsOf = () => (state.action === DELIVERED ? deliveries : state.action === RETIRED ? retired.map((claimToken) => ({ claimToken })) : pins)
      .filter((row) => state.token === null || row.claimToken === state.token)
      .map((row) => ({ metadata: row, created_at: row.createdAt }));
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

describe('the sweep and a send-only refusal (round 14)', () => {
  // The audit lookup honors the sweep's own NOT IN filter on the code; the latest row for the visit is the approval mismatch.
  function mismatchConn(status) {
    const invoiceRow = { id: 'inv-1', invoice_number: 'WPC-2099-0001', status, send_claim_token: null, scheduled_service_id: 'visit-live', paid_at: '2021-03-01T15:00:00Z', sent_at: SENT_AT };
    const candidate = { invoice_id: 'inv-1', invoice_status: status, visit_id: 'visit-live', visit_status: 'pending', own_attempt_parked: false, issued_after_service_day: true };
    const connFor = (table) => {
      const state = { ignored: [], audit: false };
      const b = new Proxy({}, {
        get: (_t, prop) => {
          if (prop === 'then') return (res, rej) => Promise.resolve(table === 'invoices as i' ? [candidate] : null).then(res, rej);
          if (prop === 'where') return (arg) => { if (arg && arg.resource_type === 'scheduled_services') state.audit = true; return b; };
          if (prop === 'whereRaw') return (sql, bindings) => { if (/NOT IN/.test(sql)) state.ignored = bindings; return b; };
          if (prop === 'first') {
            return async () => {
              if (table === 'audit_log') {
                return state.audit && !state.ignored.includes('approved_target_mismatch')
                  ? { action: 'visit.completion_on_invoice_issued_refused', metadata: { invoiceId: 'inv-1', trigger: 'sent', code: 'approved_target_mismatch' } } : null;
              }
              if (table === 'invoices') return invoiceRow;
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

  test('a mismatch row left by a bar send does not block the PAID retry: the paid closeout runs', async () => {
    const out = await retryIssuedInvoiceCloseouts({ conn: mismatchConn('paid'), today: '2099-01-01' });
    expect(out).toMatchObject({ retried: 1, closed: 1 });
    expect(completeScheduledService).toHaveBeenCalledTimes(1);
  });

  test('the same row still leaves a SENT retry alone (a person decides)', async () => {
    const out = await retryIssuedInvoiceCloseouts({ conn: mismatchConn('sent'), today: '2099-01-01' });
    expect(out).toMatchObject({ retried: 0, closed: 0 });
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

describe('an unbound pin heals once nothing holds it (round 11)', () => {
  const { pinNoLongerHeld, CLOSEOUT_PIN_STALE_MS } = require('../services/invoice-issued-closeout');
  const old = new Date(Date.now() - CLOSEOUT_PIN_STALE_MS - 60000).toISOString();
  const fresh = new Date(Date.now() - 60000).toISOString();

  test('pinNoLongerHeld: a live claim under the pin\'s token holds it; otherwise it is released only after the stale window', () => {
    expect(pinNoLongerHeld({ status: 'sending', send_claim_token: 'claim-a' }, 'claim-a', old)).toBe(false);
    expect(pinNoLongerHeld({ status: 'sent', send_claim_token: null }, 'claim-a', old)).toBe(true);
    expect(pinNoLongerHeld({ status: 'sending', send_claim_token: 'claim-b' }, 'claim-a', old)).toBe(true);
    expect(pinNoLongerHeld({ status: 'sent', send_claim_token: null }, 'claim-a', fresh)).toBe(false);
    expect(pinNoLongerHeld({ status: 'sent', send_claim_token: null }, 'claim-a', null)).toBe(false);
  });

  test('a stale unbound pin (no claim holds it) no longer blocks the sweep: the invoice is judged as any page send', async () => {
    const out = await sweep({ pins: [{ ...pin('claim-lost', 'none'), createdAt: old }], deliveries: [] });
    expect(out).toMatchObject({ retried: 1, closed: 1 });
    expect(recordAuditEvent).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'invoice.closeout_pin_unbound' }));
  });

  test('a pin still held by a live claim, or a fresh one, still fails closed', async () => {
    const held = await sweep({ pins: [{ ...pin('claim-live', 'none'), createdAt: old }], deliveries: [], liveStatus: 'sending', liveClaimToken: 'claim-live' });
    expect(held).toMatchObject({ retried: 0, closed: 0 });
    const young = await sweep({ pins: [{ ...pin('claim-young', 'none'), createdAt: fresh }], deliveries: [] });
    expect(young).toMatchObject({ retried: 0, closed: 0 });
  });
});

describe('pinDecisionFor (round 12): the sweep\'s one decision about a pin', () => {
  const row = { invoice_id: 'inv-1', visit_id: 'visit-live' };
  test('a settled invoice (trigger paid) with no payment pin is unpinned', async () => {
    await expect(pinDecisionFor(sweepConn(), row, 'paid')).resolves.toEqual({ action: 'unpinned' });
  });
  test('a settled invoice keeps to the target its payment pinned (a bar record_payment card), including "none"', async () => {
    await expect(pinDecisionFor(sweepConn({ pins: [pin(PAID_TOKEN, 'visit-live')] }), row, 'paid')).resolves.toEqual({ action: 'honor', target: 'visit-live' });
    await expect(pinDecisionFor(sweepConn({ pins: [pin(PAID_TOKEN, 'none')] }), row, 'paid')).resolves.toEqual({ action: 'honor', target: 'none' });
  });
  test('a pin written for an earlier payment of a reopened invoice (a different paid_at) is not this payment\'s', async () => {
    await expect(pinDecisionFor(sweepConn({ pins: [pin('paid:1', 'none')] }), row, 'paid')).resolves.toEqual({ action: 'unpinned' });
  });
  test('an unreadable payment pin skips the row (fail closed)', async () => {
    await expect(pinDecisionFor(sweepConn({ pinReadFails: true, pins: [pin(PAID_TOKEN, 'none')] }), row, 'paid')).resolves.toEqual({ action: 'skip', reason: 'pin_lookup_failed' });
  });
  test('a delivered pin is honored with its target; none pinned is honored as "none"; no pin is unpinned', async () => {
    await expect(pinDecisionFor(sweepConn({ pins: [pin('c', 'visit-live')], deliveries: [delivered('c')] }), row, 'sent')).resolves.toEqual({ action: 'honor', target: 'visit-live' });
    await expect(pinDecisionFor(sweepConn({ pins: [pin('c', 'none')], deliveries: [delivered('c')] }), row, 'sent')).resolves.toEqual({ action: 'honor', target: 'none' });
    await expect(pinDecisionFor(sweepConn(), row, 'sent')).resolves.toEqual({ action: 'unpinned' });
  });
  test('an unbound pin and an unreadable pin are skipped, each with its reason', async () => {
    await expect(pinDecisionFor(sweepConn({ pins: [pin('c', 'none')] }), row, 'sent')).resolves.toEqual({ action: 'skip', reason: 'pin_unbound' });
    await expect(pinDecisionFor(sweepConn({ pinReadFails: true, pins: [pin('c', 'none')], deliveries: [delivered('c')] }), row, 'sent')).resolves.toEqual({ action: 'skip', reason: 'pin_lookup_failed' });
  });
});

describe('a payment recorded from the bar pins the closeout target it showed (record_payment, Codex r2b)', () => {
  const { recordApprovedPaidCloseoutTarget } = require('../services/invoice-issued-closeout');
  const trx = (table) => ({ where: () => ({ first: async () => (table === 'invoices' ? { paid_at: PAID_AT } : null) }) });

  test('no target (the Invoices page) writes nothing', async () => {
    await recordApprovedPaidCloseoutTarget('inv-1', undefined, { conn: trx });
    expect(recordAuditEvent).not.toHaveBeenCalled();
  });

  test.each(['visit-live', 'none'])('target %s is written in the given transaction under the payment\'s own token', async (target) => {
    await recordApprovedPaidCloseoutTarget('inv-1', target, { conn: trx, actorTechnicianId: 'staff-1' });
    expect(recordAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      action: PIN, resource_id: 'inv-1', actor_id: 'staff-1', critical: true, trx,
      metadata: expect.objectContaining({ approvedTarget: target, claimToken: PAID_TOKEN }),
    }));
  });

  test('an invoice with no paid_at cannot bind the pin: it throws, so the settlement rolls back', async () => {
    const noStamp = () => ({ where: () => ({ first: async () => ({ paid_at: null }) }) });
    await expect(recordApprovedPaidCloseoutTarget('inv-1', 'none', { conn: noStamp })).rejects.toThrow(/paid_at/);
  });

  test('the retry sweep, a visit that became closable after a card that said none: nothing is completed', async () => {
    const out = await sweep({ candidateStatus: 'paid', liveStatus: 'paid', pins: [pin(PAID_TOKEN, 'none')] });
    expect(out).toMatchObject({ retried: 1, closed: 0 });
    expect(completeScheduledService).not.toHaveBeenCalled();
    expect(recordAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ code: 'approved_target_mismatch' }) }));
  });

  test('the same sweep for a payment with no pin closes the visit, as every payment rail always did', async () => {
    const out = await sweep({ candidateStatus: 'paid', liveStatus: 'paid' });
    expect(out).toMatchObject({ retried: 1, closed: 1 });
    expect(completeScheduledService).toHaveBeenCalledTimes(1);
  });

  test('a payment pin is not mistaken for an unbound send pin by the send lookup', () => {
    const source = fs.readFileSync(path.join(__dirname, '../services/invoice-issued-closeout.js'), 'utf8');
    expect(source).toMatch(/COALESCE\(metadata->>'claimToken', ''\) NOT LIKE 'paid:%'/);
  });
});

describe('the carded visit\'s facts travel with the approved target (record_payment, Codex r9)', () => {
  const CARDED = { serviceType: null, date: '2020-01-01', status: 'pending', updatedAtMs: null };

  test('approvedVisitChanged compares service type, scheduled date, status and edit time; an unset fact is not compared', () => {
    const svc = { service_type: 'Pest Control', scheduled_date: new Date('2099-02-03T00:00:00Z'), status: 'confirmed', updated_at: new Date('2099-02-01T10:00:00.123Z') };
    const carded = { serviceType: 'Pest Control', date: '2099-02-03', status: 'confirmed', updatedAtMs: new Date('2099-02-01T10:00:00.123Z').getTime() };
    expect(approvedVisitChanged(svc, carded)).toBe(false);
    expect(approvedVisitChanged(svc, null)).toBe(false);
    for (const patch of [{ serviceType: 'Lawn Care' }, { date: '2099-02-04' }, { status: 'cancelled' }, { updatedAtMs: carded.updatedAtMs + 1 }]) {
      expect(approvedVisitChanged(svc, { ...carded, ...patch })).toBe(true);
    }
    expect(approvedVisitChanged(svc, { serviceType: 'Pest Control' })).toBe(false);
  });

  test('unchanged since the card: the approved visit closes, and the completion is handed the facts to re-assert under its lock', async () => {
    await expect(run({ approvedTarget: 'visit-live', approvedVisit: CARDED })).resolves.toMatchObject({ closed: true, visitId: 'visit-live' });
    expect(completeScheduledService).toHaveBeenCalledWith(expect.objectContaining({ issuedInvoiceCloseout: { invoiceId: 'inv-1', trigger: 'paid', expectedVisit: CARDED } }));
  });

  test.each([
    ['rescheduled to another date', { date: '2020-01-02' }],
    ['reclassified to another service', { serviceType: 'Lawn Care' }],
    ['status changed (cancelled)', { status: 'cancelled' }],
    ['edited since (edit time)', { updatedAtMs: 5 }],
  ])('a visit %s after the card is left open: approved_visit_changed, audited, nothing completed', async (_label, patch) => {
    const out = await run({ approvedTarget: 'visit-live', approvedVisit: { ...CARDED, ...patch } });
    expect(out).toMatchObject({ closed: false, reason: 'approved_visit_changed', visitId: 'visit-live', audited: true });
    expect(completeScheduledService).not.toHaveBeenCalled();
    expect(recordAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ code: 'approved_visit_changed' }) }));
  });

  test('no approved visit (the Invoices page, a send): nothing is compared and the completion gets no expected facts', async () => {
    await expect(run({ approvedTarget: 'visit-live' })).resolves.toMatchObject({ closed: true });
    expect(completeScheduledService.mock.calls[0][0].issuedInvoiceCloseout).toEqual({ invoiceId: 'inv-1', trigger: 'paid' });
  });

  test('approved_visit_changed is a refusal a person decides: neither sweep treats it as transient', () => {
    const source = fs.readFileSync(path.join(__dirname, '../services/invoice-issued-closeout.js'), 'utf8');
    const transient = source.slice(source.indexOf('function isTransientRefusal'), source.indexOf('}', source.indexOf('function isTransientRefusal')));
    expect(transient).not.toMatch(/approved_visit/);
    expect(source).not.toMatch(/SEND_ONLY_REFUSAL_CODES = \[[^\]]*approved_visit_changed/);
  });

  test('the completion re-asserts the facts on the LOCKED visit row, first in the issued-closeout block, and answers 409 approved_visit_changed', () => {
    const src = fs.readFileSync(path.join(__dirname, '../services/complete-scheduled-service.js'), 'utf8');
    const lock = src.indexOf("const lockedSvcRow = await trx('scheduled_services').where({ id: svc.id }).forUpdate().first();");
    const check = src.indexOf('approvedVisitChanged(lockedSvcRow, issuedInvoiceCloseout.expectedVisit)', lock);
    const firstRefusal = src.indexOf('const lockedRefusal =', lock);
    const fromStatus = src.indexOf('fromStatus = lockedSvcRow.status;', lock);
    expect(lock).toBeGreaterThan(0);
    expect(check).toBeGreaterThan(lock);
    expect(check).toBeLessThan(firstRefusal);
    expect(check).toBeLessThan(fromStatus);
    expect(src).toMatch(/err\.code === 'approved_visit_changed'\) \{\s*await CompletionAttempts\.markCompletionAttemptFailed\(completionAttempt, err, db\);\s*return \(\{ status: 409, body: \{[^}]*code: 'approved_visit_changed'/);
  });

  test('the payment pin keeps the facts beside the target, and the sweep honors both', async () => {
    const { recordApprovedPaidCloseoutTarget } = require('../services/invoice-issued-closeout');
    const trx = () => ({ where: () => ({ first: async () => ({ paid_at: PAID_AT }) }) });
    await recordApprovedPaidCloseoutTarget('inv-1', 'visit-live', { conn: trx, approvedVisit: CARDED });
    expect(recordAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ approvedTarget: 'visit-live', approvedVisit: CARDED, claimToken: PAID_TOKEN }) }));
    const row = { invoice_id: 'inv-1', visit_id: 'visit-live' };
    await expect(pinDecisionFor(sweepConn({ pins: [{ claimToken: PAID_TOKEN, approvedTarget: 'visit-live', approvedVisit: CARDED }] }), row, 'paid'))
      .resolves.toEqual({ action: 'honor', target: 'visit-live', visit: CARDED });
  });

  test('the retry sweep: a visit changed since the card is not closed on a later pass', async () => {
    const changed = { ...CARDED, date: '2020-01-09' };
    const out = await sweep({ candidateStatus: 'paid', liveStatus: 'paid', pins: [{ claimToken: PAID_TOKEN, approvedTarget: 'visit-live', approvedVisit: changed }] });
    expect(out).toMatchObject({ retried: 1, closed: 0 });
    expect(completeScheduledService).not.toHaveBeenCalled();
  });
});
