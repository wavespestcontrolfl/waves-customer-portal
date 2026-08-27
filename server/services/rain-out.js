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
const { etParts, etDateString, deriveWindowEnd } = require('../utils/datetime-et');
const { DAY_START_HOUR, DAY_END_HOUR } = require('./scheduling/find-time');
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
  gate_locked: "we couldn't get through your gate today",
};
// gate_locked reuses the reason_code vocabulary the reschedule_log schema
// and the admin Schedule page's manual-reschedule dropdown already carry —
// one code for "couldn't get in", whichever surface moved the visit.
// Like customer_noshow it is about THIS property only (route scope would
// text "your gate" to strangers), so commit() rejects route scope.
// The moved-SMS closes with this fix-it nudge ahead of the reschedule
// link on EVERY rung (v3 link_clause, v2 alt_clause): the portal's My
// Property section stores gate/access codes (property.js prefs), so the
// customer can solve next time's visit themselves. GSM-7 only, portal
// link scheme-stripped per house SMS style, and SHORT on purpose — a
// representative v3 render must stay inside the template's 2-segment
// design budget (regression-tested against the real template body).
const GATE_ACCESS_CLAUSE = ' Add gate access for next time: portal.wavespestcontrol.com.';
function extraReasonsEnabled() {
  return process.env.GATE_QUICKMOVE_EXTRA_REASONS === 'true';
}
function isExtraReason(reasonCode) {
  return Object.prototype.hasOwnProperty.call(EXTRA_REASON_LEADS, reasonCode);
}

// Custom reason (owner ask 2026-08-11, from a move no preset covered —
// the property limited vendor entry after 6 PM): for a cause outside the
// preset list, the dispatcher's own words open the SMS and the
// templated move line + reschedule link close it. Single-stop only (the
// message is inherently stop-specific, like the note), and the assembled
// SMS is hard-capped at 2 segments — commit() renders the exact body
// pre-move and rejects a third segment. Dark until the owner flips
// GATE_QUICKMOVE_CUSTOM_REASON: the sheet hides the option (options payload
// flag) and commit() rejects the code, so the kill switch is a plain unset.
const CUSTOM_REASON = 'custom';
const CUSTOM_TEMPLATE_KEY = 'rain_out_moved_custom_v1';
// Owner ruling 2026-08-24: the typed front is OPTIONAL — the template row
// already carries a complete notice (greeting + move line + reschedule
// link), so a blank box sends this neutral opener instead of blocking the
// move. GSM-7 only (a non-GSM char would flip the encoding and shrink the
// 2-segment budget the cap is tuned for).
const CUSTOM_DEFAULT_MESSAGE = 'quick update on your upcoming appointment.';
function customReasonEnabled() {
  return process.env.GATE_QUICKMOVE_CUSTOM_REASON === 'true';
}
function isValidReason(reasonCode) {
  return !!WEATHER_PHRASES[reasonCode]
    || (isExtraReason(reasonCode) && extraReasonsEnabled())
    || (reasonCode === CUSTOM_REASON && customReasonEnabled());
}

// Same wording as v3's non-weather link clause — a custom move makes no
// weather claims, so no "forecast" in the link text.
function customLinkClause(rescheduleUrl) {
  return rescheduleUrl
    ? ` New time & other options: ${rescheduleUrl}`
    : ' Need a different time? Reply to this message.';
}

// The custom rung's single render path — commit()'s pre-move segment check
// and sendMovedSms both call THIS, so the body the cap was checked against
// is the body that sends (same vars, same template row, same GSM
// normalization + portal scheme-strip inside renderSmsTemplate).
//   noVariants: this flow contracts on ONE exact body (pre-move segment
//     cap + the sheet's counter previews the base row getOptions serves) —
//     a weighted random variant can't be predicted by either, so variants
//     are deliberately inert on this key (codex r3 P1).
//   requiredVars: an admin edit that deletes a load-bearing placeholder
//     must fail the render (→ custom_message_unavailable pre-move), not
//     send a body with the promised content silently gone — enforced on
//     the template body pre-substitution, so a note that happens to match
//     static template text can't mask the loss (codex r3 P2). The list is
//     the SHARED map the template write validator enforces at save time
//     (codex r8 P1) — one source, so save and render can never disagree.
async function renderCustomMovedBody({ firstName, serviceType, date, window, customMessage, rescheduleUrl, serviceId }) {
  const { REQUIRED_TEMPLATE_PLACEHOLDERS } = require('../routes/admin-sms-templates');
  return renderSmsTemplate(CUSTOM_TEMPLATE_KEY, {
    first_name: firstName || 'there',
    custom_message: customMessage,
    service_type: (serviceType || 'service').toLowerCase(),
    new_option: customerArrivalOption(date, window),
    link_clause: customLinkClause(rescheduleUrl),
  }, {
    workflow: 'tech_rain_out',
    entity_type: 'scheduled_service',
    entity_id: serviceId,
  }, {
    noVariants: true,
    requiredVars: REQUIRED_TEMPLATE_PLACEHOLDERS[CUSTOM_TEMPLATE_KEY],
  });
}

// Hard cap for the assembled custom-move SMS (owner requirement: 2 segments,
// never 3). Encoding-aware: the counter reports UCS-2 budgets when any
// non-GSM char survives normalization.
const CUSTOM_SMS_MAX_SEGMENTS = 2;

// Send-layer blockers the note guards can't see because they live in the
// TEMPLATE's static text (an admin-saved emoji, a broken-render marker
// like '1970'): discovering them AFTER the move strands a moved visit with
// no SMS, so commit() runs the send layer's own checks on the assembled
// body pre-move (codex r9 P2).
function customBodySendBlocked(body) {
  const { validateOutbound } = require('./sms-guard');
  if (!validateOutbound(body).ok) return true;
  const { _internals: { findEmoji } } = require('./messaging/validators/voice');
  return findEmoji(body).found;
}

/**
 * Server-side counter for the sheet's Custom mode: renders the EXACT body
 * commit() would send — same template row (base, noVariants), same
 * existing-short-code link selection, same renderer normalizations — and
 * returns the 2-segment math. The client keeps NO render mirrors (codex r9
 * P1: reimplementing gsm-normalize/segment-counter/sms-time-format/
 * substitution client-side meant any server-side change could silently
 * desync the advisory counter). Advisory + read-only: never mints a short
 * code, never moves anything; commit() re-renders and enforces.
 */
