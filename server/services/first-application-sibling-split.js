// Same-trip first-application resplit (prod 2026-09-26): a reserved-accept
// slot that sold MORE than one recurring program mints ONE draft invoice for
// the combined same-day total, linked to the RESERVED row
// (invoices.scheduled_service_id) — its "First service application" line
// carries every program's first visit. Every OTHER program's promoted parent
// is left with estimated_price NULL on purpose: closeout treats it as
// `sibling_first_application`, covered by the reserved row's invoice (see
// estimate-converter.js reservedAcceptPerVisitSplit and
// estimate-first-application-invoice.findFirstApplicationInvoiceForEstimateService).
//
// That coverage is DATE-KEYED: findFirstApplicationInvoiceForEstimateService
// only matches when the invoice's own linked row shares the LOOKING row's
// scheduled_date. Once one of the two visits is rescheduled off the other's
// day, the date match breaks — the invoice-holding row still auto-charges
// its full (still-combined) amount at its own completion, while the moved
// sibling's completion finds no covering invoice and its NULL estimated_price
// bills nothing. The customer pays the full combined total on the date that
// happens to complete first and nothing on the other.
//
// This module is the ONE chokepoint every date-changing writer calls (inside
// the SAME transaction as the date write) to close that gap: when a member
// of a first-application-invoice group no longer shares the invoice row's
// date, peel that member's own quoted per-visit share
// (recurring_template_overrides.anchored_split_per_visit — the exact
// per-program amount the accept route stamped on EVERY member's own row,
// reserved and promoted alike; see recurring-appointment-seeder.js
// markParentRecurring) off the shared invoice line and give each row its own
// estimated_price. After the split, each visit's own completion bills its
// own amount through the ordinary per-application path — no more shared
// coverage to reason about.
//
// STRUCTURAL NOTE (Codex round 2, #5021): every prior round here found ONE
// MORE money-safety fence InvoiceService.update() already enforced that this
// module had hand-copied incompletely or not at all (a saved-card charge
// attempt, a document-level discount, an active payment plan...). Rather
// than adding a sixth hand-rolled check, the invoice-reduction write below
// goes through the SAME shared fence functions invoice.js exports for
// update()'s own retotal path (invoiceHasActivePaymentPlan /
// excludeActivePaymentPlan, invoiceHasUnresolvedChargeAttempt,
// invoiceHasUnbackedDocumentDiscount) — one chokepoint, so a future fix
// there reaches this module automatically. The provenance marker's own
// validity problem (an edited source invoice after the split) is closed the
// same way: invoice.js's update() refuses to ever retotal a source invoice
// this module has split (invoiceIsFirstApplicationSplitSource /
// excludeFirstApplicationSplitSource) — the marker on the sibling row never
// needs to be revalidated because the source invoice it points at can no
// longer drift out from under it.
const logger = require('./logger');

// recurring_template_overrides key stamped on a row THIS module actually
// split off a shared first-application invoice, alongside its new
// estimated_price, in the SAME write. Its presence is what completion
// (complete-scheduled-service.js) checks before ever treating a row as no
// longer covered by a sibling's invoice — never estimated_price alone,
// which an unrelated price edit could set without the shared invoice ever
// having been reduced.
const SPLIT_PROVENANCE_KEY = 'first_application_split_invoice_id';

// The invoice id this row was split off of, or null if it never was (or the
// field is unreadable). Exported for complete-scheduled-service.js's
// completion-coverage guard. The marker is trusted permanently — see the
// STRUCTURAL NOTE above for why that is safe: InvoiceService.update() fences
// edits to a source invoice this module has ever split, so the invoice this
// id points at can never drift back to covering the sibling again.
function splitFromSharedInvoiceId(row) {
  let raw = row?.recurring_template_overrides;
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch { return null; }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  return raw[SPLIT_PROVENANCE_KEY] || null;
}

function dateOnly(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).split('T')[0].slice(0, 10);
}

function roundMoney(value) {
  return Math.round(Number(value) * 100) / 100;
}

