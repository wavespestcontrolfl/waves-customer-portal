/**
 * Call booking-miss watchdog.
 *
 * Why this exists: on 2026-07-28 an outbound callback confirmed "Saturday at
 * noon" with a property manager. The V2 extraction captured
 * scheduling.status=confirmed with a concrete confirmed_start_at — but every
 * auto-booking guard held it back (outbound_call skip, v2 needs_review
 * routing), so it parked as triage_items among 1,700+ open low-severity
 * flags and drowned. Nothing rang; nobody was scheduled. The triage queue is
 * a park, not a pager — this watchdog is the pager for the one class that
 * directly costs a visit: the caller was TOLD a slot and the schedule has
 * nothing on it.
 *
 * What counts as a miss: a fully-processed call in the lookback window, past
 * the grace period, whose stored V2 extraction (v2_extraction_status =
 * 'valid') says scheduling.status === 'confirmed' with a parseable
 * confirmed_start_at — and no scheduled_services row CLEARS it. A row clears
 * the miss only with call-linked evidence, mirroring the processor's
 * findExistingCallAppointment contract (call-recording-processor.js:2225):
 * same customer + same ET service date, status not cancelled/rescheduled,
 * AND (source_call_log_id matches, or the notes carry the call's
 * `Call SID:` marker, or window_start is within 2h of the confirmed wall
 * clock, or the row was created after the call — the office acted). A
 * pre-existing unrelated same-day appointment does NOT suppress the page.
 * A visit that carries the call itself (source_call_log_id, or the Call SID
 * notes marker) clears the miss under ANY customer (owner 2026-10-03: the
 * office booked a spouse's call on the household's account, the call had no
 * customer because her number was not on file, and the pager kept ringing
 * for a booked visit). Without that provenance, a call with no linked
 * customer_id cannot match a booking and is a miss (unattributed AND
 * unbooked; see call-log-relink.js for the attribution side).
 *
 * One more clearing rule (2026-10-10 call audit): a caller on a number no
 * account carries gets a second customer record, or no record, and the
 * office books the agreed visit on the account the person already has. The
 * pager then rang four times for a booked visit. A visit clears the miss
 * when it sits under ANOTHER live account with the same first and last name
 * (the linked customer's name, or the name the unlinked caller gave), on the
 * agreed ET date, within the window tolerance, in a live status, and created
 * AFTER the call. An older visit of a namesake never clears. The bell for an unlinked
 * call also names the one account that carries the caller's name.
 *
 * ET semantics: confirmed_start_at is parsed with the same wall-clock
 * contract as the booking path's v2IsoToEtWallClock — an ET offset (either
 * season, even the wrong one) or a zone-less stamp means the model encoded
 * the agreed LOCAL wall clock and is kept verbatim; only a true foreign
 * instant (Z / non-ET offset) is converted to ET. Booking dates are rendered
 * via to_char in SQL — no JS Date round-trip across the UTC boundary.
 *
 * Alerting mirrors call-ingest-watchdog: one bell per call, deduped forever
 * via the notifications metadata dedupeKey, with a per-run cap so the first
 * enable over a backlog can't flood. A slot under a day away re-rings in ET
 * daytime until booked or until the office closes the call's triage cards
 * (REPEAT_WINDOW_HOURS). Every bell is tagged bell:true so the admin bell
 * policy cannot silence it. Dark by default behind
 * GATE_CALL_BOOKING_MISS_WATCHDOG. Read-only against call_log,
 * scheduled_services and triage_items; writes nothing but admin
 * notifications.
 *
 * The bell closes itself (owner 2026-10-24, "Alerts must clear once the thing
 * happened"). Every tick a close pass runs first and sorts each call's open
 * bells with classifyOpenBookingMiss: the visit got booked, or was done on
 * another day, or the agreed day passed 14 days ago -> done, with a resolution
 * line; older duplicates of one call -> done as replaced. A visit booked on a
 * DIFFERENT day than the call agreed (the office booked the wrong week) is a
 * new episode: it rings one fresh date-check bell ("Booked Wed Oct 28 ...; the
 * call agreed Wed Nov 4 ..."), and only then closes the old bells as replaced.
 * The first ring says the same instead of "nothing is on the calendar". Same gate, same lock; a close failure logs a
 * warning and never stops the ring path.
 */

const db = require('../models/db');
const logger = require('./logger');
const { raiseAdminAlert, cutAtWord, MAX_HEADLINE_CHARS } = require('./admin-alert-compose');
const { CUSTOMER_STAGES } = require('./customer-stages');
const { etParts, parseETDateTime, etDateString, addETDays, formatETTime } = require('../utils/datetime-et');

// How far back each run looks. Four days: a Friday-evening call still sits
// inside Monday morning's window even after a full weekend of gated-off or
// dead cron ticks, with slack — while keeping the candidate set tiny.
const LOOKBACK_HOURS = 96;
// Calls younger than this are still legitimately in flight — transcription →
// extraction → booking can take a while, and the office may be booking it
// by hand right now.
const GRACE_MINUTES = 90;
// A first enable scans the whole window; cap the bells per run so a backlog
// rings loudly but not unreadably. Dedupe keys make the remainder ring on
// subsequent ticks.
const MAX_ALERTS_PER_RUN = 8;
// A same-date row whose window starts within this many minutes of the
// confirmed wall clock is treated as THE booking (offices book the agreed
// noon slot as a 12:00 or 13:00 window, not to the minute).
const WINDOW_MATCH_TOLERANCE_MINUTES = 120;
// Repeat paging (owner ruling 2026-09-30): once the first bell has rung, a
// miss whose slot starts within a day (until the slot's own start time)
// re-rings every REPEAT_INTERVAL_MINUTES during ET daytime until it is
// booked or the office closes the call's triage cards.
const REPEAT_WINDOW_HOURS = 24;
const REPEAT_INTERVAL_MINUTES = 120;
const REPEAT_DAY_START_HOUR_ET = 7;
const REPEAT_DAY_END_HOUR_ET = 21;
// How far back a call can be and still repeat (slots are rarely booked more
// than a few weeks out).
const REPEAT_LOOKBACK_DAYS = 30;
// Statuses of a scheduled_services row the office has acted on and closed out.
const INACTIVE_STATUSES = new Set(['cancelled', 'rescheduled']);
// The only statuses a namesake account's visit may have to clear a miss: a
// visit that is on the calendar or was done. An allow-list, so a skipped or
// any later non-live outcome never counts.
const NAMESAKE_LIVE_STATUSES = new Set(['pending', 'confirmed', 'en_route', 'on_site', 'completed']);
// A visit that is still on the calendar (not done, not closed out).
const LIVE_VISIT_STATUSES = new Set(['pending', 'confirmed', 'en_route', 'on_site']);
// A later visit counts as the office answering the call (done or booked on
// another day) only inside this many days of the agreed day. A customer's
// routine visit months away is not the visit the call agreed.
const OTHER_DAY_MATCH_DAYS = 21;
// The agreed day passed this many days ago with no visit: the bell leaves the
// list (docs/admin-notifications.md section 4, retention).
const PAST_AFTER_DAYS = 14;
const BELL_DEDUPE_PREFIX = 'call-booking-miss';
const REPLACED = 'Replaced by a newer alert for this call';
const REPLACED_BY_DATE_CHECK = 'Replaced by a date check';
const REPLACED_VISIT_GONE = 'The booked visit is gone; replaced by a new alert to book it';
// Dismiss on the Dispatch held-visit strip (owner 2026-11-01): the office will not book it.
const DISMISSED_ON_DISPATCH = 'Dismissed on Dispatch: not booking';

