'use strict';

// Follow-up due alerts (owner 2026-11-02, "build all", B1).
//
// When a tech completes a visit with the outcome "follow-up needed", a
// `dispatch_alerts` card (type follow_up_needed) lands on the dispatch board's
// Action Queue. It has no bell, so a flagged follow-up that nobody books just
// sits there: on 2026-11-02, 13 of 23 open cards were past their date with no
// later visit for the customer.
//
// This daily job turns a card that is due and not booked into an office bell:
//   - ONE alert per card, raised once, on its due date (or up to 3 days after,
//     if the job did not run that day). It links to the customer page, where
//     the owner books. Nothing here books a visit.
//   - A card that is more than 3 days past due with no alert of its own goes
//     on ONE catch-up alert. It rings when it is first raised or when a card
//     joins the list; any other change refreshes it quietly; it closes itself
//     when the list is empty.
//   - Every run closes the open alerts whose card is now covered.
//
// Due date: the card's suggestedFollowupDate (or suggestedDate) when it is a
// real YYYY-MM-DD, else the card's Eastern created date + 14 days.
//
// A card is COVERED (no alert, any open alert closed) when any of these holds:
//   - the card is resolved;
//   - the customer is inactive (active false, pipeline_stage churned, deleted)
//     or is an internal test customer;
//   - a live (not cancelled / skipped / no-show) scheduled visit for the
//     customer was created after the card;
//   - a live visit for the customer is dated after the card's Eastern date and
//     on or before due + 7 days;
//   - a live visit carries followup_source_service_id = the card's visit.
//
// Read-only on dispatch_alerts, scheduled_services and customers; writes only
// admin notifications. Sends nothing to a customer, books nothing, calls no
// paid API.
//
// GATE_FOLLOWUP_DUE_ALERT (strict 'true', read at call time). Off = the cron
// returns before any read.

const db = require('../models/db');
const logger = require('./logger');
const { etDateString, validCalendarDate } = require('../utils/datetime-et');
const { INTERNAL_TEST_CUSTOMERS, isInternalTestCustomerId } = require('./internal-test-customers');
const { FOLLOWUP_CHILD_INACTIVE_STATUSES } = require('./typed-followup-obligation');
const { MAX_HEADLINE_CHARS, MAX_WHY_CHARS, breaksAlertRules, composeAdminAlert, raiseAdminAlert } = require('./admin-alert-compose');

const CATEGORY = 'schedule';
const AREA = 'Schedule';
const OWN_PREFIX = 'followup-due:';
const CATCHUP_KEY = 'followup-due-older';
const ET = 'America/New_York';
const DEFAULT_DUE_DAYS = 14;
// A card whose due date is at most this many days back still gets its own alert.
const OWN_ALERT_WINDOW_DAYS = 3;
// A visit this many days after the due date still counts as the follow-up.
const BOOKED_GRACE_DAYS = 7;
const DETAIL_MAX_LINES = 25;
const ITEM_KEYS_MAX = 200;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const RESOLUTION = Object.freeze({
  booked: { reason: 'followup_booked', text: 'Follow-up booked' },
  resolved: { reason: 'card_resolved', text: 'Card resolved' },
  inactive: { reason: 'customer_inactive', text: 'Customer inactive' },
  internal: { reason: 'internal_test_customer', text: 'Internal test customer' },
});

// ---------------------------------------------------------------- dates (pure)

function dayNumber(day) {
  const [y, m, d] = day.split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / 86400000);
}

function addDays(day, count) {
  return new Date((dayNumber(day) + count) * 86400000).toISOString().slice(0, 10);
}

// 'Nov 5' from a YYYY-MM-DD string (no time zone is involved).
function shortDay(day) {
  const [, m, d] = day.split('-').map(Number);
  return `${MONTHS[m - 1]} ${d}`;
}

function payloadOf(card) {
  const raw = card.payload;
  if (raw && typeof raw === 'object') return raw;
  try { return JSON.parse(raw) || {}; } catch { return {}; }
}

// Eastern calendar day the card was created (the loader selects it in SQL;
// the fallback keeps pure callers honest).
function cardDay(card) {
  return card.card_day || etDateString(new Date(card.created_at));
}

function dueDay(card) {
  const payload = payloadOf(card);
  return validCalendarDate(payload.suggestedFollowupDate)
    || validCalendarDate(payload.suggestedDate)
    || addDays(cardDay(card), DEFAULT_DUE_DAYS);
}

// ------------------------------------------------------------ coverage (pure)

function isInternalTest(card) {
  if (isInternalTestCustomerId(card.customer_id)) return true;
  const name = `${card.first_name || ''} ${card.last_name || ''}`.trim().toLowerCase();
  return Boolean(name) && INTERNAL_TEST_CUSTOMERS.includes(name);
}

