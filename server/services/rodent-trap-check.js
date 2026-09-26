// server/services/rodent-trap-check.js
//
// Rodent trapping visit allowance (owner ruling 2026-09-26): the $350
// Standard trapping plan covers TWO visits for the same active trapping
// job — the setup visit plus one trap check. Visit 3 and later are billed
// as the separate "Rodent Trap Check - Additional" catalog row at $95.
//
// Counting is an office call, not an automatic re-price (ruling: separate
// $95 service, booked by the office). This module only ADVISES: the
// create-appointment modal asks how many trapping visits the customer's
// current job already has and nudges toward the $95 row once the two
// included visits are used.
//
// Grandfathering (ruling 2026-09-26): jobs sold before the change keep
// unlimited included checks. A job is grandfathered when its opener's
// source estimate was CREATED before TRAP_CHECK_FEE_EFFECTIVE_DATE — an
// estimate already out with the customer keeps the terms it was quoted
// under, whenever it is accepted — or, with no estimate link, when the
// opener was booked (row created) before that date.

const TRAP_CHECK_ADDITIONAL_KEY = 'rodent_trap_check_additional';
// Code default only — the live price is the catalog row's base_price
// (catalogAdditionalCheckPrice), the same number booking stamps.
const TRAP_CHECK_ADDITIONAL_PRICE = 95;
// Code default only — the live allowance is pricing_config.rodent_trapping
// (liveIncludedVisits), the same setting the estimate copy is built from.
const INCLUDED_TRAPPING_VISITS = 2;
// ET calendar date the 2-visit rule starts applying to newly sold jobs.
const TRAP_CHECK_FEE_EFFECTIVE_DATE = '2026-09-27';

// Rows that OPEN a trapping job (the sold program). rodent_exclusion is
// the legacy "Rodent Exclusion & Trapping" row — review-request.js counts it
// in the trapping series too.
const TRAPPING_OPENER_KEYS = [
  'rodent_trapping',
  'rodent_exclusion',
  'rodent_trapping_exclusion',
  'rodent_trapping_sanitation',
  'rodent_trapping_exclusion_sanitation',
];
// Every row that counts as a visit of the job.
const TRAPPING_VISIT_KEYS = [
  ...TRAPPING_OPENER_KEYS,
  'rodent_trapping_followup',
  TRAP_CHECK_ADDITIONAL_KEY,
];
// Rows that are checks by catalog definition, never an opener.
const TRAP_CHECK_KEYS = ['rodent_trapping_followup', TRAP_CHECK_ADDITIONAL_KEY];
// The combo packages are conclusive openers (review-request.js does the
// same). Plain rodent_trapping is NOT: it has also been booked for trap
// checks, so it opens a job only on series evidence (below).
const CONCLUSIVE_OPENER_KEYS = TRAPPING_OPENER_KEYS.filter((k) => k !== 'rodent_trapping');
// Consecutive visits further apart than this belong to different jobs.
const JOB_GAP_DAYS = 60;
const INACTIVE_STATUSES = ['cancelled', 'rescheduled', 'skipped'];
const HISTORY_LIMIT = 500;

// Today's ET calendar date. Stored DATE columns never pass through here —
// the query returns them as 'YYYY-MM-DD' text so no host timezone can
// shift them a day.
function etToday() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function dayNumber(ymd) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  return Date.UTC(y, m - 1, d) / 86400000;
}

function isGrandfathered({ estimateDate, bookedDate }) {
  const basis = estimateDate || bookedDate;
  if (!basis) return false;
  return String(basis).slice(0, 10) < TRAP_CHECK_FEE_EFFECTIVE_DATE;
}

// The tech's declared trap_visit_type on the visit's report ('initial' |
// 'followup' | null) — the same typed-report fields review-request.js
// reads. Parse problems read as undeclared.
function declaredVisitType(serviceData) {
  let data = serviceData;
  try {
    if (typeof data === 'string') data = JSON.parse(data);
  } catch { return null; }
  const snapshots = [
    data?.typedReportSnapshot,
    ...(Array.isArray(data?.companionReportSnapshots) ? data.companionReportSnapshots : []),
  ];
  for (const snap of snapshots) {
    const t = String(snap?.values?.trap_visit_type || '').trim();
    if (t === 'Initial setup') return 'initial';
    if (t === 'Follow-up check') return 'followup';
  }
  return null;
}

