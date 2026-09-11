const crypto = require('crypto');

const transactionQueues = new WeakMap();

// A caught SQL error still aborts PostgreSQL's transaction. Isolate each
// recoverable read before its caller applies a fallback. Explicit RELEASE
// also detects helpers that swallowed a query error internally.
// Await reads sequentially when they share a transaction: overlapping
// savepoints can otherwise roll back one another's work.
async function savepointRead(database, query) {
  if (!database.isTransaction) return query(database);
  const previous = transactionQueues.get(database) || Promise.resolve();
  const current = previous.catch(() => undefined).then(async () => {
    const name = `fail_soft_${crypto.randomBytes(6).toString('hex')}`;
    await database.raw(`SAVEPOINT ${name}`);
    try {
      const result = await query(database);
      await database.raw(`RELEASE SAVEPOINT ${name}`);
      return result;
    } catch (err) {
      await database.raw(`ROLLBACK TO SAVEPOINT ${name}`);
      await database.raw(`RELEASE SAVEPOINT ${name}`);
      throw err;
    }
  });
  transactionQueues.set(database, current);
  try {
    return await current;
  } finally {
    if (transactionQueues.get(database) === current) transactionQueues.delete(database);
  }
}

function failSoftRead(database, query, fallback) {
  return savepointRead(database, query).catch(() => fallback);
}

// A scope whose body performs its own savepoint reads on the same
// transaction (the appointment planner's fail-soft catalog, turf-profile and
// ordinance reads) must NOT join the per-transaction queue above: the body's
// inner reads would wait on the scope that contains them and the closeout
// would hang (#4113 packet round). Nested PostgreSQL savepoints are fine;
// only overlapping sibling reads need serializing. Callers await sequentially.
async function savepointScope(database, fn) {
  if (!database.isTransaction) return fn(database);
  const name = `scope_${crypto.randomBytes(6).toString('hex')}`;
  await database.raw(`SAVEPOINT ${name}`);
  try {
    const result = await fn(database);
    await database.raw(`RELEASE SAVEPOINT ${name}`);
    return result;
  } catch (err) {
    await database.raw(`ROLLBACK TO SAVEPOINT ${name}`);
    await database.raw(`RELEASE SAVEPOINT ${name}`);
    throw err;
  }
}

module.exports = { savepointRead, failSoftRead, savepointScope };
