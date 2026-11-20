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

// A callback originating inside a savepoint must wait for the outer commit,
// but must also be suppressed when any savepoint in its own chain rolled back
// and the parent caught that error.
function transactionChain(trx) {
  const chain = [];
  for (let current = trx, hops = 0;
    current && hops < 32;
    current = current.parentTransaction, hops += 1) {
    chain.push(current);
  }
  return chain;
}

function outermostTransaction(trx) {
  const chain = transactionChain(trx);
  return chain.length ? chain[chain.length - 1] : trx;
}

function afterCommit(trx, fn) {
  const promises = transactionChain(trx)
    .map((current) => current.executionPromise)
    .filter((promise) => promise && typeof promise.then === 'function');
  if (promises.length) Promise.all(promises).then(fn).catch(() => {});
  else Promise.resolve().then(fn).catch(() => {});
}

module.exports = {
  commitPromiseOf,
  transactionChain,
  outermostTransaction,
  afterCommit,
};
