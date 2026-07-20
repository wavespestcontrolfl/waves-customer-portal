/**
 * Estimate performance by source — the conversion half of the learning loop.
 *
 * Answers: do AI-drafted estimates (estimator_engine / ai_agent) close at
 * the same rate as manual ones, how fast do drafts reach the customer, and
 * how often does the operator send an AI draft untouched?
 *
 * Win/loss uses the SAME resolved-only semantics as estimate-winloss.js
 * (won = accepted, lost = declined|expired, archived rows excluded — the
 * archive sweep stamps converted-some-other-way rows, and counting archived
 * wins without archived losses would skew rates). The drafted/sent funnel
 * is a created_at cohort over the same window. Aggregation is plain JS over
 * slim knex selects, matching the winloss module.
 */

const db = require('../models/db');

const RESOLVED_STATUSES = ['accepted', 'declined', 'expired'];

// Display buckets. Every estimates.source value written by code today maps
// here (manual/null from the admin builder, estimator_engine + ai_agent
// from the AI composers, quote_wizard from the public self-serve wizard,
// email_inquiry from the Gmail-sync draft lane, lead_webhook / sms_intake /
// lead_agent / booking_assessment bare intake shells — the last seeded by
// Waves Assessment bookings); unknown or future values fold into 'other'
// instead of vanishing.
const KNOWN_SOURCES = [
  'manual',
  'estimator_engine',
  'ai_agent',
  'quote_wizard',
  'email_inquiry',
  'lead_webhook',
  'sms_intake',
  'lead_agent',
  'booking_assessment',
];
const SOURCE_ORDER = [...KNOWN_SOURCES, 'other'];

function sourceKey(source) {
  const key = source || 'manual';
  return KNOWN_SOURCES.includes(key) ? key : 'other';
}

function parseEstimateData(raw) {
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : (raw || {});
  } catch {
    return {};
  }
}

// Mirror of estimate-winloss.js resolutionDateMs (kept local on purpose —
// this report must not silently shift if that module's chain evolves).
function resolutionDateMs(row) {
  const pick = (...candidates) => {
    for (const value of candidates) {
      if (!value) continue;
      const ts = new Date(value).getTime();
      if (Number.isFinite(ts)) return ts;
    }
    return null;
  };
  if (row.status === 'accepted') return pick(row.accepted_at, row.created_at);
  if (row.status === 'declined') return pick(row.declined_at, row.updated_at, row.created_at);
  if (row.status === 'expired') return pick(row.expires_at, row.updated_at, row.created_at);
  return null;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const value = sorted.length % 2
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
  return Math.round(value * 10) / 10;
}

function emptyBucket(source) {
  return {
    source,
    drafted: 0,
    sent: 0,
    resolved: 0,
    won: 0,
    lost: 0,
    winRatePct: null,
    sendLatencyHoursMedian: null,
    edits: {
      events: 0,
      sentUnedited: 0,
      sentUneditedPct: null,
      avgReviseCount: null,
      totalsChanged: 0,
      servicesChanged: 0,
      // Pre-ledger sends (draft predates the baseline ledger, edit history
      // unknowable) — excluded from every stat above, surfaced for honesty.
      unknown: 0,
    },
  };
}

