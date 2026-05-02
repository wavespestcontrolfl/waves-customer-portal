const db = require('../../models/db');
const logger = require('../logger');
const { sendCustomerMessage } = require('../messaging/send-customer-message');

class RenewalReminder {
  /**
   * Check all customers for upcoming renewal dates and send reminders
   * at 30, 15, and 7 days out. Skips if already sent within 35 days.
   */
  async checkAndSend() {
    const renewalFields = [
      { column: 'termite_renewal_date', label: 'Termite Bond Renewal' },
      { column: 'mosquito_season_start', label: 'Mosquito Season' },
      { column: 'waveguard_renewal_date', label: 'WaveGuard Plan Renewal' },
    ];

    let totalSent = 0;

    for (const field of renewalFields) {
      for (const daysOut of [30, 15, 7]) {
        const targetDate = new Date();
        targetDate.setDate(targetDate.getDate() + daysOut);
        const dateStr = targetDate.toISOString().split('T')[0];

        const customers = await db('customers')
          .whereNotNull(field.column)
          .whereRaw(`DATE(${field.column}) = ?`, [dateStr])
          .whereNotNull('phone')
          .select('id', 'first_name', 'phone', 'nearest_location_id as location_id', field.column);

        for (const customer of customers) {
          try {
            // Check cooldown — skip if renewal SMS sent in last 35 days
            const recent = await db('sms_log')
              .where({ customer_id: customer.id, message_type: 'renewal' })
              .where('created_at', '>', db.raw("NOW() - INTERVAL '35 days'"))
              .first();

            if (recent) continue;

            const urgency = daysOut === 7 ? 'expires in just 1 week'
              : daysOut === 15 ? 'is coming up in 2 weeks'
              : 'is approaching in 30 days';

            const body = `Hi ${customer.first_name}! Your ${field.label} ${urgency}. ` +
              `Don't let your coverage lapse — reply RENEW or call us to take care of it. ` +
              `- Waves Pest Control`;

            const smsResult = await sendCustomerMessage({
              to: customer.phone,
              body,
              channel: 'sms',
              audience: 'customer',
              purpose: 'retention',
              customerId: customer.id,
              identityTrustLevel: 'phone_matches_customer',
              entryPoint: 'renewal_reminder',
              consentBasis: {
                status: 'opted_in',
                source: 'customer_retention_preferences',
                capturedAt: customer.updated_at || customer.created_at || new Date().toISOString(),
              },
              metadata: {
                original_message_type: 'renewal',
                customerLocationId: customer.location_id,
                renewal_field: field.column,
                days_out: daysOut,
              },
            });
            if (!smsResult.sent) {
              logger.warn(`Renewal reminder blocked/failed for customer ${customer.id}: ${smsResult.code || smsResult.reason || 'unknown'}`);
              continue;
            }

            await db('customer_interactions').insert({
              customer_id: customer.id,
              type: 'sms_outbound',
              channel: 'sms',
              subject: `${field.label} — ${daysOut}-day reminder`,
              notes: `Automated renewal reminder sent (${daysOut} days out)`,
            });

            totalSent++;
          } catch (err) {
            logger.error(`Renewal reminder failed for customer ${customer.id}: ${err.message}`);
          }
        }
      }
    }

    logger.info(`Renewal reminders: ${totalSent} sent`);
    return { sent: totalSent };
  }
}

module.exports = new RenewalReminder();
