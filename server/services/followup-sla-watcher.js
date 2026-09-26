/**
 * One-hour follow-up watcher — the fast pager for promises made on calls.
 *
 * Owner rulings (2026-09-26): a promise our staff makes on a call (call the
 * customer back, send a quote, come back with a time) is due within ONE
 * HOUR, counted only between 8:00 AM and 8:00 PM ET — a 7:30 PM promise is
 * due 8:30 AM the next day. The missed list is a rolling 24 hours,
 * regardless of how many items it holds.
 *
 * Why a separate pager: the daily watchers (call-commitments-watchdog,
 * promised-estimate-watcher, unworked-comms-watcher) all fired on the
 * dropped promises that prompted this, but as once-a-day backlogs of
 * hundreds of rows nobody could act on. This one looks only at promises
 * whose one-hour deadline passed in the last 24 hours.
 *
 * Scope: promises heard on a call that no one has touched (isPagerScope);
 * reviewed work stays with the Owed queue and the daily overdue watchdog.
 *
 * A promise counts as followed up when call-commitments' own fulfillment
 * proof closes it (estimate sent, a returned call that reached the customer,
 * handoff, staff marked done), when staff dismissed or snoozed it, or when
 * the customer shows later activity the proof does not model: a visit
 * booked, a connected call about a quote or scheduling promise, or a text a
 * staff member sent by hand.
 *
 * Alert: one rolling "missed in the last 24 hours" list (see runInner) —
 * posted fresh when a new miss joins it, rewritten in place when items drop
 * off, retired when it empties. Internal only — nothing here reaches a
 * customer. Read-only except admin notifications and the
 * fulfillment stamps refreshFulfillment already writes.
 *
 * Gates: GATE_FOLLOWUP_SLA_ALERTS (this pager) on top of
 * GATE_CALL_COMMITMENTS (no rows exist without it).
 */

const db = require('../models/db');
const logger = require('./logger');
const NotificationService = require('./notification-service');
const commitments = require('./call-commitments');
const { etDateString } = require('../utils/datetime-et');
const { isInternalTestCustomerId } = require('./internal-test-customers');

// Same trigger as the overdue watchdog: registered tech-visible, so the
// bell reaches the staff who work the Owed tab.
const TRIGGER_KEY = 'call_commitment_overdue';
const SLA_KINDS = Object.freeze(['callback', 'send_estimate', 'schedule_visit']);
// Human-authored texts, as the callback proof counts them: typed by staff,
// or an AI draft staff approved or revised before it went out.
const HUMAN_TEXT_TYPES = Object.freeze(['manual', 'ai_approved', 'ai_revised']);
const SLA_MINUTES = 60;
const DAY_OPEN = '08:00';
const DAY_CLOSE = '20:00';
const WINDOW_MS = 24 * 60 * 60 * 1000;
const SCAN_LIMIT = 200;
// Each rolling-list post is keyed `${ROLLING_KEY}:<posted at>`.
const ROLLING_KEY = 'followup-sla-rolling';

// The SLA clock: the owner's 8 AM–8 PM ET hours (ruling 2026-09-26 — wider
// than the booking day in booking_config), skipping every day the office
// calendar marks closed (holidays, closures: the blackout layers the
// callback cards already honor). The math is callback-cards' staffedDeadline.
const OPEN_CALENDAR = Object.freeze({ start: DAY_OPEN, end: DAY_CLOSE, closed: new Set() });
// Closed days from the oldest promise scanned through the furthest deadline
// staffedDeadline can reach from now (60 days ahead) — today's and future
// closures included, or a closed day would count as staffed time.
async function loadSlaCalendar(conn, from, now = new Date()) {
  const { getBlackoutLayers } = require('./scheduling/blackout-dates');
  const { addETDays } = require('../utils/datetime-et');
  const { dates } = await getBlackoutLayers(etDateString(from), etDateString(addETDays(now, 60)), conn);
  return { start: DAY_OPEN, end: DAY_CLOSE, closed: dates };
}

