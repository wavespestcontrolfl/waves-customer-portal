'use strict';

/**
 * Property Alerts engine (portal roadmap bet 6, owner rulings 2026-08-13)
 *
 * Ring-style proactive advisories: a daily sweep evaluates a small registry
 * of rules per customer and delivers each fired alert as a portal bell card
 * + native push (owner ruling: "push and bell") via
 * NotificationService.notifyCustomer, plus a customer_alerts ledger row the
 * portal home card lists.
 *
 * Launch rules (owner-accepted 2026-08-13):
 *   rain_skip_irrigation      — the customer's service area received heavy
 *                               observed rain in the last 3 days; skip the
 *                               next irrigation cycle.
 *   lawn_inspection_reassurance — chinch season + a recent CLEAN lawn visit:
 *                               reassure instead of upsell.
 *
 * Doctrine (inherited from the irrigation weekly email + property score):
 *   - HONESTY: rain windows end YESTERDAY (today's row is forecast-fed);
 *     getAreaRainfall returns null on a partial window and a null never
 *     alerts; the reassurance rule only claims "no activity found" when the
 *     visit's findings actually say so.
 *   - CAPS: per-rule cooldowns + a cross-rule cap of one alert per customer
 *     per CROSS_RULE_CAP_DAYS, enforced on the customer_alerts ledger; the
 *     sweep stops at MAX_ALERTS_PER_RUN.
 *   - QUIET HOURS: the cron runs mid-morning ET, inside the 8AM–8PM window
 *     by construction — notifyCustomer's push path has no send-window fence
 *     of its own (validators/send-window.js exempts non-SMS), so the
 *     schedule IS the fence. Do not move the cron outside the window.
 *   - GATE: GATE_PROPERTY_ALERTS (call-time read). Off = the sweep only
 *     shadow-logs would-fire counts (booking-abandon pattern) — no ledger
 *     rows, no bells, no pushes.
 *   - No SMS and no email anywhere in this lane.
 */

const db = require('../models/db');
const logger = require('./logger');
const { gateEnvValue } = require('../config/feature-gates');
const { getAreaRainfall } = require('./lawn-water-area');
const { CUSTOMER_STAGES } = require('./customer-stages');
const { etParts, etDateString, addETDays } = require('../utils/datetime-et');
const { dateOnlyString } = require('../utils/date-only');
const { detectServiceLine } = require('./service-report/service-line-configs');

const MAX_ALERTS_PER_RUN = 500;
const CROSS_RULE_CAP_DAYS = 7; // at most one alert per customer per week, across rules
const RAIN_WINDOW_DAYS = 3;
const RAIN_ALERT_INCHES = 1.5; // adjusted (calibrated) observed rain that earns the alert
const RAIN_COOLDOWN_DAYS = 7;
const SNAPSHOT_EVIDENCE_DAYS = 45; // same lawn-activity evidence window as the recommendations card
const REASSURE_COOLDOWN_DAYS = 21;
const REASSURE_VISIT_RECENCY_DAYS = 30;
// ET calendar months (0-indexed) when chinch pressure copy is honest —
// Jun–Sep, the SW Florida chinch season.
const CHINCH_SEASON_MONTHS = new Set([5, 6, 7, 8]);

const NOTIFICATION_CATEGORY = 'lawn_health';

// ---------------------------------------------------------------------------
// Rule A — heavy observed rain → skip irrigation
// ---------------------------------------------------------------------------

// Adjusted observed rain per area over the last RAIN_WINDOW_DAYS ET days,
// window ending YESTERDAY. Returns Map<areaId, inches> holding only areas
// that cross the threshold; a partial window (null) never qualifies.
async function triggeredRainAreas({ now = new Date(), knex = db } = {}) {
  const start = etDateString(addETDays(now, -RAIN_WINDOW_DAYS));
  const end = etDateString(addETDays(now, -1));
  const areas = await knex('lawn_water_areas').select('id', 'rain_adjustment_factor');
  const triggered = new Map();
  for (const area of areas) {
    const raw = await getAreaRainfall(area.id, start, end, knex);
    if (raw == null) continue; // partial window — never alert on an undercount
    const factor = Number(area.rain_adjustment_factor || 1) || 1;
    const inches = Math.round(raw * factor * 100) / 100;
    if (inches >= RAIN_ALERT_INCHES) triggered.set(area.id, inches);
  }
  return triggered;
}

