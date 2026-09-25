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

function activityMetadata(row) {
  if (!row?.metadata) return {};
  if (typeof row.metadata === 'object') return row.metadata;
  try { return JSON.parse(row.metadata); } catch { return {}; }
}

function ledgerMetadata(row) {
  if (!row?.metadata) return {};
  if (typeof row.metadata === 'object') return row.metadata;
  try { return JSON.parse(row.metadata); } catch { return {}; }
}

function emailEpisodeNeedsRetry(smsMeta, emailMeta) {
  return smsMeta.delivered === true && emailMeta.send_failed === true
    && emailMeta.delivered !== true && emailMeta.resolved !== true;
}

function isTerminalEmailRefusal(result) {
  return result?.ok === false && result.retryable !== true && result.deferred !== true
    && result.deliveryOutcome !== 'uncertain' && (
    (result.skipped === true && ['missing_email', 'billing_email_not_selected', 'template_unavailable'].includes(result.reason))
    || (result.blocked === true && /^Suppressed: /.test(result.reason || ''))
  );
}

async function recoverPendingEmailEpisode(invoiceId, { microdeposit = false } = {}) {
  const prefix = `late_payment_checker:${microdeposit ? 'microdeposit:' : ''}${invoiceId}:`;
  try {
    const rows = await db('collections_contact_ledger')
      .where({ source: 'late_payment_checker' })
      .whereIn('channel', ['sms', 'email'])
      .whereRaw('invoice_ids @> ?::jsonb', [JSON.stringify([invoiceId])])
      .whereRaw('idempotency_key LIKE ?', [`${prefix}%`])
      .orderBy('occurred_at', 'asc');
    const episodes = new Map();
    for (const row of rows || []) {
      if (!String(row.idempotency_key || '').startsWith(prefix)) continue;
      const [tierValue, channel] = String(row.idempotency_key).slice(prefix.length).split(':');
      const tierDays = Number(tierValue);
      if (!Number.isFinite(tierDays) || !['sms', 'email'].includes(channel)) continue;
      if (!episodes.has(tierDays)) episodes.set(tierDays, {});
      episodes.get(tierDays)[channel] = row;
    }
    for (const [tierDays, episode] of episodes) {
      const smsMeta = ledgerMetadata(episode.sms);
      const emailMeta = ledgerMetadata(episode.email);
      if (emailEpisodeNeedsRetry(smsMeta, emailMeta)) {
        return {
          tierDays,
          ledgerIds: [episode.sms?.id, episode.email?.id].filter(Boolean),
          emailLedgerId: episode.email?.id || null,
        };
      }
    }
  } catch (err) {
    logger.warn(`[late-payment] ledger episode recovery failed for invoice ${invoiceId}: ${err.message}`);
    return { unavailable: true };
  }
  return null;
}

async function resolvePendingEmailEpisode(episode, reason) {
  if (!episode?.emailLedgerId) return true;
  try {
    await db('collections_contact_ledger').where({ id: episode.emailLedgerId }).update({
      metadata: db.raw("COALESCE(metadata, '{}'::jsonb) || ?::jsonb", [
        JSON.stringify({ resolved: true, resolution: reason }),
      ]),
    });
    return true;
  } catch (err) {
    logger.warn(`[late-payment] could not resolve pending Email ledger ${episode.emailLedgerId}: ${err.message}`);
    return false;
  }
}

async function claimReservedEmail(ContactLedger, ledger) {
  const claim = typeof ContactLedger.claimAttempt === 'function'
    ? await ContactLedger.claimAttempt(ledger)
    : { allowed: true };
  if (claim.delivered) return { allowed: false, delivered: true };
  return claim.allowed ? { allowed: true } : { allowed: false, held: true };
}

async function completePendingEmail(row, channel = 'sms+email') {
  if (!row?.id) return false;
  try {
    await db('activity_log').where({ id: row.id }).update({
      metadata: db.raw(
        "(COALESCE(metadata, '{}'::jsonb) - 'pendingEmail') || jsonb_build_object('channel', ?)",
        [channel],
      ),
    });
    return true;
  } catch (err) {
    logger.warn(`[late-payment] could not clear pending Email activity ${row.id}: ${err.message}`);
    return false;
  }
}

