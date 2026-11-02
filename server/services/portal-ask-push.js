/**
 * The phone page for a customer's ask inside the app (GATE_PORTAL_ASK_PUSH, owner 2026-11-02).
 *
 * A portal chat hand-off, a customer service request, the late "Still waiting" re-ring and an estimate page's
 * change or call request each write an admin bell row. None of them rang a phone: three new leads asked ten times
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
 */

const logger = require('./logger');

// The send is bounded so a slow push provider cannot hold a customer's request or a sweep for long. A timeout is
// ambiguous (the push may still land), so it is reported, never retried here.
const PUSH_DEADLINE_MS = 10 * 1000;
const TIMED_OUT = Symbol('portal-ask-push-timed-out');

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
 *   itemKey: the ask's identity (one banner per key). customerId only lets the trigger suppress a demo account.
 * @returns {Promise<{ skipped: string } | { sent: boolean, result?: object, timedOut?: boolean, error?: string }>}
 */
async function pushPortalAsk({ itemKey, title, body = null, link = null, customerId = null } = {}) {
  try {
    if (!require('../config/feature-gates').portalAskPushLive?.()) return { skipped: 'gate_off' };
    if (!itemKey || !title) return { skipped: 'incomplete' };
    const { triggerNotification } = require('./notification-triggers');
    const payload = {
      itemKey: String(itemKey), title, body, ...(link ? { link } : {}), ...(customerId ? { customerId: String(customerId) } : {}),
    };
    const result = await withDeadline(triggerNotification('portal_ask', payload, { pushOnly: true }));
    if (result === TIMED_OUT) {
      logger.error(`[portal-ask-push] push timed out after ${PUSH_DEADLINE_MS}ms for ${String(itemKey).slice(0, 60)} - delivery ambiguous`);
      return { sent: false, timedOut: true };
    }
    return { sent: true, result: result || null };
  } catch (err) {
    logger.error(`[portal-ask-push] push failed for ${String(itemKey).slice(0, 60)}: ${err?.message || 'error'}`);
    return { sent: false, error: err?.message || 'error' };
  }
}

module.exports = { pushPortalAsk, shortName, customerShortName, PUSH_DEADLINE_MS };
