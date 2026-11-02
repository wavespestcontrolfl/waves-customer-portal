/**
 * Tech open-visit nudge — one 7 PM ET text to each technician who still has
 * open visits from TODAY.
 *
 * Owner request 2026-09-28: "just do an afternoon nudge, at 7 pm." About a
 * third of visits each week are left open past their day because arrival /
 * on_site is set automatically by the geofence and en_route is the tech's
 * only tap — nothing today reminds them to tap Complete. The stale-visit
 * sweep (server/services/stale-visit-sweep.js) and the schedule-integrity
 * watchdog only ring the ADMIN bell; this is the one text to the tech
 * themselves. No morning repeat, no other changes.
 *
 * Gate: GATE_TECH_OPEN_VISIT_NUDGE, off unless exactly 'true', read at CALL
 * time (unset is the kill switch — a flip needs no redeploy). Off returns
 * {status:'gate_off'} before any query.
 *
 * Dedupe: exactly one text per technician per ET day, durable across
 * restarts and multiple instances. The scheduler cron already runs this
 * inside runExclusive, but that only serializes ONE process's replicas at a
 * time — so before sending, this claims a `tech_notifications` row keyed on
 * `dedupe_key = "tech_open_visit_nudge:<technicianId>:<etDate>"`. That
 * column already carries a GLOBAL UNIQUE index (migration
 * 20260911000020_follow_through_alerts.js, added for the follow-through
 * tracker's own dedupe), so a concurrent claim from two instances can only
 * ever have one winner — no new migration needed. The loser skips the send.
 *
 * Channel: the owner gets a text; every other tech gets a tech-home card
 * (kept until "Got it") plus a push. sendSMS
 * writes sms_log + a conversations thread for every text, and only owner
 * phones are filtered out of the communications views, so a hired tech's
 * cell would land in the customer inbox (Codex r2) — card + push is the
 * staff channel tech-line.js and tech-visit-notifications.js already use. The
 * owner's technicians.phone is the office line, so the text goes to
 * ADAM_PHONE (ownerCell); usableCell keeps a Waves line from ever being the
 * recipient. messageType 'internal_alert' with `allowOwnerSms`, because an
 * owner-phone internal_alert is otherwise redirected into the admin bell;
 * OWNER_SMS_DISABLED still applies. A tech marked out for today
 * (technician_absences) is skipped, and members of one visit group count as
 * one stop.
 *
 * Carry-over (owner 2026-11-02): GATE_RESERVICE_OPEN_CARRYOVER, strict
 * 'true', read at call time and only when the nudge itself runs. On, the same
 * text also names every re-service (callback or pest/lawn re-service) still
 * open from the last 30 days before today, until it is closed. Off, nothing
 * changes. The dedupe key stays one claim per technician per ET day.
 */
const db = require('../models/db');
const logger = require('./logger');
const TwilioService = require('./twilio');
const { isAssignable, absentTechDays } = require('./technician-eligibility');
const { usableCell } = require('./tech-line');
const { etDateString, etParts } = require('../utils/datetime-et');
const { publicPortalUrl } = require('../utils/portal-url');

const GATE = 'GATE_TECH_OPEN_VISIT_NUDGE';
const CARRYOVER_GATE = 'GATE_RESERVICE_OPEN_CARRYOVER';
const CARRYOVER_DAYS = 30;
const RESERVICE_KEYS = ['pest_re_service', 'lawn_re_service'];
// Same allowlist the stale-visit sweep rings the admin about — every status
// that still means "not done." completed/cancelled/skipped/rescheduled/
// no_show are excluded on purpose; a visit that ended has nothing left to
// nudge.
const OPEN_STATUSES = ['pending', 'confirmed', 'en_route', 'on_site'];
// Never tapped En Route — listed too (a third of the 2026-09-28 backlog was
// never started), but marked so the tech knows it needs closing, not finishing.
const NOT_STARTED = new Set(['pending', 'confirmed']);
const NOTIFICATION_TYPE = 'tech_open_visit_nudge';
const MAX_LISTED = 5;

