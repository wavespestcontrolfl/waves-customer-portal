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

module.exports = { accountPropertyIds };
