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

module.exports = { savepointRead };