async function declaredTypes(db, scheduledIds) {
  if (!scheduledIds.length) return new Map();
  const records = await db('service_records')
    .whereIn('scheduled_service_id', scheduledIds)
    .orderBy('created_at', 'asc')
    .select('scheduled_service_id', 'service_data');
  const out = new Map();
  // Latest report per visit wins (ascending order, later rows overwrite).
  for (const r of records) {
    const t = declaredVisitType(r.service_data);
    if (t) out.set(r.scheduled_service_id, t);
  }
  return out;
}

// Split the customer's trapping visits (ascending) into jobs. A visit opens
// a new job when it is a conclusive opener, or a plain rodent_trapping row
// with opener evidence (tech-declared "Initial setup", or a source estimate
// other than the running job's — including a job booked without one), or when the gap from the previous
// visit exceeds JOB_GAP_DAYS. Check evidence — a check-only SKU, a
// dispatched follow-up link, or a declared "Follow-up check" — never
// opens a job, so a plain rodent_trapping check cannot reset the count.
function sliceJobs(visits, declared) {
  const jobs = [];
  let current = null;
  for (const v of visits) {
    const declaredType = declared.get(v.id) || null;
    const checkEvidence = TRAP_CHECK_KEYS.includes(v.service_key)
      || Boolean(v.followup_source_service_id)
      || declaredType === 'followup';
    const prev = current && current.visits[current.visits.length - 1];
    const gapBreak = !prev || dayNumber(v.scheduled_day) - dayNumber(prev.scheduled_day) > JOB_GAP_DAYS;
    const openerEvidence = !checkEvidence && (
      CONCLUSIVE_OPENER_KEYS.includes(v.service_key)
      || (v.service_key === 'rodent_trapping' && (
        declaredType === 'initial'
        || !prev
        || gapBreak
        // A booking from an accepted estimate other than the running job's
        // (or the running job had none — an office-booked job) is a new sale.
        || (v.source_estimate_id && v.source_estimate_id !== current?.estimateId)
      ))
    );
    if (gapBreak || openerEvidence) {
      current = { opener: openerEvidence ? v : null, estimateId: v.source_estimate_id || null, visits: [] };
      jobs.push(current);
    }
    current.visits.push(v);
  }
  return jobs;
}

const VISIT_COLUMNS = [
  'ss.id',
  'ss.status',
  'ss.source_estimate_id',
  'ss.followup_source_service_id',
  'ss.property_id',
  'ss.service_address_line1',
  'ss.service_address_line2',
  'ss.service_address_city',
  'ss.service_address_zip',
  'sv.service_key',
];