async function rainRuleCandidates({ now = new Date(), knex = db } = {}) {
  const triggered = await triggeredRainAreas({ now, knex });
  if (!triggered.size) return [];
  const snapshotCutoff = etDateString(addETDays(now, -SNAPSHOT_EVIDENCE_DAYS));
  // Audience: live customers in a triggered area with recent lawn-program
  // activity (a fresh water snapshot — the same evidence the recommendations
  // card uses; it exists only for serviced lawn customers).
  const rows = await knex('customers as c')
    .join('lawn_water_intake_snapshots as s', 's.customer_id', 'c.id')
    .where('c.active', true)
    .whereNull('c.deleted_at')
    .whereIn('c.pipeline_stage', CUSTOMER_STAGES)
    .whereIn('c.lawn_water_area_id', [...triggered.keys()])
    .where('s.service_date', '>=', snapshotCutoff)
    .groupBy('c.id', 'c.lawn_water_area_id')
    .select('c.id', 'c.lawn_water_area_id');
  const end = etDateString(addETDays(now, -1));
  return rows.map((row) => {
    const inches = triggered.get(row.lawn_water_area_id);
    return {
      customerId: row.id,
      ruleKey: 'rain_skip_irrigation',
      // One alert per rain window: the dedupe key carries the window end
      // day, so the same event never re-fires while cooldown also holds.
      dedupeKey: `rain_skip_irrigation:${end}`,
      title: 'Heavy rain in your area',
      body: `Your service area received about ${inches}" of rain in the last ${RAIN_WINDOW_DAYS} days. We recommend skipping your next irrigation cycle.`,
      payload: { inches, windowDays: RAIN_WINDOW_DAYS, windowEnd: end, areaId: row.lawn_water_area_id },
      cooldownDays: RAIN_COOLDOWN_DAYS,
    };
  });
}

// ---------------------------------------------------------------------------
// Rule B — chinch season + a recent clean lawn visit → reassurance
// ---------------------------------------------------------------------------

