/**
 * Tech rain-out flow — weather hits mid-route, the tech taps Rain Out,
 * picks where the visit (or the rest of today's route) goes, and the
 * customer gets a "we moved you" text.
 *
 * Design rule: the appointment NEVER goes unbooked. We move it first
 * (SmartRebooker.reschedule with allowLive — works from en_route /
 * on_site since PR #1555). The new slot is already booked, so the SMS
 * asks for nothing: if the time works the customer does nothing, and if
 * it doesn't they self-serve on the tokenized /reschedule/:token page —
 * the same link the 72h/24h reminders send. (The old reply-1/reply-2
 * flow is gone; replies to previously-sent texts still resolve via
 * reschedule-sms from their own reschedule_log rows.)
 *
 * Florida reality: storm cells roll in and roll back out, so the first
 * options offered are LATER TODAY (+2h / +4h), then SmartRebooker's
 * route-scored day options badged with NWS rain probabilities so the
 * tech doesn't reschedule into tomorrow's 65% thunderstorms.
 */

const db = require('../models/db');
const logger = require('./logger');
const SmartRebooker = require('./rebooker');
const { renderSmsTemplate } = require('./sms-template-renderer');
const { sendCustomerMessage } = require('./messaging/send-customer-message');
const { isRealProviderSend } = require('./sms-auto-send');
const { buildRescheduleLink } = require('./reschedule-link');
const { getDailyRainOutlook, getHourlyRainOutlook, forecastLinkForZip } = require('./weather-forecast');
const { etParts, etDateString } = require('../utils/datetime-et');
const { arrivalWindowRange, formatSmsTimeRange, ARRIVAL_WINDOW_MINUTES } = require('../utils/sms-time-format');

const WEATHER_PHRASES = {
  weather_rain: 'heavy rain',
  weather_wind: 'high winds',
  weather_lightning: 'lightning',
  weather_heat: 'extreme heat',
};

// Non-weather "Quick Move" reasons: the same move-first flow and SMS
// machinery, but the lead states the real operational cause and the copy
// makes no weather claims (no forecast fetch, no forecast link, no
// better-day/efficacy clauses — those already gate on rain/lightning).
// customer_noshow here is the SOFT path — visit rebooked + texted; the
// terminal no_show status flip (card-hold fee, invoice void, missed-you
// notice) stays on the appointment detail sheet. The rebooker's
// reschedule_log row (reason_code customer_noshow, customer_id) feeds the
// 2-in-90-days missed-appointment outreach counter automatically
// (workflows/missed-appointment.js counts rows by that reason code).
// All four are dark until the owner flips GATE_QUICKMOVE_EXTRA_REASONS:
// the chips are hidden in both sheets (options payload flag) and commit()
// rejects the codes, so the kill switch is a plain unset.
const EXTRA_REASON_LEADS = {
  running_late: "we're running behind schedule today",
  equipment_issue: 'we had equipment trouble today',
  tech_emergency: 'an emergency came up on our end',
  customer_noshow: 'we missed you today',
};
function extraReasonsEnabled() {
  return process.env.GATE_QUICKMOVE_EXTRA_REASONS === 'true';
}
function isExtraReason(reasonCode) {
  return Object.prototype.hasOwnProperty.call(EXTRA_REASON_LEADS, reasonCode);
}
function isValidReason(reasonCode) {
  return !!WEATHER_PHRASES[reasonCode] || (isExtraReason(reasonCode) && extraReasonsEnabled());
}

// Dispatcher-typed note appended to the end of the moved SMS ("Gate code
// still works, see you Friday!"). Two hard limits, both re-checked here
// because the sheet's mirrors are advisory only:
//   - 200 chars — the templates already run 2-3 segments; an unbounded
//     note lets one tap send a novel.
//   - no link shorteners — a shortened URL in an A2P campaign message is
//     a carrier violation the campaign can NOT be resubmitted after.
// On a route-scope move the note rides the ANCHOR stop's SMS only — the
// canonical note is stop-specific (gate codes, pet warnings), and fanning
// it to every remaining customer would disclose one customer's access
// details to strangers (codex pre-push P1). Siblings get the standard text.
const CUSTOMER_NOTE_MAX_CHARS = 200;
// Host boundaries = any non-domain character (or start/end): catches
// `(bit.ly/abc)`, `[t.co/x]`, and the valid trailing-root-dot form
// `bit.ly./abc`, while still passing lookalike words like `habit.ly`
// whose match is preceded by a domain character (codex pre-push P1 ×2).
const NOTE_SHORTENER_RE = /(?:^|[^a-z0-9-])(?:bit\.ly|tinyurl\.com|goo\.gl|t\.co|ow\.ly|is\.gd|buff\.ly|rb\.gy|tiny\.cc|cutt\.ly|shorturl\.at|rebrand\.ly)(?:$|[^a-z0-9-])/i;

// A blocklist of shortener hosts can never be complete (codex r2 P1:
// tiny.one, v.gd, …), so the real rule is: NO URL of any kind in a note.
// The moved SMS already carries the tokenized /reschedule link — a note
// has no legitimate need for another one. Four clickable families, each
// its own alternative (codex r3 P1 widened this beyond http/www + path):
//   1. any scheme:// URL (https, ftp, anything)
//   2. www.-prefixed hosts
//   3. host.tld immediately followed by a path/query/fragment
//   4. bare host with NO path ("tiny.one", "example.xyz") — validated
//      against the real public-suffix list (psl, already a dependency),
//      not a hand-kept TLD subset (codex r3 P1); prose pairs off the
//      list ("orbit.lyric", "p.m.") stay prose
//   5. IPv4 with optional port/path
// The named-shortener regex above stays as an extra layer for naked
// shortener hosts. NOTE: this makes typo-prose on real ccTLDs like
// "late.Be there" block too — late.be IS a registrable Belgian domain,
// and under a carrier-safety ban the false positive (add a space) is the
// cheap side of the trade.
const NOTE_URL_RE = new RegExp([
  '\\b[a-z][a-z0-9+.-]*://\\S+',
  '(?:^|[^a-z0-9.-])www\\.\\S+',
  '(?:^|[^a-z0-9.-])[a-z0-9][a-z0-9-]*(?:\\.[a-z0-9-]+)*\\.[a-z]{2,}[/?#]\\S',
  '(?:^|[^0-9.])(?:\\d{1,3}\\.){3}\\d{1,3}(?:[:/?#]\\S*)?(?=$|[^0-9])',
].join('|'), 'i');

// Dot-joined tokens that could be a hostname; each candidate is confirmed
// against the public-suffix list before it counts as a link.
const HOST_TOKEN_RE = /(?:^|[^a-z0-9.-])([a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)+)(?=$|[^a-z0-9-])/gi;
// Unicode-label candidates for bare IDNs ("пример.рф", "例子.中国") — the
// ASCII regex above never sees them (codex r4 P1). Each is punycoded via
// WHATWG domainToASCII and checked against the same suffix list, so prose
// like "café.Bueno" (no real suffix) still passes.
const UNICODE_HOST_TOKEN_RE = /([\p{L}\p{N}][\p{L}\p{N}-]*(?:\.[\p{L}\p{N}-]+)+)/gu;
function containsBareHost(text) {
  const psl = require('psl');
  for (const m of String(text).matchAll(HOST_TOKEN_RE)) {
    if (psl.isValid(m[1].toLowerCase())) return true;
  }
  const { domainToASCII } = require('url');
  for (const m of String(text).matchAll(UNICODE_HOST_TOKEN_RE)) {
    if (/^[\x20-\x7F]+$/.test(m[1])) continue; // ASCII handled above
    const ascii = domainToASCII(m[1].toLowerCase());
    if (ascii && psl.isValid(ascii)) return true;
  }
  return false;
}