// The moment a promise made at `promisedAt` is due: SLA_MINUTES of open
// office time after it. Time outside those hours, and closed days, do not
// count.
function followUpDueAt(promisedAt, calendar = OPEN_CALENDAR, minutes = SLA_MINUTES) {
  const t = new Date(promisedAt);
  if (Number.isNaN(t.getTime())) return null;
  return require('./callback-cards').staffedDeadline(t, calendar, minutes);
}

// When the promise stands from: the row for one staff entered by hand; for
// one heard on a call, the moment that call ENDED (call_ended_at, attached
// in runInner) — never its start, or a promise made late in a long call
// would fall due early. The start is only a fallback for a call row that
// could not be read.
function promisedAt(row) {
  const basis = row.source === 'human' ? row.created_at : (row.call_ended_at || row.call_started_at || row.created_at);
  const at = basis ? new Date(basis) : null;
  return at && !Number.isNaN(at.getTime()) ? at : null;
}

// The deadline this pager enforces. A stated time ("call you tomorrow at
// 10") is the promise itself and wins; a snoozed callback waits for its
// snooze, as everywhere else in the Owed queue.
function slaDueAt(row, calendar = OPEN_CALENDAR) {
  // A stated time is a DEADLINE only when extraction said so (due_type
  // 'deadline'); otherwise — 'floor' ("send it after the inspection"), or a
  // missing type / human-edited time — it is the earliest moment the work
  // can happen, and the one-hour clock starts there (call-commitments'
  // due_type contract).
  const stated = row.due_at ? new Date(row.due_at) : null;
  const statedOk = stated && !Number.isNaN(stated.getTime());
  let due = statedOk && row.due_type === 'deadline' ? stated : null;
  if (!due) {
    const at = promisedAt(row);
    const from = statedOk && (!at || stated > at) ? stated : at;
    due = from ? followUpDueAt(from, calendar) : null;
  }
  if (!due) return null;
  // Only a live callback card's snooze counts — the Owed queue's own rule
  // (overdueAt / stillOpenIds): after a callback-card rollback a stored
  // snooze postpones nothing.
  const snoozed = row.snoozed_until && require('./callback-cards').enabled() ? new Date(row.snoozed_until) : null;
  return snoozed && snoozed.getTime() > due.getTime() ? snoozed : due;
}

// The pager's scope: a promise heard on a call (AI-detected) that no one
// has touched. Once staff confirm, edit, reopen or dismiss a promise — or
// enter one by hand — someone is on it, and it stays with the Owed queue
// and the daily overdue watchdog, which own reviewed work.
function isPagerScope(r) {
  return !!r && r.party === 'waves' && SLA_KINDS.includes(r.kind) && r.source !== 'human' && !r.human_state;
}

// Pure: untouched open Waves promises of the SLA kinds whose deadline passed
// within the last 24 hours.
function selectMissed(rows, { now = new Date(), calendar = OPEN_CALENDAR } = {}) {
  const floor = now.getTime() - WINDOW_MS;
  return (rows || [])
    .filter((r) => isPagerScope(r) && r.status === 'open' && !isInternalTestCustomerId(r.customer_id))
    .map((r) => ({ ...r, sla_due_at: slaDueAt(r, calendar) }))
    .filter((r) => r.sla_due_at && r.sla_due_at.getTime() <= now.getTime() && r.sla_due_at.getTime() > floor)
    .sort((a, b) => a.sla_due_at - b.sla_due_at);
}

// Customer activity after the promise that the fulfillment proof does not
// model: a visit booked, a call that reached the customer (on any SLA kind,
// not only callbacks), or a staff-typed text that was sent. Automated
// texts (reminders, confirmations) never count as a follow-up.
// The caller's number on the promise's call: the dialed number on an
// outbound call, the caller ID on an inbound one.
// The call-commitments digits rule (phoneDigits / phoneWhere), so the pager
// and the fulfillment proof always agree on which numbers match.
function phoneKey(value) {
  return commitments.phoneDigits(value) || null;
}