// The per-visit share the accept route stamped on THIS row
// (recurring_template_overrides.anchored_split_per_visit) — provenance only,
// never inferred from a sibling's price or the invoice total.
function anchoredSplitPerVisit(row) {
  let raw = row?.recurring_template_overrides;
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch { return null; }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const amount = Number(raw.anchored_split_per_visit);
  return amount > 0 ? roundMoney(amount) : null;
}

function parseLineItems(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function hasPositiveSetupFeeLine(lineItems) {
  return lineItems.some((li) => {
    const desc = String(li?.description || '');
    if (!/setup fee/i.test(desc)) return false;
    const qty = li?.quantity != null ? Number(li.quantity) : 1;
    const amt = li?.amount != null ? Number(li.amount) : Number(li?.unit_price) * qty;
    return Number.isFinite(amt) && amt > 0;
  });
}

// Any negative line (a discount or credit — `_kind: 'discount'`, a plain
// literal credit, or a deposit-credit line the caller's own check missed)
// means the invoice's TOTAL is already net of something this module's math
// never accounts for: `remaining` below only ever subtracts a sibling's
// share from the GROSS base-application line, then writes that gross figure
// straight onto the reserved row's estimated_price. A later remint from
// that price alone (e.g. after the invoice is voided) would recreate the
// full gross charge and silently drop the discount (codex pre-push P0).
// Decline rather than guess how to net it out — same posture as the
// deposit-credit and setup-fee checks above.
function hasNegativeAdjustmentLine(lineItems) {
  return lineItems.some((li) => {
    const qty = li?.quantity != null ? Number(li.quantity) : 1;
    const amt = li?.amount != null ? Number(li.amount) : Number(li?.unit_price) * qty;
    return Number.isFinite(amt) && amt < 0;
  });
}

// Durable billing-review alert for ANY outcome that leaves a diverging
// sibling unpriced and uncovered — a whole-invoice decline (Codex P1,
// rebooker.js :1750), every sibling in the batch declined individually
// ('ineligible_siblings' — no anchored share, or the invoice's remaining
// line couldn't cover its share), or a PARTIAL split where some siblings
// split off cleanly but others did not (Codex pre-push round-2 P1: those
// declined siblings are unpriced AND no longer covered by anything — the
// invoice was already reduced for the siblings that DID split). None of
// these may be a log line only. Reuses the existing admin billing-review
// mechanism (notification-service's notifyAdmin, category 'billing' — the
// same one complete-scheduled-service.js's terminal-invoice /
// unminted-setup-fee manual-billing alerts use) rather than inventing a new
// table. Runs in its OWN savepoint off the caller's trx (mirrors the
// activity_log insert below) — a notification failure must never poison
// the transaction that is otherwise a clean split or no-op decline.
async function raiseDeclinedSplitAlert(trx, moved, invoice, reason, declines = []) {
  try {
    const declineDetail = declines.length
      ? ` Sibling visit(s) could not be priced: ${declines.map((d) => `${d.id} (${d.reason})`).join(', ')}.`
      : '';
    await trx.transaction((logTrx) => require('./notification-service').notifyAdmin(
      'billing',
      'First-application invoice needs manual review — a same-trip visit moved days',
      `Estimate #${moved.source_estimate_id}: a visit shared a first-application invoice (${invoice.invoice_number || invoice.id}) with a sibling that just moved to a different day, but the automatic split declined (${reason}).${declineDetail} The invoice-holding visit will still bill the FULL combined amount at its own completion (or, for a partial split, its already-reduced amount), and the affected sibling's price is unset and now uncovered — resolve the split manually before either visit completes.`,
      {
        link: `/admin/invoices?invoice=${invoice.id}`,
        bell: true,
        metadata: {
          estimateId: moved.source_estimate_id,
          invoiceId: invoice.id,
          movedScheduledServiceId: moved.id,
          reason,
          ...(declines.length ? { declines } : {}),
        },
        dedupeKey: `first_application_split_declined:${invoice.id}`,
        refreshOnDedupe: true,
        trx: logTrx,
      },
    ));
  } catch (e) {
    logger.warn(`[first-application-sibling-split] billing-review alert failed for estimate ${moved.source_estimate_id}, invoice ${invoice.id} (non-blocking): ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// Eligibility classifier: every read and every decline/skip decision, with
// NO money mutation. Kept separate from applySplitMutation (Codex P2 —
// AGENTS.md complexity threshold) so the "should this split happen, and for
// how much" question and the "commit the reduction" question can each be
// read on their own. Returns either a terminal result (the caller returns it
// as-is) or { eligible: true, ...everything the mutation needs }.
// ---------------------------------------------------------------------------
// Locates the estimate-accept group's locked member rows for a moved row,
// or a terminal skip when this row cannot be part of one. Split out of
// classifySplitEligibility (Codex P2, AGENTS.md complexity threshold) so
// "which rows are in play" is its own small decision, not folded into the
// same function as "is the invoice safe to retotal" and "how much does each
// sibling get".
async function loadLockedEstimateGroup(trx, scheduledServiceId) {
  const moved = await trx('scheduled_services')
    .where({ id: scheduledServiceId })
    .first('id', 'customer_id', 'source_estimate_id', 'recurring_parent_id');
  // Only a top-of-series (or one-time) row can be a first-application
  // invoice's reserved or promoted member — a later CHILD occurrence's date
  // is unrelated to the accept-time split.
  if (!moved || !moved.customer_id || !moved.source_estimate_id || moved.recurring_parent_id) {
    return { skip: { action: 'skipped', reason: 'not_estimate_anchor' } };
  }
  // Lock every member of this estimate's accept group up front — the split
  // reads and writes several of these rows together and must not race a
  // concurrent completion or a second reschedule of a sibling.
  const members = await trx('scheduled_services')
    .where({ customer_id: moved.customer_id, source_estimate_id: moved.source_estimate_id })
    .whereNull('recurring_parent_id')
    .forUpdate()
    .select('id', 'scheduled_date', 'estimated_price', 'primary_line_price', 'completed_at', 'recurring_template_overrides');
  if (members.length < 2) return { skip: { action: 'skipped', reason: 'no_siblings', moved } };
  return { moved, members };
}

// Locates the locked draft first-application invoice for this group's
// members and its invoice-holding row, or a terminal skip. Purely a LOOKUP
// — no money-safety judgment (that is checkInvoiceRetotalSafety below).
async function findLockedFirstApplicationInvoice(trx, moved, members) {
  const { isAutoGeneratedPayPerApplicationInvoice } = require('./estimate-first-application-invoice');
  const memberIds = members.map((m) => m.id);
  const draftCandidates = await trx('invoices')
    .whereIn('scheduled_service_id', memberIds)
    // Only when the invoice is still a fully open draft — unsent, unpaid, no
    // PaymentIntent, no payer-statement roll-up, no account credit applied.
    // A sent/viewed/paid invoice already reached the customer with the
    // combined total; re-splitting it now would either strand AR or double
    // the sibling's charge, so it is left untouched (declined, logged).
    .where('status', 'draft')
    .whereNull('paid_at')
    .whereNull('payment_recorded_at')
    .whereNull('stripe_payment_intent_id')
    .whereNull('payer_statement_id')
    .where((qb) => qb.whereNull('credit_applied').orWhere('credit_applied', 0))
    .orderBy('created_at', 'desc')
    // Locked for the rest of this transaction: the read above decides
    // eligibility and the write below recalculates money off that same
    // row — a concurrent send/payment/credit landing in between must not
    // overwrite itself with stale financials.
    .forUpdate()
    .select('*');
  const invoice = draftCandidates.find((inv) => isAutoGeneratedPayPerApplicationInvoice(inv));
  if (!invoice) return { skip: { action: 'skipped', reason: 'no_draft_first_application_invoice', moved } };

  const invoiceRow = members.find((m) => String(m.id) === String(invoice.scheduled_service_id));
  // Never touch a completed row's money — a completed invoice-holding visit
  // means the combined amount was already (or is about to be) charged at
  // completion; the invoice's own status guard above already excludes almost
  // every such case, but a same-tick race is closed here too.
  if (!invoiceRow || invoiceRow.completed_at) {
    return { skip: { action: 'skipped', reason: 'invoice_row_completed_or_missing', moved, invoice } };
  }
  return { invoice, invoiceRow };
}

// Every money-safety decline check — deposit credit, active payment plan,
// unresolved saved-card charge, setup fee, discount/credit line, unbacked
// document-level discount. Returns a decline reason string, or null when
// the invoice is safe to retotal. Isolated so this file's ONE list of
// "reasons a shared invoice must not be retotaled" reads as a flat sequence
// instead of being interleaved with lookup and per-sibling math (Codex P2).
// The active-payment-plan and unresolved-charge-attempt checks are the SAME
// shared functions InvoiceService.update()'s own retotal path calls — see
// the STRUCTURAL NOTE at the top of this file.
async function checkInvoiceRetotalSafety(trx, moved, invoice, lineItems) {
  const InvoiceService = require('./invoice');
  const warn = (msg) => logger.warn(`[first-application-sibling-split] estimate ${moved.source_estimate_id}: ${msg}`);

  if (InvoiceService._invoiceHasDepositCreditLine(invoice)) {
    warn(`declining resplit — invoice ${invoice.id} carries a deposit credit line`);
    return 'deposit_credit_present';
  }

  // Active payment plan (Codex P1, :164): a plan created off this invoice's
  // total BEFORE this split runs freezes payment_plans.total_balance at the
  // combined amount — plan creation never stamps the invoice itself, so no
  // column predicate can see it. Reducing the invoice now would leave the
  // plan collecting the stale combined balance while the sibling is ALSO
  // billed separately for its carved-out share.
  try {
    if (await InvoiceService._invoiceHasActivePaymentPlan(trx, invoice.id)) {
      warn(`declining resplit — invoice ${invoice.id} has an active payment plan`);
      return 'active_payment_plan';
    }
  } catch (e) {
    logger.error(`[first-application-sibling-split] estimate ${moved.source_estimate_id}: could not verify the active payment plan state on invoice ${invoice.id} — refusing to resplit (${e.message})`);
    return 'active_payment_plan_unverifiable';
  }

  // Saved-card (charge-card) attempts commit a durable claimed/ambiguous
  // row BEFORE the charge reconciles — in that window there may be no
  // payments row and no invoice PI yet, but an off-session charge may
  // still settle. A retotal would let the webhook/reconciler bind
  // collected money to a different live total. Same unresolved-attempt
  // shape the pay page's cross-rail fence uses.
  try {
    if (await InvoiceService._invoiceHasUnresolvedChargeAttempt(trx, invoice.id)) {
      warn(`declining resplit — invoice ${invoice.id} has an unresolved saved-card charge attempt`);
      return 'unresolved_charge_attempt_present';
    }
  } catch (e) {
    logger.error(`[first-application-sibling-split] estimate ${moved.source_estimate_id}: could not verify the saved-card charge state on invoice ${invoice.id} — refusing to resplit (${e.message})`);
    return 'unresolved_charge_attempt_unverifiable';
  }

  if (hasPositiveSetupFeeLine(lineItems)) {
    warn(`declining resplit — invoice ${invoice.id} carries a one-time setup-fee line`);
    return 'setup_fee_present';
  }

  if (hasNegativeAdjustmentLine(lineItems)) {
    warn(`declining resplit — invoice ${invoice.id} carries a discount/credit line`);
    return 'discount_or_credit_present';
  }

  // Document-level discount with NO backing line item (Codex P1, :219) —
  // hasNegativeAdjustmentLine above only catches a discount already
  // materialized as a negative line; InvoiceService.create's `discountIds`
  // manual picks persist a positive invoice.discount_amount with no such
  // line at all. Same shared check invoice.js's update() now declines a
  // retotal on.
  if (InvoiceService._invoiceHasUnbackedDocumentDiscount(invoice, lineItems)) {
    warn(`declining resplit — invoice ${invoice.id} carries a document-level discount with no backing line item`);
    return 'document_level_discount_present';
  }

  return null;
}

// Finds the ONE combined base-application line to peel shares off of, or a
// terminal skip/decline. lineIsBaseApplication also matches an ALREADY
// itemized invoice's per-member lines (itemizeFirstApplication under
// GATE_VISIT_CLOSEOUT) — more than one match means this invoice needs its
// OWN per-member resplit, not this single-line one, so that case declines
// rather than guessing which line is whose.
function resolveBaseApplicationLineIndex(moved, invoice, lineItems) {
  const InvoiceService = require('./invoice');
  const { lineIsBaseApplication } = InvoiceService;
  const isPositiveBaseApplicationLine = (li) => {
    if (!lineIsBaseApplication(li)) return false;
    const qty = li?.quantity != null ? Number(li.quantity) : 1;
    const amt = li?.amount != null ? Number(li.amount) : Number(li?.unit_price) * qty;
    return Number.isFinite(amt) && amt > 0;
  };
  const indexes = lineItems.reduce((acc, li, index) => {
    if (isPositiveBaseApplicationLine(li)) acc.push(index);
    return acc;
  }, []);
  if (indexes.length === 0) return { skip: { action: 'skipped', reason: 'no_first_application_line', moved, invoice } };
  if (indexes.length > 1) {
    logger.warn(`[first-application-sibling-split] estimate ${moved.source_estimate_id}: declining resplit — invoice ${invoice.id} already carries ${indexes.length} itemized base-application lines`);
    return { skip: { action: 'declined', reason: 'itemized_invoice', moved, invoice } };
  }
  return { lineIndex: indexes[0] };
}

// Members that still might need a split off this invoice: not the
// invoice-holding row itself, never a completed row's money, already-priced
// (idempotent no-op — this is also what makes a move BACK to the same day a
// no-op: once split, a row bills its own amount regardless of date), and
// still sharing the invoice row's date (nothing diverged). A CHEAP, pure
// filter with no DB reads — used as an early gate (Codex P1: money-safety
// checks and the decline billing-review alert must never run for a same-day
// no-op save that has nothing to split, regardless of what the invoice's
// line items happen to look like) and again inside computeSiblingSplits to
// build the actual per-sibling amounts.
function divergingUnpricedSiblings(invoiceRow, members) {
  const invoiceDate = dateOnly(invoiceRow.scheduled_date);
  return members.filter((m) => String(m.id) !== String(invoiceRow.id)
    && !m.completed_at
    && m.estimated_price == null
    && dateOnly(m.scheduled_date) !== invoiceDate);
}

// Peels each diverging, unpriced sibling's own anchored share off the
// combined line total. Pure arithmetic over already-locked rows — no DB
// reads or writes (those are applySplitMutation's job).
function computeSiblingSplits(invoiceRow, members, lineItems, lineIndex) {
  const candidates = divergingUnpricedSiblings(invoiceRow, members)
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));

  let remaining = roundMoney(lineItems[lineIndex].amount ?? lineItems[lineIndex].unit_price);
  const splits = [];
  const declines = [];
  for (const sib of candidates) {
    const share = anchoredSplitPerVisit(sib);
    if (!(share > 0)) {
      declines.push({ id: sib.id, reason: 'no_anchored_split' });
      continue;
    }
    if (share > remaining) {
      declines.push({ id: sib.id, reason: 'line_amount_insufficient' });
      continue;
    }
    remaining = roundMoney(remaining - share);
    splits.push({ id: sib.id, amount: share, primaryLinePriceSet: sib.primary_line_price != null });
  }
  return { remaining, splits, declines };
}

async function classifySplitEligibility(trx, scheduledServiceId) {
  if (!trx || !scheduledServiceId) return { action: 'skipped', reason: 'missing_args' };

  const group = await loadLockedEstimateGroup(trx, scheduledServiceId);
  if (group.skip) return group.skip;
  const { moved, members } = group;

  const located = await findLockedFirstApplicationInvoice(trx, moved, members);
  if (located.skip) return located.skip;
  const { invoice, invoiceRow } = located;

  // Cheap gate BEFORE any money-safety judgment, decline, or billing-review
  // alert (Codex P1): a caller that supplies scheduled_date unconditionally
  // whenever it appears in the payload (admin-schedule.js's update-details
  // save calls this on ANY scheduled_date field present, even resubmitted
  // unchanged) must never raise a false "needs manual review" alert over
  // an invoice's setup fee/discount/payment-plan shape when nothing here
  // actually diverged — there is nothing for this module to split either
  // way, so the invoice's own shape is irrelevant.
  if (!divergingUnpricedSiblings(invoiceRow, members).length) {
    return { action: 'skipped', reason: 'no_diverging_unpriced_sibling', moved, invoice };
  }

  const lineItems = parseLineItems(invoice.line_items);
  if (!lineItems) return { action: 'skipped', reason: 'unreadable_line_items', moved, invoice };

  const declineReason = await checkInvoiceRetotalSafety(trx, moved, invoice, lineItems);
  if (declineReason) return { action: 'declined', reason: declineReason, moved, invoice };

  const lineResult = resolveBaseApplicationLineIndex(moved, invoice, lineItems);
  if (lineResult.skip) return lineResult.skip;
  const { lineIndex } = lineResult;

  const { remaining, splits, declines } = computeSiblingSplits(invoiceRow, members, lineItems, lineIndex);
  if (declines.length) {
    logger.warn(`[first-application-sibling-split] estimate ${moved.source_estimate_id}: declined ${declines.length} sibling(s) on invoice ${invoice.id}: ${JSON.stringify(declines)}`);
  }
  if (!splits.length) {
    return {
      action: 'skipped',
      reason: declines.length ? 'ineligible_siblings' : 'no_diverging_unpriced_sibling',
      moved,
      invoice,
      declines,
    };
  }

  return {
    eligible: true,
    moved,
    invoice,
    invoiceRow,
    lineItems,
    lineIndex,
    remaining,
    splits,
    declines,
  };
}

// ---------------------------------------------------------------------------
// Locked mutation: commits the reduction this eligibility bundle describes.
// Assumes the invoice row and every member row are ALREADY locked (FOR
// UPDATE) by classifySplitEligibility in the SAME transaction — never called
// on its own with an unlocked bundle.
// ---------------------------------------------------------------------------
async function applySplitMutation(trx, classification) {
  const { moved, invoice, invoiceRow, lineItems, lineIndex, remaining, splits, declines } = classification;
  const InvoiceService = require('./invoice');

  const updatedLineItems = lineItems.slice();
  // `remaining` is a LINE TOTAL, not a per-unit price — quantity must be
  // pinned to 1 alongside it. calculateUpdateFinancials's own
  // normalizeInvoiceLineItems always recomputes amount as
  // quantity * unit_price and ignores whatever `amount` is passed in, so
  // keeping the ORIGINAL quantity (e.g. 2) here would double the reduced
  // total on this line — never trust the passed amount field, always
  // write the line as (quantity: 1, unit_price: remaining) (Codex
  // pre-push P0).
  updatedLineItems[lineIndex] = { ...updatedLineItems[lineIndex], quantity: 1, unit_price: remaining, amount: remaining };

  const customer = await trx('customers').where({ id: invoice.customer_id }).first('property_type');
  const financials = await InvoiceService._internals.calculateUpdateFinancials({
    lineItems: updatedLineItems,
    customer,
    invoice,
    taxRate: invoice.tax_rate,
  });

  // Same active-payment-plan fence InvoiceService.update()'s editQuery
  // applies AT WRITE TIME (excludeActivePaymentPlan) — re-asserted here so a
  // plan created between classifySplitEligibility's pre-check and this write
  // still blocks the reduction instead of racing it.
  const invoiceUpdated = await InvoiceService._excludeActivePaymentPlan(
    trx('invoices')
      .where({ id: invoice.id, status: 'draft' })
      .whereNull('paid_at')
      .whereNull('payment_recorded_at')
      .whereNull('stripe_payment_intent_id')
      .whereNull('payer_statement_id')
      .where((qb) => qb.whereNull('credit_applied').orWhere('credit_applied', 0)),
  ).update({ ...financials, updated_at: new Date() });
  if (!invoiceUpdated) {
    logger.error(`[first-application-sibling-split] estimate ${moved.source_estimate_id}: invoice ${invoice.id} changed state concurrently — resplit aborted for this pass`);
    return { action: 'skipped', reason: 'invoice_changed_concurrently', invoiceId: invoice.id };
  }

  // invoice.js's buildScheduledServiceInvoiceLines PREFERS a populated
  // primary_line_price over estimated_price when reminting a row's own
  // invoice line — updating estimated_price alone would leave a remint
  // (e.g. after this invoice is later voided) billing the stale, pre-split
  // structured price instead of the reduced/carved-out figure, double-
  // billing against the sibling's own separate charge (Codex pre-push P0).
  // Keep both in lockstep, exactly like estimate-converter.js's own
  // price-change write, and ONLY when it was already populated.
  await trx('scheduled_services').where({ id: invoiceRow.id }).update({
    estimated_price: remaining,
    ...(invoiceRow.primary_line_price != null ? { primary_line_price: remaining } : {}),
  });
  for (const split of splits) {
    // Stamp explicit provenance ALONGSIDE the price, not the price alone:
    // completion (complete-scheduled-service.js) must never infer "this row
    // was split off a sibling's invoice" from estimated_price being non-null
    // by itself — an unrelated price edit through some other flow (a manual
    // reprice) could set estimated_price on a row that was never actually
    // carved out of anything, while the shared invoice still carries its
    // full uncollapsed amount; treating that as "already split" would let
    // the row bill on its own AND leave the still-collectible shared invoice
    // double-covering it. This marker is written ONLY here, in the same
    // transaction as the real reduction, so its presence is proof the
    // reduction actually happened. Its validity going forward is protected
    // by InvoiceService.update()'s own provenance fence (see the STRUCTURAL
    // NOTE at the top of this file), not by anything re-checked here.
    await trx('scheduled_services').where({ id: split.id }).update({
      estimated_price: split.amount,
      // Same lockstep reconciliation as the invoice-holding row above.
      ...(split.primaryLinePriceSet ? { primary_line_price: split.amount } : {}),
      recurring_template_overrides: trx.raw(
        "COALESCE(recurring_template_overrides, '{}'::jsonb) || ?::jsonb",
        [JSON.stringify({ [SPLIT_PROVENANCE_KEY]: invoice.id })],
      ),
    });
  }

  const splitDescription = splits.map((s) => `visit ${s.id} → $${s.amount.toFixed(2)}`).join(', ');
  // Audit-only — in its OWN savepoint, separate from the money writes above:
  // on Postgres a failed statement aborts the whole transaction it ran in
  // until something rolls it back, so a plain try/catch around this insert
  // would not actually recover — it would leave the split's own writes
  // committed-but-unreachable (every later statement on this connection,
  // including COMMIT, would fail). A savepoint lets a log failure roll back
  // ONLY the log row while the split itself stays intact.
  try {
    await trx.transaction((logTrx) => logTrx('activity_log').insert({
      customer_id: moved.customer_id,
      action: 'first_application_invoice_resplit',
      description: `Estimate #${moved.source_estimate_id}: a same-trip visit moved to a different day than the shared first-application invoice (${invoice.invoice_number || invoice.id}). Split the "${lineItems[lineIndex].description}" line: visit ${invoiceRow.id} keeps $${remaining.toFixed(2)}; ${splitDescription}.`,
      metadata: JSON.stringify({
        estimateId: moved.source_estimate_id,
        invoiceId: invoice.id,
        invoiceRowId: invoiceRow.id,
        remaining,
        splits,
        declines,
      }),
    }));
  } catch (e) {
    logger.warn(`[first-application-sibling-split] activity_log insert failed (non-blocking): ${e.message}`);
  }

  logger.info(`[first-application-sibling-split] estimate ${moved.source_estimate_id}: split invoice ${invoice.id} — visit ${invoiceRow.id} keeps $${remaining.toFixed(2)}, ${splits.length} sibling(s) split off (${splitDescription})`);
  return { action: 'split', invoiceId: invoice.id, invoiceRowId: invoiceRow.id, remaining, splits, declines };
}