// The regex is textual, so hosts hidden behind encodings that a URL parser
// (or a tapping thumb) canonicalizes back to the real hostname would slip
// it: `bit%2ely`, fullwidth `ｂｉｔ．ｌｙ`, ideographic-dot `bit。ly`,
// zero-width joins (codex PR P1). Check the shortener set against a
// canonicalized copy too: NFKC fold, unicode dot forms → '.', zero-width
// chars stripped, then bounded percent-decode.
function normalizeForLinkCheck(raw) {
  let out = String(raw).normalize('NFKC');
  out = out.replace(/[\u3002\uFF0E\uFF61]/g, '.');
  out = out.replace(/[\u200B-\u200D\u2060\uFEFF]/g, '');
  for (let i = 0; i < 3; i++) {
    let decoded;
    try { decoded = decodeURIComponent(out); } catch { break; }
    if (decoded === out) break;
    out = decoded;
  }
  return out;
}

function sanitizeCustomerNote(raw) {
  if (raw == null) return { note: null };
  if (typeof raw !== 'string') return { error: 'note_invalid' };
  const note = raw.replace(/\s+/g, ' ').trim();
  if (!note) return { note: null };
  if (note.length > CUSTOMER_NOTE_MAX_CHARS) return { error: 'note_too_long' };
  // Validate what the PROVIDER will see, not just what was typed: the send
  // path runs normalizeGsmPunctuation before its own guard, and that pass
  // deletes zero-width chars — "19​70" fuses into "1970" AFTER a raw-text
  // check would have passed (codex r4 P2). All content checks below run on
  // the GSM-normalized form (idempotent; ZWJ is preserved so emoji
  // detection is unaffected).
  const { normalizeGsmPunctuation } = require('./messaging/gsm-normalize');
  const gsm = normalizeGsmPunctuation(note);
  const canonical = normalizeForLinkCheck(gsm);
  if (NOTE_SHORTENER_RE.test(gsm) || NOTE_SHORTENER_RE.test(canonical)
    || NOTE_URL_RE.test(gsm) || NOTE_URL_RE.test(canonical)
    || containsBareHost(gsm) || containsBareHost(canonical)) {
    return { error: 'note_link_blocked' };
  }
  // Same emoji rule sendCustomerMessage enforces (validators/voice.js) —
  // checked HERE so an emoji note rejects BEFORE the move commits, instead
  // of committing the reschedule and then silently blocking the SMS with
  // EMOJI_FOR_CUSTOMER (codex PR P2).
  const { _internals: { findEmoji } } = require('./messaging/validators/voice');
  if (findEmoji(gsm).found) return { error: 'note_emoji_blocked' };
  // The outbound sms-guard rejects bodies containing unsubstituted {vars},
  // "undefined"/"null"/"1970" etc. AFTER assembly — a note like "Gate code
  // 1970 still works" would commit the move and then lose the SMS (codex
  // r2 P2). Run the same guard on the GSM-normalized note pre-move so it
  // fails loudly in the sheet instead. (empty-body/too-long can't trip
  // here: the note is non-blank and ≤200 chars.)
  const { validateOutbound } = require('./sms-guard');
  const guard = validateOutbound(gsm);
  if (!guard.ok) return { error: 'note_guard_blocked', guardReason: guard.reason };
  // Compliance-language hard rules (product-safety "safe" claims,
  // EPA-approved, fixed re-entry timing) apply to EVERY customer surface —
  // free-form notes included (codex pre-push r5/r6). This is the CANONICAL
  // clause-level checker from social-media.js (same regression matrix as
  // validateContent), not a parallel weaker copy: bare "safe once dry"
  // without technician-confirmed timing blocks here too.
  const { complianceLanguageIssues } = require('./social-media');
  const complianceIssues = complianceLanguageIssues(gsm);
  if (complianceIssues.length) return { error: 'note_compliance_blocked', complianceIssues };
  return { note };
}

// Customer-facing lead for the moved SMS, grounded in what we actually know
// instead of a fixed "heavy rain rolled through" claim (owner call,
// 2026-07-18). A same-day push means the tech is standing in the weather —
// present tense. A day move quotes today's NWS chance when we have one, and
// degrades to an honest generic when we don't (NWS is fail-open). Non-rain
// reasons state the real operational constraint rather than a weather label.
function composeWeatherLead({ reasonCode, isSameDay, hour, todayChance }) {
  if (EXTRA_REASON_LEADS[reasonCode]) return EXTRA_REASON_LEADS[reasonCode];
  if (reasonCode === 'weather_wind') return 'winds are too high to spray safely today';
  if (reasonCode === 'weather_lightning') return "there's lightning in the area";
  if (reasonCode === 'weather_heat') return "today's heat is too extreme to treat safely";
  if (isSameDay) {
    const partOfDay = hour < 12 ? 'morning' : (hour < 17 ? 'afternoon' : 'evening');
    return `rain is moving through your area this ${partOfDay}`;
  }
  if (todayChance != null && todayChance >= 60) return `storms are likely today (${todayChance}% chance)`;
  if (todayChance != null && todayChance >= 30) return `rain is in today's forecast (${todayChance}% chance)`;
  return "the weather isn't cooperating today";
}

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// 'Tomorrow' when the chosen date is literally tomorrow, else the weekday
// name. Date-only strings are anchored at UTC noon so the weekday can't
// slip a day in either hemisphere of a DST change.
function dayLabel(dateStr, todayStr) {
  const chosen = new Date(`${dateStr}T12:00:00Z`);
  if (Number.isNaN(chosen.getTime())) return null;
  const tomorrow = new Date(`${todayStr}T12:00:00Z`);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  if (tomorrow.toISOString().slice(0, 10) === String(dateStr)) return 'Tomorrow';
  return WEEKDAY_NAMES[chosen.getUTCDay()];
}

function partOfDay(hour) {
  return hour < 12 ? 'morning' : (hour < 17 ? 'afternoon' : 'evening');
}

// Max precip chance across the customer-facing arrival window from NWS
// hourly periods — every hour the window touches, so a half-hour start
// like 11:30 samples 11, 12 AND 13 (understating the last hour let the
// SMS claim "looks better" into a stormy period). Null when the hourly
// feed has no coverage for those hours — callers fall back to the
// day-level number.
function windowRainChance(hours, dateStr, windowStartHHMM) {
  if (!Array.isArray(hours)) return null;
  const startMinutes = hhmmToMinutes(windowStartHHMM);
  if (startMinutes == null) return null;
  const firstHour = Math.floor(startMinutes / 60);
  const lastHour = Math.floor((startMinutes + ARRIVAL_WINDOW_MINUTES - 1) / 60);
  const wanted = [];
  for (let h = firstHour; h <= lastHour; h += 1) wanted.push(h);
  let max = null;
  for (const period of hours) {
    const start = String(period?.startTime || '');
    if (start.slice(0, 10) !== String(dateStr)) continue;
    const hour = parseInt(start.slice(11, 13), 10);
    if (!wanted.includes(hour) || period.rainChance == null) continue;
    if (max == null || period.rainChance > max) max = period.rainChance;
  }
  return max;
}

