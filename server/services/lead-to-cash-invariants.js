'use strict';
/**
 * Lead-to-cash invariants sweep — READ-ONLY registry over EXISTING detectors.
 *
 * Every check below lives elsewhere in the repo with its own incident
 * provenance (the completion-record predicates in
 * completion-record-invariants.js included); this module only (1) gives each
 * a common finding shape, (2) runs them together once a day, and (3) emails
 * contact@ when — and only when — something is off. It defines NO predicates
 * of its own, writes NO business rows (only the ops-email send marker, its
 * own run state and its own alerts), and never talks to a customer. Two of
 * the checks
 * (`churned_live_state`, `waveguard_alignment_drift`) promote CLI audits that
 * were manual-only until now; the alignment scan is invoked with no `onRepair`,
 * so this path has no write capability at all.
 *
 * Exception-based: a clean sweep sends nothing. A detector that throws is
 * reported as `unavailable` and counts as an exception (FAIL CLOSED — a check
 * that cannot run is not a passing check). Subject grammar follows the
 * ops-email convention (first word = owner's action): FIX, because every
 * finding is a diverged record that needs repair.
 *
 * Two alerts, not one a day (owner 2026-11-20 "go", data-check audit step 4).
 * The sweep posted one alert every morning. Most checks read standing state,
 * so the same list came back each day: 45 alerts in the 45 days to 2026-11-20,
 * each closed by hand. In the app the sweep now keeps two kinds of alert:
 *   1. The STANDING LIST (STANDING_KEY): the checks that read present state.
 *      Every run reads all of it again, so one open alert is enough. A new
 *      one posts when a check newly fails or newly cannot run, or on the 7th
 *      daily run after the last one; it replaces the older one. A higher
 *      count on a check that already fails posts nothing. A run with every
 *      standing check clean closes it. It is pinned in the Activity feed
 *      until then (fallOff), like every sender that retires on a clean run.
 *   2. RECORDS (RECORD_KEY, the sweep's key since day one): the checks that
 *      read a MOVING WINDOW (registry `moving`). A finding there can leave
 *      the window with nothing fixed: nothing reads yesterday's closeouts
 *      again. A record is an immutable row. The sweep never closes, replaces
 *      or rewrites it. One posts when a moving-window check has a finding
 *      that the last run did not have, so a 14-day window does not post 14
 *      copies and a finding that cleared and came back posts again. It
 *      lists the new findings only, every one of them.
 * A moving-window check that could not run is present state (it cannot run
 * NOW), so it stands in the standing list until it runs again. The exception
 * is a check that reads a new window on each run (yesterday's closeouts):
 * the window it missed never comes back, so each missed run is a record.
 * The run state (one system_settings row) holds what the last run found. A
 * state that is missing, cannot be read, or was not written by the last
 * daily run never hides a finding: it posts. The state moves forward only
 * for an alert the feed holds, so a failed write is tried again on the next
 * run. Each run marks its start in the row before it does anything and saves
 * its result at the end; a result older than the latest start is not
 * trusted, so a failed save cannot leave an older result in force.
 * Rows written before this split are full reports under RECORD_KEY. They get
 * the record treatment: the sweep never touches them.
 * The email path (the in-app feed off) is as before: one email a run with the
 * whole report, paced by the 20-hour send marker. In the app the run state
 * decides what is new, so the marker is not read there.
 *
 * Gate: GATE_LEAD_TO_CASH_SWEEP=true (feature-gates `leadToCashInvariantSweep`;
 * kill = unset). Cron: 6:55 ET daily (scheduler.js), after the 6:00 estimate
 * conversion guard and the 6:40 schedule-integrity watchdog on purpose — the
 * `converted_open_estimates` check asserts that guard converged.
 *
 * PII: findings carry ids, counts, and flag names only — never names, phones,
 * emails, or addresses (AGENTS.md PII-in-logs / PII-in-repo rules).
 */

const crypto = require('crypto');
const db = require('../models/db');
const logger = require('./logger');
const { deliverOpsDigest, supersedeOlderDigests, inAppEnabled } = require('./ops-digest');
const { retireIfClean } = require('./ops-digest-fall-off');
const sendgrid = require('./sendgrid-mail');
const { isEnabled } = require('../config/feature-gates');
const { isInternalEmailRecipient } = require('../utils/internal-email-recipients');
const { etDateString } = require('../utils/datetime-et');
const { scrubSentryText, safeErrorToken } = require('../utils/sentry-scrub');

const SEND_MARKER_KEY = 'lead-to-cash-invariants';
const RECORD_KEY = 'lead-to-cash-invariants';
const STANDING_KEY = 'lead-to-cash-standing';
const RUN_STATE_KEY = 'lead_to_cash_sweep.run_state';
const TWENTY_HOURS_MS = 20 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
// The standing list posts again on the 7th daily run after its last alert. The
// cron fires at 06:55 with a few seconds of jitter, so the limit is 6.5 days:
// an exact 7 days could miss the 7th run by a second and wait for the 8th.
const REPEAT_AFTER_MS = 6.5 * DAY_MS;
// The run state counts only when the LAST daily run wrote it. An older one (a
// failed state write, a missed run, days on the email path) no longer says
// what the feed shows, so the run reads it as "no state" and posts. The runs
// are 24 hours apart (23 or 25 on a clock change).
const STATE_FRESH_MS = 36 * 60 * 60 * 1000;
// The one date-bound flag of audit-churned-accounts-live-state.
const UPCOMING_VISIT_FLAG = 'upcoming_visit';
const SAMPLE_IDS = 25;
const CLOSEOUT_VISIT_CAP = 150;
const FROM_NAME = process.env.SENDGRID_FROM_NAME || 'Waves Pest Control';
const sweepEmail = () => process.env.LEAD_TO_CASH_SWEEP_EMAIL || 'contact@wavespestcontrol.com';
const fromEmail = () => process.env.SENDGRID_FROM_EMAIL || 'contact@wavespestcontrol.com';

