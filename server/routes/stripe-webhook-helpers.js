/**
 * Pure helpers for the Stripe webhook route — no DB, no Stripe SDK.
 * Exists so the audit unit tests can pin the duplicate-event decision
 * matrix without faking Knex.
 */

// How long we'll wait for an in-flight worker to finish before treating
// its claim as stale. A worker that crashes between claim and either
// processed=true / error=set leaves the row stuck at processed=false +
// error=null; without a stale-claim window, every Stripe retry would
// land on the in-flight 503 path forever and the event would never be
// re-applied. 5 minutes is comfortably above the longest realistic
// handler runtime (a few seconds) but short enough that a crashed
// worker's row is recoverable on Stripe's first or second retry.
const STALE_CLAIM_WINDOW_MS = 5 * 60 * 1000;

/**
 * Decide what to do when our atomic INSERT … ON CONFLICT DO NOTHING
 * claim loses (i.e. a row with this event.id already exists). Returns
 * one of:
 *   'duplicate' — already processed; reply 200 and skip.
 *   'reclaim'   — previous handler attempt failed (error recorded) OR
 *                 the row's received_at is older than the stale window
 *                 (worker likely crashed before writing error); try to
 *                 re-claim the row, run the handler again.
 *   'inflight'  — another worker is currently running the handler
 *                 within the stale window; reply 503 so Stripe retries.
 *
 * If the existing row is null (very rare — would mean ON CONFLICT lost
 * but the row vanished by the time we read it), we fall through to
 * 'inflight' so Stripe retries cleanly instead of double-running.
 */
function classifyExistingWebhookEvent(existing, { now = Date.now(), staleWindowMs = STALE_CLAIM_WINDOW_MS } = {}) {
  if (!existing) return 'inflight';
  if (existing.processed) return 'duplicate';
  if (existing.error) return 'reclaim';
  // No error recorded yet — could be a live worker mid-handler, or a
  // worker that crashed before its catch block fired. Use received_at
  // as the lease timestamp: anything older than the stale window is
  // assumed crashed and eligible for re-claim.
  const receivedAtMs = existing.received_at ? new Date(existing.received_at).getTime() : null;
  if (receivedAtMs && Number.isFinite(receivedAtMs) && (now - receivedAtMs) > staleWindowMs) {
    return 'reclaim';
  }
  return 'inflight';
}

module.exports = { classifyExistingWebhookEvent, STALE_CLAIM_WINDOW_MS };
