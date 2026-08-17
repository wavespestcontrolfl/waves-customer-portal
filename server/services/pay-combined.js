/**
 * Pay-page full-balance collection (owner ruling 2026-08-16, gate
 * payIncludeBalance): the /pay page itemizes the customer's other open
 * self-pay invoices and the Pay button charges the COMBINED total in ONE
 * PaymentIntent, payer-statement style — the PI carries a per-invoice
 * allocation in metadata, and the settle paths mark every allocated invoice
 * paid with its own ledger row. Invoices are never merged or re-totalled;
 * each keeps its own number, amounts, receipt, and dunning identity.
 *
 * This module is the ONE authority for:
 *   - which sibling invoices ride a combined charge (selection);
 *   - the allocation snapshot and its metadata encoding (codec);
 *   - re-verifying an allocation against LOCKED rows at every later money
 *     seam (mint reuse, update-amount, finalize, confirm, webhook settle).
 *
 * Selection = open-balance.js (the shared open-invoice authority: delivered
 * self-pay rows with a positive remainder, live payer re-resolution, oldest
 * first) MINUS:
 *   - admin-stopped-dunning invoices ("stop dunning" also means "don't force
 *     the customer to pay it here" — same signal the completion sweep and
 *     previsit-balance honor; owner confirmed 2026-08-16);
 *   - invoices that already carry a PaymentIntent (their own pay session or
 *     a saved-card claim owns them — a combined charge must never race an
 *     invoice someone is paying elsewhere).
 * Any resolve failure or candidate-page truncation makes the sibling read
 * INCOMPLETE → the combined flow declines to engage (single-invoice
 * behavior, exactly as if the gate were off) rather than assert a total the
 * read cannot prove complete (same suppression contract as the SMS line).
 *
 * The allocation is cents-exact: PI base amount === Σ allocation cents, and
 * every later seam re-checks each locked row's remainder against its
 * allocated cents — any drift is a 409 "balance changed, refresh", never a
 * charge against numbers the customer isn't looking at.
 */

const db = require('../models/db');
const logger = require('./logger');
const { isEnabled } = require('../config/feature-gates');
const { openBalanceInvoices } = require('./open-balance');
const { dunningStoppedInvoiceIds } = require('./completion-balance-sweep');
const { invoiceAmountDue, isInvoiceCollectibleStatus } = require('./invoice-helpers');

// Stripe metadata values cap at 500 chars. The compact `${id}:${cents}`
// encoding spends ~44 chars per sibling, so 8 siblings stay comfortably
// under the cap (prod max open invoices per customer is single digits).
// MORE than 8 means the combined total could not be complete → decline to
// engage rather than force a partial "total".
const MAX_COMBINED_SIBLINGS = 8;

const amountDueCents = (invoice) => Math.round(invoiceAmountDue(invoice) * 100);

/**
 * The sibling invoices a combined charge for `anchorInvoice` would collect,
 * or null when the combined flow must not engage (gate off, payer-billed
 * anchor, incomplete read, over-cap, or simply no siblings). Never throws —
 * a null return always degrades to today's single-invoice flow.
 */
async function combinedEligibleSiblings(anchorInvoice, { database = db, reusePaymentIntentId = null, throwOnPayerAnchor = false } = {}) {
  try {
    if (!isEnabled('payIncludeBalance')) return null;
    if (!anchorInvoice?.customer_id) return null;
    // A payer-billed or statement-accrued anchor is the third party's money —
    // never fan the homeowner's balance into it.
    if (anchorInvoice.payer_id || anchorInvoice.payer_statement_id) return null;
    // LIVE anchor payer resolution (codex r6 P1): a payer assigned via the
    // scheduled service or customer default AFTER invoice creation leaves
    // invoices.payer_id null — the raw-column check above would let
    // GET /pay/:token serialize the homeowner's sibling invoices to the
    // third party holding the anchor link. Fail CLOSED: a resolved payer
    // or a resolve failure both disable the combined flow (single-invoice
    // behavior). At the SETUP money seam (`throwOnPayerAnchor`) a resolved
    // payer must go further and ABORT the mint entirely (codex r13 P1):
    // degrading to single-invoice would still charge the homeowner debt
    // that now belongs to third-party AP — e.g. a payer edit that won the
    // shared advisory lock while this setup was queued behind it.
    {
      const PayerService = require('./payer');
      let resolved;
      try {
        resolved = await PayerService.resolveForInvoice({
          customerId: String(anchorInvoice.customer_id),
          ...(anchorInvoice.scheduled_service_id ? { scheduledServiceId: String(anchorInvoice.scheduled_service_id) } : {}),
          throwOnError: true,
        });
      } catch (resolveErr) {
        if (resolveErr.combinedSetupAbort) throw resolveErr;
        // Resolution UNCERTAINTY at the setup seam aborts too (codex r16
        // P1): "the lookup is down" is not "no payer" — minting an
        // anchor-only PI on an unproven self-pay anchor could charge the
        // homeowner debt a just-assigned payer now owns. The GET path
        // still degrades (a read must not 500).
        if (throwOnPayerAnchor) {
          const err = new Error('Could not verify billing ownership for this invoice — please try again in a moment.');
          err.statusCode = 409;
          err.staleBalance = true;
          err.combinedSetupAbort = true;
          throw err;
        }
        throw resolveErr; // outer catch degrades (GET / non-seam callers)
      }
      if (resolved?.payerId) {
        if (throwOnPayerAnchor) {
          const err = new Error('This invoice is billed to a third-party payer and can no longer be paid from this page — refreshing.');
          err.statusCode = 409;
          err.staleBalance = true;
          err.payerBilledAnchor = true;
          err.combinedSetupAbort = true;
          throw err;
        }
        logger.info(`[pay-combined] anchor invoice ${anchorInvoice.invoice_number} resolves to payer ${resolved.payerId} — combined flow disabled`);
        return null;
      }
    }

    let incomplete = null;
    const candidates = await openBalanceInvoices(anchorInvoice.customer_id, {
      excludeInvoiceId: anchorInvoice.id,
      database,
      onResolveFailure: () => { incomplete = 'payer resolve failed'; },
      onTruncation: () => { incomplete = 'candidate bound hit'; },
    });
    if (incomplete) {
      logger.warn(`[pay-combined] sibling read incomplete for invoice ${anchorInvoice.invoice_number} (${incomplete}) — combined flow disabled for this session`);
      return null;
    }
    if (!candidates.length) return null;

    const stopped = await dunningStoppedInvoiceIds(candidates.map((inv) => inv.id), { database });
    const eligible = candidates.filter((inv) => !stopped.has(String(inv.id))
      // An attached PI means another pay session or a saved-card claim owns
      // this invoice right now — leave it to that rail. The one exception is
      // OUR OWN combined PI being re-set-up (page reload): siblings stamped
      // with the anchor's current PI stay included, or every reload would
      // shed them.
      && (!inv.stripe_payment_intent_id
        || (reusePaymentIntentId && String(inv.stripe_payment_intent_id) === String(reusePaymentIntentId))));
    if (!eligible.length) return null;
    // Saved-card/orphan reconciliation fence per sibling (codex r13 P1): a
    // sibling with an unresolved charge attempt or orphaned charge may
    // ALREADY be collected — a combined PI capturing its share too would
    // double-collect, and the webhook's post-capture quarantine is too
    // late. Drop such siblings from the selection (graceful — the anchor
    // still pays alone or with the clean siblings); the locked verifier
    // re-checks at every money seam.
    {
      const StripeService = require('./stripe');
      const cleared = [];
      for (const inv of eligible) {
        try {
          await StripeService.assertNoInvoiceChargeReconciliationPending(inv.id, database);
          cleared.push(inv);
        } catch (fenceErr) {
          logger.warn(`[pay-combined] sibling ${inv.invoice_number} excluded from combined selection: ${fenceErr.message}`);
        }
      }
      if (!cleared.length) return null;
      eligible.length = 0;
      eligible.push(...cleared);
    }
    if (eligible.length > MAX_COMBINED_SIBLINGS) {
      logger.warn(`[pay-combined] customer ${anchorInvoice.customer_id} has ${eligible.length} eligible siblings (cap ${MAX_COMBINED_SIBLINGS}) — combined flow disabled for this session`);
      return null;
    }
    return eligible;
  } catch (err) {
    // Setup-seam abort verdicts (payer-billed anchor OR resolution
    // uncertainty) must reach the route, never degrade to single-invoice.
    if (err.combinedSetupAbort || err.payerBilledAnchor) throw err;
    logger.warn(`[pay-combined] sibling selection failed for invoice ${anchorInvoice?.id}: ${err.message} — combined flow disabled for this session`);
    return null;
  }
}

