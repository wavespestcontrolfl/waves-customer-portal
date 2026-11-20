'use strict';

/**
 * Phone-yes step 1, the office's phone alert (GATE_CALL_PHONE_YES_ACCEPT, owner 2026-11-18 "ok go", page v4). A card rings
 * the admin bell once when the sweep files it, and once more while it is still open and time runs short: an open estimate
 * on the card expires within 24 hours, or the soonest visit to come that keeps the card open starts within 48 hours. Only a
 * card with status open rings or is rewritten (the sweep keeps only those current). Each ring also sends a phone banner to
 * the admins (bell-banners.js kind call_phone_yes, 7:00 AM to 9:00 PM Eastern; a ring at night stays in the bell, and the
 * 8 AM banner counts it). The bell never holds the caller's words (headline, why, detail or metadata): a spoken turn
 * can hold a gate code or a card number, no screen catches every form, and the why reaches a phone's lock screen. The
 * card in Triage shows them, as the SMS reader's review bell leaves a text's words on the text. Nothing here texts,
 * emails or calls a customer.
 *
 * Contract: docs/admin-notifications.md. Category `estimate` with `bell: true` (as the other estimate bells), area
 * Estimates, severity needs-you, who person, subject the booking call (one card per call), link the Triage tab, where the
 * card and its tap are. Keys `call-phone-yes:<card id>` (filed) and `call-phone-yes-due:<card id>` (time short), without
 * dedupeOpenOnly: a closed row still holds its key, so each key rings at most once. Once the time-short row exists the
 * filed row closes (every pass retries that close), so a card keeps one open row. A card filed when time is already short
 * rings the time-short bell alone, and nothing rings for a card after its time-short bell. Between rings the open row is
 * rewritten quietly when the card's words change (a yes taken back, an estimate accepted, the visit moved): no ring, no
 * banner, and its read state kept. Each card rings in a transaction of its own that holds its call's triage lock and
 * reads the card and its evidence again, so a card closed, claimed or changed while the pass runs rings nothing (the
 * next run writes the change, then rings what the card says). Nothing rings while every active admin has this type's
 * Bell switch off in Push Settings, so no banner goes either; an open row is still kept current and closed. A card that
 * rang nothing while the switch was off rings once it is on again, if it is still open.
 *
 * Done-when `phone_yes_card_closed`: the sweep (call-phone-yes-accept.js, every 10 minutes while the gate is on) closes a
 * card's rows once the card is no longer open: the tap accepted it, a person resolved or dismissed it, or the sweep
 * closed it as moot.
 */

const db = require('../models/db');
const logger = require('./logger');
const compose = require('./admin-alert-compose');
const Names = require('./admin-alert-names');
const Episodes = require('./admin-alert-episodes');
const { dateOnlyString } = require('../utils/date-only');
const { parseETDateTime, formatETDayDate } = require('../utils/datetime-et');

const FILED_PREFIX = 'call-phone-yes:';
const DUE_PREFIX = 'call-phone-yes-due:';
const DONE_WHEN = 'phone_yes_card_closed';
// The trigger key (notification-triggers.js) and the banner kind (bell-banners.js).
const BANNER_KIND = 'call_phone_yes';
// The Communications page reads its tab from the hash.
const LINK = '/admin/communications#tab=triage';
const OPEN_CARD_STATES = ['open', 'in_progress'];
const HOUR_MS = 3600000;
const ESTIMATE_DUE_HOURS = 24;
const VISIT_DUE_HOURS = 48;

const filedKey = (cardId) => `${FILED_PREFIX}${cardId}`;
const dueKey = (cardId) => `${DUE_PREFIX}${cardId}`;
const cardIdOfKey = (key) => key.slice(key.indexOf(':') + 1);

// When the visit starts, in ET: its day at its window start (a visit with no start counts from the start of its day).
function visitStart(visit) {
  const day = dateOnlyString(visit?.scheduled_date);
  return day ? parseETDateTime(`${day}T${String(visit.window_start || '00:00').slice(0, 5)}`) : null;
}

// Why time runs short, or null: an open estimate on the card expires within 24 hours, or the card's visit starts within
// 48. A time already past is not short.
function dueReason({ expiresAt, visit, now }) {
  const left = (at) => (at ? at.getTime() - now.getTime() : null);
  const expiresIn = left(expiresAt ? new Date(expiresAt) : null);
  if (expiresIn > 0 && expiresIn < ESTIMATE_DUE_HOURS * HOUR_MS) return 'estimate_expires';
  const startsIn = left(visitStart(visit));
  return startsIn > 0 && startsIn < VISIT_DUE_HOURS * HOUR_MS ? 'visit_soon' : null;
}

// The key a card rings now, or null: the time-short key once time runs short, else the filed key, each at most once, and
// nothing after the time-short key. `rung`: the card's keys already written, open or closed.
function keyToRing({ cardId, due, rung }) {
  if (rung.has(dueKey(cardId))) return null;
  if (due) return dueKey(cardId);
  return rung.has(filedKey(cardId)) ? null : filedKey(cardId);
}

