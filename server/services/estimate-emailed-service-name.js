/**
 * The service name the estimate delivery email already gave the customer
 * (owner 2026-11-21, GATE_ESTIMATE_FOLLOWUP_SERVICE_NAME).
 *
 * The estimate follow-up emails say "your <service_label> estimate". This module
 * reads the words of the delivery email the office already sent (its stored
 * `service_summary`) and turns them into a follow-up label. It never classifies
 * estimate_data again and never changes a pack, a promise or a FAQ row.
 *
 *   serviceNameFromSummary(summary)  pure: closed labels only.
 *     "Pest Control"               -> "pest control"
 *     "Lawn Care"                  -> "lawn care"
 *     "Lawn Care + Pest Control"
 *     or "Pest Control + Lawn Care" -> "lawn care and pest control"
 *     anything else                -> null
 *   emailedServiceName(estimate)     async: the newest accepted delivery email
 *     for this estimate and its current address, and only while the estimate
 *     still infers the same summary. A name or null.
 */
const db = require('../models/db');
const logger = require('./logger');
const { QUERY_STATUSES, acceptedForSending } = require('./signup-single-email');

const SUMMARY_SEPARATOR = ' + ';
const DELIVERY_TEMPLATE_KEYS = () => [
  'estimate.delivery',
  'estimate.proposal_delivery',
  require('./estimate-updated-wording').UPDATED_EMAIL_TEMPLATE_KEY,
];

function pestLawnLabels() {
  const labels = require('./estimate-service-lines').SERVICE_LINE_LABELS;
  return { pest: labels.pest, lawn: labels.lawn };
}

function packLabels() {
  const { PACKS } = require('./estimate-followup-copy')._private;
  return { pest: PACKS.pest.label, lawn: PACKS.lawn.label };
}

function serviceNameFromSummary(summary) {
  if (typeof summary !== 'string') return null;
  const parts = [];
  for (const raw of summary.split(SUMMARY_SEPARATOR)) {
    const part = raw.trim();
    if (!parts.includes(part)) parts.push(part);
  }
  const names = pestLawnLabels();
  if (!parts.length || !parts.every((p) => p === names.pest || p === names.lawn)) return null;
  const labels = packLabels();
  const hasPest = parts.includes(names.pest);
  const hasLawn = parts.includes(names.lawn);
  if (hasPest && hasLawn) return `${labels.lawn} and ${labels.pest}`;
  return hasPest ? labels.pest : labels.lawn;
}

function summaryFromSnapshot(snapshot) {
  let payload = snapshot;
  if (typeof payload === 'string') {
    try { payload = JSON.parse(payload); } catch { return null; }
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  return payload.service_summary;
}

async function emailedServiceName(estimate) {
  try {
    const address = String(estimate?.customer_email || '').trim().toLowerCase();
    if (!estimate?.id || !address) return null;
    const rows = await db('email_messages')
      .where({ estimate_id: estimate.id })
      .whereIn('template_key', DELIVERY_TEMPLATE_KEYS())
      .whereIn('status', QUERY_STATUSES)
      .whereRaw('LOWER(TRIM(recipient_email_snapshot)) = ?', [address])
      .orderByRaw('COALESCE(sent_at, queued_at) DESC NULLS LAST')
      .orderBy('created_at', 'desc')
      .select('payload_snapshot', 'status', 'provider_retry_next_at', 'provider_retry_exhausted_at', 'provider_retry_count');
    const newest = (rows || []).find(acceptedForSending);
    if (!newest) return null;
    const stored = summaryFromSnapshot(newest.payload_snapshot);
    const name = serviceNameFromSummary(stored);
    if (!name) return null;
    // Second proof: the same function the delivery email used must still give
    // the same words. A different or empty result means the estimate changed.
    const { inferEstimateServiceInterest } = require('./estimate-service-lines');
    const current = inferEstimateServiceInterest({ ...estimate, estimateData: estimate.estimate_data });
    return current === stored ? name : null;
  } catch (err) {
    // A knex message can carry addresses: log only the code or name.
    logger.warn(`[estimate-emailed-service-name] read failed: ${err?.code || err?.name || 'error'}`);
    return null;
  }
}

module.exports = { serviceNameFromSummary, emailedServiceName };
