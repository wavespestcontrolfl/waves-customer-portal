const db = require('../../models/db');
const TwilioService = require('../twilio');
const logger = require('../logger');
const { sendCustomerMessage } = require('../messaging/send-customer-message');
const { renderRequiredSmsTemplate } = require('../sms-template-renderer');

// Admin alert recipient — must be a real cell, never one of our own Twilio
// numbers (an SMS from the HQ line to itself fails with Twilio error 21266).
const ADMIN_ALERT_PHONE = process.env.ADAM_PHONE || '+19415993489';

const CANCELLATION_REASONS = new Set(['price', 'moving', 'quality']);

function cancellationReasonKey(reason) {
  const normalized = String(reason || '').trim().toLowerCase();
  return CANCELLATION_REASONS.has(normalized) ? normalized : 'default';
}

function cancellationTemplateKey(step, reason) {
  return `cancellation_save_step${step}_${cancellationReasonKey(reason)}`;
}

async function sendCancellationSms(customer, body, metadata = {}) {
  const result = await sendCustomerMessage({
    to: customer.phone,
    body,
    channel: 'sms',
    audience: 'customer',
    purpose: 'support_resolution',
    customerId: customer.id,
    identityTrustLevel: 'phone_matches_customer',
    entryPoint: 'cancellation_save',
    metadata: {
      original_message_type: 'cancellation_save',
      customerLocationId: customer.location_id,
      ...metadata,
    },
  });
  if (!result.sent) {
    logger.warn(`[cancellation-save] SMS blocked/failed for customer ${customer.id}: ${result.code || result.reason || 'unknown'}`);
  }
  return result;
}

class CancellationSave {
  /**
   * Initiate 3-step cancellation save sequence:
   *  Step 1 (immediate): Empathy message
   *  Step 2 (24h): Reason-specific offer
   *  Step 3 (72h): Door's open message
   */
  async initiate(customerId, cancelReason = 'default') {
    const customer = await db('customers').where({ id: customerId }).first();
    if (!customer || !customer.phone) return null;

    const reasonKey = cancellationReasonKey(cancelReason);

    // Create sequence record to track progress
    const [sequence] = await db('sms_sequences').insert({
      customer_id: customerId,
      sequence_type: 'cancellation_save',
      status: 'active',
      current_step: 1,
      total_steps: 3,
      metadata: JSON.stringify({ cancelReason: reasonKey, startedAt: new Date().toISOString() }),
    }).returning('*');

    // Step 1 — Immediate empathy message
    const step1Body = await renderRequiredSmsTemplate(cancellationTemplateKey(1, reasonKey), {
      first_name: customer.first_name || 'there',
    }, {
      workflow: 'cancellation_save_step1',
      entity_type: 'sms_sequence',
      entity_id: sequence.id,
    });

    await sendCancellationSms(customer, step1Body, { sequence_id: sequence.id, step: 1 });

    // Notify Adam immediately
    await TwilioService.sendSMS(ADMIN_ALERT_PHONE,
      `CANCELLATION ALERT: ${customer.first_name} ${customer.last_name} ` +
      `(ID: ${customerId}) wants to cancel. Reason: ${reasonKey}. ` +
      `Save sequence started.`,
      { messageType: 'admin_alert' }
    );

    // Step 2 — 24h delay: offer message
    const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;
    setTimeout(async () => {
      try {
        const seq = await db('sms_sequences').where({ id: sequence.id }).first();
        if (!seq || seq.status !== 'active') return;

        const step2Body = await renderRequiredSmsTemplate(cancellationTemplateKey(2, reasonKey), {
          first_name: customer.first_name || 'there',
        }, {
          workflow: 'cancellation_save_step2',
          entity_type: 'sms_sequence',
          entity_id: sequence.id,
        });

        const result = await sendCancellationSms(customer, step2Body, { sequence_id: sequence.id, step: 2 });
        if (!result.sent) return;

        await db('sms_sequences').where({ id: sequence.id }).update({ current_step: 2 });
      } catch (err) {
        logger.error(`Cancellation save step 2 failed for ${customerId}: ${err.message}`);
      }
    }, TWENTY_FOUR_HOURS);

    // Step 3 — 72h delay: door's open
    const SEVENTY_TWO_HOURS = 72 * 60 * 60 * 1000;
    setTimeout(async () => {
      try {
        const seq = await db('sms_sequences').where({ id: sequence.id }).first();
        if (!seq || seq.status !== 'active') return;

        const step3Body = await renderRequiredSmsTemplate('cancellation_save_step3', {
          first_name: customer.first_name || 'there',
        }, {
          workflow: 'cancellation_save_step3',
          entity_type: 'sms_sequence',
          entity_id: sequence.id,
        });

        const result = await sendCancellationSms(customer, step3Body, { sequence_id: sequence.id, step: 3 });
        if (!result.sent) return;

        await db('sms_sequences').where({ id: sequence.id })
          .update({ current_step: 3, status: 'completed' });
      } catch (err) {
        logger.error(`Cancellation save step 3 failed for ${customerId}: ${err.message}`);
      }
    }, SEVENTY_TWO_HOURS);

    logger.info(`Cancellation save initiated for customer ${customerId} (reason: ${reasonKey})`);
    return { sequenceId: sequence.id, status: 'active' };
  }

