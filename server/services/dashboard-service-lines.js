/**
 * Dashboard "By service line" card (GET /api/admin/dashboard/service-lines).
 *
 * Four numbers per service line for the selected dashboard period:
 *   1. close rate   - RESOLVED-ONLY denominator, same rule as the client's
 *                     PipelineAnalytics + estimate-winloss.js: won = accepted,
 *                     lost = declined or expired, resolution date = accepted_at /
 *                     declined_at / expires_at (same fallback chain) inside the
 *                     window, archived rows out, dead / converted-elsewhere
 *                     dispositions leave the math.
 *   2. aging7       - live backlog: sent/viewed estimates sent over 7 days ago.
 *                     NOT period-bound.
 *   3. ret90        - first-90-day retention of customers who converted in
 *                     [from - 180d, to - 90d] (every member has had 90 days).
 *   4. cac          - leads in the window by service interest, allocated ad
 *                     spend (ad_service_attribution.ad_cost, linked by lead_id)
 *                     per converted lead.
 *
 * Read-only. Each of the four queries is wrapped in its own try/catch so one
 * failing query returns that field as null plus a caveat, never a 500
 * (the /retention-cohort pattern). The math is split into pure functions so
 * the test can call it without Express.
 */

const db = require('../models/db');
const logger = require('./logger');
const { CUSTOMER_STAGES, CONVERSION_DATE_SQL } = require('./customer-stages');
const { INTERNAL_TEST_CUSTOMERS } = require('./internal-test-customers');
const { PROSPECT_SCOPE_SQL } = require('./lead-statuses');
const { inferEstimateServiceLines, serviceKeysFromText, SERVICE_LINE_LABELS } = require('./estimate-service-lines');
// Canonical win/loss helpers (estimate-winloss.js owns the fallback chains and
// the excluded-disposition rule; this card must never carry its own copy).
const { sentAnchorMs, resolutionDateMs, effectiveDisposition, excludedFromRates } = require('./estimate-winloss');
const { parseETDateTime } = require('../utils/datetime-et');

const DAY_MS = 86400000;
const RESOLVED_STATUSES = ['accepted', 'declined', 'expired'];
const OPEN_STATUSES = ['sent', 'viewed'];
const UNKNOWN_KEY = 'unknown';
const ALWAYS_KEYS = ['pest', 'lawn'];
const CHUNK = 500;

const BASE_CAVEATS = [
  'An estimate or customer with several service lines counts once in EACH of its lines, so rows add up to more than the totals.',
  'Close rate = accepted / (accepted + declined or expired) resolved in the period; open offers and dead or converted-elsewhere rows are left out.',
  'Open >7d is the live backlog today (sent or viewed over 7 days ago), not limited to the period.',
  'Cost per new customer = allocated ad spend over every lead in the period (including spam, duplicates and cancels) / distinct customers won from real prospects; organic and referral leads carry no spend.',
];

function labelFor(key) {
  if (key === UNKNOWN_KEY) return 'Other / unclear';
  return SERVICE_LINE_LABELS[key] || key;
}

// Resolved rows that are not real demand (dead) or that converted through
// another path leave the close-rate math — the estimate-winloss rule.
function leavesCloseMath(row) {
  return excludedFromRates(effectiveDisposition(row));
}

// Distinct service-line keys of an estimate row; never empty.
function estimateLineKeys(row) {
  let lines = [];
  try { lines = inferEstimateServiceLines(row) || []; } catch { lines = []; }
  const keys = [...new Set(lines.map((l) => l && l.key).filter(Boolean))];
  return keys.length ? keys : [UNKNOWN_KEY];
}

// Every line the lead's interest names ("pest control and lawn care" → both),
// so a multi-line lead lands in each CAC row, like estimates and customers do.
function leadLineKeys(serviceInterest) {
  const keys = [...new Set(serviceKeysFromText(serviceInterest))];
  return keys.length ? keys : [UNKNOWN_KEY];
}

const pct1 = (num, den) => (den >= 1 ? Math.round((num / den) * 1000) / 10 : null);

