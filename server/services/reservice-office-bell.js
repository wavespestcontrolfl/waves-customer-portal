/**
 * Re-service office bell (step S3b of the consolidated re-service report, owner 2026-11-02, GATE_RESERVICE_ASKS).
 *
 * After a re-service completes, ONE office bell lists what the customer's report leaves to the office:
 *   - "Not today": an item the tech answered not_today. The reason is for the office, never the customer.
 *   - Office only: a customer message about damage we caused, money, a complaint or a missed visit
 *     (reservice-office-only.js). It never prints on the report; the office reads it in full. An office-only item
 *     is listed whatever its answer, even none or hidden.
 *
 * `reserviceOfficeItems(freeze)` is pure. `raiseReserviceOfficeBell` raises through raiseAdminAlert
 * (docs/admin-notifications.md) and never throws: the completion that called it must not feel a failure here. Its
 * logs carry an error code only, never the alert's text (it names a customer).
 */
'use strict';

const logger = require('./logger');

const DEDUPE_PREFIX = 'reservice-office:';
const REASON_ROOM = 40; // characters of the tech's reason kept in the why

// What the customer's original words were about, as the screen found it.
const TOPIC = Object.freeze({
  damage: 'damage to their things',
  billing: 'money (a charge or refund)',
  complaint: 'a complaint',
  schedule: 'the visit time',
});
const CHANNEL = Object.freeze({
  text: 'text',
  call: 'call',
  email: 'email',
  request_form: 'request form',
  office: 'office note',
});

const clean = (value) => String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
const entryOf = (item, reason) => ({
  itemId: String(item.id),
  source: item.source || null,
  at: item.at || null,
  words: clean(item.text),
  reason: reason || null,
});

/**
 * @param {*} freeze service_data.reserviceAsks
 * @returns {{ officeOnly: object[], notToday: object[] }} entries { itemId, source, at, words, reason }; `reason` is
 *   the screen's verdict for an office-only item and the tech's note for a not-today item.
 */
function reserviceOfficeItems(freeze) {
  const none = { officeOnly: [], notToday: [] };
  if (!freeze || typeof freeze !== 'object' || freeze.version !== 1 || !Array.isArray(freeze.items)) return none;
  const answers = freeze.answers && typeof freeze.answers === 'object' ? freeze.answers : {};
  const notes = freeze.officeNotes && typeof freeze.officeNotes === 'object' ? freeze.officeNotes : {};
  const out = { officeOnly: [], notToday: [] };
  for (const item of freeze.items) {
    if (!item || item.id == null) continue;
    if (item.officeOnly) out.officeOnly.push(entryOf(item, item.officeOnly));
    else if (answers[item.id]?.answer === 'not_today') out.notToday.push(entryOf(item, clean(notes[item.id]) || null));
  }
  return out;
}

const dayOf = (entry) => {
  if (!entry.at) return '';
  return require('./admin-alert-names').shortDateET(entry.at);
};
const channelOf = (entry) => CHANNEL[entry.source] || 'message';
// "a text on Nov 2", "a request form"
function channelDay(entry) {
  const noun = channelOf(entry);
  const day = dayOf(entry);
  return `${/^[aeiou]/.test(noun) ? 'an' : 'a'} ${noun}${day ? ` on ${day}` : ''}`;
}

function visitLink(scheduledServiceId, scheduledDate) {
  const { dateOnlyString } = require('../utils/date-only');
  const date = dateOnlyString(scheduledDate);
  return `/admin/dispatch?tab=schedule${date ? `&date=${encodeURIComponent(date)}` : ''}&appointment=${encodeURIComponent(scheduledServiceId)}`;
}