function enabled() {
  // Strict '===' (not the permissive gateEnvValue '1'/'true'/'on' parse):
  // this gate texts a tech's personal phone, so it ships dark until the
  // owner sets the literal string 'true'.
  return process.env[GATE] === 'true';
}

function carryoverEnabled() {
  return process.env[CARRYOVER_GATE] === 'true';
}

const VISIT_COLUMNS = [
  's.id as visit_id',
  's.visit_id as stop_id',
  's.status',
  's.window_start',
  's.service_type',
  's.technician_id',
  't.name as tech_name',
  't.employment_status',
  't.field_dispatchable',
  't.phone as tech_phone',
  'c.first_name as cust_first_name',
  'c.last_name as cust_last_name',
];

// An uncommitted slot hold (public-estimate reservation: no customer + a
// reservation stamp) is not a booking — same filter as occupancy.js.
function notSlotHold(q) {
  return q.whereNotNull('s.customer_id').orWhereNull('s.reservation_expires_at');
}

// Today's open visits with a technician assigned, joined to the technician
// and customer rows the message needs. Ordered by window so a tech's list
// reads chronologically and the "+N more" tail drops the latest stops. A
// visit whose window starts after the send time (an evening stop) hasn't
// happened yet, so it is left out; a visit with no window is kept.
async function findOpenVisitsToday(now, technicianId = null) {
  const today = etDateString(now);
  const { hour, minute } = etParts(now);
  const nowHHMM = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  let query = db('scheduled_services as s')
    .join('technicians as t', 's.technician_id', 't.id')
    .leftJoin('customers as c', 's.customer_id', 'c.id')
    .where('s.scheduled_date', today)
    .whereIn('s.status', OPEN_STATUSES)
    .whereNotNull('s.technician_id')
    .where((q) => q.whereNull('s.window_start').orWhere('s.window_start', '<=', nowHHMM))
    .where(notSlotHold)
    .orderBy('s.window_start', 'asc');
  if (technicianId) query = query.where('s.technician_id', technicianId);
  return query.select(...VISIT_COLUMNS);
}

// "today minus 30 days" from the ET date string itself, so a DST change never
// shifts the floor by a day.
function carryoverFloor(today) {
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - CARRYOVER_DAYS);
  return d.toISOString().slice(0, 10);
}

// Re-services still open from an earlier day (last 30 ET days): a callback
// visit, or one whose catalog service is a pest/lawn re-service. Same joins
// and slot-hold filter as today's query; oldest first.
async function findCarryoverVisits(now, technicianId = null) {
  const today = etDateString(now);
  let query = db('scheduled_services as s')
    .join('technicians as t', 's.technician_id', 't.id')
    .leftJoin('customers as c', 's.customer_id', 'c.id')
    .leftJoin('services', 's.service_id', 'services.id')
    .where('s.scheduled_date', '<', today)
    .where('s.scheduled_date', '>=', carryoverFloor(today))
    .whereIn('s.status', OPEN_STATUSES)
    .whereNotNull('s.technician_id')
    .where((q) => q.where('s.is_callback', true).orWhereIn('services.service_key', RESERVICE_KEYS))
    .where(notSlotHold)
    .orderBy('s.scheduled_date', 'asc')
    .orderBy('s.window_start', 'asc');
  if (technicianId) query = query.where('s.technician_id', technicianId);
  return query.select(...VISIT_COLUMNS, db.raw("to_char(s.scheduled_date, 'YYYY-MM-DD') as scheduled_day"));
}

