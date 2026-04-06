const crypto = require('crypto');
const db = require('../models/db');
const logger = require('./logger');
const config = require('../config');
const { v4: uuidv4 } = require('uuid');

let paymentsApi;
try {
  const { Client, Environment } = require('square');
  if (config.square?.accessToken) {
    const client = new Client({
      accessToken: config.square.accessToken,
      environment: config.square.environment === 'production' ? Environment.Production : Environment.Sandbox,
    });
    paymentsApi = client.paymentsApi;
  }
} catch { /* square not available */ }

// ══════════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════════
function generateToken() {
  return crypto.randomBytes(32).toString('hex'); // 64 char hex string
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

// WaveGuard tier discount percentages
const TIER_DISCOUNTS = { Bronze: 0, Silver: 0.10, Gold: 0.15, Platinum: 0.20 };

// ══════════════════════════════════════════════════════════════
// INVOICE SERVICE
// ══════════════════════════════════════════════════════════════
const InvoiceService = {

  /**
   * Create an invoice — optionally linked to a service record.
   * If serviceRecordId is provided, pulls products, photos, tech info automatically.
   */
  async create({ customerId, serviceRecordId, title, lineItems, notes, dueDate, taxRate }) {
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
          const dateStr = new Date(sr.service_date).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
          title = `${sr.service_type} — ${dateStr}`;
        }
      }
    }

    // Calculate financials
    const items = lineItems || [];
    const subtotal = items.reduce((sum, item) => sum + (item.quantity * item.unit_price), 0);

    // Apply WaveGuard discount
    const tierDiscount = TIER_DISCOUNTS[customer.waveguard_tier] || 0;
    const discountAmount = Math.round(subtotal * tierDiscount * 100) / 100;
    const discountLabel = tierDiscount > 0
      ? `${customer.waveguard_tier} WaveGuard — ${Math.round(tierDiscount * 100)}% off`
      : null;

    const afterDiscount = subtotal - discountAmount;

    // Tax — default to Florida 7% if not specified
    const rate = taxRate !== undefined ? taxRate : 0.07;
    const taxAmount = Math.round(afterDiscount * rate * 100) / 100;
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
      due_date: dueDate || new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0],
      status: 'draft',
      ...serviceData,
    }).returning('*');

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
   * Process payment via Square Web Payments SDK.
   * Called when customer submits payment on the /pay page.
   */
  async processPayment(token, { sourceId, verificationToken, paymentMethod }) {
    if (!paymentsApi) throw new Error('Square payments not configured');

    const invoice = await db('invoices').where({ token }).first();
    if (!invoice) throw new Error('Invoice not found');
    if (invoice.status === 'paid') throw new Error('Invoice already paid');

    const customer = await db('customers').where({ id: invoice.customer_id }).first();
    const amountCents = Math.round(invoice.total * 100);

    try {
      const paymentRequest = {
        idempotencyKey: uuidv4(),
        sourceId, // card nonce, Apple Pay token, Google Pay token, or ACH token
        amountMoney: {
          amount: BigInt(amountCents),
          currency: 'USD',
        },
        locationId: config.square.locationId,
        note: `${invoice.invoice_number} — ${invoice.title || 'Service'} — ${customer.first_name} ${customer.last_name}`,
        referenceId: invoice.id,
      };

      // Link to Square customer if available
      if (customer.square_customer_id) {
        paymentRequest.customerId = customer.square_customer_id;
      }

      // Add verification token for SCA/3DS if provided
      if (verificationToken) {
        paymentRequest.verificationToken = verificationToken;
      }

      const { result } = await paymentsApi.createPayment(paymentRequest);
      const payment = result.payment;

      // Update invoice
      await db('invoices').where({ id: invoice.id }).update({
        status: 'paid',
        paid_at: new Date(),
        square_payment_id: payment.id,
        payment_method: paymentMethod || 'card',
        card_brand: payment.cardDetails?.card?.cardBrand || null,
        card_last_four: payment.cardDetails?.card?.last4 || null,
        receipt_url: payment.receiptUrl || null,
        updated_at: new Date(),
      });

      // Record in payments table for billing history
      await db('payments').insert({
        customer_id: invoice.customer_id,
        square_payment_id: payment.id,
        payment_date: new Date().toISOString().split('T')[0],
        amount: invoice.total,
        status: payment.status === 'COMPLETED' ? 'paid' : 'processing',
        description: invoice.title || `Invoice ${invoice.invoice_number}`,
        metadata: JSON.stringify({
          invoice_id: invoice.id,
          invoice_number: invoice.invoice_number,
          square_receipt_url: payment.receiptUrl,
        }),
      });

      // Log activity
      await db('activity_log').insert({
        customer_id: invoice.customer_id,
        action: 'invoice_paid',
        description: `Invoice ${invoice.invoice_number} paid: $${invoice.total} via ${paymentMethod || 'card'}`,
        metadata: JSON.stringify({
          invoiceId: invoice.id,
          amount: invoice.total,
          squarePaymentId: payment.id,
        }),
      }).catch(() => {});

      logger.info(`[invoice] Payment processed: ${invoice.invoice_number} — $${invoice.total} via ${paymentMethod || 'card'}`);

      return {
        success: true,
        invoiceNumber: invoice.invoice_number,
        amount: invoice.total,
        receiptUrl: payment.receiptUrl,
        paymentId: payment.id,
      };
    } catch (err) {
      logger.error(`[invoice] Payment failed for ${invoice.invoice_number}: ${err.message}`);
      throw new Error(`Payment failed: ${err.message}`);
    }
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
    const payUrl = `${domain}/pay/${invoice.token}`;

    const techName = invoice.tech_name || 'Our team';
    const serviceType = invoice.service_type || invoice.title || 'your service';

    const body = `Hey ${customer.first_name}! ${techName} just wrapped up your ${serviceType} today. ` +
      `Tap to see what was applied, tech notes & before/after photos → ${payUrl}\n\n` +
      `Your invoice ($${invoice.total.toFixed(2)}) is ready at the bottom whenever you're set. \n\n` +
      `— Waves Pest Control`;

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
   */
  async sendReceipt(invoiceId) {
    const invoice = await db('invoices').where({ id: invoiceId }).first();
    if (!invoice || invoice.status !== 'paid') return;

    const customer = await db('customers').where({ id: invoice.customer_id }).first();
    if (!customer?.phone) return;

    const body = `Payment received — thank you, ${customer.first_name}!\n\n` +
      `Invoice: ${invoice.invoice_number}\n` +
      `Amount: $${invoice.total.toFixed(2)}\n` +
      (invoice.card_brand && invoice.card_last_four
        ? `Paid with: ${invoice.card_brand} ****${invoice.card_last_four}\n` : '') +
      `\nYour property is protected. See you at your next service!\n\n` +
      `— Waves Pest Control`;

    try {
      const TwilioService = require('./twilio');
      await TwilioService.sendSMS(customer.phone, body, {
        customerId: customer.id,
        messageType: 'receipt',
      });
      logger.info(`[invoice] Receipt SMS sent for ${invoice.invoice_number}`);
    } catch (err) {
      logger.error(`[invoice] Receipt SMS failed: ${err.message}`);
    }
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

  async list({ status, customerId, limit = 50, offset = 0 } = {}) {
    let query = db('invoices')
      .leftJoin('customers', 'invoices.customer_id', 'customers.id')
      .select('invoices.*', 'customers.first_name', 'customers.last_name', 'customers.phone', 'customers.waveguard_tier');
    if (status) query = query.where('invoices.status', status);
    if (customerId) query = query.where('invoices.customer_id', customerId);
    query = query.orderBy('invoices.created_at', 'desc').limit(limit).offset(offset);
    const invoices = await query;

    let countQuery = db('invoices');
    if (status) countQuery = countQuery.where({ status });
    if (customerId) countQuery = countQuery.where({ customer_id: customerId });
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
      const tierDiscount = TIER_DISCOUNTS[customer?.waveguard_tier] || 0;
      const discountAmount = Math.round(subtotal * tierDiscount * 100) / 100;
      const afterDiscount = subtotal - discountAmount;
      const rate = updates.tax_rate !== undefined ? updates.tax_rate : (invoice.tax_rate || 0.07);
      const taxAmount = Math.round(afterDiscount * rate * 100) / 100;
      data.subtotal = subtotal;
      data.discount_amount = discountAmount;
      data.discount_label = tierDiscount > 0 ? `${customer.waveguard_tier} WaveGuard — ${Math.round(tierDiscount * 100)}% off` : null;
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
