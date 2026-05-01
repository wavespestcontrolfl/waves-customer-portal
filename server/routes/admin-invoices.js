const express = require('express');
const router = express.Router();
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
const InvoiceService = require('../services/invoice');
const db = require('../models/db');
const logger = require('../services/logger');
const { etDateString } = require('../utils/datetime-et');

router.use(adminAuthenticate, requireTechOrAdmin);

// GET /stats
router.get('/stats', async (req, res, next) => {
  try {
    const stats = await InvoiceService.getStats();
    res.json(stats);
  } catch (err) { next(err); }
});

// GET / — list invoices
router.get('/', async (req, res, next) => {
  try {
    const { status, customer_id, limit = 50, page = 1, archived: archivedRaw } = req.query;
    // archived=only → archived-only view; archived=all → include both.
    // Default (any other value or unset) = hide archived.
    const archived = archivedRaw === 'only' || archivedRaw === '1' || archivedRaw === 'true'
      ? 'only'
      : archivedRaw === 'all'
      ? 'all'
      : 'hide';
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const { invoices, total } = await InvoiceService.list({
      status, customerId: customer_id, limit: parseInt(limit), offset, archived,
    });
    res.json({ invoices, total, page: parseInt(page) });
  } catch (err) { next(err); }
});

// GET /customers/search — quick customer search for invoice creation
router.get('/customers/search', async (req, res, next) => {
  try {
    const { q } = req.query;
    if (!q) return res.json({ customers: [] });
    const customers = await db('customers')
      .where(function () {
        this.whereRaw("LOWER(first_name || ' ' || last_name) LIKE ?", [`%${q.toLowerCase()}%`])
          .orWhere('phone', 'like', `%${q}%`)
          .orWhere('email', 'like', `%${q.toLowerCase()}%`);
      })
      .where({ active: true })
      .select('id', 'first_name', 'last_name', 'phone', 'email', 'waveguard_tier', 'address_line1', 'city')
      .limit(10);
    res.json({ customers });
  } catch (err) { next(err); }
});

// GET /service-records/:customerId — get recent services for a customer (to link invoice)
router.get('/service-records/:customerId', async (req, res, next) => {
  try {
    const records = await db('service_records')
      .where({ customer_id: req.params.customerId })
      .leftJoin('technicians', 'service_records.technician_id', 'technicians.id')
      .select('service_records.id', 'service_records.service_date', 'service_records.service_type',
        'service_records.status', 'technicians.name as tech_name')
      .orderBy('service_date', 'desc')
      .limit(20);
    res.json({ records });
  } catch (err) { next(err); }
});

// GET /:id — single invoice with full details
router.get('/:id', async (req, res, next) => {
  try {
    const invoice = await InvoiceService.getById(req.params.id);
    if (!invoice) return res.status(404).json({ error: 'Not found' });
    res.json(invoice);
  } catch (err) { next(err); }
});

// POST / — create invoice manually
router.post('/', async (req, res, next) => {
  try {
    const { customerId, serviceRecordId, title, lineItems, notes, dueDate, taxRate, discountIds } = req.body;
    if (!customerId) return res.status(400).json({ error: 'customerId required' });
    if (!lineItems?.length) return res.status(400).json({ error: 'lineItems required' });

    const invoice = await InvoiceService.create({
      customerId, serviceRecordId, title, lineItems, notes, dueDate, taxRate, discountIds,
    });

    const domain = process.env.CLIENT_URL || 'https://portal.wavespestcontrol.com';
    res.status(201).json({
      ...invoice,
      payUrl: `${domain}/pay/${invoice.token}`,
    });
  } catch (err) { next(err); }
});