async function sourcePerformance({ days = 90 } = {}) {
  const cutoffMs = Date.now() - days * 86400000;
  const cutoff = new Date(cutoffMs);

  const buckets = new Map(SOURCE_ORDER.map((key) => [key, emptyBucket(key)]));
  const latencies = new Map(SOURCE_ORDER.map((key) => [key, []]));
  const reviseCounts = new Map(SOURCE_ORDER.map((key) => [key, []]));

  // Funnel cohort: estimates CREATED in the window. Archived rows drop here
  // too — they left the pipeline sideways (converted otherwise / cleanup)
  // and counting them as never-sent drafts would smear every source's
  // sent-rate downward.
  const cohort = await db('estimates')
    .where('created_at', '>=', cutoff)
    .whereNull('archived_at')
    .select('id', 'source', 'status', 'created_at', 'sent_at', 'viewed_at', 'accepted_at');
  for (const row of cohort) {
    const bucket = buckets.get(sourceKey(row.source));
    bucket.drafted += 1;
    // sent_at alone is not first delivery: every resend overwrites it
    // (inflating latency), and it stays NULL when a customer acceptance
    // wins the in-flight `sending` claim. So "sent" = any delivery
    // evidence, and latency uses the EARLIEST surviving timestamp — a view
    // or accept cannot precede first delivery, so the min bounds resend
    // inflation to the customer's first reaction.
    const deliveryMs = [row.sent_at, row.viewed_at, row.accepted_at]
      .map((value) => (value ? new Date(value).getTime() : NaN))
      .filter((ts) => Number.isFinite(ts));
    if (deliveryMs.length || ['sent', 'viewed', 'accepted'].includes(row.status)) {
      bucket.sent += 1;
      const created = new Date(row.created_at).getTime();
      const first = deliveryMs.length ? Math.min(...deliveryMs) : NaN;
      if (Number.isFinite(created) && Number.isFinite(first) && first >= created) {
        latencies.get(sourceKey(row.source)).push((first - created) / 3600000);
      }
    }
  }

  // Win/loss: resolved in the window, winloss-style superset prefilter then
  // precise resolution-date trim (declined_at can be stamped without
  // touching updated_at, so no single column bounds the window).
  const resolved = await db('estimates')
    .whereIn('status', RESOLVED_STATUSES)
    .whereNull('archived_at')
    .where((q) => q
      .where('accepted_at', '>=', cutoff)
      .orWhere('declined_at', '>=', cutoff)
      .orWhere('expires_at', '>=', cutoff)
      .orWhere('updated_at', '>=', cutoff)
      .orWhere('created_at', '>=', cutoff))
    .select(
      'id', 'source', 'status', 'accepted_at', 'declined_at', 'expires_at',
      'created_at', 'updated_at',
    );
  for (const row of resolved) {
    const resolvedAt = resolutionDateMs(row);
    if (resolvedAt == null || resolvedAt < cutoffMs) continue;
    const bucket = buckets.get(sourceKey(row.source));
    bucket.resolved += 1;
    if (row.status === 'accepted') bucket.won += 1;
    else bucket.lost += 1;
  }

  // AI edit stats from the learning-event ledger (first-send events only by
  // construction — the ledger is unique per estimate).
  const events = await db('estimate_learning_events')
    .where('event_type', 'sent')
    .where('created_at', '>=', cutoff)
    .select('source', 'sent_unedited', 'edit_summary');
  for (const event of events) {
    const bucket = buckets.get(sourceKey(event.source));
    // sent_unedited is null ONLY for the pre-ledger sentinel (the draft
    // predates baseline capture, so its edit history is unknowable) —
    // counting those anywhere would fake certainty in either direction.
    if (event.sent_unedited == null) {
      bucket.edits.unknown += 1;
      continue;
    }
    bucket.edits.events += 1;
    if (event.sent_unedited) bucket.edits.sentUnedited += 1;
    const summary = parseEstimateData(event.edit_summary);
    if (Number.isFinite(summary.reviseCount)) {
      reviseCounts.get(sourceKey(event.source)).push(summary.reviseCount);
    }
    if (summary.totalsChanged) bucket.edits.totalsChanged += 1;
    if (summary.servicesAdded || summary.servicesRemoved) bucket.edits.servicesChanged += 1;
  }

  for (const key of SOURCE_ORDER) {
    const bucket = buckets.get(key);
    bucket.winRatePct = bucket.resolved > 0
      ? Math.round((bucket.won / bucket.resolved) * 1000) / 10
      : null;
    bucket.sendLatencyHoursMedian = median(latencies.get(key));
    const counts = reviseCounts.get(key);
    bucket.edits.avgReviseCount = counts.length
      ? Math.round((counts.reduce((a, b) => a + b, 0) / counts.length) * 10) / 10
      : null;
    bucket.edits.sentUneditedPct = bucket.edits.events > 0
      ? Math.round((bucket.edits.sentUnedited / bucket.edits.events) * 1000) / 10
      : null;
  }

  const sources = SOURCE_ORDER
    .map((key) => buckets.get(key))
    .filter((bucket) => bucket.drafted > 0 || bucket.resolved > 0
      || bucket.edits.events > 0 || bucket.edits.unknown > 0);

  return {
    days,
    drafted: sources.reduce((sum, b) => sum + b.drafted, 0),
    resolved: sources.reduce((sum, b) => sum + b.resolved, 0),
    sources,
  };
}

module.exports = {
  sourcePerformance,
  _private: { sourceKey, resolutionDateMs, median, SOURCE_ORDER },
};
