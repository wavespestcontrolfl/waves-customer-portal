/**
 * Lead linkage for estimates.
 *
 * Pre-conversion estimates have NO customer_id — the lead row is the only
 * contact identity. Linkage lives in two places (admin-estimates.js reads
 * them the same way for its detail pane):
 *   1. leads.estimate_id FK (canonical),
 *   2. the public-quote mirror estimate_data.lead_id (fallback).
 *
 * Used by the click-tracking lane so short-link mints and click_followup
 * action rows carry lead_id for lead-only estimates — without it, the
 * clicked-but-didn't-book queue could only dedupe those contacts by phone.
 *
 * Returns null for customer-linked estimates (customer_id already carries
 * identity; skipping the lookup keeps SMS send paths at zero extra queries
 * for the common case) and on any lookup/parse error (linkage is telemetry —
 * never block a send on it).
 */

const db = require('../models/db');
const logger = require('./logger');

async function leadIdForEstimate(estimate) {
  if (!estimate || !estimate.id || estimate.customer_id) return null;
  try {
    const lead = await db('leads')
      .where({ estimate_id: estimate.id })
      .whereNull('deleted_at')
      .first('id');
    if (lead) return lead.id;
  } catch (e) {
    logger.warn(`[estimate-lead-linkage] leads lookup failed for estimate ${estimate.id}: ${e.message}`);
  }
  try {
    const data = typeof estimate.estimate_data === 'string'
      ? JSON.parse(estimate.estimate_data)
      : estimate.estimate_data;
    return data?.lead_id || null;
  } catch {
    return null;
  }
}

module.exports = { leadIdForEstimate };
