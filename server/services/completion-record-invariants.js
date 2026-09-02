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
 * fails when none does. A project-backed visit (a project row or a
 * project_completion sibling) is excluded from the service-report checks
 * as a whole — its artifact and delivery live on the project report
 * (closeout-status.js switches the entire visit to that path).
 *
 * Each predicate returns { count, ids, truncated, detail } — the adapter
 * contract of the sweep registry. ids are PII-free row ids. One SQL
 * statement per predicate: a full count plus a LIMIT-bounded id sample (the
 * sample is bounded BEFORE aggregation — array_agg over the whole match set
 * would materialise every id exactly when a backlog is largest).
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

// Legacy cutovers — history before these dates cannot carry the marker
// the predicate checks, so reporting it would be permanent noise and (for
// the record check) could prompt a second record beside a legacy one:
// - service_records.scheduled_service_id FK: migration 20260427000007, no
//   backfill (pre-FK records link by the old customer/tech/date convention).
// - scheduled_services.completed_at tracking stamp: migration 20260422000009,
//   no backfill (readers treat those NULLs as supported legacy data).
// - completionSmsStatus marker + service_report_deliveries ledger: mid-2026.
// - service_records.report_view_token: migration 20260401000021, no backfill.
// Cutovers key on WHEN THE COMPLETION HAPPENED (the job_status_history
// transition to 'completed', or the record's write time), never on the
// visit's scheduled_date — the status route and a modern backfill can
// complete an arbitrarily old visit on today's code and owe today's markers
// (codex P2 r3/r4).
const RECORD_FK_SINCE = '2026-04-27';
const TRACKING_STAMP_SINCE = '2026-04-22';
const REPORT_TOKEN_SINCE = '2026-04-01';
const COMMS_MARKER_SINCE = '2026-07-01';

// The visit was transitioned to 'completed' on or after `since` (the
// canonical job-status ledger every completion rail writes through
// transitionJobStatus). A visit with no such transition row is legacy.
const COMPLETED_TRANSITION_SINCE = (since) => `
      EXISTS (
        SELECT 1 FROM job_status_history h
         WHERE h.job_id = ss.id
           AND h.to_status = 'completed'
           AND h.transitioned_at >= '${since}'::date)`;

// completionSmsStatus values closeout-status.js classifies as done or
// not_required (a settled outcome); everything else is pending or failed.
const TERMINAL_SMS_STATUSES = Object.freeze(['sent', 'skipped_recap_sms_already_sent', 'blocked']);

// How long an operator has to reschedule or follow up a visit the tech
// marked incomplete before the sweep lists it (closeout-alerts shows it on
// the day; this is the long tail).
const INCOMPLETE_FOLLOWUP_GRACE_DAYS = 7;

// The instant a record last became "complete" for grace-period purposes.
// created_at alone ages a recap-rail re-completion of an office-handoff
// record straight past the window (codex P2); the row's general updated_at
// moves on every report/delivery/correction write and would restart the
// window forever (codex P1). So: the record's creation, the visit's tracker
// stamp, or the recap claim stamp (recap_sms_sent_at — an at-most-once
// CLAIM written at recap completion; used here only as a time marker,
// never as delivery evidence), whichever is latest. The recap path
// re-completing an old incomplete record advances the claim stamp even
// though markComplete's already-complete branch preserves the old
// completed_at (codex P2 r2).
const COMPLETED_MARKER_AT = 'GREATEST(sr.created_at, COALESCE(ss.completed_at, sr.created_at), COALESCE(sr.recap_sms_sent_at, sr.created_at))';

// A completed record that OWES the customer a report / a completion notice:
// not a backfill, delivery not suppressed, not a project close (the project
// report lane owns those). Shared by the token and comms predicates.
const OWES_CUSTOMER_ARTIFACT = `
      sr.status = 'completed'
      AND COALESCE(sr.structured_notes->>'backfill', 'false') <> 'true'
      AND COALESCE(sr.structured_notes->>'typedReportDelivery', 'auto_send') = 'auto_send'
      AND sr.completion_source IS DISTINCT FROM 'project_completion'`;

// Visit-level project exclusion: a project row linked to the visit, or a
// project_completion sibling, moves the WHOLE visit to the project report
// path (closeout-status.js) — its token/delivery live on projects.*, so the
// service-report predicates must not judge any sibling of such a visit.
const VISIT_NOT_PROJECT_BACKED = `
      NOT EXISTS (SELECT 1 FROM projects pj WHERE pj.scheduled_service_id = ss.id)
      AND NOT EXISTS (
            SELECT 1 FROM service_records pc
             WHERE pc.scheduled_service_id = ss.id
               AND (pc.completion_source = 'project_completion'
                    OR EXISTS (SELECT 1 FROM projects pj2 WHERE pj2.service_record_id = pc.id)))`;

