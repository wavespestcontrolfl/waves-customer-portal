'use strict';

/**
 * Phone-yes step 1, the office's phone alert (GATE_CALL_PHONE_YES_ACCEPT, owner 2026-11-18 "ok go", page v4). A card rings
 * the admin bell once when the sweep files it, and once more while it is still open and time runs short: an open estimate
 * on the card expires within 24 hours, or the card's visit starts within 48 hours. Each ring also sends a phone banner to
 * the admins (bell-banners.js kind call_phone_yes, 7:00 AM to 9:00 PM Eastern; a ring at night stays in the bell, and the
 * 8 AM banner counts it). Nothing here texts, emails or calls a customer.
 *
 * Contract: docs/admin-notifications.md. Category `estimate` with `bell: true` (as the other estimate bells), area
 * Estimates, severity needs-you, who person, subject the booking call (one card per call), link the Triage tab, where the
 * card and its tap are. Keys `call-phone-yes:<card id>` (filed) and `call-phone-yes-due:<card id>` (time short), without
 * dedupeOpenOnly: a closed row still holds its key, so each key rings at most once. Once the time-short row exists the
 * filed row closes (every pass retries that close), so a card keeps one open row. A card filed when time is already short
 * rings the time-short bell alone, and nothing rings for a card after its time-short bell. Between rings the open row is
 * rewritten quietly when the card's words change (a yes taken back, an estimate accepted, the visit moved): no ring, no
 * banner, and its read state kept.
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
// The Communications page reads its tab from the hash.
const LINK = '/admin/communications#tab=triage';
const OPEN_CARD_STATES = ['open', 'in_progress'];
const HOUR_MS = 3600000;
const ESTIMATE_DUE_HOURS = 24;
const VISIT_DUE_HOURS = 48;
const DETAIL_QUOTE_CHARS = 600;

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
    why: ({ visitDay, words }) => {
      const tail = visitDay ? ` on a call, and the visit is ${visitDay}.` : ' on a call.';
      const quote = compose.firstSentence(words).replace(/\.+$/, '');
      const quoted = quote ? Names.whyWithQuote({ lead: 'The caller said ', quote, tail }) : '';
      // Words that break the why's rules (a date, an exclamation mark, a bracket) give way to plain words.
      return quoted && !compose.breaksAlertRules(quoted) ? quoted : `The caller said yes to pay per application${tail}`;
    },
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
// them, so the bell says what the card shows; the detail keeps the caller's whole words.
function textFor({ name, card, expiresAt = null, several = false, visit = null, due = null }) {
  const payload = typeof card.payload === 'string' ? JSON.parse(card.payload) : (card.payload || {});
  const state = cardStateOf(payload);
  const start = visitStart(visit);
  const visitDay = start ? formatETDayDate(start) : null;
  const words = state === 'yes' && payload.caller_words ? Names.redactedWords(payload.caller_words) : '';
  const facts = { booked: visitDay ? ` for ${visitDay}` : '', words, expiresAt, several, visitDay };
  return {
    action: Names.fitAction('Estimates', name, [STATE_TEXT[state].action]),
    why: due ? DUE_WHY[due](facts) : STATE_TEXT[state].why(facts),
    detail: [
      card.summary,
      words ? `The caller's words: “${compose.cutAtWord(words, DETAIL_QUOTE_CHARS)}”.` : null,
      'Open Communications, then Triage, to see the card.',
    ].filter(Boolean).join(' '),
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
// estimate on the card expires, after now; several: the card names more than one estimate; visit: the card's visit while
// on the calendar ({ scheduled_date, window_start }) or null; written: as standingKey.
async function ringCard({ card, expiresAt = null, several = false, visit = null, written, now = new Date() }) {
  const due = dueReason({ expiresAt, visit, now });
  const ringKey = keyToRing({ cardId: card.id, due, rung: written });
  const key = ringKey || standingKey(card.id, written);
  if (!key) return null;
  const name = (await Names.lookupCustomerName(db, card.related_customer_id)) || 'a customer';
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
    bannerKind: 'call_phone_yes',
    dedupeKey: key,
    ...(ringKey ? {} : { refreshOnDedupe: true, ringOnRefresh: () => false }),
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
 * The bell pass, run by the sweep after its filing and its moot close. `timed`: the open cards to ring, each
 * { card, expiresAt, several, visit }; `openCardIds`: every open card, also one whose times could not be read, so its
 * rows stay. Then two closes, each retried by every pass: a card's filed row once its time-short row exists (one open
 * row per card), and the rows of cards no longer open. Returns the number of rows the second close closed.
 */
async function runBellPass({ timed, openCardIds, now = new Date() }) {
  const written = await writtenKeys(openCardIds);
  for (const entry of timed) {
    try {
      const out = await ringCard({ ...entry, written, now });
      // A row now stands for this key; a raise that failed or was withheld returns no id, and the next run tries again.
      if (out?.raised?.id) written.set(out.key, true);
    } catch (e) {
      // Nothing rang for this key, so the next run tries again.
      logger.warn(`[call-phone-yes] bell skipped for card ${entry.card.id}: ${e.code || e.name || 'error'}`);
    }
  }
  const replaced = openCardIds.filter((id) => written.has(dueKey(id)) && written.get(filedKey(id)) === true);
  await Episodes.closeAdminAlertKeys(db, replaced.map(filedKey), 'phone_yes_time_short', {
    now, resolution: 'Replaced by the alert that time runs short on this card',
  });
  const open = new Set(openCardIds.map(String));
  const standing = [...await Episodes.openAdminAlertKeys(db, FILED_PREFIX), ...await Episodes.openAdminAlertKeys(db, DUE_PREFIX)];
  return Episodes.closeAdminAlertKeys(db, standing.filter((key) => !open.has(cardIdOfKey(key))), DONE_WHEN, {
    now, resolution: 'The card is closed',
  });
}

module.exports = {
  runBellPass, OPEN_CARD_STATES, FILED_PREFIX, DUE_PREFIX, DONE_WHEN, LINK,
  _private: { dueReason, keyToRing, standingKey, textFor, visitStart, cardStateOf },
};
