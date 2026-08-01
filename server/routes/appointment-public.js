/**
 * Public appointment page routes — /api/public/appointment/:token.
 *
 * The single destination the 24-hour reminder and the booking-confirmation
 * texts link to (owner direction 2026-07-30: "less wordy text, more within
 * the link"). Those texts shrink to the essentials and this page carries
 * the rest: the 2-hour arrival window and what it means, a storm heads-up
 * when the forecast warrants one, who is coming, whether the visit is part
 * of a plan or a one-time treatment, an add-to-calendar file, and — for a
 * freshly booked visit — a one-tap Confirm.
 *
 * No auth. `scheduled_services.reschedule_token` (64-char hex) is the only
 * gate, exactly like /reschedule/:token — the same secret, deliberately
 * reused rather than minting a second one (see services/appointment-link.js).
 * Rate limits mirror the reschedule router; a bad/unknown token is a plain
 * 404 with no enumeration leak.
 *
 * GET  /:token               — appointment summary (see payload notes below).
 * GET  /:token/calendar.ics  — the same visit as a calendar file.
 * POST /:token/confirm       — marks a pending visit confirmed. The ONLY
 *   write here, and a deliberately tiny one: status pending -> confirmed
 *   plus a job_status_history row. It never touches date/window/tech and
 *   never sends anything — customer comms stay owner-driven, and a
 *   confirmation that texted the customer back would be noise.
 *
 * Dark until the owner flips GATE_APPOINTMENT_PAGE: every route 404s, so
 * the page is unreachable even by token until the templates that link it
 * are live. Kill switch = unset the var.
 */

const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const db = require('../models/db');
const logger = require('../services/logger');
const { noStore } = require('../middleware/no-store');
const { parseETDateTime, etDateString, addETDays } = require('../utils/datetime-et');
const { getDailyRainOutlookBounded } = require('../services/weather-forecast');
const { resolveTechPhotoUrl } = require('../services/tech-photo');
const { stampedDivergesSql } = require('../services/stamped-address');

// Token-keyed appointment data — never cacheable.
router.use(noStore);

const TOKEN_RE = /^[a-f0-9]{64}$/;

// The customer-quoted arrival window is ALWAYS window_start + 2 hours
// (owner rule; window_end is the internal job-duration block and never
// reaches a customer surface).
const ARRIVAL_PROMISE_MINUTES = 120;

// Day-level NWS chance at or above which the page shows the storm
// heads-up. Matches the "heavy" tier the booking rain chips already use —
// a 40% afternoon in SWFL is an ordinary summer day and warning about it
// would train customers to ignore the note.
const STORM_NOTE_MIN_CHANCE = 50;

// Forecast is decoration: the page renders without it rather than waiting.
// Bounded lookup shares one in-flight NWS call per coordinate and carries a
// failure cooldown, so a burst of reminder-link opens during an outage
// can't herd outbound requests.
const FORECAST_DEADLINE_MS = 1500;

// Statuses this page will render as a live upcoming visit. 'rescheduled'
// is deliberately NOT here: the customer-portal request path uses it as a
// pending-rebook marker that keeps the OLD date/window on the row while
// staff pick the replacement — presenting that stale slot as a live booked
// visit (or letting it into the calendar file) would show the customer a
// time nobody intends to honor.
const UPCOMING_STATUSES = new Set(['pending', 'confirmed']);

// Dispatch-owned pending bookings (call-created follow-ups / outbound-review
// rows) stay office-owned until reviewed — the customer must not be able to
// self-confirm them from this token page any more than from the logged-in
// portal. Shared invariant with routes/schedule.js.
const { DISPATCH_OWNED_PENDING_SOURCE_ACTIONS } = require('../services/call-booking-source-actions');

function gateOpen() {
  return process.env.GATE_APPOINTMENT_PAGE === 'true';
}

router.use((req, res, next) => {
  if (!gateOpen()) return res.status(404).json({ error: 'Not found' });
  return next();
});

router.use(rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again in a minute.' },
}));

const confirmLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please try again in a minute.' },
});

// technicians stores a single `name`; customer surfaces show first name
// only (same helper shape track-public uses).
function firstNameOf(fullName) {
  if (!fullName) return null;
  const trimmed = String(fullName).trim();
  return trimmed ? trimmed.split(/\s+/)[0] : null;
}

