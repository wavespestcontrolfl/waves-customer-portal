// ============================================================
// evidence-prewarm.js — warm the property-evidence cache at visit
// completion so the cross-sell card can show a real price at render.
//
// The card's composer (cross-sell.js) reads property evidence CACHE-ONLY at
// render time — a customer opening their report must never wait on county
// APIs or a vision read. The consequence (prod audit 2026-08-11): customers
// with no accepted estimate and no cached lookup get the unpriced
// request-a-quote CTA, which in practice is MOST one-time customers. The
// report SMS goes out well after completion, so the hours in between are
// free — this module runs the lookup then, and the render finds it warm.
//
// Design rule: the pre-warm IS the composer. It calls buildReportCrossSell
// with the one difference that the property lookup may fetch live and
// persist (the composer's own injection seam, the same one its tests use).
// Everything else — premises proofs, the offer matrix, commercial and
// multifamily suppressions, ownership fail-closed — is the composer's own
// code, so the cache this warms is BY CONSTRUCTION the cache the render
// path will read, and a report whose card is suppressed never spends a
// lookup at all. No parallel address resolution to drift.
//
// Fire-and-forget by contract: the caller invokes this post-commit inside
// its own guard; this module additionally never rejects. Ships dark behind
// GATE_REPORT_CROSS_SELL_PREWARM and is inert unless GATE_REPORT_CROSS_SELL
// is also on (warming evidence for a card that cannot render is pure spend).
// ============================================================

const logger = require('../logger');

async function prewarmReportCrossSellEvidence(serviceRecord, database) {
  try {
    const { isEnabled } = require('../../config/feature-gates');
    if (!isEnabled('reportCrossSellPrewarm') || !isEnabled('reportCrossSell')) return null;
    if (!serviceRecord?.id || !serviceRecord?.customer_id) return null;
    const { buildReportCrossSell } = require('./cross-sell');
    // Lazy-required like the composer's own cache-only default —
    // property-lookup-v2 is heavy and cyclic-prone.
    const { performPropertyLookup } = require('../../routes/property-lookup-v2');
    const result = await buildReportCrossSell(serviceRecord, database, {
      // The ONE difference from render: a cold cache may fetch live and
      // persist. performPropertyLookup is cache-first either way, so a
      // warm cache costs nothing and replayed completions are no-ops.
      propertyLookup: (address) => performPropertyLookup(address, { cacheOnly: false, persist: true }),
    });
    return result ? result.mode : null;
  } catch (err) {
    // err.code only — same PII posture as the referral-link route: raw
    // driver/library messages can quote customer data.
    logger.warn(`[report-prewarm] suppressed (code=${err?.code || 'none'}) for record ${serviceRecord?.id || 'unknown'}`);
    return null;
  }
}

module.exports = { prewarmReportCrossSellEvidence };
