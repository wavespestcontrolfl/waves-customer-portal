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
const { invoiceAmountDue } = require('./invoice-helpers');
const { gates } = require('../config/feature-gates');
const StripeService = require('./stripe');
const { sendMicrodepositVerificationEmail } = require('./microdeposit-verification-email');

function tierDaysForOverdue(daysSince) {
  if (daysSince < 14) return 7;
  if (daysSince < 30) return 14;
  if (daysSince < 60) return 30;
  if (daysSince < 90) return 60;
  return 90;
}

/**
 * When an unpaid invoice's only blocker is an unfinished ACH micro-deposit
 * verification, the customer isn't refusing to pay — they need to confirm two
 * small bank deposits. Send a verification re-nudge instead of the misleading
 * "X days overdue" notice, on the same tier cadence. Dedup is keyed on its own
 * action so it neither blocks nor is blocked by the generic late-payment dedupe.
 *
 * Returns: 'sent' | 'deduped' | 'skip' | 'not_pending' (fall through to dunning).
 */
async function maybeDivertToMicrodepositReminder(inv, daysSince, domain) {
  const pending = await StripeService.isInvoiceAwaitingMicrodepositVerification(inv);
  if (!pending) return 'not_pending';

  const invoiceRef = inv.invoice_number || inv.id;
  const tierDays = tierDaysForOverdue(daysSince);
  const dedupeKey = `${invoiceRef}|${tierDays} DAYS|microdeposit`;
  try {
    const already = await db('activity_log')
      .where({ action: 'microdeposit_verification_reminder' })
      .whereRaw('metadata::text LIKE ?', [`%${dedupeKey}%`])
      .first();
    if (already) return 'deduped';
  } catch { /* proceed if the dedupe check fails */ }

  const customer = await db('customers').where({ id: inv.customer_id }).first();
  if (!customer?.phone || customer.deleted_at) return 'skip';

  const body = await renderSmsTemplate('bank_verification_incomplete', {
    first_name: customer.first_name || 'there',
    billing_url: `${domain}/billing`,
  }, { workflow: 'microdeposit_verification_reminder', entity_type: 'invoice', entity_id: inv.id });
  // No fallback to the generic late-payment notice — sending "you're overdue" to a
  // customer mid-verification is exactly the message this diversion exists to stop.
  if (!body) return 'skip';

  try {
    const sendResult = await sendCustomerMessage({
      to: customer.phone,
      body,
      channel: 'sms',
      audience: 'customer',
      purpose: 'payment_link',
      customerId: customer.id,
      invoiceId: inv.id,
      entryPoint: 'late_payment_checker_microdeposit',
      metadata: { original_message_type: 'bank_verification_incomplete' },
    });
    if (sendResult.blocked || sendResult.sent === false) return 'skip';
    // Branded email sidecar — best-effort; the SMS re-nudge already succeeded, so a
    // missing email address or send failure must NOT downgrade the 'sent' outcome.
    await sendMicrodepositVerificationEmail({ invoice: inv, customer, touchKey: `${tierDays}d` })
      .catch((e) => logger.warn(`[late-payment] micro-deposit email sidecar failed for invoice ${inv.id}: ${e.message}`));
    await db('activity_log').insert({
      customer_id: customer.id,
      action: 'microdeposit_verification_reminder',
      description: `Micro-deposit verification re-nudge (${tierDays}-day): ${inv.title || 'invoice'} ${invoiceRef}`,
      metadata: JSON.stringify({ dedupeKey, invoiceId: inv.id, daysOverdue: daysSince }),
    }).catch(() => {});
    return 'sent';
  } catch (e) {
    logger.error(`[late-payment] micro-deposit re-nudge failed for invoice ${inv.id}: ${e.message}`);
    return 'skip';
  }
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
        // Third-party Bill-To: a payer-billed invoice's AR rolls to the payer,
        // never the homeowner — exclude it from the legacy late-payment reminder
        // path (which texts/emails the customer a pay link). Payer dunning is
        // Phase 2.
        .whereNull('payer_id')
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
    let emailedFallback = 0;
    const domain = publicPortalUrl();

    for (const inv of invoices) {
      const refDate = inv.due_date ? new Date(inv.due_date) : new Date(inv.created_at);
      const daysSince = Math.floor((now - refDate) / 86400000);
      if (daysSince < daysOverdue) continue;

      // Skip if a per-invoice follow-up sequence is already handling this invoice,
      // or if an admin explicitly STOPPED that sequence. A stop is a deliberate
      // "stop dunning this invoice" instruction (e.g. customer is mailing a check);
      // honoring it only in the per-invoice engine but not here would let this
      // legacy reminder keep texting them after follow-ups were turned off.
      try {
        const InvoiceFollowUps = require('./invoice-followups');
        if (await InvoiceFollowUps.hasActiveSequence(inv.id)) { skipped++; continue; }
        if (await InvoiceFollowUps.isDunningStopped(inv.id)) { skipped++; continue; }
      } catch { /* fall through if module unavailable */ }

      // Divert micro-deposit-blocked invoices to a verification re-nudge instead
      // of the "overdue" dunning below. Gated to invoices that actually have a PI
      // so the Stripe read only runs where a payment was started.
      if (gates.divertMicrodepositDunning && inv.stripe_payment_intent_id) {
        const outcome = await maybeDivertToMicrodepositReminder(inv, daysSince, domain);
        if (outcome === 'sent') { notified++; continue; }
        if (outcome === 'deduped' || outcome === 'skip') { skipped++; continue; }
        // 'not_pending' → fall through to the normal late-payment dunning below.
      }

      // Key the dedupe on the computed escalation tier (the same value that
      // selects the template) so each tier (7/14/30/60/90) fires exactly once
      // per invoice. Historical rows were written with the `|7 DAYS` key, so
      // the tier-7 key stays byte-identical for backward compatibility.
      const invoiceRef = inv.invoice_number || inv.id;
      const tierDays = tierDaysForOverdue(daysSince);
      const invoiceKey = `${invoiceRef}|${tierDays} DAYS`;

      try {
        let alreadySent = await db('activity_log')
          .where({ action: 'late_payment_reminder' })
          .whereRaw("metadata::text LIKE ?", [`%${invoiceKey}%`])
          .first();
        if (!alreadySent && tierDays !== 7) {
          // Legacy rows were always keyed `|7 DAYS` regardless of which tier's
          // template was actually sent; their metadata.daysOverdue recorded the
          // computed days overdue at send time. Treat a legacy row as covering
          // the current tier if its recorded overdue age maps to this tier.
          const legacyRows = await db('activity_log')
            .where({ action: 'late_payment_reminder' })
            .whereRaw("metadata::text LIKE ?", [`%${invoiceRef}|7 DAYS%`]);
          alreadySent = legacyRows.find((row) => {
            try {
              const meta = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata;
              const sentAtDays = Number(meta?.daysOverdue);
              return Number.isFinite(sentAtDays) && tierDaysForOverdue(sentAtDays) === tierDays;
            } catch {
              return false;
            }
          });
        }
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
      // Dun for amount DUE (total − applied account credit), not the gross total.
      const totalAmount = invoiceAmountDue(inv);

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

        const smsSent = sendResult.sent === true;
        const smsWillRetry = !smsSent && (sendResult.retryable === true || sendResult.deferred === true);

        // A transient hold (quiet hours, retryable carrier error) re-sends on a
        // later run — don't email now or the customer gets both when it lands.
        if (smsWillRetry) {
          logger.info(`[late-payment] SMS deferred for customer ${customer.id} (${sendResult.code || 'retryable'}); will retry next run`);
          skipped++;
          continue;
        }

        // smsSent → primary SMS went; the email is the matching dual-channel notice.
        // Otherwise the SMS is permanently undeliverable (landline/non-mobile
        // suppression, wrong-number, opt-out, or a terminal carrier rejection) —
        // fall back to email so a customer we can't reach by text still gets the
        // reminder instead of silently getting nothing.
        if (!smsSent) {
          logger.info(`[late-payment] SMS undeliverable for customer ${customer.id} (${sendResult.code || 'unknown'}) — sending email reminder instead`);
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

        if (smsSent) {
          notified++;
          logger.info(`[late-payment] Reminder sent for customer ${customer.id} — ${daysSince} days overdue`);
        } else {
          emailedFallback++;
        }

        await db('activity_log').insert({
          customer_id: customer.id,
          action: 'late_payment_reminder',
          description: `${tierDays}-day late payment reminder: ${invoiceTitle} ($${totalAmount.toFixed(2)})`,
          metadata: JSON.stringify({ invoiceKey, invoiceId: inv.id, amount: totalAmount, daysOverdue: daysSince, channel: smsSent ? 'sms+email' : 'email_only' }),
        }).catch(() => {});
      } catch (smsErr) {
        logger.error(`[late-payment] SMS failed for customer ${customer.id}: ${smsErr.message}`);
        skipped++;
      }
    }

    return { notified, skipped, emailedFallback, totalUnpaid: invoices.length };
  },
};

module.exports = LatePaymentService;