/**
 * Allocation snapshot for a combined charge: anchor first, then siblings
 * oldest-first, each with its cents-exact remainder at snapshot time.
 */
function buildAllocation(anchorInvoice, siblings) {
  const rows = [anchorInvoice, ...siblings];
  return rows.map((inv) => ({
    invoiceId: String(inv.id),
    invoiceNumber: inv.invoice_number,
    cents: amountDueCents(inv),
    // Display-only (never encoded into PI metadata): lets the setup-
    // authoritative breakdown show WHICH visit each share belongs to
    // (codex r10 P2).
    serviceDate: inv.service_date || null,
    dueDate: inv.due_date || null,
  }));
}

const allocationTotalCents = (allocation) => allocation.reduce((sum, a) => sum + a.cents, 0);

/** `${id}:${cents}` CSV — compact enough for Stripe's 500-char metadata cap. */
function encodeAllocation(allocation) {
  return allocation.map((a) => `${a.invoiceId}:${a.cents}`).join(',');
}

/**
 * Parse a PI's combined allocation. Returns null for non-combined PIs;
 * throws on a PRESENT-but-malformed allocation (a combined PI whose
 * allocation can't be read must never settle as single-invoice). Fails
 * closed on every ambiguous shape: zero/negative/unsafe cent values (a
 * zero-cent share would "settle" an invoice no money covered), duplicate
 * invoice ids (one invoice must never absorb two shares of the charge),
 * and more entries than the mint could legitimately produce (anchor +
 * MAX_COMBINED_SIBLINGS bounds the processing loop).
 */
function parseCombinedAllocation(piMetadata) {
  const raw = piMetadata?.combined_allocation;
  if (!raw) return null;
  const parts = String(raw).split(',');
  if (parts.length > MAX_COMBINED_SIBLINGS + 1) {
    throw new Error(`Combined allocation names ${parts.length} invoices — above the ${MAX_COMBINED_SIBLINGS + 1}-entry bound`);
  }
  const seen = new Set();
  const entries = parts.map((part) => {
    const idx = part.lastIndexOf(':');
    const invoiceId = part.slice(0, idx);
    const cents = Number(part.slice(idx + 1));
    if (!invoiceId || !Number.isSafeInteger(cents) || cents <= 0) {
      throw new Error(`Malformed combined allocation entry: ${part}`);
    }
    if (seen.has(invoiceId)) {
      throw new Error(`Duplicate invoice in combined allocation: ${invoiceId}`);
    }
    seen.add(invoiceId);
    return { invoiceId, cents };
  });
  if (!entries.length) throw new Error('Empty combined allocation');
  return entries;
}

const isCombinedPiMetadata = (piMetadata) => !!piMetadata?.combined_allocation;

/**
 * Re-verify a combined allocation against LOCKED invoice rows inside the
 * caller's transaction. Locks in ascending id order (deadlock-safe against
 * concurrent combined flows), and checks per row:
 *   - still collectible, still self-pay (payer_id / payer_statement_id null);
 *   - remainder cents still exactly the allocated cents;
 *   - PI binding: bound to `expectPaymentIntentId` (or unbound for siblings
 *     when `allowUnbound` — the mint path locks before stamping).
 * Throws a 409-shaped error on any drift so the page refreshes to live
 * numbers instead of charging against a changed balance.
 */
