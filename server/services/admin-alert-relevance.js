/**
 * Admin alert relevance — an unread admin bell clears itself when the visit,
 * series move or lead it is about has moved on (owner ruling 2026-09-28: "we
 * don't want garbage"; live with the ADMIN_ALERT_RELEVANCE kill switch, rule
 * 14: auto-applied, audit-trailed, no bell).
 *
 * Why this is a sweep and not another hook (AGENTS.md "extend the existing
 * mechanism"): the retire helpers that exist today — supersedeMissedCallAdmin,
 * markInboundSmsReadAdmin, first-application-sibling-split's clearStandingAlerts
 * — are per-class event hooks: each fires from the one code path its author
 * knew moves that subject on. Subjects move on through paths no hook sees (a
 * visit closed by a direct database edit, a lead quoted from another surface),
 * and every new alert class would need its own hook. This module judges the
 * LIVE record instead. It does not replace those hooks (their classes are
 * untouched); it only adds the classes below, judged by ONE periodic sweep,
 * runAdminAlertRelevanceSweep (scheduler.js, every 10 minutes):
 *   - It retires unread rows whose subject has moved on. Unread rows never
 *     age out of it (a refreshed bell keeps its first created_at). Each
 *     retirement is judged on a fresh read right before it is written, lands
 *     only on the version judged, and is judged once more after it; a change
 *     that landed in between, or a check after the write that could not
 *     finish, puts the bell back.
 *   - A retirement holds only while its rule does: each run first judges
 *     again what it retired in the last REARM_DAYS and puts back any row
 *     whose subject is relevant again (a booking cancelled, a visit
 *     reopened), since the emitters in the table never raise it again.
 *   - No row locks, ever: the sweep is advisory and must never block or fail
 *     a money path (invoice settlement takes the visit FOR UPDATE NOWAIT).
 * A bell is always rung as its emitter wrote it; the sweep clears it within
 * minutes once its subject has moved on.
 *
 * "Moved on" is judged from what the bell itself is about, never from the
 * customer's account: a stale visit by the bell's own predicate, a series-move
 * card by each item it flagged, and a new lead only by what happened AFTER the
 * bell was raised — the lead's current state can predate it (a website
 * submission attached to a lead already quoted or worked), so a status or an
 * earlier estimate is never read as the new bell handled.
 *
 * A retire is a PURE `read_at = now` plus `metadata.retired = {by, reason, at}`
 * — the row reads exactly like a human dismissal to anything else.
 *
 * The table holds only classes whose emitter never re-raises the same alert
 * on a stable dedupe key: a new lead (one intake event per submission), a
 * series-move card (written once per move), a stale-visit bell (its emitter
 * is gone). An alert
 * whose emitter re-raises a stable key — the first-application split, the
 * schedule watchdog's price / prepay / plan reviews, the estimate hot view —
 * is its emitter's to clear, with the emitter's own recurrence rules: a
 * retire from outside would either keep the key (and swallow the bell when
 * the subject comes back) or free it (and fight the emitter's dedupe).
 *
 * Never applies to customer-initiated contact bells (inbound_sms, inbound_email,
 * missed_call, voicemail_callback, review) or money-owed/failed/refund alerts:
 * a class is only in the table if its category (plus dedupeKey prefix) is
 * listed below.
 */

const db = require('../models/db');
const logger = require('./logger');
const { adminAlertRelevanceLive } = require('../config/feature-gates');
const { etDateString } = require('../utils/datetime-et');
const { VISIT_NEVER_RAN_STATUSES } = require('./invoice-helpers');

const RETIRED_BY = 'alert-relevance';
const PAGE_SIZE = 200;
const MAX_PAGES = 50;
// How long a retirement stays open to being put back: after this, final.
const REARM_DAYS = 14;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// A visit that has finished or will never run: no longer worth a bell that
// asks someone to complete, price or review it. 'rescheduled' stays open (a
// pending reschedule request parks the same row).
const CLOSED_VISIT_STATUSES = new Set([...VISIT_NEVER_RAN_STATUSES, 'completed']);
// The statuses the stale in-progress bell was raised for (the removed
// schedule-integrity-watchdog class's STALE_STATUSES).
const STALE_IN_PROGRESS_STATUSES = new Set(['on_site', 'en_route']);

