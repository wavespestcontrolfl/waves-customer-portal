/**
 * Natural-language "when" parser for customer-facing slot search.
 * server/services/scheduling/parse-when.js
 *
 * Turns free text like "anything next Tuesday afternoon", "early July
 * mornings", or "this weekend" into a structured booking window:
 *   { dateFrom, dateTo, timeOfDay, understood, source }
 *
 * Primary path: Claude (FAST tier, env-overridable via SCHEDULE_SEARCH_MODEL)
 * with a single forced tool call so the model returns structured dates rather
 * than prose. Falls back to a deterministic regex parser when the API key is
 * missing or the call fails — same fallback discipline as estimate-assistant.js.
 *
 * Everything is anchored to Eastern Time (the fleet's timezone). The caller
 * passes its own min/max horizon; this module clamps the result into it.
 */
const logger = require('../logger');
const MODELS = require('../../config/models');
const { etParts, etDateString, addETDays } = require('../../utils/datetime-et');

let Anthropic = null;
try { Anthropic = require('@anthropic-ai/sdk'); } catch { Anthropic = null; }

const VALID_TIME_OF_DAY = new Set(['morning', 'afternoon', 'evening', 'any']);

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

function isYmd(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
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
  if (/\b(morning|mornings|a\.?m\.?|before noon|early)\b/.test(q)) return 'morning';
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
    const satDate = new Date(`${sat}T12:00:00Z`);
    const sun = new Date(satDate); sun.setUTCDate(sun.getUTCDate() + 1);
    return range(sat, sun.toISOString().slice(0, 10));
  }

  // Explicit weekday ("next tuesday", "on friday", "thursday")
  const dayMatch = q.match(/\b(next\s+)?(sunday|sun|monday|mon|tuesday|tues|tue|wednesday|weds|wed|thursday|thurs|thur|thu|friday|fri|saturday|sat)\b/);
  if (dayMatch) {
    const forceNext = !!dayMatch[1];
    return single(nextWeekday(now, WEEKDAYS[dayMatch[2]], forceNext));
  }

  // Month references ("july", "early july", "late june", "mid august")
  const monthMatch = q.match(/\b(early|mid|late|beginning of|end of)?\s*(january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sept|sep|october|oct|november|nov|december|dec)\b/);
  if (monthMatch) {
    const mod = (monthMatch[1] || '').trim();
    const monthIdx = MONTHS[monthMatch[2]];
    const { year, month } = etParts(now);
    // Pick this year if the month hasn't fully passed, else next year.
    let targetYear = year;
    if (monthIdx < month - 1) targetYear = year + 1;
    const lastDay = new Date(Date.UTC(targetYear, monthIdx + 1, 0)).getUTCDate();
    let fromDay = 1;
    let toDay = lastDay;
    if (mod === 'early' || mod === 'beginning of') { fromDay = 1; toDay = 10; }
    else if (mod === 'mid') { fromDay = 11; toDay = 20; }
    else if (mod === 'late' || mod === 'end of') { fromDay = 21; toDay = lastDay; }
    const mm = String(monthIdx + 1).padStart(2, '0');
    return range(`${targetYear}-${mm}-${String(fromDay).padStart(2, '0')}`, `${targetYear}-${mm}-${String(toDay).padStart(2, '0')}`);
  }

  // Relative weeks
  if (/\bnext\s+week\b/.test(q)) {
    const mon = nextWeekday(now, 1, true);
    const monDate = new Date(`${mon}T12:00:00Z`);
    const sun = new Date(monDate); sun.setUTCDate(sun.getUTCDate() + 6);
    return range(mon, sun.toISOString().slice(0, 10));
  }
  if (/\bthis\s+week\b/.test(q)) {
    return range(today, etDateString(addETDays(now, 6)));
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

// ---------- Claude path ----------

const SET_WINDOW_TOOL = {
  name: 'set_date_window',
  description: 'Record the service date range and time-of-day the customer is asking about.',
  input_schema: {
    type: 'object',
    properties: {
      date_from: { type: 'string', description: 'Earliest acceptable date, YYYY-MM-DD in Eastern Time. For a single requested day, equal to date_to.' },
      date_to: { type: 'string', description: 'Latest acceptable date, YYYY-MM-DD in Eastern Time.' },
      time_of_day: {
        type: 'string',
        enum: ['morning', 'afternoon', 'evening', 'any'],
        description: 'Preferred time of day. morning = before noon, afternoon = 12pm-5pm, evening = late afternoon. "any" when unspecified.',
      },
      understood: { type: 'boolean', description: 'true if the message expressed a real date or time preference; false if it had no schedulable meaning.' },
    },
    required: ['date_from', 'date_to', 'time_of_day', 'understood'],
  },
};

function buildSystemPrompt(now) {
  const todayStr = etDateString(now);
  const dow = now.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'America/New_York' });
  return `You convert a customer's natural-language scheduling request into a concrete date window for a Waves Pest Control service visit in Southwest Florida.

Today is ${dow}, ${todayStr} (Eastern Time). All dates you output must be in YYYY-MM-DD Eastern Time and on or after today.

Interpret relative phrases against today:
- "tomorrow" = the next day; "this weekend" = the upcoming Saturday-Sunday.
- A bare weekday ("Tuesday") = the next upcoming one. "next Tuesday" = the one in the following week.
- "early/mid/late <month>" = days 1-10 / 11-20 / 21-end of that month.
- A single requested day uses the same value for date_from and date_to.
- If no specific date is mentioned, set understood=false and use a sensible near-term window (today through ~14 days out).

Always respond by calling the set_date_window tool. Never write prose.`;
}

async function parseWithAnthropic(query, now) {
  if (!Anthropic || !process.env.ANTHROPIC_API_KEY) return null;
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const response = await client.messages.create({
    model: process.env.SCHEDULE_SEARCH_MODEL || MODELS.FAST,
    max_tokens: 300,
    system: buildSystemPrompt(now),
    tools: [SET_WINDOW_TOOL],
    tool_choice: { type: 'tool', name: 'set_date_window' },
    messages: [{ role: 'user', content: String(query || '').slice(0, 500) }],
  });
  const toolUse = (Array.isArray(response.content) ? response.content : [])
    .find((part) => part.type === 'tool_use' && part.name === 'set_date_window');
  if (!toolUse || !toolUse.input) return null;
  const { date_from, date_to, time_of_day, understood } = toolUse.input;
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
  try {
    parsed = await parseWithAnthropic(query, now);
    if (parsed) source = 'anthropic';
  } catch (err) {
    logger.warn(`[parse-when] AI parse failed: ${err.message}`);
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
