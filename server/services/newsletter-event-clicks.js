/**
 * Event-level click attribution + bounded click-rate learning
 * (owner spec 2026-07-28, PR 5).
 *
 * Tracking flow:
 *   1. The compact assembler renders every details link as a
 *      {{evclick:<eventId>}} token instead of the raw event URL.
 *   2. At send time the sender substitutes each token PER RECIPIENT with
 *      /api/public/newsletter/e/<engagement_token>/<eventId> (SendGrid
 *      substitutions — same mechanics as the quiz/feedback tokens).
 *   3. The public route records the click (deduped per recipient+event)
 *      and 302s to the DB-locked event URL. Like all industry email
 *      click tracking, scanner prefetch can record a click — the unique
 *      constraint caps that inflation at one per recipient/event, and it
 *      applies uniformly across events, so RELATIVE rates stay usable.
 *   4. Proof / preview / archive render the tokens as the DIRECT event
 *      URLs (resolveEvclickDirect) — tracking applies to real sends only.
 *
 * Learning (bounded, deliberately modest — clicks must never take over
 * the editorial score): 8-week category (novelty_type) and zone
 * click-per-event rates vs the overall mean produce a deterministic
 * adjustment clamped to ±5 total, applied only to floor-passing scored
 * rows (stars and unscored rows untouched, never below the floor).
 * Categories with fewer than MIN_CATEGORY_EVENTS appearances get NO
 * adjustment — that is the discovery protection: an unusual event with
 * little history is judged purely on its rubric score.
 * Kill switch: NEWSLETTER_CLICK_LEARNING=false. Fail-open on any error.
 */

const db = require('../models/db');
const logger = require('./logger');
const { featureScoreFloor } = require('./event-scoring');

const EVCLICK_TOKEN = (eventId) => `{{evclick:${eventId}}}`;
const EVCLICK_RE = /\{\{evclick:([0-9a-f-]{36})\}\}/gi;

const LEARNING_WINDOW_DAYS = 56; // 8 weeks
const MIN_TOTAL_CLICKS = 30;
const MIN_CATEGORY_EVENTS = 3;
const CATEGORY_CAP = 3;
const ZONE_CAP = 2;
const TOTAL_CAP = 5;

function clickLearningEnabled() {
  return process.env.NEWSLETTER_CLICK_LEARNING !== 'false';
}

/** Public base for tracking URLs (mirrors the portal host convention). */
function trackingBaseUrl() {
  return process.env.PUBLIC_PORTAL_URL || 'https://portal.wavespestcontrol.com';
}

function trackingUrl(engagementToken, eventId) {
  return `${trackingBaseUrl()}/api/public/newsletter/e/${encodeURIComponent(engagementToken)}/${eventId}`;
}

/** All evclick event ids present in a body. */
function evclickIdsInBody(body) {
  const ids = new Set();
  let m;
  const re = new RegExp(EVCLICK_RE.source, 'gi');
  while ((m = re.exec(String(body || ''))) !== null) ids.add(m[1].toLowerCase());
  return [...ids];
}

/**
 * Per-recipient SendGrid substitution map for every evclick token in the
 * body. A recipient without an engagement token falls back to the DIRECT
 * event URL (never a broken link), which is also the fallback when the
 * event id has no known URL.
 */
function buildEvclickSubstitutions(body, { token, urlById = new Map() } = {}) {
  const subs = {};
  for (const id of evclickIdsInBody(body)) {
    const direct = urlById.get(id) || 'https://www.wavespestcontrol.com/';
    subs[EVCLICK_TOKEN(id)] = token ? trackingUrl(token, id) : direct;
  }
  return subs;
}

/** Resolve evclick tokens to DIRECT urls (proof/preview/archive render). */
function resolveEvclickDirect(body, urlById = new Map()) {
  return String(body || '').replace(new RegExp(EVCLICK_RE.source, 'gi'), (_, id) => (
    urlById.get(String(id).toLowerCase()) || 'https://www.wavespestcontrol.com/'
  ));
}

/** Load { eventIdLower → event_url } for a send's locked + alternate ids. */
async function eventUrlMapForSend(send, knex = db) {
  const { parseLockedEventIds } = require('./newsletter-event-selection');
  const ids = [...new Set([
    ...parseLockedEventIds(send?.event_ids),
    ...parseLockedEventIds(send?.alternate_event_ids),
  ].map(String))];
  if (!ids.length) return new Map();
  const rows = await knex('events_raw').whereIn('id', ids).select('id', 'event_url');
  return new Map(rows.map((r) => [String(r.id).toLowerCase(), r.event_url || null]));
}

/**
 * Record one click (deduped). Returns the redirect URL — always a URL,
 * even when nothing was recorded (unknown token = untracked redirect).
 */