// Active trapping visits of the customer: appointments whose primary line
// OR an add-on line is a trapping SKU. One appointment is one visit — an
// appointment matched through both keeps its primary row.
async function trappingVisits(db, customerId) {
  const dayCols = () => [
    db.raw("to_char(ss.scheduled_date, 'YYYY-MM-DD') as scheduled_day"),
    // estimates.created_at / scheduled_services.created_at are timestamptz,
    // so one AT TIME ZONE yields the ET wall clock.
    db.raw("to_char(e.created_at AT TIME ZONE 'America/New_York', 'YYYY-MM-DD') as estimate_day"),
    db.raw("to_char(ss.created_at AT TIME ZONE 'America/New_York', 'YYYY-MM-DD') as booked_day"),
    db.raw("to_char(ss.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') as created_key"),
  ];
  const primaries = await db('scheduled_services as ss')
    .join('services as sv', 'ss.service_id', 'sv.id')
    .leftJoin('estimates as e', 'ss.source_estimate_id', 'e.id')
    .where('ss.customer_id', customerId)
    .whereIn('sv.service_key', TRAPPING_VISIT_KEYS)
    .whereNotIn('ss.status', INACTIVE_STATUSES)
    .orderBy('ss.scheduled_date', 'desc')
    .limit(HISTORY_LIMIT)
    .select(...VISIT_COLUMNS, ...dayCols());
  const addons = await db('scheduled_service_addons as a')
    .join('scheduled_services as ss', 'a.scheduled_service_id', 'ss.id')
    .join('services as sv', 'a.service_id', 'sv.id')
    .leftJoin('estimates as e', 'ss.source_estimate_id', 'e.id')
    .where('ss.customer_id', customerId)
    .whereIn('sv.service_key', TRAPPING_VISIT_KEYS)
    .whereNotIn('ss.status', INACTIVE_STATUSES)
    .orderBy('ss.scheduled_date', 'desc')
    .limit(HISTORY_LIMIT)
    .select(...VISIT_COLUMNS, ...dayCols());
  const byVisit = new Map();
  for (const row of [...primaries, ...addons]) {
    if (!byVisit.has(row.id)) byVisit.set(row.id, row);
  }
  return [...byVisit.values()].sort((x, y) => (
    x.scheduled_day === y.scheduled_day
      ? String(x.created_key || '').localeCompare(String(y.created_key || ''))
      : (x.scheduled_day < y.scheduled_day ? -1 : 1)
  ));
}

// Setup visit + the included checks, from the same pricing_config row the
// engine's estimate copy uses (db-bridge overlays it). 'unlimited' → null:
// every check is included, nothing is ever advised as billable.
async function liveIncludedVisits(db) {
  let value;
  try {
    const row = await db('pricing_config').where({ config_key: 'rodent_trapping' }).first('data');
    const data = row && (typeof row.data === 'string' ? JSON.parse(row.data) : row.data);
    value = data?.included_followups;
  } catch {
    value = undefined;
  }
  if (value == null) value = require('./pricing-engine/constants').RODENT.trapping.includedFollowUps;
  if (String(value).toLowerCase() === 'unlimited') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? 1 + n : INCLUDED_TRAPPING_VISITS;
}

const TRAP_SOLD_KEYS = new Set(TRAPPING_OPENER_KEYS);
const LINE_KEY_FIELDS = ['service', 'serviceKey', 'service_key', 'key'];

// What the opener's estimate froze about trapping: whether it sold a
// trapping program at all (a linked estimate may be for an unrelated
// service), and the per-check price it quoted, if any. Bounded deep walk of
// estimate_data; parse problems read as "not sold".
function estimateTrappingTerms(estimateData) {
  let data = estimateData;
  try {
    if (typeof data === 'string') data = JSON.parse(data);
  } catch { return { sold: false, additionalCheckPrice: null }; }
  let sold = false;
  let price = null;
  const walk = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > 8) return;
    if (Array.isArray(node)) { node.forEach((n) => walk(n, depth + 1)); return; }
    if (node.svcRodentTrap === true) sold = true;
    const isTrapLine = LINE_KEY_FIELDS.some((f) => TRAP_SOLD_KEYS.has(node[f]));
    if (isTrapLine) {
      sold = true;
      const quoted = Number(node.additionalCheckPrice ?? node.pricingBasis?.additionalCheckPrice);
      if (price == null && Number.isFinite(quoted) && quoted > 0) price = quoted;
    }
    for (const child of Object.values(node)) walk(child, depth + 1);
  };
  walk(data, 0);
  return { sold, additionalCheckPrice: price };
}

async function openerEstimateTerms(db, opener) {
  if (!opener?.source_estimate_id) return { sold: false, additionalCheckPrice: null };
  const row = await db('estimates').where({ id: opener.source_estimate_id }).first('estimate_data');
  return estimateTrappingTerms(row?.estimate_data);
}

// The price booking will actually stamp: the active catalog row's
// base_price, falling back to the code default when the row is absent.
async function catalogAdditionalCheckPrice(db) {
  const row = await db('services')
    .where({ service_key: TRAP_CHECK_ADDITIONAL_KEY, is_active: true })
    .first('base_price');
  const price = Number(row?.base_price);
  return Number.isFinite(price) && price > 0 ? price : TRAP_CHECK_ADDITIONAL_PRICE;
}

