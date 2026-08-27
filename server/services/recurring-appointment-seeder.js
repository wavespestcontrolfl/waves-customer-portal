const {
  parseETDateTime,
  etParts,
  etDateString,
  addETDays,
  addETMonthsByWeekday,
  etNthWeekdayOfMonth,
} = require('../utils/datetime-et');
const { lockCustomerComms, withCustomerCommsLock } = require('../utils/customer-comms-lock');
const { clearOfBlackout: nudgeOffBlackoutDates, isBlackedOut } = require('./scheduling/blackout-nudge');

const MONTH_RECURRENCE_INTERVALS = {
  monthly: 1,
  bimonthly: 2,
  quarterly: 3,
  triannual: 4,
  semiannual: 6,
  biannual: 6,
  annual: 12,
  yearly: 12,
};

const DEFAULT_WEEKEND_SHIFT = 'forward';

// Seasonal mosquito: 9 visits at monthly gaps that NEVER land Nov-Jan (owner
// 2026-07-27). Nine in-season months (Feb-Oct) means a February start runs
// Feb->Oct exactly; a mid/off-season start still gets all 9 by rolling across
// the winter gap (a July start runs Jul-Oct, skips Nov-Jan, resumes Feb-Jun).
// Not a MONTH_RECURRENCE_INTERVALS cadence — the gap is 1 month in season and
// 4 months across the winter, so it needs its own date walk.
const SEASONAL_FEB_OCT = 'seasonal_feb_oct';
const SEASON_FIRST_MONTH = 2;   // February
const SEASON_LAST_MONTH = 10;   // October
const SEASON_MONTHS_PER_YEAR = SEASON_LAST_MONTH - SEASON_FIRST_MONTH + 1; // 9

// Position of an in-season month on a continuous Feb..Oct timeline. An
// off-season base sits one slot BEFORE the coming February, so follow-up 1
// lands on that February.
function seasonOrdinalForBase(year, month) {
  if (month < SEASON_FIRST_MONTH) return year * SEASON_MONTHS_PER_YEAR - 1;
  if (month > SEASON_LAST_MONTH) return (year + 1) * SEASON_MONTHS_PER_YEAR - 1;
  return year * SEASON_MONTHS_PER_YEAR + (month - SEASON_FIRST_MONTH);
}

// The i-th seasonal occurrence after a base date. Exported because
// admin-schedule.js and rebooker.js each keep their own nextRecurringDate for
// series extension/rescheduling; without this they fall through to the generic
// 91-day gap and would corrupt the cadence (and land visits in winter).
function seasonalFebOctDate(baseDateStr, i, opts = {}) {
  const safe = dateOnly(baseDateStr) || etDateString();
  const base = parseETDateTime(`${safe}T12:00`);
  if (isNaN(base.getTime())) return safe;
  // Walk the Feb..Oct timeline, then convert back to a plain month delta so the
  // shared helper keeps this cadence's day-of-month/weekday semantics identical
  // to every other month-based pattern.
  const baseEt = etParts(base);
  const target = seasonOrdinalForBase(baseEt.year, baseEt.month) + i;
  const targetYear = Math.floor(target / SEASON_MONTHS_PER_YEAR);
  const targetMonth = (((target % SEASON_MONTHS_PER_YEAR) + SEASON_MONTHS_PER_YEAR) % SEASON_MONTHS_PER_YEAR)
    + SEASON_FIRST_MONTH;
  const monthDelta = (targetYear - baseEt.year) * 12 + (targetMonth - baseEt.month);
  return etDateString(addETMonthsByWeekday(base, monthDelta, opts));
}

// First in-season date for a seasonal series whose chosen start falls in the
// Nov–Jan gap: Nov/Dec roll to the FOLLOWING February, January to its own
// February, keeping the base's day-of-month/weekday semantics. In-season bases
// pass through untouched. Exported for the estimate converter, which picks the
// auto-scheduled first visit date itself — an office-booked off-season parent
// is deliberately NOT moved (that date is the operator's), but an auto-created
// one would otherwise put a winter treatment on a Feb–Oct program and leave
// only eight in-season visits.
function firstInSeasonDate(baseDateStr, opts = {}) {
  const safe = dateOnly(baseDateStr) || etDateString();
  const base = parseETDateTime(`${safe}T12:00`);
  if (isNaN(base.getTime())) return safe;
  const { year, month } = etParts(base);
  if (month >= SEASON_FIRST_MONTH && month <= SEASON_LAST_MONTH) return safe;
  const targetYear = month > SEASON_LAST_MONTH ? year + 1 : year;
  const monthDelta = (targetYear - year) * 12 + (SEASON_FIRST_MONTH - month);
  return etDateString(addETMonthsByWeekday(base, monthDelta, opts));
}

// Weekend shifts and blackout nudges move dates across the season edge (a
// forward-shifted Oct 31 lands Nov 2; a back-shifted Feb 1 lands Jan 30),
// breaking the seasonal cadence's no-Nov-Jan contract. Walk back INTO the
// season from whichever edge was crossed — clamping the wrong way would cross
// the whole winter and land the visit ~4 months from where the cadence put it.
// A no-op for every other pattern and for in-season dates. Exported because
// every caller that weekend-shifts a seasonal series date (admin-schedule
// creation/rewrite/extension) needs the same clamp the seeder applies.
function clampDateToSeason(pattern, dateStr, { skipWeekends = false, blackoutDates = null } = {}) {
  if (pattern !== SEASONAL_FEB_OCT || !dateStr) return dateStr;
  const drifted = Number(dateStr.slice(5, 7));
  // Already in season: the weekend/blackout passes have run, so this date is
  // good — never move it.
  if (drifted >= SEASON_FIRST_MONTH && drifted <= SEASON_LAST_MONTH) return dateStr;
  const step = drifted < SEASON_FIRST_MONTH ? 1 : -1;
  let candidate = dateStr;
  for (let i = 0; i < 75; i++) {
    candidate = etDateString(addETDays(parseETDateTime(`${candidate}T12:00`), step));
    const month = Number(candidate.slice(5, 7));
    if (month < SEASON_FIRST_MONTH || month > SEASON_LAST_MONTH) continue;
    const { dayOfWeek } = etParts(parseETDateTime(`${candidate}T12:00`));
    const weekendClear = !skipWeekends || (dayOfWeek !== 0 && dayOfWeek !== 6);
    if (weekendClear && !isBlackedOut(candidate, blackoutDates)) return candidate;
  }
  // Exhausted: no clear in-season date within the bounded search (an
  // extended blackout can eat all of it). Returning the original off-season
  // date would violate the Feb–Oct contract — null lets callers skip the
  // candidate or report a placement shortfall like every other exhausted
  // nudge.
  return null;
}

const DEFAULT_ONE_YEAR_COUNTS = {
  monthly: 12,
  every_6_weeks: 9,
  [SEASONAL_FEB_OCT]: 9,
  bimonthly: 6,
  quarterly: 4,
  triannual: 3,
  semiannual: 2,
  biannual: 2,
  annual: 1,
  yearly: 1,
};