// " Tomorrow morning looks a lot better - just a 10% chance of rain around
// your new time." Only claims what the forecast supports. Preferred source
// is the HOURLY chance scored on the actual booked arrival window (that's
// what lets us say morning vs afternoon, and lets a same-day push say
// "later today"); day-level chance is the fallback. Thresholds: window
// claims need ≤40% (≤30% same-day — same storm system, be conservative)
// and, when today's number is known, today ≥20 points worse. Always
// "looks better", never a dry-weather promise.
function composeBetterDayClause({
  reasonCode, isSameDay, chosenDate, todayStr, todayChance, newChance, windowChance, windowStart,
}) {
  if (reasonCode !== 'weather_rain' && reasonCode !== 'weather_lightning') return '';

  if (windowChance != null) {
    const cap = isSameDay ? 30 : 40;
    if (windowChance > cap) return '';
    if (todayChance != null && todayChance - windowChance < 20) return '';
    const day = isSameDay ? null : dayLabel(chosenDate, todayStr);
    if (!isSameDay && !day) return '';
    const startHour = Math.floor((hhmmToMinutes(windowStart) ?? 0) / 60);
    const label = isSameDay ? 'Later today' : `${day} ${partOfDay(startHour)}`;
    return windowChance <= 20
      ? ` ${label} looks a lot better - just a ${windowChance}% chance of rain around your new time.`
      : ` ${label} looks better - a ${windowChance}% chance of rain around your new time.`;
  }

  if (isSameDay || newChance == null || newChance > 40) return '';
  if (todayChance != null && todayChance - newChance < 20) return '';
  const label = dayLabel(chosenDate, todayStr);
  if (!label) return '';
  return newChance <= 20
    ? ` ${label} looks a lot better - just a ${newChance}% chance of rain.`
    : ` ${label} looks better - a ${newChance}% chance of rain.`;
}

// Explains WHY rain moves a spray visit. Dark until the owner flips
// GATE_RAINOUT_EFFICACY_NOTE; skipped for work rain doesn't wash away.
const EFFICACY_EXEMPT_SERVICE = /interior|granular|termite|wdo|inspection|bait/i;
function composeEfficacyClause({ reasonCode, serviceType }) {
  if (process.env.GATE_RAINOUT_EFFICACY_NOTE !== 'true') return '';
  if (reasonCode !== 'weather_rain') return '';
  if (EFFICACY_EXEMPT_SERVICE.test(String(serviceType || ''))) return '';
  return '\n\nWhy the move? Treatments need a few rain-free hours to bond - applying right before rain washes them away before they can work.';
}

// Statuses a rain-out may move. Mirrors the rebooker's reschedulable +
// live-override sets; terminal rows are never touched.
const MOVABLE_STATUSES = ['pending', 'confirmed', 'rescheduled', 'en_route', 'on_site'];

// Same-day options stop offering starts after this ET hour — a slot
// starting later than 5 PM runs past a reasonable service day.
const LAST_SAME_DAY_START_HOUR = 17;
const SAME_DAY_OFFSETS_MINUTES = [120, 240];

// Reschedule slots are booked as a 1-hour, on-the-hour block — the internal
// job-duration window, matching how normal appointments are scheduled. The
// customer-facing 2-hour "arrival between" promise is derived separately from
// the start time (arrivalWindowRange in admin-dispatch.js), so a tight 1-hour
// internal block still texts the customer their usual leniency window. Rain-out
// used to offer 2-hour windows here, which drifted from the rest of the
// schedule; on-the-hour keeps dispatch times clean.
const RESCHEDULE_WINDOW_MINUTES = 60;

function pad2(n) {
  return String(n).padStart(2, '0');
}

function minutesToHHMM(totalMinutes) {
  const clamped = Math.max(0, Math.min(23 * 60 + 59, totalMinutes));
  return `${pad2(Math.floor(clamped / 60))}:${pad2(clamped % 60)}`;
}

function hhmmToMinutes(value) {
  const m = String(value || '').match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

// Postgres TIME columns come back as 'HH:MM:SS'; the rest of the rain-out
// flow and the reminder/SMS helpers speak 'HH:MM'. Trim, preserving null.
function toHHMM(value) {
  if (value == null) return value;
  const m = String(value).match(/^(\d{1,2}):(\d{2})/);
  return m ? `${pad2(parseInt(m[1], 10))}:${m[2]}` : value;
}

function displayTime(hhmm) {
  const minutes = hhmmToMinutes(hhmm);
  if (minutes == null) return hhmm;
  const h = Math.floor(minutes / 60);
  const mm = minutes % 60;
  const h12 = h % 12 || 12;
  return `${h12}:${pad2(mm)} ${h >= 12 ? 'PM' : 'AM'}`;
}

function displayWindow(window) {
  if (!window?.start || !window?.end) return '';
  return `${displayTime(window.start)}-${displayTime(window.end)}`;
}

function displayDate(dateStr) {
  return new Date(`${String(dateStr).split('T')[0]}T12:00:00`)
    .toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'America/New_York' });
}

// Customer-facing option label. The slot is BOOKED as a tight 1-hour on-the-hour
// block (window.start→end drives scheduling/overlap), but the customer is always
// quoted the 2-hour arrival window from the start — the owner directive encoded
// in arrivalWindowRange. So the moved-SMS and reply text promise the usual
// leniency even though the internal slot is 1 hour. Falls back to the raw window
// only if the start can't be parsed into an arrival range.
function customerArrivalLabel(window) {
  const range = arrivalWindowRange(window?.start);
  return range ? formatSmsTimeRange(range) : displayWindow(window);
}

function customerArrivalOption(dateStr, window) {
  const label = customerArrivalLabel(window);
  return label ? `${displayDate(dateStr)}, ${label}` : displayDate(dateStr);
}

// Normalize a suggested start to an on-the-hour 1-hour block. The rebooker's
// findBestWindow returns 2-3h arrival-promise ranges shared with the SMS
// self-reschedule flow; rain-out books the tighter internal slot here without
// touching that shared helper. Falls back to a zero-length window if the start
// can't be parsed (day option renders its start with no end rather than crash).
function oneHourWindow(startHHMM) {
  const startMin = hhmmToMinutes(startHHMM);
  if (startMin == null) return { start: startHHMM, end: startHHMM };
  const onHour = Math.floor(startMin / 60) * 60;
  return {
    start: minutesToHHMM(onHour),
    end: minutesToHHMM(onHour + RESCHEDULE_WINDOW_MINUTES),
  };
}

async function loadServiceWithCustomer(serviceId) {
  return db('scheduled_services')
    .where('scheduled_services.id', serviceId)
    .leftJoin('customers', 'scheduled_services.customer_id', 'customers.id')
    .select(
      'scheduled_services.*',
      'customers.first_name',
      'customers.phone',
      'customers.zip',
      'customers.latitude as customer_latitude',
      'customers.longitude as customer_longitude',
      'customers.id as cust_id',
    )
    .first();
}