const uuidOrNull = (v) => (typeof v === 'string' && UUID_RE.test(v.trim()) ? v.trim().toLowerCase() : null);
const arr = (v) => (Array.isArray(v) ? v : []);
const first = (...vals) => vals.find((v) => v != null && v !== '');

function parseMeta(metadata) {
  if (metadata && typeof metadata === 'object') return metadata;
  if (typeof metadata !== 'string') return {};
  try { const m = JSON.parse(metadata); return m && typeof m === 'object' ? m : {}; } catch { return {}; }
}

function linkParams(link) {
  try { return new URL(String(link || ''), 'http://relevance.local').searchParams; } catch { return new URLSearchParams(); }
}

// Every record an alert points at, from its metadata and deep link. Bad ids
// parse to null/dropped — never a throw.
function refsFromRow(row) {
  const meta = parseMeta(row.metadata);
  const payload = parseMeta(meta.payload);
  const params = linkParams(row.link);
  // The alert's own visit first, then every other visit it names: a series
  // move's windowless conflicts and preserved occurrences (each { id, date }).
  const visitIds = [first(meta.scheduledServiceId, meta.scheduled_service_id, params.get('appointment')),
    ...arr(meta.conflicts).map((c) => c?.id), ...arr(meta.preservedOccurrences).map((c) => c?.id)]
    .map(uuidOrNull).filter(Boolean);
  return {
    meta,
    visitId: visitIds[0] || null,
    visitIds: [...new Set(visitIds)],
    estimateId: uuidOrNull(first(meta.estimateId, meta.estimate_id, payload.estimateId, params.get('estimateId'))),
    leadId: uuidOrNull(first(payload.leadId, meta.leadId, params.get('lead'))),
  };
}

// Which live records this row is about, resolved against loaded maps (an id
// the maps do not hold resolves to undefined = the record is gone).
function resolveRefs(row, data) {
  const refs = refsFromRow(row);
  const visit = refs.visitId ? data.visits.get(refs.visitId) : undefined;
  const lead = refs.leadId ? data.leads.get(refs.leadId) : undefined;
  const estimateId = refs.estimateId || (lead?.estimate_id ? String(lead.estimate_id) : null);
  const estimate = estimateId ? data.estimates.get(estimateId) : undefined;
  return { refs, visit, lead, estimate };
}

const emptyData = () => ({ visits: new Map(), leads: new Map(), estimates: new Map(), leadVisits: new Map(), leadQuotes: new Map() });
const byId = (rows) => new Map(rows.map((r) => [String(r.id), r]));

// The live records for a batch of notification rows: one query per table per
// batch (a lead's estimate is only known once the lead is loaded, so estimates
// run second). Plain reads — never a lock.
async function loadSubjects(rows, conn = db) {
  const data = emptyData();
  const all = rows.map(refsFromRow);
  const ids = (pick) => [...new Set(all.flatMap(pick))];
  const visitIds = ids((r) => r.visitIds);
  const leadIds = ids((r) => (r.leadId ? [r.leadId] : []));
  if (visitIds.length) {
    // The service date as text: a DATE parsed to a JS Date lands at the
    // host's midnight, the previous ET day on a UTC host.
    data.visits = byId(await conn('scheduled_services as ss').whereIn('ss.id', visitIds)
      .select('ss.id', 'ss.customer_id', 'ss.status', 'ss.window_start', conn.raw("to_char(ss.scheduled_date, 'YYYY-MM-DD') as service_date")));
  }
  if (leadIds.length) {
    data.leads = byId(await conn('leads').whereIn('id', leadIds)
      .select('id', 'deleted_at', 'customer_id', 'estimate_id'));
  }
  const resolved = rows.map((row) => resolveRefs(row, data));
  const estimateIds = [...new Set(resolved.flatMap((r) => [r.refs.estimateId, r.lead?.estimate_id && String(r.lead.estimate_id)]).filter(Boolean))];
  const leadCustomerIds = [...new Set([...data.leads.values()].map((l) => l.customer_id && String(l.customer_id)).filter(Boolean))];
  if (estimateIds.length) {
    data.estimates = byId(await conn('estimates').whereIn('id', estimateIds).select('id', 'sent_at'));
  }
  if (leadCustomerIds.length) {
    // A booking someone made that is still to run or ran: never a child the
    // system generated on its own (the nightly series top-up, a booking's
    // seeded follow-ups — those land on an existing customer's plan whether
    // or not anyone worked the lead), and never one that did not run
    // (cancelled, no-show, skipped).
    const booked = await conn('scheduled_services').whereIn('customer_id', leadCustomerIds)
      .where((q) => q.whereNull('status').orWhereNotIn('status', VISIT_NEVER_RAN_STATUSES))
      .whereNull('recurring_parent_id').whereNull('parent_service_id')
      .groupBy('customer_id').select('customer_id').max('created_at as latest_created_at');
    data.leadVisits = new Map(booked.map((r) => [String(r.customer_id), r.latest_created_at]));
    // Every quote sent to the lead's customer, not only the one the lead
    // points at now: a newer draft can take over leads.estimate_id
    // (draft-builder's writeGuardedLeadEstimateLink) without un-sending it.
    const quotes = await conn('estimates').whereIn('customer_id', leadCustomerIds).whereNotNull('sent_at').select('customer_id', 'sent_at');
    for (const quote of quotes) {
      const key = String(quote.customer_id);
      const at = new Date(quote.sent_at);
      if (!Number.isNaN(at.getTime()) && !(data.leadQuotes.get(key) >= at)) data.leadQuotes.set(key, at);
    }
  }
  return data;
}

