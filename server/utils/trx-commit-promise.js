'use strict';

/**
 * The promise that settles when a knex transaction's OUTERMOST transaction
 * commits (or rejects on rollback). A nested transaction (savepoint) has
 * its own executionPromise that resolves when the savepoint is released —
 * long before the enclosing transaction commits — so after-commit hooks
 * (broadcasts, seams, event emits) attached to it can observe uncommitted
 * or later-rolled-back state (codex #3590 r14). knex links nested
 * transactors to their parent via `parentTransaction`; walk to the root.
 *
 * Returns null when `trx` is not a transaction (or lacks a promise).
 */
function commitPromiseOf(trx) {
  let cur = trx;
  while (cur && cur.parentTransaction) cur = cur.parentTransaction;
  return cur && cur.executionPromise ? cur.executionPromise : null;
}

module.exports = { commitPromiseOf };
