// Strip-only recovery for STRANDED self-book series activations (codex
// #3504 r6): the booking transaction commits the billable pay-at-visit
// parent, and series activation runs in its own post-commit transaction —
// a worker that dies between the two leaves a parent invoiceable at the
// plan's first-installment price while no follow-ups exist and the wizard
// draft stays live. The customer never auto-retries the POST, so the
// crash-retry replay repair may never run.
//
// The stranded state IS the durable claim — every column is written by the
// booking commit itself: a self-booked (self_booking_id) non-recurring
// parent with payment_method_preference='pay_at_visit', no series
// children, whose source_estimate_id still points at a LIVE quote_wizard
// draft (activation archives the draft atomically, so a live draft means
// activation never committed).
//
// Disposition is STRIP, not activate: re-running activation from a sweep
// would need the whole confirm-path closure (plan/price re-resolution,
// setup-fee waiver rechecks, occupancy lock plan) re-derived outside its
// request — the fail-safe the activation path itself uses on any drift is
// to strip the pricing and leave a price-less single visit the office
// converts from the still-live draft. Same contract here, plus an admin
// bell so the office knows to convert. Fail closed: nothing billable
// survives for a plan that never activated.
const db = require('../models/db');
const logger = require('./logger');
const { lockCustomerComms } = require('../utils/customer-comms-lock');

// Only look at bookings old enough that no in-flight request is still
// racing toward its own activation. Deliberately NO upper age bound
// (codex #3504 r9 P2): the recovery guarantee must survive an extended
// sweep outage — a stranded row that ages past a window would stay
// invoiceable forever. The predicate itself is the era marker: only rows
// with pay-at-visit pricing, a self-booking link, and a LIVE quote_wizard
// draft can match, and none of those exist before this feature family.
const DEFAULT_OLDER_THAN_MINUTES = 15;

async function findStrandedParents(database, { olderThanMinutes, limit, cursor = null }) {
  return database('scheduled_services as ss')
    .join('estimates as e', 'e.id', 'ss.source_estimate_id')
    .whereNotNull('ss.self_booking_id')
    .where('ss.payment_method_preference', 'pay_at_visit')
    // The activation-minted billing state, in full (codex #3504 r25): a
    // staff edit that clears the invoice flag takes the row out of the
    // claim rather than getting overwritten by the reconcile.
    .where('ss.create_invoice_on_complete', true)
    // Reconciled rows leave the claim by the durable marker (r26).
    .whereNull('ss.wizard_recovery_reconciled_at')
    .where((qb) => qb.where('ss.is_recurring', false).orWhereNull('ss.is_recurring'))
    .whereNull('ss.recurring_parent_id')
    // EVERY non-cancelled status (codex #3504 r13): a stranded parent can
    // progress — a customer reschedule marks it 'rescheduled' (and the
    // rebooker can later restore it to 'confirmed' with the pricing
    // intact), an outage can let it reach en_route/on_site/completed —
    // and each of those still carries the first-installment price and a
    // live draft. Disposition below is by status class; nothing drops out
    // of recovery silently.
    .whereNotIn('ss.status', ['cancelled', 'canceled'])
    // PEST is IN scope from an owner-set EPOCH (owner ruling 2026-08-27,
    // Option A; codex r2 P1): the pest funnel's deliberate duplicate-kept
    // one-off stamps wizard_recovery_reconciled_at at kept-time — but only
    // marker-capable code does, and Railway keeps the previous version
    // serving while migrations run and new instances roll, so a kept visit
    // booked by OLD code in that overlap is unmarked and would read as
    // stranded. GATE_PEST_STRANDED_RECOVERY carries an ISO timestamp the
    // owner sets AFTER the rollout completes; pest parents created before
    // it (or with the gate unset) stay excluded exactly as before. Other
    // families are unaffected by the gate.
    .where((qb) => {
      qb.whereRaw("COALESCE(ss.service_type, '') !~* '\\ypest\\y'");
      const epoch = pestRecoveryEpoch();
      if (epoch) qb.orWhere('ss.created_at', '>=', epoch);
    })
    // The stranded claim is PARENT-scoped (codex #3504 r21): the wizard
    // draft row is shared and reusable, so its archive state belongs to
    // whichever booking last consumed it — a customer who re-runs the
    // wizard and activates a second quote before this sweep archives the
    // same row and would otherwise hide the original stranded parent
    // forever. The row's own shape is the durable marker: self-booked,
    // pay-at-visit, priced, auto-invoicing, not recurring, no children,
    // wizard-sourced. Only a PLANNED activation ever stamps that shape
    // (perVisitAmountForEstimate prices nothing without a resolved plan),
    // so no legitimate single visit matches it. Draft liveness is read
    // under the lock below for the bell copy only.
    .where('e.source', 'quote_wizard')
    .whereRaw("ss.created_at < NOW() - (?::text || ' minutes')::interval", [String(olderThanMinutes)])
    .whereNotExists(function child() {
      this.select(1)
        .from('scheduled_services as c')
        .whereRaw('c.recurring_parent_id = ss.id')
        .whereNot('c.status', 'cancelled');
    })
    // Keyset cursor (codex r3 P1): rows the sweep loop must skip (pre-epoch
    // pest-family labels the SQL regex cannot classify — serviceKeyFor is
    // order-dependent) would otherwise pin the oldest-first page forever.
    .modify((qb) => {
      if (cursor) qb.whereRaw('(ss.created_at, ss.id) > (?, ?)', [cursor.created_at, cursor.id]);
    })
    .orderBy('ss.created_at', 'asc')
    .orderBy('ss.id', 'asc')
    .limit(limit)
    .select('ss.id', 'ss.customer_id', 'ss.source_estimate_id', 'ss.service_type', 'ss.scheduled_date', 'ss.status', 'ss.created_at');
}

