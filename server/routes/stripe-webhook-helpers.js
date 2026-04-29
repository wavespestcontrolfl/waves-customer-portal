/**
 * Pure helpers for the Stripe webhook route — no DB, no Stripe SDK.
 * Exists so the audit unit tests can pin the duplicate-event decision
 * matrix without faking Knex.
 */

/**
 * Decide what to do when our atomic INSERT … ON CONFLICT DO NOTHING
 * claim loses (i.e. a row with this event.id already exists). Returns
 * one of:
 *   'duplicate' — already processed; reply 200 and skip.
 *   'reclaim'   — previous handler attempt failed (error recorded);
 *                 try to re-claim the row, run the handler again.
 *   'inflight'  — another worker is currently running the handler;
 *                 reply 503 so Stripe retries later.
 *
 * If the existing row is null (very rare — would mean ON CONFLICT lost
 * but the row vanished by the time we read it), we fall through to
 * 'inflight' so Stripe retries cleanly instead of double-running.
 */
function classifyExistingWebhookEvent(existing) {
  if (!existing) return 'inflight';
  if (existing.processed) return 'duplicate';
  if (existing.error) return 'reclaim';
  return 'inflight';
}

module.exports = { classifyExistingWebhookEvent };
