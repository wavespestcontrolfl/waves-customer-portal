// Same-trip first-application billing review (redesigned per owner ruling,
// 2026-09-26 — "flag, don't auto-split"): a reserved-accept slot that sold
// MORE than one recurring program mints ONE draft invoice for the combined
// same-day total, linked to the RESERVED row (invoices.scheduled_service_id)
// — its "First service application" line carries every program's first
// visit. Every OTHER program's promoted parent is left with estimated_price
// NULL on purpose: closeout treats it as `sibling_first_application`,
// covered by the reserved row's invoice (see estimate-converter.js
// reservedAcceptPerVisitSplit and estimate-first-application-invoice.js
// findFirstApplicationInvoiceForEstimateService).
//
// That coverage is DATE-KEYED: findFirstApplicationInvoiceForEstimateService
// only matches when the invoice's own linked row shares the LOOKING row's
// scheduled_date. Once one of the two visits is rescheduled off the other's
// day, the date match breaks — the invoice-holding row still auto-charges
// its full (still-combined) amount at its own completion, while the moved
// sibling's completion finds no covering invoice and its NULL
// estimated_price bills nothing.
//
// EARLIER DESIGN (superseded): a prior version of this module auto-split the
// shared invoice at move time — reducing its line, pricing the moved sibling
// with its own quoted share, and stamping provenance. Five straight Codex
// review rounds each found ONE MORE money-correctness gap in that mutation
// (payment plans, discounts, saved-card charge attempts, scheduled-send
// invoices, transient batch-mover snapshots...) — a structural sign that
// touching the invoice's money at reschedule time, outside the normal
// billing/collection surfaces, is the wrong shape for this fix.
//
// OWNER RULING: never touch the invoice on a date-diverging move. Instead,
// in the SAME transaction as the date write, open a durable billing-review
// item on the invoice (idempotent, keyed by invoice id — see
// invoices.billing_review_opened_at) — ALWAYS, regardless of the invoice's
// own delivery state, so the office always gets ONE record + ONE clear
// mechanism (admin-invoices.js's POST /:id/billing-review/clear) for this
// class of problem.
//
// ROUND-3 REDESIGN (#5021, Codex round-3 — the hold's blast radius was
// unbounded): the FIRST design held automatic collection unconditionally
// (server/services/invoice-helpers.js's assertInvoiceCollectible, the one
// gate every charge/send seam already calls) — but "every charge/send
// seam" turned out not to include an already-issued Stripe PaymentIntent a
// customer's own pay-page load can still confirm directly with Stripe, nor
// the invoice-followups.js dunning engine, nor any other seam nobody has
// enumerated yet. That surface is unbounded FOR A DELIVERED INVOICE — the
// customer already has it, and recalling money already in motion is not
// what a same-trip date divergence calls for.
//
// So the hold is now scoped to UNDELIVERED invoices only —
// invoice-helpers.js's isInvoiceUndeliveredForBillingReview ('draft':
// never sent; 'scheduled': queued, not yet sent; 'sending' claimed for an
// in-flight send AND never delivered before — a resend claim also parks
// at 'sending', so that status alone can't tell a first send from a
// resend of an already-delivered invoice; the delivery stamps break the
// tie). A genuinely-undelivered invoice has NO pay link out, NO
// PaymentIntent a customer could confirm, and NO dunning sequence
// (dunning only ever runs on a DELIVERED invoice) — the only money seams
// that can reach it are the ones that already gate on
// assertInvoiceCollectible or the two send-claim predicates, which is
// exactly the bounded set this hold protects. Once an invoice is (or was
// already) delivered — 'sent'/'viewed'/'overdue', or any terminal status
// — this module still opens the SAME durable review + admin alert, but
// assertInvoiceCollectible and the send-claim predicates never block it —
// the alert instead reads "already sent — review the split by hand", and
// the office resolves the mismatch out-of-band (adjust by hand, credit,
// or bill the sibling separately) rather than through an automatic hold.
//
// The office resolves either case by editing the invoice/prices by hand,
// then clears the review (POST /admin/invoices/:id/billing-review/clear —
// releases the hold when one was in effect, and is a no-op on enforcement
// either way for the alert-only case). A move that lands the diverging
// members BACK on the same date, with the invoice never touched since the
// review opened, clears itself (undelivered or not).
//
// FOLLOW-UP FIX (post-#5021, pre-push audit finding): the manual clear used
// to null out billing_review_context entirely, so the lookup had no memory
// that this invoice was ever reviewed and resolved — a LATER reschedule of
// ANY OTHER member of the same estimate-accept group (findLockedFirst-
// ApplicationInvoice still matches the same invoice by title/notes) could
// reopen a review + hold on an invoice the office had already correctly
// split by hand. clearBillingReview now writes a RESOLUTION record into
// billing_review_context instead of nulling it (opened_at/reason still go
// null — every existing hold/held/summary check gates on opened_at, never
// on context, so this changes nothing for them): resolvedAt, the acting
// admin (when known), the exact set of sibling scheduled_service ids this
// review covered, and the invoice's own money fingerprint at the moment of
// the clear. flagFirstApplicationInvoiceReviewOnDateChange checks that
// record (isDivergenceAlreadyResolved) before opening a fresh review: a
// later divergence is suppressed ONLY when every currently-diverging
// sibling is one this resolution already covered AND the invoice's money
// is byte-identical to how the office left it — a sibling this resolution
// never saw, or ANY change to the invoice's money since (either direction;
// the fingerprint alone can't tell "recombined" from "edited again for an
// unrelated reason", so any change is treated as suspicious), opens a
// fresh review exactly as if there had been no resolution at all. Auto-
// clear (maybeAutoClearBillingReview) deliberately does NOT record a
// resolution — realignment alone means nobody actually reviewed anything,
// so a later divergence there must always re-open normally.
const logger = require('./logger');
const db = require('../models/db');
const { isInvoiceUndeliveredForBillingReview, billingReviewVersion } = require('./invoice-helpers');

