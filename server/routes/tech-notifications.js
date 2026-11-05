/**
 * Tech in-app notifications (polled by the tech PWA).
 * Cards: visit schedule changes, texts on a tech's own line, missing-tracking
 * notices, customer visit photos, open-visit nudges and storm-watch alerts.
 */
const express = require('express');
const router = express.Router();
const db = require('../models/db');
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
const { VISIT_CARD_TYPES, hiddenVisitCardSql, staleVisitCardSql, rankedVisitCards, refreshVisitCards } = require('../services/tech-visit-notifications');
const { etDateString, addETDays } = require('../utils/datetime-et');

router.use(adminAuthenticate, requireTechOrAdmin);

// GET /api/tech/notifications?unreadOnly=true
router.get('/', async (req, res, next) => {
  try {
    const unreadOnly = req.query.unreadOnly !== 'false';
    let q = db('tech_notifications')
      .where({ technician_id: req.technicianId })
      .whereNull('dismissed_at')
      // Storm-watch nudges are only actionable for a couple of hours
      // (sweep lookahead + service window). Without an age cutoff, unread
      // alerts from earlier days pile up into a wall of cards that buries
      // the tech home screen on the next load.
      .where(function stormFreshness() {
        this.whereNot({ type: 'storm_watch_alert' })
          .orWhereRaw("created_at >= now() - interval '6 hours'");
      })
      // The geofence notice types are retired (no card renders them): an old
      // unread row must not take a slot under the feed limit.
      .whereRaw("type NOT LIKE 'geofence\\_%'");
    // GATE_NOSHOW_DETECTOR is the feature's kill switch, and turning it off
    // stops the sweep — which is the only thing that dismisses a tracking
    // notice when its visit completes, moves or is reassigned. Undismissed
    // rows would otherwise keep showing (and, since round 8, leading the
    // window) with no reconciliation behind them, so a disabled feature
    // would leave stale cards on techs' phones indefinitely (codex P1, PR
    // #4403 round 9). Read at request time, like every other gate here: a
    // flip needs no redeploy, and re-enabling hands the rows straight back
    // to the sweep, which reconciles them on its next tick.
    if (!require('../config/feature-gates').gateEnvValue('GATE_NOSHOW_DETECTOR')) {
      q = q.whereNot({ type: 'follow_through_tracking' });
    }
    // Photo cards point at the Visit Brief's customer photos, which 404
    // while either visit-prep gate is off: hide them at request time the
    // same way (Codex #5303 r2). Re-enabling brings undismissed ones back.
    const photoAlerts = require('../services/visit-prep-tech-alert');
    if (!photoAlerts.isEnabled()) {
      q = q.whereNot({ type: 'customer_visit_photos' });
    } else {
      // A photo card shows only while its visit is still this tech's and
      // still on the route (reassigned / rescheduled / cancelled → hidden).
      q = photoAlerts.scopePhotoCardsToLiveVisits(q, db);
    }
    // A schedule-change card shows only while it says something true about
    // its visit, by the same rules as the Today page's own read (below), so
    // the "notices on Today" count and the floating fallback agree with it.
    const hidden = hiddenVisitCardSql('tech_notifications', etDateString(new Date()));
    q = q.whereRaw(`NOT ${hidden.sql}`, hidden.bindings);
    if (unreadOnly) q = q.where({ read: false });
    // FRESH non-storm rows outrank everything else inside the 20-row window,
    // so a storm burst never crowds them out. The priority is
    // freshness-scoped, though: a stale backlog of 20 or more unread
    // non-storm rows must not displace a live storm warning, so aged rows
    // compete with storms purely on recency.
    // Visit notices (visit_* — tech-visit-notifications.js) never expire and
    // a bulk assign can mint dozens at once, so they must not push a fresh
    // storm warning (bucket 3) past the limit — the client shows two at a time
    // and promotes the rest as they clear. They share the LAST bucket with
    // stale rows and compete there on recency: a backlog of 20 or more stale
    // legacy rows (e.g. the old `new_appointment` type the client never
    // rendered) must not starve every schedule-change card out of the window
    // either. Texts on a tech's own line (tech_line_sms — tech-line.js) are
    // kept the same way and sit in the same bucket, as does a customer's
    // visit-prep photo submission (customer_visit_photos —
    // visit-prep-tech-alert.js): also persistent, also fine to share the
    // never-expiring bucket rather than starve out an older un-dismissed one
    // for the sake of a fresher storm or routine card.
    // Missing-tracking notices (follow_through_tracking — no-show-detector.js)
    // are their OWN bucket 0, regardless of age: they are undismissed only
    // while the visit is still overdue with no arrival evidence (the sweep's
    // reconcile pass dismisses them the moment that stops being true), and
    // the generic recency rule dropped one past six hours into the routine
    // kept-card bucket — so a tech who was offline while a stage-2 notice
    // aged, then collected 20 newer assignment or text cards, never received
    // the row at all and the client's own MAX_VISIT_CARDS ranking could not
    // rescue what the server never returned (codex P2 round 8). Its OWN
    // bucket, ahead of every other fresh row (codex P2 round 17).
    const rows = await q
      .orderByRaw("CASE WHEN type = 'follow_through_tracking' THEN 0 WHEN type LIKE 'visit\\_%' OR type IN ('tech_line_sms', 'customer_visit_photos') THEN 4 WHEN type = 'storm_watch_alert' THEN 3 WHEN created_at >= now() - interval '6 hours' THEN 2 ELSE 4 END")
      // Stage 2 before stage 1 INSIDE the tracking bucket, before the limit
      // truncates: a tech with more than 20 undismissed tracking cards would
      // otherwise lose an older critical arrival check behind 20 newer
      // stage-1 warnings, and the client's own stage-2-first sort cannot
      // rescue a row the window never returned (codex P2, PR #4403 round 20).
      .orderByRaw("CASE WHEN type = 'follow_through_tracking' THEN COALESCE((payload->>'stage')::int, 0) ELSE 0 END DESC")
      .orderBy('created_at', 'desc')
      .limit(20);
    let parsed = await refreshVisitCards(rows.map(parseRow), db);
    if (photoAlerts.isEnabled()) parsed = await photoAlerts.refreshPhotoCardDates(parsed, db);
    res.json({ notifications: parsed });
  } catch (err) { next(err); }
});

