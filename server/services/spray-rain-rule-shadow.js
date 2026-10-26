'use strict';

// GATE_SPRAY_RAIN_RULES=shadow (owner 2026-10-26, plan page "Visit-Day Rain Rule"): records, per visit and
// visit day, the WORST verdict the rain rules would have shown (spray_rain_rule_shadow), next to the chip
// the board shows today. Written from a visit-day job card or readiness build (job-card.js); nothing reads
// it to decide anything. A row is refreshed at most every 10 minutes unless the verdict got worse, so the
// board's 60-second readiness poll does not write every minute.
const db = require('../models/db');

const RANK_SQL = (table) => `CASE ${table}.shadow_status WHEN 'hold' THEN 3 WHEN 'caution' THEN 2 WHEN 'unknown' THEN 1 ELSE 0 END`;
const RANK = { ok: 0, unknown: 1, caution: 2, hold: 3 };
// Columns that describe the worst read; they move only when a read is worse than the stored one.
const PEAK_COLUMNS = ['shadow_status', 'shadow_label', 'live_label', 'start_pop', 'max_pop_4h', 'dose_hidden', 'products'];

function maxOrNull(values) {
  const known = values.filter((v) => v != null && Number.isFinite(Number(v))).map(Number);
  return known.length ? Math.max(...known) : null;
}

function shadowRow({ facts, products = [], hourly = null, serviceInstant, live, shadow }) {
  const start = serviceInstant.getTime();
  const rows = Array.isArray(hourly) ? hourly : [];
  const hourStart = (h) => Date.parse(h.startTime);
  const startRow = rows.find((h) => Number.isFinite(hourStart(h)) && hourStart(h) <= start && start < hourStart(h) + 3600000);
  const next4h = rows.filter((h) => Number.isFinite(hourStart(h)) && hourStart(h) + 3600000 > start && hourStart(h) < start + 4 * 3600000);
  const names = new Map(products.map((p) => [p.id, p.name]));
  const status = shadow.verdicts.reduce((worst, v) => (RANK[v.verdict] > RANK[worst] ? v.verdict : worst), 'ok');
  return {
    scheduled_service_id: facts.serviceId,
    visit_date: facts.scheduledDate,
    start_at: serviceInstant.toISOString(),
    service_type: String(facts.serviceType || '').slice(0, 120) || null,
    live_label: live.issue?.label || null,
    live_hold: Boolean(live.hold),
    shadow_status: status,
    shadow_label: shadow.issue?.label || null,
    start_pop: startRow?.rainChance ?? null,
    max_pop_4h: maxOrNull(next4h.map((h) => h.rainChance)),
    dose_hidden: shadow.verdicts.some((v) => v.verdict === 'hold'),
    products: JSON.stringify(shadow.verdicts.map((v) => ({
      name: names.get(v.productId) || null, verdict: v.verdict, reason: v.reason || null, source: v.source || null,
    }))),
  };
}

async function recordSprayRainShadow({ dbh = db, ...input }) {
  const row = shadowRow(input);
  if (!row.scheduled_service_id || !row.visit_date) return null;
  const worse = `${RANK_SQL('EXCLUDED')} > ${RANK_SQL('spray_rain_rule_shadow')}`;
  const peakSet = PEAK_COLUMNS
    .map((column) => `${column} = CASE WHEN ${worse} THEN EXCLUDED.${column} ELSE spray_rain_rule_shadow.${column} END`)
    .join(',\n      ');
  return dbh.raw(`
    INSERT INTO spray_rain_rule_shadow (scheduled_service_id, visit_date, start_at, service_type, live_label, live_hold,
      shadow_status, shadow_label, start_pop, max_pop_4h, dose_hidden, products)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb)
    ON CONFLICT (scheduled_service_id, visit_date) DO UPDATE SET
      ${peakSet},
      peak_at = CASE WHEN ${worse} THEN now() ELSE spray_rain_rule_shadow.peak_at END,
      live_hold = spray_rain_rule_shadow.live_hold OR EXCLUDED.live_hold,
      start_at = EXCLUDED.start_at,
      service_type = EXCLUDED.service_type,
      reads = spray_rain_rule_shadow.reads + 1,
      last_seen_at = now()
    WHERE ${worse} OR spray_rain_rule_shadow.last_seen_at < now() - interval '10 minutes'`, [
    row.scheduled_service_id, row.visit_date, row.start_at, row.service_type, row.live_label, row.live_hold,
    row.shadow_status, row.shadow_label, row.start_pop, row.max_pop_4h, row.dose_hidden, row.products,
  ]);
}

module.exports = { recordSprayRainShadow, _test: { shadowRow } };
