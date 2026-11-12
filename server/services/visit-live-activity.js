/**
 * Visit day on the Lock Screen: the card's rules, and how a card starts
 * (GATE_VISIT_LIVE_ACTIVITY, owner 2026-11-11, "do this first Visit day on the Lock Screen").
 *
 * The card is a picture of the visit, not a message queue. Whatever looks at a visit decides from these
 * rules what its card must show now, so a lost signal only delays the card: the next look repairs it.
 *
 * A STOP is the customer, the saved address, the ET day and the technician: the rule the on-the-way text
 * already uses (one-text-per-day.js), so two services at one address on one day share one card. A visit with
 * no saved address is its own stop.
 *
 * A card starts when the technician goes on the way (or arrives): one Apple broadcast channel for the stop,
 * and one start push to each of the customer's iPhones that registered for the card (routes/push.js). It adds
 * to today's notices and changes none of them.
 *
 * No lock and no connection is held across a call to Apple. A start is claimed by inserting the stop's one
 * live row (live_activity_sessions, see its migration), so two passes can never start two cards for one stop.
 *
 * syncVisit is the one way in, and nothing calls it yet. The Apple transport, the push device scope and the
 * label builders load on first use.
 */
const db = require('../models/db');
const logger = require('./logger');
const gates = require('../config/feature-gates');

const MINUTE = 60 * 1000;
// A card starts only within this long of the step it starts in. Later, the news is old.
const START_WINDOW_MS = 20 * MINUTE;
// Apple drops a start push it could not deliver by then.
const START_PUSH_TTL_MS = 20 * MINUTE;
// Production, 90 days to 2026-11-11 (432 completed visits): on the way p99 28 min, longest 54 min; on the
// property p95 96 min, 3% over 2 hours, 2% over 3 hours (mostly visits closed out late).
// After STALE the card reads as out of date; after END the server takes it off the Lock Screen.
const STALE_AFTER_MS = { en_route: 45 * MINUTE, on_property: 120 * MINUTE };
const END_AFTER_MS = { en_route: 90 * MINUTE, on_property: 180 * MINUTE };
// "Service complete" stays on the Lock Screen this long.
const COMPLETE_SHOWN_MS = 15 * MINUTE;
// A card that listens on a channel needs iOS 18.
const MIN_IOS_MAJOR = 18;
const MAX_DEVICES = 5;
const LIVE_STATES = ['en_route', 'on_property'];
const STEP = { en_route: 1, on_property: 2, complete: 3 };
const VISIT_COLUMNS = ['id', 'customer_id', 'property_id', 'technician_id', 'status', 'track_state',
  'en_route_at', 'arrived_at', 'completed_at', 'service_type', 'window_start'];

function gateLive() {
  return typeof gates.visitLiveActivityLive === 'function' && gates.visitLiveActivityLive() === true;
}

// VISIT_LIVE_ACTIVITY_CUSTOMER_ALLOWLIST only ever narrows the gate (the first production test).
function customerAllowed(customerId) {
  const allow = typeof gates.visitLiveActivityAllowlist === 'function' ? gates.visitLiveActivityAllowlist() : null;
  return !allow || allow.has(String(customerId).toLowerCase());
}

function epochSeconds(value) {
  return Math.floor(new Date(value).getTime() / 1000);
}

function clip(text, max) {
  const value = String(text || '').trim();
  return value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value;
}

function times(visits, column) {
  return visits.map((v) => (v[column] ? new Date(v[column]).getTime() : NaN)).filter(Number.isFinite);
}

function earliest(visits, column) {
  const all = times(visits, column);
  return all.length ? new Date(Math.min(...all)) : null;
}

function latest(visits, column) {
  const all = times(visits, column);
  return all.length ? new Date(Math.max(...all)) : null;
}

// The customer-facing tracker state: the ONE derivation (track-transitions.js), required on use.
function trackState(visit) {
  return require('./track-transitions').customerTrackState(visit);
}

// ---- The stop ---------------------------------------------------------------

function selectVisits() {
  return db('scheduled_services').select(...VISIT_COLUMNS, db.raw("to_char(scheduled_date, 'YYYY-MM-DD') as day"));
}

/** Pure: the stop a visit belongs to. `visit.day` is its ET calendar day (YYYY-MM-DD). */
function stopOf(visit) {
  const stop = {
    customerId: visit.customer_id,
    propertyId: visit.property_id || null,
    technicianId: visit.technician_id || null,
    day: visit.day,
    serviceId: visit.id,
  };
  stop.key = stop.propertyId
    ? `stop:${stop.customerId}:${stop.propertyId}:${stop.day}:${stop.technicianId || 'none'}`
    : `visit:${visit.id}`;
  return stop;
}

