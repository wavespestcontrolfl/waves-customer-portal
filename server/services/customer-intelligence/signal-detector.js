const db = require('../../models/db');
const logger = require('../logger');

const SIGNAL_TYPES = {
  PAYMENT_FAILED: { weight: -15, severity: 'warning' },
  PAYMENT_FAILED_TWICE: { weight: -25, severity: 'critical' },
  SERVICE_DECLINED: { weight: -20, severity: 'warning' },
  SERVICE_SKIPPED: { weight: -15, severity: 'warning' },
  SERVICE_NO_SHOW: { weight: -20, severity: 'warning' },
  RESCHEDULE_MULTIPLE: { weight: -10, severity: 'warning' },
  COMPLAINT_FILED: { weight: -20, severity: 'critical' },
  NO_RESPONSE_MULTIPLE: { weight: -15, severity: 'warning' },
  BALANCE_OVERDUE_30: { weight: -15, severity: 'warning' },
  BALANCE_OVERDUE_60: { weight: -25, severity: 'critical' },
  DOWNGRADE_REQUEST: { weight: -20, severity: 'critical' },
  COMPETITOR_MENTIONED: { weight: -25, severity: 'critical' },
  PRICE_COMPLAINT: { weight: -15, severity: 'warning' },
  SERVICE_GAP_30_DAYS: { weight: -10, severity: 'info' },
  SERVICE_GAP_60_DAYS: { weight: -20, severity: 'warning' },
  SERVICE_GAP_90_DAYS: { weight: -30, severity: 'critical' },
  PAYMENT_ON_TIME: { weight: +5, severity: 'info' },
  SERVICE_COMPLETED: { weight: +5, severity: 'info' },
  POSITIVE_REVIEW: { weight: +15, severity: 'info' },
  REFERRAL_GIVEN: { weight: +20, severity: 'info' },
  UPSELL_ACCEPTED: { weight: +15, severity: 'info' },
  SMS_ENGAGED: { weight: +5, severity: 'info' },
};

class SignalDetector {
  async detectAllSignals() {
    const customers = await db('customers').where('active', true).select('id');
    logger.info(`Signal detection: scanning ${customers.length} customers`);

    let totalNew = 0;
    for (const customer of customers) {
      const signals = await this.detectSignals(customer.id);
      totalNew += signals.length;
    }

    logger.info(`Signal detection complete: ${totalNew} new signals`);
    return { customersScanned: customers.length, newSignals: totalNew };
  }

