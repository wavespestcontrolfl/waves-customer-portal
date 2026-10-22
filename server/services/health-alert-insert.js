const db = require('../models/db');
const logger = require('./logger');

// A merge can retire a customer between the moment a writer reads its id and
// the moment it inserts the alert (Codex #6431 r4). executeMerge holds both
// customer rows FOR UPDATE while it re-points customer_health_alerts, then
// soft-deletes the loser. An unfenced insert with the loser's id can land
// after the re-point and stay on the retired profile, where staff acting on
// it would work the wrong record.
//
// insertHealthAlert takes the same lock in share mode first, so it waits for
// an in-flight merge (or undo) and then reads the outcome:
//   - customer live: insert as given.
//   - customer merged away: follow customer_merge_journal to the live winner
//     and insert there. A billing or payment alert must not be lost.
//   - customer deleted for any other reason: skip, log, return null.
// A row with no customer_id has nothing to fence and inserts as given.
//
// With opts.trx the fence and insert run in the caller's transaction (its
// error handling is the caller's). Without it they run in their own short
// transaction. Returns the inserted row, or null when skipped.
const MAX_MERGE_HOPS = 5;

async function resolveLiveCustomerId(trx, customerId) {
  let id = customerId;
  for (let hop = 0; hop <= MAX_MERGE_HOPS; hop += 1) {
    const live = await trx('customers').where({ id }).whereNull('deleted_at').forShare().first('id');
    if (live) return live.id;
    const merge = await trx('customer_merge_journal')
      .where({ loser_customer_id: id })
      .whereNull('undone_at')
      .orderBy('created_at', 'desc')
      .first('winner_customer_id');
    if (!merge || !merge.winner_customer_id) return null;
    id = merge.winner_customer_id;
  }
  return null;
}

async function insertFenced(trx, row) {
  if (!row.customer_id) {
    const [inserted] = await trx('customer_health_alerts').insert(row).returning('*');
    return inserted || null;
  }
  const liveId = await resolveLiveCustomerId(trx, row.customer_id);
  if (!liveId) {
    logger.warn(`[health-alert] skipped "${row.alert_type}" alert: customer ${row.customer_id} is deleted and has no live merge winner`);
    return null;
  }
  if (liveId !== row.customer_id) {
    logger.info(`[health-alert] "${row.alert_type}" alert for merged customer ${row.customer_id} filed on winner ${liveId}`);
  }
  const [inserted] = await trx('customer_health_alerts')
    .insert({ ...row, customer_id: liveId })
    .returning('*');
  return inserted || null;
}

async function insertHealthAlert(row, { trx } = {}) {
  if (trx) return insertFenced(trx, row);
  return db.transaction((ownTrx) => insertFenced(ownTrx, row));
}

module.exports = { insertHealthAlert, MAX_MERGE_HOPS };
