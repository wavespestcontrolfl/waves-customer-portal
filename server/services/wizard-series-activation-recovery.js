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

async function findStrandedParents(database, { olderThanMinutes, limit }) {
  return database('scheduled_services as ss')
    .join('estimates as e', 'e.id', 'ss.source_estimate_id')
    .whereNotNull('ss.self_booking_id')
    .where('ss.payment_method_preference', 'pay_at_visit')
    .where((qb) => qb.where('ss.is_recurring', false).orWhereNull('ss.is_recurring'))
    .whereNull('ss.recurring_parent_id')
    .whereIn('ss.status', ['pending', 'confirmed'])
    .where('e.source', 'quote_wizard')
    .where('e.status', 'draft')
    .whereNull('e.archived_at')
    .whereRaw("ss.created_at < NOW() - (?::text || ' minutes')::interval", [String(olderThanMinutes)])
    .whereNotExists(function child() {
      this.select(1)
        .from('scheduled_services as c')
        .whereRaw('c.recurring_parent_id = ss.id')
        .whereNot('c.status', 'cancelled');
    })
    .orderBy('ss.created_at', 'asc')
    .limit(limit)
    .select('ss.id', 'ss.customer_id', 'ss.source_estimate_id', 'ss.service_type', 'ss.scheduled_date');
}

async function sweepStrandedWizardActivations({ database = db, olderThanMinutes = DEFAULT_OLDER_THAN_MINUTES, limit = 10 } = {}) {
  const stranded = await findStrandedParents(database, { olderThanMinutes, limit });
  let stripped = 0;
  for (const parent of stranded) {
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
          .first('id', 'is_recurring', 'payment_method_preference', 'status', 'source_estimate_id');
        if (!fresh
          || fresh.is_recurring
          || fresh.payment_method_preference !== 'pay_at_visit'
          || !['pending', 'confirmed'].includes(String(fresh.status || ''))
          || String(fresh.source_estimate_id || '') !== String(parent.source_estimate_id)) return false;
        const freshChild = await trx('scheduled_services')
          .where({ recurring_parent_id: parent.id })
          .whereNot('status', 'cancelled')
          .first('id');
        if (freshChild) return false;
        const freshDraft = await trx('estimates')
          .where({ id: parent.source_estimate_id, source: 'quote_wizard', status: 'draft' })
          .whereNull('archived_at')
          .first('id');
        if (!freshDraft) return false;
        await trx('scheduled_services')
          .where({ id: parent.id })
          .update({
            estimated_price: null,
            payment_method_preference: null,
            create_invoice_on_complete: false,
            notes: trx.raw("COALESCE(notes, '') || ' — series activation never completed (worker died mid-booking); pricing stripped, office converts from the live quote'"),
            updated_at: trx.fn.now(),
          });
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
            body: `A self-booked recurring plan for customer ${parent.customer_id} (${parent.service_type || 'service'}, first visit ${String(parent.scheduled_date).slice(0, 10)}) committed its first visit but the series never activated (worker died mid-request). The visit's per-application pricing was removed and the quote draft is still live — convert the quote to schedule and bill the plan.`,
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
  return { examined: stranded.length, stripped };
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
// The 7-day window bounds the eligible set (a handful of self-booked
// wizard activations), so every run processes ALL of it, oldest first —
// a fixed newest-N slice with no completion marker would re-heal the
// same rows forever and starve older ones past the window (codex #3504
// r9 hook). The limit is a runaway safety cap only; hitting it logs
// loud so it never silently truncates.
async function healActivatedFollowThroughs({ database = db, olderThanMinutes = 10, youngerThanDays = 7, limit = 200 } = {}) {
  const parents = await database('scheduled_services as ss')
    .join('estimates as e', 'e.id', 'ss.source_estimate_id')
    .whereNotNull('ss.self_booking_id')
    .where('ss.is_recurring', true)
    .whereNull('ss.recurring_parent_id')
    .whereNotIn('ss.status', ['cancelled'])
    .where('e.source', 'quote_wizard')
    .whereRaw("ss.created_at < NOW() - (?::text || ' minutes')::interval", [String(olderThanMinutes)])
    .whereRaw("ss.created_at > NOW() - (?::text || ' days')::interval", [String(youngerThanDays)])
    .orderBy('ss.created_at', 'asc')
    .limit(limit)
    .select('ss.id', 'ss.customer_id', 'ss.source_estimate_id');
  if (parents.length >= limit) {
    logger.warn(`[wizard-series-recovery] follow-through heal hit its ${limit}-row safety cap — eligible set exceeds the cap, raise it or shrink the window`);
  }
  for (const parent of parents) {
    try {
      await runActivationFollowThroughForParent(parent, { database });
    } catch (err) {
      logger.warn(`[wizard-series-recovery] follow-through heal failed for parent=${parent.id} (retried next sweep): ${err.message}`);
    }
  }
  return { healed: parents.length };
}

module.exports = {
  sweepStrandedWizardActivations,
  findStrandedParents,
  runActivationFollowThroughForParent,
  healActivatedFollowThroughs,
};