// POST /from-service — create from service record (convenience)
router.post('/from-service', async (req, res, next) => {
  try {
    const { serviceRecordId, amount, description, taxRate } = req.body;
    if (!serviceRecordId) return res.status(400).json({ error: 'serviceRecordId required' });
    if (!amount) return res.status(400).json({ error: 'amount required' });

    const invoice = await InvoiceService.createFromService(serviceRecordId, {
      amount: parseFloat(amount), description, taxRate,
    });

    const domain = process.env.CLIENT_URL || 'https://portal.wavespestcontrol.com';
    res.status(201).json({
      ...invoice,
      payUrl: `${domain}/pay/${invoice.token}`,
    });
  } catch (err) { next(err); }
});

// POST /batch — create identical invoice for multiple customers
// Body: { customerIds: string[], title, lineItems, notes?, dueDate?, taxRate?, sendImmediately?: boolean }
router.post('/batch', async (req, res, next) => {
  try {
    const { customerIds, title, lineItems, notes, dueDate, taxRate, sendImmediately } = req.body || {};
    if (!Array.isArray(customerIds) || customerIds.length === 0) {
      return res.status(400).json({ error: 'customerIds[] required' });
    }
    if (!lineItems?.length) return res.status(400).json({ error: 'lineItems required' });

    const domain = process.env.CLIENT_URL || 'https://portal.wavespestcontrol.com';
    const created = [];
    const failed = [];

    for (const customerId of customerIds) {
      try {
        const invoice = await InvoiceService.create({
          customerId, title, lineItems, notes, dueDate, taxRate,
        });
        let sendResult = null;
        if (sendImmediately) {
          try { sendResult = await InvoiceService.sendViaSMS(invoice.id); }
          catch (sendErr) {
            logger.error(`[admin-invoices:batch] send failed for ${invoice.id}: ${sendErr.message}`);
            sendResult = { sent: false, error: sendErr.message };
          }
        }
        created.push({
          customerId,
          invoiceId: invoice.id,
          invoiceNumber: invoice.invoice_number,
          total: invoice.total,
          payUrl: `${domain}/pay/${invoice.token}`,
          sent: sendResult,
        });
      } catch (err) {
        logger.error(`[admin-invoices:batch] create failed for ${customerId}: ${err.message}`);
        failed.push({ customerId, error: err.message });
      }
    }

    res.json({
      total: customerIds.length,
      created_count: created.length,
      failed_count: failed.length,
      created,
      failed,
    });
  } catch (err) { next(err); }
});

// POST /batch/send — send multiple existing invoices via SMS + email
// Body: { invoiceIds: string[] }
router.post('/batch/send', async (req, res, next) => {
  try {
    const { invoiceIds } = req.body || {};
    if (!Array.isArray(invoiceIds) || invoiceIds.length === 0) {
      return res.status(400).json({ error: 'invoiceIds[] required' });
    }

    const { sendInvoiceEmail } = require('../services/invoice-email');
    const sent = [];
    const failed = [];

    for (const invoiceId of invoiceIds) {
      const ok = { sms: false, email: false };
      const errs = [];
      try {
        await InvoiceService.sendViaSMS(invoiceId);
        ok.sms = true;
      } catch (err) {
        errs.push(`sms: ${err.message}`);
      }
      try {
        const r = await sendInvoiceEmail(invoiceId);
        if (r?.ok) ok.email = true;
        else if (r?.error) errs.push(`email: ${r.error}`);
      } catch (err) {
        errs.push(`email: ${err.message}`);
      }
      if (ok.sms || ok.email) {
        sent.push({ invoiceId, channels: ok });
      } else {
        logger.error(`[admin-invoices:batch-send] ${invoiceId}: ${errs.join(' | ')}`);
        failed.push({ invoiceId, error: errs.join(' | ') });
      }
    }

    res.json({
      total: invoiceIds.length,
      sent_count: sent.length,
      failed_count: failed.length,
      sent,
      failed,
    });
  } catch (err) { next(err); }
});

