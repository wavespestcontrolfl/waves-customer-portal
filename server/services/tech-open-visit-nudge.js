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
 * Recipient guard: sent through the raw Twilio `sendSMS` (not
 * sendCustomerMessage), so none of the customer consent / STOP / quiet-hours
 * rails apply — this is staff messaging, never a customer channel. It uses
 * messageType 'internal_alert' (twilio.js's `isInternalAdminAlertType`), the
 * same classification every other staff/admin alert SMS in the repo uses.
 * That type is normally reserved for the owner's own phone — sending it to
 * a hired tech's phone (never a known owner number) would otherwise be
 * blocked by the internal-alert recipient guard (twilio.js, "blocked
 * internal/admin alert to unknown recipient"), so this passes
 * `allowUnknownInternalAlertRecipient: true` — but ONLY once the recipient
 * has been read fresh off the technicians row and cleared by
 * technician-eligibility's isAssignable() + tech-line's usableCell(), i.e.
 * the verified phone of a currently active, field-dispatchable technician,
 * never an arbitrary caller-supplied number. The owner's technicians.phone is
 * the office line, so for a tech whose phone is a known owner number the text
 * goes to the owner's personal cell (ADAM_PHONE) instead (recipientFor). It
 * also passes `allowOwnerSms`: the owner is the only tech today, and an
 * owner-phone internal_alert is otherwise redirected into the admin bell
 * rather than texted. A tech marked out for today (technician_absences) is
 * skipped.
 */
const db = require('../models/db');
const logger = require('./logger');
const TwilioService = require('./twilio');
const { isAssignable, absentTechDays } = require('./technician-eligibility');
const { usableCell } = require('./tech-line');
const { etDateString, etParts } = require('../utils/datetime-et');
const { publicPortalUrl } = require('../utils/portal-url');

const GATE = 'GATE_TECH_OPEN_VISIT_NUDGE';
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

// Today's open visits with a technician assigned, joined to the technician
// and customer rows the message needs. Ordered by window so a tech's list
// reads chronologically and the "+N more" tail drops the latest stops. A
// visit whose window starts after the send time (an evening stop) hasn't
// happened yet, so it is left out; a visit with no window is kept.
async function findOpenVisitsToday(now) {
  const today = etDateString(now);
  const { hour, minute } = etParts(now);
  const nowHHMM = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  return db('scheduled_services as s')
    .join('technicians as t', 's.technician_id', 't.id')
    .leftJoin('customers as c', 's.customer_id', 'c.id')
    .where('s.scheduled_date', today)
    .whereIn('s.status', OPEN_STATUSES)
    .whereNotNull('s.technician_id')
    .where((q) => q.whereNull('s.window_start').orWhere('s.window_start', '<=', nowHHMM))
    .orderBy('s.window_start', 'asc')
    .select(
      's.id as visit_id',
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
    );
}

// Flat rows -> one entry per technician, in first-seen (= earliest window)
// order.
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
      });
      order.push(id);
    }
    byId.get(id).visits.push({
      id: row.visit_id,
      status: row.status,
      windowStart: row.window_start,
      serviceType: row.service_type,
      customerFirst: row.cust_first_name,
      customerLast: row.cust_last_name,
    });
  }
  return order.map((id) => byId.get(id));
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

function visitLine(visit) {
  const time = clock12(visit.windowStart) || '—';
  const line = `${time} · ${customerLabel(visit)} · ${visit.serviceType || 'Service'}`;
  return NOT_STARTED.has(visit.status) ? `${line} (not started)` : line;
}

// "Waves: 3 visits from today are still open. Tap to close out: <link>" then
// up to MAX_LISTED lines, then "+N more". One plain-text message, no
// signature (owner ruling: brand is just "Waves").
function buildMessage(visits) {
  const count = visits.length;
  const link = `${publicPortalUrl()}/tech`;
  const header = `Waves: ${count} visit${count === 1 ? '' : 's'} from today are still open. Tap to close out: ${link}`;
  const shown = visits.slice(0, MAX_LISTED);
  const lines = shown.map(visitLine);
  const overflow = count - shown.length;
  if (overflow > 0) lines.push(`+${overflow} more`);
  return [header, ...lines].join('\n');
}

function dedupeKeyFor(technicianId, etDate) {
  return `${NOTIFICATION_TYPE}:${technicianId}:${etDate}`;
}

// Where the text goes: the tech's own cell, or — for the owner, whose
// technicians.phone is the office line (tech-line.js usableCell note) — the
// owner's personal cell (ADAM_PHONE, the number owner alerts already use).
// Both pass usableCell, so a Waves line is never the recipient.
function recipientFor(tech) {
  const cell = usableCell(tech);
  if (cell) return cell;
  if (!tech.phone || !TwilioService.isKnownOwnerPhone(tech.phone)) return null;
  return usableCell({ id: tech.id, phone: process.env.ADAM_PHONE });
}