async function reassuranceRuleCandidates({ now = new Date(), knex = db } = {}) {
  const monthIndex = etParts(now).month - 1;
  if (!CHINCH_SEASON_MONTHS.has(monthIndex)) return [];
  const visitCutoff = etDateString(addETDays(now, -REASSURE_VISIT_RECENCY_DAYS));
  const rows = await knex('service_records as sr')
    .join('customers as c', 'c.id', 'sr.customer_id')
    .where('c.active', true)
    .whereNull('c.deleted_at')
    .whereIn('c.pipeline_stage', CUSTOMER_STAGES)
    .where('sr.status', 'completed')
    .where('sr.service_date', '>=', visitCutoff)
    .orderBy('sr.service_date', 'desc')
    .select('sr.id as service_record_id', 'sr.customer_id', 'sr.service_type', 'sr.service_date');
  // Newest lawn-line visit per customer.
  const latestByCustomer = new Map();
  for (const row of rows) {
    if (detectServiceLine(row.service_type) !== 'lawn') continue;
    if (!latestByCustomer.has(row.customer_id)) latestByCustomer.set(row.customer_id, row);
  }
  if (!latestByCustomer.size) return [];
  // "No activity found" may only be said when the visit's findings say so
  // EXPLICITLY (codex pre-push P1): the visit must carry the technician's
  // no_activity finding, and ANY other finding — whatever its severity —
  // vetoes the claim. A visit with no findings rows at all proves nothing
  // and never reassures. Fail closed: an unreadable findings table skips
  // the rule entirely (the query throw rides the sweep's per-rule catch).
  const recordIds = [...latestByCustomer.values()].map((r) => r.service_record_id);
  const findingRows = await knex('service_findings')
    .whereIn('service_record_id', recordIds)
    .select('service_record_id', 'category');
  const hasNoActivity = new Set();
  const vetoed = new Set();
  for (const f of findingRows) {
    if (f.category === 'no_activity') hasNoActivity.add(f.service_record_id);
    else vetoed.add(f.service_record_id);
  }
  const today = etDateString(now);
  const toUtcNoonMs = (key) => {
    const [y, m, d] = String(key).split('-').map(Number);
    return Date.UTC(y, m - 1, d, 12);
  };
  const candidates = [];
  for (const visit of latestByCustomer.values()) {
    if (!hasNoActivity.has(visit.service_record_id)) continue;
    if (vetoed.has(visit.service_record_id)) continue;
    const visitDay = dateOnlyString(visit.service_date);
    if (!visitDay) continue;
    const daysAgo = Math.round((toUtcNoonMs(today) - toUtcNoonMs(visitDay)) / (24 * 3600 * 1000));
    if (daysAgo < 0 || daysAgo > REASSURE_VISIT_RECENCY_DAYS) continue;
    candidates.push({
      customerId: visit.customer_id,
      ruleKey: 'lawn_inspection_reassurance',
      // One reassurance per visit — the key carries the record id.
      dedupeKey: `lawn_inspection_reassurance:${visit.service_record_id}`,
      title: 'Chinch bug conditions: elevated',
      body: `Summer heat favors chinch bug activity in Southwest Florida lawns. Your lawn was inspected ${daysAgo} day${daysAgo === 1 ? '' : 's'} ago — no chinch bug activity was found.`,
      payload: { serviceRecordId: visit.service_record_id, visitDay, daysAgo },
      cooldownDays: REASSURE_COOLDOWN_DAYS,
    });
  }
  return candidates;
}

const RULES = [rainRuleCandidates, reassuranceRuleCandidates];

// ---------------------------------------------------------------------------
// Caps + delivery
// ---------------------------------------------------------------------------

// A candidate survives when: no alert for this customer (ANY rule) within
// CROSS_RULE_CAP_DAYS, no alert for this rule within its own cooldown, and
// this exact dedupe key never fired.
async function candidatePassesCaps(candidate, { now = new Date(), knex = db } = {}) {
  const recent = await knex('customer_alerts')
    .where({ customer_id: candidate.customerId })
    .where('fired_at', '>=', addETDays(now, -Math.max(CROSS_RULE_CAP_DAYS, candidate.cooldownDays)))
    .select('rule_key', 'dedupe_key', 'fired_at');
  const capMs = CROSS_RULE_CAP_DAYS * 24 * 3600 * 1000;
  const cooldownMs = candidate.cooldownDays * 24 * 3600 * 1000;
  for (const row of recent) {
    if (row.dedupe_key === candidate.dedupeKey) return false;
    const age = now.getTime() - new Date(row.fired_at).getTime();
    if (age < capMs) return false;
    if (row.rule_key === candidate.ruleKey && age < cooldownMs) return false;
  }
  return true;
}

