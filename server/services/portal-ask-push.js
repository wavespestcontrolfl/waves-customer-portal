/**
 * The phone page for a customer's ask inside the app (GATE_PORTAL_ASK_PUSH, owner 2026-11-02).
 *
 * A portal chat hand-off, a customer service request, the late "Still waiting" re-ring, an estimate page's change
 * or call request and an unfinished booking each write an admin bell row. None of them rang a phone: three new leads asked ten times
 * in the app and the bells sat unread for weeks. A customer text rings a phone because it goes through the
 * trigger registry (sms_reply). This sends the same kind of page for the app's asks: the portal_ask trigger,
 * pushOnly, so the bell keeps its one row per ask and the push is the page. notification-triggers.js owns the
 * per-admin preferences (push on, sound), the badge count, the push tag and the demo-account suppression.
 *
 * - Caller rule: call this only after the bell row really exists and the ask is new or rang again. Never for a
 *   silent dedupe, a withheld or demo-account bell, or inside a transaction that has not committed.
 * - The text names the customer by first name and last initial and the ask in a few words. No phone, no email:
 *   a push shows on a lock screen (the trigger also redacts contact details from title and body).
 * - Sends nothing to a customer.
 * - Never throws. Gate off returns { skipped: 'gate_off' }.
 * - Never holds the caller past its own checks: pages go out from a small in-process queue (page limits below).
 */

const logger = require('./logger');

// The send is bounded so a slow push provider cannot hold a customer's request or a sweep for long. A timeout is
// ambiguous (the push may still land), so it is reported, never retried here.
const PUSH_DEADLINE_MS = 10 * 1000;
const TIMED_OUT = Symbol('portal-ask-push-timed-out');

// Page limits (Codex #7482 security review). A signed-in customer can open many asks (a chat hand-off per
// session, a request per form), and the late re-ring can find many rows in one sweep. The bell row is always the
// record; these bound only the phone pages, in this process:
// - one page per customer waiting at a time: a newer ask while one waits replaces its words (one page, coalesced);
// - at most PAGES_PER_CUSTOMER_PER_HOUR pages per customer (an ask with no customer counts by its own key);
// - at most PAGES_PER_HOUR pages in all;
// - at most PAGES_IN_FLIGHT being sent at once, so a slow push provider never holds a caller.
const PAGES_PER_CUSTOMER_PER_HOUR = 3;
const PAGES_PER_HOUR = 30;
const PAGES_IN_FLIGHT = 2;
const HOUR_MS = 60 * 60 * 1000;

const freshPages = () => ({ waiting: new Map(), inFlight: 0, sent: [] });
let pages = freshPages();

const pageKey = (payload) => (payload.customerId ? `customer:${payload.customerId}` : `ask:${payload.itemKey}`);

// Counts one page against both hourly limits, or returns false when either is used up. `sent` never holds more
// than PAGES_PER_HOUR entries, so the per-customer count reads it whole.
function reservePage(state, key, now) {
  state.sent = state.sent.filter((page) => page.at > now - HOUR_MS);
  if (state.sent.length >= PAGES_PER_HOUR) return false;
  if (state.sent.filter((page) => page.key === key).length >= PAGES_PER_CUSTOMER_PER_HOUR) return false;
  state.sent.push({ at: now, key });
  return true;
}

// Sends the waiting pages, oldest customer first, PAGES_IN_FLIGHT at a time. dispatch never rejects.
function drain(state) {
  while (state.inFlight < PAGES_IN_FLIGHT && state.waiting.size) {
    const [key, entry] = state.waiting.entries().next().value;
    state.waiting.delete(key);
    state.inFlight += 1;
    dispatch(entry.payload).then(entry.resolve).finally(() => {
      state.inFlight -= 1;
      drain(state);
    });
  }
}

