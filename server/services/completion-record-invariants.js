'use strict';
/**
 * Completion ↔ report record invariants — READ-ONLY history-wide predicates.
 *
 * Why (integrity audit 2026-09-02): every closeout surface today is
 * date-scoped — the dashboard reads TODAY's visits, the lead-to-cash sweep's
 * closeout_failed_facts reads YESTERDAY's — and the per-visit facts for
 * "no report token", "no invoice", "no completion text" are `pending`, not
 * `failed`, so they never reach the sweep at all. A completion whose token
 * mint, tracker stamp, or customer text silently failed on day one is
 * therefore invisible from day two onward. These predicates look at the
 * WHOLE history (bounded only where a legacy shape predates the marker
 * being checked) and are registered as detectors in
 * lead-to-cash-invariants.js, so they ride its existing gate
 * (GATE_LEAD_TO_CASH_SWEEP), cadence, fail-closed runner, and FIX email.
 *
 * Each predicate returns { count, ids, detail } — the adapter contract of
 * the sweep registry. ids are PII-free row ids. One SQL statement per
 * predicate: a count plus a bounded id sample, so a large backlog costs one
 * aggregate, never a row scan into memory.
 *
 * Nothing here writes. Repairs stay with their owners: the dispatch
 * backfill path for missing records, ensureReportToken (pdf-queue.js) for
 * missing tokens, Billing Recovery for the money side.
 */

const db = require('../models/db');

const SAMPLE = 25;

// Yesterday-and-older in ET wall-clock terms: today's visits are still
// closing and are the dashboard's job.
const BEFORE_TODAY_ET = "ss.scheduled_date < (now() AT TIME ZONE 'America/New_York')::date";

// The completion-SMS status marker (structured_notes.completionSmsStatus)
// and the report delivery ledger both post-date the oldest records; the
// comms predicate is bounded to records created after this date so legacy
// rows without either marker are not reported as missing notifications.
const COMMS_MARKER_SINCE = '2026-07-01';

const PREDICATES = Object.freeze({
  completed_visit_without_record: {
    label: 'Completed visits (before today) with no service_records row',
    href: '/admin/dispatch',
    sql: `
      SELECT count(*)::int AS n,
             (array_agg(ss.id::text ORDER BY ss.scheduled_date DESC))[1:${SAMPLE}] AS sample
        FROM scheduled_services ss
       WHERE ss.status = 'completed'
         AND ${BEFORE_TODAY_ET}
         AND NOT EXISTS (SELECT 1 FROM service_records sr WHERE sr.scheduled_service_id = ss.id)`,
  },
  duplicate_completed_records_per_visit: {
    label: 'Visits with more than one completed service_records row',
    href: '/admin/dispatch',
    sql: `
      SELECT count(*)::int AS n,
             (array_agg(t.scheduled_service_id::text ORDER BY t.n DESC))[1:${SAMPLE}] AS sample
        FROM (
          SELECT sr.scheduled_service_id, count(*) AS n
            FROM service_records sr
           WHERE sr.scheduled_service_id IS NOT NULL
             AND sr.status = 'completed'
           GROUP BY sr.scheduled_service_id
          HAVING count(*) > 1
        ) t`,
  },
  completed_record_without_report_token: {
    label: 'Completed auto-send records (older than 2h) with no report token',
    href: '/admin/dispatch',
    sql: `
      SELECT count(*)::int AS n,
             (array_agg(sr.id::text ORDER BY sr.created_at DESC))[1:${SAMPLE}] AS sample
        FROM service_records sr
        JOIN scheduled_services ss ON ss.id = sr.scheduled_service_id
       WHERE sr.status = 'completed'
         AND ss.status = 'completed'
         AND sr.report_view_token IS NULL
         AND sr.report_generated_at IS NULL
         AND COALESCE(sr.structured_notes->>'backfill', 'false') <> 'true'
         AND COALESCE(sr.structured_notes->>'typedReportDelivery', 'auto_send') = 'auto_send'
         AND sr.completion_source IS DISTINCT FROM 'project_completion'
         AND sr.created_at < now() - interval '2 hours'`,
  },
  completed_visit_without_completed_at: {
    label: "Completed visits (before today) whose completed_at is NULL (tracker stamp never landed)",
    href: '/admin/dispatch',
    sql: `
      SELECT count(*)::int AS n,
             (array_agg(ss.id::text ORDER BY ss.scheduled_date DESC))[1:${SAMPLE}] AS sample
        FROM scheduled_services ss
       WHERE ss.status = 'completed'
         AND ss.completed_at IS NULL
         AND ${BEFORE_TODAY_ET}
         AND EXISTS (SELECT 1 FROM service_records sr WHERE sr.scheduled_service_id = ss.id AND sr.status = 'completed')`,
  },
  completed_record_without_comms_marker: {
    label: 'Completed non-backfill records (>24h old) with no completion text, recap text, or sent report email',
    href: '/admin/dispatch',
    sql: `
      SELECT count(*)::int AS n,
             (array_agg(sr.id::text ORDER BY sr.created_at DESC))[1:${SAMPLE}] AS sample
        FROM service_records sr
        JOIN scheduled_services ss ON ss.id = sr.scheduled_service_id
       WHERE ss.status = 'completed'
         AND sr.status = 'completed'
         AND COALESCE(sr.structured_notes->>'backfill', 'false') <> 'true'
         AND COALESCE(sr.structured_notes->>'typedReportDelivery', 'auto_send') = 'auto_send'
         AND sr.completion_source IS DISTINCT FROM 'project_completion'
         AND sr.structured_notes->>'completionSmsStatus' IS NULL
         AND sr.recap_sms_sent_at IS NULL
         AND NOT EXISTS (
               SELECT 1 FROM service_report_deliveries d
                WHERE d.service_record_id = sr.id AND d.status = 'sent')
         AND sr.created_at >= '${COMMS_MARKER_SINCE}'::date
         AND sr.created_at < now() - interval '24 hours'`,
  },
});

async function runPredicate(key, knex = db) {
  const predicate = PREDICATES[key];
  if (!predicate) throw new Error(`unknown completion-record predicate: ${key}`);
  const res = await knex.raw(predicate.sql);
  const row = Array.isArray(res?.rows) ? res.rows[0] : null;
  const count = Number(row?.n) || 0;
  const ids = Array.isArray(row?.sample) ? row.sample.map(String) : [];
  return { count, ids, detail: { sampleCap: SAMPLE } };
}

module.exports = {
  PREDICATES,
  runPredicate,
  _private: { SAMPLE, COMMS_MARKER_SINCE, BEFORE_TODAY_ET },
};