function subjectFor(row, data, todayET) {
  const resolved = resolveRefs(row, data);
  const bellAt = row.created_at ? new Date(row.created_at) : null;
  return {
    ...resolved,
    meta: resolved.refs.meta,
    todayET,
    // When the bell was raised: a new lead is judged only by what came after.
    bellAt: bellAt && !Number.isNaN(bellAt.getTime()) ? bellAt : null,
    // A visit the row names, by id; loaded ids only, so a miss is a visit gone.
    visitOf: (id) => data.visits.get(id),
    leadBookedAt: resolved.lead?.customer_id ? data.leadVisits.get(String(resolved.lead.customer_id)) : null,
    leadQuotedAt: resolved.lead?.customer_id ? data.leadQuotes.get(String(resolved.lead.customer_id)) : null,
  };
}

// The stale in-progress bell's own predicate, judged again: a visit from
// before today (ET) still on_site or en_route (the removed watchdog class's
// isStaleInProgress). Settled once that no longer holds — the visit is gone,
// has left those statuses (closed, or corrected back to pending, confirmed or
// rescheduled), or was moved to today or later. A bell naming no visit is
// never judged.
function staleVisitSettled(s) {
  if (!s.refs.visitId) return null;
  if (!s.visit) return 'Visit is gone';
  if (!STALE_IN_PROGRESS_STATUSES.has(String(s.visit.status))) return 'Visit is no longer in progress';
  const day = String(s.visit.service_date || '');
  return DATE_RE.test(day) && day < s.todayET ? null : 'Visit is no longer past its date';
}

// A series-move card's own work (admin-dispatch.js applySeriesMoveEffects):
// each windowless conflict needs a time, each preserved occurrence a cadence
// review, each overlap date a route check. The card is settled once every
// item is — a conflict given a time, closed or gone; a preserved occurrence
// closed or gone; any item whose day has passed (the visit's current date
// when it is loaded, else the date the card stored). A card that names no
// item is never judged. Not the moved visit itself (the card's subject, not
// its work), and never the customer's account: the card is written once per
// move (conflict_card_at).
function seriesMoveMovedOn(s) {
  const past = (day) => DATE_RE.test(day) && day < s.todayET;
  const visitItem = (item, settled) => {
    const id = uuidOrNull(item?.id);
    const visit = id ? s.visitOf(id) : undefined;
    if (id && !visit) return true;
    if (visit && settled(visit)) return true;
    return past(String(visit?.service_date || item?.date || '').slice(0, 10));
  };
  const closed = (v) => CLOSED_VISIT_STATUSES.has(String(v.status));
  const items = [
    ...arr(s.meta.conflicts).map((c) => visitItem(c, (v) => closed(v) || v.window_start != null)),
    ...arr(s.meta.preservedOccurrences).map((c) => visitItem(c, closed)),
    ...arr(s.meta.overlapDates).map((d) => past(String(d || '').slice(0, 10))),
  ];
  return items.length && items.every(Boolean) ? 'Everything it flagged is settled' : null;
}