async function verifyAllocationLocked(trx, allocation, { anchorInvoiceId, expectPaymentIntentId = null, allowUnbound = false } = {}) {
  const ids = allocation.map((a) => a.invoiceId).sort();
  const rows = await trx('invoices').whereIn('id', ids).orderBy('id', 'asc').forUpdate();
  const byId = new Map(rows.map((r) => [String(r.id), r]));
  // Stopped-dunning re-check under the money-seam lock (codex r2 P1): an
  // admin stopping a SIBLING's dunning after mint is an instruction not to
  // force-collect it — refuse-as-stale so the page reloads and the fresh
  // selection excludes it. The ANCHOR is exempt: the customer actively
  // paying today's own invoice is not forced collection.
  const siblingIds = allocation
    .map((a) => a.invoiceId)
    .filter((id) => String(id) !== String(anchorInvoiceId));
  const stoppedNow = siblingIds.length
    ? await dunningStoppedInvoiceIds(siblingIds, { database: trx })
    : new Set();
  const staleErr = (why) => {
    const err = new Error('The account balance changed since this page loaded — refreshing to the latest amounts.');
    err.statusCode = 409;
    err.staleBalance = true;
    err.reason = why;
    return err;
  };
  for (const entry of allocation) {
    const row = byId.get(String(entry.invoiceId));
    if (!row) throw staleErr(`invoice ${entry.invoiceId} not found`);
    if (stoppedNow.has(String(entry.invoiceId))) throw staleErr(`dunning stopped on invoice ${row.invoice_number}`);
    if (!isInvoiceCollectibleStatus(row.status)) throw staleErr(`invoice ${row.invoice_number} is ${row.status}`);
    if (row.payer_id || row.payer_statement_id) throw staleErr(`invoice ${row.invoice_number} became payer-billed`);
    // LIVE payer re-resolution for EVERY row, anchor included (codex r4 P1;
    // anchor exemption removed per codex r5 P1): a payer assigned after
    // invoice creation lives on scheduled_services (or as the customer's
    // default payer) while invoices.payer_id stays null — the pay POSTs
    // load the raw anchor row, so without this live resolve the anchor
    // passes every seam and the homeowner is charged debt now owned by
    // third-party AP. Fail CLOSED: a resolve failure or a resolved payer
    // both refuse (payer-billed debt is never the homeowner's to pay).
    {
      const PayerService = require('./payer');
      try {
        const resolved = await PayerService.resolveForInvoice({
          customerId: String(row.customer_id),
          ...(row.scheduled_service_id ? { scheduledServiceId: String(row.scheduled_service_id) } : {}),
          throwOnError: true,
        });
        if (resolved?.payerId) throw staleErr(`invoice ${row.invoice_number} is payer-billed`);
      } catch (err) {
        if (err.staleBalance) throw err;
        logger.warn(`[pay-combined] payer resolve failed for invoice ${row.invoice_number} during locked verification: ${err.message}`);
        throw staleErr(`payer resolution unavailable for invoice ${row.invoice_number}`);
      }
    }
    if (amountDueCents(row) !== entry.cents) throw staleErr(`invoice ${row.invoice_number} remainder changed`);
    const bound = row.stripe_payment_intent_id ? String(row.stripe_payment_intent_id) : null;
    const isAnchor = String(row.id) === String(anchorInvoiceId);
    // Sibling reconciliation fence at every money seam (codex r13 P1): an
    // unresolved saved-card attempt / orphaned charge on a sibling means
    // its share may already be collected — refuse-as-stale so the page
    // reloads and the fresh selection excludes it. The ANCHOR's own
    // route/setup preflights cover the anchor.
    if (!isAnchor) {
      try {
        await require('./stripe').assertNoInvoiceChargeReconciliationPending(row.id, trx);
      } catch (fenceErr) {
        logger.warn(`[pay-combined] sibling ${row.invoice_number} failed the reconciliation fence during locked verification: ${fenceErr.message}`);
        throw staleErr(`invoice ${row.invoice_number} has a pending payment reconciliation`);
      }
    }
    if (expectPaymentIntentId && bound && bound !== String(expectPaymentIntentId)) {
      throw staleErr(`invoice ${row.invoice_number} has a different active payment`);
    }
    if (!bound && !allowUnbound && !isAnchor) {
      throw staleErr(`invoice ${row.invoice_number} lost its payment binding`);
    }
  }
  return rows;
}

/**
 * Does this PI belong to `invoiceId`? Single-invoice PIs answer via
 * waves_invoice_id; a combined PI also OWNS every invoice its allocation
 * names (siblings are stamped with the anchor's PI, so every per-invoice
 * ownership check must accept the allocation membership or sibling pay
 * pages / settles would refuse their own money).
 */
function paymentIntentOwnsInvoice(piMetadata, invoiceId) {
  const metaId = piMetadata?.waves_invoice_id;
  if (metaId && String(metaId) === String(invoiceId)) return true;
  try {
    const alloc = parseCombinedAllocation(piMetadata);
    return !!alloc?.some((a) => String(a.invoiceId) === String(invoiceId));
  } catch {
    return false;
  }
}

/**
 * Live combined context for an invoice's CURRENT PaymentIntent, derived from
 * the DB stamps (every allocated invoice carries the PI id), not a Stripe
 * read: the stamped rows are edit-locked while the PI is attached, so their
 * remainders are exactly what the PI was priced from. Returns null when the
 * gate is off (kill switch outranks the persisted stamps — later seams then
 * degrade to single-invoice and clear the sibling stamps) or when no live
 * sibling rides the PI.
 */
async function combinedContextForInvoice(anchorInvoice, { database = db } = {}) {
  if (!isEnabled('payIncludeBalance')) return null;
  if (!anchorInvoice?.stripe_payment_intent_id) return null;
  const siblings = await database('invoices')
    .where({ stripe_payment_intent_id: anchorInvoice.stripe_payment_intent_id })
    .whereNot('id', anchorInvoice.id)
    .whereIn('status', ['sent', 'viewed', 'overdue'])
    .orderBy('created_at', 'asc');
  let live = siblings.filter((s) => amountDueCents(s) > 0);
  // An admin stopping a sibling's dunning after mint drops it from the
  // combined charge (codex r2 P1) — the same "don't force-collect" signal
  // the initial selection honors. The dropped row's stale stamp is cleared
  // by the update-amount/finalize cleanup paths.
  if (live.length) {
    const stopped = await dunningStoppedInvoiceIds(live.map((s) => s.id), { database });
    if (stopped.size) live = live.filter((s) => !stopped.has(String(s.id)));
  }
  if (!live.length) return null;
  const allocation = buildAllocation(anchorInvoice, live);
  return { siblings: live, allocation, totalCents: allocationTotalCents(allocation) };
}

/**
 * Unstamp a PaymentIntent from every collectible invoice EXCEPT the ids in
 * `keepInvoiceIds` — the cleanup half of sibling stamping. Runs whenever a
 * combined PI is canceled/replaced or a new mint's allocation drops a
 * previously-included sibling, so no invoice stays bound to a PI that will
 * never collect it. Paid/processing rows are never touched (their PI ref is
 * the settlement audit trail).
 */
async function clearPaymentIntentStamps(database, paymentIntentId, { keepInvoiceIds = [] } = {}) {
  if (!paymentIntentId) return 0;
  const query = database('invoices')
    .where({ stripe_payment_intent_id: paymentIntentId })
    .whereNotIn('status', ['paid', 'processing', 'prepaid']);
  if (keepInvoiceIds.length) query.whereNotIn('id', keepInvoiceIds);
  return query.update({ stripe_payment_intent_id: null, updated_at: new Date() });
}

