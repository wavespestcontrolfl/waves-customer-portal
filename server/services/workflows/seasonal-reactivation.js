const db = require('../../models/db');
const TwilioService = require('../twilio');
const TWILIO_NUMBERS = require('../../config/twilio-numbers');
const logger = require('../logger');

const SEASONAL_HOOKS = {
  // month index (0-based) → hooks
  0: { type: 'general', hook: 'Start the new year pest-free!' },
  1: { type: 'general', hook: 'Valentine\'s gift idea: a bug-free home' },
  2: { type: 'lawn', hook: 'Spring is here — time for pre-emergent lawn treatment' },
  3: { type: 'mosquito', hook: 'Mosquito season is starting — protect your yard now' },
  4: { type: 'mosquito', hook: 'Peak mosquito season is here. Don\'t let them take over' },
  5: { type: 'pest', hook: 'Summer bugs are out in force. Let us handle them' },
  6: { type: 'pest', hook: 'Mid-summer pest pressure is at its peak' },
  7: { type: 'pest', hook: 'Back-to-school? Make sure pests don\'t follow the kids inside' },
  8: { type: 'pest', hook: 'Fall pests are looking for warm places — like your home' },
  9: { type: 'lawn', hook: 'Fall is the perfect time for lawn recovery treatment' },
  10: { type: 'general', hook: 'Holiday prep starts with a pest-free home' },
  11: { type: 'general', hook: 'End the year right — schedule your winter treatment' },
};

class SeasonalReactivation {
  /**
   * Target dormant, at-risk, or churned customers with seasonal messaging.
   */
  async run() {
    const month = new Date().getMonth();
    const seasonal = SEASONAL_HOOKS[month];

    // Find customers not contacted in 30+ days with inactive statuses
    const customers = await db('customers')
      .whereIn('status', ['dormant', 'at_risk', 'churned', 'inactive'])
      .whereNotNull('phone')
      .where(function () {
        this.where('last_contact_date', '<', db.raw("NOW() - INTERVAL '30 days'"))
          .orWhereNull('last_contact_date');
      })
      .select('id', 'first_name', 'phone', 'nearest_location_id as location_id', 'address_line1 as address');

    let sent = 0;

    for (const customer of customers) {
      try {
        // Check if customer has history matching the seasonal hook type
        let hookText = seasonal.hook;
        if (seasonal.type !== 'general') {
          const matchingService = await db('service_records')
            .where({ customer_id: customer.id })
            .where('service_type', 'ilike', `%${seasonal.type}%`)
            .first();

          // Fall back to general if no matching service history
          if (!matchingService) {
            hookText = 'We haven\'t seen you in a while — let\'s get your home protected';
          }
        }

        const locationPhone = TWILIO_NUMBERS.getOutboundNumber(customer.location_id);
        const locationInfo = TWILIO_NUMBERS.findByNumber(locationPhone);
        const callNumber = locationInfo?.formatted || '(941) 318-7612';

        const body = `Hi ${customer.first_name}! ${hookText}. ` +
          `We'd love to get you back on the schedule` +
          `${customer.address ? ` at ${customer.address}` : ''}. ` +
          `Reply YES or call ${callNumber} to book. - Waves Pest Control`;

        await TwilioService.sendSMS(customer.phone, body, {
          customerId: customer.id,
          messageType: 'reactivation',
          customerLocationId: customer.location_id,
        });

        await db('customer_interactions').insert({
          customer_id: customer.id,
          type: 'sms_outbound',
          channel: 'sms',
          subject: `Seasonal reactivation — ${seasonal.type}`,
          notes: `Auto reactivation: ${hookText}`,
        });

        // Update last contact date
        await db('customers').where({ id: customer.id })
          .update({ last_contact_date: new Date() });

        sent++;
      } catch (err) {
        logger.error(`Reactivation failed for customer ${customer.id}: ${err.message}`);
      }
    }

    logger.info(`Seasonal reactivation: ${sent} messages sent (month ${month})`);
    return { sent, month, hookType: seasonal.type };
  }
}

module.exports = new SeasonalReactivation();