// Flat rows -> one entry per technician, in first-seen (= earliest window)
// order. Members of one visit group (shared scheduled_services.visit_id) are
// ONE stop with one closeout in the tech portal, so they collapse into one
// line: service types joined, "not started" only if no member has started.
function groupByTechnician(rows) {
  const order = [];
  const byId = new Map();
  for (const row of rows) {
    const id = String(row.technician_id);
    if (!byId.has(id)) {
      byId.set(id, {
        tech: {
          id,
          name: row.tech_name,
          employment_status: row.employment_status,
          field_dispatchable: row.field_dispatchable,
          phone: row.tech_phone,
        },
        visits: [],
        stops: new Map(),
      });
      order.push(id);
    }
    const group = byId.get(id);
    const stopKey = String(row.stop_id || row.visit_id);
    const existing = group.stops.get(stopKey);
    if (existing) {
      existing.ids.push(row.visit_id);
      if (row.service_type && !existing.serviceTypes.includes(row.service_type)) existing.serviceTypes.push(row.service_type);
      if (!NOT_STARTED.has(row.status)) existing.status = row.status;
      continue;
    }
    const stop = {
      id: row.visit_id,
      ids: [row.visit_id],
      status: row.status,
      windowStart: row.window_start,
      day: row.scheduled_day,
      serviceTypes: row.service_type ? [row.service_type] : [],
      customerFirst: row.cust_first_name,
      customerLast: row.cust_last_name,
    };
    group.stops.set(stopKey, stop);
    group.visits.push(stop);
  }
  return order.map((id) => {
    const { tech, visits } = byId.get(id);
    return { tech, visits };
  });
}

// "Maria S." — first name + last initial ONLY. Never the full last name
// (this text can sit on a lock screen).
function customerLabel(visit) {
  const first = String(visit.customerFirst || '').trim();
  const lastInitial = String(visit.customerLast || '').trim().slice(0, 1);
  if (first && lastInitial) return `${first} ${lastInitial}.`;
  if (first) return first;
  return 'Customer';
}

// window_start is a TIME column ('HH:MM' / 'HH:MM:SS') — "2:00 PM", ET
// wall-clock, no timezone math needed (the column IS the ET wall clock).
function clock12(value) {
  if (!value) return null;
  const [hStr, mStr] = String(value).split(':');
  const h = Number(hStr);
  const m = Number(mStr || 0);
  if (!Number.isInteger(h)) return null;
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  const meridiem = h < 12 ? 'AM' : 'PM';
  return `${hour12}:${String(m).padStart(2, '0')} ${meridiem}`;
}

// Plain " - " separators: a middle dot or em dash is outside GSM-7 and would
// force the whole text into UCS-2 (twice the segments, and long UCS-2 texts
// have gone missing on handsets — see the GSM normalizer's notes).
function visitLine(visit) {
  const time = clock12(visit.windowStart) || 'No time';
  const services = (visit.serviceTypes || []).join(' + ') || 'Service';
  const line = `${time} - ${customerLabel(visit)} - ${services}`;
  return NOT_STARTED.has(visit.status) ? `${line} (not started)` : line;
}

// "Waves: 3 visits from today are still open. Tap to close out: <link>" then
// up to MAX_LISTED lines, then "+N more". One plain-text message, no
// signature (owner ruling: brand is just "Waves").
function visitLines(visits) {
  const shown = visits.slice(0, MAX_LISTED);
  const lines = shown.map(visitLine);
  const overflow = visits.length - shown.length;
  if (overflow > 0) lines.push(`+${overflow} more`);
  return lines;
}

// "Mon Oct 27" from a YYYY-MM-DD string. Built from noon UTC and formatted in
// UTC, so no timezone can move the day.
function dayLabel(day) {
  const d = new Date(`${day}T12:00:00Z`);
  if (!day || Number.isNaN(d.getTime())) return 'Earlier';
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' })
      .formatToParts(d).map((p) => [p.type, p.value]),
  );
  return `${parts.weekday} ${parts.month} ${parts.day}`;
}

function carryoverLine(stop) {
  const services = (stop.serviceTypes || []).join(' + ') || 'Service';
  const line = `${dayLabel(stop.day)} - ${customerLabel(stop)} - ${services}`;
  return NOT_STARTED.has(stop.status) ? `${line} (not started)` : line;
}

function carryoverLines(stops) {
  const shown = stops.slice(0, MAX_LISTED);
  const lines = shown.map(carryoverLine);
  const overflow = stops.length - shown.length;
  if (overflow > 0) lines.push(`+${overflow} more`);
  return lines;
}

// Body under the header: today's lines, then (when both exist) the
// carry-over sub-header and its lines.
function bodyLines(visits, carryovers) {
  if (!carryovers.length) return visitLines(visits);
  if (!visits.length) return carryoverLines(carryovers);
  return [...visitLines(visits), 'Re-services still open from earlier days:', ...carryoverLines(carryovers)];
}