function apptDateStr(scheduledDate) {
  if (!scheduledDate) return null;
  return scheduledDate instanceof Date
    ? scheduledDate.toISOString().slice(0, 10)
    : String(scheduledDate).slice(0, 10);
}

function hhmm(t) {
  return t ? String(t).slice(0, 5) : null;
}

// Customer-safe state for the page. `upcoming` renders the full card;
// everything else renders a short explanatory card with contact options.
function pageState(svc, now = new Date()) {
  const status = String(svc.status || '').toLowerCase();
  if (status === 'completed') return { state: 'completed' };
  if (status === 'cancelled' || status === 'canceled') return { state: 'cancelled' };
  // Same page state, but the phase matters to the copy: "on the way" is
  // stale — and reads as wrong to someone looking at the tech in their
  // driveway — once the status is on_site.
  if (status === 'en_route' || status === 'on_site') return { state: 'in_progress', phase: status };
  // Pending rebook: staff are choosing the replacement slot; the date and
  // window still on the row are the OLD ones and must not render as booked.
  if (status === 'rescheduled') return { state: 'pending_rebook' };
  if (!UPCOMING_STATUSES.has(status)) return { state: 'not_available' };

  // Past the quoted arrival window with no terminal status = the visit came
  // and went; don't show a "your visit is tomorrow" card for it.
  const date = apptDateStr(svc.scheduled_date);
  const start = hhmm(svc.window_start);
  if (date) {
    const endsAt = start
      ? new Date(parseETDateTime(`${date}T${start}`).getTime() + ARRIVAL_PROMISE_MINUTES * 60000)
      : parseETDateTime(`${date}T23:59`);
    if (endsAt && endsAt < now) return { state: 'past' };
  }
  return { state: 'upcoming' };
}

// Pure verdict for a confirm whose guarded UPDATE matched zero rows. A row
// that is confirmed AND customer_confirmed was confirmed by a customer
// action — this route, the logged-in route, and self-booking all write the
// pair — so the lost race was a duplicate confirm and the customer's
// intent already succeeded. A row confirmed WITHOUT customer_confirmed
// came from a staff/system write (SmartRebooker stamps a rescheduled
// visit's NEW slot 'confirmed' without it), where the date/window likely
// changed under the customer — that must surface as CHANGED so the client
// reloads instead of showing the stale slot as confirmed.
function confirmRaceVerdict(row) {
  const confirmed = String(row?.status || '').toLowerCase() === 'confirmed';
  return confirmed && !!row?.customer_confirmed ? 'idempotent_success' : 'changed';
}

async function loadByToken(token) {
  return db('scheduled_services as s')
    .where('s.reschedule_token', token)
    .leftJoin('customers as c', 's.customer_id', 'c.id')
    .leftJoin('technicians as t', 's.technician_id', 't.id')
    .first(
      's.id', 's.customer_id', 's.technician_id', 's.status', 's.scheduled_date',
      's.window_start', 's.window_end', 's.service_type', 's.is_recurring',
      's.recurring_parent_id', 's.reschedule_token',
      's.source_action', 's.customer_confirmed',
      'c.first_name as cust_first_name',
      'c.deleted_at as customer_deleted_at',
      't.name as tech_name',
      't.photo_url as tech_photo_url',
      't.photo_s3_key as tech_photo_s3_key',
      db.raw(`COALESCE(s.lat, CASE WHEN NOT ${stampedDivergesSql('s', 'c')} THEN c.latitude END) as latitude`),
      db.raw(`COALESCE(s.lng, CASE WHEN NOT ${stampedDivergesSql('s', 'c')} THEN c.longitude END) as longitude`),
    );
}

// The customer-facing service label. registerAppointment persists a merged
// parent-plus-addons label ("Pest Control & Mosquito Control") into
// appointment_reminders.service_type, and the v2 texts use it — a page
// reached FROM those texts that names only the raw parent would silently
// drop scheduled work. Falls back to the raw column when no reminder row
// exists.
async function resolveServiceLabel(svc) {
  try {
    const rem = await db('appointment_reminders')
      .where({ scheduled_service_id: svc.id })
      .orderBy('created_at', 'desc')
      .first('service_type');
    return rem?.service_type || svc.service_type || 'service';
  } catch {
    return svc.service_type || 'service';
  }
}

