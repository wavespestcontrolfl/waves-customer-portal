/**
 * Late Payment Checker
 *
 * Runs daily (weekdays 10AM) via cron. Searches the portal's invoices table
 * for unpaid invoices 7+ days overdue, sends tiered reminder SMS via Twilio,
 * and logs each send to avoid duplicate reminders.
 */

const db = require('../models/db');
const logger = require('./logger');
const TwilioService = require('./twilio');

const LatePaymentService = {
  async checkAndNotify(daysOverdue = 7) {
    const now = new Date();
    const cutoff = new Date(now.getTime() - daysOverdue * 86400000);

    let invoices = [];
    try {
      invoices = await db('invoices')
        .whereIn('status', ['sent', 'viewed', 'overdue'])
        .where(function () {
          this.where('due_date', '<=', cutoff)
            .orWhere(function () {
              this.whereNull('due_date').andWhere('created_at', '<=', cutoff);
            });
        })
        .limit(500);
    } catch (err) {
      logger.error(`[late-payment] Invoice lookup failed: ${err.message}`);
      return { notified: 0, skipped: 0, error: err.message };
    }

    let notified = 0;
    let skipped = 0;
    const domain = process.env.CLIENT_URL || 'https://portal.wavespestcontrol.com';

    for (const inv of invoices) {
      const refDate = inv.due_date ? new Date(inv.due_date) : new Date(inv.created_at);
      const daysSince = Math.floor((now - refDate) / 86400000);
      if (daysSince < daysOverdue) continue;

      const invoiceKey = `${inv.invoice_number || inv.id}|${daysOverdue} DAYS`;

      try {
        const alreadySent = await db('activity_log')
          .where({ action: 'late_payment_reminder' })
          .whereRaw("metadata::text LIKE ?", [`%${invoiceKey}%`])
          .first();
        if (alreadySent) { skipped++; continue; }
      } catch { /* proceed if activity_log check fails */ }

      const customer = await db('customers').where({ id: inv.customer_id }).first();
      if (!customer?.phone) { skipped++; continue; }

      const name = customer.first_name || 'there';
      const invoiceTitle = inv.title || 'your service';
      const payUrl = `${domain}/pay/${inv.token}`;
      const totalAmount = parseFloat(inv.total || 0);

      let formattedDate = '';
      if (inv.service_date) {
        try {
          formattedDate = new Date(inv.service_date).toLocaleDateString('en-US', {
            month: 'short', day: 'numeric', year: 'numeric',
          });
        } catch { /* ignore */ }
      }
      const dateClause = formattedDate ? ` completed on ${formattedDate}` : '';

      let body;
      if (daysSince < 14) {
        body = `Hello ${name}! This is a reminder from Waves. Your invoice for ${invoiceTitle}${dateClause} is now 7 days overdue.\n\nPlease make your payment here: ${payUrl}\n\nQuestions or requests? Reply to this message.\nThank you for choosing Waves!`;
      } else if (daysSince < 30) {
        body = `Hello ${name}, this is a reminder from Waves. Your invoice for ${invoiceTitle}${dateClause} is now 14 days overdue.\n\nPlease make your payment as soon as possible at: ${payUrl}\n\nQuestions or requests? Reply to this message.\nThank you for choosing Waves!`;
      } else if (daysSince < 60) {
        body = `Hello ${name}, this is a final reminder from Waves. Your invoice for ${invoiceTitle}${dateClause} is now 30 days overdue.\n\nPlease make your payment immediately at: ${payUrl}\n\nQuestions or requests? Reply to this message.\nThank you for choosing Waves!`;
      } else if (daysSince < 90) {
        body = `Hello ${name}, this is an urgent notice from Waves. Your invoice for ${invoiceTitle}${dateClause} is now 60 days overdue.\n\nPlease make payment or contact us immediately to avoid further action: ${payUrl}\n\nQuestions or requests? Reply to this message.\nThank you for choosing Waves!`;
      } else {
        body = `Hello ${name}, your invoice from Waves for ${invoiceTitle}${dateClause} is now 90 days overdue.\n\nFinal notice: This account will be sent to collections if payment is not received today. Please pay now: ${payUrl}\n\nQuestions or requests? Reply to this message.\nThank you for choosing Waves!`;
      }

      try {
        await TwilioService.sendSMS(customer.phone, body);
        notified++;
        logger.info(`[late-payment] Reminder sent to ${name} ${customer.last_name || ''} (${customer.phone}) — ${daysSince} days overdue`);

        await db('activity_log').insert({
          customer_id: customer.id,
          action: 'late_payment_reminder',
          description: `${daysOverdue}-day late payment reminder: ${invoiceTitle} ($${totalAmount.toFixed(2)})`,
          metadata: JSON.stringify({ invoiceKey, invoiceId: inv.id, amount: totalAmount, daysOverdue: daysSince }),
        }).catch(() => {});
      } catch (smsErr) {
        logger.error(`[late-payment] SMS failed for customer ${customer.id}: ${smsErr.message}`);
        skipped++;
      }
    }

    return { notified, skipped, totalUnpaid: invoices.length };
  },
};

module.exports = LatePaymentService;
