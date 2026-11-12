/**
 * Visit day on the Lock Screen: when a card starts, what it shows and when it ends
 * (GATE_VISIT_LIVE_ACTIVITY, owner 2026-11-11, "do this first Visit day on the Lock Screen").
 *
 * The card is a picture of the visit, not a message queue. Every entry point (a tracker flip's poke, the
 * 2-minute sweep) reads the visit as it is NOW and makes the card agree with it, so a lost poke, a restart
 * or an Apple failure only delays the card: the next pass repairs it.
 *
 *   start   the technician goes on the way (or arrives): one Apple broadcast channel for the stop, and one
 *           start push to each of the customer's iPhones that registered for the card (routes/push.js).
 *   update  each later step is ONE broadcast on the channel: arrived.
 *   end     service complete (the card stays 15 minutes), or at once when the visit is cancelled, moved
 *           or rewound, when a step outlasts its time limit, or when the gate goes off.
 *
 * It adds to today's notices and changes none of them: the on-the-way and arrival texts and app
 * notifications go out exactly as before.
 *
 * A STOP is the customer, the saved address, the ET day and the technician: the rule the on-the-way text
 * already uses (one-text-per-day.js), so two services at one address on one day share one card. A visit with
 * no saved address is its own stop.
 *
 * No lock and no connection is held across a call to Apple. Order is kept by the row itself
 * (live_activity_sessions, see its migration): a start is claimed by inserting the stop's one live row, and
 * each update takes the next `seq` with a strictly later Apple timestamp in one conditional UPDATE.
 *
 * The tracker, the job status service and the rebooker load this file, so it loads only what they already
 * load (the database handle, the logger, the gates). The Apple transport, the push device scope and the
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
// Apple keeps a channel's newest message for a phone that was offline (up to 8 hours). The channel stays
// that long after the end so such a phone still hears it, then the sweep removes it.
const END_PUSH_TTL_MS = 8 * 60 * MINUTE;
const UPDATE_PUSH_TTL_MS = 60 * MINUTE;
const CHANNEL_KEPT_MS = 9 * 60 * MINUTE;
const CHANNEL_REMOVAL_TRIED_MS = 24 * 60 * MINUTE;
// A start in progress in another process is left alone this long before a sweep takes the row over.
const STARTING_GRACE_MS = MINUTE;
// iOS itself ends a card after 8 hours. A row older than this is closed whatever Apple answers.
const MAX_CARD_AGE_MS = 12 * 60 * MINUTE;
// A card that listens on a channel needs iOS 18.
const MIN_IOS_MAJOR = 18;
const MAX_DEVICES = 5;
const SWEEP_LIMIT = 200;
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

// The customer-facing tracker state: the ONE derivation (track-transitions.js). Required on use because
// that module loads this one.
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

function stopOfSession(session) {
  return {
    key: session.stop_key,
    customerId: session.customer_id,
    propertyId: session.property_id || null,
    technicianId: session.technician_id || null,
    day: session.service_day,
    serviceId: session.scheduled_service_id,
  };
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

// The card goes to the account holder's own iPhones, so it follows the two choices that decide whether the
// holder gets today's on-the-way notice: the "technician on the way" notice is on, and appointment notices
// go to the holder too (`appointment_notify_primary`, read as customer-contact.js reads it: only an
// explicit false is off). A visit at a saved address other than the primary one follows that address's
// choices where those are enforced (property-notification-prefs.js). Read only: no decision row is written
// from here.
async function holderGetsOnTheWayNotice(customerId, serviceId) {
  const prefs = await db('notification_prefs').where({ customer_id: customerId }).first();
  const propertyPrefs = require('./property-notification-prefs');
  let effective = prefs;
  if (propertyPrefs.propertyTextsEnforced()) {
    const property = await propertyPrefs.visitProperty(customerId, serviceId);
    if (property) {
      effective = propertyPrefs.overlayPropertyPrefs(property, await propertyPrefs.propertyPrefsRow(property.id), prefs);
    }
  }
  return Boolean(effective?.tech_en_route) && effective.appointment_notify_primary !== false;
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
  if (!(await holderGetsOnTheWayNotice(stop.customerId, view.visits[0].id))) return { action: 'none', reason: 'notice_off' };
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
    // (seq 0, not started): a sweep that took a stalled start over has already moved the card on, and its
    // record must stand.
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
    // row stays open and the sweep takes it over after the grace time and ends it with the visit.
    if (!pushed) {
      const removed = channelId ? await la.deleteChannel({ channelId }) : { ok: true };
      await closeSession(sessionId, `start_failed:${err.code || 'error'}`, now, { channelGone: removed.ok }).catch(() => {});
    }
    throw err;
  }
}

// ---- Keep a live card current ------------------------------------------------

// Apple's answer says the channel itself is no good (its reason names the channel), as against a failure of
// the request around it: a timeout, a busy Apple, a bad key, a refused payload. Apple's channel reasons are
// not listed in its documents, so the test is the word, not a list.
function channelRefused(result) {
  return !result.ok && !result.retryable && !result.skipped && /channel/i.test(String(result.reason || ''));
}

// The state for an end that has no visit to show (the card leaves at once, so nobody reads it).
function lastStateOf(session) {
  let stored = session.state;
  if (typeof stored === 'string') { try { stored = JSON.parse(stored); } catch { stored = null; } }
  return stored && stored.phase ? stored : { phase: 'complete', title: 'Waves', detail: '', step: STEP.complete };
}

// A row that must wait, or that is closed without a word to Apple. Null = the card can be advanced.
async function settleUnusable(session, now) {
  const age = now.getTime() - new Date(session.created_at).getTime();
  // A start is in progress in another process.
  if (!session.started_at && age < STARTING_GRACE_MS) return { action: 'none', reason: 'starting' };
  // A start that died before it got a channel: no phone ever heard of this card.
  if (!session.channel_id) {
    await closeSession(session.id, 'start_abandoned', now, { channelGone: true });
    return { action: 'ended', reason: 'start_abandoned' };
  }
  if (age > MAX_CARD_AGE_MS) {
    await closeSession(session.id, 'too_old', now);
    return { action: 'ended', reason: 'too_old' };
  }
  return null;
}

/**
 * Send one update or end, in the card's order. Returns what happened, or null when another sender took the
 * turn first.
 */
