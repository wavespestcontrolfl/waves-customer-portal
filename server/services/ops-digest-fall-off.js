/**
 * Fall-off rule for the in-process digest senders (owner 2026-09-11):
 * when a sender's tick finds NOTHING to report, the standing ops_digest
 * rows it raised earlier (same opsKey) retire — read + metadata.resolved,
 * kept as history, shown as "cleared" in Agents → Activity. Before this,
 * lead-to-cash / promised-quotes / unworked-comms stacked one unread row
 * per morning with no way to fall off.
 *
 * Call it ONLY from a branch that means "the check ran and found nothing" —
 * never from query_failed / gated / already-sent-today branches, which mean
 * the check did not run. Resolved at call time through the ops-digest
 * module (test suites stub that module; a stub without resolveOpsDigest
 * reads as a no-op). Never throws, never blocks the sender: a failed retire
 * is logged inside resolveOpsDigest and retried on the next clean tick.
 */
async function retireIfClean(key, { resolvedBy } = {}) {
  try {
    const opsDigest = require('./ops-digest');
    if (typeof opsDigest.resolveOpsDigest !== 'function') return 0;
    return await opsDigest.resolveOpsDigest({ key, resolvedBy: resolvedBy || `${key}:clean-run` });
  } catch {
    return 0;
  }
}

module.exports = { retireIfClean };
