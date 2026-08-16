/**
 * Customer-scoped advisory lock for collection-case state decisions
 * (PR C / codex gh-r5).
 *
 * The case lifecycle has three writers that can race per customer: the
 * shadow sweep's rotation/self-heal, the auto-dial sweep's promote, and
 * the supervised endpoint's promote. Row-level fences (state + version)
 * stop lost-update overwrites, but the CUSTOMER-level decision — "is any
 * case live before I rotate/promote another one?" — spans a read and a
 * write, and no row fence can make that span atomic. Same
 * pg_advisory_xact_lock(hashtext, hashtext) idiom as triage-locks and the
 * voicemail reservation: the second writer waits, re-reads inside the
 * lock, and sees the first writer's committed truth.
 */

const db = require('../../models/db');

async function withCaseLock(customerId, fn) {
  return db.transaction(async (trx) => {
    await trx.raw(
      'SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))',
      ['collections_case', String(customerId)],
    );
    return fn(trx);
  });
}

module.exports = { withCaseLock };
