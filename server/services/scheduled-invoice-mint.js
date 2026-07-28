/**
 * scheduled-invoice-mint — the ONE transaction-aware, advisory-locked
 * find-or-create for a scheduled visit's invoice. Moved verbatim from
 * routes/admin-schedule.js (gate-removal round 4) so the dispatch
 * completion mint can share it — route files don't import each other, and
 * a byte-divergent copy of the lock key would silently stop contending.
 * Every scheduled-service invoice writer (Charge Now, checkout tender
 * sheets, pre-completion mint, the live typed one-time completion mint)
 * serializes on the SAME two-key advisory lock ['schedule.invoice.mint',
 * svc.id]; create() runs on the lock transaction's own connection
 * (database: trx), so no second pooled connection is held while the lock
 * transaction is open.
 */
const db = require('../models/db');
const logger = require('./logger');

// Shared pre-completion mint: advisory-lock + replay-check + create, WITH the
// estimate-deposit roll-forward. Completion REUSES a pre-minted invoice instead
// of calling InvoiceService.createFromService (the only other roll-forward
// site), so a mint here that skips the deposit credit permanently strands the
// customer's paid deposit — accepted estimates are deliberately outside the
// terminal-refund sweep — and the visit double-collects (deposit + full price).
// Same discipline as createFromService: request the full unapplied balance,
// let create() cap it against the after-tax total, consume exactly the
// effective amount in the SAME transaction; a mismatch throws (the mint rolls
// back), one retry re-reads the fresh balance, and a second failure falls back
// to an UNCREDITED mint + reconcile alert — deposit machinery failures never
// block door collection. The advisory lock serializes the two mint callers
// (this helper's callers and Charge-now) so a double-tap can't race a visit
// into two open invoices; the in-lock re-check returns the first request's
// invoice to the replay.
async function mintScheduledServiceInvoiceWithDeposit({ svc, buildCreateParams, assertEligibleInTrx = null }) {
  const InvoiceService = require('../services/invoice');
  const { pendingDepositCredit, consumeDepositCredit } = require('../services/estimate-deposits');
  const sourceEstimateId = svc.source_estimate_id || null;
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const withDeposit = attempt < 2 && !!sourceEstimateId;
    try {
      return await db.transaction(async (trx) => {
        await trx.raw(
          'SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))',
          ['schedule.invoice.mint', String(svc.id)],
        );
        // Caller-supplied in-lock authorization recheck (technician
        // ownership): the caller's pre-transaction SELECT alone leaves a
        // window where dispatch reassigns the visit before this lock
        // lands, letting the FORMER tech mint and receive the invoice's
        // bearer payment token.
        if (assertEligibleInTrx) await assertEligibleInTrx(trx);
        // Replay = the double-tap window returning the FIRST request's fresh
        // invoice. Terminal invoices (refunded/cancelled — every payment
        // route rejects them) are not replay candidates: returning one here
        // would resurrect a dead invoice the caller's reuse filter just
        // skipped, instead of minting the replacement.
        const replayed = await trx('invoices')
          .where({ scheduled_service_id: svc.id })
          .whereNot('status', 'void')
          .whereNotIn('status', ['refunded', 'canceled', 'cancelled'])
          .orderBy('created_at', 'desc')
          .first();
        if (replayed) return { invoice: replayed, reused: true };
        const depositCredit = withDeposit
          ? await pendingDepositCredit(sourceEstimateId, trx)
          : null;
        const created = await InvoiceService.create({
          ...buildCreateParams(),
          database: trx,
          ...(depositCredit && Number(depositCredit.amount) > 0
            ? { depositCredit: { amount: depositCredit.amount, estimateId: sourceEstimateId } }
            : {}),
        });
        const effective = Number(created?.applied_deposit_credit) || 0;
        if (effective > 0) {
          const allocated = await consumeDepositCredit({
            estimateId: sourceEstimateId,
            amount: effective,
            invoiceId: created.id,
            trx,
          });
          if (Math.round(allocated * 100) !== Math.round(effective * 100)) {
            throw new Error(`deposit allocation mismatch (applied ${effective}, allocated ${allocated})`);
          }
        }
        return { invoice: created, reused: false };
      });
    } catch (err) {
      lastErr = err;
      // Authorization failures are terminal — retrying can't fix them.
      if (err.status) throw err;
      if (!withDeposit) throw err;
      logger.warn(`[schedule] mint deposit roll-forward failed for service ${svc.id} (attempt ${attempt + 1}): ${err.message}`);
      if (attempt === 1) {
        try {
          const { triggerNotification } = require('../services/notification-triggers');
          await triggerNotification('estimate_deposit_reconcile_needed', { estimateId: sourceEstimateId });
        } catch (notifyErr) {
          logger.error(`[schedule] failed to raise deposit reconcile alert: ${notifyErr.message}`);
        }
      }
    }
  }
  throw lastErr; // defensive — the uncredited final attempt returns or rethrows above
}

module.exports = { mintScheduledServiceInvoiceWithDeposit };
