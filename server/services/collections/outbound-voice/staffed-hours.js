/**
 * Staffed-hours check for the collections voice lane — 9:00–17:59 ET,
 * Monday–Friday, via the ONE call-window predicate the contact policy
 * enforces (server/services/collections/contact-policy.js). Inside the
 * window a press-0 / "human" escape warm-transfers to the office; outside
 * it the caller gets a callback task instead. The escape hatch itself is
 * ALWAYS available — only the transfer-vs-callback branch moves.
 *
 * `supervised` (an admin-approved case) lets the owner-run shakedown
 * override open staffed hours too, so a press-0 on a hand-dialed test call
 * reaches the transfer branch instead of the after-hours callback copy.
 * Autodial cases stay on the real clock.
 */

const ContactPolicy = require('../contact-policy');

function isStaffedHours(now = new Date(), { supervised = false } = {}) {
  return ContactPolicy.isWithinCallWindow(now, { supervised });
}

module.exports = { isStaffedHours };
