/**
 * Waves Admin iPhone alert sounds: one sound per alert type.
 *
 * Maps a notification trigger key to the name of a sound file. The files ship
 * in the Waves Admin app bundle (ios/WavesPay/Resources/Sounds). The push
 * builders send the name as aps.sound; iOS plays its default sound when the
 * named file is missing from the app (an older app version), so the names are
 * safe to send before the app update reaches a phone.
 *
 * A trigger that is not listed sends no sound, and apns.js falls back to the
 * default sound. The admin's own Sound switch (notification_preferences
 * .sound_enabled) still wins: the builders ask for a sound only when it is on.
 */
const ALERT_SOUNDS = Object.freeze({
  sms_reply: 'waves-text.caf',
  portal_ask: 'waves-text.caf',
  messenger_reply: 'waves-text.caf',
  customer_missed_call: 'waves-missed-call.caf',
  promise_chaser: 'waves-missed-call.caf',
  relay_hot_lead: 'waves-missed-call.caf',
  customer_voicemail_callback: 'waves-voicemail.caf',
  new_lead: 'waves-lead.caf',
  bundle_quote_requested: 'waves-lead.caf',
  customer_email_received: 'waves-email.caf',
  sms_operational_followup: 'waves-reminder.caf',
  call_commitment_overdue: 'waves-reminder.caf',
  payment_failed: 'waves-payment-problem.caf',
  bill_payment_error: 'waves-payment-problem.caf',
});

function soundForTrigger(triggerKey) {
  return Object.prototype.hasOwnProperty.call(ALERT_SOUNDS, triggerKey) ? ALERT_SOUNDS[triggerKey] : null;
}

module.exports = { ALERT_SOUNDS, soundForTrigger };