function buildMessage(visits, carryovers = []) {
  const link = `${publicPortalUrl()}/tech`;
  let header;
  if (visits.length) {
    header = `Waves: ${visits.length} visit${visits.length === 1 ? '' : 's'} from today are still open. Tap to close out: ${link}`;
  } else {
    const n = carryovers.length;
    const verb = n === 1 ? 'is' : 'are';
    header = `Waves: ${n} re-service${n === 1 ? '' : 's'} from earlier days ${verb} still open. Tap to close out: ${link}`;
  }
  return [header, ...bodyLines(visits, carryovers)].join('\n');
}

// Stored with the claim row and the card: the stop ids behind the text.
function nudgePayload(visits, carryovers) {
  const payload = { visit_ids: visits.flatMap((v) => v.ids), count: visits.length };
  if (carryovers) {
    payload.carryover_ids = carryovers.flatMap((v) => v.ids);
    payload.carryover_count = carryovers.length;
  }
  return payload;
}

function dedupeKeyFor(technicianId, etDate) {
  return `${NOTIFICATION_TYPE}:${technicianId}:${etDate}`;
}

// The SMS target, for the owner only. sendSMS writes sms_log + a
// conversations thread for every text, and only owner phones are filtered
// out of the communications views — a hired tech's cell would land in the
// customer inbox as an unknown contact (Codex r2), so other techs get a push
// instead. The owner's technicians.phone is the office line (tech-line.js
// usableCell note), so the text goes to ADAM_PHONE, the cell owner alerts
// already use. usableCell guards both: a Waves line is never the recipient.
function ownerCell(tech) {
  if (!tech.phone || !TwilioService.isKnownOwnerPhone(tech.phone)) return null;
  return usableCell(tech) || usableCell({ id: tech.id, phone: process.env.ADAM_PHONE });
}

// Log tag for a caught error: never err.message, which can carry the bound
// SQL values (the message body names customers) or a recipient number.
function errTag(err) {
  return err?.code || err?.name || 'error';
}

// Claims today's slot for this technician. Returns true when THIS call won
// the claim (the row was inserted) — false when a dedupe_key collision means
// either an earlier run today already claimed it, or a concurrent replica
// just did. onConflict/ignore is the same idempotent-insert shape
// tech-visit-notifications.js's recordTrackingNotice uses against the same
// column. The row is born read + dismissed: it is the send marker, not a
// card — GET /api/tech/notifications skips dismissed rows, so the tech home
// never renders the SMS body (raw link included) as a second notice.
async function claimToday(technicianId, etDate, message, payload) {
  const now = new Date();
  const inserted = await db('tech_notifications')
    .insert({
      technician_id: technicianId,
      type: NOTIFICATION_TYPE,
      dedupe_key: dedupeKeyFor(technicianId, etDate),
      message,
      payload: JSON.stringify(payload),
      read: true,
      dismissed_at: now,
    })
    .onConflict('dedupe_key')
    .ignore()
    .returning('id');
  return inserted.length > 0;
}

// Undo a claim whose send was definitely refused. Best-effort: a failed
// delete only means no retry today, never a duplicate text.
async function releaseClaim(technicianId, etDate) {
  try {
    await db('tech_notifications')
      .where({ dedupe_key: dedupeKeyFor(technicianId, etDate), type: NOTIFICATION_TYPE })
      .del();
  } catch (err) {
    logger.warn(`[tech-open-visit-nudge] claim release failed for ${technicianId}: ${errTag(err)}`);
  }
}