// Terminal states, classified by what they mean for the MONEY (codex
// #3504 r13 + r14):
//  - completed + a live (non-void) invoice on the visit ⇒ BILLED at the
//    quoted first-application price. Stripping estimated_price would only
//    rewrite history; the reconcile clears the pay-at-visit machinery so
//    the row leaves the predicate, keeps the price for the record, and
//    bells the office to convert the live draft for the REMAINING program.
//  - completed with NO live invoice ⇒ work done, UNBILLED: the price stays
//    (the office bills the visit by hand) and the bell says so.
//  - skipped / no_show ⇒ NOT billed (r14): neither runs the completion-
//    invoice path — a no-show charges at most its flat fee off the card-
//    hold rail, never the application — so the customer received no
//    application and owes no application invoice. The row strips exactly
//    like an in-flight one and the office converts the FULL program.
//  - completed whose only invoice is REFUNDED ⇒ a distinct state (codex
//    #3504 r20, mirrors admin-dispatch's COMPLETION_TERMINAL_INVOICE_
//    STATUSES): the refund may still fail at the bank and restore the
//    original, so the office must NOT re-bill the application inside that
//    window — the price stays for the record, the handoff retires (work
//    was performed), and the bell parks the billing decision on a human.
// ISO timestamp (or null) from GATE_PEST_STRANDED_RECOVERY — see the
// findStrandedParents predicate. Read through the canonical feature-gate
// registry (config/feature-gates gateEnvTimestamp: call-time, fail-closed).
function pestRecoveryEpoch() {
  return require('../config/feature-gates').gateEnvTimestamp('GATE_PEST_STRANDED_RECOVERY');
}

const COMPLETED_STATES = new Set(['completed']);
const UNBILLED_TERMINAL_STATES = new Set(['skipped', 'no_show']);
// Collected nothing and nothing can restore them (a canceled PaymentIntent
// is terminal) — invisible to the classification.
const DEAD_INVOICE_STATUSES = ['void', 'voided', 'cancelled', 'canceled'];
const REFUNDED_INVOICE_STATUSES = ['refunded'];

async function classifyStrandedDisposition(trx, parentId, status) {
  if (UNBILLED_TERMINAL_STATES.has(status)) return 'terminal_unbilled';
  if (!COMPLETED_STATES.has(status)) return 'in_flight';
  const invoices = await trx('invoices')
    .where({ scheduled_service_id: parentId })
    .whereNotIn('status', DEAD_INVOICE_STATUSES)
    .select('id', 'status');
  const statusOf = (row) => String(row?.status || '').toLowerCase();
  if (invoices.some((row) => !REFUNDED_INVOICE_STATUSES.includes(statusOf(row)))) return 'completed_billed';
  if (invoices.some((row) => REFUNDED_INVOICE_STATUSES.includes(statusOf(row)))) return 'completed_refunded';
  return 'completed_unbilled';
}

