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
// The ONE canonical "this visit never ran and never will" status set
// (invoice-helpers.js — already shared by settlement/send/void refusal
// across admin-invoices.js, invoice-manual-payment.js, invoice-email.js,
// invoice-send-replay-eligibility.js and invoice.js itself). Mint-time
// refusal reuses it rather than hand-rolling a second list: 'completed' is
// deliberately absent (normal completion billing) and so is 'rescheduled'
// (a pending reschedule REQUEST parks the same row — not yet terminal).
const { VISIT_NEVER_RAN_STATUSES } = require('./invoice-helpers');

// Shared pre-completion mint: advisory-lock + replay-check + create, WITH the
// estimate-deposit roll-forward. Completion REUSES a pre-minted invoice instead
// of calling InvoiceService.createFromService (the only other roll-forward
// site), so a mint here that skips the deposit credit permanently strands the
// customer's paid deposit — accepted estimates are deliberately outside the
// terminal-refund sweep — and the visit double-collects (deposit + full price).
// Same discipline as createFromService: request the full unapplied balance,
// let create() cap it against the after-tax total, consume exactly the
// effective amount in the SAME transaction; a mismatch throws (the mint rolls
// back), one retry re-reads the fresh balance, and a second failure holds the
// mint for reconciliation rather than publishing an unknown full balance.
// The advisory lock serializes the two mint callers
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