// Other not-yet-terminal jobs on this tech's plate today, ordered the
// way the route actually runs: COALESCE(route_order, 999) then window_start
// (the canonical dispatch order, admin-dispatch.js).
//
// `anchor` ({ route_order, window_start }) scopes "rest of route" to the
// anchor stop and everything AFTER it in that order — never an earlier
// stop. The tech sheet always anchors on the next stop, so this is a no-op
// there; but dispatch can rain-out an arbitrary mid-route stop, and a
// window-only bound would wrongly sweep stops that share the anchor's
// window or sit before it under a manual route_order.
async function remainingRouteJobs(technicianId, todayStr, excludeServiceId = null, anchor = null) {
  if (!technicianId) return [];
  const query = db('scheduled_services')
    .where({ technician_id: technicianId, scheduled_date: todayStr })
    .whereIn('status', MOVABLE_STATUSES)
    .orderByRaw('COALESCE(route_order, 999), window_start NULLS LAST')
    .select(
      'id', 'status', 'scheduled_date', 'window_start', 'window_end', 'customer_id', 'service_type', 'route_order',
      // Stamped service-address fields feed the moved-SMS forecast copy.
      'lat', 'lng', 'service_address_zip',
      // Collective anchoring needs recurrence membership for EVERY route
      // stop, not just the anchor — omitting it silently routed recurring
      // siblings down the single-visit path (codex P1).
      'is_recurring',
    );
  if (excludeServiceId) query.whereNot('id', excludeServiceId);
  if (anchor) {
    const anchorOrder = anchor.route_order == null ? 999 : anchor.route_order;
    // window_start sorts NULLS LAST, so a null ("anytime") window is the
    // GREATEST time. Map nulls to 24:00:00 on both sides so an anytime stop
    // after the anchor stays in "rest of route", and a timed stop before an
    // anytime anchor stays out — consistent with the ORDER BY above.
    const anchorWindow = anchor.window_start || '24:00:00';
    query.whereRaw(
      "(COALESCE(route_order, 999), COALESCE(window_start, '24:00:00'::time)) >= (?::int, ?::time)",
      [anchorOrder, anchorWindow],
    );
  }
  return query;
}

// "Later today" candidates: now + 2h and now + 4h, snapped to the nearest
// hour, 1-hour on-the-hour windows, none starting after LAST_SAME_DAY_START_HOUR.
function sameDayOptions(now = new Date()) {
  const parts = etParts(now);
  const nowMinutes = parts.hour * 60 + parts.minute;
  const todayStr = etDateString(now);

  const options = [];
  for (const offset of SAME_DAY_OFFSETS_MINUTES) {
    // Snap to the nearest hour so same-day slots land on the hour like the
    // rest of the schedule; the 2h/4h offset keeps them safely in the future.
    const start = Math.round((nowMinutes + offset) / 60) * 60;
    if (start > LAST_SAME_DAY_START_HOUR * 60) continue;
    const window = {
      start: minutesToHHMM(start),
      end: minutesToHHMM(start + RESCHEDULE_WINDOW_MINUTES),
    };
    options.push({
      kind: 'same_day',
      date: todayStr,
      window,
      label: `Later today (+${offset / 60}h)`,
      display: `Today, ${displayWindow(window)}`,
    });
  }
  return options;
}

/**
 * Everything the tech sheet needs in one fetch: same-day windows,
 * route-scored day options with rain badges, the remaining-route count
 * for the scope toggle, and today's outlook for the header.
 */
async function getOptions(serviceId) {
  const service = await loadServiceWithCustomer(serviceId);
  if (!service) return { ok: false, reason: 'not_found' };

  const todayStr = etDateString();
  // Owner blackout: when TODAY is blocked, the "later today" choices must
  // not be offered (findRescheduleOptions covers tomorrow onward; same-day
  // candidates are built here). Fail-open helper.
  const { isBlackoutDate } = require('./scheduling/blackout-dates');
  const sameDay = (await isBlackoutDate(todayStr)) ? [] : sameDayOptions();

  // probeSpanMinutes: 60 — the sheet OFFERS what commit() actually BOOKS
  // (the on-the-hour one-hour block), not the visit's stored span: a 2h
  // stored window would hide bookable options and a sub-hour one would
  // offer slots the commit then SLOT_TAKENs (codex P2).
  const dayOptionsRaw = await SmartRebooker.findRescheduleOptions(serviceId, 'weather_rain', { probeSpanMinutes: 60 });

  // Rain badges — best effort, never blocking. Customer coords first,
  // falling back to nothing (options render without percentages).
  let outlook = null;
  try {
    outlook = await getDailyRainOutlook(service.customer_latitude, service.customer_longitude);
  } catch (err) {
    logger.info(`[rain-out] outlook lookup failed for ${serviceId}: ${err.message}`);
  }

  const days = (dayOptionsRaw || []).slice(0, 3).map((opt) => {
    // Book the tighter on-the-hour slot, but re-derive the display string from
    // it so the pill matches what actually gets scheduled (the rebooker's own
    // suggestedWindow.display is the wider 2-3h arrival range).
    const window = oneHourWindow(opt.suggestedWindow.start);
    return {
      kind: 'day',
      date: opt.date,
      window,
      display: `${opt.displayDate}, ${displayWindow(window)}`,
      rainChance: outlook?.[opt.date]?.rainChance ?? null,
      shortForecast: outlook?.[opt.date]?.shortForecast ?? null,
    };
  });

  const route = await remainingRouteJobs(service.technician_id, todayStr, serviceId, service);

  return {
    ok: true,
    service: {
      id: service.id,
      serviceType: service.service_type,
      status: service.status,
      scheduledDate: service.scheduled_date,
      window: { start: service.window_start, end: service.window_end },
      customerFirstName: service.first_name || null,
      hasPhone: !!service.phone,
    },
    today: {
      date: todayStr,
      rainChance: outlook?.[todayStr]?.rainChance ?? null,
      shortForecast: outlook?.[todayStr]?.shortForecast ?? null,
    },
    sameDay,
    days,
    remainingRouteCount: route.length,
    // Both sheets render the non-weather reason chips only when the gate is
    // on — the server is still the enforcer (commit() rejects the codes).
    extraReasonsEnabled: extraReasonsEnabled(),
  };
}

// Forecast decoration gets this long per stop before the SMS goes out
// without it — the copy is optional, the tech's response is not.
const FORECAST_DECORATION_TIMEOUT_MS = 1500;