// Log-safe phone rendering — full numbers belong ONLY in the admin
// notification body (an authenticated surface); Railway logs are plaintext.
function maskPhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits ? `***${digits.slice(-4)}` : 'unknown';
}

// Same wall-clock contract as v2IsoToEtWallClock in call-recording-processor:
// ET offsets (either season — even the seasonally WRONG one) and zone-less
// stamps encode the agreed LOCAL wall clock, kept verbatim; a true foreign
// instant (Z or non-ET offset) is converted to its ET wall clock. Returns
// { dateET: 'YYYY-MM-DD', minutes: <minutes past midnight> } or null.
function confirmedWallClockET(value) {
  const raw = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(raw)) return null;
  const verbatim = () => ({
    dateET: raw.slice(0, 10),
    minutes: Number(raw.slice(11, 13)) * 60 + Number(raw.slice(14, 16)),
  });
  if (/(?:-04:?00|-05:?00)$/.test(raw)) return verbatim();
  if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw)) {
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) return null;
    const p = etParts(parsed);
    const pad = (n) => String(n).padStart(2, '0');
    return { dateET: `${p.year}-${pad(p.month)}-${pad(p.day)}`, minutes: p.hour * 60 + p.minute };
  }
  return verbatim();
}

// Parse the stored V2 extraction (jsonb object or stringified JSON — both
// exist across the column's history) into the confirmed-slot facts this
// watchdog needs. Returns null unless the call confirmed a concrete slot.
function extractConfirmedSlot(extractionRaw) {
  let extraction = extractionRaw;
  if (!extraction) return null;
  if (typeof extraction === 'string') {
    try {
      extraction = JSON.parse(extraction);
    } catch {
      return null;
    }
  }
  const scheduling = extraction.scheduling || {};
  if (scheduling.status !== 'confirmed' || !scheduling.confirmed_start_at) return null;
  const wallClock = confirmedWallClockET(scheduling.confirmed_start_at);
  if (!wallClock) return null;
  return {
    dateET: wallClock.dateET,
    minutes: wallClock.minutes,
    name: extraction.caller?.name_full || extraction.caller?.first_name || 'Unknown caller',
    service: extraction.service_request?.specific_service_name
      || extraction.service_request?.primary_service_category
      || null,
  };
}

function windowStartMinutes(windowStart) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(windowStart || ''));
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

// Call-linked booking evidence, mirroring findExistingCallAppointment
// (call-recording-processor.js:2225): does this same-customer,
// non-cancelled/rescheduled row belong to THIS call's confirmed slot? Only
// call-specific evidence clears — a same-day row merely created after the
// call could be any unrelated booking, and the canonical lookup does not
// treat post-call timing alone as a match either. The cost of dropping the
// timing shortcut is one deduped page when the office manually rebooks the
// call at a renegotiated time >2h away; the cost of keeping it was silently
// suppressing exactly the failures this pager exists for.
//
// The provenance branches (source_call_log_id, Call SID notes marker) are
// deliberately DATE-AGNOSTIC: SmartRebooker reschedules a call-created visit
// by mutating the SAME row's scheduled_date in place (rebooker.js), so the
// durable call-linked appointment can legitimately live on a different date
// than the originally confirmed slot — it is still booked, not missed. Only
// the window-proximity fallback requires the original ET date.
//
// rowCarriesCall is that provenance on its own: the row names THIS call, so
// it is the call's booking whichever customer it sits under.
function rowCarriesCall(row, call) {
  if (row.source_call_log_id && row.source_call_log_id === call.id) return true;
  // The marker sits in either notes column: the call pipeline writes it to internal_notes on
  // the visits it books, and the Dispatch "Book it" action prefills it there.
  // Two marker forms: the Twilio SID (the pipeline's), and the call_log id, which every call
  // has ("Book it" writes that one; a call row can lack a SID).
  const text = `${row.notes || ''}\n${row.internal_notes || ''}`;
  if (call.id && text.includes(`Call ID: ${call.id}`)) return true;
  return !!call.twilio_call_sid && text.includes(`Call SID: ${call.twilio_call_sid}`);
}

function rowClearsSlot(row, call, slot) {
  if (rowCarriesCall(row, call)) return true;
  if (row.sched_date !== slot.dateET) return false;
  // A cancelled / rescheduled row clears the miss ONLY through the provenance
  // branches above (owner 2026-10-01: a visit booked from the call and later
  // cancelled is handled, not missed; Codex #5543 r1-r4: any timing or
  // proximity rule on an inactive row without provenance kept admitting an
  // unrelated visit). Active rows keep the window-proximity fallback.
  if (INACTIVE_STATUSES.has(row.status)) return false;
  const startMinutes = windowStartMinutes(row.window_start);
  return startMinutes !== null && Math.abs(startMinutes - slot.minutes) <= WINDOW_MATCH_TOLERANCE_MINUTES;
}

// A visit the office booked after the call on a namesake account (same first
// and last name as the call's customer or caller): the agreed ET date, a live
// status (NAMESAKE_LIVE_STATUSES), the window tolerance, and created strictly
// after the call. The
// created-after fence is what the own-customer rule does not need: a namesake
// may be another person, and only a booking made after this call answers it.
function namesakeRowClearsSlot(row, call, slot) {
  if (row.sched_date !== slot.dateET || !NAMESAKE_LIVE_STATUSES.has(row.status)) return false;
  const startMinutes = windowStartMinutes(row.window_start);
  if (startMinutes === null || Math.abs(startMinutes - slot.minutes) > WINDOW_MATCH_TOLERANCE_MINUTES) return false;
  return rowCreatedAfterCall(row, call);
}

// Strictly after the call: the created-at fence a namesake visit needs, and
// the "later visits" evidence the date check and the done-on-another-day
// close read.
function rowCreatedAfterCall(row, call) {
  const rowAt = row.created_at ? new Date(row.created_at).getTime() : NaN;
  const callAt = call.created_at ? new Date(call.created_at).getTime() : NaN;
  return Number.isFinite(rowAt) && Number.isFinite(callAt) && rowAt > callAt;
}

// The visit that answers the call's slot, if any: the call's own booking
// (provenance, under any customer), a same-day window match on the call's
// customer, or a namesake's visit after the call. computeBookingMisses and the
// close pass both read this one rule.
function clearingRow(call, slot, bookedRows, sameName) {
  return bookedRows.find((row) => (
    rowCarriesCall(row, call)
    || (!!call.customer_id && row.customer_id === call.customer_id && rowClearsSlot(row, call, slot))
    || (!!sameName && sameName.has(row.customer_id) && namesakeRowClearsSlot(row, call, slot))
  ));
}