// The card's state, read from the same payload fields as its summary (summaryOf in call-phone-yes-accept.js).
function cardStateOf(payload) {
  if (payload.estimate_accepted === true) return 'accepted';
  if (payload.yes_heard === true) return 'yes';
  return payload.yes_rechecking === true ? 'rechecking' : 'no_yes';
}

// Per card state: the headline's action and the why at filing. `booked` is " for <visit day>" or "".
const STATE_TEXT = {
  accepted: {
    action: (who) => `check ${who}'s booked visit`,
    why: ({ booked }) => `An estimate was accepted, but the visit the call booked${booked} is not linked to it yet.`,
  },
  // The yes may come from an earlier call than the one that booked the visit, so the why names no call.
  yes: {
    action: (who) => `accept ${who}'s estimate`,
    why: ({ visitDay }) => `The caller said yes to pay per application on a call${visitDay ? `, and the visit is ${visitDay}` : ''}.`,
  },
  rechecking: {
    action: (who) => `check ${who}'s estimate`,
    why: ({ booked }) => `A call booked a pest visit${booked} while an estimate is open; its yes is being read again.`,
  },
  no_yes: {
    action: (who) => `check ${who}'s estimate`,
    why: ({ booked }) => `A call booked a pest visit${booked} while an estimate is open; no yes was heard.`,
  },
};

// The why when time runs short.
const DUE_WHY = {
  estimate_expires: ({ expiresAt, several }) => `${several ? 'An open estimate on the card' : 'The estimate'} expires ${formatETDayDate(new Date(expiresAt))} and is not accepted yet.`,
  visit_soon: ({ visitDay }) => `The visit the call booked is ${visitDay}, and its card in Triage is still open.`,
};

// The bell's words: the headline's action, the one-sentence why and the detail. The card's payload and summary give
// them (the summary is the sweep's own copy), so the bell says what the card shows. The caller's words stay on the card.
function textFor({ name, card, expiresAt = null, several = false, visit = null, due = null }) {
  const payload = typeof card.payload === 'string' ? JSON.parse(card.payload) : (card.payload || {});
  const state = cardStateOf(payload);
  const start = visitStart(visit);
  const visitDay = start ? formatETDayDate(start) : null;
  const facts = { booked: visitDay ? ` for ${visitDay}` : '', expiresAt, several, visitDay };
  const where = `Open Communications, then Triage, to see the card${payload.yes_heard === true ? " and the caller's words" : ''}.`;
  return {
    action: Names.fitAction('Estimates', name, [STATE_TEXT[state].action]),
    why: due ? DUE_WHY[due](facts) : STATE_TEXT[state].why(facts),
    detail: [card.summary, where].filter(Boolean).join(' '),
  };
}

// The card's open row to keep current when it rings nothing new: its time-short row while open, else its filed row
// while open. `written`: each key already written for the card, true while its row is open (not done).
function standingKey(cardId, written) {
  return [dueKey(cardId), filedKey(cardId)].find((key) => written.get(key) === true) || null;
}

// Rings what a card owes now (keyToRing). Otherwise rewrites its open row when the card's words changed (a yes taken
// back, an estimate accepted, the visit moved), quietly: no ring, no banner, the read state kept. Nothing when the card
// has no open row. Returns { key, raised } (the key it raised and the raise's result), or null.
// card: { id, call_log_id, related_customer_id, related_estimate_id, payload, summary }; expiresAt: the soonest an open
// estimate on the card expires, after now; several: the card names more than one estimate; visit: the soonest visit to
// come that keeps the card open ({ scheduled_date, window_start }) or null; written: as standingKey; ringsOn: the Bell
// switch (bellSwitchOn), off = nothing new rings and an open row is still kept current; trx: the card's transaction
// (runBellPass), which the write joins, so the banner goes only once it commits.
async function ringCard({ card, expiresAt = null, several = false, visit = null, written, ringsOn, now = new Date(), trx }) {
  const due = dueReason({ expiresAt, visit, now });
  const ringKey = ringsOn ? keyToRing({ cardId: card.id, due, rung: written }) : null;
  const key = ringKey || standingKey(card.id, written);
  if (!key) return null;
  const name = (await Names.lookupCustomerName(trx, card.related_customer_id)) || 'a customer';
  const text = textFor({ name, card, expiresAt, several, visit, due });
  const raised = await compose.raiseAdminAlert('estimate', {
    area: 'Estimates',
    action: text.action,
    why: text.why,
    severity: 'needs-you',
    link: LINK,
    subject: { type: 'call', id: String(card.call_log_id) },
    doneWhen: DONE_WHEN,
    who: 'person',
  }, {
    bell: true,
    // The phone banner (bell-banners.js kind call_phone_yes). A quiet rewrite sends none.
    bannerKind: BANNER_KIND,
    dedupeKey: key,
    ...(ringKey ? {} : { refreshOnDedupe: true, ringOnRefresh: () => false }),
    trx,
    detail: text.detail,
    metadata: {
      triageItemId: String(card.id),
      callLogId: String(card.call_log_id),
      customerId: card.related_customer_id || null,
      estimateId: card.related_estimate_id ? String(card.related_estimate_id) : null,
      due,
    },
  });
  return { key, raised };
}