// Schedule-change cards (tech-visit-notifications.js) for the Today page,
// which shows every open one: a change that touches today or tomorrow as its
// own card (`soon`), the rest folded into one summary (owner ruling
// 2026-10-03). The main feed above returns 20 rows, too few for a nightly
// auto-dispatch run, so these have their own read.
const SCHEDULE_CHANGE_TYPES = VISIT_CARD_TYPES;
// Rows per list (soon cards, folded rows); the summary's count and "clear
// all" cover the whole open set, past this cap (Codex #5783 P2).
const SCHEDULE_CHANGE_LIMIT = 300;
const UUID_PATTERN = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
const UUID_RE = new RegExp(UUID_PATTERN, 'i');

// The open schedule-change cards for one tech that still say something true
// about their visit: one card per visit (rankedVisitCards), none for a past
// day or a visit the tech already reached (staleVisitCardSql). The visit row
// is joined on its uuid primary key (the payload id is pattern-checked before
// the cast, so a malformed one joins nothing instead of failing the read).
// `asOf` is the read the tech sees: its ET day judges "past".
function openScheduleChanges(technicianId, asOf) {
  const stale = staleVisitCardSql('n', etDateString(asOf));
  return db.from(rankedVisitCards(db, technicianId, soonDays(asOf)).as('n'))
    .leftJoin('scheduled_services as s', function joinVisit() {
      this.on('s.id', '=', db.raw(`CASE WHEN n.payload->>'visit_id' ~* '${UUID_PATTERN}' THEN (n.payload->>'visit_id')::uuid END`));
    })
    .where('n.visit_rank', 1)
    .whereRaw(`NOT ${stale.sql}`, stale.bindings);
}

