const db = require('../../models/db');
const logger = require('../logger');
const { sendCustomerMessage } = require('../messaging/send-customer-message');

class PaymentExpiry {
  /**
   * Check for credit cards expiring this month or next month.
   * Notify customers via SMS and create dashboard alerts.
   */
  async checkExpiringCards() {
    const now = new Date();
    const thisMonth = now.getMonth() + 1; // 1-based
    const thisYear = now.getFullYear();

    // Next month (handle December → January rollover)
    const nextMonth = thisMonth === 12 ? 1 : thisMonth + 1;
    const nextYear = thisMonth === 12 ? thisYear + 1 : thisYear;

    // Query payment methods expiring this month or next
    const expiringCards = await db('payment_methods')
      .where(function () {
        this.where({ exp_month: thisMonth, exp_year: thisYear })
          .orWhere({ exp_month: nextMonth, exp_year: nextYear });
      })
      .whereNotNull('customer_id')
      .select('id', 'customer_id', 'last_four', 'exp_month', 'exp_year', 'card_brand');

    let notified = 0;

    for (const card of expiringCards) {
      try {
        const customer = await db('customers').where({ id: card.customer_id }).first();
        if (!customer || !customer.phone) continue;

        // 30-day cooldown per customer
        const recentNotice = await db('sms_log')
          .where({ customer_id: card.customer_id, message_type: 'payment_expiry' })
          .where('created_at', '>', db.raw("NOW() - INTERVAL '30 days'"))
          .first();

        if (recentNotice) continue;

        const expLabel = `${String(card.exp_month).padStart(2, '0')}/${card.exp_year}`;
        const brandLabel = card.card_brand ? `${card.card_brand} ` : '';

        const body = `Hi ${customer.first_name}, your ${brandLabel}card ending in ${card.last_four} ` +
          `expires ${expLabel}. Please update your payment method in your customer portal ` +
          `to avoid any interruption in service. ` +
          `Need help? Reply to this text. - Waves Pest Control`;

        const sendResult = await sendCustomerMessage({
          to: customer.phone,
          body,
          channel: 'sms',
          audience: 'customer',
          purpose: 'autopay',
          customerId: card.customer_id,
          entryPoint: 'payment_expiry_workflow',
          metadata: {
            original_message_type: 'payment_expiry',
            customerLocationId: customer.location_id,
          },
        });
        if (sendResult.blocked || sendResult.sent === false) {
          throw new Error(`payment expiry SMS blocked: ${sendResult.code || sendResult.reason || 'unknown'}`);
        }

        // Create inventory_alerts entry for dashboard visibility
        await db('inventory_alerts').insert({
          alert_type: 'payment_expiry',
          severity: card.exp_month === thisMonth && card.exp_year === thisYear ? 'high' : 'medium',
          title: `Card expiring: ${customer.first_name} ${customer.last_name}`,
          description: `${brandLabel}****${card.last_four} expires ${expLabel}`,
          reference_id: card.customer_id,
          reference_type: 'customer',
          status: 'active',
        });

        await db('customer_interactions').insert({
          customer_id: card.customer_id,
          type: 'sms_outbound',
          channel: 'sms',
          subject: 'Payment method expiry notice',
          notes: `Card ****${card.last_four} expires ${expLabel}`,
        });

        notified++;
      } catch (err) {
        logger.error(`Payment expiry check failed for card ${card.id}: ${err.message}`);
      }
    }

    logger.info(`Payment expiry: ${notified} customers notified, ${expiringCards.length} cards found`);
    return { notified, totalExpiring: expiringCards.length };
  }
}

module.exports = new PaymentExpiry();