async function loadStopVisits(stop) {
  if (!stop.propertyId) return selectVisits().where({ id: stop.serviceId });
  return selectVisits()
    .where({ customer_id: stop.customerId, property_id: stop.propertyId, scheduled_date: stop.day })
    .where(function sameTechnician() {
      if (stop.technicianId) this.where('technician_id', stop.technicianId);
      else this.whereNull('technician_id');
    })
    .orderBy('window_start', 'asc')
    .orderBy('id', 'asc');
}

function liveSession(stopKey) {
  return db('live_activity_sessions').where({ stop_key: stopKey }).whereNull('ended_at').first();
}

// ---- What the stop shows -----------------------------------------------------

/**
 * Pure: what a stop shows now, or null when no visit of it is live.
 *   { phase: 'en_route' | 'on_property' | 'complete', visits, since }
 * `memberIds` are the visits a card already showed. A finished visit counts only when it is one of them, so a
 * morning visit that is long finished never makes an afternoon visit at the same address read as arrived.
 * One visit finished while another is still open reads as "arrived": the technician is at the address.
 */
function viewOf(visits, memberIds = []) {
  const members = new Set((memberIds || []).map(String));
  const live = visits.filter((v) => LIVE_STATES.includes(trackState(v)));
  const done = visits.filter((v) => trackState(v) === 'complete' && members.has(String(v.id)));
  if (!live.length) {
    return done.length ? { phase: 'complete', visits: done, since: latest(done, 'completed_at') } : null;
  }
  const shown = visits.filter((v) => live.includes(v) || done.includes(v));
  if (done.length || live.some((v) => trackState(v) === 'on_property')) {
    return { phase: 'on_property', visits: shown, since: earliest(shown, 'arrived_at') };
  }
  return { phase: 'en_route', visits: shown, since: earliest(live, 'en_route_at') };
}

/**
 * Pure: what to do with a live card (`session` is its live_activity_sessions row).
 *   { kind: 'show', since, staleAt }      keep it current
 *   { kind: 'end', reason, dismissAt }    end it; dismissAt is when it leaves the Lock Screen
 */
function targetOf(view, session, now, { live = true, allowed = true } = {}) {
  const endNow = (reason) => ({ kind: 'end', reason, dismissAt: now });
  if (!live) return endNow('gate_off');
  if (!allowed) return endNow('not_on_the_list');
  if (!view) return endNow('visit_not_live');
  if (view.phase === 'complete') {
    return { kind: 'end', reason: 'complete', dismissAt: new Date(now.getTime() + COMPLETE_SHOWN_MS) };
  }
  // A step with no time of its own keeps the time the card already holds for that step.
  const since = new Date(view.since
    || (session.phase === view.phase && session.phase_since)
    || session.started_at || session.created_at);
  if (now.getTime() - since.getTime() >= END_AFTER_MS[view.phase]) return endNow('time_limit');
  return { kind: 'show', since, staleAt: new Date(since.getTime() + STALE_AFTER_MS[view.phase]) };
}

/** Pure: why a card may not start for this view (null = it may). The cheap checks; the reads come after. */
function startRefusal(stop, view, now) {
  if (!view || !LIVE_STATES.includes(view.phase)) return 'visit_not_live';
  if (!view.since) return 'no_step_time';
  if (now.getTime() - view.since.getTime() > START_WINDOW_MS) return 'too_late';
  if (!customerAllowed(stop.customerId)) return 'not_on_the_list';
  return null;
}

// The words mirror today's notices: the technician as the texts name them, and the service label the
// reminder and arrival texts use.
async function stateOf(view) {
  let title = 'Service complete';
  if (view.phase !== 'complete') {
    const technicianId = view.visits[0].technician_id;
    const tech = technicianId ? await db('technicians').where({ id: technicianId }).first('name') : null;
    const { formatTechnicianForCustomer } = require('../utils/technician-name');
    const name = formatTechnicianForCustomer({ name: tech?.name || 'Your Waves technician' });
    title = `${name} ${view.phase === 'on_property' ? 'has arrived' : 'is on the way'}`;
  }
  const { buildServiceLabel } = require('./appointment-reminders');
  const labels = [];
  for (const visit of view.visits) labels.push(await buildServiceLabel(visit.id, visit.service_type));
  const detail = require('./one-text-per-day').joinLabels(labels) || 'Your Waves service';
  return { phase: view.phase, title: clip(title, 80), detail: clip(detail, 120), step: STEP[view.phase] };
}

