const crypto = require('crypto');
const db = require('../models/db');
const logger = require('./logger');
const TaxCalculator = require('./tax-calculator');
const DiscountEngine = require('./discount-engine');
const { etDateString, addETDays } = require('../utils/datetime-et');
const { shortenOrPassthrough } = require('./short-url');

// ══════════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════════
function generateToken() {
  // 32 random bytes → 64 hex chars. Unguessable. Legacy short tokens still resolve via DB lookup.
  return crypto.randomBytes(32).toString('hex');
}

async function nextInvoiceNumber() {
  const year = new Date().getFullYear();
  const prefix = `WPC-${year}-`;
  const last = await db('invoices')
    .where('invoice_number', 'like', `${prefix}%`)
    .orderBy('invoice_number', 'desc')
    .first();
  if (!last) return `${prefix}0001`;
  const num = parseInt(last.invoice_number.replace(prefix, '')) + 1;
  return `${prefix}${String(num).padStart(4, '0')}`;
}

// WaveGuard tier discount percentages — now loaded from discount engine DB
// Fallback map only used if discount-engine import fails
const TIER_DISCOUNTS_FALLBACK = { 'One-Time': 0, Bronze: 0, Silver: 0.10, Gold: 0.15, Platinum: 0.20 };

// ══════════════════════════════════════════════════════════════
// INVOICE SERVICE
// ══════════════════════════════════════════════════════════════
const InvoiceService = {

  /**
   * Create an invoice — optionally linked to a service record.
   * If serviceRecordId is provided, pulls products, photos, tech info automatically.
   */
  async create({ customerId, serviceRecordId, scheduledServiceId, title, lineItems, notes, dueDate, taxRate }) {
    const customer = await db('customers').where({ id: customerId }).first();
    if (!customer) throw new Error('Customer not found');

    // Pull service record context if linked
    let serviceData = {};
    if (serviceRecordId) {
      const sr = await db('service_records')
        .where({ 'service_records.id': serviceRecordId })
        .leftJoin('technicians', 'service_records.technician_id', 'technicians.id')
        .select('service_records.*', 'technicians.name as tech_name')
        .first();

      if (sr) {
        const products = await db('service_products')
          .where({ service_record_id: serviceRecordId })
          .select('product_name', 'product_category', 'active_ingredient', 'application_rate', 'rate_unit', 'notes');

        const photos = await db('service_photos')
          .where({ service_record_id: serviceRecordId })
          .orderBy('sort_order', 'asc')
          .select('photo_type', 's3_url', 'caption');

        serviceData = {
          service_record_id: serviceRecordId,
          technician_id: sr.technician_id,
          service_date: sr.service_date,
          service_type: sr.service_type,
          tech_name: sr.tech_name,
          tech_notes: sr.technician_notes,
          products_applied: JSON.stringify(products),
          service_photos: JSON.stringify(photos),
        };

        // Auto-generate title from service type if not provided
        if (!title) {
          const dateStr = new Date(sr.service_date).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'America/New_York' });
          title = `${sr.service_type} — ${dateStr}`;
        }
      }
    }

    // Calculate financials
    const items = lineItems || [];
    const subtotal = items.reduce((sum, item) => sum + (item.quantity * item.unit_price), 0);

    // Apply WaveGuard tier discount via discount engine
    let tierDiscount;
    try {
      tierDiscount = await DiscountEngine.getDiscountForTier(customer.waveguard_tier);
    } catch {
      tierDiscount = TIER_DISCOUNTS_FALLBACK[customer.waveguard_tier] || 0;
    }
    const discountAmount = Math.round(subtotal * tierDiscount * 100) / 100;
    const discountLabel = tierDiscount > 0
      ? `${customer.waveguard_tier} WaveGuard — ${Math.round(tierDiscount * 100)}% off`
      : null;

    const afterDiscount = subtotal - discountAmount;

    // Tax — use TaxCalculator for automatic county-aware tax when taxRate not explicit.
    // Residential customers never see tax on invoices/receipts per operator
    // policy, so we force rate + amount to zero regardless of what the
    // caller passed. This is the single source of truth; display surfaces
    // (pay page, receipt page, PDF) can rely on stored tax_amount == 0.
    const isCommercial = customer.property_type === 'commercial' || customer.property_type === 'business';
    let rate, taxAmount;
    if (!isCommercial) {
      rate = 0;
      taxAmount = 0;
    } else if (taxRate !== undefined) {
      rate = taxRate;
      taxAmount = Math.round(afterDiscount * rate * 100) / 100;
    } else {
      try {
        const taxResult = await TaxCalculator.calculateTax(customerId, serviceData.service_type || title, afterDiscount);
        rate = taxResult.rate;
        taxAmount = taxResult.amount;
      } catch (err) {
        logger.warn(`[invoice] TaxCalculator failed, falling back to legacy logic: ${err.message}`);
        rate = 0.07;
        taxAmount = Math.round(afterDiscount * rate * 100) / 100;
      }
    }
    const total = Math.round((afterDiscount + taxAmount) * 100) / 100;

    const token = generateToken();
    const invoiceNumber = await nextInvoiceNumber();

    const [invoice] = await db('invoices').insert({
      token,
      invoice_number: invoiceNumber,
      customer_id: customerId,
      title,
      line_items: JSON.stringify(items),
      subtotal,
      discount_amount: discountAmount,
      discount_label: discountLabel,
      tax_rate: rate,
      tax_amount: taxAmount,
      total,
      notes: notes || null,
      due_date: dueDate || etDateString(addETDays(new Date(), 30)),
      status: 'draft',
      ...(scheduledServiceId ? { scheduled_service_id: scheduledServiceId } : {}),
      ...serviceData,
    }).returning('*');

    // Record applied discounts in invoice_discounts table
    try {
      if (discountAmount > 0) {
        const tierDiscountRow = await db('discounts')
          .where({ is_waveguard_tier_discount: true, requires_waveguard_tier: customer.waveguard_tier, is_active: true })
          .first();
        await DiscountEngine.recordInvoiceDiscounts(invoice.id, [{
          id: tierDiscountRow?.id || null,
          name: discountLabel,
          discount_type: 'percentage',
          amount: tierDiscount * 100,
          discount_dollars: discountAmount,
        }], 'system');
      }
      // Also record any non-tier discounts assigned to this customer
      const extraResult = await DiscountEngine.calculateDiscounts(customerId, { subtotal, isEstimate: false });
      if (extraResult.discounts.length > 0) {
        await DiscountEngine.recordInvoiceDiscounts(invoice.id, extraResult.discounts, 'system');
      }
    } catch (err) {
      logger.warn(`[invoice] Could not record invoice_discounts: ${err.message}`);
    }

    logger.info(`[invoice] Created ${invoiceNumber} for customer ${customerId}: $${total}`);
    return invoice;
  },

  /**
   * Create an invoice directly from a service record + simple amount.
   * Convenience method for post-service flow.
   */
  async createFromService(serviceRecordId, { amount, description, taxRate }) {
    const sr = await db('service_records').where({ id: serviceRecordId }).first();
    if (!sr) throw new Error('Service record not found');

    const lineItems = [{
      description: description || sr.service_type,
      quantity: 1,
      unit_price: amount,
      amount,
      category: sr.service_type,
    }];

    return this.create({
      customerId: sr.customer_id,
      serviceRecordId,
      lineItems,
      taxRate,
    });
  },

  /**
   * Get invoice by public token — for the /pay page.
   * Also records view and updates status.
   */
  async getByToken(token) {
    const invoice = await db('invoices').where({ token }).first();
    if (!invoice) return null;

    // Record view
    const updates = { view_count: (invoice.view_count || 0) + 1 };
    if (!invoice.viewed_at) updates.viewed_at = new Date();
    if (invoice.status === 'sent') updates.status = 'viewed';
    await db('invoices').where({ id: invoice.id }).update(updates);

    // Enrich with customer info
    const customer = await db('customers')
      .where({ id: invoice.customer_id })
      .select('first_name', 'last_name', 'email', 'phone', 'address_line1',
        'city', 'state', 'zip', 'waveguard_tier', 'property_sqft')
      .first();

    return {
      ...invoice,
      ...updates,
      customer,
      line_items: typeof invoice.line_items === 'string' ? JSON.parse(invoice.line_items) : invoice.line_items,
      products_applied: typeof invoice.products_applied === 'string' ? JSON.parse(invoice.products_applied) : (invoice.products_applied || []),
      service_photos: typeof invoice.service_photos === 'string' ? JSON.parse(invoice.service_photos) : (invoice.service_photos || []),
    };
  },

  /**
   * Send invoice via Twilio SMS — the unified service recap + invoice message.
   */
  async sendViaSMS(invoiceId) {
    const invoice = await db('invoices').where({ id: invoiceId }).first();
    if (!invoice) throw new Error('Invoice not found');

    const customer = await db('customers').where({ id: invoice.customer_id }).first();
    if (!customer?.phone) throw new Error('Customer has no phone number');

    const domain = process.env.CLIENT_URL || 'https://portal.wavespestcontrol.com';
    const longPayUrl = `${domain}/pay/${invoice.token}`;
    const payUrl = await shortenOrPassthrough(longPayUrl, {
      kind: 'invoice', entityType: 'invoices', entityId: invoice.id, customerId: customer.id,
    });

    const techName = invoice.tech_name || 'Our team';
    const serviceType = invoice.service_type || invoice.title || 'your service';

    let formattedDate = '';
    if (invoice.service_date) {
      try {
        // Knex returns DATE as a Date object (UTC midnight). Avoid the broken
        // `date + 'T12:00:00'` string concat and always format in ET.
        const d = invoice.service_date instanceof Date
          ? invoice.service_date
          : new Date(invoice.service_date + 'T12:00:00');
        if (!isNaN(d.getTime())) {
          formattedDate = d.toLocaleDateString('en-US', {
            weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
            timeZone: 'America/New_York',
          });
        }
      } catch { formattedDate = ''; }
    }

    // Use DB template if available, fall back to inline
    let body;
    try {
      const templates = require('../routes/admin-sms-templates');
      body = await templates.getTemplate('invoice_sent', {
        first_name: customer.first_name || '',
        service_type: serviceType,
        service_date: formattedDate || 'today',
        pay_url: payUrl,
      });
    } catch (err) {
      logger.warn(`[invoice] Template lookup failed: ${err.message}`);
    }

    // Fallback — always use inline if template returned null or still has unreplaced vars
    if (!body || body.includes('{first_name}') || body.includes('{service_type}')) {
      body = `Hi ${customer.first_name}! Your invoice for ${serviceType} completed on ${formattedDate || 'today'} is ready: ${payUrl}\n\n` +
        `Questions or requests? Reply to this message. Thank you for choosing Waves!`;
    }

    try {
      const TwilioService = require('./twilio');
      await TwilioService.sendSMS(customer.phone, body, {
        customerId: customer.id,
        messageType: 'invoice',
      });

      await db('invoices').where({ id: invoiceId }).update({
        status: invoice.status === 'draft' ? 'sent' : invoice.status,
        sent_at: new Date(),
        sms_sent_at: new Date(),
        updated_at: new Date(),
      });

      // Kick off the per-invoice automated follow-up sequence (Day 0/3/7/14/30)
      try {
        await require('./invoice-followups').scheduleForInvoice(invoiceId);
      } catch (e) {
        logger.error(`[invoice-followups] scheduleForInvoice failed: ${e.message}`);
      }

      // Log
      await db('activity_log').insert({
        customer_id: customer.id,
        action: 'invoice_sent',
        description: `Invoice ${invoice.invoice_number} sent via SMS: $${invoice.total}`,
        metadata: JSON.stringify({ invoiceId, payUrl }),
      }).catch(() => {});

      logger.info(`[invoice] SMS sent for ${invoice.invoice_number} to ${customer.phone}`);
      return { sent: true, payUrl };
    } catch (err) {
      logger.error(`[invoice] SMS failed for ${invoice.invoice_number}: ${err.message}`);
      throw err;
    }
  },

  /**
   * Send payment confirmation SMS receipt.
   *
   * Idempotent: skips if invoices.receipt_sent_at is already set, unless
   * `force: true` is passed (admin manual resend). On successful Twilio
   * send the column is stamped and an activity_log row is inserted, so
   * the invoice activity feed reflects the auto-receipt regardless of
   * which payment path triggered it (Stripe webhook, /pay confirm, etc.).
   *
   * Throws on Twilio failure so callers can surface it. The Stripe
   * webhook and pay-v2 confirm handlers wrap the call in their own
   * .catch() with loud error logging.
   */
  async sendReceipt(invoiceId, { force = false, recordActivity = true } = {}) {
    const invoice = await db('invoices').where({ id: invoiceId }).first();
    if (!invoice || invoice.status !== 'paid') return { sent: false, reason: 'not-paid' };

    if (invoice.receipt_sent_at && !force) {
      logger.info(`[invoice] Receipt already sent for ${invoice.invoice_number} — skipping`);
      return { sent: false, reason: 'already-sent' };
    }

    const customer = await db('customers').where({ id: invoice.customer_id }).first();
    if (!customer?.phone) return { sent: false, reason: 'no-phone' };

    const amount = Number(invoice.total).toFixed(2);
    const domain = process.env.PORTAL_DOMAIN || 'https://portal.wavespestcontrol.com';
    const longReceiptUrl = invoice.token ? `${domain}/pay/${invoice.token}` : '';
    const receiptUrl = longReceiptUrl
      ? await shortenOrPassthrough(longReceiptUrl, { kind: 'invoice', entityType: 'invoices', entityId: invoice.id, customerId: customer.id })
      : '';

    // Template body has a {card_line} placeholder that renders as e.g.
    // " (Visa •4242)" when card metadata is present, or empty otherwise.
    const cardBrand = invoice.card_brand;
    const cardLast4 = invoice.card_last_four;
    const cardLine = cardBrand && cardLast4 ? ` (${cardBrand.charAt(0).toUpperCase() + cardBrand.slice(1)} •${cardLast4})` : '';

    const fallback = `Hello ${customer.first_name}! Thank you for your payment — we truly appreciate your business. You can view your receipt here: ${receiptUrl}.\n\nIf you have any questions or need assistance, simply reply to this message. Thanks again for choosing Waves!`;
    let body = fallback;
    try {
      const templates = require('../routes/admin-sms-templates');
      const rendered = await templates.getTemplate('invoice_receipt', {
        first_name: customer.first_name || '',
        invoice_number: invoice.invoice_number,
        amount,
        card_line: cardLine,
        receipt_url: receiptUrl,
      });
      if (rendered && !rendered.includes('{first_name}')) body = rendered;
    } catch (err) {
      logger.warn(`[invoice] Receipt template lookup failed: ${err.message}`);
    }

    const TwilioService = require('./twilio');
    await TwilioService.sendSMS(customer.phone, body, {
      customerId: customer.id,
      messageType: 'receipt',
    });
    logger.info(`[invoice] Receipt SMS sent for ${invoice.invoice_number}`);

    if (!invoice.receipt_sent_at) {
      await db('invoices').where({ id: invoiceId }).update({
        receipt_sent_at: db.fn.now(),
      }).catch((err) => logger.error(`[invoice] receipt_sent_at stamp failed for ${invoice.invoice_number}: ${err.message}`));
    }

    if (recordActivity) {
      await db('activity_log').insert({
        customer_id: invoice.customer_id,
        action: 'invoice_receipt_sent',
        description: `Receipt sent for invoice ${invoice.invoice_number} (sms)`,
      }).catch((err) => logger.warn(`[invoice] activity_log insert failed: ${err.message}`));
    }

    return { sent: true };
  },

  // ── Admin CRUD ──

  async getById(id) {
    const invoice = await db('invoices').where({ id }).first();
    if (!invoice) return null;
    const customer = await db('customers').where({ id: invoice.customer_id })
      .select('first_name', 'last_name', 'phone', 'email', 'waveguard_tier', 'address_line1', 'city', 'state', 'zip')
      .first();
    return { ...invoice, customer };
  },

  async list({ status, customerId, limit = 50, offset = 0, archived = 'hide' } = {}) {
    // archived semantics:
    //   'hide' (default) — WHERE archived_at IS NULL
    //   'only'            — WHERE archived_at IS NOT NULL
    //   'all'             — no filter
    const applyArchived = (q) => {
      if (archived === 'only') return q.whereNotNull('invoices.archived_at');
      if (archived === 'all') return q;
      return q.whereNull('invoices.archived_at');
    };

    let query = db('invoices')
      .leftJoin('customers', 'invoices.customer_id', 'customers.id')
      .select(
        'invoices.*',
        'customers.first_name',
        'customers.last_name',
        'customers.phone',
        'customers.email',
        'customers.waveguard_tier',
        db.raw(`(
          SELECT json_build_object('brand', card_brand, 'last_four', last_four)
          FROM payment_methods
          WHERE customer_id = invoices.customer_id AND is_default = true
          LIMIT 1
        ) AS card_on_file`)
      );
    if (status) query = query.where('invoices.status', status);
    if (customerId) query = query.where('invoices.customer_id', customerId);
    query = applyArchived(query);
    query = query.orderBy('invoices.created_at', 'desc').limit(limit).offset(offset);
    const invoices = await query;

    let countQuery = db('invoices');
    if (status) countQuery = countQuery.where({ status });
    if (customerId) countQuery = countQuery.where({ customer_id: customerId });
    countQuery = applyArchived(countQuery);
    const [{ count }] = await countQuery.count('* as count');

    return { invoices, total: parseInt(count) };
  },

  async update(id, updates) {
    const allowed = ['title', 'notes', 'due_date', 'line_items', 'status', 'tax_rate'];
    const data = { updated_at: new Date() };
    for (const key of allowed) {
      if (updates[key] !== undefined) {
        data[key] = key === 'line_items' ? JSON.stringify(updates[key]) : updates[key];
      }
    }

    // Recalculate totals if line items changed
    if (updates.line_items) {
      const invoice = await db('invoices').where({ id }).first();
      const customer = await db('customers').where({ id: invoice.customer_id }).first();
      const items = updates.line_items;
      const subtotal = items.reduce((sum, i) => sum + (i.quantity * i.unit_price), 0);
      let tierDiscount;
      try {
        tierDiscount = await DiscountEngine.getDiscountForTier(customer?.waveguard_tier);
      } catch {
        tierDiscount = TIER_DISCOUNTS_FALLBACK[customer?.waveguard_tier] || 0;
      }
      const discountAmount = Math.round(subtotal * tierDiscount * 100) / 100;
      const afterDiscount = subtotal - discountAmount;
      // Residential customers are never taxed — force 0 regardless of
      // what was stored or what the caller passed. Matches the guard in
      // create() above.
      const isCommercial = customer?.property_type === 'commercial' || customer?.property_type === 'business';
      let rate = 0;
      let taxAmount = 0;
      if (isCommercial) {
        const defaultRate = 0.07;
        rate = updates.tax_rate !== undefined ? updates.tax_rate : (invoice.tax_rate != null ? Number(invoice.tax_rate) : defaultRate);
        taxAmount = Math.round(afterDiscount * rate * 100) / 100;
      }
      data.subtotal = subtotal;
      data.discount_amount = discountAmount;
      data.discount_label = tierDiscount > 0 ? `${customer.waveguard_tier} WaveGuard — ${Math.round(tierDiscount * 100)}% off` : null;
      data.tax_rate = rate;
      data.tax_amount = taxAmount;
      data.total = Math.round((afterDiscount + taxAmount) * 100) / 100;
    }

    const [invoice] = await db('invoices').where({ id }).update(data).returning('*');
    return invoice;
  },

  async voidInvoice(id) {
    const [invoice] = await db('invoices').where({ id }).update({ status: 'void', updated_at: new Date() }).returning('*');
    logger.info(`[invoice] Voided: ${invoice.invoice_number}`);
    return invoice;
  },

  async getStats() {
    const [totals] = await db('invoices').select(
      db.raw("COUNT(*) as total"),
      db.raw("COUNT(*) FILTER (WHERE status = 'paid') as paid"),
      db.raw("COUNT(*) FILTER (WHERE status IN ('sent', 'viewed')) as outstanding"),
      db.raw("COUNT(*) FILTER (WHERE status = 'overdue') as overdue"),
      db.raw("COALESCE(SUM(total) FILTER (WHERE status = 'paid'), 0) as total_collected"),
      db.raw("COALESCE(SUM(total) FILTER (WHERE status IN ('sent', 'viewed', 'overdue')), 0) as total_outstanding"),
    );
    return {
      total: parseInt(totals.total),
      paid: parseInt(totals.paid),
      outstanding: parseInt(totals.outstanding),
      overdue: parseInt(totals.overdue),
      totalCollected: parseFloat(totals.total_collected),
      totalOutstanding: parseFloat(totals.total_outstanding),
    };
  },
};

module.exports = InvoiceService;