// "The same technician as your last visit" — a trust line, so it must be
// true: compare against the customer's most recent COMPLETED visit, and
// only claim it when both sides actually carry a tech. Recurring-only (a
// one-time customer has no "last visit" to be the same as).
async function sameTechAsLastVisit(svc) {
  if (!svc.technician_id || !svc.is_recurring) return false;
  try {
    // Deterministic recency: two completed visits can share a
    // scheduled_date (split jobs, add-on same-day work) with different
    // techs, and date-only ordering leaves Postgres free to return either
    // row. Tie-break on the completion timestamp, then the visit window,
    // so "the same technician as your last visit" names the tech who was
    // actually there last.
    const last = await db('scheduled_services')
      .where({ customer_id: svc.customer_id, status: 'completed' })
      .whereNot('id', svc.id)
      .orderBy([
        { column: 'scheduled_date', order: 'desc' },
        // The visit's own time beats updated_at: notes and other edits
        // touch updated_at after completion (admin-dispatch note endpoint),
        // so a later EDIT must not make an earlier visit look like the
        // most recent one.
        { column: 'window_start', order: 'desc' },
        { column: 'updated_at', order: 'desc' },
      ])
      .first('technician_id');
    return !!last?.technician_id && String(last.technician_id) === String(svc.technician_id);
  } catch (err) {
    logger.warn(`[appointment-public] last-visit tech lookup failed for ${svc.id}: ${err.message}`);
    return false;
  }
}

// Storm heads-up for the visit's own day. Fail-open in every direction:
// no coordinates, slow NWS, or no coverage all render the page without it.
async function stormOutlook(svc) {
  try {
    const date = apptDateStr(svc.scheduled_date);
    if (!date) return null;
    const outlook = await getDailyRainOutlookBounded(svc.latitude, svc.longitude, {
      deadlineMs: FORECAST_DEADLINE_MS,
    });
    const chance = outlook?.[date]?.rainChance;
    if (chance == null || !Number.isFinite(Number(chance))) return null;
    return {
      rainChance: Math.round(Number(chance)),
      stormy: Number(chance) >= STORM_NOTE_MIN_CHANCE,
    };
  } catch (err) {
    logger.warn(`[appointment-public] forecast failed for ${svc.id}: ${err.message}`);
    return null;
  }
}

router.get('/:token', async (req, res, next) => {
  if (!TOKEN_RE.test(req.params.token || '')) {
    return res.status(404).json({ error: 'Not found' });
  }
  try {
    const svc = await loadByToken(req.params.token);
    if (!svc || svc.customer_deleted_at) return res.status(404).json({ error: 'Not found' });

    const { state, phase } = pageState(svc);
    const base = {
      state,
      // in_progress only: 'en_route' | 'on_site', so the page can say "on
      // the way" vs "at your property" truthfully.
      phase: phase || null,
      customerFirstName: svc.cust_first_name || null,
      service: { type: await resolveServiceLabel(svc) },
      appointment: {
        date: apptDateStr(svc.scheduled_date),
        windowStart: hhmm(svc.window_start),
      },
    };
    if (state !== 'upcoming') return res.json({ ...base, tech: null, plan: null, weather: null });

    // Decorations run together — neither blocks the other, and both are
    // individually fail-open.
    const [sameTech, weather, techPhotoUrl] = await Promise.all([
      sameTechAsLastVisit(svc),
      stormOutlook(svc),
      svc.technician_id
        ? resolveTechPhotoUrl(svc.tech_photo_s3_key, svc.tech_photo_url).catch(() => null)
        : Promise.resolve(null),
    ]);

    return res.json({
      ...base,
      // "Tomorrow" is an EASTERN calendar comparison — the visit date is an
      // ET wall-clock day, so deciding this on the client would mislabel it
      // for anyone whose device clock has already rolled over (late-evening
      // ET, or a customer travelling west).
      isTomorrow: base.appointment.date === etDateString(addETDays(new Date(), 1)),
      // status 'confirmed' is the existing schema value the dispatch board
      // already writes; the page just surfaces it.
      confirmed: String(svc.status).toLowerCase() === 'confirmed',
      // Drives the Confirm button. Mirrors the POST guard exactly: only a
      // plain 'pending' visit that is not dispatch-owned (call-created
      // follow-up / outbound-review awaiting office confirmation) may be
      // customer-confirmed, so the button never renders into a 409.
      confirmable: String(svc.status).toLowerCase() === 'pending'
        && !(DISPATCH_OWNED_PENDING_SOURCE_ACTIONS.includes(svc.source_action) && !svc.customer_confirmed),
      tech: svc.technician_id
        ? { firstName: firstNameOf(svc.tech_name), photoUrl: techPhotoUrl || null, sameAsLastVisit: sameTech }
        : null,
      plan: {
        // Booster extras carry recurring_parent_id but is_recurring=false —
        // they are one-time work against a plan, and the plan note would
        // over-promise for them.
        isRecurring: !!svc.is_recurring,
        collectiveAnchor: !!svc.is_recurring && process.env.GATE_COLLECTIVE_SERIES_ANCHOR === 'true',
      },
      weather,
      rescheduleToken: svc.reschedule_token,
    });
  } catch (err) {
    next(err);
  }
});