/**
 * Called after ANY write that changes scheduled_date on a top-of-series (or
 * one-time) scheduled_services row, inside the SAME transaction as that
 * write. Idempotent and side-effect-free unless it actually finds a diverging
 * unpriced sibling to split off — safe to call unconditionally whenever a
 * date-changing writer wants the guarantee, and cheap to skip (an early
 * return) for rows that never touched an estimate accept.
 *
 * A DECLINED outcome (the invoice exists but is not safe to retotal — a
 * setup fee, a discount, an active payment plan, an in-flight charge...),
 * every diverging sibling declined individually ('ineligible_siblings' — no
 * anchored share, or the invoice's remaining line couldn't cover its
 * share), or a PARTIAL split (some siblings split cleanly, others did not)
 * all raise the SAME durable billing-review bell (see raiseDeclinedSplitAlert)
 * so the office sees it — the move itself is never blocked; blocking would
 * refuse a legitimate reschedule over an invoice-level edge case unrelated
 * to the move itself, and every one of these states is rare and already
 * staff-visible on the invoice.
 *
 * @param {import('knex').Knex.Transaction} trx - the caller's OPEN transaction
 * @param {string} scheduledServiceId - the row whose date just changed (post-write id)
 */
async function reconcileFirstApplicationSplitOnDateChange(trx, scheduledServiceId) {
  const classification = await classifySplitEligibility(trx, scheduledServiceId);
  if (classification.action === 'declined') {
    await raiseDeclinedSplitAlert(trx, classification.moved, classification.invoice, classification.reason);
    return { action: 'declined', reason: classification.reason, invoiceId: classification.invoice.id };
  }
  if (!classification.eligible) {
    // 'ineligible_siblings' means at least one diverging unpriced sibling
    // COULD NOT be allocated a price — a real money gap (Codex pre-push
    // round-2 P1), never just logged: the invoice-holding row still bills
    // its full uncollapsed amount while this sibling stays unpriced.
    if (classification.reason === 'ineligible_siblings' && classification.declines?.length) {
      await raiseDeclinedSplitAlert(trx, classification.moved, classification.invoice, classification.reason, classification.declines);
    }
    // Narrow, JSON-safe result — never leak the full locked invoice/member
    // rows classifySplitEligibility carries internally to whatever caller
    // holds this (some await it without using it; none should ever need
    // more than action/reason/invoiceId/declines).
    const { action, reason, invoice, declines } = classification;
    return {
      action,
      reason,
      ...(invoice ? { invoiceId: invoice.id } : {}),
      ...(declines?.length ? { declines } : {}),
    };
  }
  const result = await applySplitMutation(trx, classification);
  // A PARTIAL split (some siblings split cleanly, others declined — no
  // anchored share, or the remaining line couldn't cover their share)
  // leaves those declined siblings unpriced AND now uncovered by anything:
  // the invoice was already reduced for the ones that DID split off.
  // Same durable alert as a whole-invoice decline (Codex pre-push round-2 P1).
  if (result.action === 'split' && result.declines?.length) {
    await raiseDeclinedSplitAlert(trx, classification.moved, classification.invoice, 'partial_split_ineligible_siblings', result.declines);
  }
  return result;
}