// ---------------------------------------------------------------------------
// Registry. Each detector returns { count, ids, detail? } — count is the
// number of violated rows, ids a PII-free identifier list (capped at
// SAMPLE_IDS by the runner), detail an optional small object of counters.
// `href` is where the owner goes to repair. `provenance` names the incident.
// `moving: true` marks a check that reads a moving window (a date filter that
// lets a finding leave with nothing fixed): its failures post as records, not
// in the standing list (see the header). Set it on every new detector whose
// query is bound to a look-back or look-ahead date. `freshEachRun: true` (with
// `moving`) = each run reads a different window, so two failing runs never
// report the same thing. A moving check's run() may return `itemKeys`: one
// stable key for each finding, when the id text holds a number that moves
// (default: the ids). A new key is what makes a new record.
// ---------------------------------------------------------------------------
const DETECTORS = Object.freeze([
  {
    // An account stands here for its plan-state flags. The audit's
    // `upcoming_visit` flag reads visits dated today or later, so it is its
    // own check below (churned_upcoming_visits).
    key: 'churned_live_state',
    label: 'Churned/inactive accounts still carrying live plan state',
    href: '/admin/customers',
    provenance: 'cancellation scope 2026-08-29 — portal cancel never cleared tier/rate/autopay',
    async run() {
      const { auditChurnedAccountsLiveState } = require('../scripts/audit-churned-accounts-live-state');
      const res = await auditChurnedAccountsLiveState({ db });
      const standing = res.findings.filter((f) => f.flags.some((flag) => flag !== UPCOMING_VISIT_FLAG));
      const counts = Object.fromEntries(Object.entries(res.counts || {}).filter(([flag]) => flag !== UPCOMING_VISIT_FLAG));
      return { count: standing.length, ids: standing.map((f) => f.id), detail: counts };
    },
  },
  {
    // Its own check since the 2026-11-21 alert split (it was one flag of
    // churned_live_state): the audit reads visits dated today or later, so
    // the finding leaves when the visit date passes, with nothing fixed. The
    // audit reads the statuses `scheduled` and `rescheduled` too, which
    // stale_open_visits does not, so no other check takes the visit over.
    key: 'churned_upcoming_visits',
    moving: true,
    label: 'Churned/inactive accounts that still have an upcoming visit',
    href: '/admin/customers',
    provenance: 'cancellation scope 2026-08-29 — audit-churned-accounts-live-state `upcoming_visit` flag',
    async run() {
      const { auditChurnedAccountsLiveState } = require('../scripts/audit-churned-accounts-live-state');
      const res = await auditChurnedAccountsLiveState({ db });
      const upcoming = res.findings.filter((f) => f.flags.includes(UPCOMING_VISIT_FLAG));
      return { count: upcoming.length, ids: upcoming.map((f) => f.id) };
    },
  },
  {
    key: 'waveguard_alignment_drift',
    label: 'WaveGuard members whose customer fields drift from their recurring services',
    href: '/admin/customers',
    provenance: 'owner directive 2026-07-28 / PR #3011 — align-waveguard-portal-records dry-run',
    async run() {
      const { scanAlignment } = require('../scripts/align-waveguard-portal-records');
      // No onRepair, no enrollNoPlan: the enrolled-member re-align pass only, read-only.
      const scan = await scanAlignment({});
      return {
        count: scan.repairs.length,
        ids: scan.repairs.map((r) => r.customerId),
        detail: { checked: scan.checkedCustomers, tierMismatches: scan.tierMismatches.length, noServiceEvidence: scan.noServiceEvidence.length },
      };
    },
  },
  {
    key: 'recurring_schedule_anomalies',
    label: 'Recurring series children off their cadence',
    href: '/admin/schedule',
    provenance: 'recurring-schedule-audit (on-demand admin route only until now)',
    async run() {
      const { auditRecurringScheduleAnomalies } = require('./recurring-schedule-audit');
      const res = await auditRecurringScheduleAnomalies({}, db);
      const byType = {};
      for (const a of res.anomalies) byType[a.checkType] = (byType[a.checkType] || 0) + 1;
      return { count: res.anomalyCount, ids: res.anomalies.map((a) => a.appointmentId), detail: byType };
    },
  },
  {
    key: 'stale_open_visits',
    label: 'Past-dated visits still in an open status',
    href: '/admin/dispatch',
    provenance: 'July 2026 audit, 250 open past-dated rows — stale-visit-sweep',
    async run({ now }) {
      const { _private } = require('./stale-visit-sweep');
      const rows = await _private.findStaleVisits(now);
      return { count: rows.length, ids: rows.map((r) => r.id), detail: _private.countsByStatus(rows) };
    },
  },
  {
    key: 'converted_open_estimates',
    label: 'Estimates still open for customers who converted another way (6:00 guard did not converge)',
    href: '/admin/estimates',
    provenance: 'prod incident — two paying customers received the full three-stage nag ladder',
    async run() {
      const { convertedOpenEstimatesQuery } = require('./estimate-conversion-guard');
      const rows = await convertedOpenEstimatesQuery().select('estimates.id');
      return { count: rows.length, ids: rows.map((r) => r.id) };
    },
  },
  {
    key: 'completion_lane_coverage',
    label: 'Active catalog services that do not resolve to exactly one completion lane',
    href: '/admin/service-library',
    provenance: 'universal one-time services plan §5 Phase B — ops/agents/completion-lane-coverage.js',
    async run() {
      const { ALL_LISTS, ABSENT_FROM_PROD_BY_DESIGN_KEYS, classifyCatalogRow } = require('../config/completion-lane-registry');
      const rows = await db('services as s')
        .leftJoin('service_completion_profiles as p', 'p.service_key', 's.service_key')
        .where({ 's.is_active': true, 's.is_archived': false })
        .select('s.service_key', 's.billing_type', 's.category', 'p.completion_mode', 'p.project_type', 'p.delivery_mode', 'p.active as profile_active');
      const defects = [];
      for (const row of rows) {
        const { lane, flags } = classifyCatalogRow(row);
        if (flags.length) defects.push(`${row.service_key} (${lane}: ${flags.join(',')})`);
      }
      // Registry keys the catalog no longer has AT ALL are stale entries.
      // Inactive/archived keys are kept on purpose (profiles still resolve
      // for their scheduled visits) and are not defects by themselves.
      const registryKeys = Array.from(new Set(Object.values(ALL_LISTS).flat()));
      const known = new Set((await db('services').whereIn('service_key', registryKeys).select('service_key')).map((r) => r.service_key));
      // Keys absent from prod BY DESIGN are not stale (they would be flagged
      // every day forever); only this list skips them, never active rows (or
      // the ghost lanes of completion_lane_ghost_lanes).
      const stale = registryKeys
        .filter((k) => !known.has(k) && !ABSENT_FROM_PROD_BY_DESIGN_KEYS.includes(k))
        .map((k) => `registry-only:${k}`);
      return { count: defects.length + stale.length, ids: [...defects, ...stale], detail: { activeServices: rows.length } };
    },
  },
  {
    // Its own check since the 2026-11-21 alert split (it was a third leg of
    // completion_lane_coverage): the query is bound to today's date, so a
    // ghost lane leaves it when its last visit date passes, with nothing fixed.
    key: 'completion_lane_ghost_lanes',
    moving: true,
    label: 'Inactive or archived services that still have upcoming visits (ghost completion lanes)',
    href: '/admin/service-library',
    provenance: 'universal one-time services plan §5 Phase B — ops/agents/completion-lane-coverage.js',
    async run({ now }) {
      const { classifyCatalogRow } = require('../config/completion-lane-registry');
      // Ghost lanes (mirrors the canonical audit): an inactive/archived
      // service with UPCOMING non-terminal visits is a live routing lane no
      // matter what the catalog flags say — the completion resolver matches
      // by service_id / name without an is_active filter. Same service_id
      // precedence and terminal-status set as ops/agents/completion-lane-
      // coverage.js; every such row is a defect, plus its own lane flags.
      const ghost = await db.raw(
        `SELECT s.service_key, s.billing_type, s.category, s.is_archived,
                p.completion_mode, p.project_type, p.delivery_mode, p.active AS profile_active,
                count(ss.id) AS upcoming
           FROM services s
           LEFT JOIN service_completion_profiles p ON p.service_key = s.service_key
           JOIN scheduled_services ss ON (
             ss.service_id = s.id
             OR (ss.service_id IS NULL AND (
               lower(s.name) = lower(ss.service_type)
               OR lower(s.name) = lower(trim(regexp_replace(ss.service_type, '\\s+service$', '', 'i')))
             ))
           )
          WHERE (s.is_active = false OR s.is_archived = true)
            AND ss.status NOT IN ('completed', 'cancelled', 'skipped')
            AND ss.scheduled_date >= ?
          GROUP BY 1, 2, 3, 4, 5, 6, 7, 8
          ORDER BY upcoming DESC`,
        [etDateString(now)],
      );
      const lanes = Array.isArray(ghost?.rows) ? ghost.rows : [];
      const ghosts = lanes.map((g) => {
        const { lane, flags } = classifyCatalogRow(g);
        return `${g.service_key} (${lane}: ${[`${g.is_archived ? 'archived' : 'inactive'}_service_with_upcoming_visits:${Number(g.upcoming) || 0}`, ...flags].join(',')})`;
      });
      // The id text holds the upcoming-visit count, which falls as visits
      // pass. The finding is the service: one record for one ghost lane.
      return { count: ghosts.length, ids: ghosts, itemKeys: lanes.map((g) => String(g.service_key)) };
    },
  },
  {
    key: 'closeout_failed_facts',
    moving: true,
    freshEachRun: true,
    label: "Yesterday's completed visits with a failed closeout fact or a contradiction",
    href: '/admin/dispatch',
    provenance: 'closeout-status service PR #3647 (ten facts, never one boolean)',
    async run({ now }) {
      const { getCloseoutStatus } = require('./closeout-status');
      const yesterday = etDateString(new Date(now.getTime() - 24 * 60 * 60 * 1000));
      const visits = await db('scheduled_services')
        .where({ status: 'completed', scheduled_date: yesterday })
        .orderBy('id')
        .limit(CLOSEOUT_VISIT_CAP + 1)
        .select('id');
      const truncated = visits.length > CLOSEOUT_VISIT_CAP;
      const ids = [];
      let unevaluable = 0;
      // FAIL CLOSED on the cap: visits beyond it were NOT evaluated, so the
      // day cannot read clean — the overflow is a finding of its own.
      if (truncated) {
        const overflow = await db('scheduled_services').where({ status: 'completed', scheduled_date: yesterday }).count({ n: 'id' }).first();
        const notEvaluated = Math.max(1, (Number(overflow?.n) || 0) - CLOSEOUT_VISIT_CAP);
        ids.push(`[truncated: ${notEvaluated} completed visit(s) beyond the ${CLOSEOUT_VISIT_CAP}-visit cap were not evaluated]`);
      }
      for (const v of visits.slice(0, CLOSEOUT_VISIT_CAP)) {
        const status = await getCloseoutStatus(v.id, { knex: db, now });
        // FAIL CLOSED: a visit whose facts could not all be loaded is not a
        // pass — it is listed as a finding of its own kind, never dropped.
        if (!status.found || (Array.isArray(status.unavailable) && status.unavailable.length)) {
          unevaluable += 1;
          ids.push(`${v.id} [unevaluable:${status.found ? status.unavailable.map((u) => u.lookup).join('/') : 'not_found'}]`);
          continue;
        }
        const { failed = [], contradictions = [] } = status.summary || {};
        if (failed.length || contradictions.length) ids.push(`${v.id} [${[...failed, ...contradictions].join(',')}]`);
      }
      return { count: ids.length, ids, detail: { checked: Math.min(visits.length, CLOSEOUT_VISIT_CAP), unevaluable, date: yesterday, truncated } };
    },
  },
  {
    key: 'street_line_holds_locality',
    label: 'Street lines that also hold the city, state or ZIP (one house saved as two)',
    href: '/admin/customers',
    provenance: 'owner 2026-10-30 — a lead address copied unsplit; a merge kept both copies (#7131, 14 repaired)',
    async run() {
      const { customersWithStreetLineHoldingLocality } = require('./customer-properties');
      const ids = await customersWithStreetLineHoldingLocality(db);
      return { count: ids.length, ids };
    },
  },
  {
    key: 'saved_address_without_pin',
    label: 'Saved addresses with no map pin (outside the address review queue)',
    href: '/admin/customers',
    provenance: 'owner 2026-10-30 — the hourly geocode backstop never pins a saved address; 14 had no pin',
    async run() {
      const { customersWithUnpinnedSavedAddress } = require('./customer-properties');
      const ids = await customersWithUnpinnedSavedAddress(db);
      return { count: ids.length, ids };
    },
  },
  {
    key: 'address_missing_city_or_zip',
    label: 'Addresses with a street but no city, state or ZIP (booking shows "Address incomplete")',
    href: '/admin/customers',
    provenance: 'owner 2026-10-30 — 37 pinned customers had no ZIP or city; the review queue only judges unpinned ones',
    async run() {
      const { customersWithIncompleteAddress } = require('./customer-properties');
      const ids = await customersWithIncompleteAddress(db);
      return { count: ids.length, ids };
    },
  },
  {
    key: 'new_plan_without_welcome',
    moving: true,
    label: 'New customers whose first recurring plan started in the last 14 days with no welcome text queued',
    href: '/admin/customers',
    provenance: 'welcome-text traces 2026-11-04 and 2026-11-09 — 27 of 94 first plans (Jul 25 to Oct 24) got no welcome text; 4 had no known cause',
    async run({ now }) {
      const { findFirstPlansWithoutWelcome, WELCOME_AUDIT_WINDOW_DAYS, WELCOME_AUDIT_GRACE_HOURS } = require('./new-recurring-welcome-sms');
      const ids = await findFirstPlansWithoutWelcome(now);
      return { count: ids.length, ids, detail: { windowDays: WELCOME_AUDIT_WINDOW_DAYS, graceHours: WELCOME_AUDIT_GRACE_HOURS } };
    },
  },
  // History-wide completion ↔ report record invariants (integrity audit
  // 2026-09-02). closeout_failed_facts above reads yesterday only and skips
  // `pending` facts, so a missing record / token / tracker stamp / customer
  // text that failed silently on day one was invisible from day two on.
  // One adapter per predicate so each reads as its own OK/FAIL line.
  ...require('./completion-record-invariants').PREDICATE_KEYS.map((key) => {
    const { PREDICATES } = require('./completion-record-invariants');
    return {
      key,
      label: PREDICATES[key].label,
      href: PREDICATES[key].href,
      provenance: 'completion ↔ report integrity audit 2026-09-02 — completion-record-invariants.js',
      async run() {
        const { runPredicate } = require('./completion-record-invariants');
        return runPredicate(key);
      },
    };
  }),
]);

