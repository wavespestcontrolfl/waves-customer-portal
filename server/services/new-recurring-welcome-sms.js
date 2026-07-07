const db = require('../models/db');
const logger = require('./logger');
const { sendCustomerMessage } = require('./messaging/send-customer-message');

const TEMPLATE_KEY = 'auto_new_recurring';
const SEQUENCE_TYPE = 'new_customer_welcome';

// Booking already texts the appointment confirmation; sending the welcome in
// the same moment double-buzzes the customer (owner directive 2026-07-06).
// Queue it and let the scheduler deliver once the confirmation has landed.
const WELCOME_DELAY_MINUTES = 60;
// A queued row that keeps erroring is abandoned after this many attempts so
// the processor can't retry forever.
const MAX_DELIVERY_ATTEMPTS = 3;
// A 'sending' claim older than this is presumed crashed mid-dispatch and is
// settled by the recovery pass (completed if a provider row proves the text
// left, released for retry otherwise). Must comfortably exceed one dispatch.
const STALE_CLAIM_MINUTES = 30;
// Email twin of the welcome, sent directly at the same delivery moment.
const TEMPLATE_EMAIL_KEY = 'welcome.new_recurring';

async function isNewRecurringSignupCandidate(customerId) {
  if (!customerId) return false;

  try {
    const [priorRecurringSeries, priorCompletedService] = await Promise.all([
      db('scheduled_services')
        .where({ customer_id: customerId, is_recurring: true })
        .first('id'),
      db('service_records')
        .where({ customer_id: customerId })
        .whereNot('status', 'cancelled')
        .first('id'),
    ]);

    return !priorRecurringSeries && !priorCompletedService;
  } catch (err) {
    logger.warn(`[new-recurring-welcome] prior service lookup failed for customer ${customerId}: ${err.message}`);
    return false;
  }
}

// Any row of this sequence type — queued, sent, or abandoned — blocks a new
// enqueue, keeping the once-ever guarantee across every booking path.
async function hasWelcomeSequence(customerId) {
  if (!customerId) return false;

  try {
    if (!(await db.schema.hasTable('sms_sequences'))) return false;
    const existing = await db('sms_sequences')
      .where({ customer_id: customerId, sequence_type: SEQUENCE_TYPE })
      .first('id');
    return !!existing;
  } catch (err) {
    logger.warn(`[new-recurring-welcome] sequence lookup failed for customer ${customerId}: ${err.message}`);
    return false;
  }
}

async function recordWelcomeInteraction({ customerId, scheduledServiceId, adminUserId }) {
  if (!customerId) return;

  try {
    if (!(await db.schema.hasTable('customer_interactions'))) return;
    const cols = await db('customer_interactions').columnInfo();
    const data = {
      customer_id: customerId,
      interaction_type: 'sms_outbound',
      subject: 'New recurring welcome SMS sent',
    };

    if (cols.body) data.body = 'Sent the New Recurring Customer SMS template.';
    if (cols.admin_user_id && adminUserId) data.admin_user_id = adminUserId;
    if (cols.metadata) {
      data.metadata = JSON.stringify({
        template_key: TEMPLATE_KEY,
        scheduled_service_id: scheduledServiceId || null,
      });
    }

    await db('customer_interactions').insert(data);
  } catch (err) {
    logger.warn(`[new-recurring-welcome] interaction log failed for customer ${customerId}: ${err.message}`);
  }
}

async function renderWelcomeBody(customer) {
  try {
    const templates = require('../routes/admin-sms-templates');
    if (typeof templates.getTemplate !== 'function') return null;
    return await templates.getTemplate(TEMPLATE_KEY, {
      first_name: customer?.first_name || 'there',
    });
  } catch (err) {
    logger.warn(`[new-recurring-welcome] template lookup failed: ${err.message}`);
    return null;
  }
}

function parseMetadata(row) {
  if (!row?.metadata) return {};
  if (typeof row.metadata === 'object') return row.metadata;
  try { return JSON.parse(row.metadata); } catch { return {}; }
}

