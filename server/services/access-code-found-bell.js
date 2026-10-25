'use strict';

// The found-codes bell (owner ruling 2026-10-24, "i think we should"): one
// standing admin row for the access codes that wait on the office. A code the
// sweep finds in a text, call or email reaches a technician only after the
// office saves it on Customers → Gate codes, and before this nothing told
// anyone a code was waiting. The list is the page's own "Found in messages"
// list (listFound), so the row's count is the tab's count. The row rings when a
// code joins the list, refreshes quietly when one leaves, and closes itself
// (done) when the list is empty; a person's own done stays until a new code
// joins. Differing codes in one neighborhood still never ring (owner ruling
// 2026-10-03). The copy never carries a code, the customer's words or a phone
// number: it names the kind of code, who sent it and the day.
// Dark behind GATE_ACCESS_CODES_FOUND_BELL (read at call time). With
// GATE_ACCESS_CODES_SECTION off the list is not served, so the row closes.
// Contract for the copy and the lifecycle: docs/admin-notifications.md.

const db = require('../models/db');
const { accessCodesFoundBellLive, alertEpisodesLive } = require('../config/feature-gates');
const { composeAdminAlert, raiseAdminAlert, cutAtWord, MAX_WHY_CHARS } = require('./admin-alert-compose');
const { fitAction, shortDateET, tidyName } = require('./admin-alert-names');

const CATEGORY = 'access_codes';
const DEDUPE_KEY = 'access-codes-found';
const AREA = 'Customers';
// The page opens on its "Found in messages" view for this marker.
const LINK = '/admin/customers/gate-codes?view=found';
// The newest codes the row's words name. The count, the ring check and the
// oldest day use every waiting code, so a code that only moves into these 50
// when a newer one is saved never reads as new.
const LIST_LIMIT = 50;
const DETAIL_MAX_CHARS = 2000;
const NAMES_IN_WHY = 3;

const KIND_WORDS = {
  neighborhood_gate: 'gate code',
  property_gate: 'gate code',
  door: 'door code',
  lockbox: 'lockbox code',
  garage: 'garage code',
  call_box: 'call box code',
  pass: 'visitor pass',
  other: 'access code',
};
const kindWord = (kind) => KIND_WORDS[kind] || 'access code';
const SOURCE_NOUNS = { sms: 'text', call: 'call', email: 'email' };
const sourceNoun = (type) => SOURCE_NOUNS[type] || 'message';
const withArticle = (noun) => (/^[aeiou]/.test(noun) ? `an ${noun}` : `a ${noun}`);
const UNKNOWN_SENDER = 'an unknown sender';

// Who sent it: the linked customer's name, else an unknown sender (the office
// links one on the page). Never a phone number or an address.
function senderName(item) {
  if (!item.customerId) return UNKNOWN_SENDER;
  return tidyName(item.customerName) || 'a customer';
}

const dayOf = (item) => shortDateET(item.sourceAt || item.createdAt);

