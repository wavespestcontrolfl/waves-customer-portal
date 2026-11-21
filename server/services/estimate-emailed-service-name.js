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
 *   emailedServiceName(estimate, todayLabel)  async: only for today's two generic
 *     labels ("home protection" takes the two-service name, "service quote" a
 *     single-service name); the newest accepted delivery email for this estimate
 *     and its current address, and only while the estimate still infers the same
 *     summary. A name or null.
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

// Exact strings only: the two single labels and the two orders of the pair. No trimming and no
// de-duplicating, so "Lawn Care + Pest Control + Lawn Care" is not a known summary.
function serviceNameFromSummary(summary) {
  if (typeof summary !== 'string') return null;
  const names = pestLawnLabels();
  const labels = packLabels();
  if (summary === names.pest) return labels.pest;
  if (summary === names.lawn) return labels.lawn;
  const pair = [`${names.lawn}${SUMMARY_SEPARATOR}${names.pest}`, `${names.pest}${SUMMARY_SEPARATOR}${names.lawn}`];
  return pair.includes(summary) ? bothLabel() : null;
}

const bothLabel = () => {
  const labels = packLabels();
  return `${labels.lawn} and ${labels.pest}`;
};

// Only the two generic labels are replaced. The bundle pack's label ("home protection") takes the
// two-service name; the one-time pack's label ("service quote") takes a single-service name. Every
// other label already names the service its pack's copy is about, so it is never replaced.
function nameForTodayLabel(todayLabel, name) {
  const { PACKS } = require('./estimate-followup-copy')._private;
  if (todayLabel === PACKS.bundle.label) return name === bothLabel() ? name : null;
  if (todayLabel === PACKS.one_time.label) return name && name !== bothLabel() ? name : null;
  return null;
}

function replaceableLabel(todayLabel) {
  const { PACKS } = require('./estimate-followup-copy')._private;
  return todayLabel === PACKS.bundle.label || todayLabel === PACKS.one_time.label;
}

function summaryFromSnapshot(snapshot) {
  let payload = snapshot;
  if (typeof payload === 'string') {
    try { payload = JSON.parse(payload); } catch { return null; }
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  return payload.service_summary;
}

// The delivery email's plain text prints the summary on its own line, "Service: <summary>". Only that exact
// line counts: the branded wrapper (logo alt text, title, footer) also holds the words "Pest Control" and "Lawn Care".
const SERVICE_ROW_PREFIX = 'Service: ';
function emailShowed(row, summary) {
  if (typeof row.text_snapshot !== 'string') return false;
  return row.text_snapshot.split('\n').some((line) => line.trim() === `${SERVICE_ROW_PREFIX}${summary}`);
}

async function emailedServiceName(estimate, todayLabel) {
  try {
    if (!replaceableLabel(todayLabel) || !estimate?.id) return null;
    // The engine read its row before it claimed the job. The address and the service are judged on a fresh
    // row, so a change since that read (a corrected address, a revised service) drops the name.
    const fresh = await db('estimates').where({ id: estimate.id }).first();
    const address = String(fresh?.customer_email || '').trim().toLowerCase();
    if (!fresh || !address) return null;
    // The follow-up goes to the address on the engine's row. A different address now = no name.
    if (address !== String(estimate.customer_email || '').trim().toLowerCase()) return null;
    const rows = await db('email_messages')
      .where({ estimate_id: fresh.id })
      .whereIn('template_key', DELIVERY_TEMPLATE_KEYS())
      .whereIn('status', QUERY_STATUSES)
      .whereRaw('LOWER(TRIM(recipient_email_snapshot)) = ?', [address])
      .orderByRaw('COALESCE(sent_at, queued_at) DESC NULLS LAST')
      .orderBy('created_at', 'desc')
      .select('payload_snapshot', 'text_snapshot', 'status', 'provider_retry_next_at', 'provider_retry_exhausted_at', 'provider_retry_count');
    const newest = (rows || []).find(acceptedForSending);
    if (!newest) return null;
    const stored = summaryFromSnapshot(newest.payload_snapshot);
    const name = nameForTodayLabel(todayLabel, serviceNameFromSummary(stored));
    if (!name) return null;
    // The payload holds the summary even when a template version does not print it. The customer
    // must have been shown these words: the stored email text has to carry its Service line.
    if (!emailShowed(newest, stored)) return null;
    // Second proof: the same function the delivery email used must still give
    // the same words. A different or empty result means the estimate changed.
    const { inferEstimateServiceInterest } = require('./estimate-service-lines');
    const current = inferEstimateServiceInterest({ ...fresh, estimateData: fresh.estimate_data });
    if (current !== stored) return null;
    // A stored service_interest wins in that function before it looks at the lines. Ask it again with the
    // stored interest blank: the estimate's own lines must give the same words, or the name is not used.
    const fromLines = inferEstimateServiceInterest({
      ...fresh, service_interest: null, serviceInterest: null, estimateData: fresh.estimate_data,
    });
    return fromLines === stored ? name : null;
  } catch (err) {
    // A knex message can carry addresses: log only the code or name.
    logger.warn(`[estimate-emailed-service-name] read failed: ${err?.code || err?.name || 'error'}`);
    return null;
  }
}

module.exports = { serviceNameFromSummary, emailedServiceName };