// A new-lead bell is about the submission that raised it, so only what
// happened AFTER the bell counts: the lead deleted, a quote sent (the one it
// points at, or any to its customer), or a live visit booked for its customer. Timestamped facts only — a status
// carries no time, and the lead's state can predate the bell (a website
// submission attached to a lead already quoted or worked). Not converted_at:
// booking the lead stamps it and cancelling that visit never clears it, so
// the booking itself — while it is live — is the evidence.
function newLeadMovedOn(s) {
  const lead = s.lead;
  // A missing lead row is "unknown", never "gone": the emitter falls back to a
  // customer id when lead creation failed.
  if (!lead || !s.bellAt) return null;
  const after = (at) => !!at && new Date(at).getTime() > s.bellAt.getTime();
  if (after(lead.deleted_at)) return 'Lead was deleted';
  if (after(s.estimate?.sent_at) || after(s.leadQuotedAt)) return 'Estimate was sent';
  if (after(s.leadBookedAt)) return 'A visit was booked';
  return null;
}

// Alert classes: category (+ dedupeKey prefix, looked up in each emitter) → a
// rule returning null while the alert is still relevant, else a short reason.
const CLASSES = [
  { // emitter removed in #5223; unread rows remain. Only the visit itself settles it.
    key: 'stale_visit', categories: ['alert'], prefix: 'stale-visit:', rule: staleVisitSettled,
  },
  { // admin-dispatch.js applySeriesMoveEffects — one card per move
    key: 'series_move', categories: ['schedule_conflict'], match: (meta) => !!meta.seriesMoveId, rule: seriesMoveMovedOn,
  },
  { // notification-triggers.js new_lead — the intake bell, one event per
    // submission, no dedupe key. A direct notifyAdmin('new_lead') (a repeat
    // submission filed as a duplicate, an email follow-up's new draft) is
    // fresh work about a lead already on file, never judged.
    key: 'new_lead', categories: ['new_lead'], match: (meta, row) => meta.triggerKey === 'new_lead' && !!refsFromRow(row).leadId, rule: newLeadMovedOn,
  },
];

// The class a row belongs to, or null. Category first, then the emitter's
// dedupeKey prefix / extra metadata test.
function classify(row) {
  const meta = parseMeta(row.metadata);
  const dedupeKey = String(meta.dedupeKey || '');
  return CLASSES.find((c) => c.categories.includes(row.category)
    && (!c.prefix || dedupeKey.startsWith(c.prefix))
    && (!c.match || c.match(meta, row))) || null;
}

// Unread admin rows this sweep could judge: bell-visible, of a class in the
// table, of any age (a refreshed bell keeps its first created_at, so an age
// cut-off would hide a re-rung one for good). Keyset-paged on id: retiring a
// row removes it from the set, so an offset would skip rows.
function candidateQuery(cursor) {
  const { excludeActivityOnlyFromBell } = require('./notification-service')._private;
  return excludeActivityOnlyFromBell(db('notifications').where({ recipient_type: 'admin' }))
    .whereNull('read_at')
    .where((q) => {
      for (const c of CLASSES) {
        q.orWhere((cq) => {
          cq.whereIn('category', c.categories);
          if (c.prefix) cq.whereRaw("left(COALESCE(metadata->>'dedupeKey', ''), ?) = ?", [c.prefix.length, c.prefix]);
        });
      }
    })
    .modify((q) => { if (cursor) q.where('id', '>', cursor); })
    .orderBy('id', 'asc')
    .limit(PAGE_SIZE)
    .select('id', 'category', 'link', 'metadata', 'created_at');
}

// The row as the batch read it, still: a refresh that rewrote it since is
// left for the next sweep to judge.
const sameRow = (a, b) => a.category === b.category && (a.link || null) === (b.link || null)
  && JSON.stringify(parseMeta(a.metadata)) === JSON.stringify(parseMeta(b.metadata));

