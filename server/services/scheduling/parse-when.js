/**
 * Natural-language "when" parser for customer-facing slot search.
 * server/services/scheduling/parse-when.js
 *
 * Turns free text like "anything next Tuesday afternoon", "early July
 * mornings", or "this weekend" into a structured booking window:
 *   { dateFrom, dateTo, timeOfDay, understood, source }
 *
 * Primary path: OpenAI Luna with Claude Sonnet backup, returning structured
 * JSON. Falls back to a deterministic regex parser when both providers miss.
 *
 * Everything is anchored to Eastern Time (the fleet's timezone). The caller
 * passes its own min/max horizon; this module clamps the result into it.
 */
const logger = require('../logger');
const MODELS = require('../../config/models');
const { etParts, etDateString, addETDays, validCalendarDate } = require('../../utils/datetime-et');
const llmCall = require('../llm/call');

const VALID_TIME_OF_DAY = new Set(['morning', 'afternoon', 'evening', 'any']);
const AI_PARSE_TIMEOUT_MS = 4000;

const WEEKDAYS = {
  sunday: 0, sun: 0,
  monday: 1, mon: 1,
  tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3, weds: 3,
  thursday: 4, thu: 4, thur: 4, thurs: 4,
  friday: 5, fri: 5,
  saturday: 6, sat: 6,
};

const MONTHS = {
  january: 0, jan: 0, february: 1, feb: 1, march: 2, mar: 2, april: 3, apr: 3,
  may: 4, june: 5, jun: 5, july: 6, jul: 6, august: 7, aug: 7,
  september: 8, sep: 8, sept: 8, october: 9, oct: 9, november: 10, nov: 10,
  december: 11, dec: 11,
};

const MONTH_PATTERN = 'january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sept|sep|october|oct|november|nov|december|dec';
const WEEKDAY_PATTERN = 'sunday|sun|monday|mon|tuesday|tues|tue|wednesday|weds|wed|thursday|thurs|thur|thu|friday|fri|saturday|sat';
const NEGATION_CONSTRAINT_RE = /\b(?:except|not|no|other than|besides|can'?t(?:\s+do)?|cannot(?:\s+do)?|don'?t(?:\s+want)?)\b/;
const FAST_TOD_PREFIX_RE = /^(?:(?:in\s+the\s+)?(?:morning|mornings|afternoon|afternoons|evening|evenings)|any\s*time|anything|sometime|on|for|in)\s+/i;
const FAST_TOD_SUFFIX_RE = /\s+(?:(?:in\s+the\s+)?(?:morning|mornings|afternoon|afternoons|evening|evenings)|any\s*time|please)$/i;
// Strict whole-string date grammars for the instant $0 deterministic fast path.
// Any extra words (negations like "Can't do Friday", multi-dates like "12/3 and 12/4",
// "next week", clock times, or qualifiers) fail the whole-string match and go to AI.
const FAST_DATE_CORE_RES = [
  /^(?:today|tonight|tomorrow)$/,
  /^(?:(?:this|next)\s+)?weekend$/,
  /^this\s+week$/,
  new RegExp(`^(?:(?:this|next)\\s+)?(?:${WEEKDAY_PATTERN})$`),
  /^\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?$/,
  new RegExp(`^(?:${MONTH_PATTERN})\\s+\\d{1,2}(?:st|nd|rd|th)?(?:\\s+\\d{4})?$`),
  new RegExp(`^\\d{1,2}(?:st|nd|rd|th)?(?:\\s+of)?\\s+(?:${MONTH_PATTERN})(?:\\s+\\d{4})?$`),
  new RegExp(`^(?:(?:early|mid|late|beginning of|end of)\\s+)?(?:${MONTH_PATTERN})$`),
];

function isYmd(value) {
  return Boolean(validCalendarDate(value));
}

function shiftEtDate(ymd, days) {
  return etDateString(addETDays(new Date(`${ymd}T12:00:00Z`), days));
}