// Today and tomorrow (ET) as of a read.
function soonDays(asOf) {
  return [etDateString(asOf), etDateString(addETDays(asOf, 1))];
}

// `soon` in SQL, over openScheduleChanges: any open card of the visit has a
// new or previous day of today or tomorrow (ET) as of `asOf`
// (`visit_touches_soon`, so a newer card never hides an older card's move off
// or onto today), or the visit's day as it is now is today or tomorrow (a
// visit moved there with no card of its own surfaces through its older card).
// Clear-all passes the read's own as_of, so an ET midnight between the read
// and the tap never clears a card the tech saw as its own today/tomorrow card
// (pre-push audit P1).
function soonSql(asOf) {
  return {
    // The visit's day as it is now counts only while it is this tech's: a
    // former holder reads nothing of a reassigned visit's new schedule.
    sql: "COALESCE(n.visit_touches_soon OR (s.technician_id = n.technician_id AND to_char(s.scheduled_date, 'YYYY-MM-DD') IN (?, ?)), false)",
    bindings: soonDays(asOf),
  };
}

// GET /schedule-changes — the soon cards and the folded (non-soon) rows are
// read separately, each up to the cap, so a pile of soon cards can never
// crowd the folded rows out of the response (Codex #5786 P2); `later_total`
// counts every open folded card. All reads stop at `as_of`, the same bound a
// following clear-all uses, so a card written mid-read is neither shown nor
// cleared — the next read shows it.
router.get('/schedule-changes', async (req, res, next) => {
  try {
    const asOf = new Date();
    const soon = soonSql(asOf);
    const columns = ['n.id', 'n.type', 'n.message', 'n.payload', 'n.created_at', 'n.technician_id', 'n.visit_soon_when'];
    const [soonRows, laterRows, totals] = await Promise.all([
      openScheduleChanges(req.technicianId, asOf)
        .where('n.created_at', '<=', asOf)
        .whereRaw(soon.sql, soon.bindings)
        // In visit order, so today's stops lead tomorrow's (this tech's
        // visits only; one now on another route goes last).
        .orderByRaw('CASE WHEN s.technician_id = n.technician_id THEN s.scheduled_date END ASC NULLS LAST, CASE WHEN s.technician_id = n.technician_id THEN s.window_start END ASC NULLS LAST')
        .orderBy('n.created_at', 'desc')
        .limit(SCHEDULE_CHANGE_LIMIT)
        .select(columns),
      openScheduleChanges(req.technicianId, asOf)
        .where('n.created_at', '<=', asOf)
        .whereRaw(`NOT ${soon.sql}`, soon.bindings)
        .orderBy('n.created_at', 'desc')
        .limit(SCHEDULE_CHANGE_LIMIT)
        .select(columns),
      openScheduleChanges(req.technicianId, asOf)
        .where('n.created_at', '<=', asOf)
        .whereRaw(`NOT ${soon.sql}`, soon.bindings)
        .count('* as n'),
    ]);
    const changes = await refreshVisitCards([
      ...soonRows.map((row) => ({ ...parseRow(row), soon: true })),
      ...laterRows.map((row) => ({ ...parseRow(row), soon: false })),
    ], db);
    res.json({ changes, later_total: Number(totals[0]?.n) || 0, as_of: asOf.toISOString() });
  } catch (err) { next(err); }
});

