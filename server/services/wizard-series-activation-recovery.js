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
// racing toward its own activation, and young enough to be this deploy
// era's work (older strays predate the feature).
const DEFAULT_OLDER_THAN_MINUTES = 15;
const DEFAULT_YOUNGER_THAN_DAYS = 7;

async function findStrandedParents(database, { olderThanMinutes, youngerThanDays, limit }) {
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
    .whereRaw("ss.created_at > NOW() - (?::text || ' days')::interval", [String(youngerThanDays)])
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

async function sweepStrandedWizardActivations({ database = db, olderThanMinutes = DEFAULT_OLDER_THAN_MINUTES, youngerThanDays = DEFAULT_YOUNGER_THAN_DAYS, limit = 10 } = {}) {
  const stranded = await findStrandedParents(database, { olderThanMinutes, youngerThanDays, limit });
  let stripped = 0;
  for (const parent of stranded) {
    try {
      const didStrip = await database.transaction(async (trx) => {
        // Same serialization + re-check the activation failure-strip uses:
        // under the comms lock, an is_recurring parent IS a completed
        // activation (a slow in-flight request can finish between the
        // sweep read and this lock) — touch nothing.
        await lockCustomerComms(trx, parent.customer_id);
        const fresh = await trx('scheduled_services')
          .where({ id: parent.id })
          .first('id', 'is_recurring', 'payment_method_preference');
        if (!fresh || fresh.is_recurring || fresh.payment_method_preference !== 'pay_at_visit') return false;
        await trx('scheduled_services')
          .where({ id: parent.id })
          .update({
            estimated_price: null,
            payment_method_preference: null,
            create_invoice_on_complete: false,
            notes: trx.raw("COALESCE(notes, '') || ' — series activation never completed (worker died mid-booking); pricing stripped, office converts from the live quote'"),
            updated_at: trx.fn.now(),
          });
        return true;
      });
      if (!didStrip) continue;
      stripped += 1;
      logger.warn(`[wizard-series-recovery] stranded activation stripped for parent=${parent.id} customer=${parent.customer_id} (draft ${parent.source_estimate_id} still live — office converts)`);
      // Same bell convention as the seeder's shortfall notice: dedupe on a
      // stable key so a re-noticed row never stacks identical bells.
      const dedupeKey = `wizard-activation-stranded:${parent.id}`;
      try {
        const existing = await database('notifications')
          .where({ recipient_type: 'admin' })
          .whereRaw("metadata->>'dedupeKey' = ?", [dedupeKey])
          .first('id')
          .catch(() => null);
        if (!existing) {
          await require('./notification-service').notifyAdmin(
            'alert',
            'Self-booked plan never activated',
            `A self-booked recurring plan for customer ${parent.customer_id} (${parent.service_type || 'service'}, first visit ${String(parent.scheduled_date).slice(0, 10)}) committed its first visit but the series never activated (worker died mid-request). The visit's per-application pricing was removed and the quote draft is still live — convert the quote to schedule and bill the plan.`,
            {
              link: `/admin/customers/${parent.customer_id}`,
              bell: true,
              metadata: {
                dedupeKey,
                customer_id: parent.customer_id,
                scheduled_service_id: parent.id,
                source_estimate_id: parent.source_estimate_id,
              },
            },
          );
        }
      } catch (bellErr) {
        logger.warn(`[wizard-series-recovery] admin bell failed for parent=${parent.id} (non-blocking): ${bellErr.message}`);
      }
    } catch (err) {
      logger.error(`[wizard-series-recovery] strip failed for parent=${parent.id}: ${err.message}`);
    }
  }
  return { examined: stranded.length, stripped };
}

module.exports = { sweepStrandedWizardActivations, findStrandedParents };