// The Bell switch for this type in Push Settings (notification_preferences, trigger call_phone_yes): true while an
// active admin has it on, no preference row meaning on, as triggerNotification decides a shared bell row for an
// admin-only type. A failed read is off for this pass (fail closed, as the dispatcher).
async function bellSwitchOn() {
  try {
    const { TRIGGER_REGISTRY, defaultPreference } = require('./notification-triggers');
    const admins = await db('technicians').where({ active: true, role: 'admin' }).pluck('id');
    if (!admins.length) return false;
    const prefs = await db('notification_preferences').where({ trigger_key: BANNER_KIND }).whereIn('admin_user_id', admins)
      .select('admin_user_id', 'bell_enabled');
    const byAdmin = new Map(prefs.map((p) => [String(p.admin_user_id), p]));
    const fallback = defaultPreference(TRIGGER_REGISTRY[BANNER_KIND]);
    return admins.some((id) => (byAdmin.get(String(id)) || fallback).bell_enabled !== false);
  } catch (e) {
    logger.warn(`[call-phone-yes] Bell switch not read, no new rings this pass: ${e.code || e.name || 'error'}`);
    return false;
  }
}

// Each key already written for these cards (a closed row still holds its key), true while its row is open.
async function writtenKeys(cardIds) {
  const keys = cardIds.flatMap((id) => [filedKey(id), dueKey(id)]);
  const written = new Map();
  if (!keys.length) return written;
  const rows = await db('notifications').where({ recipient_type: 'admin' })
    .whereRaw("metadata->>'dedupeKey' = ANY(?::text[])", [keys])
    .select(db.raw("metadata->>'dedupeKey' AS dedupe_key"), 'done_at');
  for (const row of rows) written.set(row.dedupe_key, written.get(row.dedupe_key) === true || row.done_at == null);
  return written;
}

/**
 * The bell pass, run by the sweep after its filing and its moot close. `listCards()`: every card still open or claimed,
 * each { id, status, call_log_id }. `readCard(trx, listed)`: an open card read again under its call's triage lock (the
 * lock every card writer takes first), with the times that make it urgent ({ card, expiresAt, several, visit }), or null
 * once it is no longer open or while its evidence says something it does not show yet. Each open card rings in a
 * transaction of its own that holds that lock, so a card the tap accepts or a person claims while the pass runs rings
 * nothing. With the Bell switch off (bellSwitchOn) nothing rings, and open rows are still rewritten. Then two closes,
 * each retried by every pass: a card's filed row once its time-short row exists (one open row per card), and the rows
 * of cards no longer open, listed again so a card closed during the pass loses its rows in this pass. A claimed card,
 * or one that could not be read, keeps its rows. Returns the number of rows the second close closed.
 */
async function runBellPass({ listCards, readCard, now = new Date() }) {
  const listed = await listCards();
  const written = await writtenKeys(listed.map((card) => card.id));
  const ringsOn = await bellSwitchOn();
  for (const entry of listed.filter((card) => card.status === 'open')) {
    try {
      const out = await db.transaction(async (trx) => {
        const fresh = await readCard(trx, entry);
        return fresh ? ringCard({ ...fresh, written, ringsOn, now, trx }) : null;
      });
      // A row now stands for this key; a raise that failed or was withheld returns no id, and the next run tries again.
      if (out?.raised?.id) written.set(out.key, true);
    } catch (e) {
      // Nothing rang for this key, so the next run tries again.
      logger.warn(`[call-phone-yes] bell skipped for card ${entry.id}: ${e.code || e.name || 'error'}`);
    }
  }
  // Also a filed row a person already marked Done: the system close takes it over (done_by is the latest closer), so
  // Recently Done cannot bring its words back beside the time-short row. Rows already closed this way are skipped.
  const replaced = listed.map((card) => card.id).filter((id) => written.has(dueKey(id)) && written.has(filedKey(id)));
  await Episodes.closeAdminAlertKeys(db, replaced.map(filedKey), 'phone_yes_time_short', {
    now, resolution: 'Replaced by the alert that time runs short on this card',
  });
  const open = new Set((await listCards()).map((card) => String(card.id)));
  const standing = [...await Episodes.openAdminAlertKeys(db, FILED_PREFIX), ...await Episodes.openAdminAlertKeys(db, DUE_PREFIX)];
  return Episodes.closeAdminAlertKeys(db, standing.filter((key) => !open.has(cardIdOfKey(key))), DONE_WHEN, {
    now, resolution: 'The card is closed',
  });
}

module.exports = {
  runBellPass, visitStart, OPEN_CARD_STATES, FILED_PREFIX, DUE_PREFIX, DONE_WHEN, LINK,
  _private: { dueReason, keyToRing, standingKey, textFor, visitStart, cardStateOf },
};
