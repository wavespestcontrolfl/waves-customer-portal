/**
 * Hosts whose links go BARE (scheme-less) in SMS — owner directive
 * 2026-08-01: dropping "https://" saves 8 characters per link and SMS
 * clients autolink a bare domain they recognize. Deliberately scoped to
 * hosts we own; every third-party link keeps its scheme (an unfamiliar
 * bare host may not render tappable).
 *
 * Single source of truth: the SMS template renderer
 * (routes/admin-sms-templates.js stripPortalUrlScheme) strips schemes with
 * this list, and comms-lint exempts the same hosts from its bare-host
 * rule — importing from here is what keeps the renderer and the lint from
 * ever disagreeing about which side of the rule a host is on.
 */
const SCHEMELESS_SMS_HOSTS = [
  'portal.wavespestcontrol.com',
  'waves-customer-portal-production.up.railway.app',
];

module.exports = { SCHEMELESS_SMS_HOSTS };
