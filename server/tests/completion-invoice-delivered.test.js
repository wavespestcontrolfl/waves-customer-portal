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
  const state = { status: 'draft', sent_at: null, queuedCompletionText: null };
  const chain = (table) => {
    const q = {};
    q.where = jest.fn(() => q);
    q.whereIn = jest.fn(() => q);
    q.whereRaw = jest.fn(() => q);
    q.first = jest.fn(async () => (table === 'sms_log'
      ? state.queuedCompletionText
      : { id: 'inv-1', status: state.status, sent_at: state.sent_at }));
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
          cancels.push({ values, where: q.where.mock.calls[q.where.mock.calls.length - 1][0], raw: q.whereRaw.mock.calls.map((c) => c[0]) });
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
      expect(cancels[0].where).toEqual({ status: 'scheduled' });
      expect(cancels[0].values.status).toBe('cancelled');
      expect(cancels[0].raw).toEqual(expect.arrayContaining(["metadata->>'entry_point' = ?", "metadata->>'invoice_id' = ?"]));
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
    expect(completion).toMatch(/const claim = await InvoiceServiceForClaim\.claimInvoiceForSend\(invoice\.id\);[\s\S]{0,600}?if \(require\('\.\.\/services\/invoice-helpers'\)\.completionInvoiceAlreadyDelivered\(claim\.invoice\)\) \{\s*await InvoiceServiceForClaim\.restoreSendClaim\(invoice\.id, claim\.previousStatus, claim\.claimed\);[\s\S]{0,300}?reusedInvoiceClaimedElsewhere = true;\s*\} else \{\s*completionInvoiceSendClaim = \{ invoiceId: invoice\.id, previousStatus: claim\.previousStatus, claimed: claim\.claimed \};/);
    // The claim is attempted only when every other pay-link gate already passes.
    // …including a decline notice that already delivered the link (GitHub r6 P1): report-only, no claim.
    expect(completion).toMatch(/const linkOtherwiseEligible = !suppressCompletionInvoiceLink\s*&& includePayLink !== false[\s\S]{0,2200}?&& !invoice\?\.payer_id\s*(?:\/\/[^\n]*\n\s*)*&& !paymentFailedNoticeSent;[\s\S]{0,1200}?if \(linkOtherwiseEligible && preMintedInvoice && invoice\?\.id/);
    expect(completion).toMatch(/const allowCompletionInvoiceLink = linkOtherwiseEligible && !reusedInvoiceClaimedElsewhere;/);
    expect(completion).not.toMatch(/allowCompletionInvoiceLinkBase/);
    // A refused claim is classified: settled/gone → report-only; in-flight send or transient failure → the resumable 503 (retryable delivery).
    // A queued pay-link text (any of the three send-window queues) is a durable delivery owner → report-only, never the 503.
    expect(completion).toMatch(/const nothingLeftToDeliver = claimErr\?\.code === 'queued_pay_link'\s*\|\| \/Cannot send a \(paid\|prepaid\|voided\) invoice\|Cannot send an invoice while payment is processing\|Invoice not found\|Invoice is not sendable\/i\.test\(claimMessage\);\s*if \(!nothingLeftToDeliver\) \{[\s\S]{0,300}?return exitForCompletionSmsResume\(new Error\(`Invoice \$\{invoice\.id\} delivery claim unavailable: \$\{claimMessage\}`\)\);/);
    // …and the completion's claim carries no adoptsQueuedInvoiceSend: a queued invoice_send_deferred row refuses it too.
    expect(completion).toMatch(/const claim = await InvoiceServiceForClaim\.claimInvoiceForSend\(invoice\.id\);/);
    // The link is delivered at PROVIDER ACCEPTANCE, before markDeliverySent, on both the success path and the accepted-then-threw catch (GitHub r5 P1): a failed status sync never hands the claim back on a texted link.
    expect(completion.match(/completionInvoiceLinkDelivered = true;/g)).toHaveLength(2);
    expect(completion).toMatch(/completionSmsProviderAccepted = smsResult\.sent === true;[\s\S]{0,900}?if \(completionSmsProviderAccepted && invoice\?\.id && invoiceCreated && payUrl && allowCompletionInvoiceLink\) \{\s*completionInvoiceLinkDelivered = true;\s*\}/);
    expect(completion).toMatch(/if \(invoice\?\.id && invoiceCreated && payUrl && snap\.invoiceLinkAllowed\) \{[\s\S]{0,300}?completionInvoiceLinkDelivered = true;\s*try \{\s*const InvoiceService = require\('\.\.\/services\/invoice'\);\s*invoice = await InvoiceService\.markDeliverySent/);
    expect(completion).not.toMatch(/markDeliverySent\([\s\S]{0,200}?\}\);\s*completionInvoiceLinkDelivered = true;/);
    // ONE release, in the outer finally — covers the normal end, the 503 resume returns and a throw.
    expect(completion).toMatch(/throw err;\s*\} finally \{[\s\S]{0,900}?if \(completionInvoiceSendClaim\?\.claimed && !completionInvoiceLinkDelivered\) \{\s*await require\('\.\.\/services\/invoice'\)\.restoreSendClaim\(completionInvoiceSendClaim\.invoiceId, completionInvoiceSendClaim\.previousStatus, true\);[\s\S]{0,120}?\}\s*\}\s*\}\s*\n\s*module\.exports = \{/);
    expect(completion.match(/restoreSendClaim\(completionInvoiceSendClaim\.invoiceId/g)).toHaveLength(1);
  });
});