/**
 * The trapping job a booking on `date` (ET 'YYYY-MM-DD', default today)
 * belongs to: only visits on or before that date count (a later booked
 * visit comes after this one), and the latest job among them applies when
 * its last visit is within JOB_GAP_DAYS of the date. Returns its visit
 * count and grandfathering. Reads the full trapping history (primary and
 * add-on lines), so an opener of any age still anchors its job. When the
 * job's opener cannot be identified, the answer is openerUnknown — never
 * "billable". Scoped to one premise (the booking's property, or the
 * primary/unstamped premise when none is chosen) with review-request's
 * trapping premise rules, so checks at another of the customer's
 * properties never spend this one's allowance. Read-only.
 */
async function trappingJobStatus(db, customerId, { date, today, propertyId = null, premiseMatcher } = {}) {
  const anchor = date || today || etToday();
  // Lazy: review-request pulls in the messaging stack.
  const inPremise = premiseMatcher
    || await require('./review-request').trappingPremiseMatcher(customerId, { property_id: propertyId || null });

  const visits = (await trappingVisits(db, customerId))
    .filter((r) => r.scheduled_day <= anchor && inPremise(r));
  const plainIds = visits.filter((v) => v.service_key === 'rodent_trapping').map((v) => v.id);
  const jobs = sliceJobs(visits, await declaredTypes(db, plainIds));
  const last = jobs[jobs.length - 1];
  const lastDay = last && last.visits[last.visits.length - 1].scheduled_day;
  const job = last && dayNumber(anchor) - dayNumber(lastDay) <= JOB_GAP_DAYS ? last : null;

  const includedVisits = await liveIncludedVisits(db);
  const terms = job?.opener ? await openerEstimateTerms(db, job.opener) : { sold: false, additionalCheckPrice: null };
  const base = {
    includedVisits,
    additionalCheckKey: TRAP_CHECK_ADDITIONAL_KEY,
    // The per-check price the opener's estimate quoted, else the live
    // catalog price (manually sold jobs, or estimates from before the fee).
    additionalCheckPrice: terms.additionalCheckPrice ?? await catalogAdditionalCheckPrice(db),
  };
  if (!job) {
    return { ...base, hasJob: false, openerDate: null, openerUnknown: false, visitCount: 0, grandfathered: false, nextVisitBillable: false };
  }

  const visitCount = job.visits.length;
  const firstDay = job.visits[0].scheduled_day;
  let grandfathered;
  if (job.opener) {
    // The estimate's date counts only when that estimate sold trapping; a
    // linked estimate for an unrelated service falls back to the booking.
    grandfathered = isGrandfathered({
      estimateDate: terms.sold ? job.opener.estimate_day : null,
      bookedDate: job.opener.booked_day,
    });
  } else {
    // No identifiable opener: a job already running (or booked) before the
    // rule is grandfathered for certain; otherwise the office has to look.
    grandfathered = firstDay < TRAP_CHECK_FEE_EFFECTIVE_DATE
      || isGrandfathered({ bookedDate: job.visits[0].booked_day });
  }
  const openerUnknown = !job.opener && !grandfathered;

  return {
    ...base,
    hasJob: true,
    openerDate: job.opener ? job.opener.scheduled_day : null,
    openerUnknown,
    visitCount,
    grandfathered,
    // The next booking is visit visitCount+1; it is billable once the
    // included visits are used, unless the job predates the rule or its
    // opener can't be established.
    nextVisitBillable: !grandfathered && !openerUnknown && includedVisits != null && visitCount >= includedVisits,
  };
}

module.exports = {
  TRAP_CHECK_ADDITIONAL_KEY,
  TRAP_CHECK_ADDITIONAL_PRICE,
  INCLUDED_TRAPPING_VISITS,
  TRAP_CHECK_FEE_EFFECTIVE_DATE,
  TRAPPING_OPENER_KEYS,
  TRAPPING_VISIT_KEYS,
  isGrandfathered,
  estimateTrappingTerms,
  declaredVisitType,
  sliceJobs,
  trappingJobStatus,
};