function memberUnion(session, view) {
  const ids = new Set((session?.member_ids || []).map(String));
  for (const visit of view?.visits || []) ids.add(String(visit.id));
  return [...ids].sort();
}

function signature(state, members) {
  return ['show', state.phase, state.title, state.detail, members.join(',')].join('|');
}

// ---- Who gets a card ---------------------------------------------------------

// The account holder's own iPhones that registered for the card, inside the device scope every customer
// push uses. The customer's "app notifications off" choice turns the card off too.
async function cardDevices(customerId) {
  const context = await require('./push-notifications').customerPushContext(customerId);
  if (!context || !context.enabled) return [];
  return db('push_subscriptions')
    .whereIn('customer_id', context.ids)
    .where({ platform: 'ios', role: 'customer', active: true })
    .whereNull('contact_phone_key')
    .whereNotNull('live_activity_start_token')
    .where('live_activity_os_major', '>=', MIN_IOS_MAJOR)
    .orderBy('updated_at', 'desc')
    .limit(MAX_DEVICES)
    .select('id', 'live_activity_start_token');
}

// The customer's own "technician on the way" choice decides the card too: no on-the-way notice, no card.
// A visit at a saved address other than the primary one follows that address's choice where those are
// enforced (property-notification-prefs.js). Read only: no decision row is written from here.
async function onTheWayNoticeOn(customerId, serviceId) {
  const prefs = await db('notification_prefs').where({ customer_id: customerId }).first();
  const propertyPrefs = require('./property-notification-prefs');
  if (!propertyPrefs.propertyTextsEnforced()) return Boolean(prefs?.tech_en_route);
  const property = await propertyPrefs.visitProperty(customerId, serviceId);
  if (!property) return Boolean(prefs?.tech_en_route);
  const row = await propertyPrefs.propertyPrefsRow(property.id);
  return Boolean(propertyPrefs.overlayPropertyPrefs(property, row, prefs).tech_en_route);
}

// One chance per step: a stop whose card already ended at or after this step began gets no second card
// for it. A visit rewound and sent out again has a later step time, so it gets a new one.
async function hadCardSince(stopKey, since) {
  const row = await db('live_activity_sessions').where({ stop_key: stopKey }).where('ended_at', '>=', since).first('id');
  return Boolean(row);
}

// ---- Start -------------------------------------------------------------------

async function closeSession(id, reason, now, { channelGone = false } = {}) {
  await db('live_activity_sessions').where({ id }).whereNull('ended_at').update({
    ended_at: now,
    end_reason: String(reason).slice(0, 120),
    ...(channelGone ? { channel_deleted_at: now } : {}),
    updated_at: now,
  });
}

// Apple says a start token is dead (410): this phone gets no card until its app reports a new one.
async function clearDeadTokens(devices, results) {
  for (let i = 0; i < devices.length; i += 1) {
    if (!results[i].expired) continue;
    await db('push_subscriptions')
      .where({ id: devices[i].id, live_activity_start_token: devices[i].live_activity_start_token })
      .update({ live_activity_start_token: null, live_activity_token_at: db.fn.now() });
  }
}