function dateOnly(value) {
  if (!value) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function positiveInt(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

function normalizeRecurringPattern(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return null;
  const compact = raw.replace(/[^a-z0-9]/g, '');
  if (['monthly', 'month', 'everymonth', '12x', '12xperyear'].includes(compact)) return 'monthly';
  // Tree & Shrub Enhanced (9 visits at 6-week gaps, un-retired 2026-07-24).
  // Day-gap pattern like weekly/biweekly — NOT in MONTH_RECURRENCE_INTERVALS.
  // Numeric 9-visit inference deliberately stays 'bimonthly' (mosquito
  // seasonal rows carry 9 visits and must not reclassify); only the explicit
  // frequency text selects this cadence.
  if (['every6weeks', 'everysixweeks', '6weeks', 'sixweeks', '9x', '9xperyear'].includes(compact)) return 'every_6_weeks';
  // Seasonal mosquito (9 visits, Feb-Oct). EXPLICIT tokens only, for the same
  // reason as every_6_weeks above: numeric 9-visit inference must stay
  // 'bimonthly' so legacy 9-visit rows keep their office-scheduled behavior.
  if ([SEASONAL_FEB_OCT.replace(/_/g, ''), 'seasonalfeboctober', 'seasonal9', 'seasonal9x'].includes(compact)) return SEASONAL_FEB_OCT;
  if (['bimonthly', 'bimonth', 'bimonthlypest', 'everyothermonth', 'everytwomonths', 'every2months', '6x', '6xperyear'].includes(compact)) return 'bimonthly';
  if (['quarterly', 'quarter', 'everyquarter', 'everythreemonths', 'every3months', '4x', '4xperyear'].includes(compact)) return 'quarterly';
  if (['triannual', 'threetimesyearly', '3x', '3xperyear'].includes(compact)) return 'triannual';
  if (['semiannual', 'biannual', 'twiceyearly', 'every6months', '2x', '2xperyear'].includes(compact)) return 'semiannual';
  if (['annual', 'yearly', '1x', '1xperyear'].includes(compact)) return 'annual';
  if (/\bbi[-\s]?monthly\b|every other month|every two months|every 2 months|6x/i.test(raw)) return 'bimonthly';
  if (/\bquarterly\b|every quarter|every three months|every 3 months|4x/i.test(raw)) return 'quarterly';
  if (/\btri[-\s]?annual\b|3x/i.test(raw)) return 'triannual';
  if (/\bsemi[-\s]?annual\b|\bbi[-\s]?annual\b|twice yearly|every 6 months|2x/i.test(raw)) return 'semiannual';
  if (/\bannual\b|\byearly\b|1x/i.test(raw)) return 'annual';
  if (/\bmonthly\b|every month|12x/i.test(raw)) return 'monthly';
  if (compact === 'weekly') return 'weekly';
  if (compact === 'biweekly') return 'biweekly';
  const visits = Number(raw);
  if (Number.isFinite(visits) && visits > 0) return patternFromVisitsPerYear(visits);
  if (MONTH_RECURRENCE_INTERVALS[raw] || ['weekly', 'biweekly', 'daily', 'custom', 'every_6_weeks', SEASONAL_FEB_OCT].includes(raw)) return raw;
  return null;
}

function patternFromVisitsPerYear(value) {
  const visits = positiveInt(value);
  if (!visits) return null;
  if (visits >= 12) return 'monthly';
  if (visits >= 6) return 'bimonthly';
  if (visits >= 4) return 'quarterly';
  if (visits >= 3) return 'triannual';
  if (visits >= 2) return 'semiannual';
  return 'annual';
}

function serviceKeyFor(value = {}) {
  const raw = String(
    // serviceKey (camel) joined the vocabulary with service_key (codex r22
    // pre-push P1) — the admin/estimate line spelling.
    value.service || value.serviceKey || value.service_key || value.key || value.kind
    || value.name || value.label || value.displayName || value.service_type || ''
  ).toLowerCase();
  // Multi-service composite bookings ('mosquito+pest_control' keys or
  // 'Pest Control + Mosquito Control' labels, #2957): a bundle that
  // includes pest is a PEST-family series — the quarterly pest cadence
  // anchors the follow-ups (children are seeded pest-only; add-on
  // cadences are office-managed). Must run before the mosquito/lawn
  // checks, or the add-on token wins on regex order and the series
  // mis-files (duplicate guards + maintenance would look in the wrong
  // family).
  if (/\+/.test(raw) && /pest|roach|ant|spider|perimeter|general/.test(raw)) return 'pest_control';
  if (/lawn|turf|fertili[sz]|weed|fungus|chinch/.test(raw)) return 'lawn_care';
  if (/mosquito/.test(raw)) return 'mosquito';
  if (/tree|shrub|ornamental/.test(raw)) return 'tree_shrub';
  if (/palm/.test(raw)) return 'palm_injection';
  // Recurring spot-foam termite program. Matches the service key `foam_recurring`
  // and the "Recurring Termite Foam Service" display name (plus the legacy
  // "Recurring Foam Treatment" form on older rows), but NOT the one-time
  // "Termite Foam Service" line (no recurring token — it falls through to
  // termite_bait below). The optional "termite" between recurring and foam is
  // load-bearing: without it the renamed label matches /termite/ first and
  // the series mis-files into the bait family.
  if (/foam[_\s]*recurring|recurring[_\s]*(?:termite[_\s]*)?foam/.test(raw)) return 'foam_recurring';
  // Combined services ("Pest & Rodent Control", "Quarterly Pest + Termite
  // Bait Station"): "pest" BEFORE the rodent/termite token = pest-primary —
  // these rows must keep pest cadence defaults and quarterly follow-up
  // seeding. Order is load-bearing: "Rodent Pest Control" leads with rodent
  // and stays rodent_bait (same rule as detectServiceLine).
  if (/\bpest\b.*\b(rodent|termite)\b/.test(raw)) return 'pest_control';
  if (/rodent|rat|mouse|mice/.test(raw)) return 'rodent_bait';
  if (/termite/.test(raw)) return 'termite_bait';
  if (/pest|roach|ant|spider|perimeter|general/.test(raw)) return 'pest_control';
  return raw.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'service';
}

function visitsForService(value = {}) {
  return positiveInt(
    value.visitsPerYear
    ?? value.appsPerYear
    ?? value.visits
    ?? value.apps
    ?? value.treatmentsPerYear
  );
}

function inferRecurringPattern({
  service = {},
  frequency,
  fallbackFrequency,
  visitsPerYear,
} = {}) {
  const candidates = [
    frequency,
    service.frequency,
    service.frequencyKey,
    service.frequency_key,
    service.recurringPattern,
    service.recurring_pattern,
    service.label,
    service.name,
    service.displayName,
    service.service_type,
    fallbackFrequency,
  ].filter(Boolean);

  for (const candidate of candidates) {
    const fromText = normalizeRecurringPattern(candidate);
    if (fromText) return fromText;
  }

  const visits = positiveInt(visitsPerYear) || visitsForService(service);
  const fromVisits = patternFromVisitsPerYear(visits);
  if (fromVisits) return fromVisits;

  if (serviceKeyFor(service) === 'pest_control') return 'quarterly';
  return normalizeRecurringPattern(fallbackFrequency);
}

function recurrenceOrdinalOptions(baseDateStr, opts = {}) {
  const safe = dateOnly(baseDateStr) || etDateString();
  const base = parseETDateTime(`${safe}T12:00`);
  if (isNaN(base.getTime())) return opts;
  const et = etParts(base);
  return {
    ...opts,
    nth: positiveInt(opts.nth) || Math.ceil(et.day / 7),
    weekday: opts.weekday != null && opts.weekday !== '' && !isNaN(parseInt(opts.weekday, 10))
      ? parseInt(opts.weekday, 10)
      : et.dayOfWeek,
  };
}

function nextRecurringDate(baseDateStr, pattern, i, opts = {}) {
  const safe = dateOnly(baseDateStr) || etDateString();
  const base = parseETDateTime(`${safe}T12:00`);
  if (isNaN(base.getTime())) return safe;
  const nthNum = opts.nth != null && opts.nth !== '' && !isNaN(parseInt(opts.nth, 10)) ? parseInt(opts.nth, 10) : null;
  const wdayNum = opts.weekday != null && opts.weekday !== '' && !isNaN(parseInt(opts.weekday, 10)) ? parseInt(opts.weekday, 10) : null;
  const intNum = opts.intervalDays != null && opts.intervalDays !== '' && !isNaN(parseInt(opts.intervalDays, 10)) ? parseInt(opts.intervalDays, 10) : null;

  if (pattern === 'monthly_nth_weekday' && nthNum != null && wdayNum != null) {
    const baseEt = etParts(base);
    const totalMonths = (baseEt.month - 1) + i;
    const targetYear = baseEt.year + Math.floor(totalMonths / 12);
    const targetMonth1 = ((totalMonths % 12) + 12) % 12 + 1;
    return etDateString(etNthWeekdayOfMonth(targetYear, targetMonth1, nthNum, wdayNum));
  }
  if (pattern === SEASONAL_FEB_OCT) return seasonalFebOctDate(safe, i, opts);
  if (MONTH_RECURRENCE_INTERVALS[pattern]) {
    return etDateString(addETMonthsByWeekday(base, MONTH_RECURRENCE_INTERVALS[pattern] * i, opts));
  }

  const intervals = { daily: 1, weekly: 7, biweekly: 14, every_6_weeks: 42 };
  const gap = pattern === 'custom' && intNum ? Math.max(1, intNum) : (intervals[pattern] || 91);
  return etDateString(addETDays(base, gap * i));
}

function shiftPastWeekend(dateStr, skip, direction = DEFAULT_WEEKEND_SHIFT) {
  if (!skip || !dateStr) return dateStr;
  const safe = dateOnly(dateStr);
  const d = parseETDateTime(`${safe}T12:00`);
  if (isNaN(d.getTime())) return dateStr;
  const { dayOfWeek } = etParts(d);
  if (dayOfWeek !== 0 && dayOfWeek !== 6) return safe;
  const offset = direction === 'back'
    ? (dayOfWeek === 6 ? -1 : -2)
    : (dayOfWeek === 6 ? 2 : 1);
  return etDateString(addETDays(d, offset));
}

function etDateDiffDays(a, b) {
  const left = dateOnly(a);
  const right = dateOnly(b);
  if (!left || !right) return null;
  const start = Date.UTC(...left.split('-').map((part, idx) => idx === 1 ? Number(part) - 1 : Number(part)));
  const end = Date.UTC(...right.split('-').map((part, idx) => idx === 1 ? Number(part) - 1 : Number(part)));
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.round((end - start) / 86400000);
}

function recurringCandidateTooCloseToAnchor(baseDateStr, pattern, candidateDateStr) {
  const monthInterval = MONTH_RECURRENCE_INTERVALS[pattern];
  if (!monthInterval) return false;
  const diffDays = etDateDiffDays(baseDateStr, candidateDateStr);
  if (diffDays == null) return false;
  return diffDays <= 0 || diffDays < (monthInterval * 21);
}

function plannedVisitCountForPattern(pattern, opts = {}) {
  const explicit = positiveInt(opts.plannedCount);
  if (explicit) return Math.max(1, Math.min(24, explicit));
  const visits = positiveInt(opts.visitsPerYear);
  if (visits) return Math.max(1, Math.min(24, visits));
  if (DEFAULT_ONE_YEAR_COUNTS[pattern]) return DEFAULT_ONE_YEAR_COUNTS[pattern];
  if (pattern === 'weekly') return 12;
  if (pattern === 'biweekly') return 12;
  return 4;
}

function copyIfPresent(target, source, fields) {
  for (const field of fields) {
    if (source[field] !== undefined) target[field] = source[field];
  }
}

function buildRecurringFollowUpRows(parent = {}, opts = {}) {
  const pattern = normalizeRecurringPattern(opts.pattern || parent.recurring_pattern);
  const baseDate = dateOnly(opts.baseDate || parent.scheduled_date);
  if (!pattern || !baseDate || !parent.customer_id) return [];

  const plannedCount = plannedVisitCountForPattern(pattern, opts);
  if (plannedCount <= 1) return [];

  const shiftDir = opts.weekendShift === 'back' || parent.weekend_shift === 'back' ? 'back' : DEFAULT_WEEKEND_SHIFT;
  const skipWeekends = opts.skipWeekends !== undefined ? !!opts.skipWeekends : !!parent.skip_weekends;
  // B6: rows are stamped with caller/operator intent only; skipWeekends
  // above may additionally carry the customer's live weekday preference
  // (resolved by seedFollowUpsForParent) and drives just the date walk.
  const stampSkipWeekends = opts.stampSkipWeekends !== undefined ? !!opts.stampSkipWeekends : skipWeekends;
  const rOpts = recurrenceOrdinalOptions(baseDate, {
    nth: opts.recurringNth ?? parent.recurring_nth,
    weekday: opts.recurringWeekday ?? parent.recurring_weekday,
    intervalDays: opts.recurringIntervalDays ?? parent.recurring_interval_days,
  });
  const existingDates = new Set([baseDate, ...(opts.existingDates || []).map(dateOnly).filter(Boolean)]);
  const rows = [];
  const parentId = opts.parentId || parent.id || parent.recurring_parent_id || null;
  const targetNewRows = Math.max(0, plannedCount - existingDates.size);
  if (targetNewRows === 0) return rows;
  const maxAttempts = (plannedCount - 1) * 4 + 30;

  // Owner blackout days (opts.blackoutDates: Set of YYYY-MM-DD, resolved by
  // the async caller): a seeded follow-up must not land on a day off. Nudge
  // forward a day at a time (re-applying the weekend shift) until clear —
  // skipping the visit entirely would silently shrink the customer's plan.
  const blackoutDates = opts.blackoutDates instanceof Set ? opts.blackoutDates : null;
  const clearOfBlackout = (dateStr) => nudgeOffBlackoutDates(dateStr, blackoutDates, { skipWeekends });

  // Weekend shift and blackout nudge can cross the season edge — clamp back
  // into Feb–Oct (see clampDateToSeason for the direction rules).
  const clampToSeason = (dateStr) => clampDateToSeason(pattern, dateStr, { skipWeekends, blackoutDates });

  let attempt = 1;
  while (rows.length < targetNewRows && attempt < maxAttempts) {
    const rawNext = nextRecurringDate(baseDate, pattern, attempt, rOpts);
    attempt++;
    const nextDateStr = clampToSeason(clearOfBlackout(shiftPastWeekend(rawNext, skipWeekends, shiftDir)));
    // A null candidate means the blackout nudge exhausted its bounded search
    // — skip it rather than book a closure.
    if (!nextDateStr) continue;
    if (recurringCandidateTooCloseToAnchor(baseDate, pattern, nextDateStr)) continue;
    if (existingDates.has(nextDateStr)) continue;
    existingDates.add(nextDateStr);

    const row = {
      customer_id: parent.customer_id,
      technician_id: opts.technicianId ?? parent.technician_id ?? null,
      scheduled_date: nextDateStr,
      window_start: parent.window_start || null,
      window_end: opts.windowEnd ?? (parent.window_end || null),
      service_type: opts.serviceType || parent.service_type || 'Service',
      status: opts.childStatus || 'pending',
      notes: opts.childNotes || parent.notes || null,
      time_window: parent.time_window || null,
      zone: parent.zone || null,
      estimated_duration_minutes: opts.durationMinutes ?? parent.estimated_duration_minutes ?? null,
      estimated_price: opts.estimatedPrice ?? parent.estimated_price ?? null,
      payment_method_preference: opts.paymentMethodPreference || parent.payment_method_preference || null,
      source_estimate_id: opts.sourceEstimateId || parent.source_estimate_id || null,
      source: opts.source || parent.source || null,
      is_recurring: true,
      recurring_pattern: pattern,
      recurring_parent_id: parentId,
      recurring_ongoing: opts.recurringOngoing !== false,
      customer_confirmed: false,
      confirmed_at: null,
      skip_weekends: stampSkipWeekends,
      weekend_shift: shiftDir,
    };
    if (rOpts.nth != null) row.recurring_nth = rOpts.nth;
    if (rOpts.weekday != null) row.recurring_weekday = rOpts.weekday;
    if (rOpts.intervalDays != null) row.recurring_interval_days = rOpts.intervalDays;
    // Classify from the row's own service_type rather than copying
    // parent.appointment_type: the AppointmentTagger stamps the parent
    // post-insert (fire-and-forget on the accept paths), so the parent's
    // tag may not exist yet when follow-ups seed in the same request.
    row.appointment_type = require('./appointment-tagger')
      .classifyAppointmentType(row.service_type).tag;
    copyIfPresent(row, parent, [
      'create_invoice_on_complete',
      'annual_prepay_term_id',
      // Catalog link: follow-ups must resolve the same completion profile
      // as their parent (combined services especially — name matching alone
      // breaks if the catalog row is ever renamed).
      'service_id',
      // Durable identity snapshot: children must survive the same
      // ON DELETE SET NULL catalog outage the parent does, or a cleared FK
      // leaves follow-ups resolving by mutable label while the parent keeps
      // its key (pre-push P1). Cols-guarded like the rest of the row.
      'service_key_snapshot',
      'lat',
      'lng',
      // Stamped service address (property linkage): a series booked for a
      // secondary/rental property carries a visit-level stamp; follow-ups
      // must inherit it or every reader's COALESCE(service_address_*,
      // customers.address_*) falls back to the customer's PRIMARY address
      // and the visit dispatches to the wrong property. Cols-guarded like
      // the rest of the row — the insert path maps through filterByColumns.
      'property_id',
      'service_address_line1',
      'service_address_line2',
      'service_address_city',
      'service_address_state',
      'service_address_zip',
      // Inert legacy names: scheduled_services has no plain
      // address/city/state/zip columns, so a real parent row never carries
      // these keys (copyIfPresent skips) and filterByColumns would strip
      // them from the insert anyway. Left in place rather than removed —
      // this exported builder is driven directly by other suites and the
      // cleanup belongs to its own change; the service_address_* columns
      // above are the live stamp.
      'address',
      'city',
      'state',
      'zip',
    ]);
    rows.push(row);
  }

  // Blackout/day-off exhaustion must not silently shrink the plan: when the
  // bounded walk cannot place every requested follow-up, report it — callers
  // (booking confirm, estimate conversion) return success on whatever
  // seeded, and an undersized series is otherwise invisible until the
  // customer's visits run out. The builder itself stays side-effect-free
  // (it can run inside a caller transaction that later rolls back): the
  // shortfall rides the returned array as a non-enumerable property, and
  // seedFollowUpsForParent rings the admin bell only after the seed commits.
  if (rows.length < targetNewRows) {
    Object.defineProperty(rows, 'seedShortfall', {
      value: { requested: targetNewRows, placed: rows.length },
      enumerable: false,
    });
  }

  return rows;
}

// Post-commit shortfall bell — see buildRecurringFollowUpRows. bell: true is
// load-bearing: under GATE_ADMIN_BELL_POLICY the generic 'alert' category is
// not allowlisted and the notification would be silently discarded. The
// dedupeKey keeps a retried seed from stacking identical bells. Best-effort:
// a notification failure never fails the seeding.
function notifySeedShortfall(parent, shortfall) {
  if (!shortfall) return;
  const parentId = parent?.id || null;
  const dedupeKey = `recurring-seed-shortfall:${parentId || 'n/a'}:${shortfall.placed}/${shortfall.requested}`;
  const shortfallMsg = `Recurring plan for customer ${parent?.customer_id || 'n/a'} wanted ${shortfall.requested} follow-up visit(s) but only ${shortfall.placed} could be placed — the rest fall on blackout days or closed weekdays. Adjust the days-off/blackout settings or add the missing visits manually.`;
  require('./logger').warn(`[recurring-seeder] parent=${parentId || 'n/a'} ${shortfallMsg}`);
  Promise.resolve()
    .then(async () => {
      // Real dedupe, not just a stamped key: the admin notifyAdmin path has
      // no dedupe lookup of its own (only the customer path does), so check
      // the notifications metadata directly before inserting. Best-effort —
      // a concurrent double-fire can still race past this, but retried
      // seeds (the common repeat) no longer stack identical bells.
      const db = require('../models/db');
      const existing = await db('notifications')
        .where({ recipient_type: 'admin' })
        .whereRaw("metadata->>'dedupeKey' = ?", [dedupeKey])
        .first('id')
        .catch(() => null);
      if (existing) return;
      await require('./notification-service').notifyAdmin(
        'alert',
        'Recurring plan seeded short',
        shortfallMsg,
        {
          link: parent?.customer_id ? `/admin/customers/${parent.customer_id}` : '/admin/schedule',
          bell: true,
          metadata: {
            dedupeKey,
            customer_id: parent?.customer_id || null,
            recurring_parent_id: parentId,
            requested: shortfall.requested,
            placed: shortfall.placed,
          },
        },
      );
    })
    .catch((err) => require('./logger').warn(`[recurring-seeder] shortfall notification failed (non-blocking): ${err.message}`));
}

async function scheduledServiceColumns(conn) {
  try {
    return await conn('scheduled_services').columnInfo();
  } catch {
    return null;
  }
}

function filterByColumns(row, columns) {
  if (!columns) return row;
  return Object.fromEntries(Object.entries(row).filter(([key]) => columns[key]));
}

async function markParentRecurring(conn, parent, pattern, opts = {}) {
  const parentId = typeof parent === 'object' ? parent?.id : parent;
  const normalizedPattern = normalizeRecurringPattern(pattern);
  if (!parentId || !normalizedPattern) return 0;
  const columns = opts.columns || await scheduledServiceColumns(conn);
  const baseDate = typeof parent === 'object' ? dateOnly(parent.scheduled_date) : null;
  const rOpts = baseDate ? recurrenceOrdinalOptions(baseDate, {
    nth: opts.recurringNth ?? parent.recurring_nth,
    weekday: opts.recurringWeekday ?? parent.recurring_weekday,
    intervalDays: opts.recurringIntervalDays ?? parent.recurring_interval_days,
  }) : {};
  const updates = filterByColumns({
    is_recurring: true,
    recurring_pattern: normalizedPattern,
    recurring_ongoing: opts.recurringOngoing !== false,
    skip_weekends: opts.skipWeekends !== undefined ? !!opts.skipWeekends : true,
    weekend_shift: opts.weekendShift === 'back' ? 'back' : DEFAULT_WEEKEND_SHIFT,
    recurring_nth: rOpts.nth,
    recurring_weekday: rOpts.weekday,
    recurring_interval_days: rOpts.intervalDays,
    updated_at: new Date(),
  }, columns);
  if (!Object.keys(updates).length) return 0;
  return conn('scheduled_services').where({ id: parentId }).update(updates);
}

async function existingSeriesDates(conn, parent, columns) {
  const dates = [dateOnly(parent?.scheduled_date)].filter(Boolean);
  if (!parent?.id || !columns?.recurring_parent_id) return dates;
  const rows = await conn('scheduled_services')
    .where(function () {
      this.where({ id: parent.id }).orWhere({ recurring_parent_id: parent.id });
    })
    .whereNotIn('status', ['cancelled', 'rescheduled'])
    .select('scheduled_date')
    .catch(() => []);
  for (const row of rows || []) {
    const d = dateOnly(row.scheduled_date);
    if (d) dates.push(d);
  }
  return [...new Set(dates)];
}

// Find this customer's ACTIVE recurring series parents in the same service
// family — the duplicate-series guard shared by the three series creators
// (estimate-converter auto-schedule, booking.js self-book seeding, admin
// POST /admin/schedule). A parent is a non-cancelled scheduled_services row
// with is_recurring=true and no recurring_parent_id; it is ACTIVE when it is
// flagged recurring_ongoing (auto-refills) or the series still has an
// upcoming (pending/confirmed, today-or-later ET) visit. A fully-lapsed
// series never blocks a new one.
//
// Service-family match: service_id equality when both sides carry one (the
// catalog link survives renames), OR the serviceKeyFor normalization of
// service_type. Exact service_type string equality is too narrow — the three
// creators stamp different labels for the same program ("Quarterly Pest
// Control" vs a catalog display name), so the family key is the shared
// serviceKeyFor buckets.
//
// excludeParentId: callers that already inserted their own first-visit row
// (booking.js) pass it so the fresh row can never match itself.
// Returns [] when nothing matches; matches carry next_upcoming_date (ET
// date string) when the series has a future visit.
// The duplicate-guard FAMILY classifier — used by BOTH the matcher and
// the advisory-lock keys (codex r22 pre-push P0: deriving them
// differently let an alias-labeled creator and a canonical creator take
// different family locks and both seed). Palm-first with injection vs
// nutritional as distinct identities; every other family is exactly
// serviceKeyFor. Lazy converter require — it loads this module at boot.
function duplicateGuardFamilyKey(label) {
  try {
    const { seedingFamilyKey, isPalmInjectionFamily } = require('./estimate-converter');
    const fam = seedingFamilyKey({}, { service_type: label });
    if (fam === 'palm_injection') {
      return isPalmInjectionFamily({}, { service_type: label }) ? 'palm_injection' : 'palm_nutritional';
    }
    return fam;
  } catch {
    return serviceKeyFor({ service_type: label });
  }
}

async function findActiveRecurringSeries(conn, {
  customerId,
  serviceId = null,
  serviceType = null,
  excludeParentId = null,
  // Per-property scope (codex #3244 r1): a multi-property group's second
  // estimate resolves to the SAME customer, so a customer+family match alone
  // reads the first property's series as a duplicate and skips seeding the
  // second property's schedule entirely. When set ({ estimateStreet,
  // customerPrimaryStreet }, both normalized), a parent series only counts as
  // a duplicate when its service address (stamped service_address_line1, or
  // the customer's primary street for unstamped/legacy rows) matches the
  // accepting estimate's street. Null → exact legacy behavior.
  serviceAddressScope = null,
} = {}) {
  if (!conn || !customerId || (serviceId == null && !serviceType)) return [];
  const columns = await scheduledServiceColumns(conn);
  if (!columns || !columns.is_recurring || !columns.recurring_parent_id) return [];
  const query = conn('scheduled_services')
    .where({ customer_id: customerId, is_recurring: true })
    .whereNull('recurring_parent_id')
    // Only a CANCELLED parent is out of the candidate set. A 'rescheduled'
    // parent is a live first visit awaiting re-placement (customer
    // reschedule path, streamline gates off) whose follow-ups stay
    // active — excluding it here let a later booking activate a second
    // same-family billable series over them (codex #3504 r16). Whether
    // the series is still active is decided below by the ongoing flag /
    // upcoming-row probe, exactly as for pending/confirmed parents.
    .whereNotIn('status', ['cancelled'])
    .select('id', 'service_type', 'recurring_pattern', 'scheduled_date', 'status');
  if (columns.service_id) query.select('service_id');
  if (columns.property_id) query.select('property_id');
  if (columns.service_address_line1) query.select('service_address_line1');
  if (columns.service_address_line2) query.select('service_address_line2');
  if (columns.service_address_city) query.select('service_address_city');
  if (columns.service_address_zip) query.select('service_address_zip');
  // Which estimate created the existing series — lets the duplicate-conflict
  // payload prove to a retrying client that the series IS the one its
  // partial save already created (codex r21 P0).
  if (columns.source_estimate_id) query.select('source_estimate_id');
  if (columns.recurring_ongoing) query.select('recurring_ongoing');
  if (excludeParentId) query.whereNot('id', excludeParentId);
  const parents = await query;
  // Palm-first family classification for BOTH sides (codex r21 pre-push
  // P0), shared with the advisory-lock keys via duplicateGuardFamilyKey
  // (codex r22 pre-push P0).
  const familyKeyOf = (label) => duplicateGuardFamilyKey(label);
  const targetKey = serviceType ? familyKeyOf(serviceType) : null;
  const matches = [];
  for (const parent of parents || []) {
    const idMatch = serviceId != null && parent.service_id != null
      && String(parent.service_id) === String(serviceId);
    const keyMatch = targetKey != null && parent.service_type
      && familyKeyOf(parent.service_type) === targetKey;
    if (!idMatch && !keyMatch) continue;
    if (serviceAddressScope
      && ((serviceAddressScope.estimatePropertyId && columns.property_id)
        || (columns.service_address_line1 && serviceAddressScope.estimateStreet))) {
      // property_id is authoritative when BOTH sides carry it (codex #3431
      // r4): a property-linked estimate scopes even with a blank/rejected
      // address, and a stamped parent id decides without a street compare.
      // Parent property id: the stamped column, or recovered from the
      // creating estimate (codex #3431 r10 — a pid-linked accepting
      // estimate with no usable address could not otherwise distinguish
      // an unstamped legacy parent whose source estimate is linked to a
      // DIFFERENT property, and would wrongly suppress the new series).
      let parentPid = parent.property_id ? String(parent.property_id) : '';
      if (serviceAddressScope.estimatePropertyId && !parentPid && parent.source_estimate_id) {
        try {
          const srcRow = await sourceEstimateForScope(conn, parent.source_estimate_id);
          if (srcRow?.property_id) parentPid = String(srcRow.property_id);
        } catch { /* fall through to the address branch / fail-closed default */ }
      }
      if (serviceAddressScope.estimatePropertyId && parentPid) {
        if (parentPid !== String(serviceAddressScope.estimatePropertyId)) continue;
        // Same property by id — a duplicate candidate; no street compare.
      } else if (serviceAddressScope.estimateStreet && columns.service_address_line1) {
        const { normalizedEstimateStreet, normalizedStampedStreet, sameScopeKey, scopeKeyLacksLocality } = require('./estimate-property-linkage');
        // Unit-aware mode travels WITH the scope (codex #3431 r2): the scope's
        // own candidate-key builders key parents the same way estimateStreet
        // was keyed (unit-blind when the estimate is unitless), so a unitless
        // estimate's re-quote still matches its unit-stamped parent series.
        // Legacy plain-shape scopes (no builders) keep the unit-retaining keys.
        const parentKeyOf = typeof serviceAddressScope.candidateKey === 'function'
          ? serviceAddressScope.candidateKey
          : normalizedStampedStreet;
        const parentKeyFromRaw = typeof serviceAddressScope.candidateKeyFromRaw === 'function'
          ? serviceAddressScope.candidateKeyFromRaw
          : normalizedEstimateStreet;
        // BLIND (unit-stripped) builders for street-IDENTITY questions —
        // a unit token is not street identity (codex #3431 r9); legacy
        // plain-shape scopes fall back to the retained builders.
        const parentBlindOf = typeof serviceAddressScope.blindKey === 'function'
          ? serviceAddressScope.blindKey
          : parentKeyOf;
        const parentBlindFromRaw = typeof serviceAddressScope.blindKeyFromRaw === 'function'
          ? serviceAddressScope.blindKeyFromRaw
          : parentKeyFromRaw;
        let parentStreet = parentKeyOf(parent.service_address_line1, parent.service_address_line2, parent.service_address_city, parent.service_address_zip);
        let parentBlind = parentBlindOf(parent.service_address_line1, parent.service_address_line2, parent.service_address_city, parent.service_address_zip);
        if ((!parentStreet || scopeKeyLacksLocality(parentStreet)) && parent.source_estimate_id) {
          // Unstamped parent: the post-commit linkage hook may not have run yet
          // (or the gate is off), and under concurrent group accepts the other
          // property's fresh series would otherwise read as the customer's
          // primary street and falsely match (codex #3244 r2). The creating
          // estimate's address committed in the SAME transaction as the parent,
          // so it is authoritative and race-free.
          try {
            const src = await sourceEstimateForScope(conn, parent.source_estimate_id);
            const recovered = parentKeyFromRaw(src?.address);
            if (recovered) {
              parentStreet = recovered;
              parentBlind = parentBlindFromRaw(src?.address);
            }
          } catch { /* fall back to the primary-street heuristic below */ }
        }
        const primary = String(serviceAddressScope.customerPrimaryStreet || '');
        const primaryBlind = String(serviceAddressScope.customerPrimaryBlind || primary);
        const estimateBlind = String(serviceAddressScope.blindEstimateKey || serviceAddressScope.estimateStreet || '');
        const streetSegment = (key) => String(key || '').split('|')[0];
        // Street-only ESTIMATE key: borrow the primary's locality when the
        // (unit-blind) streets agree (codex #3431 r4 — sameScopeKey would
        // otherwise wildcard a same-named street in another city).
        let estimateStreet = serviceAddressScope.estimateStreet;
        let effectiveEstimateBlind = estimateBlind;
        if (scopeKeyLacksLocality(estimateStreet) && primary
          && streetSegment(estimateBlind) === streetSegment(primaryBlind)) {
          estimateStreet = primary;
          effectiveEstimateBlind = primaryBlind;
        }
        if (parentStreet && scopeKeyLacksLocality(parentStreet)) {
          // Locality-less PARENT key after recovery (codex #3431 r4/r5):
          // borrow the primary's locality when the (unit-blind) streets
          // agree; a PLAINLY DIFFERENT street token is itself proof of
          // another property (r5 — a legacy line1-only secondary-property
          // series must not suppress the new property's seeding); only an
          // equal street token with unprovable locality counts as a
          // duplicate (fail closed — never seed a possibly-second series
          // on wildcard evidence).
          if (primary && streetSegment(parentBlind) === streetSegment(primaryBlind)) {
            parentStreet = primary;
            parentBlind = primaryBlind;
          } else if (streetSegment(parentBlind) !== streetSegment(effectiveEstimateBlind)) {
            continue;
          } else {
            parentStreet = '';
          }
        } else if (!parentStreet) {
          parentStreet = primary;
          parentBlind = primaryBlind;
        }
        // UNIT-ONLY mismatch stays a DUPLICATE only for the PRIMARY's own
        // unit (codex #3431 r9/r11): parent keys retain unit identity, so
        // a unitless estimate's re-quote (which means the primary) at its
        // own unit-stamped series mismatches on retained keys — the blind
        // keys agree AND the parent's retained key equals the unit-bearing
        // primary key, and seeding a second series there would
        // double-bill. Fail closed. Any OTHER unit's parent at the street
        // stays a different property and must not suppress this series.
        const primaryRetained = String(serviceAddressScope.customerPrimaryRetained || '');
        if (parentStreet && !sameScopeKey(parentStreet, estimateStreet)
          && parentBlind && effectiveEstimateBlind && sameScopeKey(parentBlind, effectiveEstimateBlind)
          && primaryRetained && sameScopeKey(parentStreet, primaryRetained)) {
          parentStreet = '';
        }
        // DELIBERATE divergence from the adoption predicate's shared-
        // locality requirement (codex #3431 r6): a street match on
        // disjoint locality evidence (city-only vs zip-only) still counts
        // as a DUPLICATE here. Seeding a second series on non-proof
        // double-bills a same-property customer whose legacy stamp merely
        // lacks the matching locality field; a suppressed legitimate
        // new-property series surfaces in the duplicate-conflict payload
        // and is staff-recoverable. Fail closed.
        if (parentStreet && !sameScopeKey(parentStreet, estimateStreet)) continue;
      }
    }
    const upcoming = await conn('scheduled_services')
      .where(function () {
        this.where({ recurring_parent_id: parent.id }).orWhere({ id: parent.id });
      })
      .where('is_recurring', true)
      // 'rescheduled' is a LIVE visit awaiting re-placement (the customer
      // reschedule path leaves it on the books with that status when the
      // streamline gates are off) — a fixed-length series whose last
      // outstanding visit sits in that state is not lapsed, and reading
      // it as lapsed let a second same-family billable series activate
      // (codex #3504 r15).
      .whereIn('status', ['pending', 'confirmed', 'rescheduled'])
      .where('scheduled_date', '>=', etDateString())
      .orderBy('scheduled_date', 'asc')
      .first('scheduled_date');
    const ongoing = columns.recurring_ongoing ? parent.recurring_ongoing === true : false;
    if (!ongoing && !upcoming) continue; // lapsed series — a new one is legitimate
    matches.push({
      ...parent,
      next_upcoming_date: upcoming ? dateOnly(upcoming.scheduled_date) : null,
    });
  }
  return matches;
}

// Race-safe wrapper around findActiveRecurringSeries (P0: check-then-insert
// race). Running the guard OUTSIDE the seeding transaction let two concurrent
// creators both see "no series" and both seed. Callers invoke this INSIDE the
// transaction that inserts the parent/follow-ups: it serializes series
// creation on pg advisory xact locks (the hashed-key pattern shared with
// booking's self-booking-confirm/slot-reserve locks and the per-parent
// maintenance lock in admin-schedule) and re-runs the guard under the locks —
// the loser blocks until the winner's transaction commits, then sees the
// fresh series and skips.
//
// Lock keys mirror BOTH dimensions of the guard's OR-matcher (round 3, codex
// P0: a single family-only key let two creators with the SAME service_id but
// differently-normalized labels take different locks, both pass the re-check,
// and both seed). The predicate matches on service_id equality OR
// serviceKeyFor-family equality, so no single string covers every matching
// path — instead we take one lock per dimension the caller carries:
//   '<customerId>:family:<serviceKeyFor bucket>'   (when serviceType given)
//   '<customerId>:svc:<serviceId>'                 (when serviceId given)
// Two creators whose inserts the guard would cross-match share at least one
// dimension, so they contend on at least one common lock. Keys are sorted
// before acquisition so every creator takes them in the same order — two
// creators holding one lock each while waiting on the other's (swap deadlock)
// is impossible.
//
// The locks + guard query run in a SAVEPOINT (knex nested transaction) so a
// guard failure can never abort the caller's outer transaction; the advisory
// xact locks themselves survive savepoint release and hold until top-level
// commit. Fail-open BY DESIGN (the guard is protective, not load-bearing):
// errors are returned — never thrown — as { matches: [], guardError } so the
// caller logs and proceeds with seeding.
// The creating estimate's address/property stands in for an UNSTAMPED
// parent's ONLY while that estimate row is immutable. A quote-wizard draft
// is not: the funnel REVIVES and rewrites the same draft row for the
// customer's next quote (any address) while a self-booked series keeps
// pointing at it through source_estimate_id — reading a live draft back
// would re-home an older series to whatever was quoted LAST, and the
// duplicate guard would then strip the legitimate new-property booking
// (codex #3504 r14). A live wizard draft therefore yields NOTHING and the
// parent falls to the primary-street heuristic (over-suppression, never a
// wrong match); archived/promoted wizard rows no longer revive and stay
// usable, as do accept-path estimates.
async function sourceEstimateForScope(conn, estimateId) {
  const row = await conn('estimates')
    .where({ id: estimateId })
    .first('property_id', 'address', 'source', 'status', 'archived_at');
  if (!row) return null;
  if (row.source === 'quote_wizard' && row.status === 'draft' && !row.archived_at) return null;
  return row;
}

async function checkActiveSeriesLocked(trx, opts = {}) {
  try {
    const matches = await trx.transaction(async (guardTrx) => {
      const lockKeys = seriesCreateLockKeys(opts).sort();
      for (const lockKey of lockKeys) {
        await guardTrx.raw(
          'SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))',
          ['recurring-series-create', lockKey],
        );
      }
      return findActiveRecurringSeries(guardTrx, opts);
    });
    return { matches: matches || [], guardError: null };
  } catch (guardError) {
    return { matches: [], guardError };
  }
}

// The lock keys checkActiveSeriesLocked acquires for one series-creating
// unit — extracted so the derivation lives in exactly one place (the
// sorted-union pre-pass below must emit byte-identical keys or it stops
// covering the per-unit acquisitions).
function seriesCreateLockKeys({ customerId, serviceId = null, serviceType = null } = {}) {
  const keys = [];
  if (serviceType) {
    keys.push(`${customerId}:family:${duplicateGuardFamilyKey(serviceType)}`);
  }
  if (serviceId != null) {
    keys.push(`${customerId}:svc:${serviceId}`);
  }
  return keys;
}

// Sorted-union pre-acquisition for MULTI-UNIT series creators that hold their
// locks to a shared outer commit (P1: cross-conversion deadlock).
//
// checkActiveSeriesLocked sorts WITHIN one unit's keys, so single-unit
// creators can never swap-deadlock — but a caller-transaction conversion
// seeding several units acquires each unit's keys sequentially and holds all
// of them to the OUTER commit. Two such conversions processing the same
// families in different unit order each hold one family's locks while
// waiting on the other's → Postgres aborts one of them (deadlock detected)
// and the acceptance fails. The fix is the classic total-order discipline:
// collect EVERY unit's keys up front, sort the deduped union with the same
// default lexicographic comparator checkActiveSeriesLocked uses, and acquire
// them once before any unit processes. Each key is then > every key already
// held, for every creator (single-unit creators' sorted pairs conform to the
// same global order), so no hold-and-wait cycle can form.
//
// The per-unit checkActiveSeriesLocked calls that follow re-acquire keys the
// pre-pass already holds. pg_advisory_xact_lock is re-entrant within the
// owning session/transaction — "a lock can be acquired multiple times by its
// owning process" (PostgreSQL docs, Advisory Locks); transaction-level locks
// need no matching unlock and release at transaction end — so the re-acquire
// succeeds immediately without ever waiting, and creates no new wait edges.
//
// Acquired directly on the caller's transaction (no savepoint needed — the
// statement can only fail on connection loss, and callers treat this pass as
// protective/fail-open like the guard itself). Returns the sorted key list
// (asserted by the lane tests).
async function acquireSeriesCreateLocks(conn, units = []) {
  const keys = [...new Set(units.flatMap((unit) => seriesCreateLockKeys(unit)))].sort();
  for (const lockKey of keys) {
    await conn.raw(
      'SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))',
      ['recurring-series-create', lockKey],
    );
  }
  return keys;
}

// Auto tier alignment after a recurring series lands (owner directive
// 2026-07-28) — every flow that seeds a series (estimate accepts, public
// booking, pay-at-visit, prepay renewals, admin scheduling) gets the
// customer's WaveGuard tier stamped/upgraded in the same call, with the
// write rules (tier only for non-members, no comms) enforced inside the
// gated sync. Best-effort by design: the tier is derived state healed
// nightly by reconcileNoPlanRecurringTiers, so a sync failure must never
// fail the booking that seeded the series. Lazy requires keep this module
// dependency-light and cycle-free.
// Run the tier sync on the shared pool in a fresh transaction — used both
// directly (pool callers) and as the post-commit continuation below.
async function runTierSyncOnPool(customerId) {
  try {
    const db = require('../models/db');
    const { syncCustomerWaveGuardPlanFromScheduledServices } = require('./self-booking-plan-sync');
    await db.transaction(async (inner) => {
      await syncCustomerWaveGuardPlanFromScheduledServices({ database: inner, customerId });
    });
  } catch (err) {
    try {
      require('./logger').warn(`[recurring-seeder] WaveGuard tier sync failed for customer ${customerId}: ${err.message}`);
    } catch { /* never let logging fail anything */ }
  }
}

async function syncCustomerTierAfterSeeding(conn, customerId) {
  if (!customerId) return;
  try {
    const { isEnabled } = require('../config/feature-gates');
    if (!isEnabled('autoWaveguardTierEnroll')) return;
    // Inside a caller transaction, DEFER the sync until that transaction
    // settles (Codex #3011 r5 P1): seeding callers may already hold the
    // recurring-series-create advisory lock (booking.js takes advisory ->
    // then this would take the customers row lock), while estimate-converter
    // updates the customer FIRST and then waits on the same advisory lock —
    // opposite acquisition order, a deadlock; a victim savepoint in the
    // converter's fail-open advisory guard could even seed a duplicate
    // series. Post-commit the caller's locks are released, so the pool sync
    // acquires the customer row lock without holding anything else — no
    // cycle. On ROLLBACK there is no series, so there is nothing to sync;
    // any miss is healed by the nightly reconcile.
    if (conn.isTransaction && conn.executionPromise) {
      conn.executionPromise.then(
        () => runTierSyncOnPool(customerId),
        () => { /* rolled back — no series landed, nothing to sync */ },
      );
      return;
    }
    await runTierSyncOnPool(customerId);
  } catch (err) {
    try {
      require('./logger').warn(`[recurring-seeder] WaveGuard tier sync scheduling failed for customer ${customerId}: ${err.message}`);
    } catch { /* never let logging fail the seeding */ }
  }
}

// B6 (owner ruling 2026-08-27): property_preferences.preferred_day has no
// weekend values in its enum — a customer with ANY weekday preference has
// said "not weekends", so series generators treat that as skip_weekends
// unless the caller resolved it explicitly.
//
// Fail-OPEN is DELIBERATE policy, not an oversight: on a lookup error the
// caller keeps its pre-B6 behavior. Failing closed would block booking,
// estimate acceptance, series edits, and auto-extends — customer-facing
// availability — because an OPTIONAL preference read blipped; a missed
// weekend shift merely places a visit the customer can move. The miss is
// not silent either: the external e22 schedule-integrity cron flags every
// future visit whose weekday contradicts the stored preferred_day in its
// next daily run (ACT email), so a preference missed during an outage
// surfaces for repair within a day.
const WEEKDAY_PREF_VALUES = new Set(['monday', 'tuesday', 'wednesday', 'thursday', 'friday']);
async function customerPrefersNoWeekends(conn, customerId) {
  if (!conn || !customerId) return false;
  try {
    const read = (dbh) => dbh('property_preferences').where({ customer_id: customerId }).first('preferred_day');
    // SAVEPOINT (nested trx) when the caller handed us a transaction: a
    // failed optional lookup would leave that trx ABORTED in Postgres
    // despite this catch (try/catch in a trx ≠ fail-open) and every
    // scheduling write after it would 25P02. Rolling back to the
    // savepoint keeps the caller's transaction healthy.
    const row = conn.isTransaction && typeof conn.transaction === 'function'
      ? await conn.transaction((sp) => read(sp))
      : await read(conn);
    return WEEKDAY_PREF_VALUES.has(String(row?.preferred_day || '').toLowerCase());
  } catch {
    return false;
  }
}

// Blackout set over the whole seeding horizon (generous 15 months covers
// every planned-count/pattern combination) — the sync builder nudges any
// follow-up off a blocked date. Fail-open helper.
// Blackout reads run on the CALLER's connection (codex #3504 r20): the
// seeder is called from inside booking/activation transactions that each
// hold a pool connection, and a read through the global pool would need a
// second one — at pool saturation every activation waits on every other
// until the acquire timeout. getBlackoutLayers is the existing caller-
// aware mechanism (savepoint-wrapped, throws on failure — a failed read
// rolls its savepoint back instead of aborting the caller's transaction,
// and this helper's catch keeps the fail-open contract).
async function seedingBlackoutDates(conn, parent, opts = {}) {
  try {
    const { getBlackoutLayers } = require('./scheduling/blackout-dates');
    const baseDate = dateOnly(opts.baseDate || parent.scheduled_date);
    const layers = await getBlackoutLayers(
      baseDate,
      etDateString(addETDays(parseETDateTime(`${baseDate}T12:00`), 460)),
      conn,
    );
    return layers?.dates || null;
  } catch { return null; /* fail open */ }
}

// The dates a seedFollowUpsForParent call with the SAME opts would insert —
// plain reads + the deterministic builder, no locks taken and nothing
// written. Lets a caller acquire the per-date occupancy locks (rung 1 of
// the scheduling/occupancy.js ordering contract) BEFORE its comms/row
// locks; the caller must re-verify the actual seeded dates stayed inside
// this plan (a concurrent series write between plan and seed can shift
// them) and fail closed on drift (codex #3504 r3 hook). Mirrors the seed
// call's B6 weekday-preference resolution so the planned dates match what
// the seeder will actually place.
async function planFollowUpSeedDates(conn, parent, opts = {}) {
  const pattern = normalizeRecurringPattern(opts.pattern || parent?.recurring_pattern);
  if (!conn || !parent?.id || !parent?.customer_id || !parent?.scheduled_date || !pattern) return [];
  const columns = opts.columns || await scheduledServiceColumns(conn);
  const stampSkipWeekends = opts.skipWeekends !== undefined ? !!opts.skipWeekends : !!parent.skip_weekends;
  const skipWeekends = stampSkipWeekends
    || await customerPrefersNoWeekends(conn, parent.customer_id);
  const existingDates = await existingSeriesDates(conn, parent, columns);
  const blackoutDates = await seedingBlackoutDates(conn, parent, opts);
  return [...new Set(
    buildRecurringFollowUpRows(parent, { ...opts, pattern, skipWeekends, stampSkipWeekends, existingDates, blackoutDates })
      .map((row) => dateOnly(row.scheduled_date))
      .filter(Boolean),
  )];
}

async function seedFollowUpsForParent(conn, parent, opts = {}) {
  const pattern = normalizeRecurringPattern(opts.pattern || parent?.recurring_pattern);
  if (!conn || !parent?.id || !parent?.customer_id || !parent?.scheduled_date || !pattern) {
    return { pattern, plannedCount: 0, insertedCount: 0, insertedRows: [] };
  }
  const columns = opts.columns || await scheduledServiceColumns(conn);
  // B6: seeded DATES honor the customer's live weekday preference, but
  // the STAMPED flag (parent + children) carries only caller/operator
  // intent — the preference is consulted live by every generator and the
  // rebooker, never persisted, so removing it restores weekend
  // eligibility without touching series rows.
  const stampSkipWeekends = opts.skipWeekends !== undefined ? !!opts.skipWeekends : !!parent.skip_weekends;
  const skipWeekends = stampSkipWeekends
    || await customerPrefersNoWeekends(conn, parent.customer_id);
  await markParentRecurring(conn, parent, pattern, {
    ...opts,
    skipWeekends: stampSkipWeekends,
    columns,
  });

  const existingDates = await existingSeriesDates(conn, parent, columns);
  const blackoutDates = await seedingBlackoutDates(conn, parent, opts);
  const builtRows = buildRecurringFollowUpRows(parent, {
    ...opts,
    pattern,
    skipWeekends,
    stampSkipWeekends,
    existingDates,
    blackoutDates,
  });
  const seedShortfall = builtRows.seedShortfall || null;
  // Ring the shortfall bell only once the seed is DURABLE: inside a caller
  // transaction, executionPromise resolves on commit and rejects on
  // rollback (a rolled-back seed must not report visits as placed); on a
  // plain connection the insert path below commits its own scoped trx
  // before this fires.
  const notifyShortfallAfterCommit = () => {
    if (!seedShortfall) return;
    if (conn.isTransaction && conn.executionPromise) {
      conn.executionPromise.then(
        () => notifySeedShortfall(parent, seedShortfall),
        () => {},
      );
    } else {
      notifySeedShortfall(parent, seedShortfall);
    }
  };
  const rows = builtRows.map((row) => filterByColumns(row, columns));

  if (!rows.length) {
    // Even with no NEW follow-up rows (series dates already exist), the parent
    // was just marked recurring — that alone is tier evidence.
    await syncCustomerTierAfterSeeding(conn, parent.customer_id);
    notifyShortfallAfterCommit();
    return {
      pattern,
      plannedCount: plannedVisitCountForPattern(pattern, opts),
      insertedCount: 0,
      insertedRows: [],
      seedShortfall,
    };
  }

  // Rung 6 (scheduling/occupancy.js ORDERING CONTRACT): the follow-up
  // inserts serialize against a concurrent merge-undo of this customer.
  // Callers inside a transaction (estimate-converter, admin-schedule) have
  // already taken this lock at their trx start — reentrant no-op; a plain
  // connection gets a scoped transaction (a bare advisory xact lock outside
  // one fences nothing).
  const inserted = conn.isTransaction
    ? await (async () => { await lockCustomerComms(conn, parent.customer_id); return conn('scheduled_services').insert(rows).returning('*'); })()
    : await withCustomerCommsLock(conn, parent.customer_id, (trx) => trx('scheduled_services').insert(rows).returning('*'));
  const insertedRows = Array.isArray(inserted) ? inserted : [];
  await syncCustomerTierAfterSeeding(conn, parent.customer_id);
  notifyShortfallAfterCommit();
  return {
    pattern,
    plannedCount: plannedVisitCountForPattern(pattern, opts),
    insertedCount: rows.length,
    insertedRows: insertedRows.length ? insertedRows : rows,
    seedShortfall,
  };
}

module.exports = {
  acquireSeriesCreateLocks,
  buildRecurringFollowUpRows,
  checkActiveSeriesLocked,
  sourceEstimateForScope,
  customerPrefersNoWeekends,
  findActiveRecurringSeries,
  seriesCreateLockKeys,
  inferRecurringPattern,
  SEASONAL_FEB_OCT,
  seasonalFebOctDate,
  clampDateToSeason,
  firstInSeasonDate,
  markParentRecurring,
  normalizeRecurringPattern,
  patternFromVisitsPerYear,
  plannedVisitCountForPattern,
  planFollowUpSeedDates,
  seedFollowUpsForParent,
  serviceKeyFor,
  shiftPastWeekend,
  _internals: {
    dateOnly,
    nextRecurringDate,
    recurrenceOrdinalOptions,
    recurringCandidateTooCloseToAnchor,
  },
};