// "A", "A and B", "A, B and C", "A, B and 2 more".
function listWords(names, more) {
  const parts = more > 0 ? [...names, `${more} more`] : names;
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

function oneAction(item) {
  const kind = kindWord(item.kind);
  if (!item.customerId) return `review ${withArticle(kind)} from ${UNKNOWN_SENDER}`;
  return fitAction(AREA, senderName(item), [
    (who) => `review the ${kind} from ${who}`,
    (who) => `review ${who}'s ${kind}`,
  ]);
}

function oneWhy(item) {
  const day = dayOf(item);
  const from = `From ${withArticle(sourceNoun(item.sourceType))}${day ? ` on ${day}` : ''}`;
  let next = 'a technician sees it only after the office saves it';
  if (!item.customerId) next = 'no customer is linked yet, so link one, then save it';
  else if (item.life === 'visit') next = 'it is for one visit, so pick the visit when you save it';
  return cutAtWord(`${from}; ${next}.`, MAX_WHY_CHARS);
}

// `oldestAt`: when the oldest waiting code was sent, over every waiting code.
// The list is in filing order, and codes filed in one batch (a backfill) can
// carry older message days than codes filed before them.
function manyWhy(items, oldestAt) {
  const names = [];
  for (const item of items) {
    const name = senderName(item);
    if (!names.includes(name)) names.push(name);
  }
  const day = oldestAt ? shortDateET(oldestAt) : '';
  const tail = day ? `; the oldest is from ${day}` : '';
  for (let shown = Math.min(names.length, NAMES_IN_WHY); shown >= 1; shown -= 1) {
    const text = `From ${listWords(names.slice(0, shown), names.length - shown)}${tail}.`;
    if (text.length <= MAX_WHY_CHARS) return text;
  }
  return cutAtWord(`From ${names[0]}${tail}.`, MAX_WHY_CHARS);
}

const capitalized = (text) => text.charAt(0).toUpperCase() + text.slice(1);

// One line per code, newest first. Names and days only: the code, the
// customer's words and the sender's phone or address stay on the page.
function detailOf(items, count) {
  const lines = items.map((item) => {
    const day = dayOf(item);
    const life = item.life === 'visit' ? ' for one visit' : '';
    const hint = !item.customerId && item.suggestedCustomer?.name
      ? `; the message names a home of ${tidyName(item.suggestedCustomer.name)}`
      : '';
    return `- ${capitalized(kindWord(item.kind))}${life} from ${senderName(item)} (${sourceNoun(item.sourceType)}${day ? `, ${day}` : ''})${hint}`;
  });
  if (count > items.length) lines.push(`- and ${count - items.length} more`);
  const lead = `${count === 1 ? '1 code waits' : `${count} codes wait`} on Customers → Gate codes, Found in messages. `
    + 'A technician sees a code only after the office saves it. Save, dismiss or link each one there.';
  return [lead, ...lines].join('\n').slice(0, DETAIL_MAX_CHARS);
}

// The earliest send time among the waiting codes, or null when none has one.
function oldestSent(waiting) {
  const times = waiting.map((code) => new Date(code.sentAt).getTime()).filter(Number.isFinite);
  return times.length ? new Date(Math.min(...times)) : null;
}

// The row for the waiting codes: `waiting` is every waiting code ({ id,
// sentAt }), `items` the newest of them as the page lists them (the words
// come from these).
function composeFound(items, waiting) {
  const count = waiting.length;
  const one = count === 1 && items.length === 1;
  return {
    spec: {
      area: AREA,
      action: one ? oneAction(items[0]) : `review ${count} codes found in messages`,
      why: one ? oneWhy(items[0]) : manyWhy(items, oldestSent(waiting)),
      severity: 'needs-you',
      link: LINK,
      subject: { type: 'check', id: DEDUPE_KEY },
      doneWhen: 'count_zero',
      who: 'person',
    },
    detail: detailOf(items, count),
    itemKeys: waiting.map((code) => String(code.id)).sort(),
    count,
  };
}

// A refresh rings only when a code joins the list. (A comeback after the row
// closed rings through raiseAdminAlertWithReopen, which ignores this.)
function ringOnNewCode(itemKeys) {
  return (_existing, existingMeta) => {
    const prior = new Set(Array.isArray(existingMeta?.itemKeys) ? existingMeta.itemKeys.map(String) : []);
    return itemKeys.some((key) => !prior.has(key));
  };
}

async function raiseFound(trx, composed, dedupeKey) {
  const opts = {
    dedupeKey,
    trx,
    refreshOnDedupe: true,
    ringOnRefresh: ringOnNewCode(composed.itemKeys),
    // A refresh that rings moves the row to the top of the newest-first bell.
    bumpOnRefresh: true,
    detail: composed.detail,
    metadata: { itemKeys: composed.itemKeys, count: composed.count },
  };
  if (!alertEpisodesLive()) return raiseAdminAlert(CATEGORY, composed.spec, opts);
  const alert = composeAdminAlert(composed.spec);
  return require('./admin-alert-episodes').raiseAdminAlertWithReopen(CATEGORY, alert.headline, alert.why, {
    ...opts, link: alert.link, metadata: { ...opts.metadata, ...alert.metadata },
  });
}

const CLOSE_RESOLUTIONS = {
  count_zero: 'No codes are waiting',
  section_off: 'The access codes section is off',
  category_silenced: 'Gate codes found in messages are silenced in Settings',
};

async function closeFound(trx, now, reason, dedupeKey) {
  if (!alertEpisodesLive()) return 0;
  return Number(await require('./admin-alert-episodes').closeAdminAlertKeys(trx, [dedupeKey], reason, {
    now, resolution: CLOSE_RESOLUTIONS[reason],
  })) || 0;
}

// The owner silenced the category (Settings → Notifications). notifyAdmin
// reads that override only on a fresh insert, so a refresh or a reopen of the
// standing row would still ring: a silenced category reads no codes and
// closes the row instead. Only while the bell policy itself is on, as
// NotificationService.create reads it (the low-rating review alert's rule).
async function categorySilenced() {
  const bellPolicy = require('./notification-bell-policy');
  return bellPolicy.isBellPolicyEnabled() && !(await bellPolicy.bellAllowed({ category: CATEGORY }));
}

/**
 * Five-minute cron entry point. Returns { skipped } when the gate is off,
 * else { count, outcome }: raised | refreshed | unchanged | suppressed |
 * closed | clear. A read or write failure throws and never closes the row.
 * One sync runs at a time across instances: it holds the same advisory lock
 * notifyAdmin takes for this row, and reads the codes inside it.
 * `waitingCodes`, `list`, `sectionOn` and `dedupeKey` are for tests.
 */
async function syncFoundCodesBell({ now = new Date(), conn = db, gateEnabled, sectionOn, waitingCodes, list, dedupeKey = DEDUPE_KEY } = {}) {
  if (!(gateEnabled ?? accessCodesFoundBellLive())) return { skipped: 'disabled' };
  const capture = require('./access-code-capture');
  const section = sectionOn ?? capture.enabled();
  const readWaiting = waitingCodes || capture.listFoundWaiting;
  const readList = list || capture.listFound;
  let stop = section ? null : 'section_off';
  if (!stop && await categorySilenced()) stop = 'category_silenced';
  return conn.transaction(async (trx) => {
    await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`admin:${dedupeKey}`]);
    const waiting = stop ? [] : await readWaiting(trx);
    if (!waiting.length) {
      const closed = await closeFound(trx, now, stop || 'count_zero', dedupeKey);
      return { count: 0, outcome: closed ? 'closed' : 'clear' };
    }
    const listed = await readList(trx, { limit: LIST_LIMIT, offset: 0 });
    const items = Array.isArray(listed?.items) ? listed.items : [];
    // The office decided the last codes between the two reads: the next tick settles it.
    if (!items.length) return { count: waiting.length, outcome: 'unchanged' };
    const composed = composeFound(items, waiting);
    const result = await raiseFound(trx, composed, dedupeKey);
    if (!result) throw new Error('found codes bell was not written');
    let outcome = 'unchanged';
    // The owner silenced the category: the bell policy wrote nothing.
    if (result.suppressed) outcome = 'suppressed';
    else if (!result.deduped) outcome = 'raised';
    else if (result.refreshed) outcome = result.rung === false ? 'refreshed' : 'raised';
    return { count: composed.count, outcome };
  });
}

module.exports = {
  syncFoundCodesBell,
  CATEGORY,
  DEDUPE_KEY,
  LINK,
  _private: { composeFound, ringOnNewCode, kindWord, senderName, listWords, LIST_LIMIT },
};