// ---------------------------------------------------------------------------
// Runner: every detector runs in its own try/catch so one failure never blanks
// the others; the failure itself is a finding (`unavailable`).
// ---------------------------------------------------------------------------
async function runDetectors({ now = new Date(), detectors = DETECTORS } = {}) {
  const results = [];
  for (const d of detectors) {
    const started = Date.now();
    try {
      const out = await d.run({ now });
      const ids = Array.isArray(out.ids) ? out.ids.map(String) : [];
      results.push({
        key: d.key, label: d.label, href: d.href, moving: d.moving === true, freshEachRun: d.freshEachRun === true, ok: out.count === 0, unavailable: false,
        // EVERY finding's key, not the display sample below: a record is new
        // when a key is new, and the 26th finding must count like the first.
        // `listCapped` = the check itself returned a part of its list.
        // `ids` is the whole list too, so a record can show a new finding
        // that is not in the first SAMPLE_IDS.
        ids, itemKeys: Array.isArray(out.itemKeys) ? out.itemKeys.map(String) : ids, listCapped: out.truncated === true,
        // A detector that already capped its sample in SQL reports the cap
        // itself (out.truncated) — the length test alone cannot see it.
        count: Number(out.count) || 0, sample: ids.slice(0, SAMPLE_IDS), truncated: ids.length > SAMPLE_IDS || out.truncated === true,
        detail: out.detail || null, ms: Date.now() - started,
      });
    } catch (err) {
      // Egress discipline (sentry-scrub header): the emailed `error` is a
      // FIXED allowlisted token (err.code / err.name), never prose — provider
      // and Knex messages can embed phone numbers, emails, or SQL literals.
      // The log line carries the scrubbed message for triage.
      logger.error(`[l2c-invariants] ${d.key} unavailable: ${scrubSentryText(err?.message || err)}`);
      results.push({
        key: d.key, label: d.label, href: d.href, moving: d.moving === true, freshEachRun: d.freshEachRun === true, ok: false, unavailable: true,
        ids: [], itemKeys: [], listCapped: false,
        count: 0, sample: [], truncated: false, detail: null,
        error: safeErrorToken(err?.code) || safeErrorToken(err?.name) || 'error', ms: Date.now() - started,
      });
    }
  }
  return results;
}