/**
 * Fail-closed release of any unconfirmed COMBINED payment session riding an
 * invoice tied to the given scheduled services (codex #3427 r8 P1). Payer
 * assignment via the scheduled-service writer bypasses every pay-page money
 * seam — the browser can confirm a combined ACH PI directly after the last
 * server verification — so assigning a payer must first cancel any
 * unconfirmed combined PI those invoices ride, exactly like stop-dunning.
 * Throws (aborting the caller's transaction) when a session can't be
 * verified or released; money in flight is never touched — the settle
 * paths keep their own ownership guards for it.
 */
async function releaseUnconfirmedCombinedSessionsForScheduledServices(database, scheduledServiceIds) {
  const ids = (scheduledServiceIds || []).filter(Boolean);
  if (!ids.length) return { released: 0, inFlight: 0 };
  // Serialize with combined /setup (codex r9 P1): the same per-customer
  // advisory lock createInvoicePaymentIntent holds — otherwise this scan
  // can complete before setup stamps the invoices, the payer change
  // commits while Stripe is being called, and setup returns a confirmable
  // PI containing debt that is now payer-billed. Sorted for determinism.
  const customerIds = (await database('scheduled_services')
    .whereIn('id', ids)
    .distinct('customer_id')
    .pluck('customer_id')).filter(Boolean).map(String).sort();
  await lockCombinedCustomers(database, customerIds);
  const rows = await database('invoices')
    .whereIn('scheduled_service_id', ids)
    .whereNotNull('stripe_payment_intent_id')
    // 'processing' rows stay IN the scan (codex r26 P1): they are exactly
    // the in-flight signal the PI-status check must see and report.
    .whereNotIn('status', ['paid', 'prepaid', 'void', 'refunded', 'canceled', 'cancelled'])
    .select('id', 'invoice_number', 'stripe_payment_intent_id');
  return releaseUnconfirmedCombinedSessions(database, rows);
}

/** Customer-default-payer variant of the same fence (the customers.payer_id
 * writer creates the identical late-assignment gap). */
async function releaseUnconfirmedCombinedSessionsForCustomer(database, customerId) {
  if (!customerId) return { released: 0, inFlight: 0 };
  // Same setup-serialization lock as the scheduled-service variant.
  await lockCombinedCustomers(database, [String(customerId)]);
  const rows = await database('invoices')
    .where({ customer_id: customerId })
    .whereNotNull('stripe_payment_intent_id')
    // 'processing' rows stay IN the scan (codex r26 P1): filtering them
    // out hid the exact in-flight sessions the merge's defer check exists
    // to detect.
    .whereNotIn('status', ['paid', 'prepaid', 'void', 'refunded', 'canceled', 'cancelled'])
    .select('id', 'invoice_number', 'stripe_payment_intent_id');
  return releaseUnconfirmedCombinedSessions(database, rows);
}

// The pay.combined.customer namespace matches createInvoicePaymentIntent /
// update-amount / finalize — payer changes and combined session setup are
// mutually exclusive per customer while either transaction is open. The
// caller MUST pass a transaction (xact locks release on commit/rollback).
async function lockCombinedCustomers(database, customerIds) {
  for (const cid of customerIds) {
    await database.raw(
      'SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))',
      ['pay.combined.customer', cid],
    );
  }
}

async function releaseUnconfirmedCombinedSessions(database, rows) {
  const piIds = [...new Set(rows.map((r) => String(r.stripe_payment_intent_id)))];
  let released = 0;
  let inFlight = 0;
  for (const piId of piIds) {
    const StripeService = require('./stripe');
    let pi;
    try {
      pi = await StripeService.retrievePaymentIntent(piId);
    } catch (err) {
      throw new Error(`Could not verify payment session ${piId} before the payer change (${err.message}) — try again`);
    }
    // A null return = Stripe unconfigured, NOT "no session" (codex r23
    // P1): a browser can still hold this PI's client secret and confirm
    // directly with Stripe — the ownership change must fail closed, never
    // commit past an unverifiable live session.
    if (!pi) {
      throw new Error(`Could not verify payment session ${piId} before the payer change (payment service unavailable) — try again`);
    }
    if (!isCombinedPiMetadata(pi.metadata)) continue;
    // Already canceled (codex r24 P2): a prior release's cancel succeeded
    // but the stamp cleanup failed — retry the cleanup instead of skipping.
    if (pi.status === 'canceled') {
      await clearPaymentIntentStamps(database, piId);
      released += 1;
      continue;
    }
    // NO microdeposit exemption here (codex r10 P1, unlike stop-dunning):
    // a pending bank verification is still an UNCAPTURED session, and the
    // customer completing it later would charge debt that now belongs to
    // the payer — ownership correctness outranks the verification UX, so
    // the session is canceled like any other unconfirmed PI. Only money
    // actually moving (processing/succeeded) is left to the settle-path
    // ownership guards — reported to the caller (codex r24 P1: a merge
    // must DEFER on a loser-side in-flight session, not proceed past it).
    const unconfirmed = ['requires_payment_method', 'requires_confirmation', 'requires_action'].includes(pi.status);
    if (!unconfirmed) {
      logger.warn(`[pay-combined] payer change: combined PI ${piId} is ${pi.status} — money may be in flight, not touched`);
      inFlight += 1;
      continue;
    }
    try {
      await StripeService.cancelPaymentIntent(piId);
    } catch (err) {
      throw new Error(`Could not release the combined payment session ${piId} before the payer change (${err.message}) — payer NOT changed, try again`);
    }
    await clearPaymentIntentStamps(database, piId);
    released += 1;
    logger.info(`[pay-combined] payer change released unconfirmed combined PI ${piId} and cleared its stamps`);
  }
  return { released, inFlight };
}

/**
 * Combined-session reservation for EVERY off-page collection rail (codex
 * r29/r30 P0): before a rail marks a stamped invoice paid (manual
 * record-payment, admin reconcile, Terminal card-present), any combined
 * session riding it must be released — a browser holding the original
 * client secret could otherwise still confirm the full combined amount
 * and double-charge the share. Unconfirmed → cancel + unstamp;
 * already-canceled → finish the stamp cleanup; money in flight → throw a
 * 409 (the rail must wait for the debit to settle or fail). Fail-closed
 * on unreadable/unavailable Stripe. Non-combined PIs return untouched —
 * each rail keeps its existing single-PI contract.
 */