function customerInactive(card) {
  return card.active === false || card.pipeline_stage === 'churned' || Boolean(card.deleted_at) || !card.customer_id;
}

// Does one live visit cover the card? (The loader has already dropped cancelled rows.)
function visitCovers(card, visit, due) {
  if (visit.followup_source_service_id && String(visit.followup_source_service_id) === String(card.job_id)) return true;
  if (String(visit.customer_id) !== String(card.customer_id) || String(visit.id) === String(card.job_id)) return false;
  if (new Date(visit.created_at).getTime() > new Date(card.created_at).getTime()) return true;
  return Boolean(visit.day) && visit.day > cardDay(card) && visit.day <= addDays(due, BOOKED_GRACE_DAYS);
}

// Why a card needs no alert: 'resolved' | 'internal' | 'inactive' | 'booked', else null.
function coverageOf(card, visits) {
  if (card.resolved_at) return 'resolved';
  if (isInternalTest(card)) return 'internal';
  if (customerInactive(card)) return 'inactive';
  const due = dueDay(card);
  return (visits || []).some((visit) => visitCovers(card, visit, due)) ? 'booked' : null;
}

// Sort the cards: which are covered (and why), which get their own alert today,
// which belong on the catch-up list. A card due in the future is none of them.
function classify(cards, visits, today) {
  const covered = new Map();
  const fresh = [];
  const older = [];
  for (const card of cards) {
    const reason = coverageOf(card, visits);
    if (reason) { covered.set(String(card.id), reason); continue; }
    const due = dueDay(card);
    if (due > today) continue;
    const item = { card, due };
    if (dayNumber(today) - dayNumber(due) <= OWN_ALERT_WINDOW_DAYS) fresh.push(item);
    else older.push(item);
  }
  const byDue = (a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : String(a.card.id).localeCompare(String(b.card.id)));
  return { covered, fresh: fresh.sort(byDue), older: older.sort(byDue) };
}

// -------------------------------------------------------------- copy (pure)

// "Pat S." for Pat Synthetic; "Pat" with no last name; '' with neither.
function shortName(card) {
  const first = String(card.first_name || '').trim();
  const last = String(card.last_name || '').trim();
  if (!first) return '';
  return last ? `${first} ${last[0].toUpperCase()}.` : first;
}

function actionFor(card, due) {
  const name = shortName(card);
  const candidates = name ? [
    `book ${name}'s follow-up (due ${shortDay(due)})`,
    `book ${name}'s follow-up`,
  ] : [];
  candidates.push(`book a follow-up (due ${shortDay(due)})`, 'book a follow-up');
  return candidates.find((text) => `${AREA} — ${text}`.length <= MAX_HEADLINE_CHARS && !breaksAlertRules(text)) || 'book a follow-up';
}

function serviceWords(card) {
  return String(payloadOf(card).serviceType || '').replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
}

function whyFor(card) {
  const when = shortDay(cardDay(card));
  const service = serviceWords(card);
  const named = `${service} follow-up you flagged on ${when}; no visit is booked.`;
  if (service && named.length <= MAX_WHY_CHARS && !breaksAlertRules(named)) return named;
  return `Follow-up you flagged on ${when}; no visit is booked.`;
}

function customerLink(card) {
  return `/admin/customers?customerId=${encodeURIComponent(card.customer_id)}`;
}

// The spec for one card's own alert.
function ownSpec(item) {
  const { card, due } = item;
  return {
    area: AREA,
    action: actionFor(card, due),
    why: whyFor(card),
    severity: 'needs-you',
    who: 'person',
    subject: { type: 'visit', id: String(card.job_id) },
    doneWhen: 'followup_booked',
    // The owner books from the customer page; this link does not book anything.
    link: customerLink(card),
    promise: true,
  };
}

function detailLine(item, today) {
  const { card, due } = item;
  const daysAgo = dayNumber(today) - dayNumber(due);
  const who = shortName(card) || 'Unknown customer';
  const service = serviceWords(card) || 'Follow-up';
  return `${who} · ${service} · due ${shortDay(due)} (${daysAgo} day${daysAgo === 1 ? '' : 's'} ago)`;
}

