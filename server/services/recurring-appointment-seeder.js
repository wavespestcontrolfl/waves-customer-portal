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
  const maxAttempts = (plannedCount - 1) * 4 + 30;

  let attempt = 1;
  while (rows.length < plannedCount - 1 && attempt < maxAttempts) {
    const rawNext = nextRecurringDate(baseDate, pattern, attempt, rOpts);
    attempt++;
    const nextDateStr = shiftPastWeekend(rawNext, skipWeekends, shiftDir);
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
      'lat',
      'lng',
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
  const rows = buildRecurringFollowUpRows(parent, {
    ...opts,
    pattern,
    existingDates,
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
  buildRecurringFollowUpRows,
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