// POST /batch/send-receipts — resend receipts for multiple paid invoices.
// Same shape as /batch/send but gated to status='paid' (skipped otherwise)
// and capped at BATCH_RECEIPT_MAX to prevent accidental mass-sends from
// the Needs-receipt filter. Each invoice goes through the same email +
// SMS pipeline as /:id/send-receipt so behavior matches single-send.
const BATCH_RECEIPT_MAX = 25;
router.post('/batch/send-receipts', async (req, res, next) => {
  try {
    const { invoiceIds } = req.body || {};
    if (!Array.isArray(invoiceIds) || invoiceIds.length === 0) {
      return res.status(400).json({ error: 'invoiceIds[] required' });
    }
    if (invoiceIds.length > BATCH_RECEIPT_MAX) {
      return res.status(400).json({ error: `Batch receipt send limited to ${BATCH_RECEIPT_MAX} invoices at a time` });
    }

    const { sendReceiptEmail } = require('../services/invoice-email');
    const sent = [];
    const failed = [];
    const skipped = [];

    for (const invoiceId of invoiceIds) {
      const invoice = await db('invoices').where({ id: invoiceId }).first();
      if (!invoice) {
        failed.push({ invoiceId, error: 'not found' });
        continue;
      }
      if (invoice.status !== 'paid') {
        skipped.push({ invoiceId, reason: `status=${invoice.status}` });
        continue;
      }

      let emailOk = false;
      let smsOk = false;
      const errs = [];

      try {
        const r = await sendReceiptEmail(invoiceId);
        if (r?.ok) emailOk = true;
        else if (r?.error) errs.push(`email: ${r.error}`);
      } catch (err) {
        errs.push(`email: ${err.message}`);
      }

      try {
        await InvoiceService.sendReceipt(invoiceId);
        smsOk = true;
      } catch (err) {
        errs.push(`sms: ${err.message}`);
      }

      if (emailOk || smsOk) {
        await db('invoices').where({ id: invoiceId }).update({
          receipt_sent_at: db.fn.now(),
        });
        await db('activity_log').insert({
          customer_id: invoice.customer_id,
          action: 'invoice_receipt_sent',
          description: `Receipt sent for invoice ${invoice.invoice_number}`
            + ` (${[emailOk && 'email', smsOk && 'sms'].filter(Boolean).join(' + ')})`
            + ' — batch',
        }).catch((err) => logger.warn(`[admin-invoices:batch-send-receipts] activity_log insert failed: ${err.message}`));
        sent.push({ invoiceId, channels: { email: emailOk, sms: smsOk } });
      } else {
        logger.error(`[admin-invoices:batch-send-receipts] ${invoiceId}: ${errs.join(' | ')}`);
        failed.push({ invoiceId, error: errs.join(' | ') || 'no channel succeeded' });
      }
    }

    res.json({
      total: invoiceIds.length,
      sent_count: sent.length,
      failed_count: failed.length,
      skipped_count: skipped.length,
      sent,
      failed,
      skipped,
    });
  } catch (err) { next(err); }
});

// PUT /:id — update invoice
router.put('/:id', async (req, res, next) => {
  try {
    const invoice = await InvoiceService.update(req.params.id, req.body);
    if (!invoice) return res.status(404).json({ error: 'Not found' });
    res.json(invoice);
  } catch (err) { next(err); }
});

