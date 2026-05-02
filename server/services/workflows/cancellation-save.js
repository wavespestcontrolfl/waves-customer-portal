const db = require('../../models/db');
const TwilioService = require('../twilio');
const logger = require('../logger');
const { sendCustomerMessage } = require('../messaging/send-customer-message');

const WAVES_ADMIN_PHONE = '+19413187612';

const REASON_OFFERS = {
  price: {
    empathy: 'We totally understand — budgets matter.',
    offer: 'We can review lower-cost plan options with core coverage. Reply 1 to switch, 2 to discuss options.',
  },
  moving: {
    empathy: 'Moving is stressful — we get it!',
    offer: 'Great news: we serve most of SW Florida. Reply 1 if you\'d like us to transfer service to your new address, 2 to chat about it.',
  },
  quality: {
    empathy: 'We\'re sorry to hear that. Your satisfaction means everything to us.',
    offer: 'We\'d love a chance to make it right. Reply 1 to schedule a free callback with our service manager, 2 to discuss.',
  },
  default: {
    empathy: 'We\'re sorry to see you thinking about leaving.',
    offer: 'We\'d love to find a way to keep you. Reply 1 for a special retention offer, 2 to talk to someone.',
  },
};

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

    const reason = REASON_OFFERS[cancelReason] || REASON_OFFERS.default;

    // Create sequence record to track progress
    const [sequence] = await db('sms_sequences').insert({
      customer_id: customerId,
      sequence_type: 'cancellation_save',
      status: 'active',
      current_step: 1,
      total_steps: 3,
      metadata: JSON.stringify({ cancelReason, startedAt: new Date().toISOString() }),
    }).returning('*');

    // Step 1 — Immediate empathy message
    const step1Body = `Hi ${customer.first_name}, ${reason.empathy} ` +
      `We've been proud to keep your home protected and we don't want to lose you. ` +
      `We'll follow up with some options shortly. - Waves Pest Control`;

    await sendCancellationSms(customer, step1Body, { sequence_id: sequence.id, step: 1 });

    // Notify Adam immediately
    await TwilioService.sendSMS(WAVES_ADMIN_PHONE,
      `CANCELLATION ALERT: ${customer.first_name} ${customer.last_name} ` +
      `(ID: ${customerId}) wants to cancel. Reason: ${cancelReason}. ` +
      `Save sequence started.`,
      { messageType: 'admin_alert' }
    );

    // Step 2 — 24h delay: offer message
    const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;
    setTimeout(async () => {
      try {
        const seq = await db('sms_sequences').where({ id: sequence.id }).first();
        if (!seq || seq.status !== 'active') return;

        const step2Body = `Hi ${customer.first_name}, ${reason.offer}\n` +
          `Reply CANCEL if you still want to proceed. - Waves Pest Control`;

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

        const step3Body = `Hi ${customer.first_name}, just wanted you to know — the door is always open. ` +
          `If you ever want to come back, we'll waive the setup fee and get you protected right away. ` +
          `We're here when you need us. - Waves Pest Control`;

        const result = await sendCancellationSms(customer, step3Body, { sequence_id: sequence.id, step: 3 });
        if (!result.sent) return;

        await db('sms_sequences').where({ id: sequence.id })
          .update({ current_step: 3, status: 'completed' });
      } catch (err) {
        logger.error(`Cancellation save step 3 failed for ${customerId}: ${err.message}`);
      }
    }, SEVENTY_TWO_HOURS);

    logger.info(`Cancellation save initiated for customer ${customerId} (reason: ${cancelReason})`);
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

      await sendCancellationSms(customer,
        `Awesome, ${customer.first_name}! We're so glad you're staying. ` +
        `Someone from our team will reach out within 24 hours to get you set up. - Waves Pest Control`,
        { sequence_id: sequence.id, reply_action: 'accepted_offer' }
      );

      await TwilioService.sendSMS(WAVES_ADMIN_PHONE,
        `SAVE WON: ${customer.first_name} ${customer.last_name} accepted the retention offer. Follow up to finalize.`,
        { messageType: 'admin_alert' }
      );

      return { action: 'accepted_offer' };
    }

    if (normalizedReply === '2') {
      await db('sms_sequences').where({ id: sequence.id }).update({ status: 'escalated' });

      await TwilioService.sendSMS(WAVES_ADMIN_PHONE,
        `CALLBACK REQUESTED: ${customer.first_name} ${customer.last_name} (${customer.phone}) wants to discuss cancellation.`,
        { messageType: 'admin_alert' }
      );

      await sendCancellationSms(customer,
        `Thanks ${customer.first_name}! We'll have someone call you within a few hours. - Waves Pest Control`,
        { sequence_id: sequence.id, reply_action: 'callback_requested' }
      );

      return { action: 'callback_requested' };
    }

    if (normalizedReply === 'cancel') {
      await db('sms_sequences').where({ id: sequence.id }).update({ status: 'cancelled' });

      await sendCancellationSms(customer,
        `We're sorry to see you go, ${customer.first_name}. Your service has been cancelled. ` +
        `Remember, the door's always open if you need us. - Waves Pest Control`,
        { sequence_id: sequence.id, reply_action: 'cancelled' }
      );

      return { action: 'cancelled' };
    }

    return { action: 'unrecognized', reply };
  }
}

module.exports = new CancellationSave();