// ── calendar file ────────────────────────────────────────────────────────
// RFC 5545 text escaping: backslash, semicolon, comma, and newline.
function icsEscape(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

function icsStamp(date) {
  return `${date.toISOString().replace(/[-:]/g, '').split('.')[0]}Z`;
}

// Folds a content line to the 75-octet limit RFC 5545 requires; unfolded
// long lines are the classic reason an .ics silently fails to import.
function icsFold(line) {
  if (Buffer.byteLength(line, 'utf8') <= 75) return line;
  const out = [];
  let current = '';
  for (const ch of line) {
    const candidate = current + ch;
    // Continuation lines start with a space, so they carry 74 octets.
    const limit = out.length === 0 ? 75 : 74;
    if (Buffer.byteLength(candidate, 'utf8') > limit) {
      out.push(current);
      current = ch;
    } else {
      current = candidate;
    }
  }
  if (current) out.push(current);
  return out.join('\r\n ');
}

router.get('/:token/calendar.ics', async (req, res, next) => {
  if (!TOKEN_RE.test(req.params.token || '')) {
    return res.status(404).json({ error: 'Not found' });
  }
  try {
    const svc = await loadByToken(req.params.token);
    if (!svc || svc.customer_deleted_at) return res.status(404).json({ error: 'Not found' });
    const { state } = pageState(svc);
    if (state !== 'upcoming') return res.status(404).json({ error: 'Not found' });

    const date = apptDateStr(svc.scheduled_date);
    const start = hhmm(svc.window_start);
    if (!date || !start) return res.status(404).json({ error: 'Not found' });

    // ET wall-clock -> real instants, so the event lands correctly in any
    // device timezone. The event spans the customer-quoted 2-hour arrival
    // window, never the internal job block.
    const startAt = parseETDateTime(`${date}T${start}`);
    if (!startAt || Number.isNaN(startAt.getTime())) return res.status(404).json({ error: 'Not found' });
    const endAt = new Date(startAt.getTime() + ARRIVAL_PROMISE_MINUTES * 60000);

    const serviceLabel = await resolveServiceLabel(svc);
    const lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Waves Pest Control//Appointments//EN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      'BEGIN:VEVENT',
      // Stable per visit: re-downloading updates the same event instead of
      // stacking duplicates in the customer's calendar.
      `UID:visit-${svc.id}@wavespestcontrol.com`,
      `DTSTAMP:${icsStamp(new Date())}`,
      `DTSTART:${icsStamp(startAt)}`,
      `DTEND:${icsStamp(endAt)}`,
      `SUMMARY:${icsEscape(`Waves Pest Control - ${serviceLabel}`)}`,
      `DESCRIPTION:${icsEscape(
        `Your technician arrives any time inside this 2-hour window. On service day we'll text you a live tracking link. Questions? (941) 297-5749`
      )}`,
      'END:VEVENT',
      'END:VCALENDAR',
    ].map(icsFold);

    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="waves-appointment.ics"');
    return res.send(`${lines.join('\r\n')}\r\n`);
  } catch (err) {
    next(err);
  }
});

// ── confirm ──────────────────────────────────────────────────────────────
router.post('/:token/confirm', confirmLimiter, async (req, res, next) => {
  if (!TOKEN_RE.test(req.params.token || '')) {
    return res.status(404).json({ error: 'Not found' });
  }
  try {
    const svc = await loadByToken(req.params.token);
    if (!svc || svc.customer_deleted_at) return res.status(404).json({ error: 'Not found' });

    const { state } = pageState(svc);
    if (state !== 'upcoming') {
      return res.status(409).json({
        error: "This visit can't be confirmed online anymore.",
        code: 'NOT_CONFIRMABLE',
      });
    }
    // Idempotent: a second tap (or a double-submit) is a success — but only
    // when the CUSTOMER's confirm won. Same verdict as the post-update race
    // path: SmartRebooker can commit a reschedule between the page GET and
    // this POST, stamping the NEW slot 'confirmed' without
    // customer_confirmed; returning success there would mark the client's
    // stale date/window as confirmed instead of reloading the move.
    if (String(svc.status).toLowerCase() === 'confirmed') {
      if (confirmRaceVerdict(svc) === 'idempotent_success') {
        return res.json({ success: true, confirmed: true });
      }
      return res.status(409).json({
        error: 'This appointment just changed — please refresh.',
        code: 'CHANGED',
      });
    }

    // A call-created follow-up / outbound-review booking is dispatch-owned
    // until the office confirms it — the logged-in confirm route refuses
    // these (routes/schedule.js) and this token route must too, or the link
    // holder can flip a visit the office hasn't reviewed. Same invariant as
    // call-booking-source-actions.js; 409 (not 404) because the token IS
    // valid and the page stays viewable.
    if (DISPATCH_OWNED_PENDING_SOURCE_ACTIONS.includes(svc.source_action) && !svc.customer_confirmed) {
      return res.status(409).json({
        error: "Our office is finalizing this appointment's details — no confirmation needed yet.",
        code: 'NOT_CONFIRMABLE',
      });
    }

    // This route's documented write contract is pending -> confirmed ONLY.
    // Every other upcoming status (e.g. 'rescheduled', the pending-rebook
    // marker staff resolve) is not customer-confirmable here.
    if (String(svc.status).toLowerCase() !== 'pending') {
      return res.status(409).json({
        error: "This visit can't be confirmed online anymore.",
        code: 'NOT_CONFIRMABLE',
      });
    }

    // Status-only write, guarded on the status we read so a concurrent
    // dispatch change (cancel, en_route) is never overwritten. No date,
    // window, or tech is touched, and nothing is sent to the customer.
    // The status flip and its job_status_history row commit atomically —
    // the history table is the canonical transition audit, so a lost row
    // must fail the confirm rather than silently succeed without it.
    let updated = 0;
    await db.transaction(async (trx) => {
      updated = await trx('scheduled_services')
        .where({ id: svc.id, status: 'pending' })
        // customer_confirmed + confirmed_at ride along for parity with the
        // logged-in confirm route (routes/schedule.js) and self-booking
        // (routes/booking.js), which write the trio together: the portal's
        // "Confirm Visit" button keys on the flag, and /api/schedule
        // exposes confirmedAt — a token-page confirm must not leave a
        // hole in that record.
        .update({
          status: 'confirmed',
          customer_confirmed: true,
          confirmed_at: trx.fn.now(),
          updated_at: trx.fn.now(),
        });
      if (updated === 0) return;
      await trx('job_status_history').insert({
        job_id: svc.id,
        from_status: 'pending',
        to_status: 'confirmed',
        transitioned_by: null,
      });
    });
    if (updated === 0) {
      // Losing the guarded update is not automatically an error: two taps
      // racing both pass the early idempotency check, the first commits,
      // and the second matches zero rows. Re-read and distinguish WHO won
      // the race (confirmRaceVerdict): a duplicate customer confirm is the
      // documented double-submit success; anything else — including a
      // SmartRebooker reschedule that stamps 'confirmed' on a NEW slot —
      // must reload as CHANGED or the page shows the stale slot.
      const now = await db('scheduled_services').where({ id: svc.id }).first('status', 'customer_confirmed');
      if (confirmRaceVerdict(now) === 'idempotent_success') {
        return res.json({ success: true, confirmed: true });
      }
      return res.status(409).json({
        error: 'This appointment just changed — please refresh.',
        code: 'CHANGED',
      });
    }

    return res.json({ success: true, confirmed: true });
  } catch (err) {
    next(err);
  }
});

router._test = {
  pageState,
  confirmRaceVerdict,
  icsEscape,
  icsFold,
  icsStamp,
  STORM_NOTE_MIN_CHANCE,
  ARRIVAL_PROMISE_MINUTES,
};

module.exports = router;