async function sendInOrder(session, { target, state, sig, members }, now) {
  // The next place in the order: one conditional UPDATE gives this sender the seq and an Apple timestamp
  // strictly later than every earlier one, so a slower, older update can never win on the phone.
  const turn = await db('live_activity_sessions')
    .where({ id: session.id, seq: session.seq })
    .whereNull('ended_at')
    .update({ seq: session.seq + 1, push_ts: db.raw('GREATEST(push_ts + 1, ?)', [epochSeconds(now)]), updated_at: now })
    .returning('push_ts');
  if (!turn.length) return null;

  const ending = target.kind === 'end';
  const la = require('./apns-live-activity');
  const sent = await la.broadcast({
    channelId: session.channel_id,
    payload: la.buildPayload({
      event: ending ? 'end' : 'update',
      now: new Date(Number(turn[0].push_ts) * 1000),
      contentState: state,
      staleAt: target.staleAt,
      dismissAt: target.dismissAt,
    }),
    expiresAt: new Date(now.getTime() + (ending ? END_PUSH_TTL_MS : UPDATE_PUSH_TTL_MS)),
  });
  if (!sent.ok) {
    // Apple refused the channel itself: no later update can reach this card either, so the row is closed.
    if (channelRefused(sent)) {
      await closeSession(session.id, `refused:${sent.reason}`, now);
      return { action: 'ended', reason: 'refused' };
    }
    // Any other failure (a timeout, a busy Apple, a bad key, a refused payload) can pass or be fixed, and
    // the card may still be on a phone. The row stays as it is: the next pass sends again, until the row's
    // age limit closes it.
    return { action: 'failed', reason: sent.reason };
  }
  // Recorded only by the sender that still holds the newest place: a later sender records its own.
  await db('live_activity_sessions').where({ id: session.id, seq: session.seq + 1 }).update({
    phase: state.phase,
    phase_since: target.since || session.phase_since || null,
    state: JSON.stringify(state),
    sent_sig: sig,
    member_ids: JSON.stringify(members),
    started_at: session.started_at || now,
    last_sent_at: now,
    ...(ending ? { ended_at: now, end_reason: target.reason } : {}),
    updated_at: now,
  });
  if (ending) logger.info(`[visit-live-activity] card ${session.id} ended (${target.reason})`);
  return { action: ending ? 'ended' : 'updated', reason: ending ? target.reason : state.phase };
}

/**
 * One pass over a live card: make it agree with the visit. Returns what happened, or null when another
 * sender took the turn first (the caller reads again).
 */
async function advanceCard(session, visits, now) {
  const unusable = await settleUnusable(session, now);
  if (unusable) return unusable;

  const view = viewOf(visits, session.member_ids);
  const target = targetOf(view, session, now, { live: gateLive(), allowed: customerAllowed(session.customer_id) });
  const members = memberUnion(session, view);
  const state = view ? await stateOf(view) : lastStateOf(session);
  const sig = target.kind === 'end' ? `end|${target.reason}` : signature(state, members);
  if (sig === session.sent_sig) return { action: 'none', reason: 'current' };
  return sendInOrder(session, { target, state, sig, members }, now);
}

async function keepCurrent(stop, now) {
  for (let pass = 0; pass < 3; pass += 1) {
    const session = await liveSession(stop.key);
    if (!session) return { action: 'none', reason: 'no_card' };
    const outcome = await advanceCard(session, await loadStopVisits(stop), now);
    if (outcome) return outcome;
  }
  return { action: 'none', reason: 'busy' };
}

