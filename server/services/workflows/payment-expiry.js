const db = require('../../models/db');
const logger = require('../logger');
const { sendCustomerMessage } = require('../messaging/send-customer-message');
const { renderSmsTemplate } = require('../sms-template-renderer');
const PaymentLifecycleEmail = require('../payment-lifecycle-email');

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

    // Query payment methods expiring this month or next.
    // Scope: live Stripe rows for customers we still serve — the unfiltered
    // version texted churned/deleted customers about dead cards (and legacy
    // Square rows). Former stages are excluded even when the active flag is
    // stale; a NULL pipeline_stage (legacy rows) stays included. exp_* are
    // varchar and legacy rows hold 2-digit years — compare via guarded
    // casts (CASE evaluates THEN only after the WHEN regexes pass, so a
    // non-numeric value never reaches ::integer), normalizing years < 100
    // by +2000 like the charge path does.
    const { FORMER_CUSTOMER_STAGES } = require('../customer-stages');
    const expiringCards = await db('payment_methods as pm')
      .join('customers as c', 'pm.customer_id', 'c.id')
      .where('pm.processor', 'stripe')
      .where('c.active', true)
      .whereNull('c.deleted_at')
      .where(function () {
        this.whereNull('c.pipeline_stage')
          .orWhereNotIn('c.pipeline_stage', [...FORMER_CUSTOMER_STAGES, 'lost']);
      })
      // Lead-stage rows (customers.active defaults TRUE for CRM leads) only
      // get expiry notices when a real payment relationship exists — the
      // stuck-at-new_lead PAYER gap is documented in customer-stages.js,
      // but a pure lead with a saved card must not be texted about billing
      // (hook r5 P1).
      .where(function () {
        this.whereIn('c.pipeline_stage', ['active_customer', 'won', 'at_risk'])
          .orWhereExists(function () {
            this.select(db.raw('1')).from('payments as p')
              .whereRaw('p.customer_id = c.id')
              .where('p.status', 'paid');
          });
      })
      .whereRaw(
        `CASE
           WHEN NULLIF(BTRIM(pm.exp_month), '') ~ '^[0-9]{1,2}$'
             AND NULLIF(BTRIM(pm.exp_year), '') ~ '^([0-9]{2}|[0-9]{4})$'
           THEN (
             (CASE WHEN NULLIF(BTRIM(pm.exp_year), '')::integer < 100
                   THEN NULLIF(BTRIM(pm.exp_year), '')::integer + 2000
                   ELSE NULLIF(BTRIM(pm.exp_year), '')::integer END,
              NULLIF(BTRIM(pm.exp_month), '')::integer) IN ((?, ?), (?, ?))
           )
           ELSE FALSE
         END`,
        [thisYear, thisMonth, nextYear, nextMonth],
      )
      .select('pm.id', 'pm.customer_id', 'pm.last_four', 'pm.exp_month', 'pm.exp_year', 'pm.card_brand');

    let notified = 0;

    for (const card of expiringCards) {
      try {
        const customer = await db('customers').where({ id: card.customer_id }).first();
        if (!customer) continue;

        const emailPromise = PaymentLifecycleEmail.sendPaymentMethodExpiring({
          customerId: card.customer_id,
          paymentMethodId: card.id,
          now,
        }).catch((emailErr) => {
          logger.warn(`Payment expiry email failed for card ${card.id}: ${emailErr.message}`);
        });

        if (!customer.phone) { await emailPromise; continue; }

        // 30-day cooldown per customer
        const recentNotice = await db('sms_log')
          .where({ customer_id: card.customer_id, message_type: 'payment_expiry' })
          .where('created_at', '>', db.raw("NOW() - INTERVAL '30 days'"))
          .first();

        if (recentNotice) { await emailPromise; continue; }

        const expLabel = `${String(card.exp_month).padStart(2, '0')}/${card.exp_year}`;
        const brandLabel = card.card_brand ? `${card.card_brand} ` : '';
        const cardLabel = card.card_brand ? `${card.card_brand} card` : 'card';

        const body = await renderSmsTemplate(
          'payment_method_expiry',
          {
            first_name: customer.first_name || 'there',
            card_brand: (card.card_brand || 'payment').trim(),
            last_four: card.last_four,
            exp_date: expLabel,
          },
          { workflow: 'payment_method_expiry', entity_type: 'payment_method', entity_id: card.id || card.payment_method_id }
        );

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
          interaction_type: 'sms_outbound',
          channel: 'sms',
          subject: 'Payment method expiry notice',
          body: `Card ****${card.last_four} expires ${expLabel}`,
        });

        await emailPromise;
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