// Every patch stamps wizard_recovery_reconciled_at (codex #3504 r26,
// migration 20260827000001): the durable marker is what takes the row out
// of the claim — never a billing-field mutation — so a reconcile that
// cannot prove the price is the minted amount can leave billing alone.
const STRIP_PATCH = (trx, noteTail) => ({
  estimated_price: null,
  payment_method_preference: null,
  create_invoice_on_complete: false,
  notes: trx.raw("COALESCE(notes, '') || ?", [noteTail]),
  wizard_recovery_reconciled_at: trx.fn.now(),
  updated_at: trx.fn.now(),
});
const KEEP_PRICE_PATCH = (trx, noteTail) => ({
  payment_method_preference: null,
  create_invoice_on_complete: false,
  notes: trx.raw("COALESCE(notes, '') || ?", [noteTail]),
  wizard_recovery_reconciled_at: trx.fn.now(),
  updated_at: trx.fn.now(),
});
// Billing UNTOUCHED — note + marker only (possible staff edit).
const BILLING_UNTOUCHED_PATCH = (trx, noteTail) => ({
  notes: trx.raw("COALESCE(notes, '') || ?", [noteTail]),
  wizard_recovery_reconciled_at: trx.fn.now(),
  updated_at: trx.fn.now(),
});

async function sweepStrandedWizardActivations({ database = db, olderThanMinutes = DEFAULT_OLDER_THAN_MINUTES, limit = 10 } = {}) {
  // Both marker columns ship in migration 20260827000001 (runs pre-deploy).
  // Without them the sweep cannot reconcile safely (no generation proof,
  // no durable reconciled marker) — touch nothing, loudly (fail closed).
  const hasGenerationColumn = await database.schema.hasColumn('scheduled_services', 'source_estimate_generation');
  const hasReconciledColumn = await database.schema.hasColumn('scheduled_services', 'wizard_recovery_reconciled_at');
  if (!hasGenerationColumn || !hasReconciledColumn) {
    logger.error('[wizard-series-recovery] scheduled_services is missing source_estimate_generation / wizard_recovery_reconciled_at (migration 20260827000001 not applied) — stranded sweep SKIPPED');
    return { examined: 0, stripped: 0, skipped: 'schema' };
  }
  // Page by keyset until `limit` PROCESSABLE rows were handled or the set
  // is exhausted (codex r3 P1): skipped rows advance the cursor instead of
  // being re-selected every tick. Deliberately NO page cap (pre-push P1):
  // the cursor is per-tick, so a cap would re-walk the same skipped pages
  // every tick and starve newer rows — the skipped set (pre-epoch pest-
  // family aliases the SQL regex cannot classify) is finite and each page
  // is a cheap indexed read, so the walk runs to exhaustion like the
  // follow-through healer's.
  let stripped = 0;
  let examined = 0;
  let processed = 0;
  let cursor = null;
  let exhausted = false;
  while (processed < limit && !exhausted) {
    const stranded = await findStrandedParents(database, { olderThanMinutes, limit, cursor });
    if (!stranded.length) break;
    if (stranded.length < limit) exhausted = true;
    for (const parent of stranded) {
    cursor = parent;
    if (processed >= limit) break;
    // Belt-and-braces for the SQL epoch predicate (labels the regex misses).
    const familyKey = require('./recurring-appointment-seeder').serviceKeyFor({ service_type: parent.service_type });
    if (familyKey === 'pest_control') {
      const epoch = pestRecoveryEpoch();
      if (!epoch || !parent.created_at || new Date(parent.created_at) < epoch) continue;
    }
    examined += 1;
    processed += 1;
    try {
      const didStrip = await database.transaction(async (trx) => {
        // Re-validate the ENTIRE stranded predicate under the comms lock
        // and a parent row lock (codex #3504 r6 hook): everything can have
        // moved since the sweep's unlocked read — a slow in-flight request
        // can finish activating (is_recurring), children can appear, the
        // visit can complete/cancel, and the draft can be archived or
        // promoted (in which case the bell's "live convertible quote"
        // promise would be false). Any drift → touch nothing; a still-
        // stranded row is re-noticed next sweep.
        await lockCustomerComms(trx, parent.customer_id);
        const fresh = await trx('scheduled_services')
          .where({ id: parent.id })
          .forUpdate()
          .first('id', 'is_recurring', 'payment_method_preference', 'create_invoice_on_complete', 'status', 'source_estimate_id', 'created_at', 'estimated_price', 'service_type', 'customer_id',
            'source_estimate_generation', 'wizard_recovery_reconciled_at');
        if (!fresh
          || fresh.is_recurring
          || fresh.payment_method_preference !== 'pay_at_visit'
          || fresh.create_invoice_on_complete !== true
          // Reconciled (or kept-on-purpose) between discovery and this
          // lock — e.g. the pest funnel's duplicate-kept stamp landing
          // after the unlocked read: never strip a marked row.
          || fresh.wizard_recovery_reconciled_at
          || ['cancelled', 'canceled'].includes(String(fresh.status || ''))
          || String(fresh.source_estimate_id || '') !== String(parent.source_estimate_id)) return false;
        // A completion whose post-commit side effects (the completion
        // invoice among them) are still pending/running must settle
        // first (codex #3504 r26): classifying now would read a
        // completed-but-not-yet-invoiced visit as unbilled and tell the
        // office to bill it by hand while the completion is about to
        // mint the invoice. Defer — the row is re-noticed next tick.
        const inFlightCompletion = await trx('service_completion_attempts')
          .where({ service_id: parent.id })
          .whereIn('status', ['pending', 'side_effects_pending', 'side_effects_running'])
          .first('id');
        if (inFlightCompletion) return false;
        const disposition = await classifyStrandedDisposition(trx, parent.id, String(fresh.status || ''));
        const freshChild = await trx('scheduled_services')
          .where({ recurring_parent_id: parent.id })
          .whereNot('status', 'cancelled')
          .first('id');
        if (freshChild) return false;
        // Draft liveness shapes the office copy only (r21): a consumed or
        // archived draft still leaves THIS parent stranded and billable.
        // FOR UPDATE (codex #3504 r28): the generation compare below and
        // the retire-handoff archive must see one stable row — unlocked,
        // a concurrent /calculate refresh could commit between them and
        // the archive's predicate (draft + unarchived, no generation
        // bound) would retire the customer's NEWLY issued quote. Same
        // parent→draft order as the activation path; /calculate takes
        // only this row lock, so the refresh serializes behind us (or we
        // read its committed newer generation and leave the link alone).
        const freshDraft = await trx('estimates')
          .where({ id: parent.source_estimate_id, source: 'quote_wizard', status: 'draft' })
          .whereNull('archived_at')
          .forUpdate()
          .first();
        const draftLive = !!freshDraft;
        // The draft PROVABLY still represents THIS parent only by the
        // parent-owned GENERATION marker (codex #3504 r22–r24 P0s;
        // migration 20260827000001): the shared row is revived and
        // rewritten by every later /calculate, so nothing on the draft —
        // archived_at, updated_at within a window, or content (a rerun
        // for the same family at the same price is still a NEW quote) —
        // can prove ownership. The booking stamped the draft's updated_at
        // it priced from onto the parent; every refresh rewrites the
        // draft's updated_at, so exact equality means the live draft is
        // that very generation (retiring its link prevents the
        // full-program rebook), and anything else is a newer quote whose
        // link must survive. Unstamped rows fail closed (never retire).
        const draftRepresentsParent = draftLive
          && String(freshDraft.customer_id || '') === String(fresh.customer_id || '')
          && !!fresh.source_estimate_generation
          && !!freshDraft.updated_at
          && new Date(freshDraft.updated_at).getTime() === new Date(fresh.source_estimate_generation).getTime();
        // Strip the PRICE only when it is provably the activation-minted
        // amount (codex #3504 r25): staff can reprice a stranded parent
        // before this sweep, and blanking that edit would leave a legit
        // visit unbilled. The minted amount is re-derivable only from the
        // draft generation the booking priced from; when the live draft IS
        // that generation, the anchored first-visit amount must match —
        // otherwise (repriced, or the generation is gone) the price is
        // KEPT for office review while the pay-at-visit machinery still
        // clears so the row leaves the claim.
        const mintedPriceConfirmed = (() => {
          if (!draftRepresentsParent) return false;
          try {
            const { wizardPlanServiceKey, resolveWizardSeriesPlan, resolveBookingVisitPrice } = require('./booking-pay-at-visit');
            const family = require('./recurring-appointment-seeder').serviceKeyFor({ service_type: fresh.service_type });
            // The pest funnel's plan is the fixed quarterly-4 (booking.js
            // shouldSeedQuarterlyPestFollowUps), not a wizard-resolved
            // cadence — price it the way the booking did.
            const planKey = family === 'pest_control' ? 'pest_control' : wizardPlanServiceKey(freshDraft, family);
            const planVisits = family === 'pest_control' ? 4 : resolveWizardSeriesPlan(freshDraft, planKey)?.visits;
            if (!(planVisits > 0)) return false;
            const priced = resolveBookingVisitPrice({ estimate: freshDraft, serviceKey: planKey, bookingVisits: planVisits });
            return !!priced && Number(priced.amount) === Number(fresh.estimated_price);
          } catch { return false; }
        })();
        // Unconfirmed price on a still-billable row = possible staff edit
        // (r26): leave the WHOLE billing state alone (price, pay-at-visit
        // preference, auto-invoice flag) — the durable marker takes the
        // row out of the claim; the office verifies the billing.
        const priceKeptNote = mintedPriceConfirmed
          ? ''
          : ' (BILLING LEFT UNTOUCHED — the per-application price could not be confirmed as the plan\'s minted amount, so it may be a staff edit; office verifies price and auto-invoice before the visit bills)';
        const draftNote = !draftLive
          ? ' NOTE: the original quote draft has since been consumed by a later booking or archived — reconcile this visit against the customer\'s CURRENT series/quote rather than that draft.'
          : (draftRepresentsParent
            ? ''
            : ' NOTE: the customer re-ran the quote AFTER this booking, so the live quote is a NEWER quote (its booking link was left intact) — bill this visit on its own and treat that quote as new business, not as the remainder of this program.');
        const who = `A self-booked recurring plan for customer ${parent.customer_id} (${parent.service_type || 'service'}, first visit ${String(parent.scheduled_date).slice(0, 10)})`;
        const byDisposition = {
          // Both completed dispositions RETIRE the public handoff (codex
          // #3504 r19): the completed parent is non-recurring, so the
          // duplicate guard cannot see it, and the still-live draft's
          // 14-day handoff token would let the customer pick another
          // slot and activate the FULL program on top of the performed
          // first application. Archiving the draft kills the wizard gate
          // and the handoff verdict; the office unarchives + converts for
          // the REMAINING program (a partial-program quote is theirs to
          // author — the original full-program shape must not self-book).
          completed_billed: {
            retireHandoff: true,
            patch: KEEP_PRICE_PATCH(trx, ' — series activation never completed (worker died mid-booking); this visit already billed at the quoted first-application price; self-booking link retired (draft archived) — office unarchives and converts for the remaining program'),
            bell: `${who} never activated (worker died mid-request) and that first visit has since been completed and invoiced at the quoted first-application price. ${draftRepresentsParent ? "The quote draft has been ARCHIVED so the customer's booking link cannot re-book the full program — unarchive it and convert to schedule and bill the REMAINING program." : 'Convert for the REMAINING program from the office.'}`,
          },
          completed_refunded: {
            retireHandoff: true,
            patch: KEEP_PRICE_PATCH(trx, ' — series activation never completed (worker died mid-booking); this visit was completed and its application invoice was REFUNDED — do not re-bill until the refund is final; self-booking link retired (draft archived) — office unarchives and converts for the remaining program'),
            bell: `${who} never activated (worker died mid-request). That first visit has since been completed and its application invoice was REFUNDED — do NOT bill the application again until the refund is final (a failed refund restores the original invoice). ${draftRepresentsParent ? "The quote draft has been ARCHIVED so the customer's booking link cannot re-book the full program — when the refund settles, unarchive it and convert to schedule and bill the REMAINING program." : 'When the refund settles, convert for the REMAINING program from the office.'}`,
          },
          completed_unbilled: {
            retireHandoff: true,
            patch: KEEP_PRICE_PATCH(trx, ' — series activation never completed (worker died mid-booking); this visit was completed but carries NO invoice — office bills it at the quoted first-application price; self-booking link retired (draft archived) — office unarchives and converts for the remaining program'),
            bell: `${who} never activated (worker died mid-request). That first visit has since been completed but has NO invoice — bill it at the quoted first-application price (kept on the visit). ${draftRepresentsParent ? "The quote draft has been ARCHIVED so the customer's booking link cannot re-book the full program — unarchive it and convert to schedule and bill the REMAINING program." : 'Convert for the REMAINING program from the office.'}`,
          },
          terminal_unbilled: {
            patch: (mintedPriceConfirmed ? STRIP_PATCH : BILLING_UNTOUCHED_PATCH)(trx, ` — series activation never completed (worker died mid-booking); first visit ended ${fresh.status} with no application, ${mintedPriceConfirmed ? 'pricing stripped' : 'billing left as-is'}${priceKeptNote}; office converts the live quote for the FULL program`),
            bell: mintedPriceConfirmed
              ? `${who} never activated (worker died mid-request) and that first visit ended ${fresh.status} — no application was performed and none was invoiced. The visit's per-application pricing was removed and the quote draft is still live — convert the quote to schedule and bill the FULL plan.`
              : `${who} never activated (worker died mid-request) and that first visit ended ${fresh.status} — no application was performed. Its BILLING WAS LEFT UNTOUCHED (price, pay-at-visit, auto-invoice kept as they are — possibly a staff edit). Verify that visit's billing first; then convert the quote to schedule and bill the FULL plan.`,
          },
          in_flight: {
            patch: (mintedPriceConfirmed ? STRIP_PATCH : BILLING_UNTOUCHED_PATCH)(trx, ` — series activation never completed (worker died mid-booking); ${mintedPriceConfirmed ? 'pricing stripped' : 'billing left as-is'}${priceKeptNote}, office converts from the live quote`),
            bell: mintedPriceConfirmed
              ? `${who} committed its first visit but the series never activated (worker died mid-request). The visit's per-application pricing was removed and the quote draft is still live — convert the quote to schedule and bill the plan.`
              : `${who} committed its first visit but the series never activated (worker died mid-request). That visit's BILLING WAS LEFT UNTOUCHED (price, pay-at-visit, auto-invoice kept as they are — possibly a staff edit), so it will still invoice on its own when completed. Verify that visit's billing FIRST, then convert the quote for the REMAINING program only — converting the full plan on top of it would bill the first application twice.`,
          },
        }[disposition];
        await trx('scheduled_services')
          .where({ id: parent.id })
          .update(byDisposition.patch);
        if (byDisposition.retireHandoff && draftRepresentsParent) {
          await trx('estimates')
            .where({ id: parent.source_estimate_id, source: 'quote_wizard', status: 'draft' })
            .whereNull('archived_at')
            .update({ archived_at: trx.fn.now(), updated_at: trx.fn.now() });
        }
        // Bell ATOMIC with the strip (codex #3504 r6 hook): the strip
        // removes the row from every future sweep, so a bell sent
        // best-effort afterwards could silently vanish and the office
        // would never learn to convert the live quote. Insert the
        // notification row in THIS transaction — a failed insert throws,
        // the strip rolls back, and the still-stranded row retries next
        // sweep. Dedupe mirrors notifyAdmin's mechanism (advisory lock +
        // metadata dedupeKey) so a retried strip never stacks bells.
        const dedupeKey = `wizard-activation-stranded:${parent.id}`;
        await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`admin:${dedupeKey}`]);
        const existingBell = await trx('notifications')
          .where({ recipient_type: 'admin' })
          .whereRaw("metadata->>'dedupeKey' = ?", [dedupeKey])
          .first('id');
        if (!existingBell) {
          const created = await require('./notification-service').create({
            recipientType: 'admin',
            category: 'alert',
            title: 'Self-booked plan never activated',
            body: byDisposition.bell + draftNote,
            link: `/admin/customers/${parent.customer_id}`,
            bell: true,
            metadata: {
              dedupeKey,
              customer_id: parent.customer_id,
              scheduled_service_id: parent.id,
              source_estimate_id: parent.source_estimate_id,
            },
            connection: trx,
          });
          // create() returns null on insert failure — throw so the strip
          // rolls back with it and the row stays sweepable.
          if (!created) throw new Error('recovery bell insert failed — strip rolled back for retry');
        }
        return true;
      });
      if (!didStrip) continue;
      stripped += 1;
      logger.warn(`[wizard-series-recovery] stranded activation stripped for parent=${parent.id} customer=${parent.customer_id} (draft ${parent.source_estimate_id} still live — office converts)`);
    } catch (err) {
      logger.error(`[wizard-series-recovery] strip failed for parent=${parent.id}: ${err.message}`);
    }
    }
  }
  return { examined, stripped };
}

