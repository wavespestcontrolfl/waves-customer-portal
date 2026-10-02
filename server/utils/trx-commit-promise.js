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

/**
 * The executionPromise of `trx` and of every transaction enclosing it, inner
 * to outer. Each savepoint's resolves on RELEASE and rejects on ROLLBACK; the
 * root's on COMMIT / ROLLBACK. All resolving = the work really landed.
 */
function allCommitPromisesOf(trx) {
  const out = [];
  for (let cur = trx; cur; cur = cur.parentTransaction) {
    if (cur.executionPromise) out.push(cur.executionPromise);
  }
  return out;
}

/**
 * A commit scope for work done inside a SAVEPOINT that may be thrown away
 * (an insert kept only when it ends up grouped into another row's visit).
 * Post-commit hooks (coverage alerts, tier sync, shortfall bell) read only
 * `isTransaction` / `executionPromise` off the scope they are handed. Its
 * executionPromise resolves only after keep() AND every enclosing transaction
 * (savepoints included) completes successfully (a pool caller's savepoint has already committed by keep()); drop()
 * rejects it, so nothing is filed for rows that were rolled back. Shared by
 * accept-time riders (rider-accept-seeding.seedWithRide) and the series
 * extension (admin-schedule.js#extendSeriesOnceLocked).
 */
function deferredCommitScope(conn) {
  let keep;
  let drop;
  const kept = new Promise((resolve, reject) => { keep = resolve; drop = reject; });
  // EVERY enclosing transaction must succeed, not just the root: a savepoint
  // between this scope and the root can roll back while the root commits, and
  // its executionPromise is what rejects then.
  const chain = (conn && conn.isTransaction) ? allCommitPromisesOf(conn) : [];
  const executionPromise = kept.then(() => Promise.all(chain));
  executionPromise.catch(() => {});
  return { isTransaction: true, executionPromise, keep: () => keep(), drop: (err) => drop(err) };
}

module.exports = { commitPromiseOf, allCommitPromisesOf, deferredCommitScope };