async function previewCustomSms({ serviceId, customMessage, target }) {
  if (!customReasonEnabled()) return { ok: false, reason: 'bad_reason' };
  const service = await loadServiceWithCustomer(serviceId);
  if (!service) return { ok: false, reason: 'not_found' };
  if (!target?.date || !target.window?.start) return { ok: false, reason: 'bad_target' };
  // Count the message the commit path embeds: sanitizeCustomerNote
  // collapses whitespace runs, and a blank box falls back to
  // CUSTOM_DEFAULT_MESSAGE exactly like commit() does — the counter must
  // measure the body that would actually send. The full guard suite stays
  // at commit — the preview only answers "how long".
  const message = String(customMessage == null ? '' : customMessage).replace(/\s+/g, ' ').trim()
    || CUSTOM_DEFAULT_MESSAGE;
  const { existingShortUrlFor, shortLinkBaseUrl } = require('./short-url');
  const url = service.reschedule_token
    ? ((await existingShortUrlFor({
      kind: 'reschedule', entityType: 'scheduled_services', entityId: serviceId,
    })) || `${shortLinkBaseUrl()}/l/xxxxxxxxxx`)
    : null;
  const body = await renderCustomMovedBody({
    firstName: service.first_name,
    serviceType: service.service_type,
    date: target.date,
    window: target.window,
    customMessage: message,
    rescheduleUrl: url,
    serviceId,
  });
  if (!body) return { ok: false, reason: 'custom_message_unavailable' };
  const { countSegments } = require('./messaging/segment-counter');
  const seg = countSegments(body);
  const perSegment = seg.encoding === 'GSM_7' ? 153 : 67;
  const used = seg.encoding === 'GSM_7' ? seg.gsmSlotCount : body.length;
  return {
    ok: true,
    segments: seg.segmentCount,
    maxSegments: CUSTOM_SMS_MAX_SEGMENTS,
    withinCap: seg.segmentCount <= CUSTOM_SMS_MAX_SEGMENTS,
    remaining: perSegment * CUSTOM_SMS_MAX_SEGMENTS - used,
    encoding: seg.encoding,
  };
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

// Hosts hidden behind encodings that a URL parser (or a tapping thumb)
// canonicalizes back to the real hostname would slip the textual regex —
// the shared canonicalizer lives in messaging/sms-link-policy.js (single
// source with comms-lint; codex PR P1 provenance preserved there).
const { normalizeForLinkCheck } = require('./messaging/sms-link-policy');

// Compliance fold: compatibility normalization + default-ignorable
// characters (soft hyphen, joiners, directional marks, variation
// selectors, BOM) removed — keep in sync with the client's foldNote.
const DEFAULT_IGNORABLE_RE = /[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180E\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFE00-\uFE0F\uFEFF]/g;
function foldForCompliance(text) {
  return String(text).normalize('NFKC').replace(DEFAULT_IGNORABLE_RE, '');
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
  // impliedTreatmentContext: the note rides an SMS that is ALWAYS about a
  // treatment visit, so "Treatment today. Totally safe." and "We treated
  // the lawn. Stay off for 30 minutes." must block even though the claim
  // and its context sit in different sentences (codex pre-push r10) —
  // the social surfaces keep the same-sentence co-occurrence rule.
  // Validate a compliance-FOLDED copy: normalizeGsmPunctuation deliberately
  // preserves U+200C/U+200D (emoji joins), so "sa‍fe" would slip every
  // \b-anchored compliance regex while rendering as the banned word to the
  // customer (codex r24). NFKC + default-ignorable strip closes it; the
  // SENT text stays gsm.
  const folded = foldForCompliance(gsm);
  const { complianceLanguageIssues } = require('./social-media');
  const complianceIssues = complianceLanguageIssues(folded, { impliedTreatmentContext: true });
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

const SAME_DAY_OFFSETS_MINUTES = [120, 240];

// Reschedule slots are booked as a 1-hour, on-the-hour block — the internal
// job-duration window, matching how normal appointments are scheduled. The
// customer-facing 2-hour "arrival between" promise is derived separately from
// the start time (arrivalWindowRange in admin-dispatch.js), so a tight 1-hour
// internal block still texts the customer their usual leniency window. Rain-out
// used to offer 2-hour windows here, which drifted from the rest of the
// schedule; on-the-hour keeps dispatch times clean.
const RESCHEDULE_WINDOW_MINUTES = 60;

// Same-day presets live inside the service day the slot engine uses
// (find-time DAY_START_HOUR..DAY_END_HOUR, ET) — these are the OFFERED
// presets only, not a bound on what an operator may save — and the last
// allowed start must leave a full slot before day close
// (17:00 close → 16:00 is the last start; the old 17:00 cap let a slot run
// past close).
const SAME_DAY_FIRST_START_MINUTES = DAY_START_HOUR * 60;
const SAME_DAY_LAST_START_MINUTES = DAY_END_HOUR * 60 - RESCHEDULE_WINDOW_MINUTES;

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
      // Feeds the route-scope simulation's effective-end derivation for
      // rows with a start but no stored end.
      'estimated_duration_minutes',
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
// hour, 1-hour on-the-hour windows, clamped to the service day: never before
// SAME_DAY_FIRST_START_MINUTES, none starting after SAME_DAY_LAST_START_MINUTES.
function sameDayOptions(now = new Date()) {
  const parts = etParts(now);
  const nowMinutes = parts.hour * 60 + parts.minute;
  const todayStr = etDateString(now);

  const options = [];
  const seenStarts = new Set();
  for (const offset of SAME_DAY_OFFSETS_MINUTES) {
    // Snap to the nearest hour so same-day slots land on the hour like the
    // rest of the schedule; the 2h/4h offset keeps them safely in the future.
    // A pre-dawn rain-out floors both offsets to day open — dedupe so the
    // sheet doesn't show the same 8 AM slot twice.
    const start = Math.max(Math.round((nowMinutes + offset) / 60) * 60, SAME_DAY_FIRST_START_MINUTES);
    if (start > SAME_DAY_LAST_START_MINUTES) continue;
    if (seenStarts.has(start)) continue;
    seenStarts.add(start);
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

// Advisory overlap probe for the Quick Move sheets (owner ask 2026-08-12:
// picking a time that overlaps another appointment gave no warning until
// commit's SLOT_TAKEN). Same tech-blind predicate — occupancy.js's own
// listOccupiedWindows/windowsOverlap pair, which is the range variant of
// the SQL findConflictingVisits runs — AND the same status exclusions the
// rebooker enforces at its commit gate (rebooker.js occupancyClash:
// cancelled + completed don't occupy) so the sheet warns
// on exactly what commit would reject — an offer/commit mismatch in either
// direction is how the /book 409 dead-end loop happened. Read-only, no
// rung-1 lock (offer surface — occupancy.js EXEMPT list); the rebooker's
// locked probe stays the enforcer, this only makes the rejection visible
// BEFORE the Move tap. Warn-only by design: the sheets never disable Move
// on this data (it can be seconds stale in either direction).
// nameScope gates WHO gets identified, and defaults to nobody (fail
// closed). The probe is tech-blind by design — it must see every
// technician's rows to mirror commit — but the payload rides two very
// different trust levels: `checkTarget` is admin-only (requireAdmin) and
// passes NAME_ALL, while `getOptions` is reachable by an assigned tech
// (GET /api/tech/services/:id/rain-out-options), so it passes its own
// technician id and every other tech's row degrades to the sheets'
// "another appointment" fallback. Window + hold status stay on every row:
// non-identifying, and they're what makes the warning actionable.
const TARGET_CONFLICT_LIMIT = 3;
const NAME_ALL = Symbol('rain-out:name-all');
// WHO IS ASKING decides who gets named — never the row's own assignment.
// The admin dispatch options route is requireTechOrAdmin with NO
// assignment check by design ("any dispatcher may rain-out a stop on a
// tech's behalf"), so scoping names to the SERVICE's technician would let
// tech A read tech B's customers just by requesting B's service (codex
// #3375 P1). Admin sees every name; the assigned tech sees their own
// stops (already visible on their route) and nothing else; anyone else,
// and any caller that forgot to identify itself, gets no names at all.
function nameScopeFor(caller, service) {
  if (caller?.isAdmin) return NAME_ALL;
  const techId = caller?.technicianId;
  if (techId && service?.technician_id && String(techId) === String(service.technician_id)) {
    return String(techId);
  }
  return null;
}
// ONE occupancy snapshot per request, filtered in memory per candidate
// window — the per-window query was O(options x route stops) round trips on
// every sheet open (codex #3375 P1). This is still the canonical mechanism,
// not a parallel one: listOccupiedWindows is occupancy.js's own range
// variant of the SAME predicate (identical status/hold/windowless
// conventions, and it precomputes endMin with the same
// estimated_duration_minutes-or-60 fallback the SQL COALESCEs), and
// windowsOverlap is the exported half-open comparison the SQL implements.
async function loadOccupancy({ dateFrom, dateTo, nameScope = null }) {
  const { listOccupiedWindows } = require('./scheduling/occupancy');
  const rows = await listOccupiedWindows({
    dateFrom,
    dateTo,
    // Same status exclusions the rebooker enforces at its commit gate.
    excludeStatuses: ['cancelled', 'completed'],
  });
  const canName = (row) => (nameScope === NAME_ALL
    ? true
    : !!nameScope && String(row.technician_id) === String(nameScope));
  // One customer lookup for the whole response, and only for rows this
  // caller is allowed to see named.
  const customerIds = [...new Set(rows.filter(canName).map((r) => r.customer_id).filter(Boolean))];
  const customers = customerIds.length
    ? await db('customers').whereIn('id', customerIds).select('id', 'first_name', 'last_name')
    : [];
  const nameById = new Map(customers.map((c) => [
    String(c.id),
    [c.first_name, c.last_name].filter(Boolean).join(' ').trim() || null,
  ]));
  return { rows, canName, nameById };
}

const EMPTY_OCCUPANCY = { rows: [], canName: () => false, nameById: new Map() };

function conflictsForTarget(occupancy, serviceId, date, window, {
  routeSiblingIds = null, excludeServiceIds = null,
} = {}) {
  const { windowsOverlap } = require('./scheduling/occupancy');
  const startMin = hhmmToMinutes(window.start);
  const endMin = hhmmToMinutes(window.end);
  if (startMin == null || endMin == null) return [];
  const excluded = new Set((excludeServiceIds || [serviceId]).map(String));
  const rows = occupancy.rows.filter((r) => r.date === date
    && !excluded.has(String(r.id))
    && windowsOverlap(r.startMin, r.endMin, startMin, endMin));
  if (!rows.length) return [];
  // Partition BEFORE the cap. The sheets drop flagged siblings while
  // scope=route, so slicing in query order could spend the whole cap on
  // rows that get filtered out and leave a definite conflict unshown —
  // the same offer/commit mismatch this advisory exists to close, just
  // reintroduced by the truncation. Non-siblings first (stable within
  // each group), cap second, so a definite conflict always outranks a
  // stop that's moving with the push.
  const isSibling = (row) => !!routeSiblingIds?.has(String(row.id));
  const kept = [...rows.filter((r) => !isSibling(r)), ...rows.filter(isSibling)]
    .slice(0, TARGET_CONFLICT_LIMIT);
  const { canName, nameById } = occupancy;
  return kept.map((row) => {
    // startMin/endMin come from listOccupiedWindows, which already applied
    // the predicate's own nullable-window_end fallback — so the warning
    // quotes the span that actually blocked.
    return {
      // Row id, not customer data — the sheets never render it; it exists
      // so the route-scope merge can dedupe one stop hit by two members.
      id: String(row.id),
      windowStart: minutesToHHMM(row.startMin),
      windowEnd: minutesToHHMM(row.endMin),
      customerName: (canName(row) && row.customer_id)
        ? (nameById.get(String(row.customer_id)) || null)
        : null,
      serviceType: canName(row) ? (row.service_type || null) : null,
      // customer-NULL rows with a live reservation stamp are estimate-slot
      // holds — real occupancy, but there's no customer name to show.
      isHold: !row.customer_id && !!row.reservation_expires_at,
      // A "rest of route" same-day push shifts every remaining route stop
      // by the anchor's delta (commit() moves tail-first, so a sibling
      // vacates its window before the anchor lands on it) — an overlap
      // with a stop that's moving too is NOT a definite failure. Flagged
      // so the sheets can drop these from the warning when scope=route
      // (codex #3375 P2). Only today's rows can carry the flag: the probe
      // is date-scoped and route siblings sit on today until commit.
      isRouteSibling: isSibling(row),
    };
  });
}

// A route-scope Move commits EVERY remaining stop, and the rebooker runs
// its occupancy gate per member — so a sibling's landing window can
// SLOT_TAKEN while the anchor's own target is clear, and the route ends up
// PARTIALLY moved (the stops before the straggler already booked and
// already texted). Probing only the anchor's window left that invisible
// until it happened (codex #3375 P2), which is the same offer/commit
// mismatch this advisory exists to close, in its most expensive form.
//
// Project each member's landing window exactly the way commit() does —
// same-day: shift both bounds by the anchor's delta, or fall back to the
// anchor's own window when the stop has no parseable pair (commit's
// windowless-mover fallback); day move: keep its own window on the target
// date, and a windowless stop stays inert to the predicate. EVERY swept id
// is excluded: members moving together aren't conflicts, the same
// reasoning isRouteSibling encodes for the anchor probe. Member-vs-member
// collisions are the shapes commit documents as deliberately loud
// (pre-overlapped pairs, inverted route_order, a windowless mover) and
// stay out of scope — they can't be judged from the pre-move schedule
// anyway, since commit moves tail-first and each stop vacates before the
// next lands.
function routeScopeConflicts({ occupancy, serviceId, service, route, target }) {
  if (!route.length) return [];
  const targetDate = String(target.date).split('T')[0];
  const anchorDateStr = service.scheduled_date
    ? String(service.scheduled_date instanceof Date
        ? service.scheduled_date.toISOString()
        : service.scheduled_date).slice(0, 10)
    : null;
  const isSameDay = targetDate === anchorDateStr;
  const anchorStartMin = hhmmToMinutes(toHHMM(service.window_start));
  const targetStartMin = hhmmToMinutes(target.window.start);
  const siblingDelta = (isSameDay && anchorStartMin != null && targetStartMin != null)
    ? targetStartMin - anchorStartMin
    : 0;
  const sweptIds = [...new Set([String(serviceId), ...route.map((j) => String(j.id))])];

  const windows = route.map((job) => {
    if (isSameDay) {
      const startMin = hhmmToMinutes(toHHMM(job.window_start));
      const endMin = hhmmToMinutes(toHHMM(job.window_end));
      return (startMin != null && endMin != null)
        ? { start: minutesToHHMM(startMin + siblingDelta), end: minutesToHHMM(endMin + siblingDelta) }
        : target.window;
    }
    const start = toHHMM(job.window_start);
    if (!start) return null;
    const end = toHHMM(job.window_end);
    if (end) return { start, end };
    // A day-move row with a start but NO stored end now lands behind a
    // REAL commit gate: rebooker.reschedule derives its occupancy span via
    // the canonical deriveWindowEnd (duration-or-60, the read predicate's
    // own COALESCE) and probes it, so the advisory projects the SAME
    // helper's output. Keyed on the gate's kill switch: with
    // REBOOKER_NULL_END_OCCUPANCY=off commit skips the check again and a
    // warning here would be a false "the schedule will block this move" —
    // the advisory must never disagree with what commit enforces, in
    // either direction.
    if (process.env.REBOOKER_NULL_END_OCCUPANCY === 'off') return null;
    const duration = Number(job.estimated_duration_minutes) > 0
      ? Number(job.estimated_duration_minutes)
      : 60;
    const derived = deriveWindowEnd(start, duration);
    // null = the span would cross midnight. Commit REJECTS that move
    // outright (INVALID_WINDOW — deriveWindowEnd's null-means-validation-
    // failure contract), so there is no landing to overlap-check; the
    // dispatcher gets the clear rejection at the tap instead of an
    // occupancy warning.
    return derived ? { start, end: derived } : null;
  });
  // Member-vs-member collisions: simulate commit()'s own sweep. commit
  // probes each member's target against every OTHER member's row — it
  // excludes only the row it is moving — so a not-yet-processed member
  // still occupies its CURRENT window and an already-processed one
  // occupies its LANDED window. Walking that same order is the only way
  // to see the shapes a projection-only comparison misses (codex #3375
  // P1): with a manual route_order that inverts time order, tail-first no
  // longer implies "vacated first", and a sibling can land on the
  // ANCHOR's still-current row while their two landings never overlap
  // each other. It also subsumes the projected-landing cases — a
  // same-day WINDOWLESS mover takes `target.window` verbatim, and two
  // siblings sharing a window collide — because whichever is processed
  // second meets the first at its landed position. These are the shapes
  // commit() documents as deliberately loud; now they are loud BEFORE the
  // tap. The reported span is the INTERSECTION: the slice contested.
  // Mirror the predicate's EFFECTIVE end: window_end is nullable and
  // occupancy.js COALESCEs it to window_start + estimated_duration_minutes
  // (60 default). Treating a null end as "windowless" would drop a row the
  // predicate says is occupied, so a member could land on it unwarned
  // (codex #3375 P1). Same derivation conflictsForTarget uses.
  const cur = (row) => {
    const start = toHHMM(row?.window_start);
    if (!start) return null;
    const end = toHHMM(row?.window_end);
    if (end) return { start, end };
    const startMin = hhmmToMinutes(start);
    if (startMin == null) return null;
    const duration = Number(row.estimated_duration_minutes) > 0
      ? Number(row.estimated_duration_minutes)
      : 60;
    return { start, end: minutesToHHMM(startMin + duration) };
  };
  const members = [
    { id: String(serviceId), current: cur(service), landing: target.window },
    ...route.map((job, i) => ({ id: String(job.id), current: cur(job), landing: windows[i] })),
  ];
  // Same order commit uses: tail-first on a same-day forward push so each
  // target window is already clear, head-first otherwise.
  const ordered = (isSameDay && siblingDelta > 0) ? [...members].reverse() : members;
  const positions = new Map(members.map((m) => [m.id, m.current]));
  const moved = new Set();
  const overlapSpans = new Map();
  for (const m of ordered) {
    const landing = m.landing;
    const lStart = landing ? hhmmToMinutes(landing.start) : null;
    const lEnd = landing ? hhmmToMinutes(landing.end) : null;
    if (lStart != null && lEnd != null) {
      for (const other of members) {
        if (other.id === m.id) continue;
        // On a DAY move a not-yet-moved member is still sitting on the old
        // date, which a target-date probe cannot match at all.
        if (!moved.has(other.id) && !isSameDay) continue;
        const pos = positions.get(other.id);
        if (!pos) continue; // windowless rows are inert to the predicate
        const pStart = hhmmToMinutes(pos.start);
        const pEnd = hhmmToMinutes(pos.end);
        if (pStart == null || pEnd == null) continue;
        // Canonical half-open predicate (occupancy.js: window_start <
        // probeEnd AND effective_end > probeStart) — not key equality,
        // which would miss 14:00-15:00 against 14:30-15:30.
        if (!(pStart < lEnd && pEnd > lStart)) continue;
        const start = minutesToHHMM(Math.max(pStart, lStart));
        const end = minutesToHHMM(Math.min(pEnd, lEnd));
        overlapSpans.set(`${start}|${end}`, { start, end });
      }
    }
    positions.set(m.id, landing);
    moved.add(m.id);
  }
  const selfCollisions = [...overlapSpans.values()].map((w) => ({
    id: `route-collision:${w.start}|${w.end}`,
    windowStart: w.start,
    windowEnd: w.end,
    customerName: null,
    serviceType: null,
    isHold: false,
    isRouteSibling: false,
    // The sheets render dedicated copy: this is two of THIS route's own
    // stops, not someone else's booking.
    isRouteSelfCollision: true,
  }));

  const anchorKey = `${target.window.start}|${target.window.end}`;
  // One external probe per DISTINCT landing window — the anchor's own
  // window is already covered by the anchor probe.
  const distinctByKey = new Map();
  for (const w of windows) {
    if (!w) continue;
    const key = `${w.start}|${w.end}`;
    if (key !== anchorKey && !distinctByKey.has(key)) distinctByKey.set(key, w);
  }
  const distinct = [...distinctByKey.values()];
  const probed = distinct.map((w) => conflictsForTarget(
    occupancy, serviceId, targetDate, w, { excludeServiceIds: sweptIds },
  ));
  const byId = new Map();
  for (const conflict of probed.flat()) {
    if (!byId.has(conflict.id)) byId.set(conflict.id, conflict);
  }
  // Self-collisions first: they're certain, where a probe result can go
  // stale between here and the tap.
  return [...selfCollisions, ...byId.values()].slice(0, TARGET_CONFLICT_LIMIT);
}

/**
 * Advisory overlap check for a sheet-picked target (the admin sheet's
 * custom time re-checks on every date/hour change). Never blocks anything —
 * commit's locked probe is the enforcer.
 */
async function checkTarget({ serviceId, target, caller = null }) {
  if (!target?.date || !target.window?.start || !target.window?.end) {
    return { ok: false, reason: 'bad_target' };
  }
  const service = await db('scheduled_services')
    .where({ id: serviceId })
    // window_end too: the route-scope simulation needs the anchor's CURRENT
    // occupied span, not just its start — a sibling can land on the row the
    // anchor has not vacated yet.
    .first('id', 'technician_id', 'scheduled_date', 'window_start', 'window_end',
      'estimated_duration_minutes', 'route_order');
  if (!service) return { ok: false, reason: 'not_found' };
  // Route siblings flagged (not excluded) so one response serves both
  // scopes — the sheet filters by its live scope toggle without refetching.
  const route = await remainingRouteJobs(service.technician_id, etDateString(), serviceId, service);
  const targetDate = String(target.date).split('T')[0];
  // Fail-open exactly as before: a snapshot failure hides the badges, it
  // never blocks the sheet.
  let occupancy = EMPTY_OCCUPANCY;
  try {
    occupancy = await loadOccupancy({
      dateFrom: targetDate, dateTo: targetDate, nameScope: nameScopeFor(caller, service),
    });
  } catch (err) {
    logger.info(`[rain-out] occupancy snapshot failed for ${serviceId} ${targetDate}: ${err.message}`);
  }
  const conflicts = conflictsForTarget(occupancy, serviceId, targetDate, target.window, {
    routeSiblingIds: new Set(route.map((j) => String(j.id))),
  });
  // Returned alongside (not merged): the sheet shows these only while the
  // scope toggle is on "this + rest of route", the one case commit moves
  // them. Best-effort — a probe failure degrades to the anchor-only
  // warning rather than blocking the sheet.
  let routeConflicts = [];
  try {
    routeConflicts = routeScopeConflicts({ occupancy, serviceId, service, route, target });
  } catch (err) {
    logger.info(`[rain-out] route-scope conflict probe failed for ${serviceId}: ${err.message}`);
  }
  return { ok: true, conflicts, routeConflicts };
}

// Batch advisory probe for the generic date/time pickers (edit, reschedule,
// create, bulk move) — the picker-agnostic sibling of checkTarget. No route
// simulation: each target is just a date + window checked against the same
// tech-blind occupancy snapshot commit enforces, minus the caller-supplied
// excludeServiceIds (the visit being edited, or a whole bulk selection so
// intra-selection overlap isn't reported). Warn-only everywhere it renders:
// none of these surfaces block saving on this data. Always on — the former
// GATE_SLOT_CONFLICT_HINTS dark gate was removed (owner ruling 2026-08-27:
// conflicts are advisory everywhere and nothing about them is gated).
const SLOT_CHECK_TARGET_CAP = 25;
const SLOT_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

async function checkSlots({ targets, caller = null } = {}) {
  if (!Array.isArray(targets) || targets.length === 0) return { ok: false, reason: 'bad_target' };
  if (targets.length > SLOT_CHECK_TARGET_CAP) return { ok: false, reason: 'too_many_targets' };
  const parsed = [];
  for (const t of targets) {
    const date = t?.date != null ? String(t.date).split('T')[0] : null;
    if (!date || !SLOT_DATE_RE.test(date)) return { ok: false, reason: 'bad_target' };
    // Same window requirement as checkTarget: both bounds, parseable HH:MM.
    if (hhmmToMinutes(t?.window?.start) == null || hhmmToMinutes(t?.window?.end) == null) {
      return { ok: false, reason: 'bad_target' };
    }
    parsed.push({
      date,
      window: { start: t.window.start, end: t.window.end },
      excludeServiceIds: Array.isArray(t?.excludeServiceIds) ? t.excludeServiceIds.map(String) : [],
    });
  }
  // No service in hand, so nameScopeFor degrades to admin-or-nobody: admins
  // see full names, everyone else (including techs) gets window-only rows.
  const nameScope = nameScopeFor(caller, null);
  // One snapshot per DISTINCT date, shared across every target on that day.
  const occupancyByDate = new Map();
  await Promise.all([...new Set(parsed.map((p) => p.date))].map(async (date) => {
    // Fail-open exactly like checkTarget: a snapshot failure hides the
    // hints for that date, it never fails the request.
    let occupancy = EMPTY_OCCUPANCY;
    try {
      occupancy = await loadOccupancy({ dateFrom: date, dateTo: date, nameScope });
    } catch (err) {
      logger.info(`[slot-check] occupancy snapshot failed for ${date}: ${err.message}`);
    }
    occupancyByDate.set(date, occupancy);
  }));
  // results[i] answers targets[i] — the bulk bars rely on the alignment.
  const results = parsed.map((p) => ({
    conflicts: conflictsForTarget(occupancyByDate.get(p.date), null, p.date, p.window, {
      // Always an array (possibly empty) so conflictsForTarget never falls
      // back to its [serviceId] default — there is no serviceId here.
      excludeServiceIds: p.excludeServiceIds,
    }),
  }));
  return { ok: true, results };
}

/**
 * Everything the tech sheet needs in one fetch: same-day windows,
 * route-scored day options with rain badges, the remaining-route count
 * for the scope toggle, and today's outlook for the header.
 */
async function getOptions(serviceId, { caller = null } = {}) {
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

  // Overlap advisory on the same-day presets: +2h/+4h are pure clock
  // offsets with no occupancy input, so they can land on a booked stop.
  // Day options skip the ANCHOR probe — findRescheduleOptions already
  // filters its candidates against the same predicate (rebooker.js
  // candidate clash check), so the anchor's own window arrives
  // conflict-free — but that check only ever saw the anchor, so they still
  // need the route-scope probe below. Route siblings are flagged, not
  // dropped — the sheet filters by its scope toggle (a route-scope
  // same-day push shifts them too). Best-effort: a probe failure renders
  // the pill without a badge, never blocks the sheet (same fail-open
  // posture as the rain badges).
  const routeSiblingIds = new Set(route.map((j) => String(j.id)));
  // ONE snapshot covering every date this payload annotates — today's
  // presets plus the day options — instead of a query per option per route
  // stop (codex #3375 P1). Fail-open in one place: no snapshot, no badges.
  const annotatedDates = [todayStr, ...days.map((d) => d.date)].filter(Boolean).sort();
  let occupancy = EMPTY_OCCUPANCY;
  try {
    occupancy = await loadOccupancy({
      dateFrom: annotatedDates[0],
      dateTo: annotatedDates[annotatedDates.length - 1],
      nameScope: nameScopeFor(caller, service),
    });
  } catch (err) {
    logger.info(`[rain-out] occupancy snapshot failed for ${serviceId}: ${err.message}`);
  }
  for (const opt of sameDay) {
    opt.conflicts = conflictsForTarget(occupancy, serviceId, opt.date, opt.window, { routeSiblingIds });
    // What the shifted rest-of-route would land on — shown only while the
    // sheet's scope toggle is on "rest of route".
    opt.routeConflicts = routeScopeConflicts({
      occupancy, serviceId, service, route, target: { date: opt.date, window: opt.window },
    });
  }

  // Day options need the route-scope probe too (codex #3375 P1): the
  // rebooker's candidate filter cleared the ANCHOR's window on that date
  // and nothing else, but a route-scope day move carries every remaining
  // stop onto the same date keeping its own window — and that date is a
  // different day's schedule the candidate check never looked at. Without
  // this the tech picks a "clean" Thursday, commit moves and texts the
  // early stops, then SLOT_TAKENs on the sibling. Probed concurrently:
  // one batch per option instead of days × route round-trips.
  for (const opt of days) {
    opt.routeConflicts = routeScopeConflicts({
      occupancy, serviceId, service, route, target: { date: opt.date, window: opt.window },
    });
  }

  // Custom-reason availability for the sheet: the option renders only when
  // the gate is on AND the template row is live — a missing/disabled row
  // would send every Move into commit()'s custom_message_unavailable
  // rejection, so hide the option instead. The sheet's live 2-segment
  // counter is SERVER-rendered (previewCustomSms, called by the
  // custom-preview route) — the client keeps no render mirrors (codex r9
  // P1), so no compose payload is served here.
  let customCompose = null;
  if (customReasonEnabled()) {
    const row = await db('sms_templates')
      .where({ template_key: CUSTOM_TEMPLATE_KEY })
      .first('is_active');
    if (row && row.is_active !== false) {
      customCompose = { maxSegments: CUSTOM_SMS_MAX_SEGMENTS };
    }
  }

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
    customReasonEnabled: customReasonEnabled(),
    customCompose,
  };
}

// Forecast decoration gets this long per stop before the SMS goes out
// without it — the copy is optional, the tech's response is not.
const FORECAST_DECORATION_TIMEOUT_MS = 1500;

async function sendMovedSms({ job, customer, reasonCode, chosen, serviceId, customerNote = null, actorUserId = null, forecastHealth = { degraded: false }, operatorInitiated = false, prebuiltCustomSms = null }) {
  if (!customer?.phone) return { sent: false, reason: 'no_phone' };

  const isCustom = reasonCode === CUSTOM_REASON;

  // Moved-first means the new slot is already booked — no confirmation
  // reply to ask for. Adjustments self-serve through the same tokenized
  // /reschedule link the 72h/24h reminders send. A custom move reuses the
  // { url, body } commit() built for its pre-move segment check: templates
  // are admin-editable and the shortener can fall back to the LONG url, so
  // rebuilding either here could exceed the cap the check passed (codex
  // pre-push P1) — the body that was checked is the body that sends.
  const { url: rescheduleUrl } = prebuiltCustomSms
    ? { url: prebuiltCustomSms.url }
    : await buildRescheduleLink(serviceId, { customerId: customer.id });
  // gate_locked carries the portal fix-it nudge ahead of the reschedule
  // clause on whichever rung renders — the customer must hear how to fix
  // next time's access even when v3 is absent and v2 falls in.
  const gateAccessClause = reasonCode === 'gate_locked' ? GATE_ACCESS_CLAUSE : '';
  const altClause = gateAccessClause + (rescheduleUrl
    ? ` Need a different time? Reschedule online: ${rescheduleUrl}`
    : ' Need a different time? Reply to this message.');
  // Stamped service-address coordinates/zip beat the customer profile —
  // same precedence as track-transitions and gps-arrival-detector — so a
  // rain-out at a secondary property quotes THAT address's forecast.
  const lat = job.lat ?? customer.latitude;
  const lng = job.lng ?? customer.longitude;
  const zip = job.service_address_zip || customer.zip;

  // A non-weather move makes no weather claims: no forecast link and no
  // NWS decoration below — the fixed operational lead (or the dispatcher's
  // custom message) is the whole story.
  const forecastLink = (isExtraReason(reasonCode) || isCustom) ? null : forecastLinkForZip(zip);
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
  if (lat != null && lng != null && !forecastHealth.degraded && !isExtraReason(reasonCode) && !isCustom) {
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
  if (isCustom) {
    // Custom rung: the dispatcher's message IS the lead, the move line +
    // link close it out. The normal path uses the exact body commit()'s
    // pre-move segment check validated. The render-here path only serves a
    // caller that didn't prevalidate; it re-runs the cap itself, and a
    // missing/disabled row (its own kill switch — there is no honest
    // fallback rung, the older bodies all render a reason the dispatcher
    // didn't pick) reports the customer was NOT texted.
    if (prebuiltCustomSms?.body) {
      body = prebuiltCustomSms.body;
    } else {
      body = await renderCustomMovedBody({
        firstName: customer.first_name,
        serviceType: job.service_type,
        date: chosen.date,
        window: chosen.window,
        customMessage: customerNote || CUSTOM_DEFAULT_MESSAGE,
        rescheduleUrl,
        serviceId,
      });
      if (!body) {
        logger.warn(`[rain-out] ${CUSTOM_TEMPLATE_KEY} missing/disabled — moved ${serviceId} without SMS`);
        return { sent: false, reason: 'missing_template' };
      }
      // Same cap belt commit()'s pre-check wears — an unvalidated caller's
      // render must not exceed it either. (Placeholder integrity is already
      // enforced inside the render via requiredVars: a gutted template
      // returns null above.)
      const { countSegments } = require('./messaging/segment-counter');
      if (countSegments(body).segmentCount > CUSTOM_SMS_MAX_SEGMENTS) {
        logger.warn(`[rain-out] custom body for ${serviceId} exceeds ${CUSTOM_SMS_MAX_SEGMENTS} segments — no SMS`);
        return { sent: false, reason: 'too_many_segments' };
      }
    }
    renderedKey = CUSTOM_TEMPLATE_KEY;
  }
  if (!body && process.env.GATE_RAINOUT_MOVE_BANNER === 'true') {
    body = await renderSmsTemplate('rain_out_moved_v3', {
      ...sharedVars,
      weather_lead: weatherLead,
      // "forecast" only when the page's banner will actually show one —
      // a non-weather move renders the banner without weather chips.
      // gate_locked leads with the portal fix-it nudge so the reschedule
      // link still closes the message (owner ask 2026-08-25).
      link_clause: gateAccessClause + (rescheduleUrl
        ? (isExtraReason(reasonCode)
          ? ` New time & other options: ${rescheduleUrl}`
          : ` New time, forecast & other options: ${rescheduleUrl}`)
        : ' Need a different time? Reply to this message.'),
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
  // grounding stay intact). commit() already sanitized it. The custom rung
  // embeds the message as its opening line, so no append there.
  if (customerNote && !isCustom) {
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
    // Send-window operator marker (validators/send-window.js): a quick-move
    // notice is the direct consequence of an operator's commit click with an
    // explicit notifyCustomer choice — the moratorium is for
    // machine-initiated sends, not a human moving a visit at night. Threaded
    // from the authenticated routes (never assumed here) so any future
    // autonomous caller of commit() stays fenced by default.
    ...(operatorInitiated ? { operatorInitiated: true } : {}),
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
 *                                       | customer_noshow | gate_locked (extra reasons need
 *                                       GATE_QUICKMOVE_EXTRA_REASONS; customer_noshow and
 *                                       gate_locked are single stop only)
 *                                       | custom (needs GATE_QUICKMOVE_CUSTOM_REASON; single stop
 *                                       only; customerNote becomes the SMS's opening line and is
 *                                       required when notifying; assembled SMS capped at 2 segments)
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
 * @param {boolean} [args.operatorInitiated=false]  send-window exemption for the
 *                                            moved SMS. Only the authenticated
 *                                            tech/admin routes set it (an
 *                                            operator clicked the move and chose
 *                                            notifyCustomer); defaults fenced so
 *                                            a future autonomous caller can't
 *                                            text at night by omission.
 */
async function commit({ serviceId, technicianId, reasonCode, scope, target, notifyCustomer = true, customerNote = null, actorUserId = null, initiatedBy = 'tech', operatorInitiated = false }) {
  const service = await loadServiceWithCustomer(serviceId);
  if (!service) return { ok: false, reason: 'not_found' };
  if (!isValidReason(reasonCode)) return { ok: false, reason: 'bad_reason' };
  const noteCheck = sanitizeCustomerNote(customerNote);
  if (noteCheck.error) return { ok: false, reason: noteCheck.error };
  const note = noteCheck.note;
  if (!target?.date || !target.window?.start || !target.window?.end) {
    return { ok: false, reason: 'bad_target' };
  }
  const todayStr = etDateString();
  // "Same day" compares against the ANCHOR's scheduled date (not the wall
  // clock) — a push is same-day when the jobs stay on the date they were
  // already on.
  const anchorDateStr = service.scheduled_date
    ? String(service.scheduled_date instanceof Date
        ? service.scheduled_date.toISOString()
        : service.scheduled_date).slice(0, 10)
    : todayStr;
  // Owner rule: windows are ALWAYS on the hour. The series mover writes
  // its anchor's start to every shifted occurrence, so an off-hour
  // TECH-SUPPLIED target (custom input passes the routes' date-only
  // validation) would mint a whole off-hour series — normalize through
  // the same on-the-hour block the options sheet books (codex P1).
  // Hoisted ABOVE the custom-move pre-render: everything downstream —
  // the prebuilt SMS body included — must see the window that actually
  // books, or the text quotes a time the schedule doesn't hold (codex
  // r2 P1). Scoped to the rain-out's own anchor: route SIBLINGS keep
  // their existing windows on a day move, and rounding a legacy
  // half-hour window would silently shift that customer's time.
  if (process.env.GATE_COLLECTIVE_SERIES_ANCHOR === 'true'
    && !!service.is_recurring
    && String(target.date) !== anchorDateStr
    && (hhmmToMinutes(target.window.start) ?? 0) % 60 !== 0) {
    target = { ...target, window: oneHourWindow(target.window.start) };
  }
  // A no-show is about THIS customer only — route scope would move every
  // remaining stop, text each unrelated customer "we missed you", and stamp
  // each with a customer_noshow log row that counts toward the
  // missed-appointment outreach threshold (codex P1). The sheets hide the
  // scope toggle for this reason; the server is the enforcer.
  if (reasonCode === 'customer_noshow' && scope === 'route') {
    return { ok: false, reason: 'noshow_route_scope' };
  }
  // Same one-customer logic for a locked gate: the SMS says "your gate",
  // and only the anchor stop's property was inaccessible. The sheets hide
  // the scope toggle for this reason; the server is the enforcer.
  if (reasonCode === 'gate_locked' && scope === 'route') {
    return { ok: false, reason: 'gate_route_scope' };
  }
  // Custom reason: the dispatcher's message is the SMS's opening line, so
  // it's as stop-specific as the note (route scope would fan one customer's
  // situation out to strangers — single stop only), and the assembled SMS
  // must fit CUSTOM_SMS_MAX_SEGMENTS. A blank message is allowed (owner
  // ruling 2026-08-24) — the template already carries the full notice, so
  // CUSTOM_DEFAULT_MESSAGE fills the front instead of rejecting. The exact
  // send body is rendered here, pre-move, through the same
  // renderCustomMovedBody + link the send will use — reject BEFORE anything
  // moves, never after.
  let prebuiltCustomSms = null;
  if (reasonCode === CUSTOM_REASON) {
    if (scope === 'route') return { ok: false, reason: 'custom_route_scope' };
    if (notifyCustomer) {
      // Reuse the visit's EXISTING short code before minting: the
      // reschedule target is deterministic per visit (stable token, codes
      // never expire), and the sheet's live counter estimated against the
      // existing code — minting here could produce a different-length URL
      // than the one the counter measured (codex PR P2: a legacy 5-char
      // code vs a fresh 10-char mint flips a boundary case).
      const { existingShortUrlFor } = require('./short-url');
      const url = (await existingShortUrlFor({
        kind: 'reschedule', entityType: 'scheduled_services', entityId: serviceId,
      })) || (await buildRescheduleLink(serviceId, { customerId: service.cust_id || service.customer_id })).url;
      const body = await renderCustomMovedBody({
        firstName: service.first_name,
        serviceType: service.service_type,
        date: target.date,
        window: target.window,
        customMessage: note || CUSTOM_DEFAULT_MESSAGE,
        rescheduleUrl: url,
        serviceId,
      });
      // Null render = the row is missing/disabled (the ops kill switch) OR
      // an admin edit deleted a required placeholder (renderCustomMovedBody
      // passes requiredVars — enforced inside getTemplate on the body that
      // renders, pre-substitution). Either way the message that IS the
      // reason can't send, so fail the move here instead of silently
      // moving the visit messageless.
      if (!body) return { ok: false, reason: 'custom_message_unavailable' };
      // Template statics can carry send-layer blockers the note guards
      // never saw — reject pre-move, not after (codex r9 P2).
      if (customBodySendBlocked(body)) {
        logger.warn(`[rain-out] ${CUSTOM_TEMPLATE_KEY} assembled body trips the send guards for ${serviceId} — rejecting pre-move`);
        return { ok: false, reason: 'custom_message_unavailable' };
      }
      const { countSegments } = require('./messaging/segment-counter');
      const seg = countSegments(body);
      if (seg.segmentCount > CUSTOM_SMS_MAX_SEGMENTS) {
        return { ok: false, reason: 'note_too_many_segments' };
      }
      // The send reuses this exact { url, body } — templates are
      // admin-editable, so a re-render at send time could exceed the cap
      // this check just passed (codex pre-push P1).
      prebuiltCustomSms = { url, body };
    }
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

  let jobs;
  if (scope === 'route') {
    const rest = await remainingRouteJobs(technicianId, todayStr, serviceId, service);
    jobs = [service, ...rest];
  } else {
    jobs = [service];
  }

  // Same-day route push: the anchor books exactly target.window (what
  // the tech saw in the sheet); siblings shift by the anchor's window
  // delta so the route's running order survives. Falls back to 0 (keep
  // own windows) when the anchor has no parseable window.
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
    // The anchor's on-the-hour normalization for this path lives at the
    // TOP of commit() (before the custom move's SMS pre-render) — by here
    // target.window is already the window that books.
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
          operatorInitiated,
          // Custom move: send the exact body the pre-move segment check
          // validated (see sendMovedSms header).
          ...(job.id === serviceId && prebuiltCustomSms
            ? { prebuiltCustomSms }
            : {}),
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
  previewCustomSms,
  checkTarget,
  checkSlots,
  // Tech-blind occupancy guard, consumed by the find-time hint path —
  // the slot engine walks per-technician routes, so technician-null rows
  // are invisible to it and only this predicate can veto those hours.
  loadOccupancy,
  conflictsForTarget,
  _test: {
    sameDayOptions, customerArrivalOption, minutesToHHMM, hhmmToMinutes, WEATHER_PHRASES,
    composeWeatherLead, composeBetterDayClause, composeEfficacyClause, dayLabel, windowRainChance,
    EXTRA_REASON_LEADS, GATE_ACCESS_CLAUSE, isValidReason, sanitizeCustomerNote,
    CUSTOM_REASON, CUSTOM_TEMPLATE_KEY, customLinkClause, renderCustomMovedBody,
    conflictsForTarget,
  },
};