// The same predicate as a write condition: the retire lands only on the
// version it judged (category, link and metadata — everything the rule reads),
// never on a bell an emitter refreshed in between.
const sameVersion = (q, row) => q.where('category', row.category)
  .whereRaw('link IS NOT DISTINCT FROM ?', [row.link ?? null])
  .whereRaw('metadata IS NOT DISTINCT FROM ?::jsonb', [row.metadata == null ? null : JSON.stringify(parseMeta(row.metadata))]);

// The bell as it read before this module's stamp.
function unretired(metadata) {
  const { retired: _stamp, ...meta } = parseMeta(metadata);
  return meta;
}

// Judges one row on a fresh read and retires it only if it is still moved on
// and still the version judged, then judges it once more AFTER the write, on
// the bell as it stands then (a quiet refresh rewrites content without
// touching read_at): a change that landed between the read and the write (a
// visit reopened, a lead reopened) puts the bell back — unless a person has read it since (their read_at wins), or a
// refresh rang it again (the emitter's). A check after the write that fails
// is no verdict, so it puts the bell back too; a put-back that fails is
// judged again by the next run's re-arm pass (rearmRelevantAgain). No row
// locks: see the module header. A change after the final judgement is the
// re-arm pass's.
async function retireIfStillMovedOn(row, cls, todayET, now) {
  const current = await db('notifications').where({ id: row.id, recipient_type: 'admin' }).whereNull('read_at')
    .first('id', 'category', 'link', 'metadata', 'created_at');
  if (!current || !sameRow(current, row)) return null;
  const reason = cls.rule(subjectFor(current, await loadSubjects([current]), todayET));
  if (!reason) return null;
  // The stamp's `at` IS the read_at this write stores — an explicit
  // millisecond instant, not NOW() (Postgres keeps microseconds, which a JS
  // Date read back would truncate) — so every put-back, now or on a later
  // run, can require that this module's read is still the one on the row.
  const readAt = new Date(now.getTime());
  const stamp = { by: RETIRED_BY, reason, at: readAt.toISOString() };
  const [retired] = await sameVersion(db('notifications').where({ id: row.id, recipient_type: 'admin' }).whereNull('read_at'), current)
    .update({ read_at: readAt, metadata: db.raw("COALESCE(metadata, '{}'::jsonb) || ?::jsonb", [JSON.stringify({ retired: stamp })]) })
    .returning(['id']);
  if (!retired) return null;
  const stillOurs = (q) => q.where({ id: row.id, read_at: readAt }).whereRaw("metadata->'retired'->>'at' = ?", [stamp.at]);
  try {
    const latest = await stillOurs(db('notifications')).first('id', 'category', 'link', 'metadata', 'created_at');
    if (!latest) return null;
    const judged = { ...latest, metadata: unretired(latest.metadata) };
    if (cls.rule(subjectFor(judged, await loadSubjects([judged]), todayET))) return reason;
  } catch (err) {
    logger.warn(`[alert-relevance] notification ${row.id}: the check after retiring failed, putting it back: ${err.message}`);
  }
  await stillOurs(db('notifications')).update({ read_at: null, metadata: db.raw("metadata - 'retired'") });
  return null;
}

// Rows this module retired (read, stamped) in the last REARM_DAYS,
// keyset-paged on id.
function retiredQuery(cursor, since) {
  return db('notifications').where({ recipient_type: 'admin' })
    .whereRaw("metadata->'retired'->>'by' = ?", [RETIRED_BY])
    .whereRaw("metadata->'retired'->>'at' > ?", [since])
    .modify((q) => { if (cursor) q.where('id', '>', cursor); })
    .orderBy('id', 'asc')
    .limit(PAGE_SIZE)
    .select('id', 'category', 'link', 'metadata', 'read_at', 'created_at');
}

// Puts back one retired row whose subject is relevant again, unread, onto
// exactly the version read (category, link, metadata) and only while the
// row's read is still the one this module wrote (the stamp's `at`): a person
// who read the bell since keeps their read, on this run and every later one.
// Nothing is pushed.
function putBack(row) {
  const ourRead = new Date(parseMeta(row.metadata).retired?.at || NaN);
  if (Number.isNaN(ourRead.getTime())) return 0;
  return sameVersion(db('notifications').where({ id: row.id, recipient_type: 'admin' }), row)
    .where({ read_at: ourRead })
    .update({ read_at: null, metadata: db.raw("metadata - 'retired'") });
}

