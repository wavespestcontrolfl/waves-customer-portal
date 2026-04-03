const db = require('../../models/db');
const TwilioService = require('../twilio');
const logger = require('../logger');

class BalanceReminder {

  async dailyCheck() {
    const today = new Date().toISOString().split('T')[0];
    const day7 = new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0];

    const upcoming = await db('scheduled_services')
      .where('scheduled_date', '>=', today)
      .where('scheduled_date', '<=', day7)
      .whereIn('scheduled_services.status', ['pending', 'confirmed'])
      .leftJoin('customers', 'scheduled_services.customer_id', 'customers.id')
      .where('customers.active', true)
      .whereNotNull('customers.waveguard_tier')
      .select('scheduled_services.*', 'customers.id as cust_id', 'customers.first_name',
        'customers.last_name', 'customers.phone', 'customers.waveguard_tier',
        'customers.monthly_rate', 'customers.square_customer_id', 'customers.nearest_location_id');

    let sent = 0;
    for (const service of upcoming) {
      try {
        const balance = await this.getCustomerBalance(service.cust_id);
        if (!balance || balance.totalBalance <= 0) continue;

        const daysUntil = Math.floor((new Date(service.scheduled_date) - new Date()) / 86400000);

        const prevReminders = await db('sms_log')
          .where({ customer_id: service.cust_id, message_type: 'balance_reminder' })
          .where('created_at', '>', new Date(Date.now() - 14 * 86400000))
          .orderBy('created_at', 'desc');

        if (prevReminders.length >= 3) continue;
        if (prevReminders.some(r => new Date(r.created_at).toDateString() === new Date().toDateString())) continue;

        let tier;
        if (prevReminders.length === 0 && daysUntil > 3 && daysUntil <= 7) tier = 'gentle';
        else if (prevReminders.length <= 1 && daysUntil > 1 && daysUntil <= 3) tier = 'firm';
        else if (daysUntil <= 1) tier = 'urgent';
        else continue;

        await this.sendReminder(service, balance, tier, daysUntil);
        sent++;
      } catch (err) {
        logger.error(`Balance check failed for ${service.cust_id}: ${err.message}`);
      }
    }
    logger.info(`Balance reminder: checked ${upcoming.length} services, sent ${sent} reminders`);
  }

  async getCustomerBalance(customerId) {
    const outstanding = await db('payments')
      .where({ 'payments.customer_id': customerId })
      .whereIn('status', ['failed', 'upcoming'])
      .where('payment_date', '<', new Date().toISOString().split('T')[0])
      .orderBy('payment_date', 'asc');

    if (!outstanding.length) return null;

    const totalBalance = outstanding.reduce((sum, p) => sum + parseFloat(p.amount || 0), 0);
    const oldest = outstanding[0];
    const daysOverdue = Math.max(0, Math.floor((Date.now() - new Date(oldest.payment_date)) / 86400000));

    return {
      totalBalance,
      invoiceCount: outstanding.length,
      oldestInvoiceUrl: `${process.env.CLIENT_URL || 'https://portal.wavespestcontrol.com'}/pay/${customerId}`,
      oldestDueDate: oldest.payment_date,
      daysOverdue,
    };
  }

  async sendReminder(service, balance, tier, daysUntil) {
    const datePretty = new Date(service.scheduled_date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
    const amt = balance.totalBalance.toFixed(2);
    const link = balance.oldestInvoiceUrl;

    const messages = {
      gentle: `Hello ${service.first_name}! Waves here. We're scheduled to see you on ${datePretty}.\n\nOur records show an outstanding balance of $${amt} on your account. To avoid any interruption in service, please take care of it before your appointment: ${link}`,
      firm: `Hi ${service.first_name}, quick reminder from Waves — your ${service.service_type || 'service'} is ${daysUntil === 1 ? 'tomorrow' : `in ${daysUntil} days`} and there's a $${amt} balance.\n\nPlease take care of it so we can keep you on schedule: ${link}\n\nIf there's an issue, just reply. — Waves`,
      urgent: `${service.first_name}, your Waves service is ${daysUntil === 0 ? 'today' : 'tomorrow'} and your account has a $${amt} outstanding balance.\n\nPay now to keep your appointment: ${link}\n\nAlready paid? Disregard — may take a few hours to process. — Waves`,
    };

    await TwilioService.sendSMS(service.phone, messages[tier], {
      customerId: service.cust_id, messageType: 'balance_reminder',
    });

    await db('customer_interactions').insert({
      customer_id: service.cust_id, interaction_type: 'sms_outbound',
      subject: `Balance reminder (${tier}) — $${amt}`,
      body: `Sent ${tier} reminder. Balance: $${amt}. Service: ${datePretty}. Days until: ${daysUntil}.`,
      metadata: JSON.stringify({ tier, balance: balance.totalBalance, daysUntil, daysOverdue: balance.daysOverdue }),
    });

    if (balance.daysOverdue >= 30 && tier === 'urgent') {
      await TwilioService.sendSMS(process.env.ADAM_PHONE || '+19413187612',
        `💰 Overdue: ${service.first_name} ${service.last_name} — $${amt} (${balance.daysOverdue} days). Service ${daysUntil === 0 ? 'today' : 'tomorrow'}.`,
        { messageType: 'internal_alert' }
      );
    }
  }

  async latePaymentCheck() {
    const customers = await db('customers')
      .where({ active: true })
      .whereNotNull('waveguard_tier');

    let sent = 0;
    for (const customer of customers) {
      const balance = await this.getCustomerBalance(customer.id);
      if (!balance || balance.totalBalance <= 0 || balance.daysOverdue < 7) continue;

      const prevCount = await db('sms_log')
        .where({ customer_id: customer.id, message_type: 'late_payment' })
        .where('created_at', '>', new Date(Date.now() - 90 * 86400000))
        .count('* as count').first();
      const count = parseInt(prevCount?.count || 0);

      const sentRecently = await db('sms_log')
        .where({ customer_id: customer.id, message_type: 'late_payment' })
        .where('created_at', '>', new Date(Date.now() - 7 * 86400000)).first();
      if (sentRecently) continue;

      const amt = balance.totalBalance.toFixed(2);
      const link = balance.oldestInvoiceUrl;
      let message;

      if (balance.daysOverdue >= 7 && balance.daysOverdue < 14 && count === 0) {
        message = `Hi ${customer.first_name}! Friendly reminder from Waves — you have a balance of $${amt} that's a few days past due. Tap to pay: ${link}\n\nAlready paid? Disregard! — Waves`;
      } else if (balance.daysOverdue >= 14 && balance.daysOverdue < 30 && count <= 1) {
        message = `${customer.first_name}, your Waves balance of $${amt} is ${balance.daysOverdue} days past due. Please take care of it: ${link}\n\nIssue? Just reply. — Waves`;
      } else if (balance.daysOverdue >= 30 && balance.daysOverdue < 45 && count <= 2) {
        message = `${customer.first_name}, your balance of $${amt} is 30+ days past due. To keep your WaveGuard ${customer.waveguard_tier} active: ${link}\n\nNeed a payment plan? Reply. — Adam, Waves`;
      } else if (balance.daysOverdue >= 45 && balance.daysOverdue < 60 && count <= 3) {
        message = `${customer.first_name}, your Waves account is significantly past due ($${amt}, ${balance.daysOverdue} days). Service may pause after 60 days. Pay now: ${link}\n\nReply or call to discuss. — Adam`;
      } else if (balance.daysOverdue >= 60 && count <= 4) {
        message = `${customer.first_name}, final notice — $${amt} outstanding. Service paused due to balance. Pay to reactivate: ${link}\n\nCall (941) 318-7612. — Adam`;
        await db('customers').where({ id: customer.id }).update({ pipeline_stage: 'at_risk', pipeline_stage_changed_at: new Date() });
      } else continue;

      if (message) {
        await TwilioService.sendSMS(customer.phone, message, { customerId: customer.id, messageType: 'late_payment' });
        await db('customer_interactions').insert({
          customer_id: customer.id, interaction_type: 'sms_outbound',
          subject: `Late payment tier ${count + 1} — ${balance.daysOverdue} days`,
          body: `$${amt} overdue ${balance.daysOverdue} days. Tier ${count + 1} sent.`,
        });
        sent++;
      }
    }
    logger.info(`Late payment check: sent ${sent} reminders`);
  }

  async onPaymentReceived(customerId, amount) {
    const customer = await db('customers').where({ id: customerId }).first();
    if (!customer) return;

    const recentReminder = await db('sms_log')
      .where({ customer_id: customerId })
      .whereIn('message_type', ['balance_reminder', 'late_payment'])
      .where('created_at', '>', new Date(Date.now() - 7 * 86400000)).first();

    if (recentReminder) {
      await TwilioService.sendSMS(customer.phone,
        `${customer.first_name}, got it — thank you for the payment! Your account is all caught up. See you at your next service. — Waves 🌊`,
        { customerId, messageType: 'confirmation' }
      );
    }

    if (customer.pipeline_stage === 'at_risk') {
      const remaining = await this.getCustomerBalance(customerId);
      if (!remaining || remaining.totalBalance <= 0) {
        await db('customers').where({ id: customerId }).update({ pipeline_stage: 'active_customer', pipeline_stage_changed_at: new Date() });
      }
    }
  }
}

module.exports = new BalanceReminder();