  async detectSignals(customerId) {
    const now = new Date();
    const existingSignals = await db('customer_signals')
      .where('customer_id', customerId)
      .where('resolved', false)
      .select('signal_type');
    const existing = new Set(existingSignals.map(s => s.signal_type));

    const newSignals = [];

    // ── Payment Signals ──────────────────────────────────────────
    try {
      const failedPayments = await db('payments')
        .where('customer_id', customerId)
        .where('status', 'failed')
        .where('payment_date', '>', new Date(now - 60 * 86400000))
        .count('* as count').first();

      const failCount = parseInt(failedPayments?.count || 0);
      if (failCount >= 2 && !existing.has('PAYMENT_FAILED_TWICE')) {
        newSignals.push({ signal_type: 'PAYMENT_FAILED_TWICE', signal_value: `${failCount} failed payments in 60 days`, severity: 'critical' });
      } else if (failCount === 1 && !existing.has('PAYMENT_FAILED')) {
        newSignals.push({ signal_type: 'PAYMENT_FAILED', signal_value: 'Payment failed', severity: 'warning' });
      }
    } catch { /* payments table may not have data */ }

    // ── Service Gap Signals ──────────────────────────────────────
    try {
      const lastService = await db('service_records')
        .where('customer_id', customerId)
        .where('status', 'completed')
        .orderBy('service_date', 'desc')
        .first();

      if (lastService) {
        const daysSince = Math.floor((now - new Date(lastService.service_date)) / 86400000);
        if (daysSince > 90 && !existing.has('SERVICE_GAP_90_DAYS')) {
          newSignals.push({ signal_type: 'SERVICE_GAP_90_DAYS', signal_value: `${daysSince} days since last service`, severity: 'critical' });
        } else if (daysSince > 60 && !existing.has('SERVICE_GAP_60_DAYS')) {
          newSignals.push({ signal_type: 'SERVICE_GAP_60_DAYS', signal_value: `${daysSince} days since last service`, severity: 'warning' });
        } else if (daysSince > 30 && !existing.has('SERVICE_GAP_30_DAYS')) {
          newSignals.push({ signal_type: 'SERVICE_GAP_30_DAYS', signal_value: `${daysSince} days since last service`, severity: 'info' });
        }
      }
    } catch { /* */ }

    // ── Skipped/Cancelled Services ───────────────────────────────
    try {
      const skipped = await db('scheduled_services')
        .where('customer_id', customerId)
        .whereIn('status', ['skipped', 'cancelled'])
        .where('scheduled_date', '>', new Date(now - 90 * 86400000))
        .count('* as count').first();

      if (parseInt(skipped?.count || 0) >= 2 && !existing.has('SERVICE_SKIPPED')) {
        newSignals.push({ signal_type: 'SERVICE_SKIPPED', signal_value: `${skipped.count} skipped in 90 days`, severity: 'warning' });
      }
    } catch { /* */ }

    // ── Multiple Reschedules ─────────────────────────────────────
    try {
      const reschedules = await db('scheduled_services')
        .where('customer_id', customerId)
        .where('status', 'rescheduled')
        .where('scheduled_date', '>', new Date(now - 60 * 86400000))
        .count('* as count').first();

      if (parseInt(reschedules?.count || 0) >= 3 && !existing.has('RESCHEDULE_MULTIPLE')) {
        newSignals.push({ signal_type: 'RESCHEDULE_MULTIPLE', signal_value: `${reschedules.count} reschedules in 60 days`, severity: 'warning' });
      }
    } catch { /* */ }

    // ── Communication Signals ────────────────────────────────────
    try {
      const outbound = await db('sms_log')
        .where('customer_id', customerId)
        .where('direction', 'outbound')
        .where('created_at', '>', new Date(now - 30 * 86400000))
        .count('* as count').first();

      const inbound = await db('sms_log')
        .where('customer_id', customerId)
        .where('direction', 'inbound')
        .where('created_at', '>', new Date(now - 30 * 86400000))
        .count('* as count').first();

      if (parseInt(outbound?.count || 0) > 3 && parseInt(inbound?.count || 0) === 0 && !existing.has('NO_RESPONSE_MULTIPLE')) {
        newSignals.push({ signal_type: 'NO_RESPONSE_MULTIPLE', signal_value: `${outbound.count} outbound, 0 replies in 30 days`, severity: 'warning' });
      }
    } catch { /* */ }

    // ── Sentiment Signals from SMS ───────────────────────────────
    try {
      const recentMessages = await db('sms_log')
        .where('customer_id', customerId)
        .where('direction', 'inbound')
        .where('created_at', '>', new Date(now - 30 * 86400000))
        .select('message_body');

      const allText = recentMessages.map(m => (m.message_body || '').toLowerCase()).join(' ');

      if ((allText.includes('cancel') || allText.includes('stop service') || allText.includes('not renew')) && !existing.has('DOWNGRADE_REQUEST')) {
        newSignals.push({ signal_type: 'DOWNGRADE_REQUEST', signal_value: 'Cancellation language detected', severity: 'critical' });
      }
      if ((allText.includes('too expensive') || allText.includes('too much') || allText.includes('cheaper') || allText.includes("can't afford")) && !existing.has('PRICE_COMPLAINT')) {
        newSignals.push({ signal_type: 'PRICE_COMPLAINT', signal_value: 'Price sensitivity detected', severity: 'warning' });
      }
      if ((allText.includes('orkin') || allText.includes('terminix') || allText.includes('turner') || allText.includes('other company')) && !existing.has('COMPETITOR_MENTIONED')) {
        newSignals.push({ signal_type: 'COMPETITOR_MENTIONED', signal_value: 'Competitor mentioned', severity: 'critical' });
      }
    } catch { /* */ }

    // ── Positive: Recent completed service ───────────────────────
    try {
      const recentComplete = await db('service_records')
        .where('customer_id', customerId)
        .where('status', 'completed')
        .where('service_date', '>', new Date(now - 14 * 86400000))
        .count('* as count').first();

      if (parseInt(recentComplete?.count || 0) > 0 && !existing.has('SERVICE_COMPLETED')) {
        newSignals.push({ signal_type: 'SERVICE_COMPLETED', signal_value: 'Service completed recently', severity: 'info' });
      }
    } catch { /* */ }

    // Save new signals
    for (const signal of newSignals) {
      await db('customer_signals').insert({
        customer_id: customerId,
        ...signal,
        detected_at: new Date(),
      });
    }

    return newSignals;
  }
}

// Export both the class instance and SIGNAL_TYPES for use by health scorer
module.exports = new SignalDetector();
module.exports.SIGNAL_TYPES = SIGNAL_TYPES;
