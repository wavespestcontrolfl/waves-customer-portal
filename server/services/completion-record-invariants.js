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
 * Unit of evaluation is the VISIT (scheduled_services row), never a single
 * service_records row: service_records.scheduled_service_id is intentionally
 * one-to-many — the detailed completion form, the pest-recap rail, and a
 * project close can each own a completed row for one visit (closeout-status.js
 * documents the sibling model), and the report token / completion text can
 * live on a different sibling than the row a naive scan would land on. Each
 * predicate therefore asks "does ANY sibling carry the artifact" and only
 * fails when none does.
 *
 * Each predicate returns { count, ids, detail } — the adapter contract of
 * the sweep registry. ids are PII-free row ids. One SQL statement per
 * predicate: a full count plus a LIMIT-bounded id sample (the sample is
 * bounded BEFORE aggregation — array_agg over the whole match set would
 * materialise every id exactly when a backlog is largest).
 *
 * Nothing here writes. Repairs stay with their owners: the dispatch
 * backfill path for missing records, ensureReportToken (pdf-queue.js) for
 * missing tokens, Billing Recovery for the money side, the schedule for an
 * incomplete visit's follow-up.
 */

const db = require('../models/db');

const SAMPLE = 25;

// Yesterday-and-older in ET wall-clock terms: today's visits are still
// closing and are the dashboard's job.
const TODAY_ET = "(now() AT TIME ZONE 'America/New_York')::date";
const BEFORE_TODAY_ET = `ss.scheduled_date < ${TODAY_ET}`;

// The completion-SMS status marker (structured_notes.completionSmsStatus)
// and the report delivery ledger both post-date the oldest records; the
// comms predicate is bounded to records created after this date so legacy
// rows without either marker are not reported as missing notifications.
const COMMS_MARKER_SINCE = '2026-07-01';

// completionSmsStatus values closeout-status.js classifies as done or
// not_required (a settled outcome); everything else is pending or failed.
const TERMINAL_SMS_STATUSES = Object.freeze(['sent', 'skipped_recap_sms_already_sent', 'blocked']);

// How long an operator has to reschedule or follow up a visit the tech
// marked incomplete before the sweep lists it (closeout-alerts shows it on
// the day; this is the long tail).
const INCOMPLETE_FOLLOWUP_GRACE_DAYS = 7;

// The instant a record last became "complete" for grace-period purposes:
// a recap-rail re-completion of an office-handoff record keeps its original
// created_at, so created_at alone would age a freshly completed record
// straight past the grace window (codex P2) — but the row's general
// updated_at moves on every report/delivery/correction write and would
// restart the window forever (codex P1). The visit's tracker stamp
// (scheduled_services.completed_at) is the completion-specific marker.
const COMPLETED_MARKER_AT = 'GREATEST(sr.created_at, COALESCE(ss.completed_at, sr.created_at))';

// A completed record that OWES the customer a report / a completion notice:
// not a backfill, delivery not suppressed, not a project close (the project
// report lane owns those). Shared by the token and comms predicates.
const OWES_CUSTOMER_ARTIFACT = `
      sr.status = 'completed'
      AND COALESCE(sr.structured_notes->>'backfill', 'false') <> 'true'
      AND COALESCE(sr.structured_notes->>'typedReportDelivery', 'auto_send') = 'auto_send'
      AND sr.completion_source IS DISTINCT FROM 'project_completion'`;

// matchSql must SELECT `id` (text-castable) and `ord` (sort key, newest
// first). The CTE is scanned once for the count and once for a LIMIT-bounded
// sample, so the sample never aggregates the whole backlog.
function aggregate(matchSql) {
  return `
      WITH m AS (${matchSql})
      SELECT (SELECT count(*)::int FROM m) AS n,
             (SELECT array_agg(s.id::text ORDER BY s.ord DESC)
                FROM (SELECT m.id, m.ord FROM m ORDER BY m.ord DESC LIMIT ${SAMPLE}) s) AS sample`;
}

