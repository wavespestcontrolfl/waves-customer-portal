/**
 * A bare "YES" text: opt-in or reply? (GATE_SMS_BARE_YES_REPLY, owner
 * 2026-10-29; weekly sweep #5007 finding B3.)
 *
 * YES is one of Twilio's opt-in keywords, so the inbound webhook has always
 * handled a bare YES like START: it clears suppression, turns texts back on,
 * replies "You've been re-subscribed…" and returns before the reply bell and
 * every inbound consumer. From a number that never opted out, that YES is an
 * answer ("Reply YES to book"), and the office never hears it.
 *
 * With the gate on, a bare YES stays an opt-in only while it can restore
 * something:
 *   - an active messaging_suppression row for the number (a STOP, a carrier
 *     21610, a staff do-not-text);
 *   - notification_prefs.sms_enabled = false on the matched customer;
 *   - an appointment-text recipient ask that this YES would confirm
 *     (recipient-optin.js yesWouldConfirmAsk: the same rows the webhook's
 *     markRecipientOptin('confirmed') writes).
 * Otherwise the webhook handles it as an ordinary reply. A failed lookup keeps
 * the opt-in, exactly as before the gate. START and the other opt-in keywords
 * never come here.
 */
const db = require('../../models/db');
const logger = require('../logger');
const { loadSuppressionState } = require('./validators/suppression');

async function bareYesIsReply({ phone, customerId = null, dbh = db }) {
  try {
    // loadSuppressionState only sets suppressionLoaded after a clean read, so
    // a missing table or a failed query stays an opt-in.
    const state = await loadSuppressionState({ to: phone }, {}, dbh);
    if (state.suppressionLoaded !== true || state.suppression) return false;
    if (customerId) {
      const prefs = await dbh('notification_prefs').where({ customer_id: customerId }).first('sms_enabled');
      if (prefs && prefs.sms_enabled === false) return false;
    }
    // Lazy: recipient-optin pulls in the send stack, and the webhook only
    // reaches this for a bare YES.
    if (await require('../recipient-optin').yesWouldConfirmAsk(phone, { dbh })) return false;
    return true;
  } catch (err) {
    logger.warn(`[sms-optin] bare YES check failed (${err.code || 'error'}); handling it as an opt-in`);
    return false;
  }
}

module.exports = { bareYesIsReply };
