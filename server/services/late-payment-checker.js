/**
 * Late Payment Checker
 *
 * Runs daily (weekdays 10AM) via cron. Searches the portal's invoices table
 * for unpaid invoices 7+ days overdue, sends tiered reminder SMS + matching
 * transactional email, and logs each send to avoid duplicate reminders.
 */

const db = require('../models/db');
const logger = require('./logger');
const { sendCustomerMessage } = require('./messaging/send-customer-message');
const { shortenOrPassthrough, invoiceShortCodePrefix } = require('./short-url');
const { renderSmsTemplate } = require('./sms-template-renderer');
const { publicPortalUrl } = require('../utils/portal-url');

function tierDaysForOverdue(daysSince) {
  if (daysSince < 14) return 7;
  if (daysSince < 30) return 14;
  if (daysSince < 60) return 30;
  if (daysSince < 90) return 60;
  return 90;
}

function templateKeyForOverdue(daysSince) {
  return `late_payment_${tierDaysForOverdue(daysSince)}d`;
}

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
    const domain = publicPortalUrl();

    for (const inv of invoices) {
      const refDate = inv.due_date ? new Date(inv.due_date) : new Date(inv.created_at);
      const daysSince = Math.floor((now - refDate) / 86400000);
      if (daysSince < daysOverdue) continue;

      // Skip if a per-invoice follow-up sequence is already handling this invoice
      try {
        const InvoiceFollowUps = require('./invoice-followups');
        if (await InvoiceFollowUps.hasActiveSequence(inv.id)) { skipped++; continue; }
      } catch { /* fall through if module unavailable */ }

      // Key the dedupe on the computed escalation tier (the same value that
      // selects the template) so each tier (7/14/30/60/90) fires exactly once
      // per invoice. Historical rows were written with the `|7 DAYS` key, so
      // the tier-7 key stays byte-identical for backward compatibility.
      const tierDays = tierDaysForOverdue(daysSince);
      const invoiceKey = `${inv.invoice_number || inv.id}|${tierDays} DAYS`;

      try {
        const alreadySent = await db('activity_log')
          .where({ action: 'late_payment_reminder' })
          .whereRaw("metadata::text LIKE ?", [`%${invoiceKey}%`])
          .first();
        if (alreadySent) { skipped++; continue; }
      } catch { /* proceed if activity_log check fails */ }

      const customer = await db('customers').where({ id: inv.customer_id }).first();
      if (!customer?.phone) { skipped++; continue; }
      if (customer.deleted_at) {
        logger.info(`[late-payment] Skipping invoice ${inv.id} — customer ${customer.id} is soft-deleted`);
        skipped++;
        continue;
      }

      const name = customer.first_name || 'there';
      const invoiceTitle = inv.title || 'your service';
      const payUrl = await shortenOrPassthrough(`${domain}/pay/${inv.token}`, {
        kind: 'invoice', entityType: 'invoices', entityId: inv.id, customerId: customer.id,
        codePrefix: invoiceShortCodePrefix(inv),
      });
      const totalAmount = parseFloat(inv.total || 0);

      let formattedDate = '';
      if (inv.service_date) {
        try {
          formattedDate = new Date(inv.service_date).toLocaleDateString('en-US', {
            month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/New_York',
          });
        } catch { /* ignore */ }
      }
      const dateClause = formattedDate ? ` completed on ${formattedDate}` : '';

      const templateKey = templateKeyForOverdue(daysSince);
      const body = await renderSmsTemplate(templateKey, {
        first_name: name,
        invoice_title: invoiceTitle,
        service_date_clause: dateClause,
        pay_url: payUrl,
      }, {
        workflow: 'late_payment_reminder',
        entity_type: 'invoice',
        entity_id: inv.id,
      });
      if (!body) {
        logger.warn(`[late-payment] template ${templateKey} missing/disabled — skipping reminder for invoice ${inv.id}`);
        skipped++;
        continue;
      }

      try {
        const sendResult = await sendCustomerMessage({
          to: customer.phone,
          body,
          channel: 'sms',
          audience: 'customer',
          purpose: 'payment_link',
          customerId: customer.id,
          invoiceId: inv.id,
          entryPoint: 'late_payment_checker',
          metadata: { original_message_type: 'late_payment' },
        });
        if (sendResult.blocked || sendResult.sent === false) {
          throw new Error(`late payment SMS blocked: ${sendResult.code || sendResult.reason || 'unknown'}`);
        }
        try {
          const BalanceReminder = require('./workflows/balance-reminder');
          if (typeof BalanceReminder.sendLatePaymentEmail === 'function') {
            await BalanceReminder.sendLatePaymentEmail({
              customer,
              invoice: inv,
              balance: {
                totalBalance: totalAmount,
                oldestDueDate: inv.due_date || inv.created_at,
              },
              smsTemplateKey: templateKey,
              invoiceTitle,
              serviceDateClause: dateClause,
              payUrl,
            });
          }
        } catch (emailErr) {
          logger.error(`[late-payment] Email sidecar failed for invoice ${inv.id}: ${emailErr.message}`);
        }
        notified++;
        logger.info(`[late-payment] Reminder sent for customer ${customer.id} — ${daysSince} days overdue`);

        await db('activity_log').insert({
          customer_id: customer.id,
          action: 'late_payment_reminder',
          description: `${tierDays}-day late payment reminder: ${invoiceTitle} ($${totalAmount.toFixed(2)})`,
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