// The why covers the first entry and counts the rest. One sentence, 110 characters.
function whyFor(first, more) {
  const { cutAtWord, MAX_WHY_CHARS } = require('./admin-alert-compose');
  const { whyWithQuote, redactedWords } = require('./admin-alert-names');
  const tail = more > 0 ? ` (+${more} more)` : '';
  if (first.kind === 'officeOnly') {
    const topic = TOPIC[first.entry.reason] || 'something for the office';
    const who = first.entry.source === 'office' ? 'An office note' : `Their ${channelOf(first.entry)}`;
    const day = dayOf(first.entry);
    return cutAtWord(`${who}${day ? ` on ${day}` : ''} is about ${topic}; read it in full${tail}.`, MAX_WHY_CHARS);
  }
  const reason = first.entry.reason ? redactedWords(first.entry.reason) : '';
  const lead = 'Not done today: ';
  const because = reason ? ` — ${cutAtWord(reason, REASON_ROOM)}` : '';
  const quote = redactedWords(first.entry.words);
  return whyWithQuote({ lead, quote, tail: `${because}${tail}` });
}

function detailLine({ kind, entry }) {
  const { redactedWords } = require('./admin-alert-names');
  const words = entry.words ? redactedWords(entry.words) : '';
  if (kind === 'officeOnly') {
    const topic = TOPIC[entry.reason] || 'something for the office';
    return `Office only: ${channelDay(entry)} about ${topic}. Read the whole message; it is not on the report.`
      + `${words ? ` The pest part: “${words}”.` : ''}`;
  }
  const reason = entry.reason ? redactedWords(entry.reason) : '';
  return `Not done today: ${channelDay(entry)}${words ? ` “${words}”` : ''}.${reason ? ` Tech's reason: ${reason}.` : ' The tech gave no reason.'}`;
}

/**
 * Raise the office bell for one completed re-service. Returns the alert result, or null when nothing qualifies or the
 * raise failed. Never throws.
 * @param {{ freeze: object, customer: { id?, first_name?, last_name? }, scheduledServiceId: string,
 *   serviceRecordId?: string, scheduledDate?: string|Date }} args
 */
async function raiseReserviceOfficeBell({ freeze, customer, scheduledServiceId, serviceRecordId = null, scheduledDate = null } = {}) {
  try {
    const { officeOnly, notToday } = reserviceOfficeItems(freeze);
    if (!officeOnly.length && !notToday.length) return null;
    if (!scheduledServiceId) return null;

    const { raiseAdminAlert } = require('./admin-alert-compose');
    const { fitAction, fullName, tidyName } = require('./admin-alert-names');
    const entries = [
      ...officeOnly.map((entry) => ({ kind: 'officeOnly', entry })),
      ...notToday.map((entry) => ({ kind: 'notToday', entry })),
    ];
    // Not-today items are a visit to follow up; an office-only message alone is a customer to read.
    const area = notToday.length ? 'Schedule' : 'Customers';
    const name = tidyName(fullName(customer));
    const templates = area === 'Schedule'
      ? [(who) => `follow up on ${who}'s re-service`, (who) => `follow up on ${who}'s visit`]
      : [(who) => `read ${who}'s re-service message`, (who) => `read ${who}'s message`];
    const action = name
      ? fitAction(area, name, templates)
      : (area === 'Schedule' ? 'follow up on a re-service' : 'read a re-service message');

    return await raiseAdminAlert('customer', {
      area,
      action,
      why: whyFor(entries[0], entries.length - 1),
      severity: 'needs-you',
      link: visitLink(scheduledServiceId, scheduledDate),
      subject: { type: 'visit', id: String(scheduledServiceId) },
      doneWhen: 'visit_checked',
      who: 'person',
    }, {
      bell: true,
      dedupeKey: `${DEDUPE_PREFIX}${scheduledServiceId}`,
      detail: entries.map(detailLine).join('\n'),
      metadata: {
        customerId: customer?.id ?? null,
        scheduledServiceId,
        serviceRecordId,
        itemIds: entries.map(({ entry }) => entry.itemId),
      },
    });
  } catch (err) {
    logger.warn(`[reservice-office-bell] bell not raised (${err?.code || 'error'})`);
    return null;
  }
}

module.exports = { reserviceOfficeItems, raiseReserviceOfficeBell };