function composeReport(results, { now = new Date(), title = 'lead-to-cash invariants', note = null } = {}) {
  const violated = results.filter((r) => !r.ok && !r.unavailable);
  const unavailable = results.filter((r) => r.unavailable);
  const total = violated.reduce((s, r) => s + r.count, 0);
  const parts = [];
  if (total) parts.push(`${total} violation${total === 1 ? '' : 's'} across ${violated.length} check${violated.length === 1 ? '' : 's'}`);
  if (unavailable.length) parts.push(`${unavailable.length} check${unavailable.length === 1 ? '' : 's'} could not run`);
  const subject = `FIX: ${title} — ${parts.join('; ')} (${etDateString(now)})`;

  const lines = [];
  for (const r of results) {
    if (r.ok) { lines.push(`OK   ${r.key}`); continue; }
    if (r.unavailable) { lines.push(`??   ${r.key} — could not run (${r.error}); see server log`); continue; }
    lines.push(`FAIL ${r.key} — ${r.count}: ${r.label}`);
    if (r.detail) lines.push(`     ${Object.entries(r.detail).map(([k, v]) => `${k}=${v}`).join(' ')}`);
    if (r.sample.length) lines.push(`     ${r.sample.join(', ')}${r.truncated ? ` … +${r.count - r.sample.length} more` : ''}`);
    lines.push(`     ${r.href}`);
  }
  lines.push('', ...(note ? [note] : []), 'Read-only sweep; nothing was changed. Registry: server/services/lead-to-cash-invariants.js');
  const text = lines.join('\n');
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const html = `<pre style="font:13px/1.4 ui-monospace,Menlo,monospace">${esc(text)}</pre>`;
  return { subject, text, html, total, unavailable: unavailable.length };
}