// Codex round-6 P1 (pre-push): a sibling-coverage recheck reads coverage
// off the CALLER's pre-lock `svc.scheduled_date` (siblingCoverageRecheckInTrx,
// admin-schedule.js — the sibling lookup matches on customer + estimate +
// scheduled_date). If the visit is rescheduled to a different day between
// the resolver's initial read and this locked transaction, both the
// original verdict AND the "re-proven" recheck classify coverage against
// the STALE day's siblings — a sibling invoice that genuinely covered the
// OLD date says nothing about the visit's real new day, so an extras-only
// invoice could mint on a now-uncovered visit. Same undefined-means-
// not-selected contract as priceMovedBetween: a caller whose `svc` never
// carried scheduled_date (none do today, but future pure/unit callers
// might) skips the check rather than false-refusing.
function scheduledDateMovedBetween(callerSvc, lockedSvc) {
  if (callerSvc.scheduled_date === undefined) return false;
  const dateOnly = (v) => {
    if (v == null) return null;
    return (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10);
  };
  return dateOnly(callerSvc.scheduled_date) !== dateOnly(lockedSvc.scheduled_date);
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

// Non-blocking sibling of the above, same key — for a caller that already
// holds ONE visit's mint lock (or row lock) and needs another visit's mint
// lock too, where waiting could deadlock against a second transaction
// acquiring the same two locks in the opposite order (pre-push audit P1,
// "the re-price block": the 'following' sibling propagation holds the
// edited visit's mint lock while it takes each sibling's). pg_try_advisory_
// xact_lock never blocks — it returns immediately, true if the lock was
// free (now held, transaction-scoped like the blocking form) or already
// held by THIS same transaction (re-entrant), false if another transaction
// holds it. A caller that gets false must not proceed as if it held the
// lock; it should refuse the whole operation and let the operator retry.
async function tryAcquireScheduledInvoiceMintLock(trx, scheduledServiceId) {
  const result = await trx.raw(
    'SELECT pg_try_advisory_xact_lock(hashtext(?), hashtext(?::text)) AS acquired',
    [SCHEDULED_SERVICE_INVOICE_MINT_LOCK, String(scheduledServiceId)],
  );
  return result?.rows?.[0]?.acquired === true;
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
  // 'status' rides along on EVERY call regardless of the caller's own
  // visitColumns (deduped) — this FOR UPDATE read is the ONE place every
  // scheduled-price writer observes the visit under the mint lock, so it is
  // also the ONE place that can catch a cancellation (or any other
  // never-ran transition) that committed while this transaction waited on
  // the advisory lock (Codex #5244 r7 P0: a cancel that wins the lock race
  // must not be resumed past by a mint that started before it and never
  // re-reads status). assertScheduledVisitLive throws BEFORE the caller's
  // own price/replay checks so a terminal visit never reaches them.
  const lockedSvc = await trx('scheduled_services')
    .where({ id: scheduledServiceId })
    .forUpdate()
    .first(...new Set([...visitColumns, 'status']));
  if (lockedSvc) assertScheduledVisitLive(lockedSvc);
  return lockedSvc;
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

// The ONE terminal-visit refusal every scheduled-service invoice mint
// throws (Codex #5244 r7 P0). A cancellation (or no-show/skip) that
// acquires this same mint lock first and commits while a concurrent mint
// waits behind it must not let that mint resume and bill a visit that will
// never happen — same shape/status style as scheduledPriceMovedError:
// terminal for retry loops (err.status), a stable machine-readable code.
function scheduledVisitNotLiveError(status) {
  const e = new Error(`Scheduled visit is ${status} — refusing to mint an invoice for it`);
  e.status = 409;
  e.statusCode = 409;
  // isOperational (invoice-helpers.js's own visit_busy sets it too): this
  // error can now surface through a plain create() caller with no
  // dedicated `.status` catch (e.g. the manual admin-invoice route), which
  // falls through to the shared errors.js handler — that handler renders a
  // MASKED 500 for anything not flagged isOperational. A caller with its
  // own `.status`/`.code` handling (the mint helpers, dispatch, Charge Now)
  // is unaffected either way.
  e.isOperational = true;
  e.code = 'SCHEDULED_VISIT_NOT_LIVE';
  e.visitStatus = status;
  return e;
}

// Call on a visit row read UNDER the mint lock (the row must carry
// 'status'). Throws scheduledVisitNotLiveError for any status in the
// canonical VISIT_NEVER_RAN_STATUSES set (invoice-helpers.js) — never a
// hand-rolled list, so a status added to that set for settlement/send/void
// refusal also refuses a mint without a second edit. A missing row is the
// caller's own "not found" concern, not this function's.
function assertScheduledVisitLive(visitRow) {
  const status = String(visitRow?.status || '').trim().toLowerCase();
  if (VISIT_NEVER_RAN_STATUSES.includes(status)) throw scheduledVisitNotLiveError(status);
}

// Replay = the double-tap window returning the FIRST request's fresh
// invoice; adoption = a replay transaction waking under the mint lock to
// find another writer (Charge Now / completion mint) already committed one.
// Same predicate either way — the ONE terminal-status filter.
async function findAdoptableScheduledInvoice(trx, scheduledServiceId) {
  await assertScheduledInvoiceNotPacketOwned(trx, scheduledServiceId);
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
  // A quiet backfill closeout leaves the estimate deposit on its ledger for
  // the reviewer (the completion path's skipDepositCredit posture).
  skipDepositCredit = false,
  // The caller's check, under the visit lock, that what it decided before
  // the lock still holds (e.g. the lines it built are still what the visit
  // bills — an equal-total edit passes the price guard). An editor locking
  // the visit row first waits for this mint, so a throw here is the only
  // race left. A throw carrying a status is terminal for the deposit retry.
  recheckInTrx = null,
}) {
  const InvoiceService = require('../services/invoice');
  const {
    acquireEstimateDepositLedgerLock, pendingDepositCredit, consumeDepositCredit,
  } = require('../services/estimate-deposits');
  const sourceEstimateId = svc.source_estimate_id || null;
  let lastErr = null;
  for (let attempt = 0; attempt < (sourceEstimateId ? 2 : 1); attempt += 1) {
    const withDeposit = !!sourceEstimateId && !skipDepositCredit;
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
          visitColumns: ['id', 'customer_id', 'source_estimate_id', 'estimated_price', 'primary_line_price', 'scheduled_date'],
        });
        if (!lockedSvc) {
          const e = new Error('Scheduled service not found');
          e.status = 404;
          throw e;
        }
        if (String(lockedSvc.customer_id) !== String(svc.customer_id)
          || String(lockedSvc.source_estimate_id || '') !== String(sourceEstimateId || '')
          // Codex round-6 P1: a sibling-coverage verdict (both the
          // resolver's pre-lock read and this transaction's own recheck)
          // classifies coverage against `svc.scheduled_date` — a reschedule
          // between that read and this lock invalidates it exactly like a
          // moved customer/estimate does, so it belongs in the SAME
          // unconditional refusal (never bypassed by allowPriceMovement,
          // matching customer/estimate above).
          || scheduledDateMovedBetween(svc, lockedSvc)) {
          const e = new Error('Scheduled service billing owner, estimate, or date changed while minting');
          e.status = 409;
          e.statusCode = 409;
          e.code = 'SCHEDULED_BILLING_SOURCE_MOVED';
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
        // Codex round-6 P1: the estimate-scoped ledger lock used to be taken
        // AFTER recheckInTrx. siblingCoverageRecheckInTrx's own lookup
        // (siblingInvoiceCoverageVerdict, lockRows: true → FOR UPDATE OF i)
        // locks nothing when NO invoice row exists yet for the estimate —
        // so two sibling visits under the SAME estimate, charged at the same
        // moment while neither has an invoice, could both run the recheck,
        // both see 'none' (nothing to lock, matching the pre-transaction
        // snapshot), and both fall through to mint a collectible base
        // invoice for the same trip. Acquiring the SAME estimate.deposit.
        // ledger advisory lock (the ONE lock key every estimate-scoped
        // writer already shares — see acquireEstimateDepositLedgerLock's own
        // header) BEFORE the recheck serializes the two mints on the
        // estimate itself: only one holds the lock at a time, so the second
        // one's recheck (or its own pre-transaction resolver snapshot) sees
        // the FIRST one's freshly committed invoice and refuses on the
        // status change (SIBLING_COVERAGE_CHANGED) instead of minting
        // beside it. Reuses acquireEstimateDepositLedgerLock verbatim —
        // never a second, parallel lock key for the same purpose.
        //
        // Lock order, and why it can't deadlock against the OTHER advisory
        // lock in this chain: acquireScheduledMintLockChain above already
        // took [1] the SERVICE-scoped mint lock (['schedule.invoice.mint',
        // svc.id], keyed by THIS visit) and [2] the customer KEY SHARE and
        // [3] the visit row FOR UPDATE, all before this point. This lock is
        // [4] the ESTIMATE-scoped ledger lock, keyed by source_estimate_id —
        // a DIFFERENT key namespace ('estimate.deposit.ledger' vs
        // 'schedule.invoice.mint'), so a mint for a DIFFERENT sibling visit
        // under the same estimate never contends with [1] here at all (each
        // visit has its own service-scoped key) and can only contend with
        // [4] — a single lock, no second party to form a cycle with. Every
        // other estimate-ledger-lock caller (invoice.js createFromService,
        // estimate-converter.js's converter locks, visit-completion-invoice.js's
        // packet path) takes [1]/mint-lock and the visit/customer locks
        // FIRST and this ledger lock LAST too, so the relative order between
        // the mint lock and the ledger lock is consistent everywhere — only
        // the position of THIS caller's own recheckInTrx (which may itself
        // take further invoice-row locks, e.g. sibling rows) moved, relative
        // to a lock this transaction already owns exclusively by then.
        if (sourceEstimateId) await acquireEstimateDepositLedgerLock(trx, sourceEstimateId);
        if (recheckInTrx) await recheckInTrx(trx);
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
        const held = new Error('Invoice mint held until the estimate deposit is reconciled');
        held.code = 'DEPOSIT_RECONCILIATION_REQUIRED';
        held.status = 409;
        held.statusCode = 409;
        throw held;
      }
    }
  }
  throw lastErr; // defensive — every attempt returns or rethrows above
}

module.exports = {
  SCHEDULED_SERVICE_INVOICE_MINT_LOCK,
  TERMINAL_INVOICE_STATUSES,
  acquireScheduledInvoiceMintLock,
  tryAcquireScheduledInvoiceMintLock,
  assertScheduledInvoiceNotPacketOwned,
  acquireScheduledMintLockChain,
  findAdoptableScheduledInvoice,
  adoptScheduledInvoiceUnderMintLock,
  scheduledPriceMovedError,
  scheduledVisitNotLiveError,
  assertScheduledVisitLive,
  mintScheduledServiceInvoiceWithDeposit,
};
