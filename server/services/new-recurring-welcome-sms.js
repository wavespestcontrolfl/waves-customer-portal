const db = require('../models/db');
const logger = require('./logger');
const { sendCustomerMessage } = require('./messaging/send-customer-message');

const TEMPLATE_KEY = 'auto_new_recurring';
const SEQUENCE_TYPE = 'new_customer_welcome';

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

async function markWelcomeSequenceSent({ customerId, scheduledServiceId, sendResult }) {
  if (!customerId) return;

  try {
    if (!(await db.schema.hasTable('sms_sequences'))) return;
    if (await hasWelcomeSequence(customerId)) return;

    const cols = await db('sms_sequences').columnInfo();
    const data = {
      customer_id: customerId,
      sequence_type: SEQUENCE_TYPE,
      status: 'completed',
    };

    if (cols.step) data.step = 1;
    if (cols.current_step) data.current_step = 1;
    if (cols.total_steps) data.total_steps = 1;
    if (cols.metadata) {
      data.metadata = JSON.stringify({
        template_key: TEMPLATE_KEY,
        scheduled_service_id: scheduledServiceId || null,
        audit_log_id: sendResult?.auditLogId || null,
        provider_message_id: sendResult?.providerMessageId || null,
        sent_at: new Date().toISOString(),
      });
    }

    await db('sms_sequences').insert(data);
  } catch (err) {
    logger.warn(`[new-recurring-welcome] sequence mark failed for customer ${customerId}: ${err.message}`);
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

async function sendNewRecurringWelcome({
  customer,
  scheduledServiceId,
  recurringPattern,
  entryPoint = 'new_recurring_welcome',
  adminUserId = null,
} = {}) {
  if (!customer?.id) return { sent: false, skipped: true, reason: 'missing_customer' };
  if (!customer.phone) {
    logger.info(`[new-recurring-welcome] skipping customer ${customer.id}: no phone`);
    return { sent: false, skipped: true, reason: 'no_phone' };
  }
  if (await hasWelcomeSequence(customer.id)) {
    return { sent: false, skipped: true, reason: 'already_sent' };
  }

  const body = await renderWelcomeBody(customer);
  if (!body) {
    logger.info(`[new-recurring-welcome] ${TEMPLATE_KEY} missing, disabled, or invalid; skipping customer ${customer.id}`);
    return { sent: false, skipped: true, reason: 'template_unavailable' };
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
    entryPoint,
    metadata: {
      original_message_type: TEMPLATE_KEY,
      template_key: TEMPLATE_KEY,
      scheduled_service_id: scheduledServiceId || null,
      recurring_pattern: recurringPattern || null,
      ...(adminUserId ? { adminUserId } : {}),
    },
  });

  if (!sendResult.sent) {
    logger.warn(`[new-recurring-welcome] SMS blocked/failed for customer ${customer.id}: ${sendResult.code || sendResult.reason || 'unknown'}`);
    return sendResult;
  }

  await markWelcomeSequenceSent({
    customerId: customer.id,
    scheduledServiceId,
    sendResult,
  });
  await recordWelcomeInteraction({
    customerId: customer.id,
    scheduledServiceId,
    adminUserId,
  });

  return sendResult;
}

module.exports = {
  TEMPLATE_KEY,
  SEQUENCE_TYPE,
  isNewRecurringSignupCandidate,
  sendNewRecurringWelcome,
  _internals: {
    isNewRecurringSignupCandidate,
    hasWelcomeSequence,
    markWelcomeSequenceSent,
    recordWelcomeInteraction,
    renderWelcomeBody,
  },
};