async function dispatchReservedText(ContactLedger, ledger, dispatch) {
  const claim = typeof ContactLedger.claimAttempt === 'function'
    ? await ContactLedger.claimAttempt(ledger)
    : { allowed: true };
  if (claim.delivered) return { sent: true, deduped: true };
  if (!claim.allowed) return { sent: false, deferred: true, code: 'PRIOR_TEXT_OUTCOME_UNCONFIRMED' };
  const result = await dispatch();
  if (!result || result.deliveryOutcome === 'uncertain') {
    return { sent: false, deferred: true, code: 'TEXT_OUTCOME_UNCONFIRMED' };
  }
  const stamped = result.sent === true
    ? (typeof ContactLedger.markDelivered === 'function' ? await ContactLedger.markDelivered(ledger) : true)
    : await ContactLedger.markSendFailed(ledger, { code: result.code || 'blocked' });
  return stamped ? result : { sent: false, deferred: true, code: 'TEXT_OUTCOME_STAMP_FAILED' };
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
  let tierDays = tierDaysForOverdue(daysSince);
  let dedupeKey = `${invoiceRef}|${tierDays} DAYS|microdeposit`;
  let pendingEmailActivity = null;
  let pendingEmailEpisode = await recoverPendingEmailEpisode(inv.id, { microdeposit: true });
  if (pendingEmailEpisode?.unavailable) return 'skip';
  if (pendingEmailEpisode) {
    tierDays = pendingEmailEpisode.tierDays;
    dedupeKey = `${invoiceRef}|${tierDays} DAYS|microdeposit`;
  }
  try {
    const already = await db('activity_log')
      .where({ action: 'microdeposit_verification_reminder' })
      .whereRaw(
        "(metadata::text LIKE ? OR (metadata->>'invoiceId' = ? AND metadata->>'pendingEmail' = 'true'))",
        [`%${dedupeKey}%`, String(inv.id)],
      )
      .first();
    if (already && activityMetadata(already).pendingEmail !== true) return 'deduped';
    pendingEmailActivity = already || null;
    if (pendingEmailActivity) {
      const meta = activityMetadata(pendingEmailActivity);
      tierDays = Number(meta.tierDays) || tierDays;
      dedupeKey = meta.dedupeKey || dedupeKey;
      pendingEmailEpisode = {
        ...pendingEmailEpisode,
        tierDays,
        ledgerIds: meta.ledgerIds?.length ? meta.ledgerIds : (pendingEmailEpisode?.ledgerIds || []),
        emailLedgerId: meta.emailLedgerId || pendingEmailEpisode?.emailLedgerId || null,
      };
    }
  } catch { /* proceed if the dedupe check fails */ }

  const customer = await db('customers').where({ id: inv.customer_id }).first();
  if (!customer || customer.deleted_at) return 'skip';
  const prefs = await db('notification_prefs').where({ customer_id: customer.id }).first().catch(() => null);
  const explicitChannels = explicitBillingChannels(prefs || {}, 'payment_issue');
  if (!customer.phone && !explicitChannels?.some((channel) => channel === 'email' || channel === 'push')) return 'skip';
  const explicitEmailSelected = billingChannelAllowed(prefs || {}, 'payment_issue', 'email') === true;

  const ContactLedger = require('./collections/contact-ledger');
  if (pendingEmailEpisode) {
    if (explicitChannels && !explicitEmailSelected) {
      await completePendingEmail(pendingEmailActivity, 'sms');
      await resolvePendingEmailEpisode(pendingEmailEpisode, 'email_unselected');
      return 'deduped';
    }
    const priorLedgerIds = pendingEmailEpisode.ledgerIds || [];
    if (!await collectionsChannelPermitted(customer.id, inv.id, 'email', now, priorLedgerIds)) return 'skip';
    let emailLedger;
    try {
      emailLedger = await ContactLedger.recordContact({
        customerId: customer.id, channel: 'email', purpose: 'payment_verification',
        invoiceIds: [inv.id], source: 'late_payment_checker',
        metadata: { microdeposit: true, tier_days: tierDays },
        idempotencyKey: `late_payment_checker:microdeposit:${inv.id}:${tierDays}:email`,
      });
    } catch (ledgerErr) {
      logger.warn(`[late-payment] micro-deposit pending Email skipped for invoice ${inv.id} — ledger unavailable: ${ledgerErr.message}`);
      return 'skip';
    }
    const claim = await claimReservedEmail(ContactLedger, emailLedger);
    if (claim.delivered) {
      await completePendingEmail(pendingEmailActivity);
      return 'sent';
    }
    if (!claim.allowed) return 'skip';
    const result = await sendMicrodepositVerificationEmail({
      invoice: inv, customer, touchKey: `${tierDays}d`, enforceBillingPreference: true,
    }).catch((e) => ({ ok: false, error: e.message }));
    if (result?.ok !== true) {
      await ContactLedger.markSendFailed(emailLedger, { error: result?.reason || 'sidecar_failed' });
      if (isTerminalEmailRefusal(result)
        && await resolvePendingEmailEpisode({ emailLedgerId: emailLedger.id }, 'email_terminal_refusal')) {
        await completePendingEmail(pendingEmailActivity, 'sms');
      }
      return 'skip';
    }
    await ContactLedger.markDelivered(emailLedger);
    await completePendingEmail(pendingEmailActivity);
    return 'sent';
  }

  const body = await renderSmsTemplate('bank_verification_incomplete', {
    first_name: customer.first_name || 'there',
    billing_url: `${domain}/billing`,
  }, { workflow: 'microdeposit_verification_reminder', entity_type: 'invoice', entity_id: inv.id });
  // No fallback to the generic late-payment notice — sending "you're overdue" to a
  // customer mid-verification is exactly the message this diversion exists to stop.
  if (!body) return 'skip';

  let smsLedger = null;
  try {
    const [smsPermitted, emailPermitted] = await Promise.all([
      collectionsChannelPermitted(customer.id, inv.id, 'sms', now),
      collectionsChannelPermitted(customer.id, inv.id, 'email', now),
    ]);
    let emailAttempted = false;
    let emailDelivered = false;
    let emailLedger = null;
    let emailResult = null;
    const attemptEmail = async () => {
      if (emailAttempted || !emailPermitted) return;
      emailAttempted = true;
      try {
        emailLedger = await ContactLedger.recordContact({
          customerId: customer.id,
          channel: 'email',
          purpose: 'payment_verification',
          invoiceIds: [inv.id],
          source: 'late_payment_checker',
          metadata: { microdeposit: true, tier_days: tierDays },
          idempotencyKey: `late_payment_checker:microdeposit:${inv.id}:${tierDays}:email`,
        });
      } catch (ledgerErr) {
        logger.warn(`[late-payment] micro-deposit email sidecar skipped for invoice ${inv.id} — ledger unavailable: ${ledgerErr.message}`);
      }
      if (!emailLedger) return;
      const claim = await claimReservedEmail(ContactLedger, emailLedger);
      if (claim.delivered) {
        emailDelivered = true;
        return;
      }
      if (!claim.allowed) return;
      emailResult = await sendMicrodepositVerificationEmail({
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
        idempotencyKey: `late_payment_checker:microdeposit:${inv.id}:${tierDays}:sms`,
      });
    } catch (ledgerErr) {
      logger.warn(`[late-payment] micro-deposit re-nudge skipped for invoice ${inv.id} — ledger unavailable: ${ledgerErr.message}`);
    }
    const sendResult = smsLedger ? await dispatchReservedText(ContactLedger, smsLedger, () => sendCustomerMessage({
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
    })) : { sent: false, blocked: true, code: customer.phone ? 'COLLECTIONS_POLICY' : 'NO_PHONE' };
    await attemptEmail();
    if (isTransientSmsResult(sendResult)) return 'skip';
    if (!sendResult.sent && !emailDelivered) return 'skip';
    const terminalEmailResolved = sendResult.sent && isTerminalEmailRefusal(emailResult)
      && await resolvePendingEmailEpisode({ emailLedgerId: emailLedger?.id }, 'email_terminal_refusal');
    const pendingEmail = sendResult.sent && explicitEmailSelected && !emailDelivered && !terminalEmailResolved;
    const activityInsert = db('activity_log').insert({
      customer_id: customer.id,
      action: 'microdeposit_verification_reminder',
      description: `Micro-deposit verification re-nudge (${tierDays}-day): ${inv.title || 'invoice'} ${invoiceRef}`,
      metadata: JSON.stringify({
        dedupeKey, invoiceId: inv.id, tierDays, daysOverdue: daysSince,
        ...(pendingEmail ? {
          pendingEmail: true, channel: 'sms',
          ledgerIds: [smsLedger?.id, emailLedger?.id].filter(Boolean),
          emailLedgerId: emailLedger?.id || null,
        } : {}),
      }),
    });
    if (pendingEmail) await activityInsert;
    else await activityInsert.catch(() => {});
    return 'sent';
  } catch (e) {
    logger.error(`[late-payment] micro-deposit re-nudge failed for invoice ${inv.id}: ${e.message}`);
    if (smsLedger) await ContactLedger.markSendFailed(smsLedger, { error: 'send_threw' });
    return 'skip';
  }
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
      let tierDays = tierDaysForOverdue(daysSince);
      let invoiceKey = `${invoiceRef}|${tierDays} DAYS`;
      let pendingEmailActivity = null;
      let pendingEmailEpisode = await recoverPendingEmailEpisode(inv.id);
      if (pendingEmailEpisode?.unavailable) { skipped++; continue; }
      if (pendingEmailEpisode) {
        tierDays = pendingEmailEpisode.tierDays;
        invoiceKey = `${invoiceRef}|${tierDays} DAYS`;
      }

      try {
        let alreadySent = await db('activity_log')
          .where({ action: 'late_payment_reminder' })
          .whereRaw(
            "(metadata::text LIKE ? OR (metadata->>'invoiceId' = ? AND metadata->>'pendingEmail' = 'true'))",
            [`%${invoiceKey}%`, String(inv.id)],
          )
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
        if (alreadySent) {
          const meta = activityMetadata(alreadySent);
          if (meta.pendingEmail !== true) { skipped++; continue; }
          pendingEmailActivity = alreadySent;
          const pendingDays = Number(meta.daysOverdue);
          tierDays = Number(meta.tierDays)
            || (Number.isFinite(pendingDays) ? tierDaysForOverdue(pendingDays) : tierDays);
          invoiceKey = meta.invoiceKey || `${invoiceRef}|${tierDays} DAYS`;
          pendingEmailEpisode = {
            ...pendingEmailEpisode,
            tierDays,
            ledgerIds: meta.ledgerIds?.length ? meta.ledgerIds : (pendingEmailEpisode?.ledgerIds || []),
            emailLedgerId: meta.emailLedgerId || pendingEmailEpisode?.emailLedgerId || null,
          };
        }
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
      if (pendingEmailEpisode && explicitChannels && !explicitEmailSelected) {
        await completePendingEmail(pendingEmailActivity, 'sms');
        await resolvePendingEmailEpisode(pendingEmailEpisode, 'email_unselected');
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
      const templateKey = `late_payment_${tierDays}d`;
      const body = pendingEmailEpisode ? null : await renderSmsTemplate(templateKey, {
        first_name: name,
        invoice_title: invoiceTitle,
        service_date_clause: dateClause,
        pay_url: payUrl,
      }, {
        workflow: 'late_payment_reminder',
        entity_type: 'invoice',
        entity_id: inv.id,
      });
      if (!pendingEmailEpisode && !body) {
        logger.warn(`[late-payment] template ${templateKey} missing/disabled — skipping reminder for invoice ${inv.id}`);
        skipped++;
        continue;
      }

      try {
        const ContactLedger = require('./collections/contact-ledger');
        // Decide both policy legs before either ledger reservation is written,
        // so an explicitly selected email can go first without consuming the
        // same-run frequency window that the selected Text/App leg also needs.
        const priorLedgerIds = pendingEmailEpisode?.ledgerIds || [];
        const [smsPolicyPermitted, emailPolicyPermitted] = pendingEmailEpisode
          ? [false, await collectionsChannelPermitted(customer.id, inv.id, 'email', now, priorLedgerIds)]
          : await Promise.all([
            collectionsChannelPermitted(customer.id, inv.id, 'sms', now),
            collectionsChannelPermitted(customer.id, inv.id, 'email', now),
          ]);
        let emailResult = null;
        let emailAttempted = false;
        let emailLedger = null;
        const attemptEmail = async () => {
          if (emailAttempted) return emailResult;
          emailAttempted = true;
          if (!emailPolicyPermitted) return emailResult;
          try {
            emailLedger = await ContactLedger.recordContact({
              customerId: customer.id,
              channel: 'email',
              purpose: 'late_payment',
              invoiceIds: [inv.id],
              source: 'late_payment_checker',
              metadata: { tier_days: tierDays, days_overdue: daysSince },
              idempotencyKey: `late_payment_checker:${inv.id}:${tierDays}:email`,
            });
          } catch (ledgerErr) {
            logger.warn(`[late-payment] email leg skipped for customer ${customer.id} — contact ledger unavailable: ${ledgerErr.message}`);
          }
          if (!emailLedger) return emailResult;
          const claim = await claimReservedEmail(ContactLedger, emailLedger);
          if (claim.delivered) {
            emailResult = { ok: true, deduped: true };
            return emailResult;
          }
          if (!claim.allowed) {
            emailResult = { ok: false, retryable: true, reason: 'prior_email_outcome_unconfirmed' };
            return emailResult;
          }
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
          if (emailResult?.ok === true) {
            if (typeof ContactLedger.markDelivered === 'function') await ContactLedger.markDelivered(emailLedger);
          } else {
            await ContactLedger.markSendFailed(emailLedger, { reason: emailResult?.reason || 'email_not_sent' });
          }
          return emailResult;
        };

        if (pendingEmailEpisode) {
          await attemptEmail();
          if (emailResult?.ok === true) {
            await completePendingEmail(pendingEmailActivity);
            notified++;
          } else if (isTerminalEmailRefusal(emailResult)
            && await resolvePendingEmailEpisode({ emailLedgerId: emailLedger?.id }, 'email_terminal_refusal')) {
            await completePendingEmail(pendingEmailActivity, 'sms');
            skipped++;
          } else skipped++;
          continue;
        }

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
              idempotencyKey: `late_payment_checker:${inv.id}:${tierDays}:sms`,
            });
          } catch (ledgerErr) {
            logger.warn(`[late-payment] SMS skipped for customer ${customer.id} — contact ledger unavailable: ${ledgerErr.message}`);
            sendResult = { sent: false, blocked: true, code: 'LEDGER_UNAVAILABLE' };
          }
          if (smsLedger) {
            sendResult = await dispatchReservedText(ContactLedger, smsLedger, () => sendCustomerMessage({
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
            }));
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
        const terminalEmailResolved = smsSent && isTerminalEmailRefusal(emailResult)
          && await resolvePendingEmailEpisode({ emailLedgerId: emailLedger?.id }, 'email_terminal_refusal');
        const pendingEmail = smsSent && explicitEmailSelected && !emailDelivered && !terminalEmailResolved;

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

        const activityInsert = db('activity_log').insert({
          customer_id: customer.id,
          action: 'late_payment_reminder',
          description: `${tierDays}-day late payment reminder: ${invoiceTitle} ($${totalAmount.toFixed(2)})`,
          metadata: JSON.stringify({
            invoiceKey, invoiceId: inv.id, amount: totalAmount, daysOverdue: daysSince,
            tierDays,
            channel: smsSent ? (emailDelivered ? 'sms+email' : 'sms') : 'email_only',
            ...(pendingEmail ? {
              pendingEmail: true,
              ledgerIds: [smsLedger?.id, emailLedger?.id].filter(Boolean),
              emailLedgerId: emailLedger?.id || null,
            } : {}),
          }),
        });
        if (pendingEmail) await activityInsert;
        else await activityInsert.catch(() => {});
      } catch (smsErr) {
        logger.error(`[late-payment] SMS failed for customer ${customer.id}: ${smsErr.message}`);
        skipped++;
      }
    }

    return { notified, skipped, emailedFallback, totalUnpaid: invoices.length };
  },
};

module.exports = LatePaymentService;