// Shared dispatch — used by the route's immediate path AND the scheduled-send
// cron tick. Either channel failing alone doesn't abort the other; missing
// phone / email is treated as channel-skipped, not an error. Idempotent
// cleanup at the bottom transitions a status='scheduled' row back to 'sent'
// once one channel lands so the cron can stop picking it up.
async function sendInvoiceNow(invoiceId, { sendMethod = 'both', requestReview = false } = {}) {
  const { sendInvoiceEmail } = require('../services/invoice-email');

  const sms = { ok: false };
  const email = { ok: false };

  if (sendMethod === 'sms' || sendMethod === 'both') {
    try {
      await InvoiceService.sendViaSMS(invoiceId);
      sms.ok = true;
    } catch (err) {
      sms.error = err.message;
    }
  }

  if (sendMethod === 'email' || sendMethod === 'both') {
    try {
      const r = await sendInvoiceEmail(invoiceId);
      if (r?.ok) email.ok = true;
      else if (r?.error) email.error = r.error;
    } catch (err) {
      email.error = err.message;
    }
  }

  // InvoiceService.sendViaSMS only flips draft → sent. A scheduled-send row
  // therefore stays status='scheduled' after dispatch; clear it explicitly
  // so the cron tick stops re-picking it up. We also fire any deferred
  // review-request the user opted into at scheduling time — only now that
  // we know at least one channel landed, mirroring the immediate-path
  // gating so a delivery failure doesn't ask the customer to review an
  // invoice they never got.
  if (sms.ok || email.ok) {
    try {
      const inv = await db('invoices').where({ id: invoiceId })
        .select('status', 'request_review_after_send', 'customer_id', 'service_record_id')
        .first();

      if (inv) {
        const queuedReview = !!inv.request_review_after_send;
        const wasScheduled = inv.status === 'scheduled';

        // Status / scheduling cleanup happens unconditionally on success.
        // The deferred-review flag stays set across this update — we only
        // clear it AFTER ReviewService.create lands, so a transient throw
        // there doesn't permanently drop the follow-up. If it does throw,
        // the flag remains true and is at least queryable / replayable.
        if (wasScheduled) {
          await db('invoices').where({ id: invoiceId }).update({
            status: 'sent',
            scheduled_at: null,
            send_method: null,
            send_claim_at: null,
            updated_at: new Date(),
          });
        }

        if (requestReview || queuedReview) {
          try {
            const ReviewService = require('../services/review-request');
            await ReviewService.create({
              customerId: inv.customer_id,
              serviceRecordId: inv.service_record_id || null,
              triggeredBy: 'auto',
              delayMinutes: 120,
            });
            if (queuedReview) {
              await db('invoices').where({ id: invoiceId }).update({
                request_review_after_send: false,
                updated_at: new Date(),
              });
            }
          } catch (err) {
            logger.error(`[admin-invoices] Review request schedule failed: ${err.message}`);
          }
        }
      }
    } catch (err) {
      logger.error(`[admin-invoices] post-send schedule cleanup failed: ${err.message}`);
    }
  }

  return { sms, email };
}

// POST /:id/send — send invoice via SMS + email, immediately or scheduled.
// Body: { requestReview?: boolean, scheduledAt?: ISO string, sendMethod?: 'sms'|'email'|'both' }
// When `scheduledAt` is set to a future instant, the row is flipped to
// status='scheduled' and the scheduler.js 5-minute cron picks it up; the
// review request (if requested) is queued at scheduledAt + 2h via the
// existing ReviewService.scheduled_for path. Either channel failing alone
// doesn't abort the other on the immediate path.
router.post('/:id/send', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { requestReview, scheduledAt, sendMethod } = req.body || {};

    // Reject unknown send_method values up front. sendInvoiceNow only
    // dispatches channels for sms|email|both — anything else would cause
    // both branches to skip, leaving a scheduled row to thrash through
    // cron retries forever without ever delivering.
    const finalSendMethod = sendMethod || 'both';
    if (!['sms', 'email', 'both'].includes(finalSendMethod)) {
      return res.status(400).json({ error: "sendMethod must be 'sms', 'email', or 'both'" });
    }

    // ── SCHEDULED PATH ──
    // Persist the user's review-request intent on the row instead of
    // queuing it now: sendInvoiceNow fires it post-delivery, gating on
    // sms.ok || email.ok the same way the immediate path does. That way
    // a cron-time delivery failure doesn't leave the customer with a
    // review prompt for an invoice they never received.
    if (scheduledAt) {
      const when = new Date(scheduledAt);
      if (isNaN(when.getTime())) return res.status(400).json({ error: 'Invalid scheduledAt' });
      if (when <= new Date()) return res.status(400).json({ error: 'scheduledAt must be in the future' });

      const updated = await db('invoices').where({ id }).update({
        status: 'scheduled',
        scheduled_at: when,
        send_method: finalSendMethod,
        request_review_after_send: !!requestReview,
        updated_at: new Date(),
      });
      if (!updated) return res.status(404).json({ error: 'Invoice not found' });

      return res.json({ ok: true, scheduled: true, scheduledAt: when.toISOString() });
    }

    // ── IMMEDIATE PATH ──
    // sendInvoiceNow handles the review-request gating internally so the
    // immediate and cron-driven paths share one source of truth.
    const { sms, email } = await sendInvoiceNow(id, {
      sendMethod: finalSendMethod,
      requestReview: !!requestReview,
    });

    if (!sms.ok && !email.ok) {
      return res.status(500).json({ ok: false, sms, email });
    }
    res.json({ ok: true, sms, email });
  } catch (err) { next(err); }
});

