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
    // Risk BEFORE this event. This distinguishes a real crossing into critical
    // from a customer who was ALREADY critical — via nightly/Stripe scoring
    // (which don't run this path) or before this feature was enabled. Without
    // it, an already-critical customer's next text would falsely alert "just
    // dropped to CRITICAL".
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

    // Alert the owner once on a real crossing into critical. Guards:
    //  - priorRisk !== 'critical' — it's an actual transition, not an
    //    already-critical customer (nightly/Stripe/pre-enable);
    //  - ADAM_PHONE present — checked BEFORE claiming so a missing recipient
    //    (alerts disabled) doesn't permanently burn the claim;
    //  - claimCriticalAlert() — ATOMIC, so two concurrent inbound texts that
    //    both observe a non-critical prior can't both alert: exactly one wins
    //    the `critical_alert_sent_at IS NULL` claim.
    // On a send failure the claim is released so a later text retries. The
    // canonical scorer clears the claim column whenever the customer is not
    // critical, so a later re-entry can claim and alert again. (The nightly
    // pipeline doesn't run this path, so it never fires the live alert.)
    if (result.churnRisk === 'critical' && priorRisk !== 'critical' && process.env.ADAM_PHONE) {
      if (await claimCriticalAlert(customerId)) {
        const delivered = await sendCriticalChurnAlert(customerId, result, source);
        if (!delivered) await releaseCriticalAlert(customerId);
      }
    }

    return result;
  } catch (err) {
    logger.error(`[event-rescore] rescore failed for ${customerId}: ${err.message}`);
    return null;
  }
}

// Atomically claim the crossing into critical. Returns true iff THIS caller
// won — the conditional update only matches while `critical_alert_sent_at` is
// still NULL, and Postgres row-locks the single current row, so among
// concurrent callers exactly one gets a non-zero rowcount.
async function claimCriticalAlert(customerId) {
  try {
    const claimed = await db('customer_health_scores')
      .where('customer_id', customerId)
      .where('churn_risk', 'critical')
      .whereNull('critical_alert_sent_at')
      .update({ critical_alert_sent_at: new Date() });
    return claimed > 0;
  } catch (err) {
    logger.debug(`[event-rescore] critical-alert claim failed for ${customerId}: ${err.message}`);
    return false;
  }
}

// Owner SMS the instant a customer drops to critical. Mirrors the nightly
// churn-alert format (retention-engine) but marked "(live)" and carrying no
// outreach draft — it is an immediate heads-up, not the morning action plan.
// Returns true iff the alert was delivered (so the caller can release the
// claim and retry on failure).
async function sendCriticalChurnAlert(customerId, result, source = 'inbound') {
  const adamPhone = process.env.ADAM_PHONE;
  if (!adamPhone) return false;

  try {
    const customer = await db('customers').where('id', customerId).first();
    if (!customer) return false;

    const TwilioService = require('../twilio');
    const top = (result.churnSignals || [])[0];
    const trigger = top?.value || top?.message || top?.signal || 'Multiple signals';
    const rate = customer.monthly_rate ? `$${customer.monthly_rate}/mo` : '';
    const name = `${customer.first_name || ''} ${customer.last_name || ''}`.trim() || 'Customer';

    const body = `🚨 CHURN ALERT (live): ${name} (${customer.waveguard_tier || '—'} ${rate})\n`
      + `Health just dropped to CRITICAL — ${result.overall}/100\n`
      + `Trigger: ${trigger}\n`
      + `📞 ${customer.phone || 'no phone on file'}`;

    const sendResult = await TwilioService.sendSMS(adamPhone, body, { messageType: 'internal_alert' });
    if (sendResult && sendResult.sent === false) return false; // soft failure (blocked/undelivered)
    logger.info(`[event-rescore] live churn alert sent for ${customerId} (source: ${source})`);
    return true;
  } catch (err) {
    logger.error(`[event-rescore] critical alert failed for ${customerId}: ${err.message}`);
    return false;
  }
}

// Release the live-alert claim so a later inbound text retries — used when the
// send failed after the claim was won (no recipient / Twilio error).
async function releaseCriticalAlert(customerId) {
  try {
    await db('customer_health_scores')
      .where('customer_id', customerId)
      .where('churn_risk', 'critical')
      .update({ critical_alert_sent_at: null });
  } catch (err) {
    logger.debug(`[event-rescore] release alert claim failed for ${customerId}: ${err.message}`);
  }
}

module.exports = { rescoreOnInboundMessage, sendCriticalChurnAlert, gateOn };
