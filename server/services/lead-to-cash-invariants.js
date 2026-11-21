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
 *      copies and a finding that cleared and came back posts again.
 * The run state (one system_settings row) holds what the last run found. A
 * state that is missing or cannot be read never hides a finding: it posts.
 * The state moves forward only for an alert the feed holds, so a failed
 * write is tried again on the next run.
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
// The most findings of one moving-window check the run state keeps (as short
// hashes). Past this number only the count can show a new finding.
const ITEM_KEYS_CAP = 300;
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
        itemKeys: Array.isArray(out.itemKeys) ? out.itemKeys.map(String) : ids, listCapped: out.truncated === true,
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
        itemKeys: [], listCapped: false,
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

// The last run, from the run state: { items, alertedAt, seen }.
//   items     the standing checks that failed (failingItems)
//   alertedAt the time of the last standing alert the feed holds, or null
//   seen      for each failing moving-window check, its findings (itemHashes)
// null when there is none or it cannot be read. The callers then post: a
// state fault never hides a finding.
async function readRunState() {
  try {
    const row = await db('system_settings').where({ key: RUN_STATE_KEY }).first('value');
    const state = row?.value ? JSON.parse(row.value) : null;
    if (!state || !Array.isArray(state.items)) return null;
    const alertedAt = Number.isFinite(Date.parse(state.alertedAt)) ? state.alertedAt : null;
    const seen = state.seen && typeof state.seen === 'object' && !Array.isArray(state.seen) ? state.seen : {};
    return {
      items: state.items.map(String),
      alertedAt,
      seen: Object.fromEntries(Object.entries(seen).filter(([, hashes]) => Array.isArray(hashes)).map(([key, hashes]) => [key, hashes.map(String)])),
    };
  } catch (err) {
    logger.warn(`[l2c-invariants] run-state read failed (${err.message}) — treating every item as new`);
    return null;
  }
}