async function sendMovedSms({ job, customer, reasonCode, chosen, serviceId, customerNote = null, actorUserId = null, forecastHealth = { degraded: false } }) {
  if (!customer?.phone) return { sent: false, reason: 'no_phone' };

  // Moved-first means the new slot is already booked — no confirmation
  // reply to ask for. Adjustments self-serve through the same tokenized
  // /reschedule link the 72h/24h reminders send.
  const { url: rescheduleUrl } = await buildRescheduleLink(serviceId, { customerId: customer.id });
  const altClause = rescheduleUrl
    ? ` Need a different time? Reschedule online: ${rescheduleUrl}`
    : ' Need a different time? Reply to this message.';
  // Stamped service-address coordinates/zip beat the customer profile —
  // same precedence as track-transitions and gps-arrival-detector — so a
  // rain-out at a secondary property quotes THAT address's forecast.
  const lat = job.lat ?? customer.latitude;
  const lng = job.lng ?? customer.longitude;
  const zip = job.service_address_zip || customer.zip;

  // A non-weather move makes no weather claims: no forecast link and no
  // NWS decoration below — the fixed operational lead is the whole story.
  const forecastLink = isExtraReason(reasonCode) ? null : forecastLinkForZip(zip);
  const forecastClause = forecastLink ? `\n\nYour local forecast: ${forecastLink}` : '';

  // Forecast decoration is fail-open (same rule as the options sheet):
  // any NWS problem renders the generic lead, never blocks the SMS.
  // Daily gives the lead its today-number; hourly scores the actual
  // booked arrival window so the better-day clause can say morning vs
  // afternoon. Fetched in parallel, capped by the per-commit decoration
  // budget: one slow pair marks the whole rain-out degraded so a
  // route-scope move never queues per-stop NWS waits in front of the
  // tech's response (the grid cache makes healthy repeats instant).
  const todayStr = etDateString();
  const isSameDay = String(chosen.date) === todayStr;
  let outlook = null;
  let hourly = null;
  if (lat != null && lng != null && !forecastHealth.degraded && !isExtraReason(reasonCode)) {
    const fetched = await Promise.race([
      Promise.all([
        getDailyRainOutlook(lat, lng).catch(() => null),
        getHourlyRainOutlook(lat, lng).catch(() => null),
      ]),
      new Promise((resolve) => { setTimeout(resolve, FORECAST_DECORATION_TIMEOUT_MS).unref?.(); }),
    ]);
    if (fetched) {
      [outlook, hourly] = fetched;
    } else {
      forecastHealth.degraded = true;
    }
  }
  const todayChance = outlook?.[todayStr]?.rainChance ?? null;
  const newChance = outlook?.[String(chosen.date)]?.rainChance ?? null;
  const windowChance = windowRainChance(hourly, String(chosen.date), chosen.window?.start);

  const sharedVars = {
    first_name: customer.first_name || 'there',
    service_type: (job.service_type || 'service').toLowerCase(),
    new_option: customerArrivalOption(chosen.date, chosen.window),
  };
  // v2/legacy only — v3's link_clause replaces both (the page the link
  // opens carries the forecast, so a second weather.gov URL is redundant).
  const longFormVars = { alt_clause: altClause, forecast_clause: forecastClause };
  const renderContext = {
    workflow: 'tech_rain_out',
    entity_type: 'scheduled_service',
    entity_id: serviceId,
  };

  const weatherLead = composeWeatherLead({ reasonCode, isSameDay, hour: etParts().hour, todayChance });

  // Template ladder, newest first. Each rung falls through ONLY when its
  // ROW is absent (a rolled-back migration) — an existing-but-disabled row
  // is the ops kill switch and must stop the send, not reroute it to older
  // copy. original_message_type must track whichever rung rendered, since
  // twilio.js keys its per-template kill switch on it (the #2891 lesson:
  // stamping a retired key suppresses every send as a sentinel "success").
  //
  //   v3 (GATE_RAINOUT_MOVE_BANNER) — short link-first copy; the detail
  //     (was/now slots, forecast, efficacy note) lives on the /reschedule
  //     page's weather banner, which the same gate turns on.
  //   v2 — forecast-grounded long copy; today's default while the gate is
  //     dark, and the fallback if the v3 migration is rolled back.
  //   legacy rain_out_moved — retired in prod (is_active=false) but the
  //     row is load-bearing as the absent-v2 fallback body; never delete.
  let body = null;
  let renderedKey = null;
  if (process.env.GATE_RAINOUT_MOVE_BANNER === 'true') {
    body = await renderSmsTemplate('rain_out_moved_v3', {
      ...sharedVars,
      weather_lead: weatherLead,
      // "forecast" only when the page's banner will actually show one —
      // a non-weather move renders the banner without weather chips.
      link_clause: rescheduleUrl
        ? (isExtraReason(reasonCode)
          ? ` New time & other options: ${rescheduleUrl}`
          : ` New time, forecast & other options: ${rescheduleUrl}`)
        : ' Need a different time? Reply to this message.',
    }, renderContext);
    if (body) {
      renderedKey = 'rain_out_moved_v3';
    } else {
      const v3Row = await db('sms_templates').where({ template_key: 'rain_out_moved_v3' }).first('id');
      if (v3Row) {
        logger.warn(`[rain-out] rain_out_moved_v3 disabled — moved ${serviceId} without SMS`);
        return { sent: false, reason: 'missing_template' };
      }
    }
  }
  if (!body) {
    body = await renderSmsTemplate('rain_out_moved_v2', {
      ...sharedVars,
      ...longFormVars,
      weather_lead: weatherLead,
      better_day_clause: composeBetterDayClause({
        reasonCode, isSameDay, chosenDate: String(chosen.date), todayStr, todayChance, newChance,
        windowChance, windowStart: chosen.window?.start,
      }),
      efficacy_clause: composeEfficacyClause({ reasonCode, serviceType: job.service_type }),
    }, renderContext);
    if (body) renderedKey = 'rain_out_moved_v2';
  }
  if (!body) {
    const v2Row = await db('sms_templates').where({ template_key: 'rain_out_moved_v2' }).first('id');
    // The legacy body's grammar is weather-only ("{weather_phrase} rolled
    // through your area") — a non-weather move can't render it honestly,
    // so that edge (v2 migration rolled back) falls through to the
    // missing-template path: visit moved, sheet reports the customer was
    // NOT texted, operator follows up manually.
    if (!v2Row && !isExtraReason(reasonCode)) {
      body = await renderSmsTemplate('rain_out_moved', {
        ...sharedVars,
        ...longFormVars,
        weather_phrase: WEATHER_PHRASES[reasonCode] || 'weather',
      }, renderContext);
      if (body) renderedKey = 'rain_out_moved_v2';
    }
  }
  if (!body) {
    logger.warn(`[rain-out] rain-out template missing/disabled — moved ${serviceId} without SMS`);
    return { sent: false, reason: 'missing_template' };
  }

  // Dispatcher note rides AFTER whichever rung rendered — it decorates the
  // templated copy, never replaces it (the reply-to-adjust link and weather
  // grounding stay intact). commit() already sanitized it.
  if (customerNote) {
    body = `${body}\n\nNote from our team: ${customerNote}`;
  }

  const result = await sendCustomerMessage({
    to: customer.phone,
    body,
    channel: 'sms',
    audience: 'customer',
    purpose: 'appointment',
    customerId: customer.id,
    identityTrustLevel: 'phone_matches_customer',
    // original_message_type doubles as the per-template ops kill-switch key
    // (twilio.js isTemplateActive) and MUST be the key of the rung that
    // actually rendered: the legacy rain_out_moved row is retired
    // (is_active=false), and stamping a retired key suppresses every send
    // as a sentinel "success". The legacy-render fallback stamps the v2 key
    // for the same reason — an absent v2 row (rolled-back migration) counts
    // as active there, so the fallback still texts.
    metadata: {
      original_message_type: renderedKey,
      reason_code: reasonCode,
      // Operator attribution: twilio-sms.js writes sms_log.admin_user_id
      // from this key. Without it every rain-out SMS — including ones
      // carrying a dispatcher-authored note — reads as system-generated in
      // the durable record (codex r2 P2).
      ...(actorUserId ? { adminUserId: actorUserId } : {}),
    },
  });
  if (result?.blocked || result?.sent === false) {
    return { sent: false, reason: result.code || result.reason || 'blocked' };
  }
  // sent:true is necessary but not sufficient — upstream suppression paths
  // (per-template kill switch, gates) report sent:true with a sentinel
  // provider id and no SMS leaves. Surface those as not-sent so the rain-out
  // sheet never tells the operator a customer was notified when they weren't.
  if (!isRealProviderSend(result)) {
    return { sent: false, reason: result?.providerMessageId || 'send_suppressed' };
  }
  return { sent: true };
}

