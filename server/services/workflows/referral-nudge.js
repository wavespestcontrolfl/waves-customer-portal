const db = require('../../models/db');
const TwilioService = require('../twilio');
const logger = require('../logger');

class ReferralNudge {
  /**
   * After a positive review (4-5 stars), wait 4 hours then send a
   * referral nudge with the customer's referral code + Google review link.
   */
  async triggerAfterPositiveReview(customerId, rating) {
    if (rating < 4) return null;

    const customer = await db('customers').where({ id: customerId }).first();
    if (!customer || !customer.phone) return null;

    // 90-day cooldown on referral nudges
    const recentNudge = await db('sms_log')
      .where({ customer_id: customerId, message_type: 'referral_nudge' })
      .where('created_at', '>', db.raw("NOW() - INTERVAL '90 days'"))
      .first();

    if (recentNudge) {
      logger.info(`Referral nudge skipped for customer ${customerId}: 90-day cooldown`);
      return null;
    }

    // Get or generate referral code
    let referral = await db('referrals')
      .where({ referrer_id: customerId })
      .first();

    const referralCode = referral?.referral_code || `WAVES-${customer.first_name.toUpperCase()}-${customerId}`;

    if (!referral) {
      await db('referrals').insert({
        referrer_id: customerId,
        referral_code: referralCode,
        status: 'active',
      });
    }

    // Schedule send after 4-hour delay
    const FOUR_HOURS = 4 * 60 * 60 * 1000;

    setTimeout(async () => {
      try {
        const body = `Hi ${customer.first_name}! Thanks for the amazing ${rating}-star review! ` +
          `Know someone who could use pest-free living? Share your code ${referralCode} — ` +
          `they get $25 off their first service, and you get a $25 credit! ` +
          `Also, if you have a moment, a Google review helps us a ton: ` +
          `https://g.page/r/wavespestcontrol/review\n` +
          `- Waves Pest Control`;

        await TwilioService.sendSMS(customer.phone, body, {
          customerId,
          messageType: 'referral_nudge',
          customerLocationId: customer.location_id,
        });

        await db('customer_interactions').insert({
          customer_id: customerId,
          type: 'sms_outbound',
          channel: 'sms',
          subject: 'Referral nudge after positive review',
          notes: `Triggered by ${rating}-star review, sent after 4h delay`,
        });

        logger.info(`Referral nudge sent to customer ${customerId} (${rating}-star review)`);
      } catch (err) {
        logger.error(`Referral nudge send failed for customer ${customerId}: ${err.message}`);
      }
    }, FOUR_HOURS);

    logger.info(`Referral nudge scheduled for customer ${customerId} in 4 hours`);
    return { scheduled: true, referralCode, delayMs: FOUR_HOURS };
  }
}

module.exports = new ReferralNudge();