async function sentRecently() {
  try {
    const row = await db('ops_email_send_state').where({ email_key: SEND_MARKER_KEY }).first('last_sent_at');
    return Boolean(row?.last_sent_at && (Date.now() - new Date(row.last_sent_at).getTime()) < TWENTY_HOURS_MS);
  } catch (err) {
    logger.warn(`[l2c-invariants] send-marker read failed (${err.message}) — proceeding without the guard`);
    return false;
  }
}

async function stampSendMarker() {
  try {
    const now = new Date();
    await db('ops_email_send_state')
      .insert({ email_key: SEND_MARKER_KEY, last_sent_at: now, updated_at: now })
      .onConflict('email_key')
      .merge({ last_sent_at: now, updated_at: now });
  } catch (err) {
    logger.warn(`[l2c-invariants] send-marker write failed (${err.message}) — next tick may re-send`);
  }
}

// ---------------------------------------------------------------------------
// Alert lifecycle (see the header: the standing list and the records).
// ---------------------------------------------------------------------------

// What an alert is about: one item for each check that failed or could not
// run. Counts are left out on purpose (a higher count alone is not news).
// "Could not run" and "failed" are two items on purpose: when a check runs
// again and fails, the open alert still says it could not run, so a new alert
// replaces it.
function failingItems(results) {
  return results.filter((r) => !r.ok).map((r) => (r.unavailable ? `${r.key}:unavailable` : r.key)).sort();
}

// The run state row holds the result of the last finished run,
// { runAt, items, alertedAt, alertId, seen }, plus `attempt`: the start time
// of the latest run.
//   items     the standing checks that failed (failingItems)
//   alertedAt the time of the last standing alert the feed holds, or null
//   alertId   that alert's row id
//   seen      for each failing moving-window check, its findings (itemHashes)
// A run marks its start before it does anything (startRun) and saves its
// result at the end (writeRunState: attempt = runAt). So a result with
// attempt !== runAt is OLDER than the latest run: that run posted or closed
// alerts and its own result was not saved, and what the older one says no
// longer matches the feed. Such a result, and one the last daily run did not
// write (STATE_FRESH_MS), is not trusted: null. The callers then post. A
// state fault never hides a finding.
function trustedState(raw, now) {
  if (!raw || !Array.isArray(raw.items)) return null;
  const age = now.getTime() - Date.parse(raw.runAt);
  if (raw.attempt !== raw.runAt || !(age < STATE_FRESH_MS)) {
    logger.info(`[l2c-invariants] run state is not from the last finished daily run (result ${raw.runAt || 'unknown'}, last start ${raw.attempt || 'unknown'}) — treating every item as new`);
    return null;
  }
  const seen = raw.seen && typeof raw.seen === 'object' && !Array.isArray(raw.seen) ? raw.seen : {};
  return {
    items: raw.items.map(String),
    alertedAt: Number.isFinite(Date.parse(raw.alertedAt)) ? raw.alertedAt : null,
    alertId: raw.alertId ? String(raw.alertId) : null,
    seen: Object.fromEntries(Object.entries(seen).filter(([, hashes]) => Array.isArray(hashes)).map(([key, hashes]) => [key, hashes.map(String)])),
  };
}

