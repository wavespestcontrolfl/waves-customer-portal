const db = require('../../models/db');
const logger = require('../logger');
const { sendCustomerMessage } = require('../messaging/send-customer-message');
const { renderSmsTemplate } = require('../sms-template-renderer');

class RenewalReminder {
  /**
   * Check all customers for upcoming renewal dates and send reminders
   * at 30, 15, and 7 days out. Skips if already sent within 35 days.
   */
  async checkAndSend() {
    let annualPrepaySent = 0;
    let annualPrepay = null;
    try {
      annualPrepay = require('../annual-prepay-renewals');
      if (annualPrepay.checkAndSend) {
        const result = await annualPrepay.checkAndSend();
        annualPrepaySent = Number(result?.sent || 0);
      }
    } catch (err) {
      logger.error(`Annual prepay renewal reminder failed: ${err.message}`);
    }

    const renewalFields = [
      { column: 'termite_renewal_date', label: 'Termite Bond Renewal' },
      { column: 'mosquito_season_start', label: 'Mosquito Season' },
      { column: 'waveguard_renewal_date', label: 'WaveGuard Plan Renewal' },
    ];

    let totalSent = annualPrepaySent;

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
            if (
              field.column === 'waveguard_renewal_date'
              && annualPrepay?.hasAnnualPrepayRenewal
              && await annualPrepay.hasAnnualPrepayRenewal(customer.id, dateStr)
            ) {
              continue;
            }

            // Check cooldown — skip if renewal SMS sent in last 35 days
            const recent = await db('sms_log')
              .where({ customer_id: customer.id, message_type: 'renewal' })
              .where('created_at', '>', db.raw("NOW() - INTERVAL '35 days'"))
              .first();

            if (recent) continue;

            const urgency = daysOut === 7 ? 'expires in just 1 week'
              : daysOut === 15 ? 'is coming up in 2 weeks'
              : 'is approaching in 30 days';

            const body = await renderSmsTemplate(
              'renewal_reminder',
              {
                first_name: customer.first_name || 'there',
                renewal_label: field.label,
                urgency,
              },
              { workflow: 'renewal_reminder', entity_type: 'customer', entity_id: customer.id }
            );
            if (!body) {
              logger.warn(`[renewal-reminder] template missing/disabled — skipping customer ${customer.id} (${field.column})`);
              continue;
            }

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
              interaction_type: 'sms_outbound',
              channel: 'sms',
              subject: `${field.label} — ${daysOut}-day reminder`,
              body: `Automated renewal reminder sent (${daysOut} days out)`,
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
