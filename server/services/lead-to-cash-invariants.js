'use strict';
/**
 * Lead-to-cash invariants sweep — READ-ONLY registry over EXISTING detectors.
 *
 * Every check below already exists somewhere in the repo with its own incident
 * provenance; this module only (1) gives each a common finding shape,
 * (2) runs them together once a day, and (3) emails contact@ when — and only
 * when — something is off. It adds NO new predicates, writes NO rows except the
 * ops-email send marker, and never talks to a customer. Two of the checks
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
 * Gate: GATE_LEAD_TO_CASH_SWEEP=true (feature-gates `leadToCashInvariantSweep`;
 * kill = unset). Cron: 6:55 ET daily (scheduler.js), after the 6:00 estimate
 * conversion guard and the 6:40 schedule-integrity watchdog on purpose — the
 * `converted_open_estimates` check asserts that guard converged.
 *
 * PII: findings carry ids, counts, and flag names only — never names, phones,
 * emails, or addresses (AGENTS.md PII-in-logs / PII-in-repo rules).
 */

const db = require('../models/db');
const logger = require('./logger');
const sendgrid = require('./sendgrid-mail');
const { isEnabled } = require('../config/feature-gates');
const { isInternalEmailRecipient } = require('../utils/internal-email-recipients');
const { etDateString } = require('../utils/datetime-et');
const { scrubSentryText, safeErrorToken } = require('../utils/sentry-scrub');