// Export for cron usage
router.sendInvoiceNow = sendInvoiceNow;

// POST /:id/charge-card — charge a saved card on file against this invoice.
// Body: { paymentMethodId } (our internal payment_methods.id).
// The card must belong to the invoice customer. Succeeds by calling
// Stripe off-session with confirm:true; webhook marks the invoice paid.
router.post('/:id/charge-card', async (req, res, next) => {
  try {
    const { paymentMethodId } = req.body || {};
    if (!paymentMethodId) return res.status(400).json({ error: 'paymentMethodId required' });

    const StripeService = require('../services/stripe');
    const result = await StripeService.chargeInvoiceWithSavedCard(req.params.id, paymentMethodId);
    res.json({ success: true, ...result });
  } catch (err) {
    logger.error(`[admin-invoices] charge-card failed: ${err.message}`);
    res.status(400).json({ error: err.message });
  }
});

// POST /:id/void — void invoice
router.post('/:id/void', async (req, res, next) => {
  try {
    const invoice = await InvoiceService.voidInvoice(req.params.id);
    res.json(invoice);
  } catch (err) { next(err); }
});

// POST /:id/archive — tuck a voided invoice out of the default list view.
// Void-only precondition: refusing paid/sent/draft because "archive" is
// meaningful only as a final shelving step on a row that has no activity
// left. Returns the updated row so the UI can update in place.
router.post('/:id/archive', async (req, res, next) => {
  try {
    const invoice = await db('invoices').where({ id: req.params.id }).first();
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    if (invoice.status !== 'void') {
      return res.status(400).json({ error: `Only voided invoices can be archived (current status: ${invoice.status})` });
    }
    if (invoice.archived_at) return res.json(invoice);  // idempotent
    const [updated] = await db('invoices')
      .where({ id: req.params.id })
      .update({ archived_at: db.fn.now(), updated_at: db.fn.now() })
      .returning('*');
    res.json(updated);
  } catch (err) { next(err); }
});

// POST /:id/unarchive — pulls an archived invoice back into the default view.
router.post('/:id/unarchive', async (req, res, next) => {
  try {
    const invoice = await db('invoices').where({ id: req.params.id }).first();
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    if (!invoice.archived_at) return res.json(invoice);  // idempotent
    const [updated] = await db('invoices')
      .where({ id: req.params.id })
      .update({ archived_at: null, updated_at: db.fn.now() })
      .returning('*');
    res.json(updated);
  } catch (err) { next(err); }
});