/**
 * Queue the welcome text for a new recurring customer. Keeps the historical
 * name because every booking path calls it fire-and-forget — but since
 * 2026-07-06 it enqueues an sms_sequences row for the scheduler to deliver
 * ~1 hour later instead of texting inline (see WELCOME_DELAY_MINUTES).
 * Idempotent: any existing new_customer_welcome row blocks a second enqueue.
 */
async function sendNewRecurringWelcome({
  customer,
  scheduledServiceId,
  recurringPattern,
  entryPoint = 'new_recurring_welcome',
  adminUserId = null,
} = {}) {
  if (!customer?.id) return { sent: false, skipped: true, reason: 'missing_customer' };
  // The queued sequence is the scheduling vehicle for BOTH welcome legs
  // (SMS + the email twin sent at delivery time) — an email-only customer
  // must still enqueue or they get no welcome at all. Callers pass partial
  // customer shapes (the appointment tagger sends only id/name/phone), so a
  // missing phone re-reads the row rather than trusting the argument;
  // deliverQueuedWelcome re-reads the full row at delivery time anyway.
  if (!customer.phone) {
    let email = String(customer.email || '').trim();
    if (!email) {
      const row = await db('customers').where({ id: customer.id }).first('email').catch(() => null);
      email = String(row?.email || '').trim();
    }
    if (!email) {
      logger.info(`[new-recurring-welcome] skipping customer ${customer.id}: no phone or email`);
      return { sent: false, skipped: true, reason: 'no_contact' };
    }
  }
  if (!(await db.schema.hasTable('sms_sequences'))) {
    logger.warn(`[new-recurring-welcome] sms_sequences table missing; welcome not queued for customer ${customer.id}`);
    return { sent: false, skipped: true, reason: 'no_sequence_table' };
  }
  if (await hasWelcomeSequence(customer.id)) {
    return { sent: false, skipped: true, reason: 'already_sent' };
  }

  try {
    const cols = await db('sms_sequences').columnInfo();
    const data = {
      customer_id: customer.id,
      sequence_type: SEQUENCE_TYPE,
      status: 'active',
    };
    if (cols.step) data.step = 0;
    if (cols.next_send_at) data.next_send_at = new Date(Date.now() + WELCOME_DELAY_MINUTES * 60 * 1000);
    if (cols.metadata) {
      data.metadata = JSON.stringify({
        template_key: TEMPLATE_KEY,
        scheduled_service_id: scheduledServiceId || null,
        recurring_pattern: recurringPattern || null,
        entry_point: entryPoint,
        admin_user_id: adminUserId || null,
        queued_at: new Date().toISOString(),
      });
    }
    await db('sms_sequences').insert(data);
    logger.info(`[new-recurring-welcome] welcome queued for customer ${customer.id} (+${WELCOME_DELAY_MINUTES}m)`);
    return { sent: false, queued: true };
  } catch (err) {
    logger.warn(`[new-recurring-welcome] enqueue failed for customer ${customer.id}: ${err.message}`);
    return { sent: false, skipped: true, reason: 'enqueue_failed' };
  }
}

