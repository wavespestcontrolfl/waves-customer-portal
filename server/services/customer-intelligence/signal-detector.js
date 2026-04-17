const db = require('../../models/db');
const logger = require('../logger');
const MODELS = require('../../config/models');

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
  CALLBACK_SINGLE: { weight: -5, severity: 'info' },
  CALLBACK_MULTIPLE: { weight: -15, severity: 'warning' },
  CALLBACK_PATTERN: { weight: -25, severity: 'critical' },
};

// ---------------------------------------------------------------------------
// AI Sentiment Mining
// ---------------------------------------------------------------------------
async function analyzeSentimentBatch(customerId) {
  const signals = [];
  try {
    // Throttle: only run for customers with recent inbound SMS in last 14 days
    const recentInbound = await db('sms_log')
      .where('customer_id', customerId)
      .where('direction', 'inbound')
      .where('created_at', '>', new Date(Date.now() - 14 * 86400000))
      .count('* as count').first();

    if (parseInt(recentInbound?.count || 0) === 0) return signals;

    // Get last 10 inbound SMS
    const smsMessages = await db('sms_log')
      .where('customer_id', customerId)
      .where('direction', 'inbound')
      .orderBy('created_at', 'desc')
      .limit(10)
      .select('message_body', 'created_at');

    // Get last 5 tech notes
    let techNotes = [];
    try {
      techNotes = await db('service_records')
        .where('customer_id', customerId)
        .whereNotNull('technician_notes')
        .where('technician_notes', '!=', '')
        .orderBy('service_date', 'desc')
        .limit(5)
        .select('technician_notes', 'service_date');
    } catch { /* technician_notes column may not exist */ }

    const smsText = smsMessages.map(m => m.message_body || '').filter(Boolean);
    const notesText = techNotes.map(n => n.technician_notes || '').filter(Boolean);

    if (smsText.length === 0 && notesText.length === 0) return signals;

    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic();

    const prompt = `Analyze the following customer communications for a pest control company. Return ONLY valid JSON, no other text.

SMS messages from customer (most recent first):
${smsText.map((t, i) => `${i + 1}. "${t}"`).join('\n')}

Technician notes about customer (most recent first):
${notesText.length > 0 ? notesText.map((t, i) => `${i + 1}. "${t}"`).join('\n') : 'None available'}

Detect these sentiment signals and rate confidence 0.0-1.0:
- frustration: customer seems frustrated/angry/annoyed
- treatment_ineffective: customer reports bugs still present, treatment not working
- price_complaint: customer mentions cost being too high, seeking cheaper options
- competitor_interest: customer mentions other pest control companies
- cancellation_intent: customer hints at or explicitly mentions cancelling/stopping service

Return JSON format:
{"signals": [{"type": "frustration", "confidence": 0.8, "evidence": "brief quote"}, ...]}
Only include signals you detect. Empty array if none found.`;

    const response = await client.messages.create({
      model: MODELS.FLAGSHIP,
      max_tokens: 500,
      messages: [{ role: 'user', content: prompt }],
    });

    const responseText = response.content[0]?.text || '{}';
    // Extract JSON from response (handle possible markdown wrapping)
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return signals;

    const parsed = JSON.parse(jsonMatch[0]);
    const aiSignals = parsed.signals || [];

    // Map AI types to existing signal types (only confidence >= 0.6)
    const typeMap = {
      frustration: 'COMPLAINT_FILED',
      treatment_ineffective: 'SERVICE_DECLINED',
      price_complaint: 'PRICE_COMPLAINT',
      competitor_interest: 'COMPETITOR_MENTIONED',
      cancellation_intent: 'DOWNGRADE_REQUEST',
    };

    const severityMap = {
      frustration: 'critical',
      treatment_ineffective: 'warning',
      price_complaint: 'warning',
      competitor_interest: 'critical',
      cancellation_intent: 'critical',
    };

    for (const sig of aiSignals) {
      if (sig.confidence >= 0.6 && typeMap[sig.type]) {
        signals.push({
          signal_type: typeMap[sig.type],
          signal_value: `AI detected: ${sig.type} (${Math.round(sig.confidence * 100)}% confidence) — ${sig.evidence || ''}`,
          severity: severityMap[sig.type] || 'warning',
        });
      }
    }
  } catch (err) {
    logger.debug(`[signal-detector] AI sentiment analysis failed for ${customerId}: ${err.message}`);
  }

  return signals;
}

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

    // ── Multiple Reschedules (30-day window, threshold 2) ─────────
    try {
      const thirtyDaysAgo = new Date(now - 30 * 86400000);

      // Count by status = 'rescheduled'
      const reschedulesByStatus = await db('scheduled_services')
        .where('customer_id', customerId)
        .where('status', 'rescheduled')
        .where('scheduled_date', '>', thirtyDaysAgo)
        .count('* as count').first();

      // Also count by notes containing reschedule/rain/pushed
      const reschedulesByNotes = await db('scheduled_services')
        .where('customer_id', customerId)
        .where('scheduled_date', '>', thirtyDaysAgo)
        .whereNot('status', 'rescheduled') // avoid double-counting
        .where(function() {
          this.where('notes', 'ilike', '%reschedule%')
            .orWhere('notes', 'ilike', '%rain%')
            .orWhere('notes', 'ilike', '%pushed%');
        })
        .count('* as count').first();

      const totalReschedules = parseInt(reschedulesByStatus?.count || 0) + parseInt(reschedulesByNotes?.count || 0);
      if (totalReschedules >= 2 && !existing.has('RESCHEDULE_MULTIPLE')) {
        newSignals.push({ signal_type: 'RESCHEDULE_MULTIPLE', signal_value: `${totalReschedules} reschedules in 30 days`, severity: 'warning' });
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

    // ── Callback Ratio Tracking ────────────────────────────────────
    try {
      const sixMonthsAgo = new Date(now - 180 * 86400000);
      const callbacks = await db('service_records')
        .where('customer_id', customerId)
        .where('service_date', '>', sixMonthsAgo)
        .where(function() {
          this.where('is_callback', true)
            .orWhere('service_type', 'ilike', '%callback%')
            .orWhere('service_type', 'ilike', '%re-service%');
        })
        .count('* as count').first();

      const callbackCount = parseInt(callbacks?.count || 0);
      if (callbackCount >= 3 && !existing.has('CALLBACK_PATTERN')) {
        newSignals.push({ signal_type: 'CALLBACK_PATTERN', signal_value: `${callbackCount} callbacks in 6 months — pattern detected`, severity: 'critical' });
      } else if (callbackCount >= 2 && !existing.has('CALLBACK_MULTIPLE')) {
        newSignals.push({ signal_type: 'CALLBACK_MULTIPLE', signal_value: `${callbackCount} callbacks in 6 months`, severity: 'warning' });
      } else if (callbackCount === 1 && !existing.has('CALLBACK_SINGLE')) {
        newSignals.push({ signal_type: 'CALLBACK_SINGLE', signal_value: '1 callback in 6 months', severity: 'info' });
      }
    } catch { /* service_records may not have is_callback column */ }

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

    // ── AI Sentiment Mining ────────────────────────────────────────
    try {
      const aiSignals = await analyzeSentimentBatch(customerId);
      for (const aiSig of aiSignals) {
        if (!existing.has(aiSig.signal_type)) {
          newSignals.push(aiSig);
        }
      }
    } catch (err) {
      logger.debug(`[signal-detector] AI sentiment step failed for ${customerId}: ${err.message}`);
    }

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
