/**
 * Post-delivery finalization for a completion text that was held by the
 * 8AM-8PM ET send window and replayed off the scheduled-SMS rail.
 *
 * The immediate dispatch-completion path runs its success bookkeeping
 * inline (admin-dispatch.js): invoice draft→sent via markDeliverySent, the
 * bundled inline review request marked delivered, the combined paid-receipt
 * claim stamped, a service_report_events row, and the structured-notes
 * status. A deferred send leaves the visit before any of that ran — the
 * queued sms_log row carries the references (invoice_id,
 * bundled_review_request_id, …) and the scheduled-SMS executor calls this
 * AFTER the provider accepted the replay, so the same state transitions
 * happen at actual delivery, never at enqueue (a terminally-blocked replay
 * must leave the invoice in draft on the operator's radar, not fake-sent).
 *
 * Every step is independent + best-effort: one failure must not stop the
 * others, and the executor's own sent bookkeeping already committed.
 */

const db = require('../models/db');
const logger = require('./logger');

async function finalizeDeferredCompletionSend(claimMeta = {}, { retry = false } = {}) {
  const recordId = claimMeta.service_record_id || null;
  const sentAtIso = new Date().toISOString();
  // ok covers the STATE steps (invoice flip, review mark, receipt claim).
  // All three are idempotent, so the executor can re-run this whole
  // function from a finalize_only retry row when any of them failed —
  // without that retry, one transient DB error after the SMS delivered
  // would permanently leave the invoice in draft or double-send the
  // review ask. The notes/event writes below stay cosmetic best-effort
  // (an event-row duplicate on retry would mislead analytics, a missed
  // one loses nothing).
  let ok = true;

  // Invoice pay link delivered → draft becomes sent, follow-ups schedule.
  if (claimMeta.mark_invoice_delivery === true && claimMeta.invoice_id) {
    try {
      const InvoiceService = require('./invoice');
      await InvoiceService.markDeliverySent(claimMeta.invoice_id, {
        sms: true,
        source: claimMeta.original_message_type || 'completion_sms_with_invoice',
        payUrl: claimMeta.pay_url || null,
      });
    } catch (err) {
      ok = false;
      logger.warn(`[completion-deferred] invoice delivery sync failed for ${claimMeta.invoice_id}: ${err.message}`);
    }
  }

  // Bundled inline review link rode inside the delivered body — mark the
  // request delivered so the standalone review sender (armed as a safety
  // net at enqueue) skips instead of double-texting the ask.
  if (claimMeta.bundled_review_request_id) {
    try {
      const ReviewService = require('./review-request');
      await ReviewService.markInlineDelivered(claimMeta.bundled_review_request_id);
    } catch (err) {
      ok = false;
      logger.warn(`[completion-deferred] inline review delivery mark failed for ${claimMeta.bundled_review_request_id}: ${err.message}`);
    }
  }

  // Combined completion+receipt copy delivered → claim the receipt so the
  // deferred receipt job skips its SMS leg (same stamp as the immediate
  // path; only-on-null keeps it idempotent).
  if (claimMeta.stamp_receipt_invoice_id) {
    try {
      await db('invoices')
        .where({ id: claimMeta.stamp_receipt_invoice_id })
        .whereNull('receipt_sent_at')
        .update({ receipt_sent_at: db.fn.now(), updated_at: new Date() });
    } catch (err) {
      ok = false;
      logger.warn(`[completion-deferred] combined-receipt claim failed for invoice ${claimMeta.stamp_receipt_invoice_id}: ${err.message}`);
    }
  }

  if (recordId) {
    // Same key-merge shape as the route's mergeRecordNotesKeys — never a
    // whole-column write (structured_notes has concurrent writers).
    try {
      await db('service_records').where({ id: recordId }).update({
        structured_notes: db.raw(
          "COALESCE(structured_notes::jsonb, '{}'::jsonb) || ?::jsonb",
          [JSON.stringify({ completionSmsStatus: 'sent', completionSmsDeferredDeliveredAt: sentAtIso })],
        ),
      });
    } catch (err) {
      logger.warn(`[completion-deferred] notes update failed for record ${recordId}: ${err.message}`);
    }
    // Not on retries — the event insert is not idempotent and a duplicate
    // row would mislead the report analytics; the first pass owns it.
    if (!retry) {
      try {
        await db('service_report_events').insert({
          service_record_id: recordId,
          customer_id: claimMeta.customer_id || null,
          event_name: 'sms_sent',
          channel: 'sms',
          metadata: JSON.stringify({ deferred_send_window: true }),
        });
      } catch (err) {
        logger.warn(`[completion-deferred] report event insert failed for record ${recordId}: ${err.message}`);
      }
    }
  }
  return { ok };
}