// POST /dismiss-batch { as_of, keep_ids } — "Got it, clear all" on the
// summary card: every open NON-soon schedule-change card of this tech written
// by `as_of` (the read the tech was looking at), with the older cards of the
// same visits that the read folded under them, so none of those comes back
// as the visit's card. Soon cards keep their own Got it: `keep_ids` are the
// soon cards that read showed, kept even when a move since has taken their
// visit off today and tomorrow (soon also reads the visit's day now).
router.post('/dismiss-batch', async (req, res, next) => {
  try {
    // A non-empty timestamp string only: new Date(null) is a valid 1970
    // instant that would clear nothing yet report success (Codex #5783 P2).
    const raw = req.body?.as_of;
    const asOf = typeof raw === 'string' && raw.trim() ? new Date(raw) : null;
    if (!asOf || Number.isNaN(asOf.getTime())) return res.status(400).json({ error: 'as_of is required' });
    const keepIds = Array.isArray(req.body?.keep_ids)
      ? req.body.keep_ids.filter((id) => typeof id === 'string' && UUID_RE.test(id)).slice(0, SCHEDULE_CHANGE_LIMIT)
      : [];
    const soon = soonSql(asOf);
    const shown = () => openScheduleChanges(req.technicianId, asOf)
      .where('n.created_at', '<=', asOf)
      .whereRaw(`NOT ${soon.sql}`, soon.bindings)
      .whereNotIn('n.id', keepIds);
    const dismissed = await db('tech_notifications')
      .where('technician_id', req.technicianId)
      .whereIn('type', SCHEDULE_CHANGE_TYPES)
      .where('created_at', '<=', asOf)
      .whereNull('dismissed_at')
      .where(function shownOrFolded() {
        this.whereIn('id', shown().select('n.id'))
          .orWhereIn(db.raw("payload->>'visit_id'"), shown().select(db.raw("n.payload->>'visit_id'")));
      })
      .update({ read: true, dismissed_at: new Date(), updated_at: new Date() });
    res.json({ success: true, dismissed });
  } catch (err) { next(err); }
});

// POST /:id/read — mark read (tech saw it)
router.post('/:id/read', async (req, res, next) => {
  try {
    await db('tech_notifications')
      .where({ id: req.params.id, technician_id: req.technicianId })
      .update({ read: true, updated_at: new Date() });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// POST /:id/dismiss — tech tapped Got it or close
router.post('/:id/dismiss', async (req, res, next) => {
  try {
    const row = await db('tech_notifications')
      .where({ id: req.params.id, technician_id: req.technicianId })
      .first();
    if (!row) return res.status(404).json({ error: 'Notification not found' });

    await db('tech_notifications')
      .where({ id: row.id })
      // A tech's own dismissal CLEARS any automatic supersession stamp the
      // sweep may have written in the meantime: the sweep reads that stamp as
      // "this card was retired by the system, so an identical one may be
      // raised again", and leaving it would let the next cycle resurrect a
      // card the tech had already cleared — and push it again (codex P2, PR
      // #4403 round 24).
      .update({ read: true, dismissed_at: new Date(), updated_at: new Date(),
        payload: db.raw("COALESCE(payload, '{}'::jsonb) - 'superseded_at'") });
    // A schedule-change card speaks for its visit's older open cards (the
    // feeds show one per visit): Got it clears those too, or the next older
    // one would take its place.
    const visitId = parsePayload(row.payload).visit_id;
    if (SCHEDULE_CHANGE_TYPES.includes(row.type) && visitId) {
      await db('tech_notifications')
        .where('technician_id', req.technicianId)
        .whereIn('type', SCHEDULE_CHANGE_TYPES)
        .whereNull('dismissed_at')
        .whereRaw("payload->>'visit_id' = ?", [String(visitId)])
        .where('created_at', '<=', row.created_at)
        .update({ read: true, dismissed_at: new Date(), updated_at: new Date() });
    }

    res.json({ success: true });
  } catch (err) { next(err); }
});

function parsePayload(v) {
  if (!v) return {};
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch { return {}; }
}

function parseRow(r) {
  return { ...r, payload: parsePayload(r.payload) };
}

module.exports = router;
