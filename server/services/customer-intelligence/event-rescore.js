const db = require('../../models/db');
const logger = require('../logger');
const SignalDetector = require('./signal-detector');
const customerHealth = require('../customer-health');

// Event-driven (near-real-time) health rescore.
//
// The nightly Customer Intelligence Pipeline scores every customer once at 3 AM
// ET. That means a hot inbound signal — a customer texting about a competitor,
// a cancellation, or a price complaint — can sit up to ~24h before it moves the
// score and the owner hears about it. This module lets a single hot event
// rescore THAT one customer within seconds and alert the owner the moment they
// cross into critical.
//
// Gated behind GATE_EVENT_RESCORE (fail-closed): when unset/!= 'true' this is a
// no-op and behavior is exactly the nightly-only path.

function gateOn() {
  return process.env.GATE_EVENT_RESCORE === 'true';
}

// Rescore one customer in response to a hot inbound event (currently an inbound
// SMS). Detects fresh signals for the customer so the score reflects this
// event, rescores via the canonical engine, and alerts the owner on a
// transition INTO critical. Designed to be called fire-and-forget — it never
// throws.
async function rescoreOnInboundMessage(customerId, { source = 'inbound' } = {}) {
  if (!gateOn() || !customerId) return null;

  try {
    // Risk before this event, to detect a crossing into critical.
    let priorRisk = null;
    try {
      const prior = await db('customer_health_scores')
        .where('customer_id', customerId)
        .orderByRaw('scored_at DESC NULLS LAST')
        .first();
      priorRisk = prior?.churn_risk || null;
    } catch { /* table may not exist yet */ }

    // Detect fresh signals for this customer (keyword + AI sentiment on recent
    // inbound SMS) so the rescore folds in whatever just arrived. Non-fatal.
    try {
      await SignalDetector.detectSignals(customerId);
    } catch (err) {
      logger.debug(`[event-rescore] signal detect failed for ${customerId}: ${err.message}`);
    }

    const result = await customerHealth.scoreCustomer(customerId);
    if (!result) return null;

    // Alert the owner ONLY on a transition into critical — fires once when the
    // customer crosses the line, not on every subsequent message while already
    // critical (the nightly pipeline does not call this path, so it can't
    // double-fire the live alert).
    if (result.churnRisk === 'critical' && priorRisk !== 'critical') {
      await sendCriticalChurnAlert(customerId, result, source);
    }

    return result;
  } catch (err) {
    logger.error(`[event-rescore] rescore failed for ${customerId}: ${err.message}`);
    return null;
  }
}

// Owner SMS the instant a customer drops to critical. Mirrors the nightly
// churn-alert format (retention-engine) but marked "(live)" and carrying no
// outreach draft — it is an immediate heads-up, not the morning action plan.
async function sendCriticalChurnAlert(customerId, result, source = 'inbound') {
  const adamPhone = process.env.ADAM_PHONE;
  if (!adamPhone) return;

  try {
    const customer = await db('customers').where('id', customerId).first();
    if (!customer) return;

    const TwilioService = require('../twilio');
    const top = (result.churnSignals || [])[0];
    const trigger = top?.value || top?.message || top?.signal || 'Multiple signals';
    const rate = customer.monthly_rate ? `$${customer.monthly_rate}/mo` : '';
    const name = `${customer.first_name || ''} ${customer.last_name || ''}`.trim() || 'Customer';

    const body = `🚨 CHURN ALERT (live): ${name} (${customer.waveguard_tier || '—'} ${rate})\n`
      + `Health just dropped to CRITICAL — ${result.overall}/100\n`
      + `Trigger: ${trigger}\n`
      + `📞 ${customer.phone || 'no phone on file'}`;

    await TwilioService.sendSMS(adamPhone, body, { messageType: 'internal_alert' });
    logger.info(`[event-rescore] live churn alert sent for ${customerId} (source: ${source})`);
  } catch (err) {
    logger.error(`[event-rescore] critical alert failed for ${customerId}: ${err.message}`);
  }
}

module.exports = { rescoreOnInboundMessage, sendCriticalChurnAlert, gateOn };