// The owner: one text. Nothing went out → the day's slot goes back so a
// re-run can retry; an uncertain outcome keeps it, because the text may
// already be on the phone and a second copy is worse than a missed one.
async function smsNudge(tech, cell, message, etDate) {
  try {
    const result = await TwilioService.sendSMS(cell, message, {
      messageType: 'internal_alert',
      // `cell` is always a known owner phone (ownerCell), so no
      // unknown-recipient override is needed. Without allowOwnerSms,
      // twilio.js redirects an owner-phone internal_alert into the admin
      // bell instead of texting it — the channel this nudge replaces.
      // OWNER_SMS_DISABLED still silences it (checked separately).
      allowOwnerSms: true,
    });
    // Delivered only on a provider accept, or the push-routing layer's
    // in-app delivery. Every other answer put nothing on the phone —
    // success:false, and the success:true sentinels (suppressed for
    // OWNER_SMS_DISABLED, gateBlocked for the SMS gate, templateDisabled) —
    // so the slot goes back for a later retry. An uncertain outcome keeps
    // it: the text may already be on the phone.
    if (result?.deliveryOutcome === 'accepted' || result?.pushRouted === true) return true;
    logger.warn(`[tech-open-visit-nudge] text not delivered for ${tech.id}: ${result?.code || result?.sid || 'refused'}`);
    if (result?.deliveryOutcome !== 'uncertain') await releaseClaim(tech.id, etDate);
    return false;
  } catch (err) {
    // sendSMS throws a provider rejection with providerOutcome attached;
    // only an explicit not_sent is safe to retry.
    logger.error(`[tech-open-visit-nudge] send threw for ${tech.id}: ${errTag(err)}`);
    if (err?.providerOutcome?.deliveryOutcome === 'not_sent') await releaseClaim(tech.id, etDate);
    return false;
  }
}

// Every tech but the owner (tech-line.js / tech-visit-notifications.js
// pattern — staff-only, never a customer thread): the day's marker row
// becomes a tech-home card, kept until "Got it", then one best-effort push.
// The card is the durable copy, so a push that reaches no device still
// leaves the reminder on the tech home.
async function cardNudge(tech, visits, etDate, carryovers = null) {
  const carry = carryovers || [];
  const count = visits.length;
  const headline = count
    ? `${count} visit${count === 1 ? '' : 's'} from today still open`
    : `${carry.length} re-service${carry.length === 1 ? '' : 's'} from earlier days still open`;
  try {
    const updated = await db('tech_notifications')
      .where({ dedupe_key: dedupeKeyFor(tech.id, etDate), type: NOTIFICATION_TYPE })
      .update({
        message: [`${headline}.`, ...bodyLines(visits, carry)].join('\n'),
        payload: JSON.stringify({ headline, ...nudgePayload(visits, carryovers) }),
        read: false,
        dismissed_at: null,
        updated_at: new Date(),
      });
    if (!updated) return false;
  } catch (err) {
    logger.error(`[tech-open-visit-nudge] card write failed for ${tech.id}: ${errTag(err)}`);
    await releaseClaim(tech.id, etDate);
    return false;
  }
  try {
    const PushService = require('./push-notifications');
    await PushService.sendToAdminUser(tech.id, {
      title: headline,
      body: 'Tap to close them out.',
      url: '/tech',
      tag: `${NOTIFICATION_TYPE}-${etDate}`,
    });
  } catch (err) {
    logger.warn(`[tech-open-visit-nudge] push failed for ${tech.id} (card already written): ${errTag(err)}`);
  }
  return true;
}

// Today's stops (and, gate on, the carry-over stops) one technician holds
// right now. Null when both are empty. `carryovers` is only set with the gate.
async function readLiveStops(techId, now, withCarryover) {
  const pick = (rows) => groupByTechnician(rows).find((g) => g.tech.id === String(techId));
  const today = pick(await findOpenVisitsToday(now, techId));
  const carry = withCarryover ? pick(await findCarryoverVisits(now, techId)) : null;
  const base = today || carry;
  if (!base) return null;
  const live = { tech: base.tech, visits: today ? today.visits : [] };
  if (withCarryover) live.carryovers = carry ? carry.visits : [];
  return live;
}