async function releaseCombinedSessionBeforeCollection(database, invoice, { context = 'recording this payment' } = {}) {
  // MUST be called with a TRANSACTION, inside the rail's collection commit
  // (codex r31 P0): the per-customer advisory lock below serializes with
  // /setup, and the invoice is RE-READ under it — an unlocked snapshot can
  // predate a setup that stamps a confirmable combined PI between this
  // check and the rail's own write. Holding the lock through the rail's
  // commit closes that window.
  // Re-lock until ownership is STABLE (codex r32 P1, same bounded loop as
  // setup and stop-dunning): the snapshot's customer id can be a
  // merge-retired owner — locking only that would let /setup lock the new
  // owner and stamp a confirmable combined PI after our read.
  let freshInvoice = null;
  if (invoice?.id) {
    let ownerId = invoice.customer_id ? String(invoice.customer_id) : null;
    for (let attempt = 0; ; attempt++) {
      if (ownerId) await lockCombinedCustomers(database, [ownerId]);
      freshInvoice = await database('invoices').where({ id: invoice.id }).first('id', 'invoice_number', 'customer_id', 'stripe_payment_intent_id');
      const freshId = freshInvoice?.customer_id ? String(freshInvoice.customer_id) : null;
      if (!freshId || freshId === ownerId) break;
      if (attempt >= 4) {
        const ownerErr = new Error('The invoice ownership kept changing — try again');
        ownerErr.statusCode = 409;
        throw ownerErr;
      }
      ownerId = freshId;
    }
  }
  const live = freshInvoice || invoice;
  if (!live?.stripe_payment_intent_id) return { released: false, invoice: live };
  const StripeService = require('./stripe');
  let pi;
  try {
    pi = await StripeService.retrievePaymentIntent(live.stripe_payment_intent_id);
  } catch (err) {
    const e = new Error(`Could not verify the invoice's open payment session (${err.message}) — try again`);
    e.statusCode = 409;
    throw e;
  }
  if (!pi) {
    const e = new Error("Could not verify the invoice's open payment session (payment service unavailable) — try again");
    e.statusCode = 409;
    throw e;
  }
  if (!isCombinedPiMetadata(pi.metadata)) return { released: false, invoice: live };
  if (['requires_payment_method', 'requires_confirmation', 'requires_action'].includes(pi.status)) {
    try {
      await StripeService.cancelPaymentIntent(pi.id);
    } catch (err) {
      const e = new Error(`Could not release the open combined payment session (${err.message}) — try again`);
      e.statusCode = 409;
      throw e;
    }
    await clearPaymentIntentStamps(database, pi.id);
    logger.info(`[pay-combined] released combined PI ${pi.id} before ${context} on invoice ${invoice.invoice_number || invoice.id}`);
    return { released: true, invoice: live };
  }
  if (pi.status === 'canceled') {
    await clearPaymentIntentStamps(database, pi.id);
    return { released: true, invoice: live };
  }
  const e = new Error(`A combined bank payment is in flight on this invoice — wait for it to settle or fail before ${context}`);
  e.statusCode = 409;
  e.inFlightCombined = true;
  throw e;
}

/**
 * Kill-switch enforcement sweep (codex #3427 r22 P1): after /update-amount
 * (the last server seam) a combined ACH PI is confirmable directly from the
 * browser with no further gate check — so DISABLING the gate must also
 * revoke outstanding unconfirmed combined sessions, or the advertised kill
 * switch leaves already-prepared PIs able to charge every sibling. Gate
 * flips require a restart (env-sourced), so boot-with-gate-off is exactly
 * the "gate was just disabled" moment. Identifies candidates without
 * Stripe reads first (only combined stamping ever binds ONE PI to more
 * than one collectible invoice), verifies combined metadata at Stripe,
 * cancels unconfirmed sessions, and clears every stamp. Best-effort per
 * PI; the update-amount degrade remains the per-session backstop.
 */
async function revokeOutstandingCombinedSessionsOnGateOff() {
  if (isEnabled('payIncludeBalance')) return { skipped: true };
  const candidatePiIds = await db('invoices')
    .whereNotNull('stripe_payment_intent_id')
    // 'processing' rows stay IN the candidate set (codex r26 P1): an
    // in-flight combined ACH session must keep the sweep polling — if the
    // debit later fails, Stripe returns the reusable intent to an
    // unconfirmed state and THIS sweep is what revokes it.
    .whereNotIn('status', ['paid', 'prepaid', 'void', 'refunded', 'canceled', 'cancelled'])
    .groupBy('stripe_payment_intent_id')
    .havingRaw('count(*) > 1')
    .pluck('stripe_payment_intent_id');
  let revoked = 0;
  let failed = 0;
  let pending = 0;
  for (const piId of candidatePiIds) {
    const StripeService = require('./stripe');
    let pi;
    try {
      pi = await StripeService.retrievePaymentIntent(piId);
    } catch (err) {
      logger.error(`[pay-combined] gate-off revoke: PI ${piId} unreadable (${err.message}) — will retry`);
      failed += 1;
      continue;
    }
    // A null return = Stripe unconfigured (codex r23 P1): the session is
    // UNVERIFIABLE, not absent — count as failed so the durable retry
    // keeps trying rather than silently leaving a confirmable PI live.
    if (!pi) { failed += 1; continue; }
    if (!isCombinedPiMetadata(pi.metadata)) continue;
    // ALREADY canceled (codex r24 P2): a prior pass's cancel succeeded but
    // its stamp cleanup failed — the retry must still clean the stamps, or
    // the successful Stripe transition itself suppresses the retried DB
    // cleanup and every invoice stays bound to the dead PI.
    if (pi.status === 'canceled') {
      await clearPaymentIntentStamps(db, piId);
      revoked += 1;
      continue;
    }
    if (!['requires_payment_method', 'requires_confirmation', 'requires_action'].includes(pi.status)) {
      logger.warn(`[pay-combined] gate-off revoke: combined PI ${piId} is ${pi.status} — money may be in flight; sweep keeps watching until it settles or becomes cancelable`);
      pending += 1;
      continue;
    }
    try {
      await StripeService.cancelPaymentIntent(piId);
    } catch (err) {
      logger.error(`[pay-combined] gate-off revoke: could not cancel combined PI ${piId} (${err.message}) — will retry`);
      failed += 1;
      continue;
    }
    await clearPaymentIntentStamps(db, piId);
    revoked += 1;
  }
  if (candidatePiIds.length) {
    logger.warn(`[pay-combined] gate OFF — revoked ${revoked}/${candidatePiIds.length} outstanding combined session(s)${failed ? `, ${failed} failed (retry scheduled)` : ''}${pending ? `, ${pending} in flight (sweep keeps watching)` : ''}`);
  }
  return { revoked, failed, pending, candidates: candidatePiIds.length };
}

/**
 * Settle a combined PaymentIntent: one transaction (advisory-locked on the
 * PI, same namespace as the single-invoice settle) that, for EVERY invoice
 * in the allocation, flips it paid/processing and ensures its own
 * per-invoice payments row. Idempotent per invoice — a webhook redelivery
 * or a /confirm racing the webhook re-runs safely. The card surcharge (PI
 * total − allocation total) rides the ANCHOR's ledger row, so Σ payments
 * rows === cash captured to the cent.
 *
 * `details` is the resolved tender info (paymentMethod, cardBrand,
 * cardLastFour, receiptUrl) the caller derived from the PI/charge.
 * Returns { settled, paymentStatus, invoiceIds, anchorPaymentRow }.
 */
