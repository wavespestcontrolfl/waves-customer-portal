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
// Cents-exact comparison of two nullable money values; undefined on the
// caller side means "field not selected" and never trips the guard.
function priceMovedBetween(callerSvc, lockedSvc, col) {
  if (callerSvc[col] === undefined) return false;
  const cents = (v) => (v === null || v === undefined ? null : Math.round(Number(v) * 100));
  return cents(callerSvc[col]) !== cents(lockedSvc[col]);
}

// The ONE advisory-lock namespace every scheduled-service invoice writer
// keys on. Key derivation must stay byte-identical across the writers or
// they silently stop contending — import these helpers, never re-declare
// the raw lock statement (codex #3344 r8 P1).
const SCHEDULED_SERVICE_INVOICE_MINT_LOCK = 'schedule.invoice.mint';

// Terminal invoices (refunded/cancelled — every payment route rejects them)
// are never replay/adoption candidates: returning one would resurrect a dead
// invoice the caller's reuse filter just skipped, instead of minting the
// replacement. 'void' is excluded by its own whereNot below (kept as the
// historical two-clause shape so the query is byte-stable for the writers).
const TERMINAL_INVOICE_STATUSES = ['refunded', 'canceled', 'cancelled'];

async function acquireScheduledInvoiceMintLock(trx, scheduledServiceId) {
  await trx.raw(
    'SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))',
    [SCHEDULED_SERVICE_INVOICE_MINT_LOCK, String(scheduledServiceId)],
  );
}

// The ONE lock chain every scheduled-price invoice writer takes, in the ONE
// order: advisory mint lock → customer KEY SHARE → (caller eligibility
// hook) → visit row FOR UPDATE.
// - Lock-order guard (codex r3 P1): the invoice insert's customer FK takes
//   KEY SHARE on the customer row AFTER we hold the visit row — while the
//   extension accept locks the customer FOR UPDATE at entry and THEN this
//   same visit row (ABBA deadlock). Take the customer key-share FIRST so
//   every scheduled-price path agrees: customer before scheduled service.
//   KEY SHARE is exactly the lock the FK would take anyway — hoisted, not
//   strengthened. In the derived form, the subquery read of the visit row
//   locks nothing (locking clauses don't reach subqueries), so the visit
//   lock below is still the first one.
// - assertEligibleInTrx runs AFTER the key-share, BEFORE the visit lock —
//   the Charge Now ownership recheck reads (and may lock) the visit row,
//   which would re-invert the order this chain exists to hold.
// - Visit row FOR UPDATE (WaveGuard #3338 fast-follow): the advisory lock
//   only serializes mint-vs-mint; THIS lock serializes mint-vs-reprice
//   (the extension apply holds FOR UPDATE on the rows it rewrites from
//   before its probe until its savepoint commits). Taken before any
//   replay/reuse re-check so ordering holds for adoption too.
async function acquireScheduledMintLockChain(trx, {
  scheduledServiceId, customerId = null, assertEligibleInTrx = null, visitColumns = ['id'],
}) {
  await acquireScheduledInvoiceMintLock(trx, scheduledServiceId);
  if (customerId != null) {
    await trx.raw(
      'SELECT id FROM customers WHERE id = ? FOR KEY SHARE',
      [customerId],
    );
  } else {
    await trx.raw(
      'SELECT id FROM customers WHERE id = (SELECT customer_id FROM scheduled_services WHERE id = ?) FOR KEY SHARE',
      [scheduledServiceId],
    );
  }
  if (assertEligibleInTrx) await assertEligibleInTrx(trx);
  return trx('scheduled_services')
    .where({ id: scheduledServiceId })
    .forUpdate()
    .first(...visitColumns);
}

// The ONE stale-price refusal every scheduled-price writer throws (codex
// #3344 r9 P1 — the error shape was hand-rolled in two modules). Terminal
// for retry loops (err.status); currentEstimatedPriceCents is the price
// the lock proved current — the dispatch REQUIRED-mint catch refreshes its
// frozen mint cents from it so the released resume bills the moved price.
function scheduledPriceMovedError(lockedSvc) {
  const cents = (v) => (v === null || v === undefined ? null : Math.round(Number(v) * 100));
  const e = new Error('Scheduled service was repriced while minting — retry to bill the current price');
  e.status = 409;
  e.code = 'SCHEDULED_PRICE_MOVED';
  e.currentEstimatedPriceCents = cents(lockedSvc.estimated_price);
  // The locked PRIMARY line price rides along when the caller selected it
  // (r9-round pre-push P0): estimated_price is the WHOLE bill only when no
  // primary line exists — invoice lines PREFER primary_line_price, so a
  // primary-only reprice moves the true total while estimated_price stands
  // still. The dispatch frozen-resume catch keys off this to refuse
  // freezing a single-line figure for a primary-carrying visit.
  if ('primary_line_price' in lockedSvc) {
    e.currentPrimaryLinePriceCents = cents(lockedSvc.primary_line_price);
  }
  return e;
}