// Post-activation follow-through — tier sync, the tagger/welcome re-run,
// and lead conversion — shared by the confirm route (in-request) and the
// heal sweep below. Every step is idempotent and individually
// best-effort. Property linkage deliberately does NOT run here (codex
// #3504 r10): the wizard draft row is REUSED by later quotes for OTHER
// addresses, so re-reading it after the fact could stamp this series with
// a different property — the linkage runs INSIDE the activation
// transaction, against the row-locked draft, in booking.js.
async function runActivationFollowThroughForParent(parent, { database = db } = {}) {
  if (!parent?.id || !parent?.customer_id) return;
  try {
    const { syncCustomerWaveGuardPlanFromScheduledServices } = require('./self-booking-plan-sync');
    await database.transaction(async (trx) => {
      await syncCustomerWaveGuardPlanFromScheduledServices({ database: trx, customerId: parent.customer_id });
    });
  } catch (err) {
    logger.warn(`[wizard-series-recovery] tier sync failed for parent=${parent.id} (non-blocking): ${err.message}`);
  }
  try {
    await require('./appointment-tagger').onServiceScheduled(parent.id);
  } catch (err) {
    logger.warn(`[wizard-series-recovery] tagger re-run failed for parent=${parent.id} (non-blocking): ${err.message}`);
  }
  // Activation-specific welcome (codex #3504 r11): the tagger's welcome
  // gate requires a PAID tier and rejects auto-derived tier labels, but
  // the accept path's welcome is gated on new-recurring-signup candidacy
  // alone ("all tiers are included"). A self-booked per-visit plan gets
  // no paid tier, so the tagger re-run above can never welcome it — send
  // through the SAME shared candidacy gate and the SAME idempotent
  // enqueue (hasWelcomeSequence) every accept path uses.
  try {
    const { sendNewRecurringWelcome, isNewRecurringSignupCandidate } = require('./new-recurring-welcome-sms');
    const parentRow = await database('scheduled_services')
      .where({ id: parent.id })
      .first('id', 'customer_id', 'recurring_pattern', 'is_recurring', 'status');
    if (parentRow?.is_recurring
      && String(parentRow.status || '') !== 'cancelled'
      && await isNewRecurringSignupCandidate(parent.customer_id, { excludeServiceId: parent.id })) {
      const customer = await database('customers')
        .where({ id: parent.customer_id })
        .first('id', 'first_name', 'last_name', 'phone');
      if (customer) {
        await sendNewRecurringWelcome({
          customer,
          scheduledServiceId: parent.id,
          recurringPattern: parentRow.recurring_pattern || null,
          entryPoint: 'wizard_series_activation_welcome',
        });
      }
    }
  } catch (err) {
    logger.warn(`[wizard-series-recovery] activation welcome failed for parent=${parent.id} (non-blocking): ${err.message}`);
  }
  // Lead conversion rides the durable follow-through too (codex #3504
  // r10): a worker death after the activation commit but before the
  // route's conversion block would otherwise leave the quote-wizard lead
  // pre-sale forever — the archived draft and recurring parent match no
  // other repair path. Idempotent: enforceOriginating scopes it to the
  // customer's own originating lead and an already-won lead no-ops.
  try {
    const { convertLeadFromEvent } = require('./lead-estimate-link');
    await convertLeadFromEvent({
      source: 'recurring_service_booked',
      customerId: parent.customer_id,
      enforceOriginating: true,
    });
  } catch (err) {
    logger.warn(`[wizard-series-recovery] lead conversion failed for parent=${parent.id} (non-blocking): ${err.message}`);
  }
}