// True only when nothing reached the provider. 'uncertain' may already be
// on the handset and 'accepted' is sent; a result with no outcome is a local
// refusal (guard, not configured) and sent nothing.
function definitelyNotSent(deliveryOutcome) {
  return deliveryOutcome !== 'uncertain' && deliveryOutcome !== 'accepted';
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
    logger.warn(`[tech-open-visit-nudge] claim release failed for ${technicianId}: ${err.message}`);
  }
}

/**
 * Runs the whole sweep once: gate check, today's open visits grouped by
 * technician, eligibility + phone filtering, per-technician dedupe claim,
 * then one SMS per technician that claimed a slot. Never throws — a
 * per-technician send failure is logged and counted as skipped; the sweep
 * keeps going for the rest.
 */
async function runTechOpenVisitNudge({ now = new Date() } = {}) {
  if (!enabled()) return { status: 'gate_off' };

  const etDate = etDateString(now);
  const rows = await findOpenVisitsToday(now);
  const groups = groupByTechnician(rows);

  let sent = 0;
  let skipped = 0;
  // A tech marked out today keeps their stops until a dispatcher moves them
  // (tech-out.js) — never tell them to close visits they didn't run.
  const absent = groups.length
    ? await absentTechDays(db, { dateFrom: etDate, dateTo: etDate, technicianIds: groups.map((g) => g.tech.id) })
    : new Set();

  for (const { tech, visits } of groups) {
    if (!isAssignable(tech)) {
      logger.info(`[tech-open-visit-nudge] skip ${tech.id}: not assignable`);
      skipped += 1;
      continue;
    }
    if (absent.has(`${tech.id}:${etDate}`)) {
      logger.info(`[tech-open-visit-nudge] skip ${tech.id}: marked out today`);
      skipped += 1;
      continue;
    }
    const cell = recipientFor(tech);
    if (!cell) {
      logger.info(`[tech-open-visit-nudge] skip ${tech.id}: no usable phone`);
      skipped += 1;
      continue;
    }

    const message = buildMessage(visits);
    let claimed;
    try {
      claimed = await claimToday(tech.id, etDate, message, {
        visit_ids: visits.map((v) => v.id),
        count: visits.length,
      });
    } catch (err) {
      logger.error(`[tech-open-visit-nudge] claim failed for ${tech.id}: ${err.message}`);
      skipped += 1;
      continue;
    }
    if (!claimed) {
      logger.info(`[tech-open-visit-nudge] skip ${tech.id}: already sent today`);
      skipped += 1;
      continue;
    }

    try {
      const result = await TwilioService.sendSMS(cell, message, {
        messageType: 'internal_alert',
        // Cleared above: tech.id came off the assignable-technician row
        // this run just read, and `cell` is that SAME row's own usable
        // phone (or, for the owner, the configured ADAM_PHONE) — never a
        // caller-supplied or unverified number.
        allowUnknownInternalAlertRecipient: true,
        // The owner is today's only tech, so this phone IS a known owner
        // phone — without the opt-out, twilio.js redirects an owner-phone
        // internal_alert into the admin bell instead of texting it, and the
        // bell is exactly the channel this nudge exists to replace.
        // OWNER_SMS_DISABLED still silences it (checked separately).
        allowOwnerSms: true,
      });
      if (result && result.success === false) {
        // Nothing went out → give the day's slot back so a re-run can
        // retry. An uncertain outcome keeps it: the text may already be on
        // the phone, and a second copy is worse than a missed one.
        logger.warn(`[tech-open-visit-nudge] send failed for ${tech.id}: ${result.error || result.code || 'unknown'}`);
        if (definitelyNotSent(result.deliveryOutcome)) await releaseClaim(tech.id, etDate);
        skipped += 1;
      } else {
        sent += 1;
      }
    } catch (err) {
      // sendSMS throws a provider rejection with providerOutcome attached;
      // only an explicit not_sent is safe to retry — a bare throw keeps the
      // claim for the same reason an uncertain outcome does.
      logger.error(`[tech-open-visit-nudge] send threw for ${tech.id}: ${err.message}`);
      if (err?.providerOutcome?.deliveryOutcome === 'not_sent') await releaseClaim(tech.id, etDate);
      skipped += 1;
    }
  }

  return { status: 'ok', techs: groups.length, sent, skipped, visits: rows.length };
}

module.exports = {
  GATE,
  runTechOpenVisitNudge,
  isEnabled: enabled,
  _test: {
    findOpenVisitsToday,
    groupByTechnician,
    customerLabel,
    clock12,
    visitLine,
    buildMessage,
    dedupeKeyFor,
    claimToday,
    releaseClaim,
    recipientFor,
    definitelyNotSent,
  },
};