function dateOnly(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).split('T')[0].slice(0, 10);
}

// ---------------------------------------------------------------------------
// Lookup: which invoice (if any) is this row's estimate-accept group sharing,
// and has anything diverged? No money is read or written here.
// ---------------------------------------------------------------------------

// Locates the estimate-accept group's locked member rows for a moved row, or
// a terminal skip when this row cannot be part of one.
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
  // Lock every member of this estimate's accept group up front — the read
  // below must not race a concurrent completion or a second reschedule of a
  // sibling landing between this read and the flag write.
  const members = await trx('scheduled_services')
    .where({ customer_id: moved.customer_id, source_estimate_id: moved.source_estimate_id })
    .whereNull('recurring_parent_id')
    .forUpdate()
    .select('id', 'scheduled_date', 'estimated_price', 'completed_at');
  if (members.length < 2) return { skip: { action: 'skipped', reason: 'no_siblings', moved } };
  return { moved, members };
}

// Locates the locked first-application invoice linked to any member of this
// group, or a terminal skip. Reuses estimate-first-application-invoice.js's
// selectFirstApplicationInvoiceMatch — the SAME authoritative live/
// refunded/canceled precedence findFirstApplicationInvoiceForEstimateService
// applies for its own coverage lookup (#5021 round-3 P1: a plain
// `orderBy(created_at desc).find(...)` here used to let a newer CANCELED
// replacement invoice shadow an older LIVE invoice that is still the one
// actually collectible — the review would then anchor on a dead row while
// the real invoice stayed unreviewed and fully chargeable). A void invoice
// is excluded up front (never a candidate at all — its charge was never
// collected and a replacement, if any, is a separate row); among the rest,
// prefer the LIVE match (liveBeside when a refunded row also exists,
// otherwise the selector's own `invoice`) — a purely refunded/canceled
// group (no live invoice at all) has nothing left to protect or alert on
// and is skipped, same as "no first-application invoice".
async function findLockedFirstApplicationInvoice(trx, moved, members) {
  const { selectFirstApplicationInvoiceMatch } = require('./estimate-first-application-invoice');
  const memberIds = members.map((m) => m.id);
  const candidates = await trx('invoices')
    .whereIn('scheduled_service_id', memberIds)
    .whereNot('status', 'void')
    .orderBy('created_at', 'desc')
    .forUpdate()
    .select('*');
  const { invoice: selected, liveBeside } = selectFirstApplicationInvoiceMatch(candidates);
  const invoice = liveBeside || selected || null;
  if (!invoice) return { skip: { action: 'skipped', reason: 'no_first_application_invoice', moved } };

  const invoiceRow = members.find((m) => String(m.id) === String(invoice.scheduled_service_id));
  if (!invoiceRow) return { skip: { action: 'skipped', reason: 'invoice_row_missing', moved, invoice } };
  return { invoice, invoiceRow };
}