// Deliver one due queue row. Re-reads the customer at send time (phone may
// have changed since booking) and skips permanently when the anchoring
// appointment was cancelled inside the delay window.
// Direct-send the welcome.new_recurring email (library template; the row's
// status is the kill switch — archive/pause makes sendTemplate throw
// 'active template not found', caught by the caller). Idempotency key
// matches the once-ever-per-customer design the draft automation row
// specified (welcome.new_recurring:{customer_id}), so retries of the SMS
// delivery loop dedupe instead of double-sending.
async function sendWelcomeEmail(customer) {
  const email = String(customer.email || '').trim();
  if (!email) return;
  const sendgrid = require('./sendgrid-mail');
  if (!sendgrid.isConfigured()) {
    logger.warn(`[new-recurring-welcome] welcome email skipped for customer ${customer.id} — SendGrid not configured`);
    return;
  }
  // Portal-wide email opt-out — service_operational suppression groups
  // don't cover it, so the sender checks it explicitly.
  const prefs = await db('notification_prefs')
    .where({ customer_id: customer.id })
    .first('email_enabled')
    .catch(() => null);
  if (prefs?.email_enabled === false) {
    logger.info(`[new-recurring-welcome] welcome email skipped for customer ${customer.id} — email disabled in prefs`);
    return;
  }
  const EmailTemplateLibrary = require('./email-template-library');
  const { WAVES_SUPPORT_PHONE_DISPLAY } = require('../constants/business');
  const { publicPortalUrl } = require('../utils/portal-url');
  const result = await EmailTemplateLibrary.sendTemplate({
    templateKey: TEMPLATE_EMAIL_KEY,
    to: email,
    payload: {
      first_name: String(customer.first_name || '').trim() || 'there',
      // The template's CTA renders url_variable customer_portal_url
      // (20260530000002) — renderBlocks DROPS a CTA with a blank href, so
      // omitting this silently loses the portal button.
      customer_portal_url: `${publicPortalUrl()}/login`,
      // The seed blocks don't reference it, but admin-edited versions may —
      // an empty value renders as a blank in customer copy.
      company_phone: WAVES_SUPPORT_PHONE_DISPLAY,
    },
    recipientType: 'customer',
    recipientId: customer.id,
    triggerEventId: `${TEMPLATE_EMAIL_KEY}:${customer.id}`,
    idempotencyKey: `${TEMPLATE_EMAIL_KEY}:${customer.id}`,
    categories: ['welcome_new_recurring'],
    // SendGrid rejection bodies can echo the recipient address — keep them
    // out of the provider log; the caller's catch redacts too.
    suppressProviderErrorLog: true,
  });
  if (result?.blocked) {
    logger.warn(`[new-recurring-welcome] welcome email suppressed for customer ${customer.id}: ${result.reason || 'suppressed'}`);
  } else if (result?.deduped) {
    logger.info(`[new-recurring-welcome] welcome email deduped for customer ${customer.id}`);
  } else {
    logger.info(`[new-recurring-welcome] welcome email sent for customer ${customer.id}`);
  }
}

