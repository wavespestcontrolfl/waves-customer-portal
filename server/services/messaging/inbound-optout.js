const db = require('../../models/db');
const { lockSmsPhone } = require('../../utils/customer-comms-lock');
const { toE164 } = require('../../utils/phone');
const { recordSuppression } = require('./validators/suppression');
const { markRecipientOptin } = require('../recipient-optin');

// A released webhook claim is retryable delivery, not new consent. Keep the
// application receipt separate from that claim and commit it with every STOP
// effect, so an old retry cannot undo a subsequent START.
async function applyInboundOptout({ messageSid, phone, customerId, reason, source, capturedBody }, dbh = db) {
  if (!messageSid) throw new Error('Inbound opt-out requires MessageSid');
  const canonicalPhone = toE164(phone);
  return dbh.transaction(async (trx) => {
    await lockSmsPhone(trx, canonicalPhone);
    const receipt = await trx('inbound_sms_optout_receipts').where({ message_sid: messageSid }).first();
    if (receipt) {
      if (receipt.phone !== canonicalPhone) throw new Error('Inbound opt-out receipt phone mismatch');
      return { applied: false };
    }
    const suppressed = await recordSuppression({ phone: canonicalPhone, reason, source, capturedBody, dbh: trx });
    if (suppressed?.ok === false) throw new Error('Inbound opt-out suppression failed');
    const declined = await markRecipientOptin(canonicalPhone, 'declined', { dbh: trx });
    if (declined === false) throw new Error('Inbound opt-out recipient decline failed');
    if (customerId) {
      await trx('notification_prefs').insert({ customer_id: customerId, sms_enabled: false })
        .onConflict('customer_id').merge({ sms_enabled: false });
    }
    await trx('inbound_sms_optout_receipts').insert({ message_sid: messageSid, phone: canonicalPhone });
    return { applied: true };
  });
}

module.exports = { applyInboundOptout };
