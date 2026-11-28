'use strict';

/**
 * Runs an optional DB read inside a nested SAVEPOINT when `conn` is already a
 * Postgres transaction (`conn.isTransaction === true`), so a caught SQL error
 * rolls back only the savepoint instead of leaving the outer transaction
 * aborted (`25P02`) for every subsequent statement.
 */
function savepointRead(conn, fn) {
  return conn && conn.isTransaction && typeof conn.transaction === 'function'
    ? conn.transaction((sp) => fn(sp))
    : fn(conn);
}

module.exports = { savepointRead };