async function deliverQueuedWelcome(row) {
  const meta = parseMetadata(row);
  const scheduledServiceId = meta.scheduled_service_id || null;

  const finish = async (status, extra = {}) => {
    await db('sms_sequences').where({ id: row.id }).update({
      status,
      metadata: JSON.stringify({ ...meta, ...extra }),
      updated_at: new Date(),
    });
  };

  const customer = await db('customers').where({ id: row.customer_id }).first();
  if (!customer) {
    await finish('cancelled', { skip_reason: 'customer_missing' });
    return { sent: false, skipped: true };
  }

  if (scheduledServiceId) {
    const svc = await db('scheduled_services')
      .where({ id: scheduledServiceId })
      .first('status');
    const status = String(svc?.status || '').toLowerCase();
    if (!svc || ['cancelled', 'canceled'].includes(status)) {
      await finish('cancelled', { skip_reason: 'appointment_cancelled' });
      logger.info(`[new-recurring-welcome] appointment cancelled before delivery; welcome dropped for customer ${row.customer_id}`);
      return { sent: false, skipped: true };
    }
  }

  // Email twin of the welcome (owner go 2026-07-06) — a DIRECT sender like
  // the other lifecycle emails, NOT the automation executor (whose master
  // gate is off in prod; its draft welcome automation row is vestigial).
  // Best-effort and idempotent per customer, so SMS retries can't double it
  // and an email failure never blocks the text. Fires at the same +1h
  // delivery moment as the SMS. Kill switch = the welcome.new_recurring
  // email template row.
  await sendWelcomeEmail(customer).catch((err) => {
    const { redactEmailAddresses } = require('./email-template-library');
    logger.warn(`[new-recurring-welcome] welcome email failed for customer ${customer.id}: ${redactEmailAddresses(err.message)}`);
  });

  if (!customer.phone) {
    // Email-only customer: the email above is their welcome; the SMS leg
    // settles the sequence exactly as before (the once-ever guard reads any
    // row, so the status value carries no extra meaning).
    await finish('cancelled', { skip_reason: 'no_phone' });
    return { sent: false, skipped: true };
  }

  const body = await renderWelcomeBody(customer);
  if (!body) {
    await finish('cancelled', { skip_reason: 'template_unavailable' });
    logger.info(`[new-recurring-welcome] ${TEMPLATE_KEY} missing, disabled, or invalid; welcome dropped for customer ${row.customer_id}`);
    return { sent: false, skipped: true };
  }

  const sendResult = await sendCustomerMessage({
    to: customer.phone,
    body,
    channel: 'sms',
    audience: 'customer',
    purpose: 'appointment',
    customerId: customer.id,
    appointmentId: scheduledServiceId || null,
    identityTrustLevel: 'service_contact_authorized',
    entryPoint: meta.entry_point || 'new_recurring_welcome',
    metadata: {
      original_message_type: TEMPLATE_KEY,
      template_key: TEMPLATE_KEY,
      scheduled_service_id: scheduledServiceId,
      recurring_pattern: meta.recurring_pattern || null,
      ...(meta.admin_user_id ? { adminUserId: meta.admin_user_id } : {}),
    },
  });

  if (!sendResult.sent) {
    // A retryable provider failure (429/5xx) stays queued — push next_send_at
    // out and let the next tick retry; the attempts counter still caps total
    // tries. CONSENT_LOOKUP_FAILED is a transient prefs/customer lookup DB
    // blip — retry-advised by contract but carrying no retry metadata — and
    // must not become the permanent once-ever cancel (same handling as the
    // scheduled-SMS and deposit-receipt rails). Consent BLOCKS and landlines
    // won't heal on retry — mark those done so hasWelcomeSequence's
    // once-ever guard holds.
    if (sendResult.retryable || sendResult.deferred || sendResult.code === 'CONSENT_LOOKUP_FAILED') {
      // Quiet-hours/holiday holds carry nextAllowedAt — schedule exactly
      // there and refund the attempt (a legal-window hold isn't a failure;
      // blind +15m retries would burn MAX_DELIVERY_ATTEMPTS overnight and
      // cancel the welcome before the send window ever opens).
      const isLegalHold = sendResult.code === 'QUIET_HOURS_HOLD';
      const nextAt = sendResult.nextAllowedAt
        ? new Date(sendResult.nextAllowedAt)
        : new Date(Date.now() + 15 * 60 * 1000);
      await db('sms_sequences').where({ id: row.id }).update({
        // The sweep claimed this row as 'sending' before dispatch — release
        // the claim so the next tick can retry it.
        status: 'active',
        next_send_at: nextAt,
        ...(isLegalHold ? { step: parseInt(row.step, 10) || 0 } : {}),
        updated_at: new Date(),
      });
      logger.warn(`[new-recurring-welcome] ${isLegalHold ? 'quiet-hours hold' : 'retryable send failure'} for customer ${customer.id} (${sendResult.code || sendResult.reason || 'unknown'}) — requeued for ${nextAt.toISOString()}`);
      return sendResult;
    }
    await finish('cancelled', {
      skip_reason: `send_${sendResult.code || sendResult.reason || 'failed'}`,
    });
    logger.warn(`[new-recurring-welcome] SMS blocked/failed for customer ${customer.id}: ${sendResult.code || sendResult.reason || 'unknown'}`);
    return sendResult;
  }

  await finish('completed', {
    audit_log_id: sendResult?.auditLogId || null,
    provider_message_id: sendResult?.providerMessageId || null,
    sent_at: new Date().toISOString(),
  });
  await recordWelcomeInteraction({
    customerId: customer.id,
    scheduledServiceId,
    adminUserId: meta.admin_user_id || null,
  });

  return sendResult;
}

