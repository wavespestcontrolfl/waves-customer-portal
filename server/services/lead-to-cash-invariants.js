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
 *      or rewrites it. One posts when the failing records differ from the
 *      last ones posted, so a 14-day window does not post 14 copies.
 * Rows written before this split are full reports under RECORD_KEY. They get
 * the record treatment: the sweep never touches them.
 * The email path (the in-app feed off) is unchanged: one email a run.
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
const { deliverOpsDigest, inAppEnabled } = require('./ops-digest');
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
// The same failing records are not posted twice inside this time. Longer than
// the longest moving window (14 days), so a finding that sits in its window
// unchanged is one record, not one a day.
const RECORD_DEDUPE_MS = 15 * DAY_MS;
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
// report the same thing.
// ---------------------------------------------------------------------------
const DETECTORS = Object.freeze([
  {
    key: 'churned_live_state',
    label: 'Churned/inactive accounts still carrying live plan state',
    href: '/admin/customers',
    provenance: 'cancellation scope 2026-08-29 — portal cancel never cleared tier/rate/autopay',
    async run() {
      const { auditChurnedAccountsLiveState } = require('../scripts/audit-churned-accounts-live-state');
      const res = await auditChurnedAccountsLiveState({ db });
      return { count: res.withLiveState, ids: res.findings.map((f) => f.id), detail: res.counts };
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
      const ghosts = (Array.isArray(ghost?.rows) ? ghost.rows : []).map((g) => {
        const { lane, flags } = classifyCatalogRow(g);
        return `${g.service_key} (${lane}: ${[`${g.is_archived ? 'archived' : 'inactive'}_service_with_upcoming_visits:${Number(g.upcoming) || 0}`, ...flags].join(',')})`;
      });
      return { count: ghosts.length, ids: ghosts };
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
function failingItems(results) {
  return results.filter((r) => !r.ok).map((r) => (r.unavailable ? `${r.key}:unavailable` : r.key)).sort();
}

// The standing list's last run: { items: string[], alertedAt: ISO|null }, or
// null when there is none or it cannot be read (the caller then posts: a
// state fault never hides a finding).
async function readRunState() {
  try {
    const row = await db('system_settings').where({ key: RUN_STATE_KEY }).first('value');
    const state = row?.value ? JSON.parse(row.value) : null;
    if (!state || !Array.isArray(state.items)) return null;
    const alertedAt = Number.isFinite(Date.parse(state.alertedAt)) ? state.alertedAt : null;
    return { items: state.items.map(String), alertedAt };
  } catch (err) {
    logger.warn(`[l2c-invariants] run-state read failed (${err.message}) — treating every item as new`);
    return null;
  }
}

async function writeRunState(items, alertedAt) {
  try {
    const value = JSON.stringify({ items, alertedAt: alertedAt || null });
    await db('system_settings')
      .insert({ key: RUN_STATE_KEY, value, category: 'ops_digest', description: 'Lead-to-cash sweep: the failing standing checks of the last run and the time of the last standing alert' })
      .onConflict('key')
      .merge({ value, updated_at: new Date() });
  } catch (err) {
    logger.warn(`[l2c-invariants] run-state write failed (${err.message}) — the next run may post again`);
  }
}

// True when this run's failing standing checks were all failing on the last
// run too, and the last standing alert is younger than REPEAT_AFTER_MS.
function nothingNew(state, items, now) {
  if (!state || !state.alertedAt) return false;
  const known = new Set(state.items);
  if (!items.every((item) => known.has(item))) return false;
  return (now.getTime() - Date.parse(state.alertedAt)) < REPEAT_AFTER_MS;
}

// What a record reports, as one short hash: the failing moving-window checks
// with their sampled ids. The same hash = the same records, already posted.
// A check that reads a different window each run (yesterday's closeouts) adds
// the date, so "could not run" on two days is two records. Past the sample
// only the count can show a change, so a truncated list adds its count.
function recordIdentity(results, now) {
  const parts = results.filter((r) => !r.ok).map((r) => [
    r.key,
    r.freshEachRun ? etDateString(now) : null,
    r.unavailable ? 'unavailable' : [...r.sample].sort(),
    r.truncated ? r.count : null,
  ]).sort((a, b) => a[0].localeCompare(b[0]));
  return crypto.createHash('sha1').update(JSON.stringify(parts)).digest('hex').slice(0, 20);
}

const emailSender = (mailer, to, report) => () => mailer.sendOne({
  to, fromEmail: fromEmail(), fromName: FROM_NAME,
  subject: report.subject, html: report.html, text: report.text,
  categories: ['ops', 'lead-to-cash-invariants'], suppressErrorLog: true,
});

// Every standing check ran and passed, so the open standing alert is fixed.
// Records are never retired here: a clean later window does not prove an older
// closeout failure (including license facts) was fixed, and retireIfClean
// names the standing key only. It never throws.
async function closeStandingList() {
  await retireIfClean(STANDING_KEY);
  await writeRunState([], (await readRunState())?.alertedAt);
}

// The standing list. Returns true when an alert was posted. A clean list
// closes the open alert; an unchanged one posts nothing.
async function postStandingList(standing, { now, mailer, to }) {
  const items = failingItems(standing);
  if (!items.length) {
    // A moving-window failure in this run does not matter here: it is a record.
    await closeStandingList();
    return false;
  }
  const state = await readRunState();
  if (nothingNew(state, items, now)) {
    logger.info(`[l2c-invariants] standing list: no new item since the last alert (${state.alertedAt}) — not posted again`);
    await writeRunState(items, state.alertedAt);
    return false;
  }
  const report = composeReport(standing, {
    now,
    title: 'lead-to-cash standing list',
    note: 'Standing list: one open alert. A new one replaces it when a check newly fails, or after a week. A clean run closes it.',
  });
  await deliverOpsDigest({
    key: STANDING_KEY,
    subject: report.subject,
    html: report.html,
    text: report.text,
    link: '/admin/invoices',
    fallOff: true, // retired by retireIfClean (closeStandingList), or replaced by the next standing alert
    supersedePrior: true,
    sendEmail: emailSender(mailer, to, report),
  });
  await writeRunState(items, now.toISOString());
  return true;
}

// The records. Returns true when a record was handed to the feed (the feed
// keeps one row for one identity, so a repeat writes nothing).
async function postRecords(moving, { now, mailer, to }) {
  if (!moving.some((r) => !r.ok)) return false;
  const report = composeReport(moving, { now });
  await deliverOpsDigest({
    key: RECORD_KEY,
    subject: report.subject,
    html: report.html,
    text: report.text,
    link: '/admin/invoices',
    // One immutable row for one set of failing records: no refresh, no
    // fall-off, no supersede. closeout_failed_facts checks yesterday only, so
    // rewriting or closing a row could replace an unresolved closeout failure
    // (and its IDs) with today's OK line. The dedupe finds a row a person
    // already closed too, so a handled record does not come back as a copy.
    dedupeKey: `ops-digest:lead-to-cash-record:${recordIdentity(moving, now)}`,
    dedupeWindowMs: RECORD_DEDUPE_MS,
    sendEmail: emailSender(mailer, to, report),
  });
  return true;
}

/**
 * Cron entry. Returns a plain summary; `error`/`skipped` values other than
 * 'gated' | 'clean' | 'recent_send' | 'no_new_item' mean the sweep did not do
 * its job and the scheduler rethrows so job_health records a failed run.
 */
async function runLeadToCashInvariantSweep({ now = new Date(), mailer = sendgrid, detectors = DETECTORS } = {}) {
  if (!isEnabled('leadToCashInvariantSweep')) return { skipped: 'gated' };
  const results = await runDetectors({ now, detectors });
  const summary = Object.fromEntries(results.map((r) => [r.key, r.unavailable ? 'unavailable' : r.count]));
  const exceptions = results.filter((r) => !r.ok);
  if (!exceptions.length) {
    logger.info(`[l2c-invariants] clean: ${JSON.stringify(summary)}`);
    // closeout_failed_facts checks yesterday only. A clean later window
    // does not prove older failures (including license facts) were fixed,
    // so this run closes the standing list only, never a record.
    if (inAppEnabled()) await closeStandingList();
    return { skipped: 'clean', results: summary };
  }
  const report = composeReport(results, { now });
  logger.warn(`[l2c-invariants] ${report.subject}`);
  if (typeof mailer.isConfigured === 'function' && !mailer.isConfigured()) return { skipped: 'unconfigured', results: summary };
  // FAIL CLOSED: owner/internal inboxes only — a mis-set recipient env skips, never leaks outward.
  const to = sweepEmail();
  if (!isInternalEmailRecipient(to)) return { skipped: 'recipient', results: summary };
  if (await sentRecently()) return { skipped: 'recent_send', results: summary };
  let posted = false;
  try {
    if (inAppEnabled()) {
      const standingPosted = await postStandingList(results.filter((r) => !r.moving), { now, mailer, to });
      const recordPosted = await postRecords(results.filter((r) => r.moving), { now, mailer, to });
      posted = standingPosted || recordPosted;
    } else {
      // The email path is unchanged: one email a run with the whole report,
      // paced by sentRecently(). The seam sends it (the in-app feed is off).
      await deliverOpsDigest({
        key: RECORD_KEY, subject: report.subject, html: report.html, text: report.text, link: '/admin/invoices',
        sendEmail: emailSender(mailer, to, report),
      });
      posted = true;
    }
  } catch (err) {
    logger.error(`[l2c-invariants] send failed: ${scrubSentryText(err?.message || err)}`);
    return { error: 'send_failed', results: summary };
  }
  if (!posted) return { skipped: 'no_new_item', results: summary };
  await stampSendMarker();
  return { sent: true, violations: report.total, unavailable: report.unavailable, results: summary };
}

module.exports = {
  runLeadToCashInvariantSweep,
  DETECTORS,
  _private: {
    runDetectors, composeReport, sentRecently, stampSendMarker, failingItems, nothingNew, recordIdentity, readRunState, writeRunState,
    SEND_MARKER_KEY, RECORD_KEY, STANDING_KEY, RUN_STATE_KEY, REPEAT_AFTER_MS, RECORD_DEDUPE_MS, SAMPLE_IDS, CLOSEOUT_VISIT_CAP,
  },
};
