const express = require('express');
const router = express.Router();
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
const InvoiceService = require('../services/invoice');
const db = require('../models/db');
const logger = require('../services/logger');

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
    const { customerId, serviceRecordId, title, lineItems, notes, dueDate, taxRate } = req.body;
    if (!customerId) return res.status(400).json({ error: 'customerId required' });
    if (!lineItems?.length) return res.status(400).json({ error: 'lineItems required' });

    const invoice = await InvoiceService.create({
      customerId, serviceRecordId, title, lineItems, notes, dueDate, taxRate,
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

// POST /:id/send — send invoice via SMS + email
// SMS fires via InvoiceService.sendViaSMS (the invoice_sent template);
// email via the branded sendInvoiceEmail helper with the PDF attached.
// Either channel failing alone doesn't abort the other — returns per-
// channel status so the UI can toast accordingly. Missing phone / email
// on the customer record is treated as "channel skipped", not an error.
router.post('/:id/send', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { sendInvoiceEmail } = require('../services/invoice-email');

    const sms = { ok: false };
    const email = { ok: false };

    try {
      await InvoiceService.sendViaSMS(id);
      sms.ok = true;
    } catch (err) {
      sms.error = err.message;
    }

    try {
      const r = await sendInvoiceEmail(id);
      if (r?.ok) email.ok = true;
      else if (r?.error) email.error = r.error;
    } catch (err) {
      email.error = err.message;
    }

    if (!sms.ok && !email.ok) {
      return res.status(500).json({ ok: false, sms, email });
    }
    res.json({ ok: true, sms, email });
  } catch (err) { next(err); }
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
      // InvoiceService.sendReceipt is a fire-and-forget helper that logs its
      // own failures; wrap in try/catch so one side failing doesn't block
      // the other or the stamp below.
      try {
        await InvoiceService.sendReceipt(id);
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