// The emitters in the table are one-shot: a booking cancelled or a visit or
// lead reopened raises nothing. So each run judges again what this module
// retired in the last REARM_DAYS, on the bell as it read before the stamp,
// and puts back any row whose rule no longer holds. Also the
// retry for a retire whose put-back failed. A retirement older than that is
// final: a subject that comes back weeks later is a new event, not this bell.
// Walked across runs like the retire pass (resumeAfter below): a run that
// stops at the page cap leaves where it stopped, so rows past it are reached
// by the next run instead of waiting behind the same first pages.
let rearmResumeAfter = null;

async function rearmRelevantAgain(now, todayET) {
  const since = new Date(now.getTime() - REARM_DAYS * 24 * 60 * 60 * 1000).toISOString();
  let rearmed = 0;
  let cursor = rearmResumeAfter;
  rearmResumeAfter = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const rows = await retiredQuery(cursor, since);
    if (!rows.length) break;
    cursor = rows[rows.length - 1].id;
    if (rows.length === PAGE_SIZE && page === MAX_PAGES - 1) rearmResumeAfter = cursor;
    const judged = rows.map((row) => ({ row, bell: { ...row, metadata: unretired(row.metadata) } }));
    const data = await loadSubjects(judged.map((j) => j.bell));
    for (const { row, bell } of judged) {
      try {
        const cls = classify(bell);
        if (!cls || cls.rule(subjectFor(bell, data, todayET))) continue;
        rearmed += await putBack(row);
      } catch (err) {
        logger.warn(`[alert-relevance] notification ${row.id} not re-armed: ${err.message}`);
      }
    }
    if (rows.length < PAGE_SIZE) break;
  }
  return rearmed;
}

// A backlog bigger than one run (MAX_PAGES pages) is walked across runs: a
// run that stops at the cap leaves where it stopped, and the next run
// resumes after it; a run that reaches the end leaves nothing, so the next
// one starts over. In-process: a restart simply starts over.
let resumeAfter = null;

async function runAdminAlertRelevanceSweep({ now = new Date() } = {}) {
  if (!adminAlertRelevanceLive()) return { skipped: true, reason: 'switch_off' };
  const todayET = etDateString(now);
  // First, so a row put back is judged again by the retire pass below.
  const rearmed = await rearmRelevantAgain(now, todayET);
  const byClass = {};
  let scanned = 0;
  let cursor = resumeAfter;
  resumeAfter = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const rows = await candidateQuery(cursor);
    if (!rows.length) break;
    cursor = rows[rows.length - 1].id;
    scanned += rows.length;
    if (rows.length === PAGE_SIZE && page === MAX_PAGES - 1) resumeAfter = cursor;
    const data = await loadSubjects(rows);
    for (const row of rows) {
      try {
        const cls = classify(row);
        // The batch read is a first pass: only a row that looks moved on pays
        // for the fresh recheck that actually retires it.
        if (!cls || !cls.rule(subjectFor(row, data, todayET))) continue;
        if (await retireIfStillMovedOn(row, cls, todayET, now)) byClass[cls.key] = (byClass[cls.key] || 0) + 1;
      } catch (err) {
        logger.warn(`[alert-relevance] notification ${row.id} skipped: ${err.message}`);
      }
    }
    if (rows.length < PAGE_SIZE) break;
  }
  const retired = Object.values(byClass).reduce((a, b) => a + b, 0);
  if (retired) logger.info(`[alert-relevance] retired ${retired} of ${scanned} unread alert(s): ${JSON.stringify(byClass)}`);
  if (rearmed) logger.info(`[alert-relevance] put back ${rearmed} alert(s) whose subject is relevant again`);
  return { skipped: false, scanned, retired, byClass, rearmed };
}

module.exports = {
  runAdminAlertRelevanceSweep,
  classify,
  loadSubjects,
  subjectFor,
  refsFromRow,
  CLASSES,
};