function resolveCalendarDate(monthNum, dayNum, explicitYear, now) {
  const mm = String(monthNum).padStart(2, '0');
  const dd = String(dayNum).padStart(2, '0');
  if (explicitYear != null) {
    const yyyy = explicitYear < 100 ? 2000 + explicitYear : explicitYear;
    return validCalendarDate(`${yyyy}-${mm}-${dd}`);
  }
  const { year } = etParts(now);
  const today = etDateString(now);
  const thisYear = validCalendarDate(`${year}-${mm}-${dd}`);
  if (thisYear && thisYear >= today) return thisYear;
  return validCalendarDate(`${year + 1}-${mm}-${dd}`);
}

function parseExplicitDate(q, now) {
  const iso = q.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (iso) {
    const valid = validCalendarDate(iso[1]);
    return valid ? { date: valid } : { invalid: true };
  }
  const slash = q.match(/\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\b/);
  if (slash) {
    const resolved = resolveCalendarDate(Number(slash[1]), Number(slash[2]), slash[3] ? Number(slash[3]) : null, now);
    return resolved ? { date: resolved } : { invalid: true };
  }
  const monthDay = q.match(new RegExp(`\\b(${MONTH_PATTERN})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s*(\\d{4}))?\\b`));
  if (monthDay) {
    const resolved = resolveCalendarDate(MONTHS[monthDay[1]] + 1, Number(monthDay[2]), monthDay[3] ? Number(monthDay[3]) : null, now);
    return resolved ? { date: resolved } : { invalid: true };
  }
  const dayMonth = q.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH_PATTERN})\\.?(?:,?\\s*(\\d{4}))?\\b`));
  if (dayMonth) {
    const resolved = resolveCalendarDate(MONTHS[dayMonth[2]] + 1, Number(dayMonth[1]), dayMonth[3] ? Number(dayMonth[3]) : null, now);
    return resolved ? { date: resolved } : { invalid: true };
  }
  return null;
}

function canFastParseDeterministically(query) {
  let core = String(query || '').trim().toLowerCase().replace(/[?.!,]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!core || core.length > 80) return false;
  // Strip only allowlisted polite/time-of-day modifiers at the edges; any
  // unconsumed words (e.g. "can't do", "and 12/4", "except") stay in `core`
  // and fail the strict whole-string match below.
  let prev;
  do {
    prev = core;
    core = core.replace(FAST_TOD_PREFIX_RE, '').replace(FAST_TOD_SUFFIX_RE, '').trim();
  } while (core !== prev);
  return isYmd(core) || FAST_DATE_CORE_RES.some((re) => re.test(core));
}

function clampDate(date, minDate, maxDate) {
  if (date < minDate) return minDate;
  if (date > maxDate) return maxDate;
  return date;
}

function normalizeTimeOfDay(value) {
  const v = String(value || '').trim().toLowerCase();
  return VALID_TIME_OF_DAY.has(v) ? v : 'any';
}

// ---------- deterministic fallback ----------

function timeOfDayFromText(q) {
  // Note: "early" is intentionally NOT a morning trigger — it almost always
  // modifies a date ("early July", "early next week"), not a time of day, and
  // matching it here would wrongly strip every afternoon slot from those searches.
  if (/\b(morning|mornings|a\.?m\.?|before noon)\b/.test(q)) return 'morning';
  if (/\b(evening|evenings|after work|night|tonight)\b/.test(q)) return 'evening';
  if (/\b(afternoon|afternoons|p\.?m\.?|midday|lunch)\b/.test(q)) return 'afternoon';
  return 'any';
}

// Next calendar date (YYYY-MM-DD) matching a weekday, on or after `now`.
// `forceNext` skips today even when today already matches (for "next <day>").
function nextWeekday(now, targetDow, forceNext) {
  const todayDow = etParts(now).dayOfWeek;
  let delta = (targetDow - todayDow + 7) % 7;
  if (delta === 0 && forceNext) delta = 7;
  if (forceNext && delta < 7) delta += 7; // "next" = the one in the following week
  return etDateString(addETDays(now, delta));
}

// The date of a named weekday. Without `afterToday` it is the first one on or after
// today; with it, the first one AFTER today (1 to 7 days out). So "next Tuesday"
// asked on a Friday is the Tuesday three days later, and asked on a Tuesday it is a
// week out (owner 2026-11-06; it used to mean the Tuesday of the following week).
function weekdayFrom(now, targetDow, afterToday) {
  const skip = afterToday ? 1 : 0;
  const delta = ((targetDow - etParts(now).dayOfWeek - skip + 7) % 7) + skip;
  return etDateString(addETDays(now, delta));
}

function parseMonthRange(q, now) {
  const monthMatch = q.match(/\b(early|mid|late|beginning of|end of)?\s*(january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sept|sep|october|oct|november|nov|december|dec)\b/);
  if (!monthMatch) return null;
  const mod = (monthMatch[1] || '').trim();
  const monthIdx = MONTHS[monthMatch[2]];
  const { year, month } = etParts(now);
  // Pick this year if the month hasn't fully passed, else next year.
  const targetYear = monthIdx < month - 1 ? year + 1 : year;
  const lastDay = new Date(Date.UTC(targetYear, monthIdx + 1, 0)).getUTCDate();
  const bounds = {
    early: [1, 10], 'beginning of': [1, 10], mid: [11, 20], late: [21, lastDay], 'end of': [21, lastDay],
  };
  const [fromDay, toDay] = bounds[mod] || [1, lastDay];
  const mm = String(monthIdx + 1).padStart(2, '0');
  return {
    dateFrom: `${targetYear}-${mm}-${String(fromDay).padStart(2, '0')}`,
    dateTo: `${targetYear}-${mm}-${String(toDay).padStart(2, '0')}`,
  };
}

function fallbackParse(query, now) {
  const q = String(query || '').toLowerCase();
  const timeOfDay = timeOfDayFromText(q);
  const today = etDateString(now);

  const single = (dateStr) => ({ dateFrom: dateStr, dateTo: dateStr, timeOfDay, understood: true });
  const range = (fromStr, toStr) => ({ dateFrom: fromStr, dateTo: toStr, timeOfDay, understood: true });

  if (/\btoday\b|\btonight\b/.test(q)) return single(today);
  if (/\btomorrow\b/.test(q)) return single(etDateString(addETDays(now, 1)));

  // Weekends
  if (/\bweekend\b/.test(q)) {
    const isNext = /\bnext\b/.test(q);
    const dow = etParts(now).dayOfWeek;
    // Mid-weekend with no "next": Saturday → Sat+Sun; Sunday → just today.
    if (!isNext && dow === 0) return single(today);
    if (!isNext && dow === 6) return range(today, etDateString(addETDays(now, 1)));
    const sat = nextWeekday(now, 6, isNext);
    return range(sat, shiftEtDate(sat, 1));
  }

  // Explicit calendar date ("Dec 3", "December 3rd", "12/3", "2026-12-03")
  // runs BEFORE bare month matching so "Dec 3" resolves to Dec 3 (not Dec 1–31),
  // impossible dates like "Feb 30" stop instead of matching all of Feb, and
  // boundary/negated/multi-date phrases ("after 12/3", "12/3 or 12/4", "except 12/3")
  // never collapse to one date on fallback.
  const explicitDate = parseExplicitDate(q, now);
  if (explicitDate) {
    return explicitDate.date && canFastParseDeterministically(q) && !NEGATION_CONSTRAINT_RE.test(q)
      ? single(explicitDate.date)
      : { dateFrom: null, dateTo: null, timeOfDay, understood: false };
  }

  // Explicit weekday ("next tuesday", "on friday", "thursday") — never match a
  // negated or excluded weekday ("except wednesday", "can't do next friday") on fallback.
  const dayMatch = NEGATION_CONSTRAINT_RE.test(q)
    ? null
    : q.match(new RegExp(`\\b(next\\s+)?(${WEEKDAY_PATTERN})\\b`));
  if (dayMatch) {
    return single(weekdayFrom(now, WEEKDAYS[dayMatch[2]], !!dayMatch[1]));
  }

  // Month references ("july", "early july", "late june", "mid august")
  const monthRange = parseMonthRange(q, now);
  if (monthRange) return range(monthRange.dateFrom, monthRange.dateTo);

  // Relative weeks ("next week" = upcoming Monday through Sunday, matching buildSystemPrompt)
  if (/\bnext\s+week\b/.test(q)) {
    const mon = weekdayFrom(now, 1, true);
    return range(mon, shiftEtDate(mon, 6));
  }
  if (/\bthis\s+week\b/.test(q)) {
    const daysToSunday = (7 - etParts(now).dayOfWeek) % 7;
    return range(today, shiftEtDate(today, daysToSunday));
  }
  if (/\bnext\s+month\b/.test(q)) {
    const { year, month } = etParts(now);
    const firstNext = new Date(Date.UTC(year, month, 1)); // month is 1-based → Date month index = month
    const lastNext = new Date(Date.UTC(year, month + 1, 0));
    return range(firstNext.toISOString().slice(0, 10), lastNext.toISOString().slice(0, 10));
  }

  // No date phrase recognized — leave the window to the caller's default,
  // but still pass along any time-of-day preference that was stated.
  return { dateFrom: null, dateTo: null, timeOfDay, understood: false };
}

// ---------- Cross-provider AI path ----------

function buildSystemPrompt(now) {
  const todayStr = etDateString(now);
  const dow = now.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'America/New_York' });
  return `You convert a customer's natural-language scheduling request into a concrete date window for a Waves Pest Control service visit in Southwest Florida.

