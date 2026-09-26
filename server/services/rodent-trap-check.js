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
// source estimate was accepted before TRAP_CHECK_FEE_EFFECTIVE_DATE, or —
// with no estimate link — when the opener was scheduled before that date.

const TRAP_CHECK_ADDITIONAL_KEY = 'rodent_trap_check_additional';
const TRAP_CHECK_ADDITIONAL_PRICE = 95;
const INCLUDED_TRAPPING_VISITS = 2;
// ET calendar date the 2-visit rule starts applying to newly sold jobs.
const TRAP_CHECK_FEE_EFFECTIVE_DATE = '2026-09-27';

// Rows that OPEN a trapping job (the sold program).
const TRAPPING_OPENER_KEYS = [
  'rodent_trapping',
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

function isGrandfathered({ acceptedAt, openerDate }) {
  const basis = acceptedAt || openerDate;
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
// different from the running job's), or when the gap from the previous
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
        || (v.source_estimate_id && current?.estimateId && v.source_estimate_id !== current.estimateId)
      ))
    );
    if (gapBreak || openerEvidence) {
      current = { opener: openerEvidence ? v : null, estimateId: v.source_estimate_id || null, visits: [] };
      jobs.push(current);
    }
    if (!current.estimateId && v.source_estimate_id) current.estimateId = v.source_estimate_id;
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
    db.raw("to_char(e.accepted_at AT TIME ZONE 'America/New_York', 'YYYY-MM-DD') as accepted_day"),
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

  const base = {
    includedVisits: INCLUDED_TRAPPING_VISITS,
    additionalCheckKey: TRAP_CHECK_ADDITIONAL_KEY,
    additionalCheckPrice: TRAP_CHECK_ADDITIONAL_PRICE,
  };
  if (!job) {
    return { ...base, hasJob: false, openerDate: null, openerUnknown: false, visitCount: 0, grandfathered: false, nextVisitBillable: false };
  }

  const visitCount = job.visits.length;
  const firstDay = job.visits[0].scheduled_day;
  let grandfathered;
  if (job.opener) {
    grandfathered = isGrandfathered({ acceptedAt: job.opener.accepted_day, openerDate: job.opener.scheduled_day });
  } else {
    // No identifiable opener: a job already running before the rule is
    // grandfathered for certain; otherwise the office has to look.
    grandfathered = firstDay < TRAP_CHECK_FEE_EFFECTIVE_DATE;
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
    nextVisitBillable: !grandfathered && !openerUnknown && visitCount >= INCLUDED_TRAPPING_VISITS,
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
  declaredVisitType,
  sliceJobs,
  trappingJobStatus,
};