/**
 * Same as reconcileFirstApplicationSplitOnDateChange, but never blocks the
 * caller's own write: runs the reconcile in its own SAVEPOINT (a nested
 * transaction off the caller's trx), so a failure inside it rolls back only
 * the split's own statements and leaves the caller's transaction perfectly
 * usable for whatever it does next. A plain try/catch around the direct call
 * does NOT achieve this on Postgres: the first failing statement aborts the
 * WHOLE transaction it ran in, and every later statement on that connection
 * — including the caller's own COMMIT — fails until something rolls it back.
 * Every date-changing writer that has more work to do after this call (or
 * that simply wants the guarantee) should call this, not the plain function,
 * directly.
 */
async function reconcileFirstApplicationSplitOnDateChangeSafely(trx, scheduledServiceId, context = '') {
  try {
    return await trx.transaction((nested) => reconcileFirstApplicationSplitOnDateChange(nested, scheduledServiceId));
  } catch (err) {
    logger.error(`[first-application-sibling-split] reconcile failed for ${scheduledServiceId}${context ? ` (${context})` : ''} — caller's own write still commits: ${err.message}`);
    return { action: 'error', reason: err.message };
  }
}

module.exports = {
  reconcileFirstApplicationSplitOnDateChange,
  reconcileFirstApplicationSplitOnDateChangeSafely,
  anchoredSplitPerVisit,
  splitFromSharedInvoiceId,
  SPLIT_PROVENANCE_KEY,
  dateOnly,
  // Exported for direct unit coverage of the split; the safely-wrapped
  // orchestrator above is what every production caller uses.
  classifySplitEligibility,
  applySplitMutation,
};