// Pure diff, exported for tests: which calls confirmed a slot that has no
// call-linked booking? `calls` are call_log rows ({ id, twilio_call_sid,
// customer_id, direction, created_at, from_phone, to_phone,
// ai_extraction_enriched }); `bookedRows` are scheduled_services rows
// ({ customer_id, status, sched_date ('YYYY-MM-DD' via to_char — never a JS
// Date round-trip), window_start, created_at, source_call_log_id, notes }),
// ANY status: cancelled/rescheduled rows clear only on call provenance
// (rowClearsSlot; a missing status counts as active). Provenance clears under
// any customer; the window-proximity fallback only under the call's own.
// `namesakes` maps a call id to the ids of the other live accounts that carry
// the same first and last name (see loadNamesakeAccounts); their rows clear
// only through namesakeRowClearsSlot.
function computeBookingMisses(calls, bookedRows, { now = new Date(), namesakes = new Map() } = {}) {
  const graceCutoff = new Date(now.getTime() - GRACE_MINUTES * 60 * 1000);
  const misses = [];
  for (const call of calls) {
    const createdAt = call.created_at ? new Date(call.created_at) : null;
    if (!createdAt || createdAt > graceCutoff) continue;
    const slot = extractConfirmedSlot(call.ai_extraction_enriched);
    if (!slot) continue;
    if (clearingRow(call, slot, bookedRows, namesakes.get(call.id))) continue;
    misses.push({ call, slot, serviceDateET: slot.dateET });
  }
  return misses;
}

const pad2 = (n) => String(n).padStart(2, '0');
const clockOf = (minutes) => `${pad2(Math.floor(minutes / 60))}:${pad2(minutes % 60)}`;
const dayNumber = (dateET) => Date.parse(`${dateET}T00:00:00Z`) / 86400000;
const daysApart = (a, b) => Math.abs(dayNumber(a) - dayNumber(b));

// A spoken day and time, never ISO: "Wed Oct 28 at 4:00 PM", or "Wed Oct 28" when
// the minutes are unknown.
function spokenSlot(dateET, minutes) {
  const at = parseETDateTime(`${dateET}T${clockOf(minutes ?? 12 * 60)}`);
  const day = at.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'America/New_York' }).replace(',', '');
  return minutes == null ? day : `${day} at ${formatETTime(at)}`;
}

const nearestTo = (rows, dateET) => rows.reduce((best, row) => {
  if (!best) return row;
  const d = daysApart(row.sched_date, dateET);
  const bestD = daysApart(best.sched_date, dateET);
  if (d !== bestD) return d < bestD ? row : best;
  return new Date(row.created_at) > new Date(best.created_at) ? row : best;
}, null);

const newestFirst = (a, b) => (new Date(b.created_at) - new Date(a.created_at)) || String(b.id).localeCompare(String(a.id));

// Pure (no database): what to do with a call's OPEN booking-miss bells. `call`
// is a call_log row, `slot` the agreed slot ({ dateET, minutes }), `bookedRows`
// the evidence rows (see loadBookingRows: provenance, the customer and its
// namesakes), `openRows` the call's open bells ({ id, created_at, mismatch_visit_id,
// mismatch_date, mismatch_time }), `namesakes` as computeBookingMisses takes it.
// Returns { verdict, row, mismatch, closes: [{ ids, resolution }], keep, ring }:
//   booked           the visit is on the agreed slot -> close every bell
//   ("later visit" = created after the call, within OTHER_DAY_MATCH_DAYS of the
//   agreed day, and for the service the call agreed: sameService)
//   dismissed        not booked, and the office pressed Dismiss on the call's
//                    Dispatch held row (call.held_visit_dismissed_at) -> close every bell
//   done_other_day   the call's own customer had a later visit completed on
//                    another day -> close every bell (a namesake may be another
//                    person, so a namesake's completed visit never closes)
//   booked_other_day a later visit is on the calendar on another day or outside
//                    the window. The newest bell already shows this visit ->
//                    keep it, close older ones. Otherwise `ring` is a FRESH
//                    date-check bell, and `closes` (every open bell, "Replaced by
//                    a date check") may run only once that bell stands.
//   past             nothing booked and the agreed day was PAST_AFTER_DAYS ago
//                    or more -> close every bell
//   still_missed     keep the newest bell, close older duplicates; when the
//                    newest is a date check whose visit is gone, `ring` is a
//                    fresh "book it" bell, then the date check closes
// `ring` is { mismatch, dedupeKey } (mismatch null for "book it"); its key names
// the bell it replaces, so each episode gets its own key. With no `openRows` it
// is the ring path's verdict. `row` is the visit behind the verdict; `mismatch`
// is { visit_id, date, time } for booked_other_day.
function classifyOpenBookingMiss(call, slot, bookedRows, openRows, { now, namesakes }) {
  const ordered = [...openRows].sort(newestFirst);
  const [newest] = ordered;
  const closesOf = (rows, resolution) => (rows.length ? [{ ids: rows.map((r) => r.id), resolution }] : []);
  const closeAll = (resolution) => closesOf(ordered, resolution);
  // Keep the newest bell, close older duplicates of this call.
  const keepNewest = () => ({ keep: newest ? newest.id : null, closes: closesOf(ordered.slice(1), REPLACED) });
  const result = (verdict, row, extra) => ({ verdict, row, mismatch: null, closes: [], keep: null, ring: null, ...extra });

  const sameName = namesakes.get(call.id);
  const cleared = clearingRow(call, slot, bookedRows, sameName);
  if (cleared) {
    const on = cleared.sched_date ? ` for ${spokenSlot(cleared.sched_date, windowStartMinutes(cleared.window_start))}` : '';
    // A booking from the call that was later cancelled is handled (owner 2026-10-01); say so.
    const cancelled = cleared.status === 'cancelled' ? ', later cancelled' : '';
    return result('booked', cleared, { closes: closeAll(`Visit booked${on}${cancelled}`) });
  }
  // The office dismissed the call's held row on Dispatch: it will not book it, so no bell stands.
  if (call.held_visit_dismissed_at) return result('dismissed', null, { closes: closeAll(DISMISSED_ON_DISPATCH) });

  // A later visit answers the call only when it is for the service the call agreed (a
  // routine lawn visit must never close or relabel a pest booking miss), on the call's
  // own customer or a namesake account, created after the call.
  const isOwn = (r) => (!!call.customer_id && r.customer_id === call.customer_id) || rowCarriesCall(r, call);
  const eligible = (r) => !!r.sched_date && rowCreatedAfterCall(r, call) && sameService(r.service_type, slot.service)
    && (isOwn(r) || (!!sameName && sameName.has(r.customer_id)));
  // A standing date check tracks ONE visit and follows it wherever it moves, even past
  // the match window; when that visit is gone the bell turns back into "book it" below.
  const trackedId = newest ? newest.mismatch_visit_id : null;
  const tracked = bookedRows.find((r) => !!trackedId && String(r.id) === String(trackedId) && eligible(r));
  const later = bookedRows.filter((r) => eligible(r) && daysApart(r.sched_date, slot.dateET) <= OTHER_DAY_MATCH_DAYS);
  // The tracked visit when it fits, else the fitting later visit nearest the agreed day.
  const pick = (fits) => (tracked && fits(tracked) ? tracked : nearestTo(later.filter(fits), slot.dateET));
  const done = pick((r) => isOwn(r) && r.status === 'completed');
  if (done) return result('done_other_day', done, { closes: closeAll(`Visit done ${spokenSlot(done.sched_date, null)}`) });

  const live = pick((r) => LIVE_VISIT_STATUSES.has(r.status));
  if (live) {
    const startMinutes = windowStartMinutes(live.window_start);
    const mismatch = { visit_id: live.id, date: live.sched_date, time: startMinutes == null ? null : clockOf(startMinutes) };
    // The newest bell does not show this visit yet: a new episode. A visit moved A -> B -> A
    // rings again for A, because the key names the bell it replaces.
    if (newest && [newest.mismatch_visit_id, newest.mismatch_date, newest.mismatch_time].join('|') !== [mismatch.visit_id, mismatch.date, mismatch.time].join('|')) {
      const dedupeKey = `${BELL_DEDUPE_PREFIX}-date:${call.id}:${newest.id}:${mismatch.visit_id}:${mismatch.date}:${mismatch.time ?? 'none'}`;
      return result('booked_other_day', live, { mismatch, ring: { mismatch, dedupeKey }, closes: closeAll(REPLACED_BY_DATE_CHECK) });
    }
    return result('booked_other_day', live, { mismatch, ...keepNewest() });
  }

  if (dayNumber(etDateString(now)) - dayNumber(slot.dateET) >= PAST_AFTER_DAYS) {
    return result('past', null, { closes: closeAll('Agreed day passed with no visit booked') });
  }
  // The visit a standing date check named is gone (cancelled, deleted): the bell must stop
  // saying a visit is booked. Ring a fresh "book it" bell, then close the date check.
  if (trackedId) {
    return result('still_missed', null, { ring: { mismatch: null, dedupeKey: `${BELL_DEDUPE_PREFIX}-rebook:${call.id}:${newest.id}` }, closes: closeAll(REPLACED_VISIT_GONE) });
  }
  return result('still_missed', null, keepNewest());
}