const PREDICATES = Object.freeze({
  completed_visit_without_record: {
    label: 'Completed visits (before today) with no service_records row',
    href: '/admin/dispatch',
    sql: aggregate(`
        SELECT ss.id, ss.scheduled_date AS ord
          FROM scheduled_services ss
         WHERE ss.status = 'completed'
           AND ${BEFORE_TODAY_ET}
           AND NOT EXISTS (SELECT 1 FROM service_records sr WHERE sr.scheduled_service_id = ss.id)`),
  },
  // Siblings from DIFFERENT rails are supported history; two completed rows
  // from the SAME rail (two detailed-form completions, two project closes)
  // are the corruption the missing unique index cannot prevent. The
  // pest-recap rail (completion_source NULL) updates an existing row rather
  // than inserting, and legacy NULL rows predate the column, so NULL is not
  // grouped — it cannot be told apart from history.
  duplicate_completed_records_per_visit: {
    label: 'Visits with more than one completed service_records row from the same completion rail',
    href: '/admin/dispatch',
    sql: aggregate(`
        SELECT sr.scheduled_service_id AS id, count(*) AS ord
          FROM service_records sr
         WHERE sr.scheduled_service_id IS NOT NULL
           AND sr.status = 'completed'
           AND sr.completion_source IN ('detailed_form', 'project_completion')
         GROUP BY sr.scheduled_service_id, sr.completion_source
        HAVING count(*) > 1`),
  },
  // A frozen catalog rule saying the service owes no report
  // (closeoutRequirements.requiresServiceReport=false) exempts the record,
  // as it does in closeout-status; absent = owed (conservative).
  completed_record_without_report_token: {
    label: 'Completed visits (>2h) that owe a customer report and have no sibling record with a report token',
    href: '/admin/dispatch',
    sql: aggregate(`
        SELECT ss.id, ss.scheduled_date AS ord
          FROM scheduled_services ss
         WHERE ss.status = 'completed'
           AND EXISTS (
                 SELECT 1 FROM service_records sr
                  WHERE sr.scheduled_service_id = ss.id
                    AND ${OWES_CUSTOMER_ARTIFACT}
                    AND COALESCE(sr.structured_notes->'closeoutRequirements'->>'requiresServiceReport', 'true') <> 'false'
                    AND ${COMPLETED_MARKER_AT} < now() - interval '2 hours')
           AND NOT EXISTS (
                 SELECT 1 FROM service_records tok
                  WHERE tok.scheduled_service_id = ss.id
                    AND tok.report_view_token IS NOT NULL)`),
  },
  completed_visit_without_completed_at: {
    label: "Completed visits (before today) whose completed_at is NULL (tracker stamp never landed)",
    href: '/admin/dispatch',
    sql: aggregate(`
        SELECT ss.id, ss.scheduled_date AS ord
          FROM scheduled_services ss
         WHERE ss.status = 'completed'
           AND ss.completed_at IS NULL
           AND ${BEFORE_TODAY_ET}
           AND EXISTS (SELECT 1 FROM service_records sr WHERE sr.scheduled_service_id = ss.id AND sr.status = 'completed')`),
  },
  // Confirmed notice = a TERMINAL completionSmsStatus on ANY sibling —
  // the closeout-status.js comms vocabulary's done / not_required outcomes
  // only: 'sent', 'skipped_recap_sms_already_sent', 'blocked' (consent) —
  // or a sent report email on any sibling. 'sending' and 'deferred' are
  // pending there and stay findings once 24h old; NULL and 'failed' are
  // findings. recap_sms_sent_at is deliberately NOT evidence: it is an
  // at-most-once CLAIM stamped before the provider call (closeout-status.js
  // treats an aged claim alone as unverified), so a crash can leave it set
  // with no text sent. A frozen catalog rule saying the service owes no
  // notice (closeoutRequirements.requiresCustomerNotice=false) exempts the
  // record, as it does in closeout-status. Email evidence must sit on the
  // sibling that OWNS the report artifact (its report_view_token), as
  // closeout-status pairs delivery with the artifact record — a sent
  // delivery on an older or suppressed sibling does not clear a newer
  // owed notice (codex P1).
  completed_record_without_comms_marker: {
    label: 'Completed visits (>24h) that owe a completion notice and have no sibling with a terminal one (sent / recap sent / consent-blocked SMS, or sent report email)',
    href: '/admin/dispatch',
    sql: aggregate(`
        SELECT ss.id, ss.scheduled_date AS ord
          FROM scheduled_services ss
         WHERE ss.status = 'completed'
           AND EXISTS (
                 SELECT 1 FROM service_records sr
                  WHERE sr.scheduled_service_id = ss.id
                    AND ${OWES_CUSTOMER_ARTIFACT}
                    AND COALESCE(sr.structured_notes->'closeoutRequirements'->>'requiresCustomerNotice', 'true') <> 'false'
                    AND sr.created_at >= '${COMMS_MARKER_SINCE}'::date
                    AND ${COMPLETED_MARKER_AT} < now() - interval '24 hours')
           AND NOT EXISTS (
                 SELECT 1 FROM service_records sib
                  WHERE sib.scheduled_service_id = ss.id
                    AND (
                      sib.structured_notes->>'completionSmsStatus' IN (${TERMINAL_SMS_STATUSES.map((s) => `'${s}'`).join(', ')})
                      OR (sib.report_view_token IS NOT NULL AND EXISTS (
                           SELECT 1 FROM service_report_deliveries d
                            WHERE d.service_record_id = sib.id AND d.status = 'sent'))))`),
  },
  // visitOutcome 'incomplete' leaves scheduled_services.status='completed'
  // with a service_records row of status 'incomplete' (admin-dispatch.js);
  // closeout-alerts lists it on the day as "reschedule or follow up". After
  // the grace window it must stay visible until a completed sibling lands
  // (recap-rail re-completion) or a live follow-up visit exists (the
  // followup_source_service_id link the completion's own follow-up park
  // uses) — otherwise the not-performed work silently ages out (codex P2).
  aged_incomplete_visit_records: {
    label: `Visits the tech marked incomplete more than ${INCOMPLETE_FOLLOWUP_GRACE_DAYS} days ago with no completed record and no live follow-up visit`,
    href: '/admin/dispatch',
    sql: aggregate(`
        SELECT ss.id, ss.scheduled_date AS ord
          FROM scheduled_services ss
         WHERE ss.status = 'completed'
           AND ss.scheduled_date < ${TODAY_ET} - ${INCOMPLETE_FOLLOWUP_GRACE_DAYS}
           AND EXISTS (SELECT 1 FROM service_records sr WHERE sr.scheduled_service_id = ss.id AND sr.status = 'incomplete')
           AND NOT EXISTS (SELECT 1 FROM service_records c WHERE c.scheduled_service_id = ss.id AND c.status = 'completed')
           AND NOT EXISTS (
                 SELECT 1 FROM scheduled_services f
                  WHERE f.followup_source_service_id = ss.id
                    AND f.status NOT IN ('cancelled', 'skipped', 'no_show'))`),
  },
});

const PREDICATE_KEYS = Object.freeze(Object.keys(PREDICATES));

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
  PREDICATE_KEYS,
  runPredicate,
  _private: {
    SAMPLE, COMMS_MARKER_SINCE, BEFORE_TODAY_ET, OWES_CUSTOMER_ARTIFACT, TERMINAL_SMS_STATUSES,
    COMPLETED_MARKER_AT, INCOMPLETE_FOLLOWUP_GRACE_DAYS, aggregate,
  },
};