async function dispatch(payload) {
  try {
    const { triggerNotification } = require('./notification-triggers');
    const result = await withDeadline(triggerNotification('portal_ask', payload, { pushOnly: true }));
    if (result === TIMED_OUT) {
      logger.error(`[portal-ask-push] push timed out after ${PUSH_DEADLINE_MS}ms for ${payload.itemKey.slice(0, 60)} - delivery ambiguous`);
      return { sent: false, timedOut: true };
    }
    return { sent: true, result: result || null };
  } catch (err) {
    logger.error(`[portal-ask-push] push failed for ${payload.itemKey.slice(0, 60)}: ${err?.message || 'error'}`);
    return { sent: false, error: err?.message || 'error' };
  }
}

function withDeadline(sendPromise) {
  const send = Promise.resolve(sendPromise);
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), PUSH_DEADLINE_MS);
    timer.unref?.();
  });
  return Promise.race([send, deadline]).finally(() => clearTimeout(timer));
}

// "Jane S." from a first and last name; "Jane" with no last name; "A customer" with neither.
function shortName(first, last) {
  const f = String(first || '').trim();
  const l = String(last || '').trim();
  if (!f && !l) return 'A customer';
  const initial = l ? `${l[0].toUpperCase()}.` : '';
  return [f, initial].filter(Boolean).join(' ');
}

// The short name of a customer row, for callers that hold only an id. Never throws.
async function customerShortName(customerId, database = null) {
  if (!customerId) return 'A customer';
  try {
    const conn = database || require('../models/db');
    const row = await conn('customers').where({ id: customerId }).first('first_name', 'last_name');
    return row ? shortName(row.first_name, row.last_name) : 'A customer';
  } catch (err) {
    logger.warn(`[portal-ask-push] customer name lookup failed: ${err?.code || err?.message || 'error'}`);
    return 'A customer';
  }
}

/**
 * @param {{ itemKey: string, title: string, body?: string, link?: string, customerId?: string }} ask
 *   itemKey: the ask's identity (one banner per key). customerId only lets the trigger suppress a demo account,
 *   and keys the page limits.
 * @returns {Promise<{ skipped: string } | { sent: boolean, result?: object, timedOut?: boolean, error?: string,
 *   coalesced?: boolean }>} settles when the page was sent or dropped. Callers do not wait for it.
 */
async function pushPortalAsk({ itemKey, title, body = null, link = null, customerId = null } = {}) {
  try {
    if (!require('../config/feature-gates').portalAskPushLive?.()) return { skipped: 'gate_off' };
    if (!itemKey || !title) return { skipped: 'incomplete' };
    const payload = {
      itemKey: String(itemKey), title, body, ...(link ? { link } : {}), ...(customerId ? { customerId: String(customerId) } : {}),
    };
    const state = pages;
    const key = pageKey(payload);
    const waiting = state.waiting.get(key);
    if (waiting) {
      waiting.payload = payload;
      return { ...(await waiting.done), coalesced: true };
    }
    if (!reservePage(state, key, Date.now())) {
      logger.warn(`[portal-ask-push] page limit reached, no push for ${payload.itemKey.slice(0, 60)} (the bell is the record)`);
      return { skipped: 'rate_limited' };
    }
    const entry = { payload };
    entry.done = new Promise((resolve) => { entry.resolve = resolve; });
    state.waiting.set(key, entry);
    drain(state);
    return await entry.done;
  } catch (err) {
    logger.error(`[portal-ask-push] push failed for ${String(itemKey).slice(0, 60)}: ${err?.message || 'error'}`);
    return { sent: false, error: err?.message || 'error' };
  }
}

module.exports = {
  pushPortalAsk, shortName, customerShortName, PUSH_DEADLINE_MS, PAGES_PER_CUSTOMER_PER_HOUR, PAGES_PER_HOUR, PAGES_IN_FLIGHT,
  // Tests only: forget the page limits' state (pages already being sent finish against the old state).
  __private: { resetPageLimits: () => { pages = freshPages(); } },
};
