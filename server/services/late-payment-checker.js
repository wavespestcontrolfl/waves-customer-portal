/**
 * Late Payment Checker — replaces Zapier zap #24 (7 Day Late Payment SMS)
 *
 * Runs daily (weekdays 10AM) via cron. Searches Square for unpaid invoices
 * 7+ days overdue, sends reminder SMS via Twilio, logs to avoid duplicates.
 */

const db = require('../models/db');
const logger = require('./logger');
const TwilioService = require('./twilio');
const config = require('../config');

let squareClient, invoicesApi;
try {
  const { Client, Environment } = require('square');
  if (config.square?.accessToken) {
    squareClient = new Client({
      accessToken: config.square.accessToken,
      environment: config.square.environment === 'production' ? Environment.Production : Environment.Sandbox,
    });
    invoicesApi = squareClient.invoicesApi;
  }
} catch { /* square not available */ }

const LOCATION_ID = process.env.SQUARE_LOCATION_ID || 'L4D5MY94THC3P';

const LatePaymentService = {
  async checkAndNotify(daysOverdue = 7) {
    if (!invoicesApi) {
      logger.warn('[late-payment] Square SDK not configured');
      return { notified: 0, skipped: 0, error: 'Square not configured' };
    }

    // Search Square for all unpaid invoices
    let invoices = [];
    try {
      const { result } = await invoicesApi.searchInvoices({
        query: {
          filter: {
            locationIds: [LOCATION_ID],
          },
        },
        limit: 200,
      });
      invoices = (result.invoices || []).filter(inv => inv.status === 'UNPAID');
    } catch (err) {
      logger.error(`[late-payment] Square invoice search failed: ${err.message}`);
      return { notified: 0, skipped: 0, error: err.message };
    }

    const now = new Date();
    let notified = 0;
    let skipped = 0;

    for (const inv of invoices) {
      // Calculate days overdue from due_date or created_at
      const dueDate = inv.payment_requests?.[0]?.due_date;
      const createdAt = inv.created_at;
      const refDate = dueDate ? new Date(dueDate + 'T00:00:00') : new Date(createdAt);
      const daysSince = Math.floor((now - refDate) / 86400000);

      if (daysSince < daysOverdue) continue;

      const invoiceKey = `${inv.public_url || inv.id}|${daysOverdue} DAYS`;

      // Deduplicate — check if we already sent this specific reminder
      try {
        const alreadySent = await db('activity_log')
          .where({ action: 'late_payment_reminder' })
          .whereRaw("metadata::text LIKE ?", [`%${invoiceKey}%`])
          .first();

        if (alreadySent) {
          skipped++;
          continue;
        }
      } catch { /* table might not have the right structure, proceed */ }

      // Get customer info
      const recipient = inv.primary_recipient;
      if (!recipient) { skipped++; continue; }

      const phone = recipient.phone_number;
      const firstName = recipient.given_name || '';
      const customerName = `${firstName} ${recipient.family_name || ''}`.trim();
      const invoiceTitle = inv.title || 'your service';
      const publicUrl = inv.public_url || '';
      const totalAmount = (inv.payment_requests?.[0]?.computed_amount_money?.amount || 0) / 100;
      const serviceDate = inv.sale_or_service_date || '';

      let formattedDate = '';
      if (serviceDate) {
        try {
          formattedDate = new Date(serviceDate + 'T12:00:00').toLocaleDateString('en-US', {
            month: 'short', day: 'numeric', year: 'numeric',
          });
        } catch { formattedDate = serviceDate; }
      }

      // Find customer in portal
      let customer = null;
      if (recipient.customer_id) {
        customer = await db('customers').where({ square_customer_id: recipient.customer_id }).first();
      }
      if (!customer && phone) {
        customer = await db('customers').where({ phone }).first();
      }

      const customerPhone = customer?.phone || phone;
      if (!customerPhone) { skipped++; continue; }

      // Send SMS
      try {
        const body = `Hello ${firstName || customer?.first_name || 'there'}! This is a reminder from Waves. ` +
          `Your invoice for ${invoiceTitle}` +
          (formattedDate ? ` completed on ${formattedDate}` : '') +
          ` is now ${daysSince} days overdue.\n\n` +
          (totalAmount > 0 ? `Amount due: $${totalAmount.toFixed(2)}\n` : '') +
          (publicUrl ? `\nPay here: ${publicUrl}\n` : '') +
          `\nPlease reach out if you have questions — reply here or call (941) 318-7612.\n\n` +
          `— Waves Pest Control 🌊`;

        await TwilioService.sendSMS(customerPhone, body);
        notified++;

        logger.info(`[late-payment] Reminder sent to ${customerName} (${customerPhone}) — ${daysSince} days overdue`);

        // Log to prevent duplicate sends
        await db('activity_log').insert({
          customer_id: customer?.id || null,
          action: 'late_payment_reminder',
          description: `${daysOverdue}-day late payment reminder: ${invoiceTitle} ($${totalAmount.toFixed(2)})`,
          metadata: JSON.stringify({ invoiceKey, invoiceId: inv.id, amount: totalAmount, daysOverdue: daysSince }),
        }).catch(() => {});

      } catch (smsErr) {
        logger.error(`[late-payment] SMS failed for ${customerName}: ${smsErr.message}`);
        skipped++;
      }
    }

    return { notified, skipped, totalUnpaid: invoices.length };
  },
};

module.exports = LatePaymentService;