/**
 * Commit a rain-out.
 *
 * @param {object} args
 * @param {string} args.serviceId       the job the tech is acting on
 * @param {string} args.technicianId    acting tech (route scope filter)
 * @param {string} args.reasonCode      weather_rain | weather_wind | weather_lightning | weather_heat
 *                                       | running_late | equipment_issue | tech_emergency
 *                                       | customer_noshow (extra reasons need GATE_QUICKMOVE_EXTRA_REASONS)
 * @param {string} args.scope           'job' | 'route' (this job + the rest of today's route)
 * @param {object} args.target          { date, window: {start, end} } — the ANCHOR books exactly
 *                                       this window (what the tech saw). On a same-day route push
 *                                       the siblings shift by the anchor's window delta so stop
 *                                       order survives; day moves keep each sibling's own window.
 * @param {boolean} [args.notifyCustomer=true]
 * @param {string}  [args.customerNote]       optional dispatcher-typed note appended
 *                                            to the ANCHOR stop's moved-SMS only
 *                                            (route siblings get the standard
 *                                            text — a stop-specific note must not
 *                                            fan out). ≤200 chars, no link
 *                                            shorteners — rejected as note_too_long
 *                                            / note_link_blocked / note_invalid.
 * @param {string} [args.initiatedBy='tech']  actor recorded on each reschedule
 *                                            for the audit log — 'admin' from the
 *                                            dispatch board, 'tech' from the app.
 * @param {string} [args.actorUserId]         acting user's id, stamped as
 *                                            metadata.adminUserId on each moved-SMS
 *                                            so sms_log.admin_user_id records who
 *                                            drove the send (and who authored a note).
 */