async function recordEventClick({ engagementToken, eventId }, knex = db) {
  const event = await knex('events_raw').where({ id: eventId }).first('id', 'event_url');
  const fallback = 'https://www.wavespestcontrol.com/';
  const destination = event?.event_url || fallback;
  if (!event) return { redirectUrl: fallback, recorded: false };
  try {
    const delivery = await knex('newsletter_send_deliveries')
      .where({ engagement_token: engagementToken })
      .first('id', 'send_id');
    if (!delivery) return { redirectUrl: destination, recorded: false };
    const send = await knex('newsletter_sends').where({ id: delivery.send_id }).first('event_ids');
    const { parseLockedEventIds } = require('./newsletter-event-selection');
    const lockedIds = parseLockedEventIds(send?.event_ids).map((id) => String(id).toLowerCase());
    const position = lockedIds.indexOf(String(eventId).toLowerCase());
    await knex('newsletter_event_clicks')
      .insert({
        send_id: delivery.send_id,
        event_id: eventId,
        engagement_token: engagementToken,
        position: position >= 0 ? position : null,
        kind: 'details',
      })
      .onConflict(['send_id', 'event_id', 'engagement_token', 'kind'])
      .ignore();
    return { redirectUrl: destination, recorded: true };
  } catch (err) {
    logger.warn(`[newsletter-event-clicks] record failed (redirecting anyway): ${err.message}`);
    return { redirectUrl: destination, recorded: false };
  }
}

// ── Learning ─────────────────────────────────────────────────────────

/**
 * Pure math: per-key clicks-per-event rate vs the overall mean → a
 * clamped integer adjustment. Keys with fewer than minEvents
 * appearances return 0 (discovery protection).
 */
function rateAdjustment(keyClicks, keyEvents, overallRate, { cap, minEvents = MIN_CATEGORY_EVENTS } = {}) {
  if (!keyEvents || keyEvents < minEvents || !overallRate) return 0;
  const ratio = (keyClicks / keyEvents) / overallRate;
  return Math.max(-cap, Math.min(cap, Math.round((ratio - 1) * cap)));
}

/**
 * Aggregate the 8-week window into { categoryAdj: Map, zoneAdj: Map }.
 * Fail-open: any error or thin data returns empty maps (no adjustment).
 */
async function computeLearnedAdjustments(knex = db) {
  try {
    const since = new Date(Date.now() - LEARNING_WINDOW_DAYS * 24 * 3600 * 1000);
    const rows = await knex('newsletter_event_clicks as c')
      .join('events_raw as e', 'e.id', 'c.event_id')
      .where('c.clicked_at', '>=', since)
      .select('c.event_id', 'e.novelty_type', 'e.region_zone');
    if (rows.length < MIN_TOTAL_CLICKS) return { categoryAdj: new Map(), zoneAdj: new Map() };

    const perEvent = new Map();
    for (const r of rows) {
      const key = String(r.event_id);
      if (!perEvent.has(key)) perEvent.set(key, { clicks: 0, category: r.novelty_type || 'unknown', zone: r.region_zone || 'unknown' });
      perEvent.get(key).clicks += 1;
    }
    const events = [...perEvent.values()];
    const overallRate = events.reduce((a, e) => a + e.clicks, 0) / events.length;

    const groupBy = (field) => {
      const g = new Map();
      for (const e of events) {
        const k = e[field];
        if (!g.has(k)) g.set(k, { clicks: 0, events: 0 });
        g.get(k).clicks += e.clicks;
        g.get(k).events += 1;
      }
      return g;
    };
    const categoryAdj = new Map();
    for (const [k, v] of groupBy('category')) {
      categoryAdj.set(k, rateAdjustment(v.clicks, v.events, overallRate, { cap: CATEGORY_CAP }));
    }
    const zoneAdj = new Map();
    for (const [k, v] of groupBy('zone')) {
      zoneAdj.set(k, rateAdjustment(v.clicks, v.events, overallRate, { cap: ZONE_CAP }));
    }
    return { categoryAdj, zoneAdj };
  } catch (err) {
    logger.warn(`[newsletter-event-clicks] learning aggregation failed (no adjustment): ${err.message}`);
    return { categoryAdj: new Map(), zoneAdj: new Map() };
  }
}

/**
 * Apply learned adjustments to scored candidates: clamp(cat + zone) to
 * ±5, floor-passing scored rows only, never below the floor, stars and
 * unscored rows untouched. Pure given the adjustment maps.
 */
function applyLearnedAdjustments(scored, { categoryAdj, zoneAdj }) {
  if ((!categoryAdj || !categoryAdj.size) && (!zoneAdj || !zoneAdj.size)) return scored;
  const floor = featureScoreFloor();
  return scored.map((ev) => {
    const s = Number(ev.editorial_score);
    if (!Number.isFinite(s) || s < floor || ev.admin_status === 'featured') return ev;
    const cat = categoryAdj?.get(ev.novelty_type || 'unknown') || 0;
    const zone = zoneAdj?.get(ev.region_zone || 'unknown') || 0;
    const adj = Math.max(-TOTAL_CAP, Math.min(TOTAL_CAP, cat + zone));
    if (!adj) return ev;
    return { ...ev, editorial_score: Math.max(floor, Math.min(100, s + adj)), learnedAdjustment: adj };
  });
}

async function applyLearnedAdjustmentsFromHistory(scored, knex = db) {
  if (!clickLearningEnabled()) return scored;
  const adjustments = await computeLearnedAdjustments(knex);
  return applyLearnedAdjustments(scored, adjustments);
}

module.exports = {
  EVCLICK_TOKEN,
  evclickIdsInBody,
  buildEvclickSubstitutions,
  resolveEvclickDirect,
  eventUrlMapForSend,
  recordEventClick,
  rateAdjustment,
  computeLearnedAdjustments,
  applyLearnedAdjustments,
  applyLearnedAdjustmentsFromHistory,
  clickLearningEnabled,
  trackingUrl,
};