// Re-read at the send boundary: a visit finished or reassigned, a phone
// changed, or the tech marked out (tech-out.js leaves an absent tech's stops
// assigned for redistribution) after the sweep read must not be listed or
// sent. Nothing to nudge gives the slot back. Gate on, both today's stops and
// the carry-over stops are re-read.
async function deliverNudge(techId, etDate, now, withCarryover = carryoverEnabled()) {
  let live;
  let absent;
  try {
    live = await readLiveStops(techId, now, withCarryover);
    // includeOffDays: false - an open visit a technician really holds on a day
    // they do not work (an office placement) still gets its nudge.
    absent = await absentTechDays(db, { dateFrom: etDate, dateTo: etDate, technicianIds: [techId], includeOffDays: false });
  } catch (err) {
    // One tech's failed re-read must not end the run for the rest, nor keep
    // a claim for a nudge that never went out.
    logger.error(`[tech-open-visit-nudge] send-time re-read failed for ${techId}: ${errTag(err)}`);
    await releaseClaim(techId, etDate);
    return false;
  }
  if (!live || !isAssignable(live.tech) || absent.size > 0) {
    logger.info(`[tech-open-visit-nudge] skip ${techId}: nothing to nudge at send time`);
    await releaseClaim(techId, etDate);
    return false;
  }
  const cell = ownerCell(live.tech);
  return cell
    ? smsNudge(live.tech, cell, buildMessage(live.visits, live.carryovers), etDate)
    : cardNudge(live.tech, live.visits, etDate, live.carryovers);
}

// One entry per technician: today's stops first, then technicians who only
// have carry-over stops. Each entry is { tech, visits, carryovers }.
function mergeGroups(todayGroups, carryGroups) {
  const byId = new Map(todayGroups.map((g) => [g.tech.id, { ...g, carryovers: [] }]));
  for (const g of carryGroups) {
    const entry = byId.get(g.tech.id);
    if (entry) entry.carryovers = g.visits;
    else byId.set(g.tech.id, { tech: g.tech, visits: [], carryovers: g.visits });
  }
  return [...byId.values()];
}

/**
 * Runs the whole sweep once: gate check, today's open visits grouped by
 * technician, eligibility + phone filtering, per-technician dedupe claim,
 * then one SMS (owner) or tech-home card + push (everyone else) per technician that claimed a
 * slot. Never throws — a
 * per-technician send failure is logged and counted as skipped; the sweep
 * keeps going for the rest.
 */
async function runTechOpenVisitNudge({ now = new Date() } = {}) {
  if (!enabled()) return { status: 'gate_off' };

  const withCarryover = carryoverEnabled();
  const etDate = etDateString(now);
  const rows = await findOpenVisitsToday(now);
  const carryRows = withCarryover ? await findCarryoverVisits(now) : [];
  const groups = mergeGroups(groupByTechnician(rows), groupByTechnician(carryRows));

  let sent = 0;
  let skipped = 0;

  for (const { tech, visits, carryovers } of groups) {
    if (!isAssignable(tech)) {
      logger.info(`[tech-open-visit-nudge] skip ${tech.id}: not assignable`);
      skipped += 1;
      continue;
    }
    const message = buildMessage(visits, carryovers);
    let claimed;
    try {
      claimed = await claimToday(tech.id, etDate, message, nudgePayload(visits, withCarryover ? carryovers : null));
    } catch (err) {
      logger.error(`[tech-open-visit-nudge] claim failed for ${tech.id}: ${errTag(err)}`);
      skipped += 1;
      continue;
    }
    if (!claimed) {
      logger.info(`[tech-open-visit-nudge] skip ${tech.id}: already sent today`);
      skipped += 1;
      continue;
    }

    if (await deliverNudge(tech.id, etDate, now, withCarryover)) sent += 1;
    else skipped += 1;
  }

  const result = { status: 'ok', techs: groups.length, sent, skipped, visits: rows.length };
  if (withCarryover) result.carryover = carryRows.length;
  return result;
}

module.exports = {
  GATE,
  runTechOpenVisitNudge,
  isEnabled: enabled,
  _test: {
    findOpenVisitsToday,
    findCarryoverVisits,
    carryoverEnabled,
    dayLabel,
    groupByTechnician,
    customerLabel,
    clock12,
    visitLine,
    buildMessage,
    dedupeKeyFor,
    claimToday,
    releaseClaim,
    ownerCell,
    cardNudge,
    visitLines,
    smsNudge,
    deliverNudge,
  },
};