// Any sibling record whose frozen closeout requirements say the named
// obligation is NOT owed. Used as NOT EXISTS: one frozen "false" exempts the
// visit, mirroring closeout-status's canonical-sibling read conservatively.
const SIBLING_FROZE_FALSE = (requirement) => `
                 SELECT 1 FROM service_records fr
                  WHERE fr.scheduled_service_id = ss.id
                    AND fr.structured_notes->'closeoutRequirements'->>'${requirement}' = 'false'`;

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
    label: `Visits completed (per job_status_history) since the ${RECORD_FK_SINCE} record FK, before today, with no service_records row`,
    href: '/admin/dispatch',
    sql: aggregate(`
        SELECT ss.id, ss.scheduled_date AS ord
          FROM scheduled_services ss
         WHERE ss.status = 'completed'
           AND ${COMPLETED_TRANSITION_SINCE(RECORD_FK_SINCE)}
           AND ${BEFORE_TODAY_ET}
           AND NOT EXISTS (SELECT 1 FROM service_records sr WHERE sr.scheduled_service_id = ss.id)`),
  },
  // Siblings from DIFFERENT rails are supported history; two completed rows
  // from the SAME rail (two detailed-form / one-tap completions, two project closes)
  // are the corruption the missing unique index cannot prevent. The
  // pest-recap rail (completion_source NULL) updates an existing row rather
  // than inserting, and legacy NULL rows predate the column, so NULL is not
  // grouped — it cannot be told apart from history.
  duplicate_completed_records_per_visit: {
    label: 'Visits with more than one completed service_records row from the same completion rail',
    href: '/admin/dispatch',
    sql: aggregate(`
        SELECT g.scheduled_service_id AS id, max(g.n) AS ord
          FROM (
            SELECT sr.scheduled_service_id, count(*) AS n
              FROM service_records sr
             WHERE sr.scheduled_service_id IS NOT NULL
               AND sr.status = 'completed'
               AND sr.completion_source IN ('detailed_form', 'one_tap_completion', 'project_completion')
             GROUP BY sr.scheduled_service_id, sr.completion_source
            HAVING count(*) > 1
          ) g
         GROUP BY g.scheduled_service_id`),
  },
  // A frozen catalog rule saying the service owes no report
  // (closeoutRequirements.requiresServiceReport=false) on ANY sibling
  // exempts the visit (conservative twin of closeout-status's canonical
  // sibling read — codex P2 r5); absent everywhere = owed.
  completed_record_without_report_token: {
    label: 'Completed non-project visits (>2h) that owe a customer report and have no sibling record with a report token',
    href: '/admin/dispatch',
    sql: aggregate(`
        SELECT ss.id, ss.scheduled_date AS ord
          FROM scheduled_services ss
         WHERE ss.status = 'completed'
           AND ${VISIT_NOT_PROJECT_BACKED}
           AND EXISTS (
                 SELECT 1 FROM service_records sr
                  WHERE sr.scheduled_service_id = ss.id
                    AND ${OWES_CUSTOMER_ARTIFACT}
                    AND sr.created_at >= '${REPORT_TOKEN_SINCE}'::date
                    AND ${COMPLETED_MARKER_AT} < now() - interval '2 hours')
           AND NOT EXISTS (${SIBLING_FROZE_FALSE('requiresServiceReport')})
           AND NOT EXISTS (
                 SELECT 1 FROM service_records tok
                  WHERE tok.scheduled_service_id = ss.id
                    AND tok.report_view_token IS NOT NULL)`),
  },
  completed_visit_without_completed_at: {
    label: `Visits completed (per job_status_history) since the ${TRACKING_STAMP_SINCE} tracker stamp shipped, before today, whose completed_at is NULL`,
    href: '/admin/dispatch',
    // The cutover keys on the completion TRANSITION time, not the visit
    // date or the record's creation: a modern backfill of a pre-tracking
    // visit, or a recap re-completing an old FK-healed record, runs on
    // today's code and owes the stamp (codex P2 r3/r4). An 'incomplete'
    // record is completion evidence too — /complete still calls
    // markComplete for visitOutcome 'incomplete' (codex P2 r5).
    sql: aggregate(`
        SELECT ss.id, ss.scheduled_date AS ord
          FROM scheduled_services ss
         WHERE ss.status = 'completed'
           AND ss.completed_at IS NULL
           AND ${BEFORE_TODAY_ET}
           AND ${COMPLETED_TRANSITION_SINCE(TRACKING_STAMP_SINCE)}
           AND EXISTS (
                 SELECT 1 FROM service_records sr
                  WHERE sr.scheduled_service_id = ss.id
                    AND sr.status IN ('completed', 'incomplete'))`),
  },
  // Confirmed notice = a TERMINAL completionSmsStatus on ANY sibling —
  // the closeout-status.js comms vocabulary's done / not_required outcomes
  // only: 'sent', 'skipped_recap_sms_already_sent', 'blocked' (consent) —
  // or a sent report email on the sibling that OWNS the report artifact
  // (its report_view_token), as closeout-status pairs delivery with the
  // artifact record. 'sending' and 'deferred' are pending there and stay
  // findings once 24h old; NULL and 'failed' are findings. A frozen catalog
  // rule saying the service owes no notice
  // (closeoutRequirements.requiresCustomerNotice=false) on ANY sibling
  // exempts the visit (closeout-status reads the canonical sibling's
  // snapshot; treating a frozen "not owed" on any sibling as authoritative
  // is the conservative SQL twin — codex P2 r5). A delivered video recap
  // (service_recaps.sent_at — set only on provider confirmation,
  // recap-delivery.js) is a completion notice too (codex P2 r5).
  completed_record_without_comms_marker: {
    label: 'Completed non-project visits (>24h) that owe a completion notice and have no sibling with a terminal one (sent / recap sent / consent-blocked SMS, or sent report email on the artifact record)',
    href: '/admin/dispatch',
    sql: aggregate(`
        SELECT ss.id, ss.scheduled_date AS ord
          FROM scheduled_services ss
         WHERE ss.status = 'completed'
           AND ${VISIT_NOT_PROJECT_BACKED}
           AND EXISTS (
                 SELECT 1 FROM service_records sr
                  WHERE sr.scheduled_service_id = ss.id
                    AND ${OWES_CUSTOMER_ARTIFACT}
                    AND ${COMPLETED_MARKER_AT} >= '${COMMS_MARKER_SINCE}'::date
                    AND ${COMPLETED_MARKER_AT} < now() - interval '24 hours')
           AND NOT EXISTS (${SIBLING_FROZE_FALSE('requiresCustomerNotice')})
           AND NOT EXISTS (
                 SELECT 1 FROM service_records sib
                  WHERE sib.scheduled_service_id = ss.id
                    AND (
                      sib.structured_notes->>'completionSmsStatus' IN (${TERMINAL_SMS_STATUSES.map((s) => `'${s}'`).join(', ')})
                      OR (sib.report_view_token IS NOT NULL AND EXISTS (
                           SELECT 1 FROM service_report_deliveries d
                            WHERE d.service_record_id = sib.id AND d.status = 'sent'))))
           AND NOT EXISTS (
                 SELECT 1 FROM service_recaps rc
                  WHERE rc.scheduled_service_id = ss.id AND rc.sent_at IS NOT NULL)`),
  },
  // visitOutcome 'incomplete' leaves scheduled_services.status='completed'
  // with a service_records row of status 'incomplete' (admin-dispatch.js);
  // closeout-alerts lists it on the day as "reschedule or follow up". After
  // the grace window it must stay visible until a completed sibling lands
  // (recap-rail re-completion) or a live follow-up visit exists (the
  // followup_source_service_id link the completion's own follow-up park
  // uses) — otherwise the not-performed work silently ages out (codex P2).
  aged_incomplete_visit_records: {
    label: `Visits whose incomplete record is more than ${INCOMPLETE_FOLLOWUP_GRACE_DAYS} days old with no completed record and no live follow-up visit`,
    href: '/admin/dispatch',
    // Grace runs from when the incomplete outcome was RECORDED (a months-old
    // visit backfilled today gets its seven days), and a live follow-up on
    // EITHER lineage column clears it — the completion CTA links by
    // followup_source_service_id, call-booked replacements by
    // parent_service_id (review-request.js checks both) (codex P2 r3).
    sql: aggregate(`
        SELECT ss.id, ss.scheduled_date AS ord
          FROM scheduled_services ss
         WHERE ss.status = 'completed'
           AND EXISTS (
                 SELECT 1 FROM service_records sr
                  WHERE sr.scheduled_service_id = ss.id
                    AND sr.status = 'incomplete'
                    AND sr.created_at < now() - interval '${INCOMPLETE_FOLLOWUP_GRACE_DAYS} days')
           AND NOT EXISTS (SELECT 1 FROM service_records c WHERE c.scheduled_service_id = ss.id AND c.status = 'completed')
           AND NOT EXISTS (
                 SELECT 1 FROM scheduled_services f
                  WHERE (f.followup_source_service_id = ss.id OR f.parent_service_id = ss.id)
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
  // The SQL already capped the sample; the runner cannot infer truncation
  // from ids.length alone, so say so explicitly (codex P2).
  return { count, ids, truncated: count > ids.length, detail: { sampleCap: SAMPLE } };
}

module.exports = {
  PREDICATES,
  PREDICATE_KEYS,
  runPredicate,
  _private: {
    SAMPLE, RECORD_FK_SINCE, TRACKING_STAMP_SINCE, REPORT_TOKEN_SINCE, COMMS_MARKER_SINCE, BEFORE_TODAY_ET, COMPLETED_TRANSITION_SINCE,
    OWES_CUSTOMER_ARTIFACT, VISIT_NOT_PROJECT_BACKED, TERMINAL_SMS_STATUSES, SIBLING_FROZE_FALSE,
    COMPLETED_MARKER_AT, INCOMPLETE_FOLLOWUP_GRACE_DAYS, aggregate,
  },
};
