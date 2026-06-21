const express = require('express');
const router = express.Router();
const multer = require('multer');
const { adminAuthenticate, requireAdmin, requireTechOrAdmin } = require('../middleware/admin-auth');
const InvoiceService = require('../services/invoice');
const InvoiceAttachments = require('../services/invoice-attachments');
const db = require('../models/db');
const logger = require('../services/logger');
const MODELS = require('../config/models');
const { etDateString, addETDays, parseETDateTime } = require('../utils/datetime-et');
const { shortenOrPassthrough, invoiceShortCodePrefix } = require('../services/short-url');
const { assertInvoiceCollectible, INVOICE_UNCOLLECTIBLE_STATUSES, invoiceAmountDue } = require('../services/invoice-helpers');
const CustomerCredit = require('../services/customer-credit');
const { getInvoiceEmailRecipients, getPrimaryContact } = require('../services/customer-contact');
const { publicPortalUrl } = require('../utils/portal-url');
const AnnualPrepayRenewals = require('../services/annual-prepay-renewals');

router.use(adminAuthenticate, requireTechOrAdmin);

const BILLING_RECIPIENT_EMAIL_MAX_LENGTH = 200;

// Per-customer advisory-lock namespace for annual-prepay term creation. MUST
// match admin-customers.js so flagging an invoice here serializes against the
// Customer 360 annual-prepay routes (a shared lock prevents two routes from
// concurrently creating overlapping coverage for the same customer).
const ANNUAL_PREPAY_LOCK_NS = 0x4150;

// Map a recurring_interval_days value (used by the scheduler's "Custom (every N
// days)" option, and by month-based patterns stored as custom) to an annual-
// prepay coverage cadence, with tolerance. Returns null for intervals that don't
// correspond to a supported coverage cadence (e.g. weekly/biweekly or an
// arbitrary custom gap) so we never guess one.
function cadenceFromIntervalDays(days) {
  const d = Number(days);
  if (!Number.isFinite(d) || d <= 17) return null; // daily/weekly/biweekly: not coverage cadences
  if (d >= 26 && d <= 35) return 'monthly';        // ~30
  if (d >= 38 && d <= 48) return 'every_6_weeks';  // ~42
  if (d >= 55 && d <= 66) return 'bimonthly';      // ~60
  if (d >= 85 && d <= 96) return 'quarterly';      // ~90/91
  if (d >= 115 && d <= 125) return 'triannual';    // ~120
  if (d >= 170 && d <= 190) return 'semiannual';   // ~180
  if (d >= 350 && d <= 380) return 'annual';       // ~365
  return null;
}

// Best-guess coverage for the annual-prepay modal: the customer's most common
// active RECURRING scheduled-service label (NOT the invoice title, which can be
// a plan label like "WaveGuard Bronze Annual Prepay"), plus the cadence carried
// on those real recurring rows. Used only to prefill a brand-new term so the
// standard Mark-prepaid flow auto-covers the real recurring visits; the operator
// can clear/override it. Returns null unless the customer has recurring history
// AND we can confidently determine its cadence — a one-off/initial treatment
// must NOT seed annual coverage, and we never guess a default cadence (the modal
// submits the suggestion as explicit, so a wrong guess mis-stamps visits).
async function suggestCoverageServiceType(customerId) {
  if (!customerId) return null;
  try {
    const rows = await db('scheduled_services')
      .where({ customer_id: customerId })
      .where('is_recurring', true)
      .whereNotIn('status', ['cancelled', 'canceled', 'rescheduled'])
      .whereNotNull('service_type')
      .orderBy('scheduled_date', 'desc')
      .limit(100)
      .select('service_type', 'recurring_pattern', 'recurring_interval_days');
    if (!rows.length) return null;
    const counts = new Map();
    for (const row of rows) {
      const t = String(row.service_type || '').trim();
      if (t) counts.set(t, (counts.get(t) || 0) + 1);
    }
    let serviceType = null;
    let bestN = 0;
    for (const [t, n] of counts) {
      if (n > bestN) { serviceType = t; bestN = n; }
    }
    if (!serviceType) return null;
    // Derive cadence ONLY from the chosen service's actual recurrence data — a
    // generic label like "Pest Control Service" carries its real cadence on the
    // rows, not in the name. We deliberately do NOT fall back to label inference
    // (which defaults to quarterly): the modal treats the suggested cadence as
    // explicit, so a guessed quarterly would mis-stamp a monthly/custom plan.
    const { normalizeCoverageCadence } = AnnualPrepayRenewals._private;
    const cadenceCounts = new Map();
    for (const row of rows) {
      if (String(row.service_type || '').trim() !== serviceType) continue;
      // monthly_nth_weekday (scheduler's "nth weekday of month") is monthly;
      // normalizeCoverageCadence handles the named month cadences; custom/other
      // patterns fall to the interval-days mapping.
      const rawPattern = String(row.recurring_pattern || '').trim().toLowerCase();
      let c = rawPattern === 'monthly_nth_weekday'
        ? 'monthly'
        : normalizeCoverageCadence(row.recurring_pattern);
      if (!c) c = cadenceFromIntervalDays(row.recurring_interval_days);
      if (c) cadenceCounts.set(c, (cadenceCounts.get(c) || 0) + 1);
    }
    let cadence = null;
    let cadenceBest = 0;
    for (const [c, n] of cadenceCounts) {
      if (n > cadenceBest) { cadence = c; cadenceBest = n; }
    }
    // No determinable cadence → no prefill, so the operator sets coverage
    // explicitly rather than us submitting a guessed quarterly default.
    if (!cadence) return null;
    return { serviceType, cadence };
  } catch (err) {
    logger.warn(`[admin-invoices] coverage service suggestion skipped: ${err.message}`);
    return null;
  }
}

function aggregateAttachmentMemoryStorage() {
  return {
    _handleFile(req, file, cb) {
      const chunks = [];
      let fileBytes = 0;
      let done = false;

      const fail = (err) => {
        if (done) return;
        done = true;
        chunks.length = 0;
        file.stream.resume();
        cb(err);
      };

      file.stream.on('limit', () => {
        fail(InvoiceAttachments.attachmentError('Invoice attachments cannot total more than 25 MB', 400));
      });

      file.stream.on('data', (chunk) => {
        if (done) return;
        const nextTotal = Number(req.invoiceAttachmentUploadBytes || 0) + chunk.length;
        if (nextTotal > InvoiceAttachments.MAX_ATTACHMENT_TOTAL_BYTES) {
          fail(InvoiceAttachments.attachmentError('Invoice attachments cannot total more than 25 MB', 400));
          return;
        }
        req.invoiceAttachmentUploadBytes = nextTotal;
        fileBytes += chunk.length;
        chunks.push(chunk);
      });

      file.stream.on('error', fail);
      file.stream.on('end', () => {
        if (done) return;
        done = true;
        cb(null, {
          buffer: Buffer.concat(chunks, fileBytes),
          size: fileBytes,
        });
      });
    },
    _removeFile(_req, file, cb) {
      delete file.buffer;
      cb(null);
    },
  };
}

const attachmentUpload = multer({
  storage: aggregateAttachmentMemoryStorage(),
  limits: {
    files: InvoiceAttachments.MAX_ATTACHMENT_COUNT,
    fileSize: InvoiceAttachments.MAX_ATTACHMENT_TOTAL_BYTES,
  },
  fileFilter: (_req, file, cb) => {
    if (!InvoiceAttachments.isAllowedDeclaredFile(file)) {
      return cb(InvoiceAttachments.attachmentError(
        'Supported attachment types are JPG, PNG, GIF, TIFF, BMP, and PDF',
        400
      ));
    }
    return cb(null, true);
  },
});

function normalizeAttachmentUploadError(err, _req, _res, next) {
  if (err?.code === 'LIMIT_FILE_SIZE') {
    return next(InvoiceAttachments.attachmentError('Invoice attachments cannot total more than 25 MB', 400));
  }
  if (err?.code === 'LIMIT_FILE_COUNT' || err?.code === 'LIMIT_UNEXPECTED_FILE') {
    return next(InvoiceAttachments.attachmentError(
      `Invoices can have at most ${InvoiceAttachments.MAX_ATTACHMENT_COUNT} attachments`,
      400
    ));
  }
  if (err?.status && !err.statusCode) {
    err.statusCode = err.status;
    err.isOperational = true;
  }
  return next(err);
}

function parseReviewDelayMinutes(body = {}) {
  if (!body.requestReview) return null;
  if (body.reviewTiming === 'now') return 0;
  if (body.reviewTiming === 'tomorrow_8') {
    const targetDay = etDateString(addETDays(new Date(), 1));
    const target = parseETDateTime(`${targetDay}T08:00`);
    return Math.max(0, Math.ceil((target.getTime() - Date.now()) / 60000));
  }
  if (body.reviewTiming === 'custom') {
    if (body.reviewScheduledFor) {
      const target = parseETDateTime(body.reviewScheduledFor);
      if (!Number.isNaN(target.getTime())) {
        return Math.max(0, Math.ceil((target.getTime() - Date.now()) / 60000));
      }
    }
    return 120;
  }
  const raw = body.reviewDelayMinutes;
  if (raw === undefined || raw === null || raw === '') return 120;
  const minutes = Number(raw);
  if (!Number.isFinite(minutes)) return 120;
  const rounded = Math.max(0, Math.round(minutes));
  const maxDelayMinutes = 60 * 24 * 30;
  return Math.min(rounded, maxDelayMinutes);
}

