/**
 * Every active, non-deleted customer row (property profile) on the same
 * account as the signed-in customer — the primary profile plus each
 * additional property. Accepts the authenticated request (or any object
 * carrying accountId / customerId / customer) and returns the ids ordered
 * primary first. Shared by the notification and schedule routes so the
 * account-scoped reads agree on what "my properties" means.
 */
const db = require('../models/db');

async function accountPropertyIds(req, knex = db) {
  const accountId = req.accountId || req.customer?.account_id || req.customerId;
  const rows = await knex('customers')
    .where({ active: true })
    .whereNull('deleted_at')
    .where(function () {
      this.where({ account_id: accountId }).orWhere({ id: accountId });
    })
    .orderBy('is_primary_profile', 'desc')
    .select('id');
  return rows.map((r) => r.id);
}

// Appointment delivery preferences belong to the account's primary profile.
// Delivery decisions must request onError:'throw'; an unknown owner cannot
// authorize a different profile's preference. Routes retain their legacy fallback.
async function resolvePrimaryProfileId(req, knex = db, { onError = 'fallback' } = {}) {
  const accountId = req.accountId || req.customer?.account_id || req.customerId;
  if (!accountId) return req.customerId;
  const primary = await knex('customers')
    .where({ account_id: accountId, is_primary_profile: true })
    .first('id')
    .catch((err) => {
      if (onError === 'throw') throw err;
      return null;
    });
  return primary?.id || req.customerId;
}

module.exports = { accountPropertyIds, resolvePrimaryProfileId };