// Returns true when the row is saved. It never throws.
async function saveRunStateRow(row) {
  try {
    const value = JSON.stringify(row);
    await db('system_settings')
      .insert({ key: RUN_STATE_KEY, value, category: 'ops_digest', description: 'Lead-to-cash sweep: what the last run found (failing standing checks, the last standing alert, moving-window findings as hashes)' })
      .onConflict('key')
      .merge({ value, updated_at: new Date() });
    return true;
  } catch (err) {
    logger.warn(`[l2c-invariants] run-state write failed (${err.message}) — the next run may post again`);
    return false;
  }
}

// The first step of every in-app run: read the last result, then mark this
// run's start in the row. Returns { marked, state }: `state` is the trusted
// result, or null. A start that cannot be marked = null too, and the run then
// trusts nothing, posts, and closes nothing (closeStandingAlert): nothing
// would tell the next run that this run's own result went unsaved.
async function startRun(now) {
  let raw = null;
  try {
    const row = await db('system_settings').where({ key: RUN_STATE_KEY }).first('value');
    raw = row?.value ? JSON.parse(row.value) : null;
  } catch (err) {
    logger.warn(`[l2c-invariants] run-state read failed (${err.message}) — treating every item as new`);
  }
  const last = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const marked = await saveRunStateRow({ ...last, attempt: now.toISOString() });
  return { marked, state: marked ? trustedState(last, now) : null };
}

// Every standing check ran and passed, so the open standing alert is fixed.
// retireIfClean names the standing key only, so it can never close a record,
// and it never throws. It runs only when this run's start is marked: without
// the mark, a later run could trust an older result that still names the
// check, and keep it quiet with its alert closed. Not closed on this run =
// closed by the next clean run.
async function closeStandingAlert(marked) {
  if (!marked) {
    logger.warn('[l2c-invariants] the run start could not be marked — the standing alert stays open until the next clean run');
    return;
  }
  await retireIfClean(STANDING_KEY);
}

// The last step: this run's result, tried twice. Returns true when it is
// saved; it never throws. A failed save leaves the start mark of startRun, so
// no later run trusts the older result (the cost is a possible second copy
// of an alert), and the run reads as failed (state_failed) so job_health
// shows it.
async function writeRunState(now, { items, alertedAt, alertId, seen }) {
  const at = now.toISOString();
  const row = { runAt: at, attempt: at, items, alertedAt: alertedAt || null, alertId: alertId || null, seen: seen || {} };
  return (await saveRunStateRow(row)) || saveRunStateRow(row);
}

// True when this run's failing standing checks were all failing on the last
// run too, and the last standing alert is younger than REPEAT_AFTER_MS.
// An alert a person marked Done still counts, on purpose: that is a decision
// about a list the person has seen. Posting again on the next run would bring
// back the one-alert-a-day, closed-by-hand loop this split removes. The
// weekly alert brings the list back.
function nothingNew(state, items, now) {
  if (!state || !state.alertedAt) return false;
  const known = new Set(state.items);
  if (!items.every((item) => known.has(item))) return false;
  return (now.getTime() - Date.parse(state.alertedAt)) < REPEAT_AFTER_MS;
}

const shortHash = (text) => crypto.createHash('sha1').update(String(text)).digest('hex').slice(0, 16);

// One finding of a moving-window check, as a short hash: what the run state
// keeps to tell a new finding from one already posted (it holds no record
// id). A check that reads a different window on each run (yesterday's
// closeouts) adds the date, so the same visit id, or "could not run", on two
// days is two findings.
function itemHash(r, itemKey, now) {
  return shortHash(`${r.freshEachRun ? etDateString(now) : ''}|${r.key}|${itemKey}`);
}

// EVERY finding of one failing moving-window check (no cap: a finding left
// out could be replaced unseen). A list that does not name every finding (the
// check returned a part of it, or no ids) cannot show a new one, so its count
// joins the list and any change of the count is a new finding.
function itemHashes(r, now) {
  if (r.unavailable) return [itemHash(r, 'unavailable', now)];
  const keys = [...new Set(r.itemKeys)];
  if (r.listCapped || !keys.length) keys.push(`count:${r.count}`);
  return keys.map((key) => itemHash(r, key, now)).sort();
}

function hasNewItem(hashes, seen) {
  const known = new Set(Array.isArray(seen) ? seen : []);
  return hashes.some((hash) => !known.has(hash));
}

// What the run state keeps for one failing check of a record. A check that
// could not run saw nothing, so what it had found stays known beside the
// "could not run" item: a rerun on the same day that works again does not
// post the same findings a second time.
function findingsNow(r, seen, now) {
  const hashes = itemHashes(r, now);
  return r.unavailable && Array.isArray(seen) ? [...new Set([...seen, ...hashes])].sort() : hashes;
}

// Which alert a result belongs to (see the header): true = a record.
const isRecordResult = (r) => r.moving && !(r.unavailable && !r.freshEachRun);

// One moving-window check as a record shows it: its NEW findings only (the
// ones the last run did not have), every one, with no cap. So the record's
// count and ids are what made it, and no finding is marked as seen without
// being listed. null = the check fails with nothing new: it is not in this
// record (its earlier record stands).
function newFindingsOf(r, seen, now) {
  if (r.ok) return r;
  if (!hasNewItem(itemHashes(r, now), seen)) return null;
  // Without one key for each id, or with a list that does not name every
  // finding, the new ids cannot be told apart: the check shows as it stands.
  if (r.unavailable || r.listCapped || !r.ids.length || r.ids.length !== r.itemKeys.length) return { ...r, sample: r.ids, truncated: r.listCapped };
  const known = new Set(Array.isArray(seen) ? seen : []);
  const fresh = r.ids.filter((id, i) => !known.has(itemHash(r, r.itemKeys[i], now)));
  const postedBefore = r.ids.length - fresh.length;
  return { ...r, count: fresh.length, sample: fresh, truncated: false, detail: postedBefore ? { ...(r.detail || {}), postedBefore } : r.detail };
}