// ── 1 + 2: close rate, sent, open, aging ─────────────────────────────────
// win = { fromMs, toMs } with toMs EXCLUSIVE (ET midnight after the last day).
function buildCloseStats(rows, win, nowMs) {
  const byLine = new Map();
  const cell = (key) => {
    if (!byLine.has(key)) byLine.set(key, { sent: 0, accepted: 0, lost: 0, open: 0, aging7: 0 });
    return byLine.get(key);
  };
  const agingCutoff = nowMs - 7 * DAY_MS;
  for (const row of rows) {
    if (row.archived_at) continue;
    const keys = estimateLineKeys(row);
    // First durable delivery evidence, not sent_at alone: an accept that won
    // the in-flight send claim has deliveryState.firstDeliveredAt and no
    // sent_at, and a resend must not reset the age (estimate-winloss rule).
    const sentMs = sentAnchorMs(row);
    const sentInWindow = sentMs != null && sentMs >= win.fromMs && sentMs < win.toMs;
    if (sentInWindow) {
      for (const k of keys) {
        cell(k).sent += 1;
        if (OPEN_STATUSES.includes(row.status)) cell(k).open += 1;
      }
    }
    if (OPEN_STATUSES.includes(row.status) && sentMs != null && sentMs < agingCutoff) {
      for (const k of keys) cell(k).aging7 += 1;
    }
    if (RESOLVED_STATUSES.includes(row.status) && !leavesCloseMath(row)) {
      const at = resolutionDateMs(row);
      if (at != null && at >= win.fromMs && at < win.toMs) {
        for (const k of keys) {
          if (row.status === 'accepted') cell(k).accepted += 1;
          else cell(k).lost += 1;
        }
      }
    }
  }
  return byLine;
}