const SEND_MARKER_KEY = 'lead-to-cash-invariants';
const TWENTY_HOURS_MS = 20 * 60 * 60 * 1000;
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
    href: '/admin/services',
    provenance: 'universal one-time services plan §5 Phase B — ops/agents/completion-lane-coverage.js',
    async run({ now }) {
      const { ALL_LISTS, classifyCatalogRow } = require('../config/completion-lane-registry');
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
      const stale = registryKeys.filter((k) => !known.has(k)).map((k) => `registry-only:${k}`);
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
      return {
        count: defects.length + stale.length + ghosts.length,
        ids: [...defects, ...stale, ...ghosts],
        detail: { activeServices: rows.length, ghostLanes: ghosts.length },
      };
    },
  },
  {
    key: 'unbilled_completed_visits',
    label: "Yesterday's completed visits that billed nothing because no rate or price was on the account",
    href: '/admin/dispatch',
    provenance: 'prod 2026-08-31 — a hand-booked customer took recurring visits at monthly_rate 0; the sheet said "nothing bills" and nothing else did',
    async run({ now }) {
      const { resolveBillingLane, predictCompletionBilling, unbilledCompletionGap } = require('./billing-lane');
      const yesterday = etDateString(new Date(now.getTime() - 24 * 60 * 60 * 1000));
      // Re-runs the SAME prediction the sheet and the completion path use —
      // never a SQL re-derivation of the billing decision (the 2026-07
      // double-billing incident came from a second classifier).
      const visits = await db('scheduled_services as ss')
        .leftJoin('customers as c', 'c.id', 'ss.customer_id')
        .where({ 'ss.status': 'completed', 'ss.scheduled_date': yesterday })
        .orderBy('ss.id')
        .limit(CLOSEOUT_VISIT_CAP + 1)
        .select(
          'ss.id', 'ss.estimated_price', 'ss.is_callback', 'ss.is_recurring', 'ss.service_type',
          // scheduled_services.payer_id is the real per-job column;
          // billed_to_payer_id is only an alias the schedule query builds, so
          // selecting it threw in Postgres and made this detector unavailable
          // on EVERY sweep (Codex P1). Presence is not the verdict either —
          // resolveForInvoice below is.
          'ss.payer_id', 'ss.customer_id', 'ss.prepaid_amount', 'ss.prepaid_method',
          'c.billing_mode', 'c.monthly_rate', 'c.waveguard_tier', 'c.per_application_fee',
        );
      const truncated = visits.length > CLOSEOUT_VISIT_CAP;
      const ids = [];
      if (truncated) {
        // FAIL CLOSED on the cap, exactly like closeout_failed_facts.
        const overflow = await db('scheduled_services')
          .where({ status: 'completed', scheduled_date: yesterday }).count({ n: 'id' }).first();
        const notEvaluated = Math.max(1, (Number(overflow?.n) || 0) - CLOSEOUT_VISIT_CAP);
        ids.push(`[truncated: ${notEvaluated} completed visit(s) beyond the ${CLOSEOUT_VISIT_CAP}-visit cap were not evaluated]`);
      }
      // An invoice that DID mint settles the question regardless of what the
      // prediction says now — completion may have stamped a price the
      // prediction can no longer see.
      const evaluated = visits.slice(0, CLOSEOUT_VISIT_CAP);
      // VOID invoices are not proof of billing — the completion and schedule
      // paths both exclude them, and a stale void would otherwise suppress a
      // visit that now has no bill at all (Codex P1).
      const invoicedIds = new Set(
        evaluated.length
          ? (await db('invoices')
            .whereIn('scheduled_service_id', evaluated.map((v) => v.id))
            .whereNot('status', 'void')
            .select('scheduled_service_id'))
            .map((r) => r.scheduled_service_id)
          : [],
      );
      const { resolveForInvoice } = require('./payer');
      for (const v of evaluated) {
        if (invoicedIds.has(v.id)) continue;
        // Canonical active-payer resolution for EVERY visit, with BOTH ids.
        // Gating the call on ss.payer_id skipped visits that inherit an active
        // customers.payer_id default, reporting payer-billed work as a
        // no-amount gap (Codex P1); passing customerId is also what makes
        // self_pay_override resolve the way completion resolves it.
        // resolveForInvoice never throws.
        const payerBilled = !!(await resolveForInvoice({
          database: db,
          scheduledServiceId: v.id,
          customerId: v.customer_id,
        })).payerId;
        const lane = resolveBillingLane({
          billing_mode: v.billing_mode,
          waveguard_tier: v.waveguard_tier,
          monthly_rate: v.monthly_rate,
        });
        const prediction = predictCompletionBilling({
          lane: lane.mode,
          billingMode: v.billing_mode || null,
          // Autopay/dues state is a SETTLEMENT detail; the gap this detector
          // hunts is "no number exists at all", which neither can create or
          // cure. Left at the conservative defaults so an unreadable wallet
          // never manufactures a finding.
          autopayActive: false,
          estimatedPrice: v.estimated_price != null ? Number(v.estimated_price) : null,
          monthlyRate: v.monthly_rate,
          perApplicationFee: v.per_application_fee,
          isRecurring: !!v.is_recurring,
          isCallback: !!v.is_callback,
          serviceType: v.service_type,
          payerBilled,
          prepaidAmount: v.prepaid_amount,
          prepaidMethod: v.prepaid_method || null,
        });
        // hasChargeableMethod omitted: the wallet only sharpens the tech's
        // on-site message, and this detector reports ids only (PII rule).
        // Label from the GAP, not the prediction: a payer-billed prediction
        // carries no `reason` of its own, and the gap is the thing being
        // reported.
        const gap = unbilledCompletionGap({ prediction });
        if (gap) ids.push(`${v.id} [${gap.reason}]`);
      }
      return { count: ids.length, ids, detail: { checked: evaluated.length, date: yesterday, truncated } };
    },
  },
  {
    key: 'closeout_failed_facts',
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
        key: d.key, label: d.label, href: d.href, ok: out.count === 0, unavailable: false,
        count: Number(out.count) || 0, sample: ids.slice(0, SAMPLE_IDS), truncated: ids.length > SAMPLE_IDS,
        detail: out.detail || null, ms: Date.now() - started,
      });
    } catch (err) {
      // Egress discipline (sentry-scrub header): the emailed `error` is a
      // FIXED allowlisted token (err.code / err.name), never prose — provider
      // and Knex messages can embed phone numbers, emails, or SQL literals.
      // The log line carries the scrubbed message for triage.
      logger.error(`[l2c-invariants] ${d.key} unavailable: ${scrubSentryText(err?.message || err)}`);
      results.push({
        key: d.key, label: d.label, href: d.href, ok: false, unavailable: true,
        count: 0, sample: [], truncated: false, detail: null,
        error: safeErrorToken(err?.code) || safeErrorToken(err?.name) || 'error', ms: Date.now() - started,
      });
    }
  }
  return results;
}