// Replay = the double-tap window returning the FIRST request's fresh
// invoice; adoption = a replay transaction waking under the mint lock to
// find another writer (Charge Now / completion mint) already committed one.
// Same predicate either way — the ONE terminal-status filter.
function findAdoptableScheduledInvoice(trx, scheduledServiceId) {
  return trx('invoices')
    .where({ scheduled_service_id: scheduledServiceId })
    .whereNot('status', 'void')
    .whereNotIn('status', TERMINAL_INVOICE_STATUSES)
    .orderBy('created_at', 'desc')
    .first();
}

// Take the mint lock, adopt whatever non-terminal invoice landed first.
// Adoption metadata (codex r6 P1): callers must be able to tell an adopted
// concurrent invoice from one their call created — dispatch keys its
// back-link, setup-fee restore, and already-paid messaging off it.
// Transient JS property, never persisted.
async function adoptScheduledInvoiceUnderMintLock(trx, scheduledServiceId) {
  await acquireScheduledInvoiceMintLock(trx, scheduledServiceId);
  const replayed = await findAdoptableScheduledInvoice(trx, scheduledServiceId);
  return replayed ? { ...replayed, adopted_existing_invoice: true } : null;
}

// allowPriceMovement: the frozen-money-truth resume lanes (dispatch REQUIRED
// backfill mints) bill a FROZEN amount by design — by-now-mutable row fields
// must not block that mint (lost AR). Everyone else fails closed: a 409 with
// code SCHEDULED_PRICE_MOVED means the visit was repriced (the WaveGuard
// tier-extension apply holds FOR UPDATE on the rows it rewrites) between the
// caller's read and this lock — retrying re-reads and bills the current
// price instead of silently minting the stale one.
async function mintScheduledServiceInvoiceWithDeposit({
  svc, buildCreateParams, assertEligibleInTrx = null, allowPriceMovement = false,
}) {
  const InvoiceService = require('../services/invoice');
  const { pendingDepositCredit, consumeDepositCredit } = require('../services/estimate-deposits');
  const sourceEstimateId = svc.source_estimate_id || null;
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const withDeposit = attempt < 2 && !!sourceEstimateId;
    try {
      return await db.transaction(async (trx) => {
        // The shared lock chain (advisory → customer key-share → caller
        // eligibility hook → visit FOR UPDATE). The hook is the caller's
        // in-lock authorization recheck (technician ownership): the
        // caller's pre-transaction SELECT alone leaves a window where
        // dispatch reassigns the visit before this lock lands, letting the
        // FORMER tech mint and receive the invoice's bearer payment token.
        const lockedSvc = await acquireScheduledMintLockChain(trx, {
          scheduledServiceId: svc.id,
          assertEligibleInTrx,
          visitColumns: ['id', 'estimated_price', 'primary_line_price'],
        });
        if (!lockedSvc) {
          const e = new Error('Scheduled service not found');
          e.status = 404;
          throw e;
        }
        const replayed = await findAdoptableScheduledInvoice(trx, svc.id);
        if (replayed) return { invoice: replayed, reused: true };
        // Stale-price refusal — CREATE only (an adopted replay invoice is
        // the extension probe/re-probe's problem, handled there). Both
        // price columns matter: invoice lines PREFER primary_line_price
        // when present. err.status makes the failure terminal for the
        // retry loop below — retrying the same stale params can't fix it.
        if (!allowPriceMovement
          && (priceMovedBetween(svc, lockedSvc, 'estimated_price')
            || priceMovedBetween(svc, lockedSvc, 'primary_line_price'))) {
          throw scheduledPriceMovedError(lockedSvc);
        }
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

module.exports = {
  SCHEDULED_SERVICE_INVOICE_MINT_LOCK,
  TERMINAL_INVOICE_STATUSES,
  acquireScheduledInvoiceMintLock,
  acquireScheduledMintLockChain,
  findAdoptableScheduledInvoice,
  adoptScheduledInvoiceUnderMintLock,
  scheduledPriceMovedError,
  mintScheduledServiceInvoiceWithDeposit,
};