async function commit({ serviceId, technicianId, reasonCode, scope, target, notifyCustomer = true, customerNote = null, actorUserId = null, initiatedBy = 'tech' }) {
  const service = await loadServiceWithCustomer(serviceId);
  if (!service) return { ok: false, reason: 'not_found' };
  if (!isValidReason(reasonCode)) return { ok: false, reason: 'bad_reason' };
  const noteCheck = sanitizeCustomerNote(customerNote);
  if (noteCheck.error) return { ok: false, reason: noteCheck.error };
  const note = noteCheck.note;
  if (!target?.date || !target.window?.start || !target.window?.end) {
    return { ok: false, reason: 'bad_target' };
  }
  // A no-show is about THIS customer only — route scope would move every
  // remaining stop, text each unrelated customer "we missed you", and stamp
  // each with a customer_noshow log row that counts toward the
  // missed-appointment outreach threshold (codex P1). The sheets hide the
  // scope toggle for this reason; the server is the enforcer.
  if (reasonCode === 'customer_noshow' && scope === 'route') {
    return { ok: false, reason: 'noshow_route_scope' };
  }
  // "Running behind" can only push a same-day visit LATER. The generic
  // same-day options are now+2h/+4h with no regard for the current window,
  // so a morning Quick Move on an afternoon visit could otherwise pull it
  // earlier while the SMS claims we ran behind (codex P2). Day moves are
  // exempt — landing earlier on a DIFFERENT day contradicts nothing. The
  // sheets filter their same-day presets to match; this is the enforcer.
  if (reasonCode === 'running_late') {
    const currentDateStr = service.scheduled_date
      ? String(service.scheduled_date instanceof Date
          ? service.scheduled_date.toISOString()
          : service.scheduled_date).slice(0, 10)
      : null;
    const currentStartMin = hhmmToMinutes(service.window_start);
    const targetStartMin = hhmmToMinutes(target.window.start);
    if (currentDateStr && String(target.date) === currentDateStr
        && currentStartMin != null && targetStartMin != null && targetStartMin <= currentStartMin) {
      return { ok: false, reason: 'target_not_later' };
    }
  }

  const todayStr = etDateString();
  let jobs;
  if (scope === 'route') {
    const rest = await remainingRouteJobs(technicianId, todayStr, serviceId, service);
    jobs = [service, ...rest];
  } else {
    jobs = [service];
  }

  // Same-day route push: the anchor books exactly target.window (what
  // the tech saw in the sheet); siblings shift by the anchor's window
  // delta so the route's running order survives. "Same day" compares
  // against the ANCHOR's scheduled date (not the wall clock) — a push
  // is same-day when the jobs stay on the date they were already on.
  // Falls back to 0 (keep own windows) when the anchor has no
  // parseable window.
  const anchorDateStr = service.scheduled_date
    ? String(service.scheduled_date instanceof Date
        ? service.scheduled_date.toISOString()
        : service.scheduled_date).slice(0, 10)
    : todayStr;
  const isSameDay = String(target.date) === anchorDateStr;
  const anchorStartMin = hhmmToMinutes(service.window_start);
  const targetStartMin = hhmmToMinutes(target.window.start);
  const siblingDelta = (isSameDay && anchorStartMin != null && targetStartMin != null)
    ? targetStartMin - anchorStartMin
    : 0;

  // Same-day forward pushes (positive delta) must move tail-first: the rebooker
  // checks the anchor's new window against the not-yet-moved next stop, so
  // moving the anchor first would SLOT_TAKEN against a sibling about to vacate
  // that slot. Process later stops first so each target window is already clear.
  // A backward pull (custom time earlier than the anchor — negative delta) is
  // the mirror image: process head-first (anchor first) so each stop vacates its
  // old slot before the next, earlier-shifted stop claims it. Day moves land on
  // a different (empty) date — order doesn't matter, and keeping anchor-first
  // there fires its reply-alt SMS first.
  const orderedJobs = (isSameDay && siblingDelta > 0) ? [...jobs].reverse() : jobs;

  // Exclusion = ONLY the row being moved, per move. Its own pre-move
  // position must not clash against its own target (the rebooker also
  // self-excludes the moving row; passing it keeps the contract explicit).
  // EVERY other row stays visible to the rebooker's occupancy probe —
  // including batch members whose moves already COMMITTED:
  //   - An already-moved member's NEW position is real committed occupancy.
  //     Excluding it (the old accumulated moved-ids set) hid the race where
  //     another actor (customer /reschedule link, dispatch board)
  //     concurrently RE-MOVES that committed row INTO a later member's
  //     target window — the later probe sailed past the committed overlap
  //     purely because the id sat in the exclusion set, and no later
  //     bookkeeping could undo the double-book. If a moved member's
  //     committed position genuinely overlaps a later member's target, that
  //     is a REAL conflict → SLOT_TAKEN → the per-member failure path
  //     below.
  //   - A member still awaiting its move keeps its OLD row visible for the
  //     same reason: another actor may have already re-committed it
  //     anywhere. The rebooker's own gates work only on non-excluded rows:
  //     its tech-blind probe runs under the rung-1 date lock, so any
  //     committed position IS visible to it, and its status CAS re-checks
  //     the moving row's own state at write time.
  // Self-blocking is impossible in the proven shapes because the batch's
  // OWN targets never overlap one another — the ordering proof, per batch
  // shape:
  //   - Day move (target.date differs from the anchor's date): every member
  //     keeps its own window on the target date, so pairwise non-overlap on
  //     the old date carries over verbatim to members already landed there;
  //     members not yet moved still sit on the OLD date, which the
  //     TARGET-date-scoped probe cannot match at all.
  //   - Same-day forward push (delta > 0, processed tail-first): every
  //     member's target is its own window shifted LATER by the same delta —
  //     a time-ordered, non-overlapping route stays non-overlapping after
  //     the uniform shift (moved members' new positions included), and the
  //     current member's target moves AWAY from every not-yet-moved earlier
  //     stop's old window.
  //   - Same-day backward pull (delta < 0, processed head-first): the
  //     mirror image.
  //   - Windowless stops (window_start NULL) are inert to the occupancy
  //     predicate (scheduling/occupancy.js header) wherever they sit.
  // The shapes the order math does NOT cover — stops whose current windows
  // already overlap each other, a manual route_order that inverts time
  // order (sort position no longer implies time position), or a same-day
  // windowless sibling AS THE MOVER (its fallback target is the anchor's
  // window, not an order-preserving shift of its own): there a target CAN
  // land on another member's row — old position or committed new one — the
  // probe SEES it, and the move fails SLOT_TAKEN into the existing
  // per-member failure path below (recorded on the sheet; the tech re-runs
  // the straggler). Deliberate, and deliberately LOUD: the old exclusion
  // silently recreated a pre-overlapped pair's overlap at the new
  // positions; now the later member fails visibly instead.
  const results = [];
  // Shared across the whole rain-out: the first slow NWS pair degrades
  // forecast decoration for every remaining stop's SMS.
  const forecastHealth = { degraded: false };
  for (const job of orderedJobs) {
    let newWindow;
    if (job.id === serviceId) {
      newWindow = target.window;
    } else if (isSameDay) {
      const startMin = hhmmToMinutes(job.window_start);
      const endMin = hhmmToMinutes(job.window_end);
      newWindow = (startMin != null && endMin != null)
        ? { start: minutesToHHMM(startMin + siblingDelta), end: minutesToHHMM(endMin + siblingDelta) }
        : target.window;
    } else {
      // Day move for the rest of the route: same new date, keep each
      // job's own window so the route's running order survives. DB TIME
      // values are 'HH:MM:SS'; trim to 'HH:MM' so the downstream reminder
      // helper (normalizeHHMM is strict) doesn't reject them and re-arm the
      // reminder to a default time.
      newWindow = { start: toHHMM(job.window_start), end: toHHMM(job.window_end) };
    }

    // Collective anchoring (owner ruling 2026-07-30, GATE_COLLECTIVE_SERIES_ANCHOR):
    // a DAY move of a series child shifts its whole future series by the
    // same delta, so the customer's next visit lands ~an interval after the
    // treatment that actually happened. Same-day time pushes have no date
    // delta and never touch the series; boosters (is_recurring=false) never
    // shift the base plan. A rain-out must never fail because a future
    // sibling collides: the atomic series shift is tried first, and when it
    // can't commit, the visit still moves alone while the un-shifted series
    // parks as a schedule_conflict admin card (hands-off + exception-based).
    const jobDateStr = job.scheduled_date
      ? String(job.scheduled_date instanceof Date ? job.scheduled_date.toISOString() : job.scheduled_date).slice(0, 10)
      : null;
    const wantsSeriesShift = process.env.GATE_COLLECTIVE_SERIES_ANCHOR === 'true'
      && !!job.is_recurring
      && String(target.date) !== jobDateStr;
    // Owner rule: windows are ALWAYS on the hour. The series mover writes
    // its anchor's start to every shifted occurrence, so an off-hour
    // TECH-SUPPLIED target (custom input passes the routes' date-only
    // validation) would mint a whole off-hour series — normalize through
    // the same on-the-hour block the options sheet books (codex P1).
    // Scoped to the rain-out's own anchor: route SIBLINGS keep their
    // existing windows on a day move, and rounding a legacy half-hour
    // window would silently shift that customer's time.
    if (wantsSeriesShift && job.id === serviceId
      && (hhmmToMinutes(newWindow?.start) ?? 0) % 60 !== 0) {
      newWindow = oneHourWindow(newWindow.start);
    }
    let shiftedOccurrences = null;
    try {
      if (wantsSeriesShift) {
        try {
          const seriesResult = await SmartRebooker.rescheduleSeries(job.id, target.date, newWindow, reasonCode, initiatedBy, {
            allowLive: true,
            // Pin the anchor to the state this loop read — a concurrent
            // move means the delta is stale and the series must not shift.
            expectAnchor: { scheduled_date: job.scheduled_date, window_start: job.window_start },
          });
          shiftedOccurrences = Array.isArray(seriesResult?.rescheduledOccurrences)
            ? seriesResult.rescheduledOccurrences
            : null;
        } catch (err) {
          logger.warn(`[rain-out] collective series shift failed for ${job.id} (${err.message}) — moving the visit alone and parking the series`);
        }
      }
      if (!shiftedOccurrences) {
        // excludeServiceIds = the CURRENT row only (see the exclusion
        // rationale above the loop). Every other member's row — old position
        // or committed new one — stays visible to the rebooker's occupancy
        // probe: an already-committed position is real occupancy, and hiding
        // it let another actor re-move a committed member into a later
        // member's target unseen.
        //
        // Fallback-after-series keeps the anchor CAS (codex P1): the series
        // call may have rejected precisely BECAUSE the anchor moved
        // concurrently (expectAnchor), and re-reading the now-current row
        // would let this fallback overwrite the newer choice. The same
        // expected-state predicate makes the single path 409 instead —
        // caught below as a per-member failure the tech re-runs.
        await SmartRebooker.reschedule(job.id, target.date, newWindow, reasonCode, initiatedBy, {
          allowLive: true,
          excludeServiceIds: [job.id],
          ...(wantsSeriesShift
            ? { expect: { scheduled_date: job.scheduled_date, window_start: job.window_start } }
            : {}),
        });
        if (wantsSeriesShift) {
          // The visit moved but the series could not shift atomically —
          // park it for the office instead of failing the rain-out.
          try {
            const NotificationService = require('./notification-service');
            // notifyAdmin swallows DB errors and resolves null (codex P2) —
            // a falsy result means the cadence is intentionally broken with
            // NO card prompting repair. Log at error with full context (the
            // durable signal Sentry picks up); the moved visit itself is
            // committed and must not read as retryable.
            const card = await NotificationService.notifyAdmin(
              'schedule_conflict',
              'Rain-out series shift needs a look',
              `A rain-out moved a recurring visit to ${target.date} but its future visits could not shift with it (a later occurrence conflicts). The plan's cadence no longer follows the moved visit — adjust from dispatch.`,
              { metadata: { scheduledServiceId: job.id, customerId: job.customer_id || null, targetDate: target.date, reasonCode } }
            );
            if (!card) {
              logger.error(`[rain-out] schedule_conflict card insert FAILED for ${job.id} — series cadence broken with no admin card; targetDate=${target.date} reason=${reasonCode}`);
            }
          } catch (notifyErr) {
            logger.error(`[rain-out] schedule_conflict notification failed for ${job.id}: ${notifyErr.message}`);
          }
        }
      }
    } catch (err) {
      // One job racing to completed/cancelled must not strand the rest
      // of a bulk rain-out — record and continue. This member did NOT move:
      // its row is still live at its old position and (like every member's
      // row, moved or not) stays visible to every later member's occupancy
      // probe, which refuses to schedule on top of it.
      logger.warn(`[rain-out] reschedule failed for ${job.id}: ${err.message}`);
      results.push({ id: job.id, ok: false, error: err.message, statusCode: err.statusCode || 500 });
      continue;
    }

    // The move is COMMITTED past this point. Notification problems —
    // a throwing provider/audit wrapper, a failed forecast fetch —
    // must never mark the job failed, or the tech retries and
    // double-reschedules / double-texts an already-moved appointment.

    // Series shift committed: re-arm every shifted SIBLING's reminders as a
    // SILENT move — sendNotification:false WITHOUT coverDueWindows. The
    // rain-out sends only the anchor's SMS and no series notice, so a
    // sibling shifted inside its 24h window must keep that window pending
    // for the cron's normal day-before reminder; covering it would strand
    // the customer with no message at all (codex P1 — coverDueWindows is
    // reserved for callers that send their own notice). The anchor's
    // re-arm stays with the calling route.
    if (shiftedOccurrences) {
      const AppointmentReminders = require('./appointment-reminders');
      for (const occ of shiftedOccurrences) {
        if (String(occ.id) === String(job.id)) continue;
        try {
          await AppointmentReminders.handleReschedule(
            occ.id,
            `${String(occ.date).split('T')[0]}T${toHHMM(occ.windowStart) || newWindow.start}`,
            {
              sendNotification: false,
              // Atomic stale-guard (codex P1): another actor can re-move a
              // sibling between the series trx commit and this sequential
              // loop — the re-arm must no-op unless the row still holds the
              // slot we shifted it to, or the customer gets a reminder for
              // the wrong appointment.
              expectSchedule: {
                date: String(occ.date).split('T')[0],
                windowStart: toHHMM(occ.windowStart) || null,
              },
            }
          );
        } catch (err) {
          logger.error(`[rain-out] series reminder sync failed for ${occ.id}: ${err.message}`);
        }
      }
      // Live boards track every shifted sibling, not just the loop's own
      // jobs — the admin/tech callers broadcast only their route ids, so
      // future-date siblings would sit stale on any open board (codex P2).
      // Per-occurrence isolation like the public series path.
      try {
        const { emitDispatchJobUpdate } = require('./dispatch-assignment');
        for (const occ of shiftedOccurrences) {
          if (String(occ.id) === String(job.id)) continue;
          try {
            await emitDispatchJobUpdate({ jobId: occ.id, actorId: null });
          } catch (err) {
            logger.error(`[rain-out] board broadcast failed for ${occ.id}: ${err.message}`);
          }
        }
      } catch (err) {
        logger.error(`[rain-out] board broadcast unavailable: ${err.message}`);
      }
      // Kept-tech double-books were committed UNASSIGNED by the rebooker —
      // park them for reassignment, same as the public series path.
      const conflicted = shiftedOccurrences
        .filter((occ) => occ.conflicted)
        .map((occ) => ({ id: occ.id, date: String(occ.date).split('T')[0] }));
      if (conflicted.length) {
        try {
          const NotificationService = require('./notification-service');
          const card = await NotificationService.notifyAdmin(
            'schedule_conflict',
            'Rain-out series shift needs a look',
            `A rain-out shifted a recurring series; ${conflicted.length} future visit(s) landed on already-booked windows and were left UNASSIGNED (${conflicted.map((c) => c.date).join(', ')}). Reassign from dispatch.`,
            { metadata: { scheduledServiceId: job.id, conflicts: conflicted, reasonCode } }
          );
          if (!card) {
            logger.error(`[rain-out] schedule_conflict card insert FAILED for ${job.id} — unassigned siblings with no admin card: ${JSON.stringify(conflicted)}`);
          }
        } catch (err) {
          logger.error(`[rain-out] schedule_conflict notification failed for ${job.id}: ${err.message}`);
        }
      }
    }

    // Soft no-show: the rebooker just logged the occurrence (reason_code
    // customer_noshow with the missed slot's original_date/window), but
    // only the terminal path and nightly sweep ever ran the outreach
    // threshold — two soft no-shows would accumulate without the promised
    // 2-in-90-days task (codex r2). Evaluate WITHOUT inserting a second
    // occurrence row. Best-effort: never fails the committed move.
    if (reasonCode === 'customer_noshow') {
      try {
        const MissedAppointment = require('./workflows/missed-appointment');
        await MissedAppointment.evaluateThreshold(
          job.customer_id || service.cust_id || service.customer_id,
          'quick_move_no_show',
        );
      } catch (err) {
        logger.warn(`[rain-out] no-show outreach evaluation failed for ${job.id}: ${err.message}`);
      }
    }

    const chosen = { date: target.date, window: newWindow };
    let sms = { sent: false, reason: 'not_requested' };
    if (notifyCustomer) {
      try {
        const customer = job.id === serviceId
          ? {
            id: service.cust_id || service.customer_id, phone: service.phone, first_name: service.first_name,
            zip: service.zip, latitude: service.customer_latitude, longitude: service.customer_longitude,
          }
          : await db('customers').where({ id: job.customer_id }).first('id', 'phone', 'first_name', 'zip', 'latitude', 'longitude');
        sms = await sendMovedSms({
          job, customer, reasonCode, chosen, serviceId: job.id,
          // Anchor only — a stop-specific note (gate code, pet warning)
          // must never fan out to the rest of the route's customers.
          customerNote: job.id === serviceId ? note : null,
          actorUserId,
          forecastHealth,
        });
      } catch (err) {
        logger.warn(`[rain-out] post-move notification failed for ${job.id}: ${err.message}`);
        sms = { sent: false, reason: err.message };
      }
    }

    results.push({ id: job.id, ok: true, newDate: target.date, newWindow, smsSent: sms.sent, smsReason: sms.sent ? null : sms.reason });
  }

  const moved = results.filter((r) => r.ok);
  return {
    ok: moved.length > 0,
    reason: moved.length === 0 ? (results[0]?.error || 'nothing_moved') : undefined,
    movedCount: moved.length,
    failedCount: results.length - moved.length,
    results,
  };
}

module.exports = {
  getOptions,
  commit,
  _test: {
    sameDayOptions, customerArrivalOption, minutesToHHMM, hhmmToMinutes, WEATHER_PHRASES,
    composeWeatherLead, composeBetterDayClause, composeEfficacyClause, dayLabel, windowRainChance,
    EXTRA_REASON_LEADS, isValidReason, sanitizeCustomerNote,
  },
};