  /**
   * Handle customer replies to the cancellation save sequence.
   * 1 = accept offer, 2 = want to talk, CANCEL = proceed with cancellation
   */
  async handleReply(customerId, reply) {
    const sequence = await db('sms_sequences')
      .where({ customer_id: customerId, sequence_type: 'cancellation_save', status: 'active' })
      .orderBy('created_at', 'desc')
      .first();

    if (!sequence) return null;

    const customer = await db('customers').where({ id: customerId }).first();
    const normalizedReply = reply.trim().toLowerCase();

    if (normalizedReply === '1') {
      await db('sms_sequences').where({ id: sequence.id }).update({ status: 'converted' });

      const body = await renderRequiredSmsTemplate('cancellation_save_accepted_offer', {
        first_name: customer.first_name || 'there',
      }, {
        workflow: 'cancellation_save_accepted_offer',
        entity_type: 'sms_sequence',
        entity_id: sequence.id,
      });
      await sendCancellationSms(customer, body, { sequence_id: sequence.id, reply_action: 'accepted_offer' });

      await TwilioService.sendSMS(ADMIN_ALERT_PHONE,
        `SAVE WON: ${customer.first_name} ${customer.last_name} accepted the retention offer. Follow up to finalize.`,
        { messageType: 'admin_alert' }
      );

      return { action: 'accepted_offer' };
    }

    if (normalizedReply === '2') {
      await db('sms_sequences').where({ id: sequence.id }).update({ status: 'escalated' });

      await TwilioService.sendSMS(ADMIN_ALERT_PHONE,
        `CALLBACK REQUESTED: ${customer.first_name} ${customer.last_name} (${customer.phone}) wants to discuss cancellation.`,
        { messageType: 'admin_alert' }
      );

      const body = await renderRequiredSmsTemplate('cancellation_save_callback_requested', {
        first_name: customer.first_name || 'there',
      }, {
        workflow: 'cancellation_save_callback_requested',
        entity_type: 'sms_sequence',
        entity_id: sequence.id,
      });
      await sendCancellationSms(customer, body, { sequence_id: sequence.id, reply_action: 'callback_requested' });

      return { action: 'callback_requested' };
    }

    if (normalizedReply === 'cancel') {
      await db('sms_sequences').where({ id: sequence.id }).update({ status: 'cancelled' });

      const body = await renderRequiredSmsTemplate('cancellation_save_cancelled', {
        first_name: customer.first_name || 'there',
      }, {
        workflow: 'cancellation_save_cancelled',
        entity_type: 'sms_sequence',
        entity_id: sequence.id,
      });
      await sendCancellationSms(customer, body, { sequence_id: sequence.id, reply_action: 'cancelled' });

      return { action: 'cancelled' };
    }

    return { action: 'unrecognized', reply };
  }
}

module.exports = new CancellationSave();