// ---- Entry points ------------------------------------------------------------

/** Make one stop's card agree with its visits: keep a live card current, or start one. */
async function syncStop(stop, { now = new Date() } = {}) {
  const kept = await keepCurrent(stop, now);
  if (kept.reason !== 'no_card') return kept;
  if (!gateLive()) return { action: 'none', reason: 'gate_off' };
  const started = await startCard(stop, viewOf(await loadStopVisits(stop)), now);
  // The visit may have moved on while the start was in flight.
  if (started.action === 'started') await keepCurrent(stop, now);
  return started;
}

async function syncVisit(serviceId, { now = new Date() } = {}) {
  const visit = await selectVisits().where({ id: serviceId }).first();
  if (!visit) return { action: 'none', reason: 'no_visit' };
  return syncStop(stopOf(visit), { now });
}

/**
 * A visit's customer-facing tracker state just changed: bring its card up to date. Called from every place
 * that tells the customer's in-app tracker to refresh. Never throws and never waits; gate off = nothing.
 */
function poke(serviceId) {
  try {
    if (!serviceId || !gateLive()) return;
    setImmediate(() => {
      syncVisit(serviceId).catch((err) => logger.warn(`[visit-live-activity] sync failed for visit ${serviceId}: ${err.message}`));
    });
  } catch (err) {
    logger.warn(`[visit-live-activity] poke failed for visit ${serviceId}: ${err.message}`);
  }
}

// A channel is asked to be removed for one day after its 9 hours are up. Apple answering "removed" or "no
// such channel" marks it gone, and so does a refusal of the channel itself. Any other failure (a timeout,
// a bad key) is tried again by the next sweep; a channel still there after the day is left (it costs
// nothing, and the app has 10,000).
async function removeOldChannels(now) {
  const la = require('./apns-live-activity');
  const due = now.getTime() - CHANNEL_KEPT_MS;
  const rows = await db('live_activity_sessions')
    .whereNotNull('channel_id')
    .whereNull('channel_deleted_at')
    .whereBetween('ended_at', [new Date(due - CHANNEL_REMOVAL_TRIED_MS), new Date(due)])
    .limit(SWEEP_LIMIT)
    .select('id', 'channel_id');
  let removed = 0;
  for (const row of rows) {
    const result = await la.deleteChannel({ channelId: row.channel_id });
    if (!result.ok && !channelRefused(result)) continue;
    await db('live_activity_sessions').where({ id: row.id }).update({ channel_deleted_at: now, updated_at: now });
    removed += 1;
  }
  return removed;
}

/**
 * Every 2 minutes (scheduler.js): the repair pass.
 *   1. Every live card is checked against its visit: a missed step is sent, a time limit ends the card.
 *      With the gate off this ends every live card, so "off" clears the Lock Screens within 2 minutes.
 *   2. Gate on: a visit that went live in the last 20 minutes with no card gets one (its poke was lost in a
 *      restart, or its iPhone registered a moment late).
 *   3. Channels of cards that ended more than 9 hours ago are removed.
 */
async function sweep({ now = new Date() } = {}) {
  const counts = { cards: 0, started: 0, updated: 0, ended: 0, failed: 0, channelsRemoved: 0 };
  const seen = new Set();
  const run = async (stop) => {
    seen.add(stop.key);
    try {
      const outcome = await syncStop(stop, { now });
      if (counts[outcome.action] !== undefined) counts[outcome.action] += 1;
    } catch (err) {
      counts.failed += 1;
      logger.warn(`[visit-live-activity] sweep could not sync ${stop.key}: ${err.message}`);
    }
  };

  const sessions = await db('live_activity_sessions').whereNull('ended_at').orderBy('created_at', 'asc').limit(SWEEP_LIMIT);
  counts.cards = sessions.length;
  for (const session of sessions) await run(stopOfSession(session));

  if (gateLive()) {
    const cutoff = new Date(now.getTime() - START_WINDOW_MS);
    const { etDateString } = require('../utils/datetime-et');
    const visits = await selectVisits()
      .whereIn('track_state', LIVE_STATES)
      .whereRaw('scheduled_date >= ?::date - 1', [etDateString(now)])
      .where(function wentLiveLately() { this.where('en_route_at', '>=', cutoff).orWhere('arrived_at', '>=', cutoff); })
      .limit(SWEEP_LIMIT);
    for (const visit of visits) {
      const stop = stopOf(visit);
      if (!seen.has(stop.key)) await run(stop);
    }
  }

  counts.channelsRemoved = await removeOldChannels(now);
  return counts;
}

module.exports = {
  poke,
  syncVisit,
  sweep,
  // exported for unit tests
  stopOf,
  viewOf,
  targetOf,
  startRefusal,
  START_WINDOW_MS,
  STALE_AFTER_MS,
  END_AFTER_MS,
  COMPLETE_SHOWN_MS,
  CHANNEL_KEPT_MS,
};