function composeReport(results, { now = new Date() } = {}) {
  const violated = results.filter((r) => !r.ok && !r.unavailable);
  const unavailable = results.filter((r) => r.unavailable);
  const total = violated.reduce((s, r) => s + r.count, 0);
  const parts = [];
  if (total) parts.push(`${total} violation${total === 1 ? '' : 's'} across ${violated.length} check${violated.length === 1 ? '' : 's'}`);
  if (unavailable.length) parts.push(`${unavailable.length} check${unavailable.length === 1 ? '' : 's'} could not run`);
  const subject = `FIX: lead-to-cash invariants — ${parts.join('; ')} (${etDateString(now)})`;

  const lines = [];
  for (const r of results) {
    if (r.ok) { lines.push(`OK   ${r.key}`); continue; }
    if (r.unavailable) { lines.push(`??   ${r.key} — could not run (${r.error}); see server log`); continue; }
    lines.push(`FAIL ${r.key} — ${r.count}: ${r.label}`);
    if (r.detail) lines.push(`     ${Object.entries(r.detail).map(([k, v]) => `${k}=${v}`).join(' ')}`);
    if (r.sample.length) lines.push(`     ${r.sample.join(', ')}${r.truncated ? ` … +${r.count - r.sample.length} more` : ''}`);
    lines.push(`     ${r.href}`);
  }
  lines.push('', 'Read-only sweep; nothing was changed. Registry: server/services/lead-to-cash-invariants.js');
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

/**
 * Cron entry. Returns a plain summary; `error`/`skipped` values other than
 * 'gated' | 'clean' | 'recent_send' mean the sweep did not do its job and the
 * scheduler rethrows so job_health records a failed run.
 */
async function runLeadToCashInvariantSweep({ now = new Date(), mailer = sendgrid, detectors = DETECTORS } = {}) {
  if (!isEnabled('leadToCashInvariantSweep')) return { skipped: 'gated' };
  const results = await runDetectors({ now, detectors });
  const summary = Object.fromEntries(results.map((r) => [r.key, r.unavailable ? 'unavailable' : r.count]));
  const exceptions = results.filter((r) => !r.ok);
  if (!exceptions.length) {
    logger.info(`[l2c-invariants] clean: ${JSON.stringify(summary)}`);
    return { skipped: 'clean', results: summary };
  }
  const report = composeReport(results, { now });
  logger.warn(`[l2c-invariants] ${report.subject}`);
  if (typeof mailer.isConfigured === 'function' && !mailer.isConfigured()) return { skipped: 'unconfigured', results: summary };
  // FAIL CLOSED: owner/internal inboxes only — a mis-set recipient env skips, never leaks outward.
  const to = sweepEmail();
  if (!isInternalEmailRecipient(to)) return { skipped: 'recipient', results: summary };
  if (await sentRecently()) return { skipped: 'recent_send', results: summary };
  try {
    await mailer.sendOne({
      to, fromEmail: fromEmail(), fromName: FROM_NAME,
      subject: report.subject, html: report.html, text: report.text,
      categories: ['ops', 'lead-to-cash-invariants'], suppressErrorLog: true,
    });
  } catch (err) {
    logger.error(`[l2c-invariants] send failed: ${scrubSentryText(err?.message || err)}`);
    return { error: 'send_failed', results: summary };
  }
  await stampSendMarker();
  return { sent: true, violations: report.total, unavailable: report.unavailable, results: summary };
}

module.exports = {
  runLeadToCashInvariantSweep,
  DETECTORS,
  _private: { runDetectors, composeReport, sentRecently, stampSendMarker, SEND_MARKER_KEY, SAMPLE_IDS, CLOSEOUT_VISIT_CAP },
};