const squashName = (v) => String(v || '').normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();

// Same service: the visit's service_type equals the call's agreed service name
// (whitespace and case aside). A name cut short with "…" (an old bell's title)
// matches by its prefix. No agreed service, no match.
function sameService(visitServiceType, agreedService) {
  const raw = String(agreedService || '');
  const cut = raw.endsWith('…');
  const want = squashName(cut ? raw.slice(0, -1) : raw);
  if (!want) return false;
  const have = squashName(visitServiceType);
  return cut ? have.startsWith(want) : have === want;
}

// One comparable name that keeps the first/last boundary: "first|last",
// trimmed, whitespace-collapsed, lower-cased. Both parts are required. The
// boundary matters: "Mary Jane" + "Smith" and "Mary" + "Jane Smith" are two
// different people.
function nameKey(first, last) {
  const f = squashName(first);
  const l = squashName(last);
  return f && l ? `${f}|${l}` : null;
}
// The same record as one unsplit string, for a caller known only by name_full.
const unsplitKey = (splitKey) => splitKey.replace('|', ' ');

// The name the caller gave: { split } when both parts were heard, else
// { unsplit } from a name_full of two or more words (the V2 schema lets either
// split field be null beside a complete name_full). A split name matches a
// record only on the same boundary; an unsplit one has no boundary to keep, so
// it is compared whole against the record's "first last". Nothing is sliced
// out of it.
function callerNameKey(extractionRaw) {
  let extraction = extractionRaw;
  if (typeof extraction === 'string') {
    try { extraction = JSON.parse(extraction); } catch { return null; }
  }
  const caller = extraction?.caller || {};
  const split = nameKey(caller.first_name, caller.last_name);
  if (split) return { split };
  const unsplit = squashName(caller.name_full);
  return unsplit.includes(' ') ? { unsplit } : null;
}

// The other accounts that carry each missed call's name: the linked
// customer's first and last name, or for an unlinked call the name the caller
// gave. Exact match on the boundary-keeping key (or, for a name_full-only
// caller, on the whole unsplit name); a missing first or last name on a
// record matches nothing.
//
// Scope: active, not soft-deleted, ANY pipeline stage. Not whereLiveCustomer
// on purpose: a customer the call pipeline created stays at new_lead after
// the office books it (customer-stages.js notes that the booking path does
// not promote the stage), and that booked record is exactly the namesake the
// audited call needed. A namesake row clears nothing by existing; only its
// own live visit at the agreed slot, created after the call, does. The
// likely-account hint is stricter and counts canonical live customers only
// (`live`), so a lead row is never named as an account and never makes a
// unique account look ambiguous.
// Returns { namesakes: Map(call id -> Set(customer id)), accounts: Map(customer id -> row) }.
async function loadNamesakeAccounts(misses) {
  const namesakes = new Map();
  const accounts = new Map();
  const linkedIds = [...new Set(misses.map((m) => m.call.customer_id).filter(Boolean))];
  const linked = linkedIds.length
    ? await db('customers').whereIn('id', linkedIds).select('id', 'first_name', 'last_name')
    : [];
  const linkedKey = new Map(linked.map((c) => [c.id, nameKey(c.first_name, c.last_name)]));
  const keyByCall = new Map();
  for (const m of misses) {
    const linkedSplit = m.call.customer_id ? linkedKey.get(m.call.customer_id) : null;
    const key = m.call.customer_id ? (linkedSplit && { split: linkedSplit }) : callerNameKey(m.call.ai_extraction_enriched);
    if (key) keyByCall.set(m.call.id, key);
  }
  // One fetch on the unsplit form (a superset); the boundary is applied below.
  const keys = [...new Set([...keyByCall.values()].map((k) => k.unsplit || unsplitKey(k.split)))];
  if (!keys.length) return { namesakes, accounts };
  const squash = (col) => `lower(btrim(regexp_replace(COALESCE(${col}, ''), '\\s+', ' ', 'g')))`;
  const rows = await db('customers')
    .where('active', true)
    .whereNull('deleted_at')
    .whereRaw(`(${squash('first_name')} || ' ' || ${squash('last_name')}) = ANY(?)`, [keys])
    .select('id', 'first_name', 'last_name', 'city', 'pipeline_stage');
  const idsBySplit = new Map();
  const idsByUnsplit = new Map();
  const index = (map, key, id) => { if (!map.has(key)) map.set(key, new Set()); map.get(key).add(id); };
  for (const r of rows) {
    const key = nameKey(r.first_name, r.last_name);
    if (!key) continue;
    accounts.set(r.id, { ...r, live: CUSTOMER_STAGES.includes(r.pipeline_stage) });
    index(idsBySplit, key, r.id);
    index(idsByUnsplit, unsplitKey(key), r.id);
  }
  for (const m of misses) {
    const k = keyByCall.get(m.call.id) || {};
    const ids = new Set((k.split ? idsBySplit.get(k.split) : idsByUnsplit.get(k.unsplit)) || []);
    if (m.call.customer_id) ids.delete(m.call.customer_id);
    if (ids.size) namesakes.set(m.call.id, ids);
  }
  return { namesakes, accounts };
}

