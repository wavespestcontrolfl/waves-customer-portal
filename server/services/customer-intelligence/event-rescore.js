const logger = require('../logger');
const SignalDetector = require('./signal-detector');
const customerHealth = require('../customer-health');

// Event-driven (near-real-time) health rescore.
//
// The nightly Customer Intelligence Pipeline scores every customer once at 3 AM
// ET. That means a hot inbound signal — a customer texting about a competitor,
// a cancellation, or a price complaint — can sit up to ~24h before it moves the
// score. This module lets a single hot event rescore THAT one customer within
// seconds. The live "🚨 Churn risk" owner alert (bell/push) that used to fire
// on a crossing into critical was retired 2026-08-28 (owner ruling: churn is
// reviewed in /admin/customers?view=health, not pushed).
//
// Gated behind GATE_EVENT_RESCORE (fail-closed): when unset/!= 'true' this is a
// no-op and behavior is exactly the nightly-only path.

function gateOn() {
  return process.env.GATE_EVENT_RESCORE === 'true';
}

// Rescore one customer in response to a hot inbound event (currently an inbound
// SMS). Detects fresh signals for the customer so the score reflects this
// event, then rescores via the canonical engine. Designed to be called
// fire-and-forget — it never throws. (The second argument is accepted for
// call-site compatibility; nothing reads it since the alert was retired.)
async function rescoreOnInboundMessage(customerId) {
  if (!gateOn() || !customerId) return null;

  try {
    // Detect fresh signals for this customer (keyword + AI sentiment on recent
    // inbound SMS) so the rescore folds in whatever just arrived. Non-fatal.
    try {
      await SignalDetector.detectSignals(customerId);
    } catch (err) {
      logger.debug(`[event-rescore] signal detect failed for ${customerId}: ${err.message}`);
    }

    return (await customerHealth.scoreCustomer(customerId)) || null;
  } catch (err) {
    logger.error(`[event-rescore] rescore failed for ${customerId}: ${err.message}`);
    return null;
  }
}

module.exports = { rescoreOnInboundMessage, gateOn };
