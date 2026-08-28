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
// rescore THAT one customer within seconds and post an admin notification
// (bell + push, never an SMS, never a message to the customer) the moment they
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

    // The live "🚨 Churn risk" owner alert (bell/push) was retired 2026-08-28
    // (owner ruling: churn is reviewed in /admin/customers?view=health, not
    // pushed). The score itself still updates; critical_alert_sent_at is no
    // longer claimed here.

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
module.exports = { rescoreOnInboundMessage, gateOn };