Today is ${dow}, ${todayStr} (Eastern Time). All dates you output must be in YYYY-MM-DD Eastern Time and on or after today.

Interpret relative phrases against today:
- "tomorrow" = the next day; "this weekend" = the upcoming Saturday-Sunday.
- "next week" = the upcoming Monday through Sunday.
- A bare weekday ("Tuesday") = the next upcoming one (today counts). "next Tuesday" = the coming Tuesday, the first Tuesday after today.
- "early/mid/late <month>" = days 1-10 / 11-20 / 21-end of that month.
- A single requested day uses the same value for date_from and date_to.
- If no specific date is mentioned, set understood=false and use a sensible near-term window (today through ~14 days out).`;
}

// Structured-output contract (llm/call.js jsonSchema): the provider constrains
// the reply to this shape; isYmd below still rejects a malformed or impossible date.
const WHEN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['date_from', 'date_to', 'time_of_day', 'understood'],
  properties: {
    date_from: { type: 'string', description: 'Window start, YYYY-MM-DD Eastern Time, on or after today' },
    date_to: { type: 'string', description: 'Window end, YYYY-MM-DD Eastern Time, on or after date_from' },
    time_of_day: { type: 'string', enum: ['morning', 'afternoon', 'evening', 'any'] },
    understood: { type: 'boolean', description: 'false when no specific date was mentioned' },
  },
};

async function parseWithAI(query, now) {
  // Interactive customer-facing search: use fastStructuredInteractive (Luna, not the
  // slower reasoning model behind fastStructured) with a strict wait budget.
  const response = await llmCall.dispatchWithFallback(MODELS.TEXT_POLICIES.fastStructuredInteractive, {
    laneId: 'parse_when',
    maxTokens: 300,
    timeoutMs: AI_PARSE_TIMEOUT_MS,
    jsonMode: true,
    jsonSchema: WHEN_SCHEMA,
    system: buildSystemPrompt(now),
    text: String(query || '').slice(0, 500),
  });
  if (!response.ok || !response.json) return null;
  const { date_from, date_to, time_of_day, understood } = response.json;
  if (!isYmd(date_from) || !isYmd(date_to)) return null;
  return {
    dateFrom: date_from,
    dateTo: date_to,
    timeOfDay: normalizeTimeOfDay(time_of_day),
    understood: understood !== false,
  };
}

/**
 * @param {string} query              free-text request
 * @param {Object} [opts]
 * @param {Date}   [opts.now]
 * @param {number} [opts.minDaysOut]  earliest bookable offset from today (default 0)
 * @param {number} [opts.maxDaysOut]  horizon cap (default 90)
 * @param {number} [opts.defaultWindowDays] window when no date is recognized (default 14)
 * @returns {Promise<{dateFrom, dateTo, timeOfDay, understood, source}>}
 */
async function parseWhen(query, opts = {}) {
  const now = opts.now || new Date();
  const minDaysOut = Number.isFinite(opts.minDaysOut) ? opts.minDaysOut : 0;
  const maxDaysOut = Number.isFinite(opts.maxDaysOut) ? opts.maxDaysOut : 90;
  const defaultWindowDays = Number.isFinite(opts.defaultWindowDays) ? opts.defaultWindowDays : 14;

  const minDate = etDateString(addETDays(now, minDaysOut));
  const maxDate = etDateString(addETDays(now, maxDaysOut));

  let parsed = null;
  let source = 'fallback';
  // Instant, $0 deterministic path for clean date phrases ("Tomorrow morning",
  // "This weekend", "Sunday", "Dec 3", "12/3"); complex natural language falls
  // through to the fast interactive model below.
  if (canFastParseDeterministically(query)) {
    const fast = fallbackParse(query, now);
    if (fast.understood && isYmd(fast.dateFrom) && isYmd(fast.dateTo)) {
      parsed = fast;
      source = 'deterministic';
    }
  }
  if (!parsed) {
    try {
      parsed = await parseWithAI(query, now);
      if (parsed) source = 'ai';
    } catch (err) {
      logger.warn(`[parse-when] AI parse failed: ${err.message}`);
    }
  }
  if (!parsed) parsed = fallbackParse(query, now);

  // No recognized date → caller's near-term default window.
  let dateFrom = parsed.dateFrom;
  let dateTo = parsed.dateTo;
  if (!isYmd(dateFrom) || !isYmd(dateTo)) {
    dateFrom = minDate;
    dateTo = etDateString(addETDays(now, Math.min(defaultWindowDays, maxDaysOut)));
  }

  // Clamp into the caller's horizon and keep from <= to.
  dateFrom = clampDate(dateFrom, minDate, maxDate);
  dateTo = clampDate(dateTo, minDate, maxDate);
  if (dateTo < dateFrom) dateTo = dateFrom;

  return {
    dateFrom,
    dateTo,
    timeOfDay: normalizeTimeOfDay(parsed.timeOfDay),
    understood: parsed.understood !== false,
    source,
  };
}

// Friendly ET date label, e.g. "Tuesday, June 9".
function formatDayLabel(ymd) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  const dt = new Date(Date.UTC(y, (m || 1) - 1, d || 1, 12, 0, 0));
  return dt.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'America/New_York' });
}

// Shared, deterministic recap line for a Waves AI slot search — same phrasing
// across the public booking flow and the estimate page.
function summarizeWindow(when, { count = 0, nearby = false } = {}) {
  const from = formatDayLabel(when.dateFrom);
  const to = formatDayLabel(when.dateTo);
  const period = when.dateFrom === when.dateTo ? from : `${from} – ${to}`;
  const tod = when.timeOfDay && when.timeOfDay !== 'any' ? ` ${when.timeOfDay}` : '';
  if (!count) {
    return `I don't see an open${tod} window for ${period}. Try another day, or call (941) 297-5749 and we'll fit you in.`;
  }
  const plural = count === 1 ? 'time' : 'times';
  if (!nearby) {
    return `No route near you that day yet, but here ${count === 1 ? 'is' : 'are'} ${count} open ${plural} for ${period}.`;
  }
  return `Here ${count === 1 ? 'is' : 'are'} ${count} open ${plural} for ${period}${tod}.`;
}

module.exports = {
  parseWhen,
  summarizeWindow,
  formatDayLabel,
  _internals: { fallbackParse, nextWeekday, timeOfDayFromText },
};
