const {
  parseETDateTime,
  etParts,
  etDateString,
  addETDays,
  addETMonthsByWeekday,
  etNthWeekdayOfMonth,
} = require('../utils/datetime-et');

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
const DEFAULT_ONE_YEAR_COUNTS = {
  monthly: 12,
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
  if (MONTH_RECURRENCE_INTERVALS[raw] || ['weekly', 'biweekly', 'daily', 'custom'].includes(raw)) return raw;
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
    value.service || value.service_key || value.key || value.kind
    || value.name || value.label || value.displayName || value.service_type || ''
  ).toLowerCase();
  if (/lawn|turf|fertili[sz]|weed|fungus|chinch/.test(raw)) return 'lawn_care';
  if (/mosquito/.test(raw)) return 'mosquito';
  if (/tree|shrub|ornamental/.test(raw)) return 'tree_shrub';
  if (/palm/.test(raw)) return 'palm_injection';
  // Recurring spot-foam termite program. Matches the service key `foam_recurring`
  // and the "Recurring Foam Treatment" display name, but NOT the one-time
  // "Drill-and-Foam Termite" line (which has no recurring/foam_recurring token
  // and falls through to termite_bait below).
  if (/foam[_\s]*recurring|recurring[_\s]*foam/.test(raw)) return 'foam_recurring';
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
  if (MONTH_RECURRENCE_INTERVALS[pattern]) {
    return etDateString(addETMonthsByWeekday(base, MONTH_RECURRENCE_INTERVALS[pattern] * i, opts));
  }

  const intervals = { daily: 1, weekly: 7, biweekly: 14 };
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
  const clearOfBlackout = (dateStr) => {
    if (!blackoutDates || !blackoutDates.size) return dateStr;
    let candidate = dateStr;
    for (let nudge = 0; nudge < 14 && blackoutDates.has(candidate); nudge++) {
      candidate = shiftPastWeekend(
        etDateString(addETDays(parseETDateTime(`${candidate}T12:00`), 1)),
        skipWeekends,
        'forward',
      );
    }
    return candidate;
  };

  let attempt = 1;
  while (rows.length < targetNewRows && attempt < maxAttempts) {
    const rawNext = nextRecurringDate(baseDate, pattern, attempt, rOpts);
    attempt++;
    const nextDateStr = clearOfBlackout(shiftPastWeekend(rawNext, skipWeekends, shiftDir));
    if (recurringCandidateTooCloseToAnchor(baseDate, pattern, nextDateStr)) continue;
    if (existingDates.has(nextDateStr)) continue;
    existingDates.add(nextDateStr);

    const row = {
      customer_id: parent.customer_id,
      technician_id: opts.technicianId ?? parent.technician_id ?? null,
      scheduled_date: nextDateStr,
      window_start: parent.window_start || null,
      window_end: parent.window_end || null,
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
      skip_weekends: skipWeekends,
      weekend_shift: shiftDir,
    };
    if (rOpts.nth != null) row.recurring_nth = rOpts.nth;
    if (rOpts.weekday != null) row.recurring_weekday = rOpts.weekday;
    if (rOpts.intervalDays != null) row.recurring_interval_days = rOpts.intervalDays;
    copyIfPresent(row, parent, [
      'create_invoice_on_complete',
      'annual_prepay_term_id',
      // Catalog link: follow-ups must resolve the same completion profile
      // as their parent (combined services especially — name matching alone
      // breaks if the catalog row is ever renamed).
      'service_id',
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

  return rows;
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
async function findActiveRecurringSeries(conn, {
  customerId,
  serviceId = null,
  serviceType = null,
  excludeParentId = null,
} = {}) {
  if (!conn || !customerId || (serviceId == null && !serviceType)) return [];
  const columns = await scheduledServiceColumns(conn);
  if (!columns || !columns.is_recurring || !columns.recurring_parent_id) return [];
  const query = conn('scheduled_services')
    .where({ customer_id: customerId, is_recurring: true })
    .whereNull('recurring_parent_id')
    .whereNotIn('status', ['cancelled', 'rescheduled'])
    .select('id', 'service_type', 'recurring_pattern', 'scheduled_date', 'status');
  if (columns.service_id) query.select('service_id');
  if (columns.recurring_ongoing) query.select('recurring_ongoing');
  if (excludeParentId) query.whereNot('id', excludeParentId);
  const parents = await query;
  const targetKey = serviceType ? serviceKeyFor({ service_type: serviceType }) : null;
  const matches = [];
  for (const parent of parents || []) {
    const idMatch = serviceId != null && parent.service_id != null
      && String(parent.service_id) === String(serviceId);
    const keyMatch = targetKey != null && parent.service_type
      && serviceKeyFor({ service_type: parent.service_type }) === targetKey;
    if (!idMatch && !keyMatch) continue;
    const upcoming = await conn('scheduled_services')
      .where(function () {
        this.where({ recurring_parent_id: parent.id }).orWhere({ id: parent.id });
      })
      .where('is_recurring', true)
      .whereIn('status', ['pending', 'confirmed'])
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
    keys.push(`${customerId}:family:${serviceKeyFor({ service_type: serviceType })}`);
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

async function seedFollowUpsForParent(conn, parent, opts = {}) {
  const pattern = normalizeRecurringPattern(opts.pattern || parent?.recurring_pattern);
  if (!conn || !parent?.id || !parent?.customer_id || !parent?.scheduled_date || !pattern) {
    return { pattern, plannedCount: 0, insertedCount: 0, insertedRows: [] };
  }
  const columns = opts.columns || await scheduledServiceColumns(conn);
  await markParentRecurring(conn, parent, pattern, {
    ...opts,
    columns,
  });

  const existingDates = await existingSeriesDates(conn, parent, columns);
  // Owner blackout days over the whole seeding horizon (generous 15 months
  // covers every planned-count/pattern combination) — the sync builder
  // nudges any follow-up off a blocked date. Fail-open helper.
  let blackoutDates = null;
  try {
    const { getBlackoutDates } = require('./scheduling/blackout-dates');
    const baseDate = dateOnly(opts.baseDate || parent.scheduled_date);
    blackoutDates = await getBlackoutDates(
      baseDate,
      etDateString(addETDays(parseETDateTime(`${baseDate}T12:00`), 460)),
    );
  } catch { /* fail open */ }
  const rows = buildRecurringFollowUpRows(parent, {
    ...opts,
    pattern,
    existingDates,
    blackoutDates,
  }).map((row) => filterByColumns(row, columns));

  if (!rows.length) {
    return {
      pattern,
      plannedCount: plannedVisitCountForPattern(pattern, opts),
      insertedCount: 0,
      insertedRows: [],
    };
  }

  const inserted = await conn('scheduled_services').insert(rows).returning('*');
  const insertedRows = Array.isArray(inserted) ? inserted : [];
  return {
    pattern,
    plannedCount: plannedVisitCountForPattern(pattern, opts),
    insertedCount: rows.length,
    insertedRows: insertedRows.length ? insertedRows : rows,
  };
}

module.exports = {
  acquireSeriesCreateLocks,
  buildRecurringFollowUpRows,
  checkActiveSeriesLocked,
  findActiveRecurringSeries,
  seriesCreateLockKeys,
  inferRecurringPattern,
  markParentRecurring,
  normalizeRecurringPattern,
  patternFromVisitsPerYear,
  plannedVisitCountForPattern,
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
