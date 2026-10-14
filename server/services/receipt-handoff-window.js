/**
 * How long a receipt send must keep its locks once a provider request has started: the provider
 * client's OWN timeout plus a margin, read from the clients themselves (never a guessed number), so a
 * request that starts near the end of the send lock's lease or the operator claim's staleness window is
 * not cut loose while it may still be in flight.
 *
 *   email  SendGrid: sendgrid-mail.js REQUEST_TIMEOUT_MS (every call aborts there)
 *   sms    Twilio SDK RequestClient's default request timeout (the client twilio.js builds sets none)
 *   app    APNs / FCM: their wall-clock request timeouts; FCM also fetches its access token first,
 *          under the same bound, so the longest App request is twice the larger of the two
 *
 * A call whose channel is unknown is given the longest window. The SMTP fallback (refused in production by
 * email-fallback-gate) uses nodemailer's own, much longer socket timeouts and is not
 * covered by this window.
 */
const MARGIN_MS = 30 * 1000;

const timeouts = {
  email: () => require('./sendgrid-mail').REQUEST_TIMEOUT_MS,
  sms: () => new (require('twilio/lib/base/RequestClient'))().defaultTimeout,
  app: () => 2 * Math.max(require('./apns').APNS_REQUEST_TIMEOUT_MS, require('./fcm').FCM_REQUEST_TIMEOUT_MS),
};

function providerTimeoutMs(channel) {
  const read = timeouts[channel];
  const values = (read ? [read()] : Object.values(timeouts).map((fn) => fn()));
  if (!values.every((ms) => Number.isFinite(ms) && ms > 0)) throw new Error(`no provider timeout known for ${channel || 'receipt'} sends`);
  return Math.max(...values);
}

const handoffWindowMs = (channel) => providerTimeoutMs(channel) + MARGIN_MS;

module.exports = { handoffWindowMs, providerTimeoutMs, MARGIN_MS };