// Whose visits the booking lookup reads: each call's own customer and its
// namesake accounts.
function evidenceCustomerIds(misses, namesakes) {
  return [...new Set([
    ...misses.map((m) => m.call.customer_id).filter(Boolean),
    ...[...namesakes.values()].flatMap((ids) => [...ids]),
  ])];
}

// An unlinked call whose caller's name is on exactly one canonical live
// customer (customer-stages CUSTOMER_STAGES): the bell names that account, so
// the office can link the call and book. Lead rows are not counted.
function nameLikelyAccounts(misses, namesakes, accounts) {
  for (const m of misses) {
    if (m.call.customer_id) continue;
    const live = [...(namesakes.get(m.call.id) || [])].map((id) => accounts.get(id)).filter((a) => a && a.live);
    if (live.length === 1) m.likelyAccount = live[0];
  }
}

// Has this exact miss already rung the bell (any time in the past)? Same
// notifications metadata dedupeKey pattern as call-ingest-watchdog —
// restart-safe, no new table.
async function alreadyAlerted(dedupeKey) {
  const existing = await db('notifications')
    .where({ recipient_type: 'admin' })
    .whereRaw("metadata->>'dedupeKey' = ?", [dedupeKey])
    .first('id')
    .catch(() => null);
  return !!existing;
}

// The evidence rows for a set of calls ({ call, slot } entries): one bulk
// lookup, three OR'd fetch branches matching what computeBookingMisses reads
// — date-agnostic, customer-agnostic provenance (source_call_log_id / Call SID
// marker): an in-place reschedule moves the call-linked row to another date,
// and the office may book the call under another household member, and either
// row must still be fetched or the watchdog pages a booked visit as missed —
// PLUS the calls' own customers on the confirmed dates (window-proximity
// fallback) and their namesake accounts on those dates (namesakeRowClearsSlot)
// — and a fourth for classifyOpenBookingMiss: every visit of the call's own
// customer and its namesakes created after the earliest call, any date, any
// status (the "later visits").
async function loadBookingRows(entries, namesakes) {
  const customerIds = evidenceCustomerIds(entries, namesakes);
  const dates = [...new Set(entries.map((m) => m.slot.dateET))];
  const callIds = entries.map((m) => m.call.id);
  const sidPatterns = entries
    .map((m) => m.call.twilio_call_sid)
    .filter(Boolean)
    .map((sid) => `%Call SID: ${sid}%`);
  const earliestCallAt = new Date(Math.min(...entries.map((m) => new Date(m.call.created_at).getTime())));
  return db('scheduled_services')
    .where(function bookedEvidence() {
      this.whereIn('source_call_log_id', callIds);
      const markerPatterns = [...sidPatterns, ...callIds.map((id) => `%Call ID: ${id}%`)];
      this.orWhereRaw('(notes LIKE ANY(?) OR internal_notes LIKE ANY(?))', [markerPatterns, markerPatterns]);
      if (customerIds.length) {
        this.orWhere(function ownCustomerOnDate() {
          this.whereIn('customer_id', customerIds)
            .whereRaw("to_char(scheduled_date, 'YYYY-MM-DD') = ANY(?)", [dates]);
        });
        if (!Number.isNaN(earliestCallAt.getTime())) {
          this.orWhere(function laterVisits() {
            this.whereIn('customer_id', customerIds).where('created_at', '>', earliestCallAt);
          });
        }
      }
    })
    .select(
      'id', 'customer_id', 'status', 'service_type', 'window_start', 'created_at', 'source_call_log_id', 'notes', 'internal_notes',
      db.raw("to_char(scheduled_date, 'YYYY-MM-DD') AS sched_date"),
    );
}

// The call facts both bell texts name in `detail`: when it was (ET), the
// customer's number, and which way it went.
function callFacts(call) {
  const outbound = String(call.direction || '').startsWith('outbound');
  return {
    callAtET: new Date(call.created_at).toLocaleString('en-US', {
      timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    }),
    contactPhone: outbound ? call.to_phone : call.from_phone,
    direction: call.direction || 'unknown-direction',
  };
}

// The date-check text, for the first ring and for the fresh bell the close
// pass raises when a visit lands on another day: the office booked a visit, but not on the day the call agreed. `name`
// is null when only the old bell's slot is known. Headline and why follow
// docs/admin-notifications.md (composeAdminAlert checks them).
function dateCheckAlert({ name, slot, call, mismatch, service = null }) {
  const agreedAt = spokenSlot(slot.dateET, slot.minutes);
  const bookedAt = spokenSlot(mismatch.date, windowStartMinutes(mismatch.time));
  const { callAtET, contactPhone, direction } = callFacts(call);
  return {
    action: `check ${name ? `${cutAtWord(name, MAX_HEADLINE_CHARS - 'Schedule — check '.length - "'s visit date".length)}'s` : 'the'} visit date`,
    why: `Booked ${bookedAt}; the call agreed ${agreedAt}.`,
    detail: `${name || 'The caller'} (${contactPhone || 'no number'}) agreed ${service || 'a visit'} for ${agreedAt} ` +
      `on a ${direction} call at ${callAtET} ET. The visit on the calendar is ${bookedAt}. ` +
      'Move it to the agreed day, or confirm the new day with the customer, then tap Done.',
    link: `/admin/dispatch?tab=schedule&date=${encodeURIComponent(mismatch.date)}`,
  };
}

// The "book it" text: the call confirmed a slot and nothing is on the calendar.
// The full sentence (phone number, direction, call time) stays in `detail`.
function bookItAlert(m, repeat) {
  const { callAtET, contactPhone, direction } = callFacts(m.call);
  return {
    action: `book ${cutAtWord(`${m.slot.name}'s ${m.slot.service || 'visit'}`, MAX_HEADLINE_CHARS - 'Schedule — book '.length)}`,
    why: `${repeat ? 'Still unbooked: confirmed' : 'Confirmed'} ${spokenSlot(m.slot.dateET, m.slot.minutes)} on a call; nothing is on the calendar.`,
    link: `/admin/dispatch?tab=schedule&date=${encodeURIComponent(m.slot.dateET)}`,
    detail: `${m.slot.name} (${contactPhone || 'no number'}) confirmed ${m.slot.service || 'a visit'} for ${m.slot.dateET} ${clockOf(m.slot.minutes)} ET ` +
      `on a ${direction} call at ${callAtET} ET, but the schedule has no matching appointment ` +
      `for that date${m.call.customer_id ? '' : ' — and the call is not linked to any customer'}. ` +
      likelyAccountSentence(m.likelyAccount) +
      'Book it in dispatch or call back to reset expectations.' +
      (repeat ? ' This keeps ringing until the visit is booked or the call\'s cards are dismissed.' : ''),
  };
}