function contactPhone(row) {
  return String(row.direction || '').startsWith('outbound') ? row.to_phone : row.from_phone;
}

// Where evidence may start: after the promise's call ENDED (promisedAt) —
// a text sent mid-call is not a follow-up. Pager rows are untouched, so no
// staff renewal can move this boundary.
// Which of these promises show follow-up the proof does not close on its
// own, in five queries however many rows (the check also runs under the publishing
// lock): a booking someone made, a call that reached the customer, or a text
// a staff member typed. Evidence counts only after the promise's call ENDED
// (promisedAt) and is matched by customer — or, for a caller with no
// customer record yet, by the number the promise was made on.
async function followedUpIds(conn, rows) {
  const scoped = (rows || []).map((r) => ({ r, since: promisedAt(r), phone: r.customer_id ? null : contactPhone(r) }))
    .filter((x) => x.since && (x.r.customer_id || x.phone));
  const done = new Set();
  if (!scoped.length) return done;
  const floor = new Date(Math.min(...scoped.map((x) => x.since.getTime())));
  const customerIds = [...new Set(scoped.filter((x) => x.r.customer_id).map((x) => x.r.customer_id))];
  // Numbers match however they were written (9415550123, +19415550123,
  // (941) 555-0123) — call-commitments' phoneWhere rule, batched.
  const phones = [...new Set(scoped.filter((x) => x.phone).map((x) => phoneKey(x.phone)).filter(Boolean))];
  // A caller with no customer record when the promise was made is usually
  // linked (or created) by the very follow-up that keeps it, so their later
  // calls and texts match by number whether or not they carry a customer now.
  const byContact = (qb) => qb.where(function contact() {
    if (customerIds.length) this.whereIn('customer_id', customerIds);
    if (phones.length) commitments.phoneWhereAny(this, 'to_phone', phones, { or: true });
  });
  // …and a booking made for them lands under the customer that number
  // belongs to by then.
  const phoneCustomers = phones.length ? await commitments.phoneWhereAny(conn('customers'), 'phone', phones).select('id', 'phone') : [];
  const customersByPhone = new Map();
  for (const c of phoneCustomers) {
    const k = phoneKey(c.phone);
    customersByPhone.set(k, [...(customersByPhone.get(k) || []), String(c.id)]);
  }
  const visitCustomerIds = [...new Set([...customerIds.map(String), ...phoneCustomers.map((c) => String(c.id))])];
  // A booking someone made — never a visit the system generated on its own
  // (the nightly series top-up, a booking's seeded follow-ups) and never one
  // later cancelled (the proof's own rule).
  const visits = visitCustomerIds.length ? await conn('scheduled_services').whereIn('customer_id', visitCustomerIds)
    .where('created_at', '>', floor).whereNull('recurring_parent_id').whereNull('parent_service_id')
    .whereNotIn('status', ['cancelled', 'canceled']).select('customer_id', 'created_at') : [];
  // A call that reached the customer — the proof's bar for a returned
  // callback (completed customer leg of 60 s or more, affirmatively not
  // voicemail), applied to every SLA kind; never a voice-relay sandbox call.
  const calls = await byContact(conn('call_log'))
    .modify((b) => require('./voice-agent/relay-protocol').whereNotSandboxCall(b))
    .whereRaw("direction LIKE 'outbound%'").where('created_at', '>', floor)
    // The proof's two connected-call arms: a callback-card bridge whose
    // customer leg completed (>= 60 s, affirmatively not voicemail), or an
    // ordinary outbound call — no card link — whose own duration is >= 60 s.
    .where(function connected() {
      this.where(function cardLeg() {
        this.whereRaw("metadata->'customer_leg'->>'status' = 'completed'")
          .whereRaw("CASE WHEN metadata->'customer_leg'->>'duration_seconds' ~ '^[0-9]+$' THEN (metadata->'customer_leg'->>'duration_seconds')::numeric >= 60 ELSE FALSE END")
          .where('v2_extraction_status', 'valid')
          .whereRaw("ai_extraction_enriched->'meta'->>'is_voicemail' = 'false'");
      }).orWhere(function ordinary() {
        this.whereRaw("metadata->>'relatedCommitmentId' IS NULL AND COALESCE(metadata->>'callback_policy', '') <> 'card'")
          .whereRaw('COALESCE(duration_seconds, 0) >= 60');
      });
    })
    .select('id', 'customer_id', 'to_phone', 'created_at');
  // A text a person typed that actually went out: the staff send paths stamp
  // BOTH message_type 'manual' and admin_user_id (either alone admits
  // automated texts), and only queued/sent/delivered rows reached anyone.
  const texts = await byContact(conn('sms_log'))
    .whereRaw("direction LIKE 'out%'").where('created_at', '>', floor)
    .whereIn('message_type', HUMAN_TEXT_TYPES).whereNotNull('admin_user_id')
    .whereIn('status', ['queued', 'sent', 'delivered'])
    .select('customer_id', 'to_phone', 'created_at');
  // A quote delivered to the customer rather than linked to this call: the
  // canonical proof records it as an association hint on the promise
  // (fulfillment kind estimate_sent, status still open) — its ownership rules
  // (customer FK, lead mirror, caller phone) are the Owed queue's own.
  const quoteIds = scoped.filter((x) => x.r.kind === 'send_estimate').map((x) => x.r.id);
  const hints = quoteIds.length ? await conn('call_commitments').whereIn('id', quoteIds).select('id', 'fulfillment') : [];
  for (const h of hints) {
    const f = typeof h.fulfillment === 'string' ? JSON.parse(h.fulfillment) : h.fulfillment;
    if (f?.kind === 'estimate_sent') done.add(h.id);
  }
  const after = (rec, since) => new Date(rec.created_at).getTime() > since.getTime();
  const mine = (rec, x) => (x.r.customer_id ? String(rec.customer_id) === String(x.r.customer_id)
    : phoneKey(rec.to_phone) === phoneKey(x.phone));
  const visitFor = (v, x) => (x.r.customer_id ? String(v.customer_id) === String(x.r.customer_id)
    : (customersByPhone.get(phoneKey(x.phone)) || []).includes(String(v.customer_id)));
  for (const x of scoped) {
    if (visits.some((v) => visitFor(v, x) && after(v, x.since))
      || calls.some((c) => c.id !== x.r.call_log_id && mine(c, x) && after(c, x.since))
      || texts.some((t) => mine(t, x) && after(t, x.since))) done.add(x.r.id);
  }
  return done;
}

