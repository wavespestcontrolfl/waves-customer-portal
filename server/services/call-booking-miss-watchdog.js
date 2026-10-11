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
 * agreed ET date, within the window tolerance, active, and created AFTER the
 * call. An older visit of a namesake never clears. The bell for an unlinked
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
 */

const db = require('../models/db');
const logger = require('./logger');
const { raiseAdminAlert, cutAtWord, MAX_HEADLINE_CHARS } = require('./admin-alert-compose');
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
  return !!call.twilio_call_sid && String(row.notes || '').includes(`Call SID: ${call.twilio_call_sid}`);
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
// and last name as the call's customer or caller): the agreed ET date, an
// active row, the window tolerance, and created strictly after the call. The
// created-after fence is what the own-customer rule does not need: a namesake
// may be another person, and only a booking made after this call answers it.
function namesakeRowClearsSlot(row, call, slot) {
  if (row.sched_date !== slot.dateET || INACTIVE_STATUSES.has(row.status)) return false;
  const startMinutes = windowStartMinutes(row.window_start);
  if (startMinutes === null || Math.abs(startMinutes - slot.minutes) > WINDOW_MATCH_TOLERANCE_MINUTES) return false;
  const rowAt = row.created_at ? new Date(row.created_at).getTime() : NaN;
  const callAt = call.created_at ? new Date(call.created_at).getTime() : NaN;
  return Number.isFinite(rowAt) && Number.isFinite(callAt) && rowAt > callAt;
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
    const sameName = namesakes.get(call.id);
    const cleared = bookedRows.some((row) => (
      rowCarriesCall(row, call)
      || (!!call.customer_id && row.customer_id === call.customer_id && rowClearsSlot(row, call, slot))
      || (!!sameName && sameName.has(row.customer_id) && namesakeRowClearsSlot(row, call, slot))
    ));
    if (cleared) continue;
    misses.push({ call, slot, serviceDateET: slot.dateET });
  }
  return misses;
}

function nameKey(first, last) {
  const norm = (v) => String(v || '').normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
  const f = norm(first);
  const l = norm(last);
  return f && l ? `${f}|${l}` : null;
}

function callerNameKey(extractionRaw) {
  let extraction = extractionRaw;
  if (typeof extraction === 'string') {
    try { extraction = JSON.parse(extraction); } catch { return null; }
  }
  return nameKey(extraction?.caller?.first_name, extraction?.caller?.last_name);
}

// The other live accounts that carry each missed call's name: the linked
// customer's first and last name, or for an unlinked call the name the caller
// gave. Exact match on trimmed, whitespace-collapsed, lower-cased text; a
// missing first or last name matches nothing. Returns
// { namesakes: Map(call id -> Set(customer id)), accounts: Map(customer id -> row) }.
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
    const key = m.call.customer_id ? linkedKey.get(m.call.customer_id) : callerNameKey(m.call.ai_extraction_enriched);
    if (key) keyByCall.set(m.call.id, key);
  }
  const keys = [...new Set(keyByCall.values())];
  if (!keys.length) return { namesakes, accounts };
  const squash = (col) => `lower(btrim(regexp_replace(COALESCE(${col}, ''), '\\s+', ' ', 'g')))`;
  const rows = await db('customers')
    .where('active', true)
    .whereNull('deleted_at')
    .whereRaw(`(${squash('first_name')} || '|' || ${squash('last_name')}) = ANY(?)`, [keys])
    .select('id', 'first_name', 'last_name', 'city');
  const idsByKey = new Map();
  for (const r of rows) {
    accounts.set(r.id, r);
    const key = nameKey(r.first_name, r.last_name);
    if (!key) continue;
    if (!idsByKey.has(key)) idsByKey.set(key, new Set());
    idsByKey.get(key).add(r.id);
  }
  for (const m of misses) {
    const ids = new Set(idsByKey.get(keyByCall.get(m.call.id)) || []);
    if (m.call.customer_id) ids.delete(m.call.customer_id);
    if (ids.size) namesakes.set(m.call.id, ids);
  }
  return { namesakes, accounts };
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