function parseScheduledReviewDelayMinutes(body = {}, scheduledSendAt = new Date()) {
  if (!body.requestReview) return null;
  // Delays stored on scheduled invoices are relative to the eventual send,
  // not relative to the time the admin creates the schedule.
  if (body.reviewTiming === 'now') return 0;
  if (body.reviewTiming === 'tomorrow_8') {
    const targetDay = etDateString(addETDays(scheduledSendAt, 1));
    const target = parseETDateTime(`${targetDay}T08:00`);
    return Math.max(0, Math.ceil((target.getTime() - scheduledSendAt.getTime()) / 60000));
  }
  if (body.reviewTiming === 'custom' && body.reviewScheduledFor) {
    const target = parseETDateTime(body.reviewScheduledFor);
    if (!Number.isNaN(target.getTime())) {
      if (target.getTime() <= scheduledSendAt.getTime()) {
        const err = new Error('reviewScheduledFor must be after scheduledFor');
        err.statusCode = 400;
        err.isOperational = true;
        throw err;
      }
      return Math.ceil((target.getTime() - scheduledSendAt.getTime()) / 60000);
    }
  }
  return parseReviewDelayMinutes(body);
}

function paymentPlanFollowupStopReason(paymentPlanId) {
  return `payment_plan_created:${paymentPlanId || 'unknown'}`;
}

async function stopInvoiceFollowupsForPaymentPlan(invoiceId, {
  paymentPlanId = null,
  adminId = null,
  database = db,
} = {}) {
  if (!invoiceId) return 0;
  return database('invoice_followup_sequences')
    .where({ invoice_id: invoiceId })
    .whereIn('status', ['active', 'paused', 'autopay_hold'])
    .update({
      status: 'stopped',
      stopped_reason: paymentPlanFollowupStopReason(paymentPlanId),
      stopped_by_admin_id: adminId || null,
      next_touch_at: null,
    });
}

function cleanOptionalText(value, max = 120) {
  if (value == null) return null;
  const trimmed = String(value).trim().replace(/\s+/g, ' ');
  return trimmed ? trimmed.slice(0, max) : null;
}

function cleanEmail(value) {
  if (value == null) return '';
  return String(value).trim().toLowerCase();
}

function isEmailLike(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail(value));
}

function invoiceRecipientOverrideError(email, saveBillingRecipient = false) {
  if (saveBillingRecipient !== undefined && typeof saveBillingRecipient !== 'boolean') {
    return 'saveBillingRecipient must be true or false.';
  }
  if (!email) return null;
  if (!isEmailLike(email)) {
    return 'Enter a valid invoice recipient email.';
  }
  if (cleanEmail(email).length > BILLING_RECIPIENT_EMAIL_MAX_LENGTH) {
    return saveBillingRecipient
      ? 'Billing recipient email must be 200 characters or fewer.'
      : 'Invoice recipient email must be 200 characters or fewer.';
  }
  return null;
}

function fullName(customer = {}) {
  return [customer.first_name, customer.last_name].filter(Boolean).join(' ').trim()
    || customer.company_name
    || customer.first_name
    || '';
}

function publicEmailRecipient(recipient) {
  if (!recipient?.email) return null;
  return {
    email: recipient.email,
    name: recipient.name || '',
    role: recipient.role || 'recipient',
  };
}

async function getInvoiceDeliveryRecipients(invoiceId) {
  const invoice = await db('invoices')
    .where({ id: invoiceId })
    .select('id', 'customer_id', 'invoice_number', 'payer_id', 'payer_snapshot', 'status', 'sent_at')
    .first();
  if (!invoice) return null;

  const customer = await db('customers')
    .where({ id: invoice.customer_id })
    .select('id', 'first_name', 'last_name', 'company_name', 'email', 'phone')
    .first();
  if (!customer) return null;

  // Third-party Bill-To: a payer-billed invoice is delivered to the payer's AP
  // inbox, never the homeowner — homeowner SMS is suppressed server-side (it
  // would expose the payer's pay link / card last4). Report the payer AP as the
  // only email recipient and NO SMS recipient, so the admin UI gates Send
  // Invoice / Send Receipt / Record-Payment-receipt correctly. A payer with no
  // usable AP email (or an unattachable/deactivated payer) reports no recipient
  // → Send stays disabled until the operator adds an AP email or one-off.
  if (invoice.payer_id) {
    const PayerService = require('../services/payer');
    await PayerService.attachToInvoice(invoice);
    const payerRcpt = invoice.payer ? PayerService.payerRecipient(invoice.payer) : null;
    return {
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoice_number,
      customerId: customer.id,
      customerName: fullName(customer),
      payerBilled: true,
      primaryContact: {
        name: payerRcpt?.name || '',
        email: payerRcpt?.email || '',
        phone: '',
        role: 'payer',
      },
      smsRecipient: null,
      emailRecipient: payerRcpt,
      billingPreference: {
        name: payerRcpt?.name || '',
        email: payerRcpt?.email || '',
      },
    };
  }

  const prefs = await db('notification_prefs')
    .where({ customer_id: invoice.customer_id })
    .first()
    .catch(() => null);
  const primary = getPrimaryContact(customer);
  const [emailRecipient] = getInvoiceEmailRecipients(customer, prefs || {});

  return {
    invoiceId: invoice.id,
    invoiceNumber: invoice.invoice_number,
    customerId: customer.id,
    customerName: fullName(customer),
    primaryContact: {
      name: fullName(customer) || primary.name || '',
      email: customer.email || '',
      phone: customer.phone || '',
      role: 'primary',
    },
    smsRecipient: primary.phone ? {
      name: fullName(customer) || primary.name || '',
      phone: primary.phone,
      role: 'primary',
    } : null,
    emailRecipient: publicEmailRecipient(emailRecipient),
    billingPreference: {
      name: prefs?.billing_contact_name || '',
      email: prefs?.billing_email || '',
    },
  };
}

async function saveBillingRecipientPreference(customerId, { email, name }) {
  const updates = {
    billing_email: email,
    billing_contact_name: name || null,
    updated_at: new Date(),
  };
  const existing = await db('notification_prefs')
    .where({ customer_id: customerId })
    .first('id');
  if (existing) {
    await db('notification_prefs')
      .where({ customer_id: customerId })
      .update(updates);
  } else {
    await db('notification_prefs').insert({
      customer_id: customerId,
      ...updates,
    });
  }
}

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
    const {
      status,
      customer_id,
      customerId,
      limit = 50,
      page = 1,
      archived: archivedRaw,
      search,
      from,
      to,
      sort,
    } = req.query;
    // archived=only → archived-only view; archived=all → include both.
    // Default (any other value or unset) = hide archived.
    const archived = archivedRaw === 'only' || archivedRaw === '1' || archivedRaw === 'true'
      ? 'only'
      : archivedRaw === 'all'
      ? 'all'
      : 'hide';
    const limitNum = parseInt(limit, 10) || 50;
    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const offset = (pageNum - 1) * limitNum;
    const { invoices, total } = await InvoiceService.list({
      status,
      customerId: customer_id || customerId,
      limit: limitNum,
      offset,
      archived,
      search,
      from,
      to,
      sort,
    });
    res.json({ invoices, total, page: pageNum });
  } catch (err) { next(err); }
});

