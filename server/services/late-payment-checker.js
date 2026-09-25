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
const { formatDateOnly } = require('../utils/date-only');
const { billingChannelAllowed, explicitBillingChannels } = require('./billing-delivery-channels');

function tierDaysForOverdue(daysSince) {
  if (daysSince < 14) return 7;
  if (daysSince < 30) return 14;
  if (daysSince < 60) return 30;
  if (daysSince < 90) return 60;
  return 90;
}

// A blocked/failed SMS that should be retried on a later run rather than burning
// the reminder tier (and rather than firing the email fallback, which would
// double up once the SMS lands). Covers retryable-provider holds
// (flagged on the result) plus CONSENT_LOOKUP_FAILED — a transient consent-prefs
// DB blip that review-request.js and admin-dispatch.js also treat as retryable.
function isTransientSmsResult(result) {
  if (!result) return false;
  return result.retryable === true
    || result.deferred === true
    || result.code === 'CONSENT_LOOKUP_FAILED';
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
async function maybeDivertToMicrodepositReminder(inv, daysSince, domain, now = new Date()) {
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
  if (!customer || customer.deleted_at) return 'skip';
  const prefs = await db('notification_prefs').where({ customer_id: customer.id }).first().catch(() => null);
  const explicitChannels = explicitBillingChannels(prefs || {}, 'payment_issue');
  if (!customer.phone && !explicitChannels?.some((channel) => channel === 'email' || channel === 'push')) return 'skip';
  const explicitEmailSelected = billingChannelAllowed(prefs || {}, 'payment_issue', 'email') === true;

  const body = await renderSmsTemplate('bank_verification_incomplete', {
    first_name: customer.first_name || 'there',
    billing_url: `${domain}/billing`,
  }, { workflow: 'microdeposit_verification_reminder', entity_type: 'invoice', entity_id: inv.id });
  // No fallback to the generic late-payment notice — sending "you're overdue" to a
  // customer mid-verification is exactly the message this diversion exists to stop.
  if (!body) return 'skip';

  const ContactLedger = require('./collections/contact-ledger');
  let smsLedger = null;
  try {
    const [smsPermitted, emailPermitted] = await Promise.all([
      collectionsChannelPermitted(customer.id, inv.id, 'sms', now),
      collectionsChannelPermitted(customer.id, inv.id, 'email', now),
    ]);
    let emailAttempted = false;
    let emailDelivered = false;
    const attemptEmail = async () => {
      if (emailAttempted || !emailPermitted) return;
      emailAttempted = true;
      let emailLedger = null;
      try {
        emailLedger = await ContactLedger.recordContact({
          customerId: customer.id,
          channel: 'email',
          purpose: 'payment_verification',
          invoiceIds: [inv.id],
          source: 'late_payment_checker',
          metadata: { microdeposit: true, tier_days: tierDays },
        });
      } catch (ledgerErr) {
        logger.warn(`[late-payment] micro-deposit email sidecar skipped for invoice ${inv.id} — ledger unavailable: ${ledgerErr.message}`);
      }
      if (!emailLedger) return;
      const emailResult = await sendMicrodepositVerificationEmail({
        invoice: inv,
        customer,
        touchKey: `${tierDays}d`,
        enforceBillingPreference: true,
      }).catch((e) => ({ ok: false, error: e.message }));
      emailDelivered = emailResult?.ok === true;
      if (emailDelivered) await ContactLedger.markDelivered(emailLedger);
      else await ContactLedger.markSendFailed(emailLedger, { error: emailResult?.reason || 'sidecar_failed' });
    };
    if (explicitEmailSelected) await attemptEmail();

    // RECORD-THEN-SEND: the ledger row precedes the delivery attempt; an
    // insert failure skips the send (no unledgered customer contact, ever).
    if (smsPermitted && (customer.phone || billingChannelAllowed(prefs || {}, 'payment_issue', 'push') === true)) try {
      smsLedger = await ContactLedger.recordContact({
        customerId: customer.id,
        channel: 'sms',
        purpose: 'payment_verification',
        invoiceIds: [inv.id],
        source: 'late_payment_checker',
        metadata: { microdeposit: true, tier_days: tierDays },
      });
    } catch (ledgerErr) {
      logger.warn(`[late-payment] micro-deposit re-nudge skipped for invoice ${inv.id} — ledger unavailable: ${ledgerErr.message}`);
    }
    const sendResult = smsLedger ? await sendCustomerMessage({
      to: customer.phone,
      body,
      channel: 'sms',
      audience: 'customer',
      purpose: 'payment_link',
      customerId: customer.id,
      invoiceId: inv.id,
      entryPoint: 'late_payment_checker_microdeposit',
      metadata: {
        original_message_type: 'bank_verification_incomplete',
        notificationEventKey: `payment-problem:microdeposit:${inv.id}:${tierDays}`,
        billingDeliveryCategory: 'payment_issue',
      },
      hasEmailLeg: true,
    }) : { sent: false, blocked: true, code: customer.phone ? 'COLLECTIONS_POLICY' : 'NO_PHONE' };
    if (sendResult.blocked || sendResult.sent === false) {
      if (smsLedger) await ContactLedger.markSendFailed(smsLedger, { code: sendResult.code || 'blocked' });
    } else {
      await ContactLedger.markDelivered(smsLedger);
    }
    await attemptEmail();
    if (isTransientSmsResult(sendResult)) return 'skip';
    if (!sendResult.sent && !emailDelivered) return 'skip';
    await db('activity_log').insert({
      customer_id: customer.id,
      action: 'microdeposit_verification_reminder',
      description: `Micro-deposit verification re-nudge (${tierDays}-day): ${inv.title || 'invoice'} ${invoiceRef}`,
      metadata: JSON.stringify({ dedupeKey, invoiceId: inv.id, daysOverdue: daysSince }),
    }).catch(() => {});
    return 'sent';
  } catch (e) {
    logger.error(`[late-payment] micro-deposit re-nudge failed for invoice ${inv.id}: ${e.message}`);
    if (smsLedger) await ContactLedger.markSendFailed(smsLedger, { error: 'send_threw' });
    return 'skip';
  }
}

function templateKeyForOverdue(daysSince) {
  return `late_payment_${tierDaysForOverdue(daysSince)}d`;
}

// Collections policy consult lives in the SHARED rail guard (codex
// 2026-08-14: one implementation, not three that drift) — gate-off
// byte-identical, per-channel verdicts, invoice-membership required.
const { collectionsChannelPermitted: railGuardPermitted } = require('./collections/rail-guard');

async function collectionsChannelPermitted(customerId, invoiceId, channel, now, excludeLedgerIds = []) {
  return railGuardPermitted({
    customerId, invoiceId, channel, purpose: 'late_payment', now, excludeLedgerIds, logTag: 'late-payment',
  });
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
        // A combined-visit invoice WITHDRAWN to a payer keeps payer_id NULL and
        // a collectible status — the move is recorded only in the stamp (Codex
        // #4311 r31 P1), so a payer_id-only filter would keep reminding the
        // homeowner about debt the payer now owes.
        .where(function () {
          this.whereNull('scheduled_send_error').orWhereNot('scheduled_send_error', 'like', 'payer_billed:%');
        })
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
      // Ownership RE-READ immediately before the dispatch decision (Codex
      // #4311 r32 P1): a Bill-To change committing between the batch query
      // above and this send stamps the invoice and moves the debt to AP,
      // and the batch row still carries the old, empty stamp. FAIL CLOSED on
      // an unreadable row, like every other customer-comms guard here.
      try {
        const live = await db('invoices').where({ id: inv.id }).first('payer_id', 'scheduled_send_error');
        if (!live || live.payer_id
          || require('./invoice-helpers').invoiceWithdrawnFromCustomer(live)) { skipped++; continue; }
      } catch (ownershipErr) {
        logger.warn(`[late-payment] ownership re-read failed for invoice ${inv.id} — skipping this run (fail closed): ${ownershipErr.message}`);
        skipped++;
        continue;
      }
      try {
        const InvoiceFollowUps = require('./invoice-followups');
        if (await InvoiceFollowUps.hasActiveSequence(inv.id)) { skipped++; continue; }
        if (await InvoiceFollowUps.isDunningStopped(inv.id)) { skipped++; continue; }
      } catch { /* fall through if module unavailable */ }
      // An ACTIVE payment plan is a dunning stop in itself (codex PR r8 P1):
      // an invoice can carry a plan with NO sequence row at all (nothing
      // existed to stop at plan creation), and the sequence checks above are
      // blind to that shape — the plan customer would keep getting legacy
      // overdue reminders. FAIL CLOSED on a read error (customer comms): an
      // unverifiable plan state skips THIS invoice this run rather than
      // risking a reminder the plan explicitly suppresses.
      try {
        const activePlan = await db('payment_plans')
          .where({ invoice_id: inv.id, status: 'active' })
          .first('id');
        if (activePlan) { skipped++; continue; }
      } catch (planErr) {
        logger.warn(`[late-payment] plan lookup failed for invoice ${inv.id} — skipping this run (fail closed): ${planErr.message}`);
        skipped++;
        continue;
      }

      // Divert micro-deposit-blocked invoices to a verification re-nudge instead
      // of the "overdue" dunning below. Gated to invoices that actually have a PI
      // so the Stripe read only runs where a payment was started.
      if (gates.divertMicrodepositDunning && inv.stripe_payment_intent_id) {
        const outcome = await maybeDivertToMicrodepositReminder(inv, daysSince, domain, now);
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
      if (!customer) { skipped++; continue; }
      if (customer.deleted_at) {
        logger.info(`[late-payment] Skipping invoice ${inv.id} — customer ${customer.id} is soft-deleted`);
        skipped++;
        continue;
      }
      let prefs = null;
      try {
        prefs = await db('notification_prefs').where({ customer_id: customer.id }).first();
      } catch { /* preserve legacy routing when preferences cannot be read */ }
      const explicitChannels = explicitBillingChannels(prefs || {}, 'billing');
      if (!customer.phone && !explicitChannels?.some((channel) => channel === 'email' || channel === 'push')) {
        skipped++;
        continue;
      }
      const explicitEmailSelected = billingChannelAllowed(prefs || {}, 'billing', 'email') === true;

      const name = customer.first_name || 'there';
      const invoiceTitle = inv.title || 'your service';
      const payUrl = await shortenOrPassthrough(`${domain}/pay/${inv.token}`, {
        kind: 'invoice', entityType: 'invoices', entityId: inv.id, customerId: customer.id,
        codePrefix: invoiceShortCodePrefix(inv),
      });
      // Dun for amount DUE (total − applied account credit), not the gross total.
      const totalAmount = invoiceAmountDue(inv);

      // ADMIN-BUG-R51: service_date is a DATE column, not an instant — formatting
      // it through an America/New_York instant formatter shifts a UTC-midnight
      // pg Date (TZ=UTC in production) to the PREVIOUS Eastern day. formatDateOnly
      // normalises to noon UTC first, matching the sibling dunning paths
      // (invoice-followups.js, balance-reminder.js) for the same column.
      const formattedDate = formatDateOnly(inv.service_date, { month: 'short', fallback: '' });
      const dateClause = formattedDate ? ` completed on ${formattedDate}` : '';

      // Ownership ONE more time, on the last read before the provider (local
      // audit): every check above is awaited, and a Bill-To assignment
      // landing in that window would otherwise still text the homeowner.
      try {
        const stillSelfPay = await db('invoices').where({ id: inv.id }).first('payer_id', 'scheduled_send_error');
        if (!stillSelfPay || stillSelfPay.payer_id
          || require('./invoice-helpers').invoiceWithdrawnFromCustomer(stillSelfPay)) { skipped++; continue; }
      } catch (ownershipErr) {
        logger.warn(`[late-payment] pre-send ownership re-read failed for invoice ${inv.id} — skipping (fail closed): ${ownershipErr.message}`);
        skipped++;
        continue;
      }
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
        const ContactLedger = require('./collections/contact-ledger');
        // Decide both policy legs before either ledger reservation is written,
        // so an explicitly selected email can go first without consuming the
        // same-run frequency window that the selected Text/App leg also needs.
        const [smsPolicyPermitted, emailPolicyPermitted] = await Promise.all([
          collectionsChannelPermitted(customer.id, inv.id, 'sms', now),
          collectionsChannelPermitted(customer.id, inv.id, 'email', now),
        ]);
        let emailResult = null;
        let emailAttempted = false;
        const attemptEmail = async () => {
          if (emailAttempted) return emailResult;
          emailAttempted = true;
          if (!emailPolicyPermitted) return emailResult;
          let emailLedger = null;
          try {
            emailLedger = await ContactLedger.recordContact({
              customerId: customer.id,
              channel: 'email',
              purpose: 'late_payment',
              invoiceIds: [inv.id],
              source: 'late_payment_checker',
              metadata: { tier_days: tierDays, days_overdue: daysSince },
            });
          } catch (ledgerErr) {
            logger.warn(`[late-payment] email leg skipped for customer ${customer.id} — contact ledger unavailable: ${ledgerErr.message}`);
          }
          if (!emailLedger) return emailResult;
          try {
            const BalanceReminder = require('./workflows/balance-reminder');
            const emailOwnership = await require('./invoice-helpers').selfPayAtDispatch(inv.id, db)();
            if (emailOwnership.ok !== true) {
              logger.warn(`[late-payment] email reminder skipped for invoice ${inv.id} — ${emailOwnership.reason}`);
            } else if (typeof BalanceReminder.sendLatePaymentEmail === 'function') {
              emailResult = await BalanceReminder.sendLatePaymentEmail({
                customer,
                invoice: inv,
                balance: { totalBalance: totalAmount, oldestDueDate: inv.due_date || inv.created_at },
                smsTemplateKey: templateKey,
                invoiceTitle,
                serviceDateClause: dateClause,
                payUrl,
                initialPrefs: prefs,
              });
            }
          } catch (emailErr) {
            logger.error(`[late-payment] Email sidecar failed for invoice ${inv.id}: ${emailErr.message}`);
          }
          if (emailResult?.ok !== true) {
            await ContactLedger.markSendFailed(emailLedger, { reason: emailResult?.reason || 'email_not_sent' });
          }
          return emailResult;
        };

        // An explicit Email selection is an independent delivery choice. Send
        // it before touching the SMS provider so a held/blocked Text or App leg
        // cannot silence it. Legacy rows retain the historical SMS-first order.
        if (explicitEmailSelected) await attemptEmail();

        // SMS leg. Per-channel collections consult (gate off ⇒ permitted
        // without loading the policy — byte-identical sends, pinned) and
        // RECORD-THEN-SEND: the ledger row precedes the delivery attempt; a
        // ledger insert failure skips the send (no unledgered contact, ever)
        // and the row is stamped send_failed if the delivery then fails.
        let sendResult;
        let smsLedger = null;
        if (!smsPolicyPermitted) {
          // Terminal (non-transient) non-delivery for this run; the email
          // leg below decides for itself (codex 2026-08-14: channels are
          // independent — do_not_text must not silence the email).
          sendResult = { sent: false, blocked: true, code: 'COLLECTIONS_POLICY' };
        } else if (!customer.phone && billingChannelAllowed(prefs || {}, 'billing', 'push') !== true) {
          sendResult = { sent: false, blocked: true, code: 'NO_PHONE' };
        } else {
          try {
            smsLedger = await ContactLedger.recordContact({
              customerId: customer.id,
              channel: 'sms',
              purpose: 'late_payment',
              invoiceIds: [inv.id],
              source: 'late_payment_checker',
              metadata: { tier_days: tierDays, days_overdue: daysSince },
            });
          } catch (ledgerErr) {
            logger.warn(`[late-payment] SMS skipped for customer ${customer.id} — contact ledger unavailable: ${ledgerErr.message}`);
            sendResult = { sent: false, blocked: true, code: 'LEDGER_UNAVAILABLE' };
          }
          if (smsLedger) {
            sendResult = await sendCustomerMessage({
              to: customer.phone,
              body,
              channel: 'sms',
              audience: 'customer',
              purpose: 'payment_link',
              customerId: customer.id,
              invoiceId: inv.id,
              entryPoint: 'late_payment_checker',
              metadata: {
                original_message_type: 'late_payment',
                billingDeliveryCategory: 'billing',
                notificationEventKey: `late-payment:${inv.id}:${tierDays}`,
              },
              hasEmailLeg: true,
              // The LAST ownership check, run by the canonical sender
              // immediately before provider preparation (Codex #4311 r42 P1):
              // the template render, the policy lookup and the ledger insert
              // are all awaited after the read above, and this legacy rail
              // holds no claim a Bill-To writer fences on. Fail-closed, and
              // no lock is held across provider I/O.
              preDispatchCheck: require('./invoice-helpers').selfPayAtDispatch(inv.id, db),
            });
            if (sendResult.sent !== true) {
              await ContactLedger.markSendFailed(smsLedger, { code: sendResult.code || 'blocked' });
            }
          }
        }

        const smsSent = sendResult.sent === true;
        const smsWillRetry = !smsSent && isTransientSmsResult(sendResult);

        // A transient hold (retryable carrier error, consent-lookup
        // DB blip) re-sends on a later run — don't email now or the customer gets
        // both when it lands, and don't burn the tier.
        if (smsWillRetry) {
          logger.info(`[late-payment] SMS deferred for customer ${customer.id} (${sendResult.code || 'retryable'}); will retry next run`);
          skipped++;
          continue;
        }

        await attemptEmail();

        const emailDelivered = emailResult?.ok === true;

        if (smsSent) {
          // SMS reached the customer; the email is a bonus. The reminder landed,
          // so recording the dedupe row below is justified regardless of the email.
          notified++;
          logger.info(`[late-payment] Reminder sent for customer ${customer.id} — ${daysSince} days overdue`);
        } else if (emailDelivered) {
          // SMS was undeliverable but the email fallback reached them.
          emailedFallback++;
          logger.info(`[late-payment] SMS undeliverable for customer ${customer.id} (${sendResult.code || 'unknown'}) — sent email reminder instead`);
        } else {
          // Neither channel reached the customer (SMS undeliverable AND no email
          // sent — no billing email, blocked, ineligible, …). Do NOT write the
          // dedupe row, so a later run retries instead of silently giving up.
          // Log only a bounded reason/status — never emailResult.error, which is
          // the raw provider message and can contain the recipient's email (PII).
          // Detailed failure context lives in the email audit rows.
          const emailStatus = emailResult?.reason || (emailResult?.blocked ? 'blocked' : 'not_sent');
          logger.warn(`[late-payment] No reachable channel for customer ${customer.id} (sms=${sendResult.code || 'unknown'}, email=${emailStatus}) — will retry next run`);
          skipped++;
          continue;
        }

        await db('activity_log').insert({
          customer_id: customer.id,
          action: 'late_payment_reminder',
          description: `${tierDays}-day late payment reminder: ${invoiceTitle} ($${totalAmount.toFixed(2)})`,
          metadata: JSON.stringify({ invoiceKey, invoiceId: inv.id, amount: totalAmount, daysOverdue: daysSince, channel: smsSent ? (emailDelivered ? 'sms+email' : 'sms') : 'email_only' }),
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