async function runInner({ now = new Date() } = {}) {
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
    .select('id', 'twilio_call_sid', 'customer_id', 'direction', 'created_at', 'from_phone', 'to_phone', 'ai_extraction_enriched');
  const calls = scanned.filter((c) => new Date(c.created_at) >= windowStart || slotInRepeatRange(extractConfirmedSlot(c.ai_extraction_enriched), now));

  // One pass to find the confirmed slots, then one bulk booking lookup.
  const provisional = computeBookingMisses(calls, [], { now });
  if (!provisional.length) {
    return { skipped: false, scanned: calls.length, misses: 0, alerted: 0 };
  }
  const { namesakes, accounts } = await loadNamesakeAccounts(provisional);
  const customerIds = [...new Set([
    ...provisional.map((m) => m.call.customer_id).filter(Boolean),
    ...[...namesakes.values()].flatMap((ids) => [...ids]),
  ])];
  const dates = [...new Set(provisional.map((m) => m.serviceDateET))];
  const callIds = provisional.map((m) => m.call.id);
  const sidPatterns = provisional
    .map((m) => m.call.twilio_call_sid)
    .filter(Boolean)
    .map((sid) => `%Call SID: ${sid}%`);
  // Three OR'd fetch branches, matching the evidence computeBookingMisses
  // reads: date-agnostic, customer-agnostic provenance (source_call_log_id /
  // Call SID marker) — an in-place reschedule moves the call-linked row to
  // another date, and the office may book the call under another household
  // member, and either row must still be fetched or the watchdog pages a
  // booked visit as missed — PLUS the calls' own customers on the confirmed
  // dates (window-proximity fallback) and their namesake accounts on those
  // dates (namesakeRowClearsSlot).
  const bookedRows = await db('scheduled_services')
    .where(function bookedEvidence() {
      this.whereIn('source_call_log_id', callIds);
      if (sidPatterns.length) this.orWhereRaw('notes LIKE ANY(?)', [sidPatterns]);
      if (customerIds.length) {
        this.orWhere(function ownCustomerOnDate() {
          this.whereIn('customer_id', customerIds)
            .whereRaw("to_char(scheduled_date, 'YYYY-MM-DD') = ANY(?)", [dates]);
        });
      }
    })
    .select(
      'customer_id', 'status', 'window_start', 'created_at', 'source_call_log_id', 'notes',
      db.raw("to_char(scheduled_date, 'YYYY-MM-DD') AS sched_date"),
    );
  const misses = computeBookingMisses(calls, bookedRows, { now, namesakes });
  // An unlinked call whose caller's name is on exactly one live account: the
  // bell names that account, so the office can link the call and book.
  for (const m of misses) {
    const ids = m.call.customer_id ? null : namesakes.get(m.call.id);
    if (ids && ids.size === 1) m.likelyAccount = accounts.get([...ids][0]) || null;
  }

  // Office dismissal and last-ring lookups, only for calls a repeat could
  // reach this tick (slot inside the repeat window).
  const repeatCandidates = misses.filter((m) => repeatWindowOpen(m.slot, now));
  const closedCalls = new Set();
  const lastRung = new Map();
  if (repeatCandidates.length) {
    const ids = repeatCandidates.map((m) => m.call.id);
    const triageRows = await db('triage_items').whereIn('call_log_id', ids).select('call_log_id', 'status', 'resolution_source');
    for (const id of ids) {
      if (officeClosedCall(triageRows.filter((r) => r.call_log_id === id))) closedCalls.add(id);
    }
    const rungRows = await db('notifications')
      .where({ recipient_type: 'admin' })
      .whereRaw("metadata->>'call_log_id' = ANY(?)", [ids])
      .whereRaw("metadata->>'dedupeKey' LIKE 'call-booking-miss%'")
      .groupByRaw("metadata->>'call_log_id'")
      .select(db.raw("metadata->>'call_log_id' AS call_log_id"), db.raw('MAX(created_at) AS last_at'));
    for (const r of rungRows) lastRung.set(r.call_log_id, new Date(r.last_at));
  }

  let alerted = 0;
  let repeated = 0;
  for (const m of misses) {
    if (alerted + repeated >= MAX_ALERTS_PER_RUN) {
      logger.warn(`[call-booking-miss] per-run alert cap hit (${MAX_ALERTS_PER_RUN}); the rest ring next tick`);
      break;
    }
    const dedupeKey = `call-booking-miss:${m.call.id}`;
    if (!(await alreadyAlerted(dedupeKey))) {
      const outcome = await ringMiss(m, { dedupeKey, repeat: false });
      if (outcome === 'rung') alerted += 1;
      continue;
    }
    // Already rung once. Re-ring while the slot is under a day away, the
    // office has not closed the call's cards, and the last bell is older
    // than the repeat interval.
    if (!repeatCandidates.includes(m) || closedCalls.has(m.call.id)) continue;
    const last = lastRung.get(m.call.id);
    if (last && now.getTime() - last.getTime() < REPEAT_INTERVAL_MINUTES * 60 * 1000) continue;
    const outcome = await ringMiss(m, { dedupeKey: `call-booking-miss-repeat:${m.call.id}`, repeat: true });
    if (outcome === 'rung') repeated += 1;
  }
  return { skipped: false, scanned: calls.length, misses: misses.length, alerted, repeated };
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
  const pad = (n) => String(n).padStart(2, '0');
  const slotClock = `${pad(Math.floor(m.slot.minutes / 60))}:${pad(m.slot.minutes % 60)}`;
  const slotET = `${m.slot.dateET} ${slotClock} ET`;
  const callAtET = new Date(m.call.created_at).toLocaleString('en-US', {
    timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
  const contactPhone = String(m.call.direction || '').startsWith('outbound') ? m.call.to_phone : m.call.from_phone;
  // Headline and why follow docs/admin-notifications.md; the full sentence (phone
  // number, direction, call time) stays in `detail`. A spoken day and time, never ISO.
  const slotAt = parseETDateTime(`${m.slot.dateET}T${slotClock}`);
  const spokenDay = slotAt.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'America/New_York' }).replace(',', '');
  const created = await raiseAdminAlert(
    'alert',
    {
      area: 'Schedule',
      action: `book ${cutAtWord(`${m.slot.name}'s ${m.slot.service || 'visit'}`, MAX_HEADLINE_CHARS - 'Schedule — book '.length)}`,
      why: `${repeat ? 'Still unbooked: confirmed' : 'Confirmed'} ${spokenDay} at ${formatETTime(slotAt)} on a call; nothing is on the calendar.`,
      severity: 'needs-you',
      // Booking happens on the schedule, so the tap opens the confirmed day there;
      // the call itself is named in `detail` and in the subject.
      link: `/admin/dispatch?tab=schedule&date=${encodeURIComponent(m.slot.dateET)}`,
      subject: { type: 'call', id: m.call.id },
      doneWhen: 'visit_booked',
      who: 'person',
    },
    {
      detail: `${m.slot.name} (${contactPhone || 'no number'}) confirmed ${m.slot.service || 'a visit'} for ${slotET} ` +
        `on a ${m.call.direction || 'unknown-direction'} call at ${callAtET} ET, but the schedule has no matching appointment ` +
        `for that date${m.call.customer_id ? '' : ' — and the call is not linked to any customer'}. ` +
        likelyAccountSentence(m.likelyAccount) +
        'Book it in dispatch or call back to reset expectations.' +
        (repeat ? ' This keeps ringing until the visit is booked or the call\'s cards are dismissed.' : ''),
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
        confirmed_time_et: slotClock,
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
  logger.warn(`[call-booking-miss] Unbooked confirmed slot on call ${m.call.id} (${maskPhone(contactPhone)}, ${m.serviceDateET}) — ${repeat ? 'repeat' : 'alert'} fired`);
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
};