// Post-delivery finalization for the DECLINE NOTICE (`payment_failed`
// template) held by the send window at completion time. The inline success
// path finalizes the invoice as delivered (the notice carried the pay
// link) and stamps the structured-notes status; a deferred send must run
// the same transitions at actual delivery. Both steps idempotent — rides
// the finalize_pending durability rail.
async function finalizeDeferredDeclineNotice(claimMeta = {}) {
  let ok = true;
  if (claimMeta.invoice_id) {
    try {
      const InvoiceService = require('./invoice');
      await InvoiceService.markDeliverySent(claimMeta.invoice_id, {
        sms: true,
        source: 'payment_failed_notice',
        payUrl: claimMeta.pay_url || null,
      });
    } catch (err) {
      ok = false;
      logger.warn(`[completion-deferred] decline-notice invoice delivery sync failed for ${claimMeta.invoice_id}: ${err.message}`);
    }
  }
  if (claimMeta.service_record_id) {
    try {
      await db('service_records').where({ id: claimMeta.service_record_id }).update({
        structured_notes: db.raw(
          "COALESCE(structured_notes::jsonb, '{}'::jsonb) || ?::jsonb",
          [JSON.stringify({ paymentFailedNoticeStatus: 'sent', paymentFailedNoticeSentAt: new Date().toISOString() })],
        ),
      });
    } catch (err) {
      ok = false;
      logger.warn(`[completion-deferred] decline-notice notes update failed for record ${claimMeta.service_record_id}: ${err.message}`);
    }
  }
  return { ok };
}

// Terminally-blocked completion replay: restore the inline-failure state
// ('failed', same key shape as admin-dispatch's inline failure writes)
// instead of leaving 'deferred' — completionSmsAlreadyHandled treats
// 'deferred' as an owned obligation on every later completion attempt, so
// a replay that terminally died (phone removed, opted out, retries
// exhausted) would otherwise block the report/pay-link text forever, even
// after the operator fixes the phone and re-completes.
async function terminalDeferredCompletionSend(claimMeta = {}) {
  if (!claimMeta.service_record_id) return;
  await db('service_records').where({ id: claimMeta.service_record_id }).update({
    structured_notes: db.raw(
      "COALESCE(structured_notes::jsonb, '{}'::jsonb) || ?::jsonb",
      [JSON.stringify({
        completionSmsStatus: 'failed',
        completionSmsError: 'deferred replay terminally blocked',
        completionSmsFailedAt: new Date().toISOString(),
      })],
    ),
  });
  logger.warn(`[completion-deferred] completion SMS for record ${claimMeta.service_record_id} terminally blocked — status restored to failed`);
}

// Terminally-blocked decline-notice replay: restore the inline-failure
// state ('failed', which a later completion resume may retry) instead of
// leaving 'deferred' — the resume dedupe treats 'deferred' as handled, so
// a stuck 'deferred' would block every future re-attempt of the notice.
async function terminalDeferredDeclineNotice(claimMeta = {}) {
  if (!claimMeta.service_record_id) return;
  await db('service_records').where({ id: claimMeta.service_record_id }).update({
    structured_notes: db.raw(
      "COALESCE(structured_notes::jsonb, '{}'::jsonb) || ?::jsonb",
      [JSON.stringify({ paymentFailedNoticeStatus: 'failed', paymentFailedNoticeError: 'deferred replay terminally blocked' })],
    ),
  });
  logger.warn(`[completion-deferred] decline notice for record ${claimMeta.service_record_id} terminally blocked — status restored to failed`);
}

module.exports = { finalizeDeferredCompletionSend, finalizeDeferredDeclineNotice, terminalDeferredCompletionSend, terminalDeferredDeclineNotice };