async function settleCombinedPaymentIntent(paymentIntent, details, { eventCreated = null } = {}) {
  const { invoicePaymentStatusForIntent } = require('./stripe-invoice-state');
  const { etDateString } = require('../utils/datetime-et');
  const piId = paymentIntent.id;
  const allocation = parseCombinedAllocation(paymentIntent.metadata);
  if (!allocation) throw new Error(`PI ${piId} is not a combined payment`);
  const anchorInvoiceId = paymentIntent.metadata?.waves_invoice_id || allocation[0].invoiceId;

  const paymentStatus = invoicePaymentStatusForIntent(paymentIntent, details.paymentMethod);
  const invoiceStatus = paymentStatus === 'paid' ? 'paid' : 'processing';
  const chargedCents = Number(paymentIntent.amount_received || paymentIntent.amount || 0);
  const allocCents = allocationTotalCents(allocation);
  const surchargeCents = Math.round(Number(paymentIntent.metadata?.card_surcharge || 0) * 100);
  // Cash captured must equal allocation + recorded surcharge EXACTLY
  // (codex r2 P0): both sides are integer cents with no rounding step left,
  // so any difference — even one cent — means the PI amount drifted from
  // the allocation snapshot. Never guess a split; the caller quarantines.
  if (paymentStatus === 'paid' && chargedCents !== allocCents + surchargeCents) {
    const err = new Error(
      `Combined PI ${piId} captured ${chargedCents}c but allocation+surcharge is ${allocCents + surchargeCents}c`,
    );
    err.code = 'COMBINED_ALLOCATION_MISMATCH';
    throw err;
  }

  const settledInvoiceIds = [];
  let anchorPaymentRow = null;
  await db.transaction(async (trx) => {
    await trx.raw(
      'SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))',
      ['stripe.pi.payment', String(piId)],
    );
    const ids = allocation.map((a) => a.invoiceId).sort();
    const rows = await trx('invoices').whereIn('id', ids).orderBy('id', 'asc').forUpdate();
    const byId = new Map(rows.map((r) => [String(r.id), r]));

    // 'disputed' is terminal for this PI (mirrors the single-invoice
    // confirm guard): the money already went back via the chargeback. A
    // pre-settlement REFUND fence (charge.refunded before succeeded —
    // codex r6 P0) is terminal the same way: the whole charge was
    // returned, so nothing may settle as paid. Post-settlement refunded
    // rows never fence (no pre_settlement flag) — redelivery idempotency
    // is unchanged for them.
    const fenceRows = await trx('payments')
      .where({ stripe_payment_intent_id: piId });
    const fenceMetaOf = (r) => (typeof r.metadata === 'string' ? safeJson(r.metadata) : r.metadata) || {};
    const fenced = fenceRows.some((r) => {
      if (r.status === 'disputed') return true;
      return r.status === 'refunded' && fenceMetaOf(r).pre_settlement === true;
    });
    if (fenced) {
      // Coded so the webhook records the orphan for the operator instead of
      // retrying a permanently-fenced settle forever (a pre-settlement
      // dispute or refund marker also raises this — codex r5/r6).
      const disputedErr = new Error('This payment was disputed or refunded before settlement — the invoices cannot be marked paid from the old payment session');
      disputedErr.code = 'COMBINED_PI_DISPUTED';
      throw disputedErr;
    }
    // Charge ALREADY fully refunded (codex r17 P1): charge.refunded can
    // land between the ACH processing rows and the delayed succeeded event
    // — every combined row is 'refunded' (full) with no pre_settlement
    // flag. Settling would record every share as an unexplained residual
    // and run the success-side hooks on returned money; the delayed
    // success is a NO-OP for this shape (coded so the webhook returns
    // quietly — the refund path already accounted for the cash).
    const combinedLedgerRows = fenceRows.filter((r) => fenceMetaOf(r).combined_payment && r.status !== 'canceled');
    if (combinedLedgerRows.length
      && combinedLedgerRows.every((r) => r.status === 'refunded' && r.refund_status === 'full')) {
      const refundedErr = new Error(`Combined PI ${piId} was already fully refunded — the delayed settlement event is a no-op`);
      refundedErr.code = 'COMBINED_PI_ALREADY_REFUNDED';
      throw refundedErr;
    }

    const existingRows = await trx('payments').where({ stripe_payment_intent_id: piId });
    const rowForInvoice = (invId) => existingRows.find(
      (p) => String(p.metadata?.invoice_id ?? (typeof p.metadata === 'string' ? safeJson(p.metadata)?.invoice_id : null)) === String(invId),
    );

    for (const entry of allocation) {
      const invoice = byId.get(String(entry.invoiceId));
      const isAnchor = String(entry.invoiceId) === String(anchorInvoiceId);
      if (!invoice) {
        logger.error(`[pay-combined] settle: allocated invoice ${entry.invoiceId} missing for PI ${piId} — recording residual`);
        await recordResidual(trx, paymentIntent, entry, 'allocated invoice not found', { isAnchor, surchargeCents, provisional: paymentStatus !== 'paid' });
        continue;
      }
      const status = String(invoice.status || '').toLowerCase();
      if (['void', 'refunded', 'canceled', 'cancelled'].includes(status)) {
        logger.error(`[pay-combined] settle: allocated invoice ${invoice.invoice_number} is ${status} for PI ${piId} — recording residual`);
        await recordResidual(trx, paymentIntent, entry, `allocated invoice is ${status}`, { isAnchor, surchargeCents, provisional: paymentStatus !== 'paid' });
        continue;
      }
      if (['paid', 'prepaid'].includes(status)) {
        // Already settled. By THIS PI (redelivery/race) → idempotent pass,
        // but still counted as settled so the post-settle side effects
        // (receipt enqueue, dunning stop, term sync — all idempotent)
        // re-run: a crash between the money commit and that loop must not
        // lose them forever (codex r2 P2). By a DIFFERENT PI → this
        // allocation's share was double-collected; record the residual so
        // an operator refunds it.
        if (String(invoice.stripe_payment_intent_id || '') !== String(piId)) {
          logger.error(`[pay-combined] settle: invoice ${invoice.invoice_number} already ${status} by another payment — recording residual for PI ${piId}`);
          await recordResidual(trx, paymentIntent, entry, `invoice already ${status} by ${invoice.stripe_payment_intent_id || 'unknown'}`, { isAnchor, surchargeCents, provisional: paymentStatus !== 'paid' });
          continue;
        }
        // Idempotence requires a SETTLED combined ledger row (codex r29
        // P0): "same PI + paid invoice" alone also matches an out-of-band
        // manual payment (cash/check recorded while the invoice still rode
        // this PI) — in that shape the captured share is a DOUBLE
        // collection with no Stripe ledger row, and passing silently would
        // hide it. Quarantine the share instead.
        const existing = rowForInvoice(invoice.id);
        const existingSettled = existing && ['paid', 'processing'].includes(existing.status);
        if (!existingSettled) {
          logger.error(`[pay-combined] settle: invoice ${invoice.invoice_number} is ${status} under this PI but has no settled combined ledger row — out-of-band payment raced the capture; recording residual`);
          await recordResidual(trx, paymentIntent, entry, `invoice ${invoice.invoice_number} was paid out-of-band while riding this combined PI — the captured share needs refund/credit`, { isAnchor, surchargeCents, provisional: paymentStatus !== 'paid' });
          continue;
        }
        if (isAnchor) anchorPaymentRow = existing;
        settledInvoiceIds.push(invoice.id);
        continue;
      }
      if (String(invoice.stripe_payment_intent_id || '') && String(invoice.stripe_payment_intent_id) !== String(piId)) {
        logger.error(`[pay-combined] settle: invoice ${invoice.invoice_number} bound to a different payment — recording residual for PI ${piId}`);
        await recordResidual(trx, paymentIntent, entry, `invoice bound to ${invoice.stripe_payment_intent_id}`, { isAnchor, surchargeCents, provisional: paymentStatus !== 'paid' });
        continue;
      }

      const invoiceUpdates = {
        status: invoiceStatus,
        processor: 'stripe',
        stripe_payment_intent_id: piId,
        stripe_charge_id: typeof paymentIntent.latest_charge === 'string'
          ? paymentIntent.latest_charge
          : paymentIntent.latest_charge?.id || null,
        updated_at: trx.fn.now(),
      };
      if (invoiceStatus === 'paid') invoiceUpdates.paid_at = new Date().toISOString();
      if (details.paymentMethod) invoiceUpdates.payment_method = details.paymentMethod;
      if (details.cardBrand) invoiceUpdates.card_brand = details.cardBrand;
      if (details.cardLastFour) invoiceUpdates.card_last_four = details.cardLastFour;
      if (details.receiptUrl) invoiceUpdates.receipt_url = details.receiptUrl;
      await trx('invoices').where({ id: invoice.id }).update(invoiceUpdates);

      const shareCents = entry.cents + (isAnchor ? surchargeCents : 0);
      const existing = rowForInvoice(invoice.id);
      if (existing) {
        // ACH RETRY on the same reusable PI (codex r7 P2): the prior
        // attempt's bounce left this row 'failed' — a new processing event
        // must pull it back to 'processing' (failure metadata cleared, and
        // the charge linkage refreshed to the NEW attempt's charge) or the
        // invoice sits in 'processing' over a 'failed' ledger row for the
        // multi-day clearing window.
        if (existing.status === 'failed' && invoiceStatus === 'processing') {
          await trx('payments').where({ id: existing.id }).update({
            status: 'processing',
            failure_reason: null,
            stripe_charge_id: invoiceUpdates.stripe_charge_id || existing.stripe_charge_id || null,
            updated_at: new Date(),
            metadata: trx.raw(
              `jsonb_set(COALESCE(metadata, '{}'::jsonb), '{payment_state}', '"processing"') - 'settled_event_at'`,
            ),
          });
        }
        // ACH: the processing handler inserted this row — flip it in place.
        // A retry can also change TENDER on the reused PI (failed ACH →
        // successful card — codex r9 P0): refresh every charge-derived
        // column from the CURRENT PI/details, not just the status, or the
        // ledger keeps the failed attempt's charge id, omits the captured
        // card surcharge on the anchor, and a later refund/dispute on the
        // successful charge can't find the allocation rows.
        if (!['paid', 'refunded', 'disputed'].includes(existing.status) && invoiceStatus === 'paid') {
          const existingMeta = (typeof existing.metadata === 'string' ? safeJson(existing.metadata) : existing.metadata) || {};
          const settledAtIso = eventCreated ? new Date(eventCreated * 1000).toISOString() : new Date().toISOString();
          await trx('payments').where({ id: existing.id }).update({
            status: 'paid',
            updated_at: new Date(),
            payment_date: etDateString(eventCreated ? new Date(eventCreated * 1000) : undefined),
            receipt_url: details.receiptUrl || existing.receipt_url || null,
            // The ACH-processing insert stamped "(bank payment pending)" —
            // strip it on settle like the single-invoice path (codex r14
            // P2); REPLACE is a no-op for rows without the marker.
            description: trx.raw("REPLACE(description, ' (bank payment pending)', '')"),
            stripe_charge_id: invoiceUpdates.stripe_charge_id || existing.stripe_charge_id || null,
            amount: shareCents / 100,
            base_amount_cents: entry.cents,
            surcharge_amount_cents: isAnchor ? surchargeCents : 0,
            surcharge_rate_bps: isAnchor ? Number(paymentIntent.metadata?.surcharge_rate_bps || 0) : 0,
            surcharge_policy_version: isAnchor ? (paymentIntent.metadata?.surcharge_policy_version || null) : null,
            card_funding: paymentIntent.metadata?.card_funding || null,
            card_brand: details.cardBrand || null,
            card_last_four: details.cardLastFour || null,
            failure_reason: null,
            metadata: JSON.stringify({
              ...existingMeta,
              payment_state: 'paid',
              settled_event_at: settledAtIso,
              payment_method: details.paymentMethod || paymentIntent.payment_method_types?.[0] || existingMeta.payment_method || null,
              base_amount: entry.cents / 100,
              card_surcharge: isAnchor ? surchargeCents / 100 : 0,
              charged_amount: shareCents / 100,
            }),
          });
        }
        // Re-read AFTER the in-place updates above (codex r25 P2): the
        // captured `existing` object predates the paid flip, and /confirm
        // reports its status to the client — returning the stale 'failed'
        // snapshot made a successful retry read as a failed charge and
        // skipped the paid-only hold-release action.
        if (isAnchor) {
          anchorPaymentRow = await trx('payments').where({ id: existing.id }).first() || existing;
        }
        settledInvoiceIds.push(invoice.id);
        continue;
      }

      const [inserted] = await trx('payments').insert({
        customer_id: invoice.customer_id,
        processor: 'stripe',
        stripe_payment_intent_id: piId,
        stripe_charge_id: invoiceUpdates.stripe_charge_id,
        payment_date: etDateString(eventCreated ? new Date(eventCreated * 1000) : undefined),
        amount: shareCents / 100,
        base_amount_cents: entry.cents,
        surcharge_amount_cents: isAnchor ? surchargeCents : 0,
        surcharge_rate_bps: isAnchor ? Number(paymentIntent.metadata?.surcharge_rate_bps || 0) : 0,
        surcharge_policy_version: isAnchor ? (paymentIntent.metadata?.surcharge_policy_version || null) : null,
        card_funding: paymentIntent.metadata?.card_funding || null,
        card_brand: details.cardBrand || null,
        status: paymentStatus,
        description: `Invoice ${invoice.invoice_number} (combined balance payment${isAnchor && surchargeCents > 0 ? `, includes $${(surchargeCents / 100).toFixed(2)} card processing fee` : ''})${paymentStatus === 'processing' ? ' (bank payment pending)' : ''}`,
        receipt_url: details.receiptUrl || null,
        card_last_four: details.cardLastFour || null,
        metadata: JSON.stringify({
          invoice_id: invoice.id,
          combined_payment: true,
          combined_anchor_invoice_id: String(anchorInvoiceId),
          stripe_receipt_url: details.receiptUrl || null,
          base_amount: entry.cents / 100,
          card_surcharge: isAnchor ? surchargeCents / 100 : 0,
          charged_amount: shareCents / 100,
          payment_method: details.paymentMethod || paymentIntent.payment_method_types?.[0] || null,
          payment_state: paymentStatus,
          settled_event_at: paymentStatus === 'paid'
            ? (eventCreated ? new Date(eventCreated * 1000).toISOString() : new Date().toISOString())
            : null,
        }),
      }).returning('*');
      if (isAnchor) anchorPaymentRow = inserted;
      settledInvoiceIds.push(invoice.id);
    }
  });

  // Post-settle side effects, per invoice, outside the money transaction —
  // each is best-effort and independently recoverable.
  if (invoiceStatus === 'paid') {
    for (const invId of settledInvoiceIds) {
      try {
        await require('./invoice-followups').stopOnPayment(invId);
      } catch (e) {
        logger.warn(`[pay-combined] stopOnPayment failed for invoice ${invId}: ${e.message}`);
      }
      try {
        const fresh = await db('invoices').where({ id: invId }).first();
        if (fresh) await require('./annual-prepay-renewals').syncTermForInvoicePayment(fresh);
      } catch (e) {
        logger.warn(`[pay-combined] term sync failed for invoice ${invId}: ${e.message}`);
      }
      // The durable receipt job is NOT best-effort (codex r2 P2): the queue
      // row is the only durable form of the customer's receipt once this
      // settle commits, so an enqueue failure must THROW — the webhook
      // 500s, Stripe redelivers, and the idempotent settle re-runs this
      // loop (mirrors the single-invoice /confirm, which awaits the
      // enqueue uncaught).
      const ReceiptDeliveryQueue = require('./receipt-delivery-queue');
      await ReceiptDeliveryQueue.enqueueReceiptDelivery({
        invoiceId: invId,
        stripePaymentIntentId: piId,
        source: 'combined_pay',
      });
    }
    try {
      require('./receipt-delivery-queue').scheduleReceiptDeliveryDrain({ delayMs: 1000, limit: 10 });
    } catch { /* drain is interval-backed */ }
  }

  return { settled: settledInvoiceIds.length, paymentStatus, invoiceIds: settledInvoiceIds, anchorPaymentRow };
}