// The catch-up alert for a non-empty list (items oldest due first).
function composeCatchUp(items, today) {
  const count = items.length;
  const oldest = items[0];
  const lines = items.slice(0, DETAIL_MAX_LINES).map((item) => detailLine(item, today));
  if (count > DETAIL_MAX_LINES) lines.push(`…and ${count - DETAIL_MAX_LINES} more.`);
  const detail = [
    `${count} flagged follow-up${count === 1 ? ' has' : 's have'} no visit booked and ${count === 1 ? 'is' : 'are'} more than ${OWN_ALERT_WINDOW_DAYS} days past due. Oldest first:`,
    ...lines,
  ].join('\n');
  const spec = {
    area: AREA,
    action: `book ${count} older follow-up${count === 1 ? '' : 's'}`,
    why: `${count === 1 ? 'A follow-up you flagged has' : `${count} follow-ups you flagged have`} no visit booked; the oldest was due ${shortDay(oldest.due)}.`,
    severity: 'needs-you',
    who: 'person',
    subject: { type: 'check', id: CATCHUP_KEY },
    doneWhen: 'count_zero',
    // One card: open its customer. Several: the Dispatch board, where the cards live.
    link: count === 1 ? customerLink(oldest.card) : '/admin/dispatch',
    promise: true,
  };
  const itemKeys = items.map((item) => String(item.card.id)).sort().slice(0, ITEM_KEYS_MAX);
  return { spec, detail, itemKeys, count };
}

// A refresh rings only when a card joins the list.
function ringOnNewCard(itemKeys) {
  return (_existing, existingMeta) => {
    const prior = new Set(Array.isArray(existingMeta?.itemKeys) ? existingMeta.itemKeys.map(String) : []);
    return itemKeys.some((key) => !prior.has(key));
  };
}

// ------------------------------------------------------------------- reads

async function loadCards(database, alsoIds = []) {
  const query = database('dispatch_alerts as a')
    .leftJoin('scheduled_services as s', 's.id', 'a.job_id')
    .leftJoin('customers as c', 'c.id', 's.customer_id')
    .where('a.type', 'follow_up_needed')
    .where(function openOrWatched() {
      this.whereNull('a.resolved_at');
      if (alsoIds.length) this.orWhereIn('a.id', alsoIds);
    })
    .select(
      'a.id', 'a.job_id', 'a.created_at', 'a.resolved_at', 'a.payload',
      's.customer_id', 'c.first_name', 'c.last_name', 'c.active', 'c.pipeline_stage', 'c.deleted_at',
      database.raw(`to_char(a.created_at AT TIME ZONE '${ET}', 'YYYY-MM-DD') AS card_day`),
    );
  return query;
}

// Every live visit that could cover one of the cards: the customers' visits
// created or dated since the oldest card, and any visit that names a card's
// visit as its source.
async function loadVisits(database, cards) {
  const open = cards.filter((card) => !card.resolved_at && card.customer_id);
  if (!open.length) return [];
  const customerIds = [...new Set(open.map((card) => card.customer_id))];
  const jobIds = [...new Set(open.map((card) => card.job_id))];
  const oldestCreated = open.map((card) => new Date(card.created_at)).sort((a, b) => a - b)[0];
  const oldestDay = open.map(cardDay).sort()[0];
  return database('scheduled_services as v')
    .whereNotIn('v.status', FOLLOWUP_CHILD_INACTIVE_STATUSES)
    .where(function coversACard() {
      this.whereIn('v.followup_source_service_id', jobIds).orWhere(function sinceTheCards() {
        this.whereIn('v.customer_id', customerIds).where(function recent() {
          this.where('v.created_at', '>=', oldestCreated).orWhere('v.scheduled_date', '>=', oldestDay);
        });
      });
    })
    .select(
      'v.id', 'v.customer_id', 'v.followup_source_service_id', 'v.created_at',
      database.raw("to_char(v.scheduled_date, 'YYYY-MM-DD') AS day"),
    );
}

// Dedupe keys that ever got an alert row (open, read or closed) among `keys`.
async function loadRaisedKeys(database, keys) {
  if (!keys.length) return new Set();
  const rows = await database('notifications')
    .where({ recipient_type: 'admin' })
    .whereRaw("metadata->>'dedupeKey' = ANY(?::text[])", [keys])
    .select(database.raw("metadata->>'dedupeKey' AS dedupe_key"));
  return new Set(rows.map((row) => row.dedupe_key));
}

// ------------------------------------------------------------------ writes

async function raiseOwn(item) {
  const { card } = item;
  const result = await raiseAdminAlert(CATEGORY, ownSpec(item), {
    dedupeKey: `${OWN_PREFIX}${card.id}`,
    // GATE_ADMIN_BELL_POLICY drops an admin row that does not ask to ring.
    bell: true,
    metadata: { dispatchAlertId: String(card.id), customerId: String(card.customer_id), dueDate: item.due },
  });
  if (!result) throw new Error('follow-up due alert was not written');
  return result.suppressed ? 'suppressed' : (result.deduped ? 'unchanged' : 'raised');
}