const emailSender = (mailer, to, report) => () => mailer.sendOne({
  to, fromEmail: fromEmail(), fromName: FROM_NAME,
  subject: report.subject, html: report.html, text: report.text,
  categories: ['ops', 'lead-to-cash-invariants'], suppressErrorLog: true,
});

// One alert through the digest seam. channel 'in_app' = the feed holds the
// row `id`. 'email' = the feed write failed and the seam's fallback email
// went out. An alert that reached nobody throws.
async function deliver(options) {
  const out = await deliverOpsDigest(options);
  if (out?.ok === false) throw new Error(out.error || 'send failed');
  return out?.channel === 'in_app' ? { channel: 'in_app', id: out.id || null } : { channel: 'email', id: null };
}

// The standing list. Returns { posted, error, items, alertedAt, alertId }: the
// last three are what the run state keeps. It never throws, so a failure
// here cannot stop the records of the same run.
async function postStandingList(standing, state, { now, mailer, to, marked }) {
  const items = failingItems(standing);
  if (!items.length) {
    // A moving-window failure in this run does not matter here: it is a
    // record. If the state write after this close fails, the start mark of
    // startRun makes the next run post.
    await closeStandingAlert(marked);
    return { posted: false, items: [], alertedAt: null, alertId: null };
  }
  const kept = { alertedAt: state?.alertedAt || null, alertId: state?.alertId || null };
  if (nothingNew(state, items, now)) {
    logger.info(`[l2c-invariants] standing list: no new item since the last alert (${state.alertedAt}) — not posted again`);
    // The seam closes the older alert right after it writes a new one, and a
    // failure there is logged, not thrown. Without a retry two alerts would
    // stay pinned until the weekly one. This closes only alerts older than
    // the one the state names, writes nothing when there is none, and never
    // throws.
    await supersedeOlderDigests({ key: STANDING_KEY, row: { id: state.alertId }, enabled: true });
    return { posted: false, items, ...kept };
  }
  // What the state keeps when the feed did not get the alert: the checks that
  // failed before and still fail. A new item stays new for the next run.
  const known = new Set(state?.items || []);
  const unposted = { items: items.filter((item) => known.has(item)), ...kept };
  const report = composeReport(standing, {
    now,
    title: 'lead-to-cash standing list',
    note: 'Standing list: one open alert. A new one replaces it when a check newly fails, or after a week. A clean run closes it.',
  });
  try {
    const sent = await deliver({
      key: STANDING_KEY,
      subject: report.subject,
      html: report.html,
      text: report.text,
      link: '/admin/invoices',
      fallOff: true, // retired by closeStandingAlert, or replaced by the next standing alert
      supersedePrior: true,
      sendEmail: emailSender(mailer, to, report),
    });
    // After the fallback email the feed holds no standing alert: the state
    // stays, so the next run writes it.
    return sent.channel === 'in_app' ? { posted: true, items, alertedAt: now.toISOString(), alertId: sent.id } : { posted: true, ...unposted };
  } catch (error) {
    return { posted: false, error, ...unposted };
  }
}

// The records. Returns { posted, error, seen }: `seen` is what the run state
// keeps. It never throws. `notRun` = the moving-window checks that stand in
// the standing list on this run because they could not run: they saw nothing,
// so the findings they had stay known and do not post again when they run
// again.
async function postRecords(moving, notRun, state, { now, mailer, to }) {
  const failing = moving.filter((r) => !r.ok);
  const before = state?.seen || {};
  const kept = Object.fromEntries(notRun.filter((r) => Array.isArray(before[r.key])).map((r) => [r.key, before[r.key]]));
  const current = { ...kept, ...Object.fromEntries(failing.map((r) => [r.key, findingsNow(r, before[r.key], now)])) };
  // A finding that left is dropped here, so the same finding posts again if
  // it comes back.
  if (!failing.some((r) => hasNewItem(current[r.key], before[r.key]))) return { posted: false, seen: current };
  // What the state keeps when the feed did not get the record: the findings
  // posted before that still stand. A new finding stays new for the next run.
  const unposted = { ...kept, ...Object.fromEntries(failing.map((r) => [r.key, current[r.key].filter((hash) => (before[r.key] || []).includes(hash))])) };
  const shown = moving.map((r) => newFindingsOf(r, before[r.key], now));
  const unchanged = moving.filter((r, i) => !shown[i]).map((r) => `${r.key} (${r.unavailable ? 'could not run' : r.count})`);
  const report = composeReport(shown.filter(Boolean), {
    now,
    note: `Record: new findings only.${unchanged.length ? ` Not in this record, no new finding (the earlier record stands): ${unchanged.join(', ')}.` : ''}`,
  });
  try {
    const sent = await deliver({
      key: RECORD_KEY,
      subject: report.subject,
      html: report.html,
      text: report.text,
      link: '/admin/invoices',
      // One immutable row: no dedupe key, no refresh, no fall-off, no
      // supersede. closeout_failed_facts checks yesterday only, so rewriting
      // or closing a row could replace an unresolved closeout failure (and
      // its IDs) with today's OK line.
      sendEmail: emailSender(mailer, to, report),
    });
    // After the fallback email a finding of a standing window stays new, so
    // the next run writes its record. A closeout day cannot be written later
    // (the next run reads another day): there the email is the record, as it
    // was before this split.
    return { posted: true, seen: sent.channel === 'in_app' ? current : unposted };
  } catch (error) {
    return { posted: false, error, seen: unposted };
  }
}