// ── 3: first-90-day retention ────────────────────────────────────────────
// customers: { id, pipeline_stage, churned_at: 'YYYY-MM-DD'|null, conv: 'YYYY-MM-DD' }
// linesByCustomer: Map(customerId -> [keys]) from accepted estimates.
function addDaysStr(dateStr, n) {
  const [y, m, d] = String(dateStr).slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

// Exit date by CAUSE, mirroring /retention-cohort: live now = active, not
// deleted, in a customer stage. Otherwise churned/dormant exit on churned_at
// (else the stage-change date); a soft delete exits on deleted_at; an
// active=false row with neither is an undatable deactivation and is dropped
// from the cohort (null), never backdated or counted as retained.
const LEFT_STAGES = new Set(['churned', 'dormant']);
function exitDateStr(c) {
  const liveNow = c.active === true && c.deleted_at == null && CUSTOMER_STAGES.includes(c.pipeline_stage);
  if (liveNow) return Infinity;
  let exit = null;
  if (LEFT_STAGES.has(c.pipeline_stage)) exit = c.churned_at || c.stage_changed_at;
  else if (c.deleted_at) exit = c.deleted_at;
  return exit ? String(exit).slice(0, 10) : null;
}

// true = retained past day 90, false = left inside 90 days, null = undatable (excluded).
function isRetained90(c) {
  const exit = exitDateStr(c);
  if (exit === Infinity) return true;
  if (exit == null || !c.conv) return null;
  return exit > addDaysStr(c.conv, 90);
}

function buildRetention(customers, linesByCustomer) {
  const byLine = new Map();
  for (const c of customers) {
    const keys = linesByCustomer.get(c.id) || [UNKNOWN_KEY];
    const retained = isRetained90(c);
    if (retained == null) continue; // undatable deactivation → not in the cohort
    for (const k of keys) {
      if (!byLine.has(k)) byLine.set(k, { cohort: 0, retained: 0 });
      const cell = byLine.get(k);
      cell.cohort += 1;
      if (retained) cell.retained += 1;
    }
  }
  return byLine;
}

// ── 4: cost per new customer ─────────────────────────────────────────────
// converted = DISTINCT customers acquired: a lead counts only when it is won
// or converted AND carries a customer_id, and two won leads for the same
// customer (an add-on sold to an existing account) count once.
// Spend is tallied over EVERY attributable lead (the allocator spreads
// platform spend across all of a channel's leads, so spam/duplicate/cancel
// shares must stay in true CAC); `leads` and `converted` count only real
// prospects (is_prospect = the lead-statuses prospect scope).
function buildCac(leads) {
  const byLine = new Map();
  const seen = new Map(); // line key -> Set(customer_id)
  for (const l of leads) {
    const prospect = l.is_prospect == null ? true : (l.is_prospect === true || l.is_prospect === 't');
    const won = l.status === 'won' || !!l.converted_at;
    for (const k of leadLineKeys(l.service_interest)) {
      if (!byLine.has(k)) { byLine.set(k, { leads: 0, converted: 0, spend: 0 }); seen.set(k, new Set()); }
      const cell = byLine.get(k);
      cell.spend += Number(l.ad_cost) || 0;
      if (!prospect) continue;
      cell.leads += 1;
      if (won && l.customer_id && !seen.get(k).has(l.customer_id)) {
        seen.get(k).add(l.customer_id);
        cell.converted += 1;
      }
    }
  }
  return byLine;
}

// ── assembly ─────────────────────────────────────────────────────────────
// Each input is a Map or null (query failed -> that field null).
function assembleLines({ close, retention, cac }) {
  const keys = new Set(ALWAYS_KEYS);
  for (const m of [close, retention, cac]) if (m) for (const k of m.keys()) keys.add(k);
  const lines = [];
  for (const key of keys) {
    const c = close ? (close.get(key) || { sent: 0, accepted: 0, lost: 0, open: 0, aging7: 0 }) : null;
    const r = retention ? (retention.get(key) || { cohort: 0, retained: 0 }) : null;
    const a = cac ? (cac.get(key) || { leads: 0, converted: 0, spend: 0 }) : null;
    const spend = a ? Math.round(a.spend * 100) / 100 : 0;
    lines.push({
      key,
      label: labelFor(key),
      sent: c ? c.sent : null,
      accepted: c ? c.accepted : null,
      lost: c ? c.lost : null,
      resolved: c ? c.accepted + c.lost : null,
      open: c ? c.open : null,
      close_rate: c ? pct1(c.accepted, c.accepted + c.lost) : null,
      aging7: c ? c.aging7 : null,
      ret90: r ? { cohort: r.cohort, retained: r.retained, rate: pct1(r.retained, r.cohort) } : null,
      cac: a
        ? {
          leads: a.leads,
          converted: a.converted,
          spend,
          value: a.converted > 0 ? Math.round((a.spend / a.converted) * 100) / 100 : null,
        }
        : null,
    });
  }
  const isEmpty = (l) => !(l.sent || l.accepted || l.lost || l.open || l.aging7
    || (l.ret90 && l.ret90.cohort) || (l.cac && l.cac.leads));
  return lines
    .filter((l) => ALWAYS_KEYS.includes(l.key) || !isEmpty(l))
    .sort((x, y) => (y.sent || 0) - (x.sent || 0) || x.label.localeCompare(y.label));
}

// ── queries ──────────────────────────────────────────────────────────────
function excludeInternalLeadNames(qb) {
  if (!INTERNAL_TEST_CUSTOMERS.length) return qb;
  return qb.whereNotIn(
    db.raw("LOWER(COALESCE(first_name, '') || ' ' || COALESCE(last_name, ''))"),
    INTERNAL_TEST_CUSTOMERS,
  );
}

// Same exclusion as excludeInternalEstimates in intelligence-bar/dashboard-tools.js
// (not exported there): estimates `e` joined to customers `c`, matched on the
// denormalized customer_name AND the joined customer's name.
function excludeInternalEstimateRows(qb) {
  if (!INTERNAL_TEST_CUSTOMERS.length) return qb;
  return qb
    .whereNotIn(db.raw("LOWER(COALESCE(e.customer_name, ''))"), INTERNAL_TEST_CUSTOMERS)
    .whereNotIn(
      db.raw("LOWER(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, ''))"),
      INTERNAL_TEST_CUSTOMERS,
    );
}

const ET_TS = "?::timestamp AT TIME ZONE 'America/New_York'";
const RESOLVED_AT_SQL = `CASE e.status
  WHEN 'accepted' THEN COALESCE(e.accepted_at, e.created_at)
  WHEN 'declined' THEN COALESCE(e.declined_at, e.updated_at, e.created_at)
  WHEN 'expired' THEN COALESCE(e.expires_at, e.updated_at, e.created_at)
END`;

async function fetchEstimateRows(win, nowMs) {
  const fromTs = `${win.from}T00:00:00`;
  const toTs = `${addDaysStr(win.to, 1)}T00:00:00`;
  const agingTs = new Date(nowMs - 7 * DAY_MS).toISOString();
  const qb = db({ e: 'estimates' })
    .leftJoin({ c: 'customers' }, 'e.customer_id', 'c.id')
    .whereNull('e.archived_at')
    .where(function coarseWindow() {
      // Sent/open/aging anchor on the first delivery evidence (sentAnchorMs):
      // superset prefilter on sent_at, viewed_at, accepted_at and the durable
      // deliveryState.firstDeliveredAt; the precise anchoring happens in JS.
      this.whereRaw(`(e.sent_at >= ${ET_TS} AND e.sent_at < ${ET_TS})`, [fromTs, toTs])
        .orWhereRaw(`(e.viewed_at >= ${ET_TS} AND e.viewed_at < ${ET_TS})`, [fromTs, toTs])
        .orWhereRaw(`((e.estimate_data #>> '{deliveryState,firstDeliveredAt}')::timestamptz >= ${ET_TS} AND (e.estimate_data #>> '{deliveryState,firstDeliveredAt}')::timestamptz < ${ET_TS})`, [fromTs, toTs])
        .orWhereRaw(
          `(e.status IN ('accepted','declined','expired') AND (${RESOLVED_AT_SQL}) >= ${ET_TS} AND (${RESOLVED_AT_SQL}) < ${ET_TS})`,
          [fromTs, toTs],
        )
        .orWhereRaw("(e.status IN ('sent','viewed') AND (e.sent_at < ? OR e.viewed_at < ? OR (e.estimate_data #>> '{deliveryState,firstDeliveredAt}')::timestamptz < ?))", [agingTs, agingTs, agingTs]);
    });
  return excludeInternalEstimateRows(qb).select(
    'e.id', 'e.status', 'e.sent_at', 'e.accepted_at', 'e.declined_at', 'e.expires_at',
    'e.created_at', 'e.updated_at', 'e.archived_at', 'e.disposition', 'e.decline_reason',
    'e.viewed_at', 'e.view_count', 'e.last_viewed_at', 'e.source',
    'e.estimate_data', 'e.service_interest', 'e.notes',
  );
}

async function fetchRetentionInputs(win) {
  const cohortFrom = addDaysStr(win.from, -180);
  const cohortTo = addDaysStr(win.to, -90);
  const qb = db('customers')
    .whereRaw(`${CONVERSION_DATE_SQL} >= ?`, [cohortFrom])
    .whereRaw(`${CONVERSION_DATE_SQL} <= ?`, [cohortTo])
    // Same cohort stages as /retention-cohort: past_customer is an archival
    // label, not a churn event (owner ruling 2026-08-07), so it stays out.
    .whereIn('pipeline_stage', [...CUSTOMER_STAGES, 'churned', 'dormant']);
  excludeInternalLeadNames(qb);
  const customers = await qb.select(
    'id',
    'pipeline_stage',
    'active',
    db.raw("to_char((deleted_at AT TIME ZONE 'America/New_York')::date, 'YYYY-MM-DD') as deleted_at"),
    db.raw("to_char((pipeline_stage_changed_at AT TIME ZONE 'America/New_York')::date, 'YYYY-MM-DD') as stage_changed_at"),
    db.raw("to_char(churned_at, 'YYYY-MM-DD') as churned_at"),
    db.raw(`to_char(${CONVERSION_DATE_SQL}, 'YYYY-MM-DD') as conv`),
  );
  // Lines come from the estimates accepted in the customer's FIRST 90 days
  // only (accepted_at, else created_at, on or before conv + 90d) — a lawn
  // upsell a year later must not rewrite the historical lawn cohort.
  const day90ByCustomer = new Map(customers.filter((c) => c.conv).map((c) => [c.id, addDaysStr(c.conv, 90)]));
  const linesByCustomer = new Map();
  const ids = customers.map((c) => c.id);
  for (let i = 0; i < ids.length; i += CHUNK) {
    const rows = await db('estimates')
      .whereIn('customer_id', ids.slice(i, i + CHUNK))
      .where('status', 'accepted')
      .select('customer_id', 'estimate_data', 'service_interest', 'notes',
        db.raw("to_char(COALESCE(accepted_at, created_at) AT TIME ZONE 'America/New_York', 'YYYY-MM-DD') as accepted_on"));
    for (const row of rows) {
      const day90 = day90ByCustomer.get(row.customer_id);
      if (day90 && row.accepted_on && String(row.accepted_on).slice(0, 10) > day90) continue;
      const set = new Set(linesByCustomer.get(row.customer_id) || []);
      for (const k of estimateLineKeys(row)) set.add(k);
      linesByCustomer.set(row.customer_id, [...set]);
    }
  }
  return { customers, linesByCustomer };
}

async function fetchLeadRows(win) {
  const fromTs = `${win.from}T00:00:00`;
  const toTs = `${addDaysStr(win.to, 1)}T00:00:00`;
  // Every attributable lead (spend side); the prospect scope rides along as a
  // flag so only real prospects count in the lead/conversion denominators.
  const qb = db('leads')
    .whereNull('deleted_at')
    .whereRaw(`first_contact_at >= ${ET_TS}`, [fromTs])
    .whereRaw(`first_contact_at < ${ET_TS}`, [toTs])
    .modify(excludeInternalLeadNames);
  return qb.select(
    'id', 'service_interest', 'status', 'converted_at', 'customer_id',
    db.raw(`(${PROSPECT_SCOPE_SQL}) as is_prospect`),
    db.raw('(SELECT COALESCE(SUM(asa.ad_cost), 0) FROM ad_service_attribution asa WHERE asa.lead_id = leads.id) as ad_cost'),
  );
}

// win = the plain dashboard period (close rate, retention); adWin = the same
// period floored at the attribution fresh start (cost per customer only —
// estimate outcomes and retention are not attribution data).
async function computeServiceLines(win, { now = new Date(), adWin = win } = {}) {
  const nowMs = now.getTime();
  const winMs = {
    fromMs: parseETDateTime(`${win.from}T00:00`).getTime(),
    toMs: parseETDateTime(`${addDaysStr(win.to, 1)}T00:00`).getTime(),
  };
  const caveats = [...BASE_CAVEATS];
  const guard = async (name, fn) => {
    try {
      return await fn();
    } catch (err) {
      logger.error(`[admin-dashboard] /service-lines ${name} query failed: ${err.message}`);
      caveats.push(`${name} could not be loaded right now, so those columns show "—".`);
      return null;
    }
  };

  const [close, retention, cac] = await Promise.all([
    guard('Close rate and open estimates', async () => buildCloseStats(await fetchEstimateRows(win, nowMs), winMs, nowMs)),
    guard('90-day retention', async () => {
      const { customers, linesByCustomer } = await fetchRetentionInputs(win);
      return buildRetention(customers, linesByCustomer);
    }),
    guard('Cost per new customer', async () => buildCac(await fetchLeadRows(adWin))),
  ]);

  if (adWin.from !== win.from) caveats.push(`Cost per new customer uses lead data from ${adWin.from} (attribution baseline); the other columns use the full period.`);
  return { period: win, adPeriod: adWin, lines: assembleLines({ close, retention, cac }), caveats };
}

module.exports = {
  computeServiceLines,
  buildCloseStats,
  buildRetention,
  buildCac,
  assembleLines,
  isRetained90,
  exitDateStr,
  BASE_CAVEATS,
};