// GET /customers/search — quick customer search for invoice creation
router.get('/customers/search', async (req, res, next) => {
  try {
    const { q } = req.query;
    if (!q) return res.json({ customers: [] });
    const customers = await db('customers')
      .where(function () {
        this.whereRaw("LOWER(TRIM(first_name || ' ' || COALESCE(last_name, ''))) LIKE ?", [`%${q.toLowerCase()}%`])
          .orWhere('phone', 'like', `%${q}%`)
          .orWhere('email', 'like', `%${q.toLowerCase()}%`);
      })
      .where({ active: true })
      .select('id', 'first_name', 'last_name', 'phone', 'email', 'waveguard_tier', 'address_line1', 'city', 'property_type')
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

// POST /notes/ai — draft customer-facing invoice notes from tech input.
router.post('/notes/ai', requireAdmin, async (req, res, next) => {
  try {
    if (!process.env.ANTHROPIC_API_KEY) return res.status(400).json({ error: 'AI not configured' });

    const rawInput = String(req.body.input || '').trim().slice(0, 2000);
    const customerName = String(req.body.customerName || 'Customer').trim().slice(0, 160);
    const services = Array.isArray(req.body.services) ? req.body.services.slice(0, 12) : [];
    const serviceLines = services
      .map(s => {
        const description = String(s.description || '').trim().slice(0, 160);
        const quantity = Number(s.quantity) || 1;
        return description ? `- ${description}${quantity > 1 ? ` x${quantity}` : ''}` : null;
      })
      .filter(Boolean)
      .join('\n') || '- No service lines provided';

    if (!rawInput && serviceLines === '- No service lines provided') {
      return res.status(400).json({ error: 'Add notes or service lines first' });
    }

    const prompt = `Write a short customer-facing invoice note for Waves Pest Control & Lawn Care.

Requirements:
- Plain text only.
- 2 to 4 sentences.
- Professional, friendly, and specific.
- Use the technician input and service lines only.
- Do not invent products, pests, locations, guarantees, follow-up dates, prices, discounts, or payment claims.
- Do not include a greeting, subject line, sign-off, markdown, or bullets.

Customer: ${customerName || 'Customer'}

Service lines:
${serviceLines}

Technician input:
${rawInput || '[none provided]'}`;

    const Anthropic = require('@anthropic-ai/sdk');
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const msg = await anthropic.messages.create({
      model: MODELS.FLAGSHIP,
      max_tokens: 260,
      messages: [{ role: 'user', content: prompt }],
    });

    const notes = (msg.content?.[0]?.text || '').trim();
    logger.info(`[invoices] ai-notes ${notes.length} chars`);
    res.json({ notes });
  } catch (err) {
    logger.error(`[invoices] ai-notes failed: ${err.message}`);
    next(err);
  }
});

// GET /:id/recipients — preview invoice delivery recipients before sending
router.get('/:id/recipients', requireAdmin, async (req, res, next) => {
  try {
    const recipients = await getInvoiceDeliveryRecipients(req.params.id);
    if (!recipients) return res.status(404).json({ error: 'Invoice not found' });
    res.json(recipients);
  } catch (err) { next(err); }
});

// GET /:id — single invoice with full details
router.get('/:id', async (req, res, next) => {
  try {
    const invoice = await InvoiceService.getById(req.params.id);
    if (!invoice) return res.status(404).json({ error: 'Not found' });
    // Coverage-service suggestion for the annual-prepay modal (real recurring
    // service, not the invoice title). Modal-only; safe to attach for all GETs.
    invoice.suggested_coverage = await suggestCoverageServiceType(invoice.customer_id);
    res.json(invoice);
  } catch (err) { next(err); }
});

// GET /:id/attachments — list invoice-level files
router.get('/:id/attachments', async (req, res, next) => {
  try {
    const invoice = await db('invoices').where({ id: req.params.id }).first('id');
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    const attachments = await InvoiceAttachments.list(req.params.id);
    res.json({ attachments });
  } catch (err) { next(err); }
});

// POST /:id/attachments — upload up to 10 files / 25 MB total per invoice
router.post('/:id/attachments', requireAdmin, attachmentUpload.array('attachments', InvoiceAttachments.MAX_ATTACHMENT_COUNT), normalizeAttachmentUploadError, async (req, res, next) => {
  try {
    const invoice = await db('invoices').where({ id: req.params.id }).first();
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    const attachments = await InvoiceAttachments.upload(invoice, req.files || [], {
      uploadedByTechId: req.technicianId || null,
    });
    await db('activity_log').insert({
      customer_id: invoice.customer_id,
      action: 'invoice_attachment_uploaded',
      description: `Attached ${attachments.length} file${attachments.length === 1 ? '' : 's'} to invoice ${invoice.invoice_number}`,
    }).catch((err) => logger.warn(`[admin-invoices] attachment activity_log insert failed: ${err.message}`));
    res.status(201).json({ attachments });
  } catch (err) { next(err); }
});

// GET /:id/attachments/:attachmentId/url — signed S3 URL for admin preview/download
router.get('/:id/attachments/:attachmentId/url', async (req, res, next) => {
  try {
    const attachment = await InvoiceAttachments.getForInvoice(req.params.id, req.params.attachmentId);
    if (!attachment) return res.status(404).json({ error: 'Attachment not found' });
    const url = await InvoiceAttachments.signedViewUrl(attachment);
    res.json({ url });
  } catch (err) { next(err); }
});

// DELETE /:id/attachments/:attachmentId — remove invoice attachment
router.delete('/:id/attachments/:attachmentId', requireAdmin, async (req, res, next) => {
  try {
    const invoice = await db('invoices').where({ id: req.params.id }).first();
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    const removed = await InvoiceAttachments.remove(req.params.id, req.params.attachmentId);
    await db('activity_log').insert({
      customer_id: invoice.customer_id,
      action: 'invoice_attachment_deleted',
      description: `Removed ${removed.file_name} from invoice ${invoice.invoice_number}`,
    }).catch((err) => logger.warn(`[admin-invoices] attachment delete activity_log insert failed: ${err.message}`));
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// POST / — create invoice manually
router.post('/', requireAdmin, async (req, res, next) => {
  try {
    const { customerId, serviceRecordId, title, lineItems, notes, dueDate, taxRate, discountIds, serviceDate } = req.body;
    if (!customerId) return res.status(400).json({ error: 'customerId required' });
    if (!lineItems?.length) return res.status(400).json({ error: 'lineItems required' });
    if (serviceDate && !/^\d{4}-\d{2}-\d{2}$/.test(String(serviceDate))) {
      return res.status(400).json({ error: 'serviceDate must be YYYY-MM-DD' });
    }

    const invoice = await InvoiceService.create({
      customerId, serviceRecordId, title, lineItems, notes, dueDate, taxRate, discountIds, serviceDate,
    });

    const domain = publicPortalUrl();
    const payUrl = await shortenOrPassthrough(`${domain}/pay/${invoice.token}`, {
      kind: 'invoice', entityType: 'invoices', entityId: invoice.id, customerId: invoice.customer_id,
      codePrefix: invoiceShortCodePrefix(invoice),
    });
    res.status(201).json({
      ...invoice,
      payUrl,
    });
  } catch (err) {
    if (err?.isOperational && err.statusCode) {
      return res.status(err.statusCode).json({ error: err.message, code: err.code });
    }
    next(err);
  }
});

// POST /from-service — create from service record (convenience)
router.post('/from-service', requireAdmin, async (req, res, next) => {
  try {
    const { serviceRecordId, amount, description, taxRate } = req.body;
    if (!serviceRecordId) return res.status(400).json({ error: 'serviceRecordId required' });
    if (!amount) return res.status(400).json({ error: 'amount required' });

    const invoice = await InvoiceService.createFromService(serviceRecordId, {
      amount: parseFloat(amount), description, taxRate,
    });

    const domain = publicPortalUrl();
    const payUrl = await shortenOrPassthrough(`${domain}/pay/${invoice.token}`, {
      kind: 'invoice', entityType: 'invoices', entityId: invoice.id, customerId: invoice.customer_id,
      codePrefix: invoiceShortCodePrefix(invoice),
    });
    res.status(201).json({
      ...invoice,
      payUrl,
    });
  } catch (err) { next(err); }
});

// POST /batch — create identical invoice for multiple customers
// Body: { customerIds: string[], title, lineItems, notes?, dueDate?, taxRate?, sendImmediately?: boolean }
router.post('/batch', requireAdmin, async (req, res, next) => {
  try {
    const { customerIds, title, lineItems, notes, dueDate, taxRate, sendImmediately } = req.body || {};
    if (!Array.isArray(customerIds) || customerIds.length === 0) {
      return res.status(400).json({ error: 'customerIds[] required' });
    }
    if (!lineItems?.length) return res.status(400).json({ error: 'lineItems required' });

    const domain = publicPortalUrl();
    const created = [];
    const failed = [];

    for (const customerId of customerIds) {
      try {
        const invoice = await InvoiceService.create({
          customerId, title, lineItems, notes, dueDate, taxRate,
        });
        let sendResult = null;
        if (sendImmediately) {
          try {
            // Third-party Bill-To: a payer-billed invoice can't be delivered by
            // the homeowner SMS (sendViaSMS short-circuits to payer_billed and
            // never finalizes). Route it through the email-capable path so the
            // payer AP inbox receives it and the invoice is finalized; self-pay
            // invoices keep the existing SMS-only immediate send.
            sendResult = invoice.payer_id
              ? await InvoiceService.sendViaSMSAndEmail(invoice.id)
              : await InvoiceService.sendViaSMS(invoice.id);
          } catch (sendErr) {
            logger.error(`[admin-invoices:batch] send failed for ${invoice.id}: ${sendErr.message}`);
            sendResult = { sent: false, error: sendErr.message };
          }
        }
        created.push({
          customerId,
          invoiceId: invoice.id,
          invoiceNumber: invoice.invoice_number,
          total: invoice.total,
          payUrl: await shortenOrPassthrough(`${domain}/pay/${invoice.token}`, {
            kind: 'invoice', entityType: 'invoices', entityId: invoice.id, customerId,
            codePrefix: invoiceShortCodePrefix(invoice),
          }),
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
router.post('/batch/send', requireAdmin, async (req, res, next) => {
  try {
    const { invoiceIds } = req.body || {};
    if (!Array.isArray(invoiceIds) || invoiceIds.length === 0) {
      return res.status(400).json({ error: 'invoiceIds[] required' });
    }

    const sent = [];
    const failed = [];

    for (const invoiceId of invoiceIds) {
      try {
        const result = await InvoiceService.sendViaSMSAndEmail(invoiceId);
        if (result.ok) {
          sent.push({
            invoiceId,
            channels: { sms: Boolean(result.sms?.ok), email: Boolean(result.email?.ok) },
          });
        } else {
          const error = [result.sms?.error && `sms: ${result.sms.error}`, result.email?.error && `email: ${result.email.error}`]
            .filter(Boolean)
            .join(' | ') || 'no channel succeeded';
          logger.error(`[admin-invoices:batch-send] ${invoiceId}: ${error}`);
          failed.push({ invoiceId, error });
        }
      } catch (err) {
        logger.error(`[admin-invoices:batch-send] ${invoiceId}: ${err.message}`);
        failed.push({ invoiceId, error: err.message });
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
router.post('/batch/send-receipts', requireAdmin, async (req, res, next) => {
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
        const r = await InvoiceService.sendReceipt(invoiceId);
        if (r?.sent) {
          smsOk = true;
        } else {
          errs.push(`sms: ${r?.reason || r?.code || 'not-sent'}`);
        }
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
router.put('/:id', requireAdmin, async (req, res, next) => {
  try {
    const invoice = await InvoiceService.update(req.params.id, req.body);
    if (!invoice) return res.status(404).json({ error: 'Not found' });
    res.json(invoice);
  } catch (err) {
    // Editability guards (status race, live PaymentIntent, payment plan,
    // annual prepay, deposit/account credit) are operator-actionable conflicts,
    // not server faults — surface them so the UI can toast the reason.
    if (/can be edited|already started paying|annual prepay term|active payment plan|deposit credit|account credit applied/i.test(err.message)) {
      return res.status(409).json({ error: err.message });
    }
    if (/Invalid line-item discount/i.test(err.message)) {
      return res.status(400).json({ error: err.message });
    }
    next(err);
  }
});

// POST /:id/send — send invoice via SMS + email
// SMS fires via InvoiceService.sendViaSMS (the invoice_sent template);
// email via the branded sendInvoiceEmail helper with the PDF attached.
// Either channel failing alone doesn't abort the other — returns per-
// channel status so the UI can toast accordingly. Missing phone / email
// on the customer record is treated as "channel skipped", not an error.
router.post('/:id/send', requireAdmin, async (req, res, next) => {
  try {
    const { id } = req.params;
    const {
      requestReview,
      invoiceRecipientEmail,
      invoiceRecipientName,
      saveBillingRecipient,
    } = req.body || {};
    const reviewDelayMinutes = parseReviewDelayMinutes(req.body || {});
    const overrideEmail = cleanEmail(invoiceRecipientEmail);
    const overrideName = cleanOptionalText(invoiceRecipientName);
    const shouldSaveBillingRecipient = saveBillingRecipient === true;
    let emailRecipientOverride = null;

    if (overrideEmail) {
      const recipientError = invoiceRecipientOverrideError(overrideEmail, saveBillingRecipient);
      if (recipientError) {
        return res.status(400).json({ error: recipientError });
      }
      emailRecipientOverride = {
        email: overrideEmail,
        name: overrideName || undefined,
      };

      if (shouldSaveBillingRecipient) {
        const invoice = await db('invoices')
          .where({ id })
          .select('customer_id', 'payer_id')
          .first();
        if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
        // Third-party Bill-To: a one-off AP override on a payer invoice is the
        // payer's address — never persist it to the homeowner's billing prefs
        // (that would reroute the homeowner's own future self-pay invoices to
        // the third party). The payer snapshot/AP path (payer.freezeApEmail)
        // handles persisting the delivered AP email for payer invoices.
        if (!invoice.payer_id) {
          await saveBillingRecipientPreference(invoice.customer_id, {
            email: overrideEmail,
            name: overrideName,
          });
        }
      }
    }

    const result = await InvoiceService.sendViaSMSAndEmail(id, {
      requestReview,
      reviewDelayMinutes,
      emailRecipientOverride,
    });
    if (!result.ok) {
      return res.status(400).json(result);
    }
    res.json(result);
  } catch (err) {
    if (/already paid|paid invoice|voided|processing|already in progress|not sendable/i.test(err.message)) {
      return res.status(/processing|already in progress/i.test(err.message) ? 409 : 400).json({ error: err.message });
    }
    next(err);
  }
});

// POST /:id/schedule-send — send invoice later via the scheduler.
router.post('/:id/schedule-send', requireAdmin, async (req, res, next) => {
  try {
    const { scheduledFor, requestReview } = req.body || {};
    if (!scheduledFor) return res.status(400).json({ error: 'scheduledFor required' });
    const when = parseETDateTime(scheduledFor);
    if (Number.isNaN(when.getTime())) return res.status(400).json({ error: 'invalid scheduledFor' });
    if (when.getTime() <= Date.now()) return res.status(400).json({ error: 'scheduledFor must be in the future' });
    const reviewDelayMinutes = parseScheduledReviewDelayMinutes(req.body || {}, when);

    // Phase 2: never queue an accrued invoice into the individual send scheduler —
    // it is delivered on the consolidated statement (processScheduledSends would
    // churn failed sends against the statement-only send guard).
    const target = await db('invoices').where({ id: req.params.id }).first('payer_statement_id');
    if (target?.payer_statement_id) {
      return res.status(400).json({ error: 'Invoice is billed on the payer’s monthly statement; it cannot be scheduled for individual send.' });
    }

    const [invoice] = await db('invoices')
      .where({ id: req.params.id })
      .whereIn('status', ['draft', 'scheduled'])
      .whereNull('payer_statement_id')
      .update({
        status: 'scheduled',
        scheduled_send_at: when,
        scheduled_send_attempts: 0,
        scheduled_send_error: null,
        scheduled_request_review: Boolean(requestReview),
        scheduled_review_delay_minutes: requestReview ? reviewDelayMinutes : null,
        updated_at: new Date(),
      })
      .returning('*');
    if (!invoice) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true, invoice });
  } catch (err) { next(err); }
});

// POST /:id/charge-card — charge a saved card on file against this invoice.
// Body: { paymentMethodId } (our internal payment_methods.id).
// The card must belong to the invoice customer. Succeeds by calling
// Stripe off-session with confirm:true; webhook marks the invoice paid.
router.post('/:id/charge-card', async (req, res, next) => {
  try {
    const { paymentMethodId } = req.body || {};
    if (!paymentMethodId) return res.status(400).json({ error: 'paymentMethodId required' });

    // Account credit is auto-applied INSIDE chargeInvoiceWithSavedCard — after it
    // validates the saved card + triages a stale PI, all in the same locked
    // transaction — and on full coverage it commits 'prepaid' and returns
    // { covered_by_credit: true } instead of charging. Do NOT pre-apply here: a
    // stale/invalid paymentMethodId would otherwise consume credit before the
    // card check throws, leaving the invoice reduced/edit-locked with no charge.
    const StripeService = require('../services/stripe');
    const result = await StripeService.chargeInvoiceWithSavedCard(req.params.id, paymentMethodId);
    res.json({ success: true, ...result });
  } catch (err) {
    logger.error(`[admin-invoices] charge-card failed: ${err.message}`);
    res.status(400).json({ error: err.message });
  }
});

// POST /:id/void — void invoice
router.post('/:id/void', requireAdmin, async (req, res, next) => {
  try {
    const invoice = await InvoiceService.voidInvoice(req.params.id);
    res.json(invoice);
  } catch (err) { next(err); }
});

// POST /:id/annual-prepay — flag an existing invoice as an annual prepayment.
// Creates (or re-activates) the linked annual_prepay_terms row and stamps
// invoices.annual_prepay_term_id — that link is what surfaces the coverage
// banner on the pay page + PDF. Defaults: coverage starts on the service date
// (or today) for 12 months, prepay amount = invoice total. Idempotent per
// invoice (annual_prepay_terms has a unique prepay_invoice_id).
//
// When coverageServiceType + coverageVisitCount (+ optional coverageCadence)
// are supplied, the linked term also seeds/auto-stamps that many scheduled
// visits prepaid on payment (the same coverage behavior as the Customer 360
// annual-prepay flow). Omitting them preserves the legacy display-only flag.
router.post('/:id/annual-prepay', requireAdmin, async (req, res, next) => {
  try {
    const {
      termStart, termEnd, months, planLabel, prepayAmount, monthlyRate,
      coverageServiceType, coverageVisitCount, coverageCadence,
    } = req.body || {};
    const ymd = /^\d{4}-\d{2}-\d{2}$/;
    if (termStart && !ymd.test(String(termStart))) {
      return res.status(400).json({ error: 'termStart must be YYYY-MM-DD' });
    }
    if (termEnd && !ymd.test(String(termEnd))) {
      return res.status(400).json({ error: 'termEnd must be YYYY-MM-DD' });
    }

    const invoice = await db('invoices').where({ id: req.params.id }).first();
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });

    const { dateOnly, addMonthsSameDay } = AnnualPrepayRenewals._private;
    const start = termStart || dateOnly(invoice.service_date) || undefined;
    let end = termEnd || undefined;
    if (!end && months != null && months !== '') {
      const span = parseInt(months, 10);
      if (!Number.isFinite(span) || span < 1 || span > 60) {
        return res.status(400).json({ error: 'months must be between 1 and 60' });
      }
      end = addMonthsSameDay(dateOnly(start) || etDateString(), span);
    }
    if (start && end && dateOnly(end) <= dateOnly(start)) {
      return res.status(400).json({ error: 'termEnd must be after termStart' });
    }

    const resolvedAmount = prepayAmount != null && prepayAmount !== ''
      ? Number(prepayAmount)
      : Number(invoice.total || 0);
    if (!Number.isFinite(resolvedAmount) || resolvedAmount < 0) {
      return res.status(400).json({ error: 'prepayAmount must be a non-negative number' });
    }

    const resolvedMonthly = monthlyRate != null && monthlyRate !== ''
      ? Number(monthlyRate)
      : null;
    if (resolvedMonthly != null && (!Number.isFinite(resolvedMonthly) || resolvedMonthly < 0)) {
      return res.status(400).json({ error: 'monthlyRate must be a non-negative number' });
    }

    // Coverage fields are optional. When present, the term seeds + auto-stamps
    // the covered visits prepaid (so completing them doesn't re-invoice the
    // customer who already paid the year up front); when omitted they stay
    // `undefined` and createTermForAnnualPrepay leaves the term display-only.
    let resolvedVisitCount;
    if (coverageVisitCount != null && coverageVisitCount !== '') {
      const vc = parseInt(coverageVisitCount, 10);
      if (!Number.isInteger(vc) || vc < 1 || vc > 24) {
        return res.status(400).json({ error: 'coverageVisitCount must be between 1 and 24' });
      }
      resolvedVisitCount = vc;
    }
    const resolvedServiceType = coverageServiceType !== undefined
      ? (cleanOptionalText(coverageServiceType) || null)
      : undefined;
    const resolvedCadence = coverageCadence !== undefined
      ? (cleanOptionalText(coverageCadence) || null)
      : undefined;

    // Mirror the client guard server-side: a service type with no valid visit
    // count is incomplete coverage. The term would store the service type but
    // refreshTermSnapshot needs BOTH to seed/stamp, so the invoice would look
    // coverage-configured while its visits still bill normally. Reject it so a
    // stale client or direct API call can't persist that half state.
    if (resolvedServiceType && resolvedVisitCount === undefined) {
      return res.status(400).json({
        error: 'coverageVisitCount is required when coverageServiceType is set',
      });
    }

    const coverageEnabled = !!resolvedServiceType && resolvedVisitCount !== undefined;

    // Visit coverage needs a positive amount to stamp: applyPrepaidCoverageForTerm
    // bails unless prepay_amount > 0, and completion billing only skips visits
    // with a positive prepaid_amount. A zero-amount coverage term would look
    // configured but still re-invoice every covered visit, so reject it.
    if (coverageEnabled && !(resolvedAmount > 0)) {
      return res.status(400).json({
        error: 'A positive prepay amount is required to enable visit coverage',
      });
    }

    // Coverage stamps prepay_amount split across the covered visits, and
    // completion billing only suppresses a visit when its prepaid_amount >= the
    // amount it would bill. If the operator lowers the prepay amount below the
    // invoice total, the per-visit stamp can fall short and covered visits still
    // invoice despite the customer having paid. Require the stamped amount to be
    // at least the invoice total when coverage is enabled (the Customer 360 flow
    // likewise stamps the full invoice total).
    const invoiceTotalForCoverage = Number(invoice.total) || 0;
    if (coverageEnabled && resolvedAmount + 1e-9 < invoiceTotalForCoverage) {
      return res.status(400).json({
        error: `When covering visits, the prepay amount must be at least the invoice total ($${invoiceTotalForCoverage.toFixed(2)}).`,
      });
    }

    // Per-customer overlap guard, mirroring the Customer 360 annual-prepay
    // routes. Now that this endpoint can create real visit coverage, a second
    // overlapping term would let two terms fight over the same scheduled visits
    // (double-counting / mis-stamping). Serialize the check + create under the
    // same per-customer advisory lock + transaction the Customer 360 routes use,
    // so two concurrent flags can't both pass a preflight read and insert
    // overlapping coverage. Always run the check when coverage is enabled
    // (incl. editing an existing term), excluding only this invoice's own term;
    // a display-only flag owns no visits, so it skips the guard.
    let term;
    try {
      term = await db.transaction(async (trx) => {
        await trx.raw(
          'SELECT pg_advisory_xact_lock(?, hashtext(?))',
          [ANNUAL_PREPAY_LOCK_NS, String(invoice.customer_id)],
        );

        if (coverageEnabled) {
          const ownTerm = await trx('annual_prepay_terms')
            .where({ prepay_invoice_id: invoice.id })
            .first('id');
          // Proper interval overlap: this term's [start, end] vs the other
          // term's [term_start, term_end]. Comparing only this start against the
          // latest other term_end would falsely 409 when editing an older term
          // whose window ends before a separate future renewal begins.
          const startYmd = dateOnly(start) || etDateString();
          const endYmd = dateOnly(end) || addMonthsSameDay(startYmd, 12);
          let overlapQuery = trx('annual_prepay_terms')
            .where({ customer_id: invoice.customer_id })
            .where(function overlapStatus() {
              this.whereIn('status', ['payment_pending', 'active', 'renewal_pending', 'renewed', 'switch_plan'])
                .orWhere(function lapsedRenewalStillInTerm() {
                  this.where('status', 'cancelled').andWhere('renewal_decision', 'cancel');
                });
            })
            .where('term_start', '<=', endYmd)
            .where('term_end', '>=', startYmd);
          if (ownTerm) overlapQuery = overlapQuery.whereNot('id', ownTerm.id);
          const overlapTerm = await overlapQuery.orderBy('term_start', 'asc').first('id', 'term_start', 'term_end');
          if (overlapTerm) {
            const oStart = dateOnly(overlapTerm.term_start);
            const oEnd = dateOnly(overlapTerm.term_end);
            const message = `Customer already has an annual prepay term covering ${oStart} through ${oEnd}. Choose coverage dates outside that window, or apply coverage from that term.`;
            const err = new Error(message);
            err.annualPrepayOverlap = { error: message, activeTermId: overlapTerm.id, activeTermStart: oStart, activeTermEnd: oEnd };
            throw err;
          }
        }

        return AnnualPrepayRenewals.createTermForAnnualPrepay({
          customerId: invoice.customer_id,
          prepayInvoiceId: invoice.id,
          planLabel: cleanOptionalText(planLabel) || invoice.title || 'Annual Prepay',
          monthlyRate: resolvedMonthly,
          prepayAmount: resolvedAmount,
          termStart: start || null,
          termEnd: end || null,
          coverageServiceType: resolvedServiceType,
          coverageVisitCount: resolvedVisitCount,
          coverageCadence: resolvedCadence,
          conn: trx,
        });
      });
    } catch (err) {
      if (err && err.annualPrepayOverlap) return res.status(409).json(err.annualPrepayOverlap);
      throw err;
    }
    if (!term) {
      return res.status(409).json({ error: 'Annual prepay is not available for this account' });
    }

    const updated = await InvoiceService.getById(invoice.id);
    res.json({ ok: true, term, invoice: updated });
  } catch (err) { next(err); }
});

// DELETE /:id/annual-prepay — remove the annual-prepay flag from an invoice.
// Clears the invoice link and cancels the linked term so the banner stops
// rendering. Idempotent — re-marking later re-activates the same term row.
router.delete('/:id/annual-prepay', requireAdmin, async (req, res, next) => {
  try {
    const invoice = await db('invoices')
      .where({ id: req.params.id })
      .first('id', 'annual_prepay_term_id');
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });

    const termId = invoice.annual_prepay_term_id;
    await db.transaction(async (trx) => {
      await trx('invoices')
        .where({ id: invoice.id })
        .update({ annual_prepay_term_id: null, updated_at: new Date() });
      if (termId) {
        await trx('annual_prepay_terms')
          .where({ id: termId })
          .update({ status: 'cancelled', updated_at: new Date() });
        // Clear per-visit prepaid_amount stamps on the term's not-yet-completed
        // visits FIRST (while they can still be found by term id). Completion
        // billing keys on prepaid_amount independently of the term link, so an
        // unflagged future visit would otherwise stay "prepaid" and skip
        // invoicing — same cleanup the refund/void path runs.
        await AnnualPrepayRenewals.clearPrepaidStampsForTerm(termId, trx);
        // Detach any scheduled visits attachScheduledServices() stamped while
        // the term was active — pricing-reality-check treats a non-null
        // annual_prepay_term_id as "Annual Prepay", so leaving them linked keeps
        // visits reported/seeded as prepaid after the flag is removed.
        await trx('scheduled_services')
          .where({ annual_prepay_term_id: termId })
          .update({ annual_prepay_term_id: null, updated_at: new Date() });
      }
    });

    const updated = await InvoiceService.getById(invoice.id);
    res.json({ ok: true, invoice: updated });
  } catch (err) { next(err); }
});

// POST /:id/archive — tuck a voided invoice out of the default list view.
// Void-only precondition: refusing paid/sent/draft because "archive" is
// meaningful only as a final shelving step on a row that has no activity
// left. Returns the updated row so the UI can update in place.
router.post('/:id/archive', requireAdmin, async (req, res, next) => {
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
router.post('/:id/unarchive', requireAdmin, async (req, res, next) => {
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
router.post('/:id/send-receipt', requireAdmin, async (req, res, next) => {
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
        const r = await InvoiceService.sendReceipt(id, { force: true, recordActivity: false });
        smsResult = r?.sent ? { ok: true } : { ok: false, error: r?.reason || r?.code || 'not-sent' };
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
const VALID_PAYMENT_PLAN_FREQUENCIES = ['weekly', 'biweekly', 'monthly'];

function parsePositiveMoney(value, field) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) {
    const err = new Error(`${field} must be a positive amount`);
    err.statusCode = 400;
    err.isOperational = true;
    throw err;
  }
  return Math.round(amount * 100) / 100;
}

function parseDateOnly(value, field) {
  if (!value) {
    const err = new Error(`${field} is required`);
    err.statusCode = 400;
    err.isOperational = true;
    throw err;
  }
  const date = new Date(`${String(value).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) {
    const err = new Error(`${field} must be a valid YYYY-MM-DD date`);
    err.statusCode = 400;
    err.isOperational = true;
    throw err;
  }
  return String(value).slice(0, 10);
}

router.post('/:id/record-payment', requireAdmin, async (req, res, next) => {
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
    // Phase 2: an accrued invoice is collected ONLY via its consolidated
    // statement — never mark an individual accrued invoice paid here (it would
    // settle once manually and again when the statement settles).
    if (invoice.payer_statement_id) {
      return res.status(400).json({ error: 'Invoice is billed on the payer’s monthly statement — record the payment against the statement, not the individual invoice' });
    }
    // Terminal or in-flight invoices can never be manually marked paid.
    // This shares the same transition guard as Stripe collection paths.
    try {
      assertInvoiceCollectible(invoice.status);
    } catch (err) {
      return res.status(invoice.status === 'processing' ? 409 : 400).json({ error: err.message });
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
      .whereNotIn('status', INVOICE_UNCOLLECTIBLE_STATUSES)
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
      const paymentRow = {
        customer_id: updatedInvoice.customer_id,
        // Record the CASH actually received — amount due (total − applied account
        // credit) — not the full total, or manual cash/check/Zelle over-states
        // revenue by the applied credit (which isn't cash).
        amount: invoiceAmountDue(updatedInvoice),
        status: 'paid',
        description: `Invoice ${updatedInvoice.invoice_number} — ${method}`
          + `${trimmedReference ? ` (${trimmedReference})` : ''}`,
        payment_date: etDateString(),
      };
      // Third-party Bill-To: link a payer-billed manual payment to its invoice so
      // the customer-facing billing history/balance can filter it out. Self-pay
      // rows normally stay unlinked to use the receipt-total fallback — BUT when
      // account credit was applied the recorded cash (amount due) differs from
      // invoice.total, so they MUST be linked or the receipt falls back to the
      // pre-credit total instead of the amount actually received.
      if (updatedInvoice.payer_id || Number(updatedInvoice.credit_applied) > 0) {
        paymentRow.metadata = JSON.stringify({ invoice_id: updatedInvoice.id });
      }
      await db('payments').insert(paymentRow);
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

    try {
      const AnnualPrepayRenewals = require('../services/annual-prepay-renewals');
      await AnnualPrepayRenewals.syncTermForInvoicePayment(updatedInvoice);
    } catch (err) {
      logger.warn(`[admin-invoices:record-payment] annual prepay activation failed: ${err.message}`);
    }

    await db('activity_log').insert({
      customer_id: updatedInvoice.customer_id,
      action: 'invoice_payment_recorded',
      description: `Manual payment recorded for ${updatedInvoice.invoice_number}`
        + ` ($${invoiceAmountDue(updatedInvoice).toFixed(2)} via ${method}`
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
          const r = await InvoiceService.sendReceipt(id, { force: true, recordActivity: false });
          smsResult = r?.sent ? { ok: true } : { ok: false, error: r?.reason || r?.code || 'not-sent' };
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

// GET /:id/credit-context — available account credit + this invoice's
// amount due, for the Apply-credit / Mark-prepaid modal.
router.get('/:id/credit-context', async (req, res, next) => {
  try {
    const invoice = await db('invoices').where({ id: req.params.id })
      .first('id', 'customer_id', 'total', 'credit_applied', 'status', 'invoice_number');
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    const total = CustomerCredit.round2(invoice.total || 0);
    const amountDue = CustomerCredit.round2(total - CustomerCredit.round2(invoice.credit_applied || 0));
    const balance = (await CustomerCredit.getBalance(invoice.customer_id)) || 0;
    res.json({
      customer_id: invoice.customer_id,
      invoice_number: invoice.invoice_number,
      total,
      credit_applied: CustomerCredit.round2(invoice.credit_applied || 0),
      amount_due: amountDue,
      balance,
    });
  } catch (err) { next(err); }
});

// POST /:id/apply-credit — draw down the customer's account credit to cover
// this invoice in full and mark it prepaid (the prepaid / quarterly-prepay
// flow). Account credit is the holding bucket for money paid ahead (recorded
// via Customer 360 "Issue credit") or any goodwill/adjustment. Revenue is
// recognized when cash is RECEIVED (a cash-backed prepayment books its payment
// row at issuance), NOT here — applying credit only covers the invoice.
//
// Body: {
//   waiveSetupFee?: boolean — record that the WaveGuard initial/setup fee was
//                             waived for this prepaid invoice (flag only, like
//                             the annual-prepay setupFeeWaived display flag —
//                             does NOT recompute line-item totals).
//   note?:          string  — operator note (≤400 chars).
// }
//
// Full coverage only: credit must cover the entire amount due. Partial
// application is deliberately NOT supported — leaving an invoice collectible
// for a remainder would let the Stripe/Terminal pay paths still charge the
// full `invoice.total` (they price off total, not total − credit), over-
// collecting. To prepay part of a bill, lower the invoice first.
//
// On success the invoice becomes terminal `prepaid` (+ `paid_at`, so AR
// dashboards and annual-prepay activation — both keyed on `paid_at` — treat
// it as closed). Any already-open PaymentIntent is cancelled first so a stale
// session can't charge the card after the credit is consumed; if that PI has
// money in flight the request is refused for manual review.
const PI_MONEY_IN_FLIGHT_STATUSES = ['processing', 'succeeded', 'requires_capture'];

router.post('/:id/apply-credit', requireAdmin, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { waiveSetupFee = false, note } = req.body || {};
    const trimmedNote = typeof note === 'string' ? note.trim().slice(0, 400) : '';
    const recordedBy = req.technician?.name || req.technician?.email || req.technicianId || 'admin';

    // ── Pre-checks (no lock): status, amount due, sufficient balance ──
    const invoice = await db('invoices').where({ id }).first();
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    // Third-party Bill-To: account credit belongs to the homeowner. A
    // payer-billed invoice is owed by the payer, not the homeowner — drawing
    // down the service customer's credit to mark the AP invoice prepaid would
    // consume the wrong party's money. Reject it before any state change (a
    // payer-facing credit flow is Phase 2).
    if (invoice.payer_id) {
      return res.status(400).json({ error: 'Invoice is billed to a third-party payer — account credit cannot be applied to payer invoices' });
    }
    try {
      assertInvoiceCollectible(invoice.status);
    } catch (err) {
      return res.status(invoice.status === 'processing' ? 409 : 400).json({ error: err.message });
    }
    const total = CustomerCredit.round2(invoice.total || 0);
    if (total <= 0) {
      return res.status(400).json({ error: 'Invoice has no amount to collect (total is $0)' });
    }
    const amountDue = CustomerCredit.round2(total - CustomerCredit.round2(invoice.credit_applied || 0));
    if (amountDue <= 0) {
      return res.status(400).json({ error: 'Invoice is already fully covered by credit' });
    }
    const balance = (await CustomerCredit.getBalance(invoice.customer_id)) || 0;
    if (balance + 0.005 < amountDue) {
      return res.status(400).json({
        error: `Insufficient account credit — balance is $${balance.toFixed(2)}, `
          + `invoice needs $${amountDue.toFixed(2)}. Issue more credit first, or lower the invoice.`,
      });
    }

    // ── Cancel any open collection session (pre-lock Stripe triage) ──
    // Once the invoice is prepaid, assertInvoiceCollectible blocks NEW
    // PaymentIntents / Terminal handoffs, but an already-minted PI could
    // still settle and charge the card. Cancel it; refuse if money is in
    // flight (mirrors the cancelled-service auto-void triage).
    const openPiId = invoice.stripe_payment_intent_id || null;
    if (openPiId) {
      const StripeService = require('../services/stripe');
      let pi;
      try {
        pi = await StripeService.retrievePaymentIntent(openPiId);
      } catch (e) {
        return res.status(409).json({ error: `Open payment session ${openPiId} could not be verified (${e.message}); resolve it before applying credit` });
      }
      // Null = Stripe unconfigured/unreachable — we can't prove the PI is dead,
      // so fail closed rather than consume credit while a client secret could
      // still settle (the webhook treats prepaid as terminal and would skip it).
      if (!pi) {
        return res.status(409).json({ error: `Open payment session ${openPiId} could not be verified (payment service unavailable); resolve it before applying credit` });
      }
      if (pi && PI_MONEY_IN_FLIGHT_STATUSES.includes(pi.status)) {
        return res.status(409).json({ error: `A payment is already in flight (${pi.status}); wait for it to settle or refund it before applying credit` });
      }
      if (pi && pi.status !== 'canceled') {
        try {
          await StripeService.cancelPaymentIntent(openPiId, { cancellation_reason: 'abandoned' });
        } catch (e) {
          return res.status(409).json({ error: `Couldn't cancel the open payment session ${openPiId} (${e.message}); resolve it before applying credit` });
        }
      }
    }

    // ── Atomic credit draw-down + prepaid transition ──
    let outcome;
    try {
      outcome = await db.transaction(async (trx) => {
        const locked = await trx('invoices').where({ id }).forUpdate().first();
        if (!locked) {
          const err = new Error('Invoice not found'); err.statusCode = 404; err.isOperational = true; throw err;
        }
        try {
          assertInvoiceCollectible(locked.status);
        } catch (err) {
          err.statusCode = locked.status === 'processing' ? 409 : 400; err.isOperational = true; throw err;
        }
        // A customer could have opened /pay/:token/setup between our pre-lock
        // PI triage and this row lock, minting a NEW PaymentIntent (its own
        // lock released by now). If the invoice's PI changed from the one we
        // triaged/cancelled, refuse — the operator retries and the new PI gets
        // triaged. Without this, we'd consume credit while a live client
        // secret could still charge the card.
        if ((locked.stripe_payment_intent_id || null) !== (openPiId || null)) {
          const err = new Error('A new payment session started for this invoice — retry applying credit');
          err.statusCode = 409; err.isOperational = true; throw err;
        }
        const lockedTotal = CustomerCredit.round2(locked.total || 0);
        const lockedDue = CustomerCredit.round2(lockedTotal - CustomerCredit.round2(locked.credit_applied || 0));
        if (lockedDue <= 0) {
          const err = new Error('Invoice is already fully covered by credit'); err.statusCode = 400; err.isOperational = true; throw err;
        }

        // Consume the credit (throws 400 on insufficient balance → rolls back).
        const { balanceAfter } = await CustomerCredit.postCreditMovement({
          customerId: locked.customer_id,
          delta: -lockedDue,
          source: 'invoice_prepaid',
          invoiceId: id,
          note: trimmedNote || null,
          createdBy: recordedBy,
        }, trx);

        const updates = {
          credit_applied: CustomerCredit.round2(CustomerCredit.round2(locked.credit_applied || 0) + lockedDue),
          status: 'prepaid',
          prepaid_prev_status: locked.status,
          prepaid_at: trx.fn.now(),
          prepaid_by: recordedBy,
          // Stamp paid_at so paid_at-keyed paths (AR dashboards, annual-prepay
          // activation) treat the prepaid invoice as closed. Status stays
          // 'prepaid' so collected-revenue stats (keyed on status='paid')
          // don't double-count against the payments ledger row below.
          paid_at: trx.fn.now(),
          updated_at: trx.fn.now(),
        };
        if (waiveSetupFee) updates.setup_fee_waived = true;
        await trx('invoices').where({ id }).update(updates);

        // No payments-ledger row here. Revenue is recognized when cash is
        // RECEIVED — a cash-backed prepayment books its payment row at credit
        // issuance (POST /admin/customers/:id/credits, kind=prepayment);
        // goodwill/adjustment credit is non-cash and never booked. Booking
        // again at application would double-count cash or tax courtesy credit
        // as income (owner decision 2026-06-17).

        return { invoice: locked, cover: lockedDue, balanceAfter };
      });
    } catch (err) {
      if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
      throw err;
    }

    const { invoice: covered, cover, balanceAfter } = outcome;

    // Stop reminders + activate any linked annual-prepay term, mirroring the
    // manual/Stripe paid paths (term activation keys on paid_at, now stamped).
    try {
      const FollowUps = require('../services/invoice-followups');
      await FollowUps.stopOnPayment(id);
    } catch (err) {
      logger.warn(`[admin-invoices:apply-credit] stopOnPayment failed: ${err.message}`);
    }
    try {
      const final = await db('invoices').where({ id }).first();
      await AnnualPrepayRenewals.syncTermForInvoicePayment(final);
    } catch (err) {
      logger.warn(`[admin-invoices:apply-credit] annual prepay activation failed: ${err.message}`);
    }

    await db('activity_log').insert({
      customer_id: covered.customer_id,
      action: 'invoice_marked_prepaid',
      description: `$${cover.toFixed(2)} account credit applied to ${covered.invoice_number}`
        + ` — marked PREPAID (remaining credit $${balanceAfter.toFixed(2)}) — ${recordedBy}`
        + (trimmedNote ? ` — ${trimmedNote.slice(0, 120)}` : ''),
    }).catch((err) => logger.warn(`[admin-invoices:apply-credit] activity_log insert failed: ${err.message}`));

    const final = await db('invoices').where({ id }).first();
    res.json({
      ok: true,
      invoice: final,
      applied: cover,
      fully_covered: true,
      balance: balanceAfter,
    });
  } catch (err) {
    logger.error(`[admin-invoices] apply-credit failed: ${err.message}`);
    next(err);
  }
});

// POST /:id/reverse-prepaid — undo a prepaid invoice: restore the consumed
// account credit to the customer and reopen the invoice for collection. This
// is the repair path for credit applied to the wrong invoice (a prepaid
// invoice is otherwise non-voidable / edit-locked to protect the credit).
//
// Body: { note?: string }
//
// The cash row booked at credit issuance is intentionally left in place — the
// money is simply held as account credit again. Reopens to `sent` (collectible
// again). Body note is appended to the credit ledger + activity entry.
router.post('/:id/reverse-prepaid', requireAdmin, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { note } = req.body || {};
    const trimmedNote = typeof note === 'string' ? note.trim().slice(0, 400) : '';
    const recordedBy = req.technician?.name || req.technician?.email || req.technicianId || 'admin';

    let outcome;
    try {
      outcome = await db.transaction(async (trx) => {
        const locked = await trx('invoices').where({ id }).forUpdate().first();
        if (!locked) {
          const err = new Error('Invoice not found'); err.statusCode = 404; err.isOperational = true; throw err;
        }
        // Reversible: a fully-covered prepaid invoice, OR a still-collectible
        // invoice carrying a PARTIAL auto-applied credit. The latter is otherwise
        // edit-locked (credit_applied > 0 blocks editing) with no way to return
        // the credit short of voiding — this is that return path.
        const isPrepaid = locked.status === 'prepaid';
        const isCollectibleWithCredit = !isPrepaid
          && !INVOICE_UNCOLLECTIBLE_STATUSES.includes(locked.status)
          // 'sending' isn't in INVOICE_UNCOLLECTIBLE_STATUSES, but a concurrent
          // send may hold the claim and be delivering a reduced-amount pay link —
          // reversing here would pull the credit out from under it (same race
          // reverseAppliedCredit guards). Refuse while a send is in flight.
          && String(locked.status || '').toLowerCase() !== 'sending'
          && CustomerCredit.round2(locked.credit_applied || 0) > 0;
        if (!isPrepaid && !isCollectibleWithCredit) {
          const err = new Error('Only a prepaid invoice or one with partially applied account credit can be reversed'); err.statusCode = 400; err.isOperational = true; throw err;
        }
        // A partial reversal raises the invoice's amount due (credit_applied → 0),
        // but an active payment plan was built against the REDUCED amount due — its
        // total_balance wouldn't move, so reversing here would under-collect and
        // desync AR. Refuse until the plan is cancelled/recreated. (Mirrors the
        // apply-side active-plan guard; a fully-prepaid invoice is exempt — it is
        // credit-covered with nothing on a collection plan.)
        if (isCollectibleWithCredit) {
          const activePlan = await trx('payment_plans')
            .where({ invoice_id: id, status: 'active' })
            .first('id');
          if (activePlan) {
            const err = new Error('This invoice has an active payment plan built against the reduced balance — cancel or recreate the plan before reversing the applied credit'); err.statusCode = 409; err.isOperational = true; throw err;
          }
        }
        const restore = CustomerCredit.round2(locked.credit_applied || 0);
        if (restore <= 0) {
          const err = new Error('No applied credit to restore'); err.statusCode = 400; err.isOperational = true; throw err;
        }

        const { balanceAfter } = await CustomerCredit.postCreditMovement({
          customerId: locked.customer_id,
          delta: restore,
          source: 'adjustment',
          invoiceId: id,
          note: `Prepaid reversal for ${locked.invoice_number}${trimmedNote ? ` — ${trimmedNote}` : ''}`,
          createdBy: recordedBy,
        }, trx);

        if (isPrepaid) {
          // Restore the status the invoice held before it was prepaid (draft/
          // scheduled/sent/viewed/overdue); fall back to 'sent' for older rows
          // minted before prepaid_prev_status existed.
          await trx('invoices').where({ id }).update({
            status: locked.prepaid_prev_status || 'sent',
            credit_applied: 0,
            prepaid_at: null,
            prepaid_by: null,
            prepaid_prev_status: null,
            paid_at: null,
            setup_fee_waived: false,
            updated_at: trx.fn.now(),
          });
        } else {
          // Partial credit on a still-collectible invoice. If a PaymentIntent was
          // minted against the reduced amount due, reversing the credit raises the
          // amount due while that PI could still settle for the lower amount —
          // refuse (fail closed, under this row lock) and let the operator resolve
          // the open session first. (apply-credit cancels the PI before applying;
          // this is the symmetric guard for the reverse direction. The whole
          // transaction — including the credit restore above — rolls back.)
          if (locked.stripe_payment_intent_id) {
            const err = new Error('This invoice has an open payment session — resolve it before reversing the applied credit');
            err.statusCode = 409; err.isOperational = true; throw err;
          }
          // Return the credit and clear credit_applied — the status and stamps are
          // already correct, and this re-opens the invoice for editing.
          await trx('invoices').where({ id }).update({
            credit_applied: 0,
            updated_at: trx.fn.now(),
          });
        }

        // If apply-credit had activated a linked annual-prepay term, un-pay it:
        // drop the term back to payment_pending and clear the future-visit
        // prepaid stamps so covered visits bill normally again. A later real
        // payment reactivates it (renewal-decided terms are left untouched).
        // Prepaid-only: a partial credit on a collectible invoice never activated
        // a term.
        if (isPrepaid && locked.annual_prepay_term_id) {
          await trx('annual_prepay_terms')
            .where({ id: locked.annual_prepay_term_id })
            .whereNull('renewal_decision')
            .whereNotIn('status', ['cancelled', 'canceled'])
            .update({ status: 'payment_pending', updated_at: trx.fn.now() });
          // throwOnError → if stamp cleanup fails, the whole reversal rolls
          // back rather than restoring credit while visits stay stamped free.
          await AnnualPrepayRenewals.clearPrepaidStampsForTerm(locked.annual_prepay_term_id, trx, { throwOnError: true });
        }

        return { invoice: locked, restore, balanceAfter };
      });
    } catch (err) {
      if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
      throw err;
    }

    const { invoice: reversed, restore, balanceAfter } = outcome;

    // apply-credit completed the follow-up sequence (stopOnPayment); the invoice
    // is collectible again, so re-arm reminders. resumeSequence reactivates an
    // existing (completed) row; scheduleForInvoice creates one if none exists.
    try {
      const FollowUps = require('../services/invoice-followups');
      await FollowUps.resumeSequence(id);
      await FollowUps.scheduleForInvoice(id);
    } catch (err) {
      logger.warn(`[admin-invoices:reverse-prepaid] follow-up re-arm failed: ${err.message}`);
    }

    await db('activity_log').insert({
      customer_id: reversed.customer_id,
      action: 'invoice_prepaid_reversed',
      description: `Prepaid reversed on ${reversed.invoice_number} — $${restore.toFixed(2)} credit`
        + ` restored (balance $${balanceAfter.toFixed(2)}), invoice reopened — ${recordedBy}`
        + (trimmedNote ? ` — ${trimmedNote.slice(0, 120)}` : ''),
    }).catch((err) => logger.warn(`[admin-invoices:reverse-prepaid] activity_log insert failed: ${err.message}`));

    const final = await db('invoices').where({ id }).first();
    res.json({ ok: true, invoice: final, restored: restore, balance: balanceAfter });
  } catch (err) {
    logger.error(`[admin-invoices] reverse-prepaid failed: ${err.message}`);
    next(err);
  }
});

// POST /:id/payment-plan — create a customer payment plan for this invoice
// and fire the lifecycle confirmation email. The notification helper already
// dedupes on payment_plan_id, so repeated sends won't spam the customer.
router.post('/:id/payment-plan', requireAdmin, async (req, res, next) => {
  try {
    const { id } = req.params;
    const body = req.body || {};
    const invoice = await db('invoices').where({ id }).first();
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    // Third-party Bill-To: a payment plan is a homeowner-scoped arrangement
    // (payment_plans.customer_id) that pauses the invoice's collection path. A
    // payer-billed invoice is owed by the payer, not the homeowner — reject it
    // here before inserting a plan / pausing follow-ups (a payer-facing plan
    // flow is Phase 2).
    if (invoice.payer_id) {
      return res.status(400).json({ error: 'Invoice is billed to a third-party payer — payment plans are not supported for payer invoices' });
    }
    try {
      assertInvoiceCollectible(invoice.status);
    } catch (err) {
      return res.status(invoice.status === 'processing' ? 409 : 400).json({ error: err.message });
    }
    if (parseFloat(invoice.total || 0) <= 0) {
      return res.status(400).json({ error: 'Invoice has no amount to collect (total is $0)' });
    }
    const activePlan = await db('payment_plans')
      .where({ invoice_id: invoice.id, status: 'active' })
      .first('id');
    if (activePlan) {
      return res.status(409).json({ error: 'Invoice already has an active payment plan' });
    }

    const paymentFrequency = cleanOptionalText(body.paymentFrequency || body.payment_frequency, 40);
    if (!VALID_PAYMENT_PLAN_FREQUENCIES.includes(paymentFrequency)) {
      return res.status(400).json({
        error: `paymentFrequency must be one of: ${VALID_PAYMENT_PLAN_FREQUENCIES.join(', ')}`,
      });
    }

    // Server-authoritative plan balance: amount DUE (total − applied account
    // credit) is the canonical max. CLAMP any client-supplied totalBalance to it —
    // a stale admin modal posts the pre-credit invoice.total, which would create a
    // plan that over-collects the applied credit.
    const amountDue = invoiceAmountDue(invoice);
    const totalBalance = Math.min(
      parsePositiveMoney(body.totalBalance ?? body.total_balance ?? amountDue, 'totalBalance'),
      amountDue,
    );
    const paymentAmount = parsePositiveMoney(body.paymentAmount ?? body.payment_amount, 'paymentAmount');
    if (paymentAmount > totalBalance) {
      return res.status(400).json({ error: 'paymentAmount cannot exceed totalBalance' });
    }

    const planStartDate = parseDateOnly(body.planStartDate || body.plan_start_date || etDateString(), 'planStartDate');
    const nextPaymentDate = parseDateOnly(body.nextPaymentDate || body.next_payment_date, 'nextPaymentDate');
    const paymentMethodId = body.paymentMethodId || body.payment_method_id || null;
    const notes = cleanOptionalText(body.notes || body.note, 500);
    const createdBy = req.technician?.name || req.technician?.email || req.technicianId || 'admin';

    let paymentPlan;
    try {
      const adminId = req.user?.id || req.technicianId || null;
      paymentPlan = await db.transaction(async (trx) => {
        // Re-read the invoice under a row lock so a concurrent seam auto-apply can't
        // lower amount due between the earlier read and this insert and leave a plan
        // that over-collects the now-applied credit. Re-clamp the balance to the FRESH
        // amount due and re-validate the installment against it.
        const lockedInvoice = await trx('invoices').where({ id: invoice.id }).forUpdate().first();
        const lockedAmountDue = lockedInvoice ? invoiceAmountDue(lockedInvoice) : amountDue;
        const lockedTotalBalance = Math.min(totalBalance, lockedAmountDue);
        if (!(lockedTotalBalance > 0)) {
          const e = new Error('Invoice has no remaining balance after applied account credit — no payment plan needed');
          e.statusCode = 409; throw e;
        }
        if (paymentAmount > lockedTotalBalance) {
          const e = new Error('paymentAmount cannot exceed the invoice balance after applied account credit');
          e.statusCode = 400; throw e;
        }
        const [createdPlan] = await trx('payment_plans')
          .insert({
            customer_id: invoice.customer_id,
            invoice_id: invoice.id,
            payment_method_id: paymentMethodId,
            total_balance: lockedTotalBalance,
            payment_amount: paymentAmount,
            payment_frequency: paymentFrequency,
            plan_start_date: planStartDate,
            next_payment_date: nextPaymentDate,
            status: 'active',
            notes,
            created_by: createdBy,
            created_by_user_id: req.technicianId || null,
          })
          .returning('*');

        await stopInvoiceFollowupsForPaymentPlan(invoice.id, {
          paymentPlanId: createdPlan?.id,
          adminId,
          database: trx,
        });

        return createdPlan;
      });
    } catch (err) {
      if (err?.code === '23505' && String(err.constraint || '').includes('payment_plans_one_active_per_invoice')) {
        return res.status(409).json({ error: 'Invoice already has an active payment plan' });
      }
      // Under-lock re-clamp validations (balance covered by credit / installment too
      // large after credit) surface as client errors, not 500s.
      if (err?.statusCode === 400 || err?.statusCode === 409) {
        return res.status(err.statusCode).json({ error: err.message });
      }
      throw err;
    }

    const PaymentLifecycleEmail = require('../services/payment-lifecycle-email');
    const emailResult = await PaymentLifecycleEmail.sendPaymentPlanConfirmed({
      customerId: invoice.customer_id,
      paymentPlanId: paymentPlan.id,
      paymentMethodId,
      plan: paymentPlan,
      idempotencyKey: `payment.plan_confirmed:${paymentPlan.id}:${invoice.customer_id}`,
    }).catch((err) => ({ ok: false, error: err.message }));

    try {
      const FollowUps = require('../services/invoice-followups');
      await FollowUps.pauseSequence(invoice.id, {
        reason: 'payment_plan_created',
        adminId: req.user?.id || req.technicianId || null,
      });
    } catch (err) {
      logger.warn(`[admin-invoices:payment-plan] follow-up pause failed: ${err.message}`);
    }

    await db('activity_log').insert({
      customer_id: invoice.customer_id,
      action: 'payment_plan_created',
      description: `Payment plan created for invoice ${invoice.invoice_number || invoice.id}: `
        + `$${paymentAmount.toFixed(2)} ${paymentFrequency} toward $${Number(paymentPlan.total_balance).toFixed(2)} — ${createdBy}`,
      metadata: {
        invoice_id: invoice.id,
        payment_plan_id: paymentPlan.id,
        email_result: emailResult,
      },
    }).catch((err) => logger.warn(`[admin-invoices:payment-plan] activity_log insert failed: ${err.message}`));

    res.status(201).json({
      ok: true,
      paymentPlan,
      email: emailResult,
    });
  } catch (err) {
    logger.error(`[admin-invoices] payment-plan failed: ${err.message}`);
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
router.post('/:id/followup/pause', requireAdmin, async (req, res, next) => {
  try {
    const { reason, until } = req.body || {};
    await FollowUps.pauseSequence(req.params.id, {
      reason, until, adminId: req.user?.id || null,
    });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// POST /:id/followup/resume
router.post('/:id/followup/resume', requireAdmin, async (req, res, next) => {
  try {
    await FollowUps.resumeSequence(req.params.id);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// POST /:id/followup/stop
router.post('/:id/followup/stop', requireAdmin, async (req, res, next) => {
  try {
    const { reason } = req.body || {};
    await FollowUps.stopSequence(req.params.id, {
      reason, adminId: req.user?.id || null,
    });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// POST /:id/followup/send-now — fires the next touch immediately
router.post('/:id/followup/send-now', requireAdmin, async (req, res, next) => {
  try {
    await FollowUps.sendNextTouchNow(req.params.id);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router._private = {
  invoiceRecipientOverrideError,
  paymentPlanFollowupStopReason,
  stopInvoiceFollowupsForPaymentPlan,
};

module.exports = router;
