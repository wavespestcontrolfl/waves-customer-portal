/**
 * completionInvoiceAlreadyDelivered — the durable "already sent" signal the
 * schedule / dispatch feeds expose as completionInvoiceAlreadySent and the
 * completion applies to a reused pre-minted invoice (Codex P1 #4131 r3):
 * an Invoices-page linked create sent NOW must not be re-texted at
 * completion.
 */
const fs = require('fs');
const path = require('path');
const { completionInvoiceAlreadyDelivered } = require('../services/invoice-helpers');

// The claim itself, interleaved: two deliverers read the same draft; the
// second UPDATE … WHERE status = 'draft' matches nothing once the first
// flipped it to 'sending', and the loser is refused — so an admin "send
// now" and the completion can never both text the pay link.
jest.mock('../models/db', () => {
  const state = { status: 'draft', sent_at: null, email_sent_at: null, queuedCompletionText: null };
  const chain = (table) => {
    const q = {};
    q.where = jest.fn(() => q);
    q.whereIn = jest.fn(() => q);
    q.whereRaw = jest.fn(() => q);
    q.first = jest.fn(async () => (table === 'sms_log'
      ? state.queuedCompletionText
      : { id: 'inv-1', status: state.status, sent_at: state.sent_at, email_sent_at: state.email_sent_at }));
    q.update = jest.fn((values) => ({
      returning: jest.fn(async () => {
        const expected = q.where.mock.calls[q.where.mock.calls.length - 1][0].status;
        if (state.status !== expected) return [];
        state.status = values.status;
        return [{ id: 'inv-1', status: state.status }];
      }),
      catch: jest.fn(async () => { state.status = values.status; }),
    }));
    return q;
  };
  const db = jest.fn((table) => chain(table));
  db.__state = state;
  db.fn = { now: () => new Date() };
  db.raw = jest.fn();
  db.transaction = jest.fn();
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
// Real prepaidRefusesOfficeInvoice (services/visit-prepaid-coverage.js) runs
// unmocked below — it's the classification the send-guard fix reuses. Only
// its own deep dependency (the real coverage query against annual_prepay_terms)
// is stubbed, so a "stale annual stamp" is simulated by resolving `false`
// (not covering) rather than standing up a real annual-prepay-terms fixture.
jest.mock('../services/annual-prepay-renewals', () => ({
  ...jest.requireActual('../services/annual-prepay-renewals'),
  annualPrepayCoversVisit: jest.fn(async () => false),
}));

describe('the shared send claim (claimInvoiceForSend) under interleaving', () => {
  test('the first deliverer wins the claim; a second is refused; releasing restores the row', async () => {
    const db = require('../models/db');
    const { claimInvoiceForSend, restoreSendClaim } = require('../services/invoice');
    db.__state.status = 'draft';
    const first = await claimInvoiceForSend('inv-1');
    expect(first).toMatchObject({ previousStatus: 'draft', claimed: true });
    expect(db.__state.status).toBe('sending');
    await expect(claimInvoiceForSend('inv-1')).rejects.toThrow(/already in progress|not sendable/i);
    await restoreSendClaim('inv-1', first.previousStatus, first.claimed);
    expect(db.__state.status).toBe('draft');
  });

  test('a FIRST delivery (the linked create\'s immediate send) is refused as already_delivered once the completion delivered the row — never re-claimed from sent as a resend (GitHub r6 P1)', async () => {
    const db = require('../models/db');
    const { claimInvoiceForSend } = require('../services/invoice');
    db.__state.status = 'sent';
    db.__state.sent_at = null;
    await expect(claimInvoiceForSend('inv-1', { firstDeliveryOnly: true })).rejects.toMatchObject({ code: 'already_delivered' });
    // A delivered-but-unfinalized draft (sent_at stamped) is delivered too.
    db.__state.status = 'draft';
    db.__state.sent_at = new Date();
    await expect(claimInvoiceForSend('inv-1', { firstDeliveryOnly: true })).rejects.toMatchObject({ code: 'already_delivered' });
    expect(db.__state.status).toBe('draft');
    // The operator's own resend (no flag) still claims from sent.
    db.__state.status = 'sent';
    db.__state.sent_at = null;
    const resend = await claimInvoiceForSend('inv-1');
    expect(resend).toMatchObject({ previousStatus: 'sent', claimed: true });
    db.__state.status = 'draft';
    db.__state.sent_at = null;
  });

  test('a FIRST delivery is refused as already_delivered when only email_sent_at is stamped, even though status reads draft and sent_at is null (pre-push Codex P1 #4131: the AP email accept stamps email_sent_at before any status transition, and a bookkeeping failure that restores the claim to draft must not un-hide that stamp from a firstDeliveryOnly claimant)', async () => {
    const db = require('../models/db');
    const { claimInvoiceForSend } = require('../services/invoice');
    db.__state.status = 'draft';
    db.__state.sent_at = null;
    db.__state.email_sent_at = new Date();
    await expect(claimInvoiceForSend('inv-1', { firstDeliveryOnly: true })).rejects.toMatchObject({ code: 'already_delivered' });
    expect(db.__state.status).toBe('draft');
    // The operator's own resend (no flag) is unaffected — email_sent_at only
    // gates the FIRST-delivery claimants, never an intentional resend.
    const resend = await claimInvoiceForSend('inv-1');
    expect(resend).toMatchObject({ previousStatus: 'draft', claimed: true });
    db.__state.status = 'draft';
    db.__state.email_sent_at = null;
  });

  test('a queued pay-link text (send-window hold) owns the delivery: every other claim is refused (queued_pay_link) until it delivers or terminally fails; the invoice-send path adopts its own queue and is blocked only by the completion-owned ones (GitHub r5 P1 + pre-push P1)', async () => {
    const db = require('../models/db');
    const { claimInvoiceForSend } = require('../services/invoice');
    db.__state.status = 'draft';
    db.__state.sent_at = null;
    db.__state.queuedCompletionText = { id: 'sms-q', scheduled_for: new Date('2026-09-11T12:00:00Z') };
    // The completion's claim (no adopt flag): every queue blocks it, incl. an earlier admin send's held SMS leg.
    await expect(claimInvoiceForSend('inv-1')).rejects.toMatchObject({ code: 'queued_pay_link', message: expect.stringMatching(/already in progress.*queued for the send window/i) });
    expect(db.__state.status).toBe('draft');
    const queries = () => db.mock.results.map((r) => r.value).filter((q) => q.whereRaw.mock.calls.length);
    let smsLogQuery = queries().pop();
    // Live = queued, mid-send, or settled 'sent' with finalization still
    // pending (the worker stamps finalize_pending BEFORE markDeliverySent
    // runs — a claim in that gap must still see the owner; Codex P1 r6).
    expect(smsLogQuery.whereRaw).toHaveBeenCalledWith("(status IN ('scheduled', 'sending') OR (status = 'sent' AND metadata->>'finalize_pending' = 'true'))");
    expect(smsLogQuery.whereRaw).toHaveBeenCalledWith("metadata->>'invoice_id' = ?", ['inv-1']);
    expect(smsLogQuery.whereRaw).toHaveBeenCalledWith("metadata->>'entry_point' = ANY(?)", [['dispatch_completion_deferred', 'autopay_completion_decline_deferred', 'invoice_send_deferred']]);
    // The invoice-send path's own retry: the completion-owned queues and any
    // worker-claimed row block it; only its own still-SCHEDULED held leg is
    // adoptable (consumed under the claim).
    await expect(claimInvoiceForSend('inv-1', { adoptsQueuedInvoiceSend: true })).rejects.toMatchObject({ code: 'queued_pay_link' });
    smsLogQuery = queries().pop();
    expect(smsLogQuery.whereRaw).toHaveBeenCalledWith("metadata->>'entry_point' = ANY(?)", [['dispatch_completion_deferred', 'autopay_completion_decline_deferred', 'invoice_send_deferred']]);
    expect(smsLogQuery.whereRaw).toHaveBeenCalledWith("(status = 'sending' OR (status = 'sent' AND metadata->>'finalize_pending' = 'true') OR (status = 'scheduled' AND metadata->>'entry_point' <> ?))", ['invoice_send_deferred']);
    // Delivered or terminally failed → the row is no longer live → claimable again.
    db.__state.queuedCompletionText = null;
    const claim = await claimInvoiceForSend('inv-1');
    expect(claim).toMatchObject({ previousStatus: 'draft', claimed: true });
    db.__state.status = 'draft';
  });

  test('interleaving: draft → sending → draft between the queue check and the claim flip (an admin send claimed, queued its held SMS leg, failed its email leg, restored draft) — the re-check under the claim refuses and gives the claim back', async () => {
    const db = require('../models/db');
    const { claimInvoiceForSend } = require('../services/invoice');
    db.__state.status = 'draft';
    db.__state.sent_at = null;
    // No queue on the pre-claim read; the other sender's row exists by the re-check.
    let smsLogReads = 0;
    db.__state.queuedCompletionText = null;
    const original = db.getMockImplementation();
    db.mockImplementation((table) => {
      const q = original(table);
      if (table === 'sms_log') {
        q.first = jest.fn(async () => {
          smsLogReads += 1;
          return smsLogReads === 1 ? null : { id: 'sms-other-sender', scheduled_for: new Date('2026-09-11T12:00:00Z') };
        });
      }
      return q;
    });
    try {
      await expect(claimInvoiceForSend('inv-1')).rejects.toMatchObject({ code: 'queued_pay_link' });
      expect(smsLogReads).toBe(2);
      // The claim was taken (draft → sending) and given back (→ draft): nothing left under it.
      expect(db.__state.status).toBe('draft');
    } finally {
      db.mockImplementation(original);
    }
  });

  test('the CLAIM itself guards a zero-due visit-linked invoice — record-linked or not: settled → refused as prepaid (report-only for the completion), unsettleable → deposit_settlement_pending; the row is never flipped to sending (Codex P1 r9 #4131)', async () => {
    const db = require('../models/db');
    const InvoiceService = require('../services/invoice');
    const { claimInvoiceForSend } = InvoiceService;
    db.__state.status = 'draft';
    db.__state.sent_at = null;
    db.__state.queuedCompletionText = null;
    const original = db.getMockImplementation();
    let row = { id: 'inv-1', status: 'draft', total: 0, credit_applied: 0, scheduled_service_id: 'svc-1', service_record_id: 'sr-1' };
    db.mockImplementation((table) => {
      const q = original(table);
      if (table === 'invoices') q.first = jest.fn(async () => row);
      return q;
    });
    const settle = jest.spyOn(InvoiceService, 'settleZeroBalance');
    try {
      settle.mockResolvedValueOnce({ settled: true, invoice: { ...row, status: 'prepaid' } });
      await expect(claimInvoiceForSend('inv-1')).rejects.toThrow(/Cannot send a prepaid invoice/);
      expect(settle).toHaveBeenCalledWith('inv-1', db);
      expect(db.__state.status).toBe('draft'); // no claim flip happened
      settle.mockResolvedValueOnce({ settled: false, reason: 'followup_in_flight', retryable: true });
      await expect(claimInvoiceForSend('inv-1')).rejects.toMatchObject({ code: 'deposit_settlement_pending' });
      settle.mockRejectedValueOnce(new Error('deadlock detected'));
      await expect(claimInvoiceForSend('inv-1')).rejects.toMatchObject({ code: 'deposit_settlement_pending', message: expect.stringMatching(/deadlock detected/) });
      // Out of scope: a balance due, or no visit link → the normal claim.
      settle.mockClear();
      row = { ...row, total: 117 };
      expect(await claimInvoiceForSend('inv-1')).toMatchObject({ claimed: true });
      db.__state.status = 'draft';
      row = { ...row, total: 0, scheduled_service_id: null };
      expect(await claimInvoiceForSend('inv-1')).toMatchObject({ claimed: true });
      expect(settle).not.toHaveBeenCalled();
      db.__state.status = 'draft';
    } finally {
      settle.mockRestore();
      db.mockImplementation(original);
    }
  });

  test('under the claim: a draft retotalled to $0 between the read and the flip is settled and refused; a visit cancelled since creation refuses (visit_cancelled) — the claim is given back both times (Codex P1 r10 ×2 #4131)', async () => {
    const db = require('../models/db');
    const InvoiceService = require('../services/invoice');
    const { claimInvoiceForSend } = InvoiceService;
    const original = db.getMockImplementation();
    let readRow = { id: 'inv-1', status: 'draft', total: 117, credit_applied: 0, scheduled_service_id: 'svc-1', service_record_id: null };
    let flippedRow = { ...readRow, status: 'sending' };
    let visitStatus = 'confirmed';
    db.mockImplementation((table) => {
      const q = original(table);
      if (table === 'invoices') {
        q.first = jest.fn(async () => ({ ...readRow, status: db.__state.status }));
        q.update = jest.fn((values) => ({
          returning: jest.fn(async () => {
            if (db.__state.status !== q.where.mock.calls[q.where.mock.calls.length - 1][0].status) return [];
            db.__state.status = values.status;
            return [{ ...flippedRow, status: values.status }];
          }),
          catch: jest.fn(async () => { db.__state.status = values.status; }),
        }));
      }
      if (table === 'scheduled_services') q.first = jest.fn(async () => ({ id: 'svc-1', status: visitStatus }));
      return q;
    });
    const settle = jest.spyOn(InvoiceService, 'settleZeroBalance');
    try {
      // (a) the row the flip RETURNS is already $0 (admin retotal under the read)
      db.__state.status = 'draft';
      flippedRow = { ...readRow, total: 0 };
      settle.mockResolvedValueOnce({ settled: true, invoice: { ...flippedRow, status: 'prepaid' } });
      await expect(claimInvoiceForSend('inv-1')).rejects.toThrow(/Cannot send a prepaid invoice/);
      expect(settle).toHaveBeenCalledWith('inv-1', db);
      expect(db.__state.status).toBe('draft'); // claim given back BEFORE settling (settleZeroBalance refuses 'sending')
      // (b) the linked visit was cancelled since the invoice was created
      flippedRow = { ...readRow };
      visitStatus = 'cancelled';
      settle.mockClear();
      await expect(claimInvoiceForSend('inv-1')).rejects.toMatchObject({ code: 'visit_cancelled', message: expect.stringMatching(/Invoice is not sendable/) });
      expect(db.__state.status).toBe('draft');
      expect(settle).not.toHaveBeenCalled();
      // control: a live visit with a balance due claims normally
      visitStatus = 'confirmed';
      expect(await claimInvoiceForSend('inv-1')).toMatchObject({ claimed: true, previousStatus: 'draft' });
      expect(db.__state.status).toBe('sending');
      db.__state.status = 'draft';
    } finally {
      settle.mockRestore();
      db.mockImplementation(original);
    }
  });

  test('the CLAIM refuses a visit-linked invoice whose recorded cash/Zelle prepayment has not yet been reconciled with it — the interleaving where the office\'s direct scheduled_services write lands moments AFTER this invoice\'s mint, invisible to the mint\'s own eligibility check (round-17 P1 #4131 finding 1, widened to partial prepayments round 19)', async () => {
    const db = require('../models/db');
    const InvoiceService = require('../services/invoice');
    const { claimInvoiceForSend } = InvoiceService;
    const original = db.getMockImplementation();
    const readRow = { id: 'inv-1', status: 'draft', total: 117, credit_applied: 0, scheduled_service_id: 'svc-1', service_record_id: null };
    let visitPrepaidAmount = 0;
    // Whether a `scheduled_service_prepaid` payments row already exists for
    // (inv-1, svc-1) — the durable "already reconciled with THIS invoice"
    // marker admin-schedule's full-payment finalize and completion's
    // applyPrepaidCreditToInvoice both write.
    let creditApplied = false;
    db.mockImplementation((table) => {
      const q = original(table);
      if (table === 'invoices') {
        q.first = jest.fn(async () => ({ ...readRow, status: db.__state.status }));
        q.update = jest.fn((values) => ({
          returning: jest.fn(async () => {
            if (db.__state.status !== q.where.mock.calls[q.where.mock.calls.length - 1][0].status) return [];
            db.__state.status = values.status;
            return [{ ...readRow, status: values.status }];
          }),
          catch: jest.fn(async () => { db.__state.status = values.status; }),
        }));
      }
      if (table === 'scheduled_services') q.first = jest.fn(async () => ({ id: 'svc-1', status: 'confirmed', prepaid_amount: visitPrepaidAmount, prepaid_method: 'cash' }));
      if (table === 'payments') q.first = jest.fn(async () => (creditApplied ? { id: 'pmt-1' } : null));
      return q;
    });
    try {
      // The office's direct scheduled_services.prepaid_amount write has
      // NO row lock of its own — it can commit right after this SAME
      // invoice's mint, which never saw it. By the time an Immediate send
      // takes this claim, the visit's cash is not yet reconciled with the
      // invoice: refuse rather than text the full-balance link for money
      // already in hand.
      db.__state.status = 'draft';
      visitPrepaidAmount = 117;
      await expect(claimInvoiceForSend('inv-1')).rejects.toMatchObject({ code: 'visit_prepaid_covered', message: expect.stringMatching(/Invoice is not sendable/) });
      expect(db.__state.status).toBe('draft'); // claim taken then given straight back
      // A prepayment that covers MORE than the balance due also refuses.
      visitPrepaidAmount = 200;
      await expect(claimInvoiceForSend('inv-1')).rejects.toMatchObject({ code: 'visit_prepaid_covered' });
      expect(db.__state.status).toBe('draft');
      // Round-19 P1 (#4131 finding 1, partial-payment follow-on): a
      // prepayment that only PARTIALLY covers the balance and has NOT yet
      // been credited to this invoice must ALSO refuse — otherwise the
      // Immediate send collects the invoice's full, un-reduced balance on
      // top of the cash already taken.
      visitPrepaidAmount = 50;
      creditApplied = false;
      await expect(claimInvoiceForSend('inv-1')).rejects.toMatchObject({ code: 'visit_prepaid_covered', message: expect.stringMatching(/Invoice is not sendable/) });
      expect(db.__state.status).toBe('draft');
      // Once that same partial amount HAS been credited to this invoice
      // (completion's applyPrepaidCreditToInvoice already reduced the
      // total, or admin-schedule's reconciler caught up) the marker row
      // exists and the claim proceeds normally for the genuinely
      // remaining balance — comparing raw prepaid_amount (never cleared)
      // against the now-reduced total would otherwise misfire here.
      creditApplied = true;
      expect(await claimInvoiceForSend('inv-1')).toMatchObject({ claimed: true, previousStatus: 'draft' });
      db.__state.status = 'draft';
      creditApplied = false;
      // Control: no recorded prepayment claims normally.
      visitPrepaidAmount = 0;
      expect(await claimInvoiceForSend('inv-1')).toMatchObject({ claimed: true, previousStatus: 'draft' });
      db.__state.status = 'draft';
    } finally {
      db.mockImplementation(original);
    }
  });

  test('the CLAIM does NOT refuse a PAYER-billed visit on the homeowner\'s own recorded prepayment — the payer\'s AP invoice is what this claim sends, mirroring prepaidRefusesOfficeInvoice\'s payerBilled exemption on the create path (pre-push audit P1 #4131 finding 2, fixing round-19\'s over-broad widening)', async () => {
    const db = require('../models/db');
    const InvoiceService = require('../services/invoice');
    const { claimInvoiceForSend } = InvoiceService;
    const original = db.getMockImplementation();
    // The homeowner's own scheduled_services.prepaid_amount is positive —
    // exactly the shape round 19 started refusing on ANY positive amount —
    // but this invoice is billed to a third-party PAYER (payer_id set), so
    // it must send regardless: the homeowner's cash says nothing about
    // whether the payer's AP invoice is settled.
    const readRow = { id: 'inv-1', status: 'draft', total: 117, credit_applied: 0, scheduled_service_id: 'svc-1', service_record_id: null, payer_id: 'payer-1' };
    db.mockImplementation((table) => {
      const q = original(table);
      if (table === 'invoices') {
        q.first = jest.fn(async () => ({ ...readRow, status: db.__state.status }));
        q.update = jest.fn((values) => ({
          returning: jest.fn(async () => {
            if (db.__state.status !== q.where.mock.calls[q.where.mock.calls.length - 1][0].status) return [];
            db.__state.status = values.status;
            return [{ ...readRow, status: values.status }];
          }),
          catch: jest.fn(async () => { db.__state.status = values.status; }),
        }));
      }
      if (table === 'scheduled_services') q.first = jest.fn(async () => ({ id: 'svc-1', status: 'confirmed', prepaid_amount: 117, prepaid_method: 'cash' }));
      if (table === 'payments') q.first = jest.fn(async () => null);
      return q;
    });
    try {
      db.__state.status = 'draft';
      expect(await claimInvoiceForSend('inv-1')).toMatchObject({ claimed: true, previousStatus: 'draft' });
      expect(db.__state.status).toBe('sending');
    } finally {
      db.mockImplementation(original);
      db.__state.status = 'draft';
    }
  });

  test('the CLAIM does NOT refuse a visit whose prepaid_method is the annual-prepay stamp when the stamp is stale (no live covering term) — governed by annualPrepayCoversVisit\'s own classification, not the out-of-band payments-row marker (pre-push audit P1 #4131 finding 2, fixing round-19\'s over-broad widening)', async () => {
    const db = require('../models/db');
    const InvoiceService = require('../services/invoice');
    const { claimInvoiceForSend } = InvoiceService;
    const { ANNUAL_PREPAY_PREPAID_METHOD, annualPrepayCoversVisit } = require('../services/annual-prepay-renewals');
    const original = db.getMockImplementation();
    const readRow = { id: 'inv-1', status: 'draft', total: 117, credit_applied: 0, scheduled_service_id: 'svc-1', service_record_id: null, payer_id: null };
    db.mockImplementation((table) => {
      const q = original(table);
      if (table === 'invoices') {
        q.first = jest.fn(async () => ({ ...readRow, status: db.__state.status }));
        q.update = jest.fn((values) => ({
          returning: jest.fn(async () => {
            if (db.__state.status !== q.where.mock.calls[q.where.mock.calls.length - 1][0].status) return [];
            db.__state.status = values.status;
            return [{ ...readRow, status: values.status }];
          }),
          catch: jest.fn(async () => { db.__state.status = values.status; }),
        }));
      }
      // A stamped visit — carries a positive prepaid_amount AND the annual
      // method, but no LIVE covering term (annualPrepayCoversVisit mocked
      // to resolve false at module scope — a stale stamp left by a
      // best-effort void/refund clear). Never writes a
      // `scheduled_service_prepaid` payments row, so the out-of-band
      // credited-marker check could never see this as "reconciled" even
      // in principle — this must be governed by the annual classification
      // alone, exactly like prepaidRefusesOfficeInvoice on create.
      if (table === 'scheduled_services') {
        q.first = jest.fn(async () => ({
          id: 'svc-1', status: 'confirmed', customer_id: 'cust-1', service_type: 'Fixture Quarterly Pest Control Service',
          prepaid_amount: 400, prepaid_method: ANNUAL_PREPAY_PREPAID_METHOD, annual_prepay_term_id: 'term-1',
        }));
      }
      if (table === 'payments') q.first = jest.fn(async () => null);
      return q;
    });
    try {
      db.__state.status = 'draft';
      expect(await claimInvoiceForSend('inv-1')).toMatchObject({ claimed: true, previousStatus: 'draft' });
      expect(db.__state.status).toBe('sending');
      expect(annualPrepayCoversVisit).toHaveBeenCalled();
    } finally {
      db.mockImplementation(original);
      db.__state.status = 'draft';
    }
  });

  test('adoption consumes the send\'s own still-scheduled held SMS leg under the claim, then re-checks strictly: a row the worker claimed meanwhile keeps the delivery and the claim is given back (Codex P1 r6 #4131)', async () => {
    const db = require('../models/db');
    const { claimInvoiceForSend } = require('../services/invoice');
    db.__state.status = 'draft';
    db.__state.sent_at = null;
    db.__state.queuedCompletionText = null;
    const original = db.getMockImplementation();
    const cancels = [];
    let strictReads = 0;
    let workerOwnsRow = false;
    db.mockImplementation((table) => {
      const q = original(table);
      if (table === 'sms_log') {
        q.update = jest.fn((values) => {
          cancels.push({ values, raw: q.whereRaw.mock.calls.map((c) => c[0]) });
          return { returning: jest.fn(async () => (workerOwnsRow ? [] : [{ id: 'sms-held-leg' }])) };
        });
        q.first = jest.fn(async () => {
          const strict = q.whereRaw.mock.calls.some((c) => c[0] === "(status IN ('scheduled', 'sending') OR (status = 'sent' AND metadata->>'finalize_pending' = 'true'))");
          if (!strict) return null; // adopter's view: its own scheduled leg is not a blocker
          strictReads += 1;
          return workerOwnsRow ? { id: 'sms-held-leg', scheduled_for: new Date('2026-09-11T12:00:00Z') } : null;
        });
      }
      return q;
    });
    try {
      // Happy path: the scheduled leg is cancelled (superseded) and the claim is returned.
      const claim = await claimInvoiceForSend('inv-1', { adoptsQueuedInvoiceSend: true });
      expect(claim).toMatchObject({ previousStatus: 'draft', claimed: true });
      expect(cancels).toHaveLength(1);
      expect(cancels[0].values.status).toBe('cancelled');
      expect(cancels[0].raw).toEqual(expect.arrayContaining([
        "metadata->>'entry_point' = ?",
        "metadata->>'invoice_id' = ?",
        "(status = 'scheduled' OR (status = 'cancelled' AND metadata->>'invoice_send_adoption_pending' = 'true'))",
      ]));
      expect(strictReads).toBe(1);
      // Race: the worker flipped the row to 'sending' first — nothing to cancel,
      // the strict re-check sees the live row, the claim is refused AND released.
      db.__state.status = 'draft';
      workerOwnsRow = true;
      await expect(claimInvoiceForSend('inv-1', { adoptsQueuedInvoiceSend: true })).rejects.toMatchObject({ code: 'queued_pay_link' });
      expect(db.__state.status).toBe('draft');
      // The completion's claim never consumes anything: no adopt flag → no cancel.
      cancels.length = 0;
      workerOwnsRow = false;
      db.__state.status = 'draft';
      await claimInvoiceForSend('inv-1');
      expect(cancels).toHaveLength(0);
      db.__state.status = 'draft';
    } finally {
      db.mockImplementation(original);
    }
  });

  test('a post-claim queue lookup that THROWS gives the claim back and rethrows — the row never sits under a claim nobody holds', async () => {
    const db = require('../models/db');
    const { claimInvoiceForSend } = require('../services/invoice');
    db.__state.status = 'draft';
    db.__state.sent_at = null;
    db.__state.queuedCompletionText = null;
    let smsLogReads = 0;
    const original = db.getMockImplementation();
    db.mockImplementation((table) => {
      const q = original(table);
      if (table === 'sms_log') {
        q.first = jest.fn(async () => {
          smsLogReads += 1;
          if (smsLogReads === 2) throw new Error('sms_log read failed');
          return null;
        });
      }
      return q;
    });
    try {
      await expect(claimInvoiceForSend('inv-1')).rejects.toThrow('sms_log read failed');
      expect(smsLogReads).toBe(2);
      expect(db.__state.status).toBe('draft');
    } finally {
      db.mockImplementation(original);
    }
  });

  test('behavioral: an admin send whose SMS leg was queued for the window (row back to draft) followed by the completion — the completion is refused and goes report-only; the admin retry still adopts its queue', async () => {
    const db = require('../models/db');
    const { claimInvoiceForSend } = require('../services/invoice');
    db.__state.status = 'draft';
    db.__state.sent_at = null;
    // The queued invoice_send_deferred row is what the mock returns for any live queue; the
    // completion's claim consults all three entry points and is refused.
    db.__state.queuedCompletionText = { id: 'sms-invoice-send', scheduled_for: new Date('2026-09-11T12:00:00Z') };
    let refusal = null;
    try { await claimInvoiceForSend('inv-1'); } catch (e) { refusal = e; }
    expect(refusal?.code).toBe('queued_pay_link');
    // The completion classifies that code as nothing-left-to-deliver (source contract below), so no 503.
    const fs2 = require('fs');
    const completion = fs2.readFileSync(require('path').join(__dirname, '../services/complete-scheduled-service.js'), 'utf8');
    expect(completion).toMatch(/const nothingLeftToDeliver = claimErr\?\.code === 'queued_pay_link'/);
    expect(db.__state.status).toBe('draft');
    db.__state.queuedCompletionText = null;
  });

  // Codex r12 P1 #4131: processScheduledSends parks a stale 'sending' claim
  // as status 'scheduled' + scheduled_send_at: null + the durable
  // "Recovered from stale sending claim…" marker for OPERATOR review — the
  // claim may have died AFTER the provider accepted the text, and DB state
  // can't tell that apart from a pre-delivery crash. An automatic claimant
  // (the completion) must honor that hold instead of texting a pay link the
  // customer may already have; an explicit operator resend is the intended
  // way off it.
  test('a stale-claim review hold refuses an automatic claim (report-only shape) but an operatorInitiated claim still proceeds', async () => {
    const db = require('../models/db');
    const InvoiceService = require('../services/invoice');
    const { claimInvoiceForSend } = InvoiceService;
    const original = db.getMockImplementation();
    const parkedRow = {
      id: 'inv-1',
      status: 'scheduled',
      scheduled_send_at: null,
      scheduled_send_error: 'Recovered from stale sending claim — delivery unverified; check whether the customer received it, then resend or re-schedule manually',
      total: 117,
      credit_applied: 0,
      scheduled_service_id: null,
      service_record_id: null,
    };
    db.__state.status = 'scheduled';
    db.mockImplementation((table) => {
      const q = original(table);
      if (table === 'invoices') q.first = jest.fn(async () => ({ ...parkedRow, status: db.__state.status }));
      return q;
    });
    try {
      // No operatorInitiated: refused, and shaped so the completion's
      // existing classifier reads it as nothing-left-to-deliver (report-only,
      // not the resumable 503) — same "Invoice is not sendable" phrase.
      await expect(claimInvoiceForSend('inv-1')).rejects.toMatchObject({
        code: 'stale_claim_review_hold',
        message: expect.stringMatching(/Invoice is not sendable/),
      });
      expect(db.__state.status).toBe('scheduled'); // never flipped to sending

      // An explicit operator resend (operatorInitiated: true) is the
      // intended way off the hold and still claims normally.
      const resend = await claimInvoiceForSend('inv-1', { operatorInitiated: true });
      expect(resend).toMatchObject({ previousStatus: 'scheduled', claimed: true });
      expect(db.__state.status).toBe('sending');
      db.__state.status = 'scheduled';

      // sendViaSMS and sendViaSMSAndEmail thread operatorInitiated through to
      // the claim — the two callers an admin resend route actually uses.
      const invoiceSource = require('fs').readFileSync(require('path').join(__dirname, '../services/invoice.js'), 'utf8');
      expect(invoiceSource).toMatch(/claimInvoiceForSend\(invoiceId, \{ allowClaimed, adoptsQueuedInvoiceSend, operatorInitiated \}\)/);
      expect(invoiceSource).toMatch(/claimInvoiceForSend\(invoiceId, \{ allowClaimed, firstDeliveryOnly, adoptsQueuedInvoiceSend: true, operatorInitiated \}\)/);
    } finally {
      db.mockImplementation(original);
    }
  });
});

describe('completionInvoiceAlreadyDelivered', () => {
  test('delivered = sent_at stamped, or a sent / paid / prepaid status', () => {
    expect(completionInvoiceAlreadyDelivered({ status: 'draft', sent_at: new Date() })).toBe(true);
    expect(completionInvoiceAlreadyDelivered({ status: 'sent', sent_at: null })).toBe(true);
    expect(completionInvoiceAlreadyDelivered({ status: 'paid' })).toBe(true);
    expect(completionInvoiceAlreadyDelivered({ status: 'prepaid' })).toBe(true);
  });
  test('not delivered = no invoice, a draft, sending, or overdue-unsent', () => {
    expect(completionInvoiceAlreadyDelivered(null)).toBe(false);
    expect(completionInvoiceAlreadyDelivered({ status: 'draft', sent_at: null })).toBe(false);
    expect(completionInvoiceAlreadyDelivered({ status: 'sending' })).toBe(false);
    expect(completionInvoiceAlreadyDelivered({})).toBe(false);
  });
  test('source contract: every visit feed exposes completionInvoiceAlreadySent from the attached invoice, and the completion applies it to a reused pre-minted invoice', () => {
    const schedule = fs.readFileSync(path.join(__dirname, '../routes/admin-schedule.js'), 'utf8');
    expect(schedule.match(/completionInvoiceAlreadySent: completionInvoiceAlreadyDelivered\(checkoutInvoice\)/g)).toHaveLength(2);
    expect(schedule.match(/'credit_applied', 'payer_id', 'sent_at'\)/g)).toHaveLength(2);
    const dispatch = fs.readFileSync(path.join(__dirname, '../routes/admin-dispatch.js'), 'utf8');
    expect(dispatch).toContain("completionInvoiceAlreadySent: require('../services/invoice-helpers').completionInvoiceAlreadyDelivered(checkoutInvoice)");
    expect(dispatch).toContain(".first('id', 'status', 'total', 'token', 'sent_at')");
    const completion = fs.readFileSync(path.join(__dirname, '../services/complete-scheduled-service.js'), 'utf8');
    expect(completion).toMatch(/const suppressCompletionInvoiceLink = !!invoiceAlreadySent\s*\|\| !!\(preMintedInvoice && require\('\.\.\/services\/invoice-helpers'\)\.completionInvoiceAlreadyDelivered\(preMintedInvoice\)\);/);
    // …and takes the ONE send claim before texting a link for a reused invoice (Codex P1 r4):
    // claim at the decision, finalize via markDeliverySent when the link went out, release otherwise (normal end and thrown path).
    // firstDeliveryOnly (P1 #4131, this round): the plain claim +
    // completionInvoiceAlreadyDelivered(claim.invoice) post-claim recheck a
    // prior sweep called "equivalent" is gone — claim.invoice.status is
    // always 'sending' post-flip (that recheck's status half could never
    // fire) and the helper never read email_sent_at at all, so an
    // email-delivered AP invoice was invisible to it. firstDeliveryOnly
    // refuses BEFORE the flip on sent_at, email_sent_at, or a delivered
    // status — see the completion-invoice-delivered describe block below
    // for the mechanism-diff proof.
    expect(completion).toMatch(/const claim = await InvoiceServiceForClaim\.claimInvoiceForSend\(invoice\.id, \{ firstDeliveryOnly: true \}\);\s*completionInvoiceSendClaim = \{ invoiceId: invoice\.id, previousStatus: claim\.previousStatus, claimed: claim\.claimed \};/);
    // The dead post-claim recheck itself (an actual call, not a comment
    // explaining why it's gone) no longer exists at this site.
    expect(completion).not.toMatch(/if \(require\('\.\.\/services\/invoice-helpers'\)\.completionInvoiceAlreadyDelivered\(claim\.invoice\)\)/);
    // The claim is attempted only when every other pay-link gate already passes.
    // …including a decline notice that already delivered the link (GitHub r6 P1): report-only, no claim.
    // Codex r16 P1 #4131: the claim is taken for EVERY collectible invoice —
    // the one this completion minted itself included (the mint commits
    // before the delivery lane, so an admin send can claim the fresh draft
    // in between). The earlier reused-only keys (preMintedInvoice /
    // adoptedConcurrentInvoice, r4 + r12) no longer gate it.
    expect(completion).toMatch(/const linkOtherwiseEligible = !suppressCompletionInvoiceLink\s*&& includePayLink !== false[\s\S]{0,2200}?&& !invoice\?\.payer_id\s*(?:\/\/[^\n]*\n\s*)*&& !paymentFailedNoticeSent;[\s\S]{0,2200}?if \(linkOtherwiseEligible && invoice\?\.id\) \{/);
    expect(completion).not.toMatch(/if \(linkOtherwiseEligible && invoice\?\.id\s*&& \(\(preMintedInvoice/);
    expect(completion).toMatch(/const allowCompletionInvoiceLink = linkOtherwiseEligible && !reusedInvoiceClaimedElsewhere;/);
    expect(completion).not.toMatch(/allowCompletionInvoiceLinkBase/);
    // A refused claim is classified: settled/gone → report-only; in-flight send or transient failure → the resumable 503 (retryable delivery).
    // A queued pay-link text (any of the three send-window queues) is a durable delivery owner → report-only, never the 503.
    // 'already_delivered' (P1 #4131, this round) is firstDeliveryOnly's own
    // refusal — the row was already delivered since the pre-completion
    // read; nothing left for THIS completion to send either, same as a
    // queued pay-link text.
    expect(completion).toMatch(/const nothingLeftToDeliver = claimErr\?\.code === 'queued_pay_link'\s*\|\| claimErr\?\.code === 'already_delivered'\s*\|\| \/Cannot send a \(paid\|prepaid\|voided\) invoice\|Cannot send an invoice while payment is processing\|Invoice not found\|Invoice is not sendable\/i\.test\(claimMessage\);\s*if \(!nothingLeftToDeliver\) \{[\s\S]{0,300}?return exitForCompletionSmsResume\(new Error\(`Invoice \$\{invoice\.id\} delivery claim unavailable: \$\{claimMessage\}`\)\);/);
    // …and the completion's claim carries no adoptsQueuedInvoiceSend: a queued invoice_send_deferred row refuses it too.
    expect(completion).toMatch(/const claim = await InvoiceServiceForClaim\.claimInvoiceForSend\(invoice\.id, \{ firstDeliveryOnly: true \}\);/);
    // The link is delivered at PROVIDER ACCEPTANCE, before markDeliverySent, on both the success path and the accepted-then-threw catch (GitHub r5 P1): a failed status sync never hands the claim back on a texted link.
    expect(completion.match(/completionInvoiceLinkDelivered = true;/g)).toHaveLength(2);
    expect(completion).toMatch(/completionSmsProviderAccepted = smsResult\.sent === true;[\s\S]{0,900}?if \(completionSmsProviderAccepted && invoice\?\.id && invoiceCreated && payUrl && allowCompletionInvoiceLink\) \{\s*completionInvoiceLinkDelivered = true;\s*\}/);
    expect(completion).toMatch(/if \(invoice\?\.id && invoiceCreated && payUrl && snap\.invoiceLinkAllowed\) \{[\s\S]{0,300}?completionInvoiceLinkDelivered = true;\s*try \{\s*const InvoiceService = require\('\.\.\/services\/invoice'\);\s*invoice = await InvoiceService\.markDeliverySent/);
    expect(completion).not.toMatch(/markDeliverySent\([\s\S]{0,200}?\}\);\s*completionInvoiceLinkDelivered = true;/);
    // ONE release, in the outer finally — covers the normal end, the 503 resume returns and a throw.
    expect(completion).toMatch(/throw err;\s*\} finally \{[\s\S]{0,900}?if \(completionInvoiceSendClaim\?\.claimed && !completionInvoiceLinkDelivered\) \{\s*await require\('\.\.\/services\/invoice'\)\.restoreSendClaim\(completionInvoiceSendClaim\.invoiceId, completionInvoiceSendClaim\.previousStatus, true\);[\s\S]{0,120}?\}\s*\}\s*\}\s*\n\s*module\.exports = \{/);
    expect(completion.match(/restoreSendClaim\(completionInvoiceSendClaim\.invoiceId/g)).toHaveLength(1);
  });

  // Codex round 16 P1 #4131: the Dispatch feed's checkoutInvoice fetch used
  // to exclude ONLY 'void' — a canceled invoice that still carried sent_at
  // (from before it was canceled) was read as the visit's "current"
  // invoice, and completionInvoiceAlreadyDelivered reported it delivered
  // even though nobody can ever collect on it. Both the Dispatch feed and
  // the schedule feeds now filter on the ONE shared DEAD_INVOICE_STATUSES
  // set (invoice-helpers.js), so they can never drift apart again.
  test('canceled + sent_at is excluded by DEAD_INVOICE_STATUSES — the flag a stale narrower filter would have reported true is false', () => {
    const { DEAD_INVOICE_STATUSES, completionInvoiceAlreadyDelivered } = require('../services/invoice-helpers');
    expect(DEAD_INVOICE_STATUSES).toEqual(['void', 'canceled', 'cancelled']);

    // The exact bug: a canceled invoice with a stale sent_at stamp reads as
    // delivered once selected — the fix is that it's never selected.
    const canceledWithSentAt = { status: 'canceled', sent_at: new Date('2026-01-01') };
    expect(completionInvoiceAlreadyDelivered(canceledWithSentAt)).toBe(true);
    // The OLD filter (exclude only 'void') would have let this row through.
    expect(canceledWithSentAt.status).not.toBe('void');
    // The FIX: DEAD_INVOICE_STATUSES excludes it before completionInvoiceAlreadyDelivered
    // ever sees it — simulating the query's WHERE clause directly.
    const invoiceRows = [canceledWithSentAt, { status: 'cancelled', sent_at: new Date() }, { status: 'draft', sent_at: null }];
    const selectable = invoiceRows.filter((row) => !DEAD_INVOICE_STATUSES.includes(row.status));
    expect(selectable).toEqual([{ status: 'draft', sent_at: null }]);
    // The newest non-dead invoice is what the feed derives the flag from —
    // here, an undelivered draft, so the flag is false.
    expect(completionInvoiceAlreadyDelivered(selectable[0] || null)).toBe(false);

    // Both consumers filter on this SAME shared set (Codex round 16 P1
    // #4131) — not local, possibly-drifting copies.
    const dispatch = fs.readFileSync(path.join(__dirname, '../routes/admin-dispatch.js'), 'utf8');
    expect(dispatch).toMatch(/const \{ DEAD_INVOICE_STATUSES \} = require\('\.\.\/services\/invoice-helpers'\);[\s\S]{0,200}?checkoutInvoice = await db\('invoices'\)[\s\S]{0,100}?\.where\(\{ scheduled_service_id: s\.id \}\)[\s\S]{0,50}?\.whereNotIn\('status', DEAD_INVOICE_STATUSES\)/);
    const schedule = fs.readFileSync(path.join(__dirname, '../routes/admin-schedule.js'), 'utf8');
    expect(schedule).toMatch(/const \{ DEAD_INVOICE_STATUSES: DEAD_ATTACHED_INVOICE_STATUSES \} = require\('\.\.\/services\/invoice-helpers'\);/);
    expect(schedule.match(/\.whereNotIn\('status', DEAD_ATTACHED_INVOICE_STATUSES\)/g).length).toBeGreaterThanOrEqual(2);
  });
});