async function deliverAlert(candidate, { knex = db } = {}) {
  // NOTIFY FIRST, ledger after (codex pre-push P1): the ledger row feeds the
  // portal card and consumes the frequency cap, so it may only exist for an
  // alert the customer actually received. notifyCustomer checks the
  // preference, dedupes on (customerId, dedupeKey) under an advisory lock
  // (the multi-pod double-fire guard), and returns null on a create/dedupe
  // failure — none of those outcomes ledger anything, so a failed send is
  // retried by the next sweep instead of being silently consumed.
  const NotificationService = require('./notification-service');
  const result = await NotificationService.notifyCustomer(
    candidate.customerId,
    NOTIFICATION_CATEGORY,
    candidate.title,
    candidate.body,
    {
      link: '/',
      dedupeKey: candidate.dedupeKey,
      // notification_prefs.weather_alerts (default true) — the customer's
      // opt-out for weather/property advisories.
      preferenceKey: 'weather_alerts',
    }
  );
  if (!result) return { delivered: false, reason: 'notify_failed' };
  if (result.suppressed) return { delivered: false, reason: 'preference_disabled' };

  // The bell is durable — ledger the alert. onConflict ignore covers the
  // self-heal path: a prior run whose bell landed but whose ledger insert
  // failed re-reaches here via notifyCustomer's dedupe (no second push) and
  // backfills the row.
  try {
    await knex('customer_alerts')
      .insert({
        customer_id: candidate.customerId,
        rule_key: candidate.ruleKey,
        dedupe_key: candidate.dedupeKey,
        title: candidate.title,
        body: candidate.body,
        payload: JSON.stringify(candidate.payload || {}),
      })
      .onConflict(['customer_id', 'dedupe_key'])
      .ignore()
      .returning('id');
  } catch (err) {
    // The customer HAS the bell; the missing ledger row self-heals on the
    // next sweep (dedupe prevents a duplicate push).
    logger.warn(`[property-alerts] ledger insert failed after delivery (${candidate.ruleKey}): ${err.message}`);
  }
  return { delivered: true, deduped: !!result.deduped };
}

// ---------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------

async function runPropertyAlertsSweep({ now = new Date(), knex = db, maxAlerts = MAX_ALERTS_PER_RUN } = {}) {
  const gateOn = gateEnvValue('GATE_PROPERTY_ALERTS');
  const summary = { gate: gateOn ? 'on' : 'off', candidates: 0, delivered: 0, capped: 0, skipped: 0 };

  const candidates = [];
  for (const rule of RULES) {
    try {
      candidates.push(...await rule({ now, knex }));
    } catch (err) {
      // One rule's failure never blocks the others.
      logger.warn(`[property-alerts] rule failed (${rule.name}): ${err.message}`);
    }
  }
  summary.candidates = candidates.length;

  if (!gateOn) {
    // Shadow mode: report what WOULD fire so the flip decision has data.
    logger.info(`[property-alerts] gate off — would evaluate ${candidates.length} candidate(s)`);
    return summary;
  }

  for (const candidate of candidates) {
    if (summary.delivered >= maxAlerts) {
      // No silent caps: say what was dropped.
      logger.warn(`[property-alerts] run cap ${maxAlerts} reached — ${candidates.length - summary.delivered - summary.capped - summary.skipped} candidate(s) deferred to the next run`);
      break;
    }
    try {
      if (!(await candidatePassesCaps(candidate, { now, knex }))) {
        summary.capped += 1;
        continue;
      }
      const outcome = await deliverAlert(candidate, { knex });
      if (outcome.delivered) summary.delivered += 1;
      else summary.skipped += 1;
    } catch (err) {
      summary.skipped += 1;
      logger.warn(`[property-alerts] candidate failed (${candidate.ruleKey}/${candidate.customerId}): ${err.message}`);
    }
  }
  return summary;
}

// Recent alerts for the portal card (route-facing read).
async function listCustomerAlerts(customerId, { knex = db, limit = 5, withinDays = 30 } = {}) {
  const rows = await knex('customer_alerts')
    .where({ customer_id: customerId })
    .where('fired_at', '>=', addETDays(new Date(), -withinDays))
    .orderBy('fired_at', 'desc')
    .limit(limit)
    .select('id', 'rule_key', 'title', 'body', 'fired_at');
  return rows.map((row) => ({
    id: row.id,
    ruleKey: row.rule_key,
    title: row.title,
    body: row.body,
    firedAt: row.fired_at,
  }));
}

module.exports = {
  runPropertyAlertsSweep,
  listCustomerAlerts,
  _test: {
    triggeredRainAreas,
    rainRuleCandidates,
    reassuranceRuleCandidates,
    candidatePassesCaps,
    deliverAlert,
    RAIN_ALERT_INCHES,
    CHINCH_SEASON_MONTHS,
    CROSS_RULE_CAP_DAYS,
  },
};