function safeJson(value) {
  try { return JSON.parse(value); } catch { return null; }
}

// Durable operator queue entry for an allocation share that could NOT be
// settled onto its invoice (row missing/void/already paid elsewhere): the
// money is captured, so the shortfall must be loud, never silent.
async function recordResidual(trx, paymentIntent, entry, reason, { isAnchor = false, surchargeCents = 0, provisional = false } = {}) {
  await trx('stripe_orphan_charges')
    .insert({
      stripe_payment_intent_id: `${paymentIntent.id}:${entry.invoiceId}`,
      stripe_charge_id: typeof paymentIntent.latest_charge === 'string'
        ? paymentIntent.latest_charge
        : paymentIntent.latest_charge?.id || null,
      customer_id: paymentIntent.metadata?.waves_customer_id || null,
      invoice_id: entry.invoiceId,
      // The anchor's residual carries the captured card surcharge too
      // (codex r17 P2): the whole surcharge was assigned to the anchor's
      // share, and with no anchor payment row it would otherwise vanish
      // from the ledger AND from the amount operators reconcile/refund.
      amount: (entry.cents + (isAnchor ? surchargeCents : 0)) / 100,
      // PROVISIONAL residuals (codex r27 P2) come from the PROCESSING-stage
      // settle — the ACH cash has not arrived yet, and the failure/cancel
      // handlers resolve them by this source when the debit terminates
      // without settling.
      source: provisional ? 'combined_pay_processing' : 'combined_pay_webhook',
      original_db_error: String(`${reason}${isAnchor && surchargeCents > 0 ? ` (includes $${(surchargeCents / 100).toFixed(2)} card surcharge assigned to the anchor share)` : ''}`).slice(0, 1000),
    })
    .onConflict('stripe_payment_intent_id')
    .ignore();
  // A PAID settle upgrades a still-provisional row to the durable source
  // and RE-OPENS it (the cash has now genuinely arrived unmatched) — so
  // the refund/dispute cleanups, which match 'combined_pay_webhook', can
  // resolve it later. Targeted by source, so operator-resolved durable
  // cases are never re-opened by a webhook redelivery.
  if (!provisional) {
    await trx('stripe_orphan_charges')
      .where({ stripe_payment_intent_id: `${paymentIntent.id}:${entry.invoiceId}`, source: 'combined_pay_processing' })
      .update({ source: 'combined_pay_webhook', resolved: false, resolved_at: null, resolution_notes: null });
  }
}

module.exports = {
  MAX_COMBINED_SIBLINGS,
  amountDueCents,
  combinedEligibleSiblings,
  buildAllocation,
  allocationTotalCents,
  encodeAllocation,
  parseCombinedAllocation,
  isCombinedPiMetadata,
  verifyAllocationLocked,
  paymentIntentOwnsInvoice,
  combinedContextForInvoice,
  clearPaymentIntentStamps,
  lockCombinedCustomers,
  releaseUnconfirmedCombinedSessionsForScheduledServices,
  releaseUnconfirmedCombinedSessionsForCustomer,
  releaseCombinedSessionBeforeCollection,
  revokeOutstandingCombinedSessionsOnGateOff,
  settleCombinedPaymentIntent,
};