// POST /:id/send-receipt — operator-triggered receipt delivery for a paid
// invoice. Hits the branded email + the invoice_receipt SMS template, then
// stamps invoices.receipt_sent_at so the UI can mark the service closed.
// Body: { memo?: string (≤400 chars), via?: 'email'|'sms'|'both' (default 'both') }
router.post('/:id/send-receipt', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { memo, via = 'both' } = req.body || {};
    if (!['email', 'sms', 'both'].includes(via)) {
      return res.status(400).json({ error: "via must be 'email', 'sms', or 'both'" });
    }
    const trimmedMemo = typeof memo === 'string' ? memo.trim().slice(0, 400) : '';

    const invoice = await db('invoices').where({ id }).first();
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    if (invoice.status !== 'paid') {
      return res.status(400).json({ error: 'Invoice is not paid — receipt can only be sent for paid invoices' });
    }

    const { sendReceiptEmail } = require('../services/invoice-email');

    let emailResult = { ok: false, skipped: true };
    let smsResult = { ok: false, skipped: true };

    if (via === 'email' || via === 'both') {
      emailResult = await sendReceiptEmail(id, { memo: trimmedMemo }).catch((err) => ({ ok: false, error: err.message }));
    }
    if (via === 'sms' || via === 'both') {
      // Manual operator resend — pass force:true to override the auto-send
      // idempotency guard (otherwise re-clicking SEND RECEIPT would no-op
      // for invoices already auto-receipted by the Stripe webhook).
      // recordActivity:false because this route writes its own activity_log
      // row below with the memo and channel mix.
      try {
        await InvoiceService.sendReceipt(id, { force: true, recordActivity: false });
        smsResult = { ok: true };
      } catch (err) {
        smsResult = { ok: false, error: err.message };
      }
    }

    // Stamp receipt metadata whenever at least one channel succeeded. If
    // both failed, leave receipt_sent_at NULL so the operator can retry.
    if (emailResult.ok || smsResult.ok) {
      await db('invoices').where({ id }).update({
        receipt_sent_at: db.fn.now(),
        receipt_memo: trimmedMemo || null,
      });
      await db('activity_log').insert({
        customer_id: invoice.customer_id,
        action: 'invoice_receipt_sent',
        description: `Receipt sent for invoice ${invoice.invoice_number}`
          + ` (${[emailResult.ok && 'email', smsResult.ok && 'sms'].filter(Boolean).join(' + ')})`
          + (trimmedMemo ? ` — memo: ${trimmedMemo.slice(0, 80)}${trimmedMemo.length > 80 ? '…' : ''}` : ''),
      }).catch((err) => logger.warn(`[admin-invoices] activity_log insert failed: ${err.message}`));
    }

    const updated = await db('invoices').where({ id }).first();
    res.json({
      ok: emailResult.ok || smsResult.ok,
      email: emailResult,
      sms: smsResult,
      invoice: updated,
    });
  } catch (err) { next(err); }
});

