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

// Call under the existing mint lock. Packet creation takes those same locks
// before freezing its members, so a legacy writer cannot slip past a packet
// that has committed while the writer waited. Do not adopt the shared invoice
// into a member's old billing flow: that flow also owns delivery and credits.
async function assertScheduledInvoiceNotPacketOwned(trx, scheduledServiceId, packetId = null) {
  const scheduled = await trx('scheduled_services').where({ id: scheduledServiceId }).first('visit_id');
  const owner = scheduled?.visit_id
    ? await trx('visit_completion_packets').where({ visit_id: scheduled.visit_id }).first('id')
    : null;
  if (owner && owner.id !== packetId) {
    const err = new Error('This service is billed by its saved visit closeout. Resume that closeout.');
    err.status = 409;
    err.code = 'VISIT_PACKET_OWNS_BILLING';
    throw err;
  }
  if (packetId && owner?.id !== packetId) throw new Error('Visit invoice ownership mismatch');
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
// The ONE definition of "this visit already carries an invoice the mint
// would adopt": not void, not terminal. Applied to an `invoices` query.
// Shared with the Invoices page picker feed, which must not offer a visit
// the linked create would refuse as visit_already_invoiced.
function scopeAdoptableScheduledInvoices(query) {
  return query
    .whereNot('status', 'void')
    .whereNotIn('status', TERMINAL_INVOICE_STATUSES);
}

async function findAdoptableScheduledInvoice(trx, scheduledServiceId) {
  await assertScheduledInvoiceNotPacketOwned(trx, scheduledServiceId);
  return scopeAdoptableScheduledInvoices(trx('invoices').where({ scheduled_service_id: scheduledServiceId }))
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
// expectedDepositCredit: the PENDING estimate deposit the caller previewed
// to the operator (the Invoices page "Balance due" credits it, capped at
// the total). The pending amount read under the lock must match it to the
// cent, or the customer is sent a different balance than the operator
// approved (GitHub P1 #4131: another invoice consumed the deposit, a refund
// moved it, or the uncredited final attempt below applies none). It is the
// deposit that is compared — never the applied (total-capped) credit: the
// server total carries verified tax exemptions and county rates the form
// preview does not, so a cap comparison would refuse a tax-exempt customer
// on every retry (pre-push P1). A mismatch is terminal — 409
// DEPOSIT_CREDIT_CHANGED thrown inside the transaction before anything is
// created; the caller re-previews and tries again. Null = no expectation
// (every other caller).
// expectedBalanceDue: the BALANCE the caller previewed (GitHub P1 #4131 r2).
// The deposit check above cannot see a total that differs from the
// caller's preview — InvoiceService.create computes the authoritative
// after-tax total (county rate, verified exemption, third-party payer) and
// caps the applied credit against it, while the Invoices page previews a
// flat 7% — so a matching deposit can still deliver a different balance
// than the operator approved. The created row's `total` IS that balance
// (create nets the applied credit into it); it is compared to the cent
// INSIDE the transaction, and a mismatch throws 409 BALANCE_CHANGED
// carrying the authoritative figures, rolling the create back — the caller
// shows them and re-submits with the confirmed balance. Null = no
// expectation.
const centsDiffer = (a, b) => Math.round((Number(a) || 0) * 100) !== Math.round((Number(b) || 0) * 100);

// Money-validation step 1 — the PAYER-ELIGIBLE pending deposit under the
// lock (pre-push P1): InvoiceService.create applies no homeowner deposit
// when a third-party Bill-To resolves, and the Invoices page previews zero
// there through the same resolver — so the expectation is compared against
// zero when a payer resolves under the lock, and a payer assigned since a
// non-zero preview refuses. Same resolver, same fail-soft-to-self-pay
// contract as the create itself. Only resolved when a preview is being
// checked and there is a deposit to check.
async function payerEligiblePendingDeposit(trx, { svc, lockedSvc, depositCredit, expectedDepositCredit }) {
  const pendingAmount = depositCredit ? Number(depositCredit.amount) || 0 : 0;
  if (expectedDepositCredit == null || pendingAmount <= 0) return pendingAmount;
  const { resolveForInvoice } = require('./payer');
  // Fail closed like every other payer resolution on this path: a fail-soft
  // self-pay answer here would let the deposit preview pass on a stale payer.
  const payer = await resolveForInvoice({ database: trx, customerId: lockedSvc.customer_id || svc.customer_id || null, scheduledServiceId: svc.id, throwOnError: true });
  return payer?.payerId ? 0 : pendingAmount;
}

// Step 2 — the pending deposit must match the preview to the cent, or the
// customer is sent a different balance than the operator approved (GitHub
// P1 #4131). Terminal 409 thrown before anything is created.
function assertDepositMatchesPreview(pendingAmount, expectedDepositCredit) {
  if (expectedDepositCredit == null || !centsDiffer(pendingAmount, expectedDepositCredit)) return;
  const e = new Error(`The deposit credit changed while this invoice was being created (previewed $${Number(expectedDepositCredit).toFixed(2)}, now $${pendingAmount.toFixed(2)}) — nothing was created. Reload the visit and try again.`);
  e.status = 409;
  e.code = 'DEPOSIT_CREDIT_CHANGED';
  e.expectedDepositCredit = Number(expectedDepositCredit);
  e.pendingDepositCredit = pendingAmount;
  throw e;
}

// Step 3 — the created row's authoritative balance must match the preview
// (GitHub P1 #4131 r2): create nets the total-capped credit into `total`,
// so `total` IS the balance the customer would be billed. A mismatch throws
// inside the transaction (the create rolls back) carrying the real figures
// for the caller to show and confirm.
function assertBalanceMatchesPreview(created, expectedBalanceDue) {
  if (expectedBalanceDue == null) return;
  const balanceDue = Number(created?.total) || 0;
  if (!centsDiffer(balanceDue, expectedBalanceDue)) return;
  const effective = Number(created?.applied_deposit_credit) || 0;
  const e = new Error(`The balance this invoice would bill ($${balanceDue.toFixed(2)}) differs from the one previewed ($${Number(expectedBalanceDue).toFixed(2)}) — the customer's tax or exemption on file changes the total. Nothing was created; the summary now shows the balance that would be sent — review it and click Create again to send it.`);
  e.status = 409;
  e.code = 'BALANCE_CHANGED';
  e.expectedBalanceDue = Number(expectedBalanceDue);
  e.balanceDue = balanceDue;
  e.invoiceTotal = Math.round((balanceDue + effective) * 100) / 100;
  e.appliedDepositCredit = effective;
  throw e;
}

// Step 4 — consume from the ledger exactly what the invoice absorbed.
async function consumeAppliedDeposit(trx, { created, sourceEstimateId }) {
  const effective = Number(created?.applied_deposit_credit) || 0;
  if (effective <= 0) return;
  const { consumeDepositCredit } = require('../services/estimate-deposits');
  const allocated = await consumeDepositCredit({ estimateId: sourceEstimateId, amount: effective, invoiceId: created.id, trx });
  if (centsDiffer(allocated, effective)) {
    throw new Error(`deposit allocation mismatch (applied ${effective}, allocated ${allocated})`);
  }
}

async function mintScheduledServiceInvoiceWithDeposit({
  svc, buildCreateParams, assertEligibleInTrx = null, allowPriceMovement = false, expectedDepositCredit = null,
  expectedBalanceDue = null,
}) {
  const InvoiceService = require('../services/invoice');
  const { pendingDepositCredit } = require('../services/estimate-deposits');
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
          visitColumns: ['id', 'customer_id', 'estimated_price', 'primary_line_price'],
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
        // Serialize against markDepositReceived (Codex round 14 P1 #4131):
        // pendingDepositCredit is a plain SELECT and the deposit-received
        // writer runs as an entirely independent transaction, so without a
        // shared lock a deposit could settle right after this read and
        // right before the mint's own commit — the zero-credit check would
        // pass, consumeAppliedDeposit would skip (nothing to apply), and a
        // full-balance invoice would go out beside the newly received
        // deposit. This lock is acquired FIRST, so a concurrent receipt
        // either already committed (this read sees it) or waits behind
        // this transaction (and sees it on its own read, after this mint
        // commits or rolls back).
        if (withDeposit) {
          const { acquireEstimateDepositLedgerLock } = require('../services/estimate-deposits');
          await acquireEstimateDepositLedgerLock(trx, sourceEstimateId);
        }
        const depositCredit = withDeposit
          ? await pendingDepositCredit(sourceEstimateId, trx)
          : null;
        // The money-validation flow, in order: payer-eligible pending
        // deposit → deposit-vs-preview → create → balance-vs-preview →
        // ledger consume. Every refusal is thrown inside this transaction,
        // so nothing is created or consumed on a mismatch.
        const pendingAmount = await payerEligiblePendingDeposit(trx, { svc, lockedSvc, depositCredit, expectedDepositCredit });
        assertDepositMatchesPreview(pendingAmount, expectedDepositCredit);
        const created = await InvoiceService.create({
          ...buildCreateParams(),
          database: trx,
          ...(depositCredit && Number(depositCredit.amount) > 0
            ? { depositCredit: { amount: depositCredit.amount, estimateId: sourceEstimateId } }
            : {}),
        });
        assertBalanceMatchesPreview(created, expectedBalanceDue);
        await consumeAppliedDeposit(trx, { created, sourceEstimateId });
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
        // An operator-previewed create never takes the uncredited fallback
        // (GitHub r6 P1 #4131): the third attempt reads no ledger, so a
        // deposit paid after a successful zero preview would be compared
        // against a synthesized zero — the stale preview accepted and a
        // full-balance invoice sent over the new deposit. The ledger could
        // not be verified twice: refuse terminally, nothing created; the
        // door-collection callers (no preview) keep the fallback.
        if (expectedDepositCredit != null) throw depositLedgerUnverifiableError(err);
      }
    }
  }
  throw lastErr; // defensive — the uncredited final attempt returns or rethrows above
}

function depositLedgerUnverifiableError(cause) {
  const e = new Error(`The estimate deposit could not be verified while this invoice was being created (${cause?.message || cause}) — nothing was created. Reload the visit and try again.`);
  e.status = 409;
  e.code = 'DEPOSIT_CREDIT_UNVERIFIABLE';
  return e;
}

module.exports = {
  SCHEDULED_SERVICE_INVOICE_MINT_LOCK,
  scopeAdoptableScheduledInvoices,
  TERMINAL_INVOICE_STATUSES,
  acquireScheduledInvoiceMintLock,
  assertScheduledInvoiceNotPacketOwned,
  acquireScheduledMintLockChain,
  findAdoptableScheduledInvoice,
  adoptScheduledInvoiceUnderMintLock,
  scheduledPriceMovedError,
  mintScheduledServiceInvoiceWithDeposit,
};
