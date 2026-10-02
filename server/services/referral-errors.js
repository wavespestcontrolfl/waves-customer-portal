/**
 * Referral-program error classification shared by the routes and the engine.
 *
 * referral_promoters.customer_phone is unique. enrollPromoter inserts the
 * customer's phone; when another customer on a DIFFERENT account already
 * holds that phone, resolvePromoter finds no same-account household promoter
 * and rethrows the Postgres unique violation (23505) rather than guess an
 * attribution. That is a data-ownership question for staff, not a server
 * failure — so the customer-facing routes answer it with "not enrolled"
 * (GET) or 409 (actions) instead of a 500. Sentry issue 7424336910 counted
 * 464 of these 500s between 2026-04-19 and 2026-10-01 on the portal home.
 */

const PHONE_UNIQUE_CONSTRAINT = 'referral_promoters_customer_phone_unique';

function isPromoterPhoneCollision(err) {
  if (!err || err.code !== '23505') return false;
  const where = String(err.constraint || err.detail || err.message || '');
  return where.includes(PHONE_UNIQUE_CONSTRAINT) || where.includes('customer_phone');
}

// Customer-facing copy for the blocked state. No phone number: PG's message
// quotes the conflicting value and must never reach the response.
const PHONE_COLLISION_MESSAGE =
  "Referral sharing isn't connected to this account yet. Text or call us and we'll link it for you.";
const PHONE_COLLISION_CODE = 'referral_phone_in_use';

module.exports = { isPromoterPhoneCollision, PHONE_COLLISION_MESSAGE, PHONE_COLLISION_CODE, PHONE_UNIQUE_CONSTRAINT };