// POST /:id/record-payment — log an off-Stripe payment (cash, check,
// Zelle, or other) against an open invoice. Marks the invoice paid,
// stops the follow-up sequence, and optionally fires the receipt in
// the same call so the operator can close the bill in one tap.
//
// Body: {
//   method:       'cash' | 'check' | 'zelle' | 'other'  (required)
//   reference?:   string  — check #, Zelle confirmation, etc.  (≤200 chars)
//   note?:        string  — operator note appended to invoice notes  (≤400 chars)
//   sendReceipt?: boolean — fire receipt SMS/email after marking paid (default true)
//   via?:         'email' | 'sms' | 'both'  — receipt channels (default 'both')
// }
//
// Refuses to overwrite an already-paid invoice (use refund flow first)
// and refuses to mark a void invoice paid. Stripe-paid invoices keep
// their card_brand/card_last_four; manual payments leave those NULL so
// timeline rendering can distinguish.
const VALID_PAYMENT_METHODS = ['cash', 'check', 'zelle', 'other'];
router.post('/:id/record-payment', async (req, res, next) => {
  try {
    const { id } = req.params;
    const {
      method,
      reference,
      note,
      sendReceipt = true,
      via = 'both',
    } = req.body || {};

    if (!method || !VALID_PAYMENT_METHODS.includes(method)) {
      return res.status(400).json({
        error: `method must be one of: ${VALID_PAYMENT_METHODS.join(', ')}`,
      });
    }
    if (sendReceipt && !['email', 'sms', 'both'].includes(via)) {
      return res.status(400).json({ error: "via must be 'email', 'sms', or 'both'" });
    }
    const trimmedReference = typeof reference === 'string' ? reference.trim().slice(0, 200) : '';
    const trimmedNote = typeof note === 'string' ? note.trim().slice(0, 400) : '';

    const invoice = await db('invoices').where({ id }).first();
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    // Voided invoices can never be marked paid — short-circuit early so
    // we surface the right error message instead of a generic race loss.
    if (invoice.status === 'void') {
      return res.status(400).json({ error: 'Cannot record payment on a voided invoice' });
    }
    if (invoice.status === 'paid') {
      return res.status(400).json({ error: 'Invoice is already paid' });
    }
    // ACH PIs sit at status='processing' for 3–5 business days while
    // the bank transfer clears. Recording a manual cash/check/Zelle
    // payment in that window double-collects: Stripe later succeeds
    // and the webhook flips the invoice paid against the ACH PI.
    // Make the operator wait for the ACH to settle (or fail) before
    // recording a manual payment.
    if (invoice.status === 'processing') {
      return res.status(409).json({
        error: 'Invoice has a payment in flight (ACH clearing) — wait for it to settle before recording a manual payment',
      });
    }
    // Refuse to mark a $0 invoice paid — surfaces upstream creation bugs
    // instead of silently producing "$0.00 PAID" rows that misreport revenue.
    if (parseFloat(invoice.total || 0) <= 0) {
      return res.status(400).json({ error: 'Invoice has no amount to collect (total is $0)' });
    }

    const recordedBy = req.technician?.name || req.technician?.email || req.technicianId || 'admin';

    // Append operator note to invoice notes (don't clobber existing notes).
    let nextNotes = invoice.notes || null;
    if (trimmedNote) {
      const stamp = new Date().toISOString().slice(0, 10);
      const line = `[${stamp}] ${method.toUpperCase()}${trimmedReference ? ` ${trimmedReference}` : ''}: ${trimmedNote}`;
      nextNotes = nextNotes ? `${nextNotes}\n${line}` : line;
    }

    // Atomic transition. Two concurrent double-clicks both pass the
    // precheck above, but Postgres serializes UPDATEs against the same
    // row so only one of these statements actually changes anything;
    // the loser gets an empty .returning('*') and bails out before any
    // side effects (receipt send, payments-ledger insert, activity row)
    // run a second time.
    const [updatedInvoice] = await db('invoices')
      .where({ id })
      .whereNotIn('status', ['paid', 'void', 'processing'])
      .update({
        status: 'paid',
        paid_at: db.fn.now(),
        payment_method: method,
        payment_reference: trimmedReference || null,
        payment_recorded_by: recordedBy,
        payment_recorded_at: db.fn.now(),
        notes: nextNotes,
        updated_at: db.fn.now(),
      })
      .returning('*');

    if (!updatedInvoice) {
      // Lost the race to a concurrent caller (or another path marked it
      // paid in between). Re-fetch so we can return a useful 409 body.
      const current = await db('invoices').where({ id }).first();
      return res.status(409).json({
        error: 'Invoice status changed before payment could be recorded',
        current_status: current?.status,
      });
    }

    // Payments-ledger row so revenue dashboards (admin-dashboard, monthly
    // reports) sum manual cash/check/Zelle alongside Stripe collections.
    // No `processor` set — that column is reserved for actual gateways
    // (`stripe`); leaving it null is the existing convention for off-
    // gateway money (see admin-payments-reconcile.js manual branch).
    try {
      await db('payments').insert({
        customer_id: updatedInvoice.customer_id,
        amount: Number(updatedInvoice.total),
        status: 'paid',
        description: `Invoice ${updatedInvoice.invoice_number} — ${method}`
          + `${trimmedReference ? ` (${trimmedReference})` : ''}`,
        payment_date: etDateString(),
      });
    } catch (err) {
      logger.error(`[admin-invoices:record-payment] payments-ledger insert failed for ${updatedInvoice.invoice_number}: ${err.message}`);
    }

    // Stop the follow-up sequence the same way the Stripe webhook does.
    try {
      const FollowUps = require('../services/invoice-followups');
      await FollowUps.stopOnPayment(id);
    } catch (err) {
      logger.warn(`[admin-invoices:record-payment] stopOnPayment failed: ${err.message}`);
    }

    await db('activity_log').insert({
      customer_id: updatedInvoice.customer_id,
      action: 'invoice_payment_recorded',
      description: `Manual payment recorded for ${updatedInvoice.invoice_number}`
        + ` ($${Number(updatedInvoice.total).toFixed(2)} via ${method}`
        + `${trimmedReference ? ` · ref ${trimmedReference}` : ''})`
        + ` — ${recordedBy}`,
    }).catch((err) => logger.warn(`[admin-invoices:record-payment] activity_log insert failed: ${err.message}`));

    // Optional inline receipt — same pipeline as /:id/send-receipt.
    let emailResult = null;
    let smsResult = null;
    if (sendReceipt) {
      const { sendReceiptEmail } = require('../services/invoice-email');
      if (via === 'email' || via === 'both') {
        emailResult = await sendReceiptEmail(id).catch((err) => ({ ok: false, error: err.message }));
      }
      if (via === 'sms' || via === 'both') {
        try {
          await InvoiceService.sendReceipt(id, { force: true, recordActivity: false });
          smsResult = { ok: true };
        } catch (err) {
          smsResult = { ok: false, error: err.message };
        }
      }
      if (emailResult?.ok || smsResult?.ok) {
        await db('invoices').where({ id }).update({ receipt_sent_at: db.fn.now() });
        await db('activity_log').insert({
          customer_id: updatedInvoice.customer_id,
          action: 'invoice_receipt_sent',
          description: `Receipt sent for invoice ${updatedInvoice.invoice_number}`
            + ` (${[emailResult?.ok && 'email', smsResult?.ok && 'sms'].filter(Boolean).join(' + ')})`
            + ' — auto after manual payment',
        }).catch((err) => logger.warn(`[admin-invoices:record-payment] activity_log insert failed: ${err.message}`));
      }
    }

    const final = await db('invoices').where({ id }).first();
    res.json({
      ok: true,
      invoice: final,
      receipt: sendReceipt ? { email: emailResult, sms: smsResult } : null,
    });
  } catch (err) {
    logger.error(`[admin-invoices] record-payment failed: ${err.message}`);
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────
// Per-invoice follow-up sequence (Day 0/3/7/14/30 reminder chain)
// ─────────────────────────────────────────────────────────────
const FollowUps = require('../services/invoice-followups');
const followupConfig = require('../config/invoice-followups');

// GET /:id/followup — current sequence state + config
router.get('/:id/followup', async (req, res, next) => {
  try {
    const seq = await db('invoice_followup_sequences').where({ invoice_id: req.params.id }).first();
    res.json({
      sequence: seq || null,
      // Config-field rename: steps now expose daysAfterSend (PR #106
      // anchored the cadence to invoice.sent_at). daysAfterDue is kept
      // as an alias so any pre-update client still renders a number.
      steps: followupConfig.steps.map(s => ({
        id: s.id,
        label: s.label,
        daysAfterSend: s.daysAfterSend,
        daysAfterDue: s.daysAfterSend,
      })),
      autopayFailureThreshold: followupConfig.autopayFailureThreshold,
    });
  } catch (err) { next(err); }
});

// POST /:id/followup/pause
router.post('/:id/followup/pause', async (req, res, next) => {
  try {
    const { reason, until } = req.body || {};
    await FollowUps.pauseSequence(req.params.id, {
      reason, until, adminId: req.user?.id || null,
    });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// POST /:id/followup/resume
router.post('/:id/followup/resume', async (req, res, next) => {
  try {
    await FollowUps.resumeSequence(req.params.id);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// POST /:id/followup/stop
router.post('/:id/followup/stop', async (req, res, next) => {
  try {
    const { reason } = req.body || {};
    await FollowUps.stopSequence(req.params.id, {
      reason, adminId: req.user?.id || null,
    });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// POST /:id/followup/send-now — fires the next touch immediately
router.post('/:id/followup/send-now', async (req, res, next) => {
  try {
    await FollowUps.sendNextTouchNow(req.params.id);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