/**
 * Scheduler entry point — deliver every queued welcome whose delay has
 * elapsed. Attempt counting rides the `step` column so a row that throws
 * repeatedly (e.g. transient Twilio outage) is abandoned after
 * MAX_DELIVERY_ATTEMPTS instead of retrying forever.
 */
async function processDueWelcomes() {
  const results = { sent: 0, skipped: 0, errors: 0 };
  try {
    if (!(await db.schema.hasTable('sms_sequences'))) return results;

    // Recover stale claims first: a crash between Twilio's accept and the
    // completed-stamp leaves a row in 'sending'. A provider sms_log row for
    // this customer + template proves the text left (the welcome is
    // once-ever per customer, so the pair is unambiguous) — settle it as
    // completed; otherwise release the claim so the next tick retries
    // (attempts were already counted at claim time, so the cap still holds).
    const staleBefore = new Date(Date.now() - STALE_CLAIM_MINUTES * 60 * 1000);
    const stale = await db('sms_sequences')
      .where({ sequence_type: SEQUENCE_TYPE, status: 'sending' })
      .where('updated_at', '<', staleBefore)
      .limit(25);
    for (const row of stale) {
      try {
        const proof = await db('sms_log')
          .where({ customer_id: row.customer_id, direction: 'outbound', message_type: TEMPLATE_KEY })
          .whereIn('status', ['queued', 'sent', 'delivered'])
          .first('id');
        await db('sms_sequences').where({ id: row.id, status: 'sending' }).update({
          status: proof ? 'completed' : 'active',
          ...(proof ? {} : { next_send_at: new Date() }),
          updated_at: new Date(),
        });
        logger.warn(`[new-recurring-welcome] recovered stale claim for customer ${row.customer_id} — ${proof ? 'provider row found, settled as completed' : 'no provider row, released for retry'}`);
      } catch (err) {
        logger.error(`[new-recurring-welcome] stale-claim recovery failed for sequence ${row.id}: ${err.message}`);
      }
    }

    const due = await db('sms_sequences')
      .where({ sequence_type: SEQUENCE_TYPE, status: 'active' })
      .whereNotNull('next_send_at')
      .where('next_send_at', '<=', new Date())
      .limit(25);

    for (const row of due) {
      try {
        const attempts = (parseInt(row.step, 10) || 0) + 1;
        if (attempts > MAX_DELIVERY_ATTEMPTS) {
          await db('sms_sequences').where({ id: row.id }).update({ status: 'cancelled', updated_at: new Date() });
          results.skipped++;
          logger.warn(`[new-recurring-welcome] abandoned after ${MAX_DELIVERY_ATTEMPTS} attempts for customer ${row.customer_id}`);
          continue;
        }
        // Claim before dispatch (active → sending, atomic on status) so a
        // crash after Twilio accepts can't leave the row due for the next
        // 10-minute sweep and double-text the customer. A miss means another
        // worker claimed it.
        const claimed = await db('sms_sequences')
          .where({ id: row.id, status: 'active' })
          .update({ status: 'sending', step: attempts, updated_at: new Date() });
        if (!claimed) continue;
        const outcome = await deliverQueuedWelcome(row);
        if (outcome?.sent) results.sent++;
        else results.skipped++;
      } catch (err) {
        results.errors++;
        logger.error(`[new-recurring-welcome] delivery failed for sequence ${row.id}: ${err.message}`);
      }
    }
  } catch (err) {
    logger.error(`[new-recurring-welcome] queue scan failed: ${err.message}`);
  }
  return results;
}

module.exports = {
  TEMPLATE_KEY,
  SEQUENCE_TYPE,
  WELCOME_DELAY_MINUTES,
  isNewRecurringSignupCandidate,
  sendNewRecurringWelcome,
  processDueWelcomes,
  _internals: {
    isNewRecurringSignupCandidate,
    hasWelcomeSequence,
    deliverQueuedWelcome,
    recordWelcomeInteraction,
    renderWelcomeBody,
  },
};