async function startCard(stop, view, now) {
  const refusal = startRefusal(stop, view, now);
  if (refusal) return { action: 'none', reason: refusal };
  const devices = await cardDevices(stop.customerId);
  if (!devices.length) return { action: 'none', reason: 'no_device' };
  // A server with no Apple key (a preview, a dev machine) writes no row and asks Apple nothing.
  if (!require('./apns').status().configured) return { action: 'none', reason: 'apns_not_configured' };
  if (!(await onTheWayNoticeOn(stop.customerId, view.visits[0].id))) return { action: 'none', reason: 'notice_off' };
  if (await hadCardSince(stop.key, view.since)) return { action: 'none', reason: 'already_had_a_card' };

  // The claim: the stop's one live row. A second process gets no row back and leaves the start to the first.
  const members = memberUnion(null, view);
  const claimed = await db.raw(
    `INSERT INTO live_activity_sessions
       (stop_key, customer_id, property_id, technician_id, service_day, scheduled_service_id, member_ids, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?)
     ON CONFLICT (stop_key) WHERE ended_at IS NULL DO NOTHING
     RETURNING id`,
    [stop.key, stop.customerId, stop.propertyId, stop.technicianId, stop.day, stop.serviceId, JSON.stringify(members), now, now],
  );
  const sessionId = claimed.rows[0]?.id;
  if (!sessionId) return { action: 'none', reason: 'starting' };

  const la = require('./apns-live-activity');
  let channelId = null;
  let pushed = false;
  try {
    const channel = await la.createChannel();
    if (!channel.ok) {
      await closeSession(sessionId, `no_channel:${channel.reason}`, now, { channelGone: true });
      return { action: 'none', reason: 'no_channel' };
    }
    channelId = channel.channelId;
    await db('live_activity_sessions').where({ id: sessionId }).update({ channel_id: channelId, updated_at: now });

    const state = await stateOf(view);
    const payload = la.buildPayload({
      event: 'start',
      now,
      contentState: state,
      attributes: { visitRef: sessionId },
      // Apple requires an alert on a start. No sound: the on-the-way notice already made one.
      alert: { title: 'Waves', body: `${state.title}.` },
      channelId,
      staleAt: new Date(view.since.getTime() + STALE_AFTER_MS[view.phase]),
    });
    const expiresAt = new Date(now.getTime() + START_PUSH_TTL_MS);
    pushed = true;
    const results = await Promise.all(devices.map((device) => la.start({ startToken: device.live_activity_start_token, payload, expiresAt })));
    await clearDeadTokens(devices, results);
    // Apple's answer for each phone. Accepting a start is not proof the card showed, so a first test reads this.
    const answers = results.map((r, i) => ({ device: devices[i].id, ok: Boolean(r.ok), reason: r.reason || null }));
    await db('live_activity_sessions').where({ id: sessionId }).update({ start_results: JSON.stringify(answers), updated_at: now });
    const started = results.filter((r) => r.ok).length;
    // A start with no answer (a timeout, a dropped connection) may still have put a card on the phone.
    const unsure = results.filter((r) => !r.ok && r.uncertain).length;
    if (!started && !unsure) {
      // Apple refused every start, so no card exists and nobody listens on the channel.
      const removed = await la.deleteChannel({ channelId });
      await closeSession(sessionId, `no_device_started:${results[0].reason || 'unknown'}`, now, { channelGone: removed.ok });
      return { action: 'none', reason: 'no_device_started' };
    }
    // With any start accepted or unsure, the row stays live and keeps its channel, so a card that did reach
    // a phone still gets its updates and its end. Recorded only while the row is still this start's own
    // (seq 0, not started): a later pass that took a stalled start over has already moved the card on, and
    // its record must stand.
    await db('live_activity_sessions').where({ id: sessionId, seq: 0 }).whereNull('started_at').update({
      phase: state.phase,
      phase_since: view.since,
      state: JSON.stringify(state),
      sent_sig: signature(state, members),
      push_ts: epochSeconds(now),
      devices_started: started,
      started_at: now,
      last_sent_at: now,
      updated_at: now,
    });
    logger.info(`[visit-live-activity] card ${sessionId} started (${state.phase}) on ${started} of ${devices.length} iPhone(s)${unsure ? `, ${unsure} with no answer` : ''}`);
    return { action: 'started', devices: started, ...(unsure ? { unsure } : {}) };
  } catch (err) {
    // Before any start push: nothing is on a phone, so close the row. After one: a card may exist, so the
    // row stays open for the pass that keeps a live card current, which ends the card with the visit.
    if (!pushed) {
      const removed = channelId ? await la.deleteChannel({ channelId }) : { ok: true };
      await closeSession(sessionId, `start_failed:${err.code || 'error'}`, now, { channelGone: removed.ok }).catch(() => {});
    }
    throw err;
  }
}

// ---- Entry points ------------------------------------------------------------

/** Make one stop's card agree with its visits. In this step: start one when the stop has none. */
async function syncStop(stop, { now = new Date() } = {}) {
  if (await liveSession(stop.key)) return { action: 'none', reason: 'card_live' };
  if (!gateLive()) return { action: 'none', reason: 'gate_off' };
  return startCard(stop, viewOf(await loadStopVisits(stop)), now);
}

async function syncVisit(serviceId, { now = new Date() } = {}) {
  const visit = await selectVisits().where({ id: serviceId }).first();
  if (!visit) return { action: 'none', reason: 'no_visit' };
  return syncStop(stopOf(visit), { now });
}

module.exports = {
  syncVisit,
  // exported for unit tests
  stopOf,
  viewOf,
  targetOf,
  startRefusal,
  START_WINDOW_MS,
  STALE_AFTER_MS,
  END_AFTER_MS,
  COMPLETE_SHOWN_MS,
};