async function writeRunState({ items, alertedAt, seen }) {
  try {
    const value = JSON.stringify({ items, alertedAt: alertedAt || null, seen: seen || {} });
    await db('system_settings')
      .insert({ key: RUN_STATE_KEY, value, category: 'ops_digest', description: 'Lead-to-cash sweep: what the last run found (failing standing checks, time of the last standing alert, moving-window findings as hashes)' })
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

const shortHash = (text) => crypto.createHash('sha1').update(String(text)).digest('hex').slice(0, 16);

// The findings of one failing moving-window check, as short hashes: what the
// run state keeps to tell a new finding from one already posted (it holds no
// record id). A check that reads a different window on each run (yesterday's
// closeouts) adds the date, so the same visit id, or "could not run", on two
// days is two findings. A list that does not name every finding (the check
// returned a part, the cap cut it, or it gave no ids) cannot show a new one,
// so its count joins the list and any change of the count is a new finding.
function itemHashes(r, now) {
  const scope = `${r.freshEachRun ? etDateString(now) : ''}|${r.key}|`;
  if (r.unavailable) return [shortHash(`${scope}unavailable`)];
  const all = [...new Set(r.itemKeys)].sort();
  const keys = all.slice(0, ITEM_KEYS_CAP);
  if (r.listCapped || all.length > keys.length || !keys.length) keys.push(`count:${r.count}`);
  return keys.map((key) => shortHash(scope + key)).sort();
}

function hasNewItem(hashes, seen) {
  const known = new Set(Array.isArray(seen) ? seen : []);
  return hashes.some((hash) => !known.has(hash));
}

const emailSender = (mailer, to, report) => () => mailer.sendOne({
  to, fromEmail: fromEmail(), fromName: FROM_NAME,
  subject: report.subject, html: report.html, text: report.text,
  categories: ['ops', 'lead-to-cash-invariants'], suppressErrorLog: true,
});

// One alert through the digest seam. 'in_app' = the feed holds the row.
// 'email' = the feed write failed and the seam's fallback email went out.
// An alert that reached nobody throws.
async function deliver(options) {
  const out = await deliverOpsDigest(options);
  if (out?.ok === false) throw new Error(out.error || 'send failed');
  return out?.channel === 'in_app' ? 'in_app' : 'email';
}

// The standing list. Returns { posted, error, items, alertedAt }: the last two
// are what the run state keeps. It never throws, so a failure here cannot
// stop the records of the same run.
async function postStandingList(standing, state, { now, mailer, to }) {
  const items = failingItems(standing);
  const alertedAt = state?.alertedAt || null;
  if (!items.length) {
    // Every standing check ran and passed, so the open standing alert is
    // fixed. A moving-window failure in this run does not matter here (it is
    // a record), and retireIfClean names the standing key only, so it can
    // never close a record. It never throws.
    await retireIfClean(STANDING_KEY);
    return { posted: false, items: [], alertedAt: null }; // an empty list: the next failing check is new
  }
  if (nothingNew(state, items, now)) {
    logger.info(`[l2c-invariants] standing list: no new item since the last alert (${state.alertedAt}) — not posted again`);
    return { posted: false, items, alertedAt };
  }
  // What the state keeps when the feed did not get the alert: the checks that
  // failed before and still fail. A new item stays new for the next run.
  const known = new Set(state?.items || []);
  const unposted = { items: items.filter((item) => known.has(item)), alertedAt };
  const report = composeReport(standing, {
    now,
    title: 'lead-to-cash standing list',
    note: 'Standing list: one open alert. A new one replaces it when a check newly fails, or after a week. A clean run closes it.',
  });
  try {
    const channel = await deliver({
      key: STANDING_KEY,
      subject: report.subject,
      html: report.html,
      text: report.text,
      link: '/admin/invoices',
      fallOff: true, // retired by retireIfClean above, or replaced by the next standing alert
      supersedePrior: true,
      sendEmail: emailSender(mailer, to, report),
    });
    // After the fallback email the feed holds no standing alert: the state
    // stays, so the next run writes it.
    return channel === 'in_app' ? { posted: true, items, alertedAt: now.toISOString() } : { posted: true, ...unposted };
  } catch (error) {
    return { posted: false, error, ...unposted };
  }
}

// The records. Returns { posted, error, seen }: `seen` is what the run state
// keeps. It never throws.
async function postRecords(moving, state, { now, mailer, to }) {
  const failing = moving.filter((r) => !r.ok);
  const before = state?.seen || {};
  const current = Object.fromEntries(failing.map((r) => [r.key, itemHashes(r, now)]));
  // A finding that left is dropped here, so the same finding posts again if
  // it comes back.
  if (!failing.some((r) => hasNewItem(current[r.key], before[r.key]))) return { posted: false, seen: current };
  // What the state keeps when the feed did not get the record: the findings
  // posted before that still stand. A new finding stays new for the next run.
  const unposted = Object.fromEntries(failing.map((r) => [r.key, current[r.key].filter((hash) => (before[r.key] || []).includes(hash))]));
  const report = composeReport(moving, { now });
  try {
    const channel = await deliver({
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
    return { posted: true, seen: channel === 'in_app' ? current : unposted };
  } catch (error) {
    return { posted: false, error, seen: unposted };
  }
}

// In the app: both alerts, each tried by itself, then one write of the run state.
async function postInApp(results, context) {
  const state = await readRunState();
  const standing = await postStandingList(results.filter((r) => !r.moving), state, context);
  const records = await postRecords(results.filter((r) => r.moving), state, context);
  await writeRunState({ items: standing.items, alertedAt: standing.alertedAt, seen: records.seen });
  return { posted: standing.posted || records.posted, errors: [standing.error, records.error].filter(Boolean) };
}

// The email path is unchanged: one email a run with the whole report, paced
// by sentRecently(). The seam sends it (the in-app feed is off).
async function sendWholeReport(report, { mailer, to }) {
  try {
    await deliverOpsDigest({
      key: RECORD_KEY, subject: report.subject, html: report.html, text: report.text, link: '/admin/invoices',
      sendEmail: emailSender(mailer, to, report),
    });
    return { posted: true, errors: [] };
  } catch (error) {
    return { posted: false, errors: [error] };
  }
}

// A run with every check clean, in the app: the standing list is fixed and no
// finding stands. Records are never retired: closeout_failed_facts checks
// yesterday only, and a clean later window does not prove older failures
// (including license facts) were fixed.
async function recordCleanRun() {
  await retireIfClean(STANDING_KEY);
  await writeRunState({ items: [], alertedAt: null, seen: {} });
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
    if (inAppEnabled()) await recordCleanRun();
    return { skipped: 'clean', results: summary };
  }
  const report = composeReport(results, { now });
  logger.warn(`[l2c-invariants] ${report.subject}`);
  if (typeof mailer.isConfigured === 'function' && !mailer.isConfigured()) return { skipped: 'unconfigured', results: summary };
  // FAIL CLOSED: owner/internal inboxes only — a mis-set recipient env skips, never leaks outward.
  const to = sweepEmail();
  if (!isInternalEmailRecipient(to)) return { skipped: 'recipient', results: summary };
  if (await sentRecently()) return { skipped: 'recent_send', results: summary };
  const { posted, errors } = inAppEnabled()
    ? await postInApp(results, { now, mailer, to })
    : await sendWholeReport(report, { mailer, to });
  for (const err of errors) logger.error(`[l2c-invariants] send failed: ${scrubSentryText(err?.message || err)}`);
  // One alert of two can fail. The run then reads as failed (job_health), and
  // the send marker stays unset so a rerun can post what is missing; the run
  // state stops a second copy of the alert that did post.
  if (errors.length) return { error: 'send_failed', results: summary };
  if (!posted) return { skipped: 'no_new_item', results: summary };
  await stampSendMarker();
  return { sent: true, violations: report.total, unavailable: report.unavailable, results: summary };
}

module.exports = {
  runLeadToCashInvariantSweep,
  DETECTORS,
  _private: {
    runDetectors, composeReport, sentRecently, stampSendMarker, failingItems, nothingNew, itemHashes, hasNewItem, readRunState, writeRunState,
    SEND_MARKER_KEY, RECORD_KEY, STANDING_KEY, RUN_STATE_KEY, REPEAT_AFTER_MS, ITEM_KEYS_CAP, SAMPLE_IDS, CLOSEOUT_VISIT_CAP,
  },
};