// The close pass's plan (owner 2026-10-24), read-only: every open booking-miss
// bell, not only the ones a new ring would reach, grouped by call, with that
// call's verdict (classifyOpenBookingMiss). Returns [{ call, slot, plan }].
// closeResolvedBookingMissBells applies it; on its own it is the dry run (every
// read, no write).
async function planOpenBookingMissBells({ now = new Date() } = {}) {
  const openRows = await db('notifications')
    .where({ recipient_type: 'admin' })
    .whereNull('done_at')
    .whereRaw("metadata->>'dedupeKey' LIKE ?", [`${BELL_DEDUPE_PREFIX}%`])
    .whereRaw("metadata->>'call_log_id' IS NOT NULL")
    // Newest first: a call's first stamped row is its newest bell.
    .orderBy('created_at', 'desc')
    .select(
      'id', 'title', 'created_at',
      db.raw("metadata->>'call_log_id' AS call_log_id"),
      db.raw("metadata->>'confirmed_date_et' AS confirmed_date_et"),
      db.raw("metadata->>'confirmed_time_et' AS confirmed_time_et"),
      db.raw("metadata->>'confirmed_service' AS confirmed_service"),
      db.raw("metadata->'mismatch'->>'visit_id' AS mismatch_visit_id"),
      db.raw("metadata->'mismatch'->>'date' AS mismatch_date"),
      db.raw("metadata->'mismatch'->>'time' AS mismatch_time"),
    );
  if (!openRows.length) return [];
  const byCall = new Map(openRows.map((row) => [row.call_log_id, []]));
  for (const row of openRows) byCall.get(row.call_log_id).push(row);

  const calls = await db('call_log')
    .whereIn('id', [...byCall.keys()])
    .select('id', 'twilio_call_sid', 'customer_id', 'direction', 'created_at', 'from_phone', 'to_phone', 'ai_extraction_enriched',
      db.raw("metadata->'held_visit_dismissed'->>'at' AS held_visit_dismissed_at"));
  // The slot comes from the call's extraction. When a reprocessed extraction no
  // longer confirms one, the newest stamped bell stands in: its date and time,
  // and the service it stamps (confirmed_service survives a date check's title;
  // older bells carry the service only in a "book" title).
  const entries = [];
  for (const call of calls) {
    const rows = byCall.get(call.id);
    const stamp = rows.find((r) => r.confirmed_date_et && /^\d{2}:\d{2}/.test(r.confirmed_time_et));
    const slot = extractConfirmedSlot(call.ai_extraction_enriched) || (stamp && {
      dateET: stamp.confirmed_date_et,
      minutes: windowStartMinutes(stamp.confirmed_time_et),
      name: (/^Schedule — (?:book|check) (.+?)'s /.exec(stamp.title) || [])[1],
      service: stamp.confirmed_service || (/^Schedule — book .+?'s (.+)$/.exec(stamp.title) || [])[1],
    });
    if (slot) entries.push({ call, slot, rows });
  }
  if (!entries.length) return [];

  const { namesakes } = await loadNamesakeAccounts(entries);
  const bookedRows = await loadBookingRows(entries, namesakes);
  return entries.map(({ call, slot, rows }) => ({ call, slot, plan: classifyOpenBookingMiss(call, slot, bookedRows, rows, { now, namesakes }) }));
}

// Dismiss on the Dispatch held-visit strip (owner 2026-11-01): a person decided not to book the
// call's visit, so its open booking-miss bells close now as that person's Done (the close pass
// would close them on its next tick through the 'dismissed' verdict). `by` is the admin's id.
// Returns the number of bells closed.
async function closeBookingMissBellsForCall(callId, { by }) {
  const ids = await db('notifications')
    .where({ recipient_type: 'admin' })
    .whereNull('done_at')
    .whereRaw("metadata->>'call_log_id' = ?", [callId])
    .whereRaw("metadata->>'dedupeKey' LIKE ?", [`${BELL_DEDUPE_PREFIX}%`])
    .pluck('id');
  if (!ids.length) return 0;
  const NotificationService = require('./notification-service');
  return NotificationService.markAdminDone(ids, { by: String(by), resolution: DISMISSED_ON_DISPATCH, role: 'admin' });
}

// The close pass (owner 2026-10-24) applies the plan on every tick: each call's
// bells close as done with a resolution. A visit booked on another day is a NEW
// episode: it rings a fresh date-check bell once (the bell list orders by
// created_at, so a rewritten old row would stay buried), and only after that
// bell exists (raised, or already standing under the same key) are the old
// "nothing is on the calendar" bells closed. A failed raise closes nothing.
// System-closer pattern (openToCloser + doneColumns), the same shape
// promise-chaser-bell uses. Returns { closed, raised } (rows).
async function closeResolvedBookingMissBells({ now = new Date() } = {}) {
  const NotificationService = require('./notification-service');
  const plans = await planOpenBookingMissBells({ now });
  let closed = 0;
  let raised = 0;
  let waiting = 0;
  const closeRows = ({ ids, resolution }, callId) => NotificationService._private.openToCloser(db('notifications').where({ recipient_type: 'admin' }).whereIn('id', ids), BELL_DEDUPE_PREFIX)
    .update(NotificationService._private.doneColumns({ by: BELL_DEDUPE_PREFIX, resolution, keepExisting: true, conn: db }))
    .catch((err) => { logger.warn(`[call-booking-miss] failed to close bell(s) for call ${callId}: ${err.message}`); return 0; });
  for (const { call, slot, plan } of plans) {
    if (plan.ring) {
      // One alert budget per run (MAX_ALERTS_PER_RUN), shared with the ring path: past
      // it, a plan that needs a new bell waits for the next tick with its old bells open;
      // plain closes still run.
      if (raised >= MAX_ALERTS_PER_RUN) { waiting += 1; continue; }
      const outcome = await ringMiss({ call, slot, mismatch: plan.ring.mismatch }, { dedupeKey: plan.ring.dedupeKey, repeat: false })
        .catch((err) => { logger.warn(`[call-booking-miss] failed to raise the replacement bell for call ${call.id}: ${err.message}`); return 'failed'; });
      // Close the old bells only once the replacement stands ('rung' or an
      // existing row under the same key). A suppressed or failed raise keeps them.
      if (outcome !== 'rung' && outcome !== 'deduped') continue;
      if (outcome === 'rung') raised += 1;
    }
    for (const close of plan.closes) closed += await closeRows(close, call.id);
  }
  if (waiting) logger.warn(`[call-booking-miss] close pass: alert cap hit (${MAX_ALERTS_PER_RUN}); ${waiting} replacement(s) wait for the next tick`);
  if (closed || raised) logger.info(`[call-booking-miss] close pass: closed=${closed} raised=${raised}`);
  return { closed, raised };
}

async function runCallBookingMissWatchdog({ now = new Date() } = {}) {
  const { isEnabled } = require('../config/feature-gates');
  if (!isEnabled('callBookingMissWatchdog')) {
    return { skipped: true, reason: 'gated_off' };
  }
  // alreadyAlerted() is a read-then-notify with no unique constraint —
  // serialize ticks so deploy overlap can't double-ring.
  const { runExclusive } = require('../utils/cron-lock');
  return runExclusive('call-booking-miss-watchdog', () => runInner({ now }));
}

async function runInner({ now }) {
  const { closed, raised } = await closeResolvedBookingMissBells({ now })
    .catch((err) => { logger.warn(`[call-booking-miss] close pass failed: ${err.message}`); return { closed: 0, raised: 0 }; });
  const windowStart = new Date(now.getTime() - LOOKBACK_HOURS * 3600 * 1000);
  // Exclude ACTIVE processing only ('processing' / NULL): a delayed or
  // force-reprocessed call persists its valid V2 extraction BEFORE the
  // booking insert and the terminal status write, so alerting mid-run would
  // permanently ring a false bell. But failed TERMINAL states
  // (customer_creation_failed, lead_creation_failed) must stay in — a
  // confirmed slot on a call whose customer/lead creation failed is among
  // the highest-value misses this pager exists for. Candidate filtering on
  // the extraction happens in JS, not SQL: ai_extraction_enriched has been
  // both json and stringified-text across its history, so a ->> filter
  // would silently drop the string-era rows. The window keeps this cheap.
  // Repeats reach further back: a slot booked more than LOOKBACK_HOURS ahead
  // (a Monday call for next Sunday) is only inside its repeat window after
  // the call has left the first-ring window. Older rows are narrowed to ones
  // whose extraction text mentions a confirmed slot (both storage eras), and
  // kept only when that slot is inside the repeat window. A call that
  // already rang for a slot today or tomorrow (ET) is read at any age, so a
  // visit booked months ahead still repeats in its last day.
  const repeatScanStart = new Date(now.getTime() - REPEAT_LOOKBACK_DAYS * 86400 * 1000);
  const soonDates = [etDateString(now), etDateString(addETDays(now, 1))];
  const alertedSoonRows = await db('notifications')
    .where({ recipient_type: 'admin' })
    .whereRaw("metadata->>'dedupeKey' LIKE 'call-booking-miss:%'")
    .whereRaw("metadata->>'confirmed_date_et' = ANY(?)", [soonDates])
    .select(db.raw("metadata->>'call_log_id' AS call_log_id"));
  const alertedSoonIds = [...new Set(alertedSoonRows.map((r) => r.call_log_id).filter(Boolean))];
  const scanned = await db('call_log')
    .where(function firstRingOrRepeat() {
      this.where('created_at', '>=', windowStart)
        .orWhere(function recentConfirmed() {
          this.where('created_at', '>=', repeatScanStart)
            .whereRaw("ai_extraction_enriched::text LIKE '%confirmed_start_at%'");
        });
      if (alertedSoonIds.length) this.orWhereIn('id', alertedSoonIds);
    })
    .where({ v2_extraction_status: 'valid' })
    .whereRaw("processing_status IS NOT NULL AND processing_status <> 'processing'")
    .whereNotNull('ai_extraction_enriched')
    .select('id', 'twilio_call_sid', 'customer_id', 'direction', 'created_at', 'from_phone', 'to_phone', 'ai_extraction_enriched',
      db.raw("metadata->'held_visit_dismissed'->>'at' AS held_visit_dismissed_at"));
  // A call whose held row the office dismissed on Dispatch never rings (owner 2026-11-01).
  const calls = scanned.filter((c) => !c.held_visit_dismissed_at
    && (new Date(c.created_at) >= windowStart || slotInRepeatRange(extractConfirmedSlot(c.ai_extraction_enriched), now)));

  // One pass to find the confirmed slots, then one bulk booking lookup.
  const provisional = computeBookingMisses(calls, [], { now });
  if (!provisional.length) {
    return { skipped: false, scanned: calls.length, misses: 0, alerted: 0, closed, raised };
  }
  const { namesakes, accounts } = await loadNamesakeAccounts(provisional);
  const bookedRows = await loadBookingRows(provisional, namesakes);
  const missed = computeBookingMisses(calls, bookedRows, { now, namesakes });
  nameLikelyAccounts(missed, namesakes, accounts);
  // A later visit changes what the bell says. Done on another day: the call
  // was handled, so it never rings. On the calendar on another day: it rings
  // as a date check (the verdict's mismatch), not as "nothing is on the calendar".
  const misses = [];
  for (const m of missed) {
    const { verdict, mismatch } = classifyOpenBookingMiss(m.call, m.slot, bookedRows, [], { now, namesakes });
    m.mismatch = mismatch;
    if (verdict !== 'done_other_day') misses.push(m);
  }

  // The calls a repeat may reach this tick: the slot is inside the repeat window,
  // the office has not closed the call's cards, and no open bell is a standing date
  // check. That call has a booked visit (on the wrong day), so a repeat must never
  // re-ring it as "nothing is on the calendar"; the close pass, which ran first,
  // owns that bell (it follows the visit, or turns it back into "book it").
  const repeatIds = misses.filter((m) => repeatWindowOpen(m.slot, now)).map((m) => m.call.id);
  const repeatable = new Set();
  const lastRung = new Map();
  if (repeatIds.length) {
    const triageRows = await db('triage_items').whereIn('call_log_id', repeatIds).select('call_log_id', 'status', 'resolution_source');
    const rungRows = await db('notifications')
      .where({ recipient_type: 'admin' })
      .whereRaw("metadata->>'call_log_id' = ANY(?)", [repeatIds])
      .whereRaw("metadata->>'dedupeKey' LIKE 'call-booking-miss%'")
      .groupByRaw("metadata->>'call_log_id'")
      .select(db.raw("metadata->>'call_log_id' AS call_log_id"), db.raw('MAX(created_at) AS last_at'));
    for (const r of rungRows) lastRung.set(r.call_log_id, new Date(r.last_at));
    const dateCheckRows = await db('notifications')
      .where({ recipient_type: 'admin' })
      .whereNull('done_at')
      .whereRaw("metadata->>'dedupeKey' LIKE ?", [`${BELL_DEDUPE_PREFIX}%`])
      .whereRaw("metadata->>'call_log_id' = ANY(?)", [repeatIds])
      .whereRaw("metadata->'mismatch'->>'date' IS NOT NULL")
      .select(db.raw("metadata->>'call_log_id' AS call_log_id"));
    const standingDateChecks = new Set(dateCheckRows.map((r) => r.call_log_id));
    for (const id of repeatIds) {
      if (!standingDateChecks.has(id) && !officeClosedCall(triageRows.filter((r) => r.call_log_id === id))) repeatable.add(id);
    }
  }

  // GATE_ALERT_RING_ONCE (owner 2026-10-14): the first ring stands alone.
  const ringOnce = require('../config/feature-gates').alertRingOnceLive();
  let alerted = 0;
  let repeated = 0;
  for (const m of misses) {
    if (alerted + repeated + raised >= MAX_ALERTS_PER_RUN) {
      logger.warn(`[call-booking-miss] per-run alert cap hit (${MAX_ALERTS_PER_RUN}); the rest ring next tick`);
      break;
    }
    const dedupeKey = `call-booking-miss:${m.call.id}`;
    if (!(await alreadyAlerted(dedupeKey))) {
      const outcome = await ringMiss(m, { dedupeKey, repeat: false });
      if (outcome === 'rung') alerted += 1;
      continue;
    }
    // Already rung once. Re-ring while the call is repeatable (above) and the
    // last bell is older than the repeat interval.
    if (ringOnce || !repeatable.has(m.call.id)) continue;
    const last = lastRung.get(m.call.id);
    if (last && now.getTime() - last.getTime() < REPEAT_INTERVAL_MINUTES * 60 * 1000) continue;
    const outcome = await ringMiss(m, { dedupeKey: `call-booking-miss-repeat:${m.call.id}`, repeat: true });
    if (outcome === 'rung') repeated += 1;
  }
  return { skipped: false, scanned: calls.length, misses: misses.length, alerted, repeated, closed, raised };
}

function likelyAccountSentence(account) {
  if (!account) return '';
  const name = [account.first_name, account.last_name].map((v) => String(v || '').trim()).filter(Boolean).join(' ');
  return `One account carries this name: ${name}${account.city ? ` (${String(account.city).trim()})` : ''}. Confirm it is the same person, then link the call. `;
}

// One bell for one miss. bell:true is an explicit site-level ring: under
// GATE_ADMIN_BELL_POLICY the 'alert' category is silenced by default, which
// muted this pager from 2026-08-07 to 2026-09-30 while the job kept
// reporting "alert fired" (owner ruling 2026-09-30: this alarm always
// rings). Returns 'rung', 'deduped' or 'silenced'.
async function ringMiss(m, { dedupeKey, repeat }) {
  // Headline and why follow docs/admin-notifications.md. The office booked a visit,
  // but not on the agreed day: the date check says the dates differ.
  const text = m.mismatch
    ? dateCheckAlert({ name: m.slot.name, slot: m.slot, call: m.call, mismatch: m.mismatch, service: m.slot.service })
    : bookItAlert(m, repeat);
  const created = await raiseAdminAlert(
    'alert',
    {
      area: 'Schedule',
      action: text.action,
      why: text.why,
      severity: 'needs-you',
      // Booking happens on the schedule, so the tap opens the confirmed day there (the
      // booked day for a date check, where the fix is made); the call itself is named
      // in `detail` and in the subject.
      link: text.link,
      subject: { type: 'call', id: m.call.id },
      doneWhen: 'visit_booked',
      who: 'person',
    },
    {
      detail: text.detail,
      bell: true,
      // Top-level dedupeKey takes notifyAdmin's advisory-locked dedupe path
      // (it writes the key into metadata itself): forever for the first
      // bell, a rolling interval for repeats.
      dedupeKey,
      ...(repeat ? { dedupeWindowMs: REPEAT_INTERVAL_MINUTES * 60 * 1000 } : {}),
      metadata: {
        call_log_id: m.call.id,
        customer_id: m.call.customer_id || null,
        confirmed_date_et: m.slot.dateET,
        confirmed_time_et: clockOf(m.slot.minutes),
        confirmed_service: m.slot.service || null,
        ...(m.mismatch ? { mismatch: m.mismatch } : {}),
        ...(repeat ? { repeat: true } : {}),
      },
    },
  );
  // NotificationService.create swallows insert errors into a null result;
  // this job's ONLY output is the bell, so a lost bell must fail the run
  // loudly (cron error log + failed job_health) instead of logging
  // "alert fired".
  if (!created || (created.id == null && !created.suppressed)) {
    throw new Error(`[call-booking-miss] notification insert failed for ${dedupeKey} — pager output lost`);
  }
  if (created.deduped) return 'deduped';
  // A deliberate suppression (internal test customer) is success without a
  // row. Never log it as fired.
  if (created.suppressed) {
    logger.info(`[call-booking-miss] bell silenced (${created.reason || 'suppressed'}) for call ${m.call.id}`);
    return 'silenced';
  }
  logger.warn(`[call-booking-miss] Unbooked confirmed slot on call ${m.call.id} (${maskPhone(callFacts(m.call).contactPhone)}, ${m.slot.dateET}) — ${repeat ? 'repeat' : 'alert'} fired`);
  return 'rung';
}

// The agreed slot starts within REPEAT_WINDOW_HOURS, or it is still the
// slot's own ET day. This is the candidate-scan range only; repeatWindowOpen
// additionally requires the slot not to have started.
function slotInRepeatRange(slot, now = new Date()) {
  if (!slot) return false;
  const pad = (n) => String(n).padStart(2, '0');
  const start = parseETDateTime(`${slot.dateET}T${pad(Math.floor(slot.minutes / 60))}:${pad(slot.minutes % 60)}`);
  if (!start || Number.isNaN(start.getTime())) return false;
  if (start.getTime() - now.getTime() > REPEAT_WINDOW_HOURS * 3600 * 1000) return false;
  return slot.dateET >= etDateString(now);
}

// Repeat window: the agreed slot starts within REPEAT_WINDOW_HOURS and has
// not started yet, and it is daytime in ET (no overnight re-rings). Once the
// slot's start time passes the repeats stop (owner 2026-10-01: they used to
// run to the end of the slot's day, ringing at 23:22Z for a 1 PM slot); the
// first bell still rings for a slot that already passed unbooked.
function repeatWindowOpen(slot, now = new Date()) {
  if (!slotInRepeatRange(slot, now)) return false;
  const pad = (n) => String(n).padStart(2, '0');
  const start = parseETDateTime(`${slot.dateET}T${pad(Math.floor(slot.minutes / 60))}:${pad(slot.minutes % 60)}`);
  if (start.getTime() <= now.getTime()) return false;
  const hourET = etParts(now).hour;
  return hourET >= REPEAT_DAY_START_HOUR_ET && hourET < REPEAT_DAY_END_HOUR_ET;
}

// The office closed the call: a person resolved or dismissed at least one of
// its triage cards (resolution_source 'human') and none is still open. That
// stops repeats (the first bell already rang). Cards the nightly sweep
// ('auto'), the processor ('system') or event-driven resolvers (NULL) closed
// are not an office decision and never silence the pager.
function officeClosedCall(triageRows) {
  if (!triageRows.length) return false;
  if (triageRows.some((r) => r.status === 'open' || r.status === 'in_progress')) return false;
  return triageRows.some((r) => (r.status === 'resolved' || r.status === 'dismissed') && r.resolution_source === 'human');
}

module.exports = {
  runCallBookingMissWatchdog,
  computeBookingMisses,
  classifyOpenBookingMiss,
  planOpenBookingMissBells,
  closeResolvedBookingMissBells,
  closeBookingMissBellsForCall,
  dateCheckAlert,
  extractConfirmedSlot,
  confirmedWallClockET,
  rowClearsSlot,
  rowCarriesCall,
  namesakeRowClearsSlot,
  loadNamesakeAccounts,
  likelyAccountSentence,
  LOOKBACK_HOURS,
  GRACE_MINUTES,
  MAX_ALERTS_PER_RUN,
  WINDOW_MATCH_TOLERANCE_MINUTES,
  REPEAT_INTERVAL_MINUTES,
  repeatWindowOpen,
  officeClosedCall,
  INACTIVE_STATUSES,
  NAMESAKE_LIVE_STATUSES,
  LIVE_VISIT_STATUSES,
  OTHER_DAY_MATCH_DAYS,
  PAST_AFTER_DAYS,
};