// Durable follow-through recovery (codex #3504 r9): a worker can die AFTER
// the activation commits but before the in-request follow-through runs —
// the draft is archived and the parent recurring, so neither the stranded
// sweep nor a customer-driven replay reliably repairs it, and a
// secondary-property series could dispatch to the primary address forever.
// Every recently-activated self-booked wizard parent gets the idempotent
// follow-through re-run; re-running a healthy one is a no-op by design.
// The 7-day window here is generous coverage for a seconds-wide crash
// window (unlike the stranded strip above, nothing billable rides on it).
// Every run walks the WHOLE windowed set oldest-first — a fixed newest-N
// slice with no completion marker would re-heal the same rows forever and
// starve older ones past the window (codex #3504 r9 hook). There is no
// completion marker by design (every step is idempotent), so the walk is
// a KEYSET cursor over (created_at, id) in pages (codex #3504 r14): a
// single capped page re-selected the same oldest rows every tick once
// the eligible set outgrew it, and everything past the page aged out
// unhealed. There is deliberately NO row cap (pre-push audit on r17): the
// cursor is per-invocation, so a cap would re-walk the same oldest rows
// every tick and starve the tail exactly like the single page did — the
// 7-day window is the only bound, and the set is walked to exhaustion.
async function healActivatedFollowThroughs({ database = db, olderThanMinutes = 10, youngerThanDays = 7, pageSize = 200 } = {}) {
  let healed = 0;
  let cursor = null;
  for (;;) {
    const parents = await database('scheduled_services as ss')
      .join('estimates as e', 'e.id', 'ss.source_estimate_id')
      .whereNotNull('ss.self_booking_id')
      .where('ss.is_recurring', true)
      .whereNull('ss.recurring_parent_id')
      .whereNotIn('ss.status', ['cancelled'])
      .where('e.source', 'quote_wizard')
      // Activation-OWNED evidence, not is_recurring alone (codex #3504
      // r19), and PARENT-scoped (r23): the shared draft's archived_at is
      // cleared by any later wizard rerun, so it cannot mark this parent.
      // The activation seeds this parent's children in the same
      // transaction as markParentRecurring (every seedable plan has ≥2
      // visits), and child rows persist under recurring_parent_id even
      // when cancelled — a recurring self-booked parent WITH a child is a
      // series that exists; one without is the staff-flipped, never-
      // activated shape (r18) and gets no follow-through.
      .whereExists(function activationChild() {
        this.select(1).from('scheduled_services as c').whereRaw('c.recurring_parent_id = ss.id');
      })
      .whereRaw("ss.created_at < NOW() - (?::text || ' minutes')::interval", [String(olderThanMinutes)])
      .whereRaw("ss.created_at > NOW() - (?::text || ' days')::interval", [String(youngerThanDays)])
      .modify((qb) => {
        if (cursor) qb.whereRaw('(ss.created_at, ss.id) > (?, ?)', [cursor.created_at, cursor.id]);
      })
      .orderBy('ss.created_at', 'asc')
      .orderBy('ss.id', 'asc')
      .limit(pageSize)
      .select('ss.id', 'ss.customer_id', 'ss.source_estimate_id', 'ss.created_at');
    if (!parents.length) break;
    for (const parent of parents) {
      try {
        await runActivationFollowThroughForParent(parent, { database });
      } catch (err) {
        logger.warn(`[wizard-series-recovery] follow-through heal failed for parent=${parent.id} (retried next sweep): ${err.message}`);
      }
    }
    healed += parents.length;
    cursor = parents[parents.length - 1];
    if (parents.length < pageSize) break;
  }
  return { healed };
}

module.exports = {
  sweepStrandedWizardActivations,
  findStrandedParents,
  runActivationFollowThroughForParent,
  healActivatedFollowThroughs,
  classifyStrandedDisposition,
  pestRecoveryEpoch,
};