// In the app: both alerts, each tried by itself, then one write of the run state.
async function postInApp(results, context) {
  const { marked, state } = await startRun(context.now);
  const standing = await postStandingList(results.filter((r) => !isRecordResult(r)), state, { ...context, marked });
  const records = await postRecords(results.filter(isRecordResult), results.filter((r) => r.moving && !isRecordResult(r)), state, context);
  const saved = await writeRunState(context.now, { items: standing.items, alertedAt: standing.alertedAt, alertId: standing.alertId, seen: records.seen });
  // A start that could not be marked is a state fault too (and a clean
  // standing list was then not closed): the run reads as failed.
  return { posted: standing.posted || records.posted, errors: [standing.error, records.error].filter(Boolean), saved: saved && marked };
}

// The email path: one email a run with the whole report, paced by
// sentRecently(). The seam sends it (the in-app feed is off).
async function sendWholeReport(report, { mailer, to }) {
  try {
    await deliver({
      key: RECORD_KEY, subject: report.subject, html: report.html, text: report.text, link: '/admin/invoices',
      sendEmail: emailSender(mailer, to, report),
    });
    return { posted: true, errors: [], saved: true };
  } catch (error) {
    return { posted: false, errors: [error], saved: true };
  }
}

// A run with every check clean, in the app: the standing list is fixed and no
// finding stands. Records are never retired: closeout_failed_facts checks
// yesterday only, and a clean later window does not prove older failures
// (including license facts) were fixed.
// Returns the run's outcome: clean, or state_failed when the run start or the
// clean result could not be saved.
async function recordCleanRun(now) {
  const { marked } = await startRun(now);
  await closeStandingAlert(marked);
  const saved = await writeRunState(now, { items: [], alertedAt: null, alertId: null, seen: {} });
  // Without the start mark the standing alert was not closed: not a clean run yet.
  return saved && marked ? { skipped: 'clean' } : { error: 'state_failed' };
}

// Why a run with exceptions did not end as "sent", or null when it did.
function unsentOutcome({ posted, errors, saved }) {
  // One alert of two can fail. The run then reads as failed (job_health). A
  // rerun posts what is missing; the run state stops a second copy of the
  // alert that did post.
  if (errors.length) return { error: 'send_failed' };
  // The alerts are in the feed but this run's result is not saved. The next
  // run posts instead of trusting an older result; job_health shows why.
  if (!saved) return { error: 'state_failed' };
  return posted ? null : { skipped: 'no_new_item' };
}

/**
 * Cron entry. Returns a plain summary; `error`/`skipped` values other than
 * 'gated' | 'clean' | 'recent_send' | 'no_new_item' mean the sweep did not do
 * its job and the scheduler rethrows so job_health records a failed run
 * (`send_failed`: an alert reached nobody; `state_failed`: the run's result
 * could not be saved).
 */
async function runLeadToCashInvariantSweep({ now = new Date(), mailer = sendgrid, detectors = DETECTORS } = {}) {
  if (!isEnabled('leadToCashInvariantSweep')) return { skipped: 'gated' };
  const results = await runDetectors({ now, detectors });
  const summary = Object.fromEntries(results.map((r) => [r.key, r.unavailable ? 'unavailable' : r.count]));
  const exceptions = results.filter((r) => !r.ok);
  if (!exceptions.length) {
    logger.info(`[l2c-invariants] clean: ${JSON.stringify(summary)}`);
    const outcome = inAppEnabled() ? await recordCleanRun(now) : { skipped: 'clean' };
    return { ...outcome, results: summary };
  }
  const report = composeReport(results, { now });
  logger.warn(`[l2c-invariants] ${report.subject}`);
  if (typeof mailer.isConfigured === 'function' && !mailer.isConfigured()) return { skipped: 'unconfigured', results: summary };
  // FAIL CLOSED: owner/internal inboxes only — a mis-set recipient env skips, never leaks outward.
  const to = sweepEmail();
  if (!isInternalEmailRecipient(to)) return { skipped: 'recipient', results: summary };
  // The 20-hour send marker paces the whole-report email only: nothing else
  // stops a second copy there. In the app the run state does that, and the
  // marker would do harm: after an afternoon rerun that posted, the next
  // morning's run would skip a new closeout failure, and no later run reads
  // that day again.
  const inApp = inAppEnabled();
  if (!inApp && await sentRecently()) return { skipped: 'recent_send', results: summary };
  const delivery = inApp
    ? await postInApp(results, { now, mailer, to })
    : await sendWholeReport(report, { mailer, to });
  for (const err of delivery.errors) logger.error(`[l2c-invariants] send failed: ${scrubSentryText(err?.message || err)}`);
  const unsent = unsentOutcome(delivery);
  if (unsent) return { ...unsent, results: summary };
  if (!inApp) await stampSendMarker();
  return { sent: true, violations: report.total, unavailable: report.unavailable, results: summary };
}

module.exports = {
  runLeadToCashInvariantSweep,
  DETECTORS,
  _private: {
    runDetectors, composeReport, sentRecently, stampSendMarker, failingItems, nothingNew, itemHashes, hasNewItem, trustedState, startRun, writeRunState,
    SEND_MARKER_KEY, RECORD_KEY, STANDING_KEY, RUN_STATE_KEY, REPEAT_AFTER_MS, STATE_FRESH_MS, SAMPLE_IDS, CLOSEOUT_VISIT_CAP,
  },
};