// A stable fingerprint of exactly the columns the collection hold actually
// protects — never `updated_at`, which is only a proxy other invoice-
// mutating code paths are conventionally supposed to bump and nothing
// enforces (Claude fallback-auditor P1, this branch's own first push): a
// write that changed real money but forgot to touch updated_at would let
// maybeAutoClearBillingReview treat a genuinely-edited, still-uncovered
// invoice as "untouched" and silently release the hold. Comparing the
// money fields themselves has no such gap — anything that actually changed
// what the customer owes shows up here directly.
function invoiceMoneyFingerprint(invoice) {
  return JSON.stringify({
    total: invoice?.total ?? null,
    subtotal: invoice?.subtotal ?? null,
    discount_amount: invoice?.discount_amount ?? null,
    status: invoice?.status ?? null,
    lineItems: parseLineItems(invoice?.line_items) || invoice?.line_items || null,
  });
}

// Money-ONLY fingerprint — everything invoiceMoneyFingerprint hashes
// EXCEPT `status` (pre-push P1: a manual-clear resolution's own money
// fingerprint must not include status. invoiceMoneyFingerprint's `status`
// field exists for maybeAutoClearBillingReview, whose window is short —
// review opened, sibling realigns soon after — where a status change
// plausibly means something happened to the invoice worth re-reviewing.
// A manual resolution's window is open-ended: the invoice goes on to
// progress through its ordinary delivery lifecycle — draft -> scheduled ->
// sending -> sent -> paid — with NO money change at all, purely because
// time passed and it got sent/paid normally. Reusing the status-inclusive
// fingerprint here would reopen a correctly-resolved review the moment the
// invoice was next sent or paid, exactly the false-reopen this fix exists
// to stop. isDivergenceAlreadyResolved and clearBillingReview's resolution
// record both use this one instead; maybeAutoClearBillingReview keeps
// invoiceMoneyFingerprint (with status) unchanged.
function invoiceMoneyOnlyFingerprint(invoice) {
  return JSON.stringify({
    total: invoice?.total ?? null,
    subtotal: invoice?.subtotal ?? null,
    discount_amount: invoice?.discount_amount ?? null,
    lineItems: parseLineItems(invoice?.line_items) || invoice?.line_items || null,
  });
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

// Members that have diverged from the invoice-holding row's date and have
// not completed (a completed row's billing outcome is already a settled
// fact this move cannot change). Pure filter, no DB reads.
//
// Deliberately does NOT require estimated_price == null (#5021 round-3 P1:
// it used to, dropping a sibling from review the instant it carried ANY
// price). update-details can set a date and a price in the SAME write —
// divergence alone must open the review regardless of whether the sibling
// was ever priced: the shared invoice's total was never reduced either
// way, so a now-priced-but-still-diverged sibling would otherwise complete
// AND bill its own new price while the invoice-holder's invoice still
// carries the full original combined total — a double bill with no
// review to catch it. maybeAutoClearBillingReview's own notResolved check
// already treats a recorded sibling that picked up a price as unresolved
// (fails closed, requires the manual clear) regardless of how it entered
// the record, so widening this filter cannot make auto-clear too lenient.
function divergingSiblings(invoiceRow, members) {
  const invoiceDate = dateOnly(invoiceRow.scheduled_date);
  return members.filter((m) => String(m.id) !== String(invoiceRow.id)
    && !m.completed_at
    && dateOnly(m.scheduled_date) !== invoiceDate);
}

// ---------------------------------------------------------------------------
// Durable review: open, idempotent, keyed by invoice id (invoices.
// billing_review_opened_at/_reason/_context). Never touches invoice money.
// ---------------------------------------------------------------------------

// Reuses the existing admin billing-review bell (notification-service's
// notifyAdmin, category 'billing' — the same mechanism complete-scheduled-
// service.js's manual-billing alerts use) so the office sees it, in ADDITION
// to the durable invoice-row flag the collection gate reads. Runs in its own
// savepoint off the caller's trx — a notification failure must never poison
// a transaction that otherwise just committed the date write cleanly.
//
// `held` (round-3): whether the invoice was still UNDELIVERED at the moment
// this review opened (invoice.status ∈ UNDELIVERED_INVOICE_STATUSES) — the
// only case where assertInvoiceCollectible / the send-claim predicates
// actually hold collection. A delivered invoice (sent/viewed/overdue) or a
// terminal one gets the SAME durable record and bell, worded as an alert
// only: the customer already has it, nothing is on hold, and the office
// resolves the mismatch by hand (adjust the invoice, credit, or bill the
// sibling separately).
//
// `dedupeVersion` (Codex #5021 round-3 P1: the bell never reopened on a
// RECURRING divergence): notifyAdmin's refreshOnDedupe only resets read_at
// when the content changed OR this version differs from what the standing
// row last stored. Every opening call here passes the SAME openedAt this
// invocation is about to stamp on invoices.billing_review_opened_at — a
// fresh open (after a prior review auto-cleared or was cleared by hand)
// gets a NEW openedAt and therefore a new version, so a recurrence always
// re-bells even though the title/body/link text is otherwise identical to
// the first opening. Accumulating a further sibling while STILL open keeps
// the ORIGINAL openedAt (see openBillingReview) and so the same version —
// deliberate: that is one continuous, still-unread review, not a new one.
async function raiseBillingReviewAlert(trx, invoice, moved, diverging, { held, dedupeVersion }) {
  try {
    const divergingDetail = diverging.length
      ? ` Sibling visit(s) diverged: ${diverging.map((d) => d.id).join(', ')}.`
      : '';
    const title = held
      ? 'First-application invoice needs manual review — a same-trip visit moved days'
      : 'First-application invoice already sent — a same-trip visit moved days, review the split by hand';
    const body = held
      ? `Estimate #${moved.source_estimate_id}: a visit shared a first-application invoice (${invoice.invoice_number || invoice.id}) with a sibling that just moved to a different day.${divergingDetail} The invoice-holding visit still bills the FULL combined amount at its own completion; a diverging sibling with no price of its own will complete WITHOUT billing unless the office prices it by hand, and one that WAS given its own price still leaves the shared invoice's total unreduced — either way this is a mismatch. Automatic collection on this invoice (auto-charge, saved-card charge, scheduled send) is on hold until the office resolves this by hand and clears the review (Admin → Invoices → this invoice).`
      : `Estimate #${moved.source_estimate_id}: a visit shared a first-application invoice (${invoice.invoice_number || invoice.id}) with a sibling that just moved to a different day, AFTER that invoice was already sent to the customer.${divergingDetail} The invoice already reached the customer at its combined total — nothing is on hold — but the split is now wrong: review it by hand (adjust the invoice, credit, or bill the sibling separately), then clear the review (Admin → Invoices → this invoice).`;
    await trx.transaction((logTrx) => require('./notification-service').notifyAdmin(
      'billing',
      title,
      body,
      {
        link: `/admin/invoices?invoice=${invoice.id}`,
        bell: true,
        metadata: {
          estimateId: moved.source_estimate_id,
          invoiceId: invoice.id,
          movedScheduledServiceId: moved.id,
          divergingSiblingIds: diverging.map((d) => d.id),
          held,
        },
        dedupeKey: `first_application_billing_review:${invoice.id}`,
        dedupeVersion,
        refreshOnDedupe: true,
        trx: logTrx,
      },
    ));
  } catch (e) {
    logger.warn(`[first-application-sibling-split] billing-review alert failed for estimate ${moved.source_estimate_id}, invoice ${invoice.id} (non-blocking): ${e.message}`);
  }
}

// A review already open keeps its ORIGINAL opened_at and money-fingerprint
// snapshot — but divergingSiblingIds ACCUMULATES (union, never replaces):
// the invoice-holding row's forUpdate lock (findLockedFirstApplicationInvoice)
// means this read-modify-write can't race a concurrent open, so merging in
// JS is safe without a second whereNull round trip. A later divergence (a
// DIFFERENT sibling, or the invoice-holder itself moving again) must not
// drop the FIRST sibling from the record — maybeAutoClearBillingReview
// requires every one of them back on the invoice's date before it will
// auto-clear.
async function openBillingReview(trx, invoice, moved, diverging) {
  let existingContext = invoice.billing_review_context;
  if (typeof existingContext === 'string') {
    try { existingContext = JSON.parse(existingContext); } catch { existingContext = null; }
  }
  const alreadyOpen = !!invoice.billing_review_opened_at;
  // The SAME openedAt this call is about to stamp (or, if already open,
  // the ORIGINAL one it is about to leave untouched) — used for both the
  // column write and the alert's dedupeVersion, so a fresh open and its
  // bell always agree on what "this opening" means (round-3 P1: computing
  // `new Date()` twice, once per use, could let the two drift by a tick).
  const openedAt = invoice.billing_review_opened_at ? new Date(invoice.billing_review_opened_at) : new Date();
  // Round-3: only an UNDELIVERED invoice is actually held — see the module
  // header and invoice-helpers.js's isInvoiceUndeliveredForBillingReview
  // (status alone is ambiguous for 'sending': a concurrent send claim can
  // put the invoice-holder at 'sending' whether or not it was EVER
  // delivered before, so the delivery stamps break the tie). A review
  // that opens after delivery gets the identical record and bell, worded
  // as an alert only (raiseBillingReviewAlert).
  const held = isInvoiceUndeliveredForBillingReview(invoice);
  const priorSiblingIds = Array.isArray(existingContext?.divergingSiblingIds) ? existingContext.divergingSiblingIds : [];
  const mergedSiblingIds = [...new Set([...priorSiblingIds, ...diverging.map((d) => String(d.id))])];
  const context = {
    sourceEstimateId: moved.source_estimate_id,
    invoiceHolderScheduledServiceId: invoice.scheduled_service_id,
    divergingSiblingIds: mergedSiblingIds,
    // The invoice's own money fields AT THE MOMENT this review FIRST opened
    // (see invoiceMoneyFingerprint) — never restamped on a later
    // divergence while already open, or an invoice edited in between would
    // get a fresh, already-edited baseline and wrongly read as "untouched"
    // going forward. Compared, not `updated_at`, to prove "the invoice was
    // never touched" at auto-clear time.
    invoiceMoneyFingerprintAtOpen: (alreadyOpen && typeof existingContext?.invoiceMoneyFingerprintAtOpen === 'string')
      ? existingContext.invoiceMoneyFingerprintAtOpen
      : invoiceMoneyFingerprint(invoice),
  };
  await trx('invoices')
    .where({ id: invoice.id })
    .update({
      billing_review_opened_at: openedAt,
      billing_review_reason: invoice.billing_review_reason || (held ? 'sibling_date_diverged' : 'sibling_date_diverged_after_delivery'),
      billing_review_context: JSON.stringify(context),
    });
  await raiseBillingReviewAlert(trx, invoice, moved, diverging, { held, dedupeVersion: openedAt.toISOString() });
  return { action: 'review_opened', invoiceId: invoice.id, opened: !alreadyOpen };
}

// Resolves the standing admin bell this review's own open raised
// (raiseBillingReviewAlert's dedupeKey) — mirrors the manual clear route
// (admin-invoices.js) so an auto-cleared review's bell doesn't sit unread
// forever once there is nothing left to review. Best-effort: a failure
// here must never block the actual hold release.
// Runs in its own savepoint off the caller's trx, exactly like
// raiseBillingReviewAlert above — a plain try/catch around a failing
// statement does NOT recover a Postgres transaction (the first failing
// statement aborts the whole transaction it ran in, and every later
// statement on that connection, including the caller's own COMMIT, fails
// until something rolls it back). Without the savepoint, a failure here
// would silently roll back the invoice UPDATE that just cleared the review
// too (Claude fallback-auditor P1, this branch's own fourth push) — the
// caller would report 'review_auto_cleared' for a clear that never
// actually persisted.
async function resolveBillingReviewAlert(trx, invoiceId) {
  try {
    await trx.transaction((nested) => nested('notifications')
      .where({ recipient_type: 'admin', category: 'billing' })
      .whereRaw("metadata->>'dedupeKey' = ?", [`first_application_billing_review:${invoiceId}`])
      .whereNull('read_at')
      .update({ read_at: new Date() }));
  } catch (e) {
    logger.warn(`[first-application-sibling-split] billing-review bell resolve failed for invoice ${invoiceId} (non-blocking): ${e.message}`);
  }
}

// The office's manual clear (POST /admin/invoices/:id/billing-review/clear
// — admin-invoices.js delegates here so the route and the tests share the
// ONE chokepoint). `expectedVersion` is billingReviewVersion(invoice) as
// the operator's page last read it (InvoiceService.getById/.list's
// billingReviewSummary): recomputed and compared HERE, under the row's own
// FOR UPDATE lock, so a review that changed since the operator loaded the
// page — most commonly a NEW sibling diverging into the same still-open
// review — is caught even if it happened between the page load and this
// call (Codex #5021 round-3 P1: clearing on stale information would
// silently drop that later divergence). Runs as its OWN transaction (a
// savepoint when `database` is already inside one, e.g. a test's
// rollbackTest wrapper) so the lock, the version check, and the clear are
// atomic — no window where a concurrent open lands between the check and
// the write.
//
// `actorId` (optional — the clearing admin's technicians.id, when the
// caller has one; admin-invoices.js passes req.technicianId) is stamped
// into the resolution record below purely for the office's own record —
// nothing in this module reads it back.
//
// Writes a RESOLUTION record into billing_review_context rather than
// nulling it (see the module header's FOLLOW-UP FIX note): the exact
// sibling ids this review covered (context.divergingSiblingIds as it
// stood at the moment of the clear — everything the office actually had a
// chance to look at) and the invoice's own money fingerprint as the office
// left it. isDivergenceAlreadyResolved reads this to decide whether a
// LATER, unrelated divergence should re-open a review at all.
async function clearBillingReview(invoiceId, expectedVersion, database = db, actorId = null) {
  return database.transaction(async (trx) => {
    const invoice = await trx('invoices').where({ id: invoiceId }).forUpdate().first();
    if (!invoice) return { code: 'not_found' };
    if (!invoice.billing_review_opened_at) return { code: 'idempotent', invoice };
    if (billingReviewVersion(invoice) !== expectedVersion) return { code: 'stale', invoice };
    let context = invoice.billing_review_context;
    if (typeof context === 'string') {
      try { context = JSON.parse(context); } catch { context = null; }
    }
    const resolution = {
      resolvedAt: new Date().toISOString(),
      resolvedBy: actorId || null,
      resolvedSiblingIds: Array.isArray(context?.divergingSiblingIds) ? context.divergingSiblingIds : [],
      // Money-only (no status) — see invoiceMoneyOnlyFingerprint: this
      // resolution's window is open-ended, so the invoice's own normal
      // delivery progress (draft -> scheduled -> sent -> paid) must never
      // by itself count as "the invoice changed".
      resolvedInvoiceMoneyFingerprint: invoiceMoneyOnlyFingerprint(invoice),
    };
    const [updated] = await trx('invoices')
      .where({ id: invoiceId })
      .whereNotNull('billing_review_opened_at')
      .update({
        billing_review_opened_at: null,
        billing_review_reason: null,
        billing_review_context: JSON.stringify(resolution),
      })
      .returning('*');
    await resolveBillingReviewAlert(trx, invoiceId);
    return { code: 'cleared', invoice: updated };
  });
}

// Whether every member of `diverging` (the CURRENT divergence this date
// write just found) is already covered by the invoice's last manual
// resolution (see clearBillingReview), AND the invoice's own money is
// exactly as the office left it at that clear. Only meaningful when no
// review is currently open — flagFirstApplicationInvoiceReviewOnDateChange
// checks that before calling this; a still-open review always accumulates
// through openBillingReview instead, same as before this fix.
//
// Fails closed in both directions that matter: a sibling this resolution
// never saw (a genuinely new, unresolved divergence) is never suppressed,
// and ANY change to the invoice's money since the clear — up, down, or
// sideways — is treated as "might be re-combined" and also never
// suppressed. The fingerprint alone can't distinguish "this invoice looks
// re-merged" from "this invoice was edited again for an unrelated reason",
// and failing closed (open a fresh review) is the safe side of that
// ambiguity — the office loses nothing but a redundant Clear click, while
// failing open would risk silently resuming a double-billing invoice.
function isDivergenceAlreadyResolved(invoice, diverging) {
  let context = invoice.billing_review_context;
  if (typeof context === 'string') {
    try { context = JSON.parse(context); } catch { context = null; }
  }
  if (!context || !context.resolvedAt) return false;
  const resolvedIds = new Set(
    (Array.isArray(context.resolvedSiblingIds) ? context.resolvedSiblingIds : []).map(String),
  );
  const everyDivergingSiblingWasResolved = diverging.every((d) => resolvedIds.has(String(d.id)));
  if (!everyDivergingSiblingWasResolved) return false;
  // Money-only (no status) — see invoiceMoneyOnlyFingerprint. Must match
  // exactly what the resolution recorded, or an invoice that simply
  // progressed through its ordinary delivery lifecycle since the clear
  // (draft -> scheduled -> sent -> paid, no money change at all) would
  // wrongly look "touched" and reopen a correctly-resolved review.
  return typeof context.resolvedInvoiceMoneyFingerprint === 'string'
    && context.resolvedInvoiceMoneyFingerprint === invoiceMoneyOnlyFingerprint(invoice);
}

// The trivial auto-clear (owner ruling): EVERY sibling this review recorded
// as diverging at open time (billing_review_context.divergingSiblingIds) is
// now back on the invoice-holding row's date, AND the invoice's own money
// (total, subtotal, discount_amount, status, line items) has not changed
// since the review opened. Anything else requires the office's own manual
// clear.
//
// Deliberately checks the RECORDED sibling ids against the invoice-holder's
// CURRENT date directly — never divergingSiblings's current
// (empty) output (Claude fallback-auditor P0, this branch's own second
// push): that filter also drops a sibling the office manually priced BY
// HAND without moving its date back, or one that simply completed on its
// still-diverged date. Either would make divergingSiblings return
// empty while the invoice-holder's invoice still carries the FULL combined
// total — auto-clearing on that alone would resume automatic collection on
// a still-double-billing invoice, exactly the gap this module exists to
// hold. Only "genuinely back on the same date" clears automatically;
// anything else (priced by hand, completed, still diverged) requires the
// office's own manual clear via POST /admin/invoices/:id/billing-review/clear.
async function maybeAutoClearBillingReview(trx, invoice, invoiceRow, members, moved) {
  if (!invoice.billing_review_opened_at) {
    return { action: 'skipped', reason: 'no_diverging_unpriced_sibling', invoiceId: invoice.id };
  }
  let context = invoice.billing_review_context;
  if (typeof context === 'string') {
    try { context = JSON.parse(context); } catch { context = null; }
  }
  const recordedSiblingIds = Array.isArray(context?.divergingSiblingIds) ? context.divergingSiblingIds : null;
  // No usable record of who diverged (an old/foreign row, or unreadable
  // context) — fail closed, same posture as every other unreadable-state
  // branch in this module: require the manual clear rather than guess.
  if (!recordedSiblingIds) {
    return { action: 'skipped', reason: 'review_open_requires_manual_clear', invoiceId: invoice.id };
  }
  const invoiceDate = dateOnly(invoiceRow.scheduled_date);
  const notResolved = recordedSiblingIds.some((id) => {
    const member = members.find((m) => String(m.id) === String(id));
    // A recorded sibling that no longer exists in this locked group (e.g.
    // moved to a different estimate) can't be proven realigned — fail closed.
    if (!member) return true;
    if (dateOnly(member.scheduled_date) !== invoiceDate) return true;
    // Priced by hand SINCE it was recorded (Claude fallback-auditor P1,
    // this branch's own third push): a sibling whose date was later moved
    // back onto the invoice-holder's date by some unrelated write, while
    // it also carries a manually-set estimated_price, is not the trivial
    // "genuinely never diverged" case — it now bills its own separate
    // price AND the invoice-holder's invoice was never reduced. The office
    // must clear this by hand, having actually reconciled both sides.
    if (member.estimated_price != null) return true;
    return false;
  });
  if (notResolved) {
    return { action: 'skipped', reason: 'review_open_requires_manual_clear', invoiceId: invoice.id };
  }
  const snapshot = context?.invoiceMoneyFingerprintAtOpen;
  const untouched = typeof snapshot === 'string' && snapshot === invoiceMoneyFingerprint(invoice);
  if (!untouched) {
    return { action: 'skipped', reason: 'review_open_requires_manual_clear', invoiceId: invoice.id };
  }
  const [cleared] = await trx('invoices')
    .where({ id: invoice.id })
    .whereNotNull('billing_review_opened_at')
    .update({ billing_review_opened_at: null, billing_review_reason: null, billing_review_context: null })
    .returning('id');
  if (cleared) {
    await resolveBillingReviewAlert(trx, invoice.id);
    logger.info(`[first-application-sibling-split] estimate ${moved.source_estimate_id}: invoice ${invoice.id}'s billing review auto-cleared — the diverging visit(s) landed back on the invoice's date and the invoice was never touched`);
  }
  return { action: cleared ? 'review_auto_cleared' : 'skipped', invoiceId: invoice.id };
}

/**
 * Called after ANY write that changes scheduled_date on a top-of-series (or
 * one-time) scheduled_services row, inside the SAME transaction as that
 * write. Idempotent and side-effect-free unless it actually finds a shared
 * first-application invoice for this row's estimate-accept group — safe to
 * call unconditionally whenever a date-changing writer wants the guarantee,
 * and cheap to skip (an early return) for rows that never touched an
 * estimate accept. Never mutates invoice money or scheduled_services rows
 * other than the review columns on `invoices` themselves.
 *
 * Because this runs in the SAME transaction as the date write, a crash,
 * deadlock, or interrupted batch that rolls back the move also rolls back
 * the review flag with it — there is no window where a review can persist
 * for a move that never actually committed.
 *
 * @param {import('knex').Knex.Transaction} trx - the caller's OPEN transaction
 * @param {string} scheduledServiceId - the row whose date just changed (post-write id)
 */
async function flagFirstApplicationInvoiceReviewOnDateChange(trx, scheduledServiceId) {
  if (!trx || !scheduledServiceId) return { action: 'skipped', reason: 'missing_args' };

  const group = await loadLockedEstimateGroup(trx, scheduledServiceId);
  if (group.skip) return group.skip;
  const { moved, members } = group;

  const located = await findLockedFirstApplicationInvoice(trx, moved, members);
  if (located.skip) return located.skip;
  const { invoice, invoiceRow } = located;

  const diverging = divergingSiblings(invoiceRow, members);
  if (diverging.length) {
    // No review currently open, and the office's last manual clear already
    // covered every sibling that's diverging right now with the invoice's
    // money unchanged since — this is the SAME resolved situation recurring
    // through an unrelated later reschedule, not a new mismatch. Skip
    // rather than re-open (see isDivergenceAlreadyResolved and the module
    // header's FOLLOW-UP FIX note). A still-open review always accumulates
    // through openBillingReview instead, unaffected by this check.
    if (!invoice.billing_review_opened_at && isDivergenceAlreadyResolved(invoice, diverging)) {
      return { action: 'skipped', reason: 'already_resolved_by_manual_clear', invoiceId: invoice.id };
    }
    return openBillingReview(trx, invoice, moved, diverging);
  }
  return maybeAutoClearBillingReview(trx, invoice, invoiceRow, members, moved);
}

/**
 * Same as flagFirstApplicationInvoiceReviewOnDateChange, but never blocks
 * the caller's own write: runs in its own SAVEPOINT (a nested transaction
 * off the caller's trx), so a failure inside it rolls back only its own
 * statements and leaves the caller's transaction perfectly usable for
 * whatever it does next. A plain try/catch around the direct call does NOT
 * achieve this on Postgres: the first failing statement aborts the WHOLE
 * transaction it ran in, and every later statement on that connection —
 * including the caller's own COMMIT — fails until something rolls it back.
 * Every date-changing writer enumerated in the PR (rebooker, admin-schedule
 * bulk + update-details, the Intelligence Bar's moveStopsToDay +
 * rescheduleAppointment, visit-groups' moveVisitAsUnit via rebooker) should
 * call this, not the plain function, directly.
 */
async function flagFirstApplicationInvoiceReviewOnDateChangeSafely(trx, scheduledServiceId, context = '') {
  try {
    return await trx.transaction((nested) => flagFirstApplicationInvoiceReviewOnDateChange(nested, scheduledServiceId));
  } catch (err) {
    logger.error(`[first-application-sibling-split] review flag failed for ${scheduledServiceId}${context ? ` (${context})` : ''} — caller's own write still commits: ${err.message}`);
    return { action: 'error', reason: err.message };
  }
}

module.exports = {
  flagFirstApplicationInvoiceReviewOnDateChange,
  flagFirstApplicationInvoiceReviewOnDateChangeSafely,
  clearBillingReview,
  dateOnly,
  // Exported for direct unit coverage of the lookup/classification pieces.
  loadLockedEstimateGroup,
  findLockedFirstApplicationInvoice,
  divergingSiblings,
  isDivergenceAlreadyResolved,
};