async function raiseCatchUp(composed) {
  const alert = composeAdminAlert(composed.spec);
  const result = await require('./admin-alert-episodes').raiseAdminAlertWithReopen(CATEGORY, alert.headline, alert.why, {
    dedupeKey: CATCHUP_KEY,
    bell: true,
    refreshOnDedupe: true,
    ringOnRefresh: ringOnNewCard(composed.itemKeys),
    // A refresh that rings moves the row to the top of the newest-first bell.
    bumpOnRefresh: true,
    detail: composed.detail,
    link: alert.link,
    metadata: { ...alert.metadata, itemKeys: composed.itemKeys, count: composed.count },
  });
  if (!result) throw new Error('follow-up catch-up alert was not written');
  if (result.suppressed) return 'suppressed';
  if (!result.deduped) return 'raised';
  if (result.refreshed) return result.rung === false ? 'refreshed' : 'raised';
  return 'unchanged';
}

// Close the open own alerts whose card is covered (or gone), grouped by cause.
async function closeCovered(database, openIds, cards, covered) {
  const present = new Set(cards.map((card) => String(card.id)));
  const byCause = new Map();
  for (const id of openIds) {
    const cause = present.has(id) ? covered.get(id) : 'resolved';
    if (!cause) continue;
    byCause.set(cause, [...(byCause.get(cause) || []), `${OWN_PREFIX}${id}`]);
  }
  const episodes = require('./admin-alert-episodes');
  let closed = 0;
  for (const [cause, keys] of byCause) {
    closed += Number(await episodes.closeAdminAlertKeys(database, keys, RESOLUTION[cause].reason, { resolution: RESOLUTION[cause].text })) || 0;
  }
  return closed;
}

async function closeCatchUp(database) {
  return Number(await require('./admin-alert-episodes').closeAdminAlertKeys(database, [CATCHUP_KEY], 'count_zero', {
    resolution: 'Every older follow-up is booked or closed',
  })) || 0;
}

// Raise each fresh card's own alert; one failure never stops the rest.
async function raiseFresh(fresh) {
  const tally = { raised: 0, failed: 0 };
  for (const item of fresh) {
    try {
      if ((await raiseOwn(item)) === 'raised') tally.raised += 1;
    } catch (err) {
      tally.failed += 1;
      logger.warn(`[followup-due-alerts] own alert failed: ${err.message}`);
    }
  }
  return tally;
}

// The catch-up list is the older cards with no alert of their own.
async function catchUpPass(database, older, today) {
  const raisedKeys = await loadRaisedKeys(database, older.map((item) => `${OWN_PREFIX}${item.card.id}`));
  const listed = older.filter((item) => !raisedKeys.has(`${OWN_PREFIX}${item.card.id}`));
  if (!listed.length) {
    const closed = await closeCatchUp(database);
    return { listed: 0, outcome: closed ? 'closed' : 'clear' };
  }
  return { listed: listed.length, outcome: await raiseCatchUp(composeCatchUp(listed, today)) };
}

/**
 * Daily cron entry point. Returns { skipped } when the gate is off, otherwise
 * { raised, closed, listed, outcome }. A read failure throws (runExclusive
 * records it in job_health) and closes nothing. `gateEnabled` and `now` are
 * for tests.
 */
async function runFollowupDueAlerts({ now = new Date(), database = db, gateEnabled } = {}) {
  const live = gateEnabled ?? require('../config/feature-gates').followupDueAlertLive();
  if (!live) return { skipped: 'disabled' };
  const today = etDateString(now);
  const episodes = require('./admin-alert-episodes');
  const openIds = (await episodes.openAdminAlertKeys(database, OWN_PREFIX)).map((key) => key.slice(OWN_PREFIX.length));
  const cards = await loadCards(database, openIds);
  const visits = await loadVisits(database, cards);
  const { covered, fresh, older } = classify(cards, visits, today);
  const closedOwn = await closeCovered(database, openIds, cards, covered);
  const own = await raiseFresh(fresh);
  const catchUp = await catchUpPass(database, older, today);
  const result = { raised: own.raised, closed: closedOwn, listed: catchUp.listed, outcome: catchUp.outcome };
  if (own.failed) throw new Error(`${own.failed} follow-up due alert${own.failed === 1 ? '' : 's'} failed to write`);
  return result;
}

module.exports = {
  runFollowupDueAlerts,
  CATCHUP_KEY,
  OWN_PREFIX,
  _private: {
    dueDay, coverageOf, classify, actionFor, whyFor, ownSpec, composeCatchUp, ringOnNewCard, shortName, shortDay, addDays,
    loadCards, loadVisits, OWN_ALERT_WINDOW_DAYS, BOOKED_GRACE_DAYS, DEFAULT_DUE_DAYS,
  },
};