// How far back a promise can have been made and still fall due inside the
// window: the 24-hour window plus the longest span one hour of open office
// time can take — the same 60-day horizon staffedDeadline itself supports,
// so no closure run the office calendar can hold hides a current miss.
const LOOKBACK_MS = WINDOW_MS + 60 * 24 * 60 * 60 * 1000;

async function listOpenWaves(now) {
  const all = [];
  const activeSince = new Date(now.getTime() - LOOKBACK_MS);
  // Every page, however many: the list is uncapped, and the read is already
  // bounded to promises that can fall due inside the window (activeSince).
  for (let page = 0; ; page += 1) {
    const rows = await commitments.listOpenCommitments(db, { party: 'waves', limit: SCAN_LIMIT, offset: page * SCAN_LIMIT, includeHints: true, prepare: page === 0, now, activeSince });
    all.push(...rows);
    if (rows.length < SCAN_LIMIT) break;
  }
  return all;
}

function whoFor(row) {
  const name = [row.customer_first_name, row.customer_last_name].filter(Boolean).join(' ');
  if (name) return name;
  const digits = String(contactPhone(row) || '').replace(/\D/g, '');
  return digits ? `caller ***${digits.slice(-4)}` : 'unknown caller';
}

const WHAT = { callback: 'callback', send_estimate: 'quote', schedule_visit: 'time to come out' };

function etTime(value) {
  return new Date(value).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function describe(row) {
  return `${WHAT[row.kind] || 'follow-up'} promised to ${whoFor(row)} at ${etTime(promisedAt(row))} (due ${etTime(row.sla_due_at)})`;
}

// The promises this pager owns right now: SLA kinds whose one-hour
// deadline is still ahead or passed within its 24-hour window. While the
// pager is live AND healthy (pagerHealthy), the daily overdue watchdog
// leaves exactly these alone and takes a promise over once it ages off the
// rolling list — one alert family per promise, no overdue bell before the
// SLA deadline. The takeover covers what the watchdog pages at all: an
// undated scheduling promise (schedule_visit, no due_at) has no overdue
// deadline there, so after 24 hours it returns to exactly what it had
// before this pager — the Owed queue, no bell. During a pager outage the watchdog covers them instead; a
// promise it paged then may also appear on the list once the pager
// recovers — a repeat, never a silence.
async function slaOwnedIds(conn, rows, now = new Date()) {
  const eligible = (rows || []).filter(isPagerScope);
  if (!eligible.length) return new Set();
  const callIds = [...new Set(eligible.filter((r) => r.source !== 'human' && r.call_log_id).map((r) => r.call_log_id))];
  const calls = callIds.length
    ? await conn('call_log').whereIn('id', callIds).select('id', 'created_at', 'duration_seconds', 'bridged_at', 'direction')
    : [];
  const endedById = new Map(calls.map((c) => [c.id, commitments.callEndedAt(c)]));
  const floor = now.getTime() - WINDOW_MS;
  const calendar = await loadSlaCalendar(conn, new Date(now.getTime() - LOOKBACK_MS), now);
  return new Set(eligible.filter((r) => {
    const due = slaDueAt({ ...r, call_ended_at: endedById.get(r.call_log_id) || null }, calendar);
    return due && due.getTime() > floor;
  }).map((r) => r.id));
}

// The pager's most recent scheduled tick (every 15 minutes 8:00–20:45 ET,
// scheduler.js), so its health can be judged overnight too.
function lastScheduledTick(now) {
  const { etParts, parseETDateTime, addETDays } = require('../utils/datetime-et');
  const { hour, minute } = etParts(now);
  const today = etDateString(now);
  if (hour < 8) return parseETDateTime(`${etDateString(addETDays(now, -1))}T20:45`);
  if (hour > 20 || (hour === 20 && minute >= 45)) return parseETDateTime(`${today}T20:45`);
  const floored = Math.floor(minute / 15) * 15;
  return parseETDateTime(`${today}T${String(hour).padStart(2, '0')}:${String(floored).padStart(2, '0')}`);
}

// Whether the pager is actually working: its latest settled scheduled tick
// succeeded. The daily
// watchdog defers to the pager only while this holds — a pager that keeps
// failing hands its promises straight back.
async function pagerHealthy(conn, now = new Date()) {
  const row = await conn('job_health').where({ job_name: 'followup-sla-watcher' }).first('last_success_at', 'last_started_at', 'last_status');
  // The latest run must have SUCCEEDED and have STARTED on or after the
  // settled tick — a run that began before it (and finished late) says
  // nothing about that tick, and a failed or still-running one proves nothing.
  if (row?.last_status !== 'success') return false;
  const started = row.last_started_at ? new Date(row.last_started_at).getTime() : NaN;
  const last = Number.isFinite(started) ? started : NaN;
  // Judged against the last tick that has had time to FINISH: at 8:00 AM the
  // opening tick is still running (the watchdog fires at the same minute),
  // so it is measured against last night's 8:45 PM tick, not today's.
  const settled = lastScheduledTick(new Date(now.getTime() - 10 * 60 * 1000));
  return Number.isFinite(last) && last >= settled.getTime();
}

async function runFollowUpSlaWatcher({ now = new Date() } = {}) {
  const { isEnabled } = require('../config/feature-gates');
  if (!isEnabled('followupSlaAlerts') || !isEnabled('callCommitments')) return { skipped: true, reason: 'gated_off' };
  const { runExclusive } = require('../utils/cron-lock');
  return runExclusive('followup-sla-watcher', async () => {
    const result = await runInner({ now });
    // An unverified tick left the list unchanged — job health must show it,
    // or persistent lookup failures would silence the pager while it reads
    // green (the commitment watchdog's rule).
    if (result.unverified) throw new Error(`Follow-up verification incomplete for ${result.unverified} call(s)`);
    return result;
  });
}

async function runInner({ now = new Date() } = {}) {
  const listed = await listOpenWaves(now);
  // Each promise heard on a call stands from the moment that call ended.
  const callIds = [...new Set(listed.filter((r) => r.source !== 'human' && r.call_log_id).map((r) => r.call_log_id))];
  const calls = callIds.length
    ? await db('call_log').whereIn('id', callIds).select('id', 'created_at', 'duration_seconds', 'bridged_at', 'direction')
    : [];
  const endedById = new Map(calls.map((c) => [c.id, commitments.callEndedAt(c)]));
  const rows = listed.map((r) => ({ ...r, call_ended_at: endedById.get(r.call_log_id) || null }));
  const calendar = await loadSlaCalendar(db, new Date(now.getTime() - LOOKBACK_MS), now);
  let candidates = selectMissed(rows, { now, calendar });
  // Refresh the proof for the candidate calls first — nothing stamps
  // fulfillment until someone opens the queue — and never page on a call
  // whose proof could not be checked.
  const unverified = new Set();
  for (const id of [...new Set(candidates.map((r) => r.call_log_id))]) {
    const r = await commitments.refreshFulfillment(db, id).catch((err) => {
      logger.warn(`[followup-sla] fulfillment refresh failed for call ${id}: ${err.message}`);
      return { failed: 1 };
    });
    if (r.failed > 0) unverified.add(id);
  }
  const live = await commitments.stillOpenIds(db, candidates.map((r) => r.id), { now });
  const liveCandidates = candidates.filter((r) => live.has(r.id));
  candidates = liveCandidates.filter((r) => !unverified.has(r.call_log_id));
  let missed = [];
  const followed = await followedUpIds(db, candidates).catch((err) => {
    logger.warn(`[followup-sla] activity lookup failed: ${err.message}`);
    return null;
  });
  if (followed === null) candidates.forEach((r) => unverified.add(r.call_log_id));
  else missed = candidates.filter((r) => !followed.has(r.id));

  // ONE alert — the rolling list of every promise missed in the last 24
  // hours (owner ruling: a revolving 24 hours, regardless of number),
  // recomputed from live state on every tick:
  //  - a promise newly on the list → a fresh post at the top of the feed,
  //    unread (a key unique to the post);
  //  - items only dropped off → the latest post is rewritten in place, its
  //    read state kept (good news never re-rings);
  //  - nothing missed → the latest post is marked read and flagged emptied,
  //    so a miss that returns later always gets a fresh post.
  // A promise whose call could not be verified this tick is never newly
  // listed, but one ALREADY on the list stays on it — one bad lookup never
  // holds back every other miss, nor silently drops one (the tick still
  // fails job health).
  let alerted = 0;
  let changed = 0;
  const latest = await db('notifications').where({ recipient_type: 'admin' })
    .whereRaw("metadata->>'dedupeKey' LIKE ?", [`${ROLLING_KEY}:%`])
    .orderBy('created_at', 'desc').first('id', 'metadata', 'read_at', 'title', 'body');
  const meta = (latest && (typeof latest.metadata === 'string' ? JSON.parse(latest.metadata) : latest.metadata)) || {};
  const shown = latest && !meta.emptied ? (meta.missed_commitment_ids || []).map(String) : [];
  // A promise held over this way still drops off when later activity
  // (booking, connected call, staff text) independently proves follow-up.
  const heldOver = liveCandidates.filter((r) => unverified.has(r.call_log_id) && shown.includes(String(r.id)));
  const heldFollowed = await followedUpIds(db, heldOver).catch(() => new Set());
  const carried = heldOver.filter((r) => !heldFollowed.has(r.id));
  const onList = [...missed, ...carried].sort((a, b) => a.sla_due_at - b.sla_due_at);
  // Publish in ONE transaction that first locks and reloads every listed
  // promise: if staff changed any of them since the scan (a new deadline,
  // a dismissal, a snooze — anything that moves updated_at) or it closed,
  // this tick publishes nothing and the next one decides on fresh rows.
  // The same transaction posts the new list and retires the old posts, so
  // the single rolling alert never splits into two unread copies.
  await db.transaction(async (trx) => {
    // Every staff action on a promise (dismiss, snooze, edit, close) moves
    // its updated_at, so a status + updated_at comparison catches them all.
    const locked = await trx('call_commitments').whereIn('id', onList.map((r) => r.id)).forUpdate().select('id', 'status', 'updated_at');
    const byId = new Map(locked.map((f) => [String(f.id), f]));
    const stamp = (v) => new Date(v || 0).getTime();
    changed = onList.filter((r) => byId.get(String(r.id))?.status !== 'open'
      || stamp(byId.get(String(r.id)).updated_at) !== stamp(r.updated_at)).length;
    // Follow-up evidence lives in other tables (visits, calls, texts) that
    // this lock does not fence: re-check it now, after the lock.
    if (!changed) changed = (await followedUpIds(trx, onList)).size;
    if (changed) {
      logger.info(`[followup-sla] ${changed} listed promise(s) changed during the tick — list left for the next tick`);
      return;
    }
    const ids = onList.map((r) => String(r.id)).sort();
    const fresh = ids.filter((id) => !shown.includes(id));
    // Stored the way NotificationService stores admin text (emoji stripped
    // — owner ruling), so an in-place rewrite matches a fresh post exactly.
    const { stripEmoji } = require('../utils/strip-emoji');
    const title = stripEmoji(`${ids.length} missed follow-up${ids.length === 1 ? '' : 's'} in the last 24 hours`);
    const body = stripEmoji(`Promises made on calls with no follow-up within an hour (8 AM–8 PM):\n${onList.map((r) => `• ${describe(r)}`).join('\n')}`);
    if (fresh.length) {
      const key = `${ROLLING_KEY}:${now.toISOString()}`;
      const notif = await NotificationService.notifyAdmin('alert', title, body, {
        link: '/admin/communications#tab=owed', dedupeKey: key, bell: true, trx,
        metadata: { triggerKey: TRIGGER_KEY, missed_commitment_ids: ids },
      });
      if (!notif?.id || notif.suppressed) return;
      await trx('notifications').where({ recipient_type: 'admin' }).whereNull('read_at')
        .whereRaw("metadata->>'dedupeKey' LIKE ?", [`${ROLLING_KEY}:%`])
        .whereRaw("metadata->>'dedupeKey' <> ?", [key]).update({ read_at: now });
      alerted = fresh.length;
      return;
    }
    // No new miss: keep the standing post true without re-ringing it —
    // emptied → read and flagged (a returning miss posts fresh); fewer
    // items or changed details → rewritten in place, read state kept.
    if (!shown.length) return;
    const patch = ids.length
      ? { title, body, metadata: JSON.stringify({ ...meta, missed_commitment_ids: ids }) }
      : { read_at: latest.read_at || now, metadata: JSON.stringify({ ...meta, emptied: true }) };
    // Same items, same words: nothing to write (an emptied patch carries no
    // title, so it never matches).
    if (patch.title === latest.title && patch.body === latest.body && ids.length === shown.length) return;
    await trx('notifications').where({ id: latest.id }).update(patch);
  });
  return { skipped: false, scanned: rows.length, candidates: candidates.length, missed: onList.length, alerted, changed, unverified: unverified.size };
}

module.exports = {
  runFollowUpSlaWatcher,
  runInner,
  followUpDueAt,
  loadSlaCalendar,
  slaDueAt,
  selectMissed,
  slaOwnedIds,
  isPagerScope,
  pagerHealthy,
  lastScheduledTick,
  followedUpIds,
  SLA_KINDS,
  ROLLING_KEY,
};
