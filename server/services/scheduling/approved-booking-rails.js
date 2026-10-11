/**
 * Approved-card rails for the Schedule booking transaction.
 *
 * A caller that booked from a confirm card (the Intelligence Bar's
 * start_program, through createScheduleBooking) hands the handler the facts
 * the card showed (req.approved*). Every one of those facts is re-read here,
 * in ONE step, after the handler holds every customer and series lock and
 * before it inserts anything, and compared with what the card pinned. A
 * mismatch throws the rail's code (409 unless the rail says otherwise) and
 * the booking transaction rolls back.
 *
 * One table, one runner. A new approved fact is a new row here, not another
 * inline conditional at another point of the lock sequence.
 *
 * A rail is:
 *   code      the error code the handler returns
 *   message   the plain sentence for the 409 (or `fail(read, ctx)` for a
 *             rail that throws its own error)
 *   applies   (ctx) => boolean — the card pinned this fact
 *   lock      optional async (trx, ctx) — a lock the read needs. All locks run
 *             first, in table order, so the estimate lock (a leaf in the lock
 *             order) is the last lock taken before the reads.
 *   read      async (trx, ctx) => the live fact
 *   approved  (ctx) => the fact the card pinned
 *   matches   optional (read, approved) => boolean (default: strict equality)
 *
 * ctx is built by the handler: { req, customerId, trx-independent inputs and
 * small closures (probeOverlap, assertTech) so this module imports nothing
 * heavy }.
 */

const BILLING_FINGERPRINT_COLS = ['payer_id', 'billing_mode', 'per_application_fee', 'waveguard_tier', 'monthly_rate'];
// Every customers column the booking's WaveGuard plan sync reads (syncCustomerWaveGuardPlanFromScheduledServices:
// isMembershipCustomerRow, isAutoDerivedTierLabelRow, buildCustomerWaveGuardAlignmentUpdates, and the
// customer_not_found check) beyond the billing columns above. The card's alignment preview is built from these, so
// a change under the lock must refuse. Only this rail compares them: page bookings keep BILLING_FINGERPRINT_COLS.
const PLAN_SYNC_FINGERPRINT_COLS = ['waveguard_tier_source', 'active', 'pipeline_stage', 'member_since', 'deleted_at'];
const CARD_BILLING_COLS = [...BILLING_FINGERPRINT_COLS, ...PLAN_SYNC_FINGERPRINT_COLS];
const ADDRESS_COLS = ['address_line1', 'address_line2', 'city', 'state', 'zip'];

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  err.statusCode = status;
  err.isOperational = true;
  return err;
}

const billingString = (row) => CARD_BILLING_COLS.map((c) => String(row?.[c] ?? '')).join('|');

const RAILS = [
  {
    // The billing state the card was built on (dues-covered visits). Read after
    // the customer row is held FOR UPDATE, so a payer-only edit that committed
    // while the booking waited is seen.
    code: 'BILLING_CHANGED',
    message: 'The customer\'s billing changed since the card was shown. Nothing was booked.',
    applies: (ctx) => !!ctx.req.approvedBilling,
    lock: (trx, ctx) => trx('customers').where({ id: ctx.customerId }).forUpdate().first('id'),
    read: async (trx, ctx) => billingString(await trx('customers').where({ id: ctx.customerId }).first(...CARD_BILLING_COLS)),
    approved: (ctx) => billingString(ctx.req.approvedBilling),
  },
  {
    // The card's open-estimate check: the SAME any-open condition the card's own check uses
    // (openEstimateForCustomer; no service-family reading). Every estimate insert and reopening
    // for a customer takes this lock first (utils/customer-estimate-lock.js),
    // so this read waits for an in-flight creator and sees its row.
    code: 'ESTIMATE_OPENED',
    message: 'This customer now has an open estimate. Accept or close it first; the bar does not start a program beside an open estimate. Nothing was booked.',
    applies: (ctx) => ctx.req.approvedNoOpenEstimate === true,
    lock: (trx, ctx) => require('../../utils/customer-estimate-lock').lockCustomerEstimates(trx, ctx.customerId),
    read: async (trx, ctx) => Boolean(await require('../intelligence-bar/start-program')
      .openEstimateForCustomer(ctx.customerId, trx)),
    approved: () => false,
  },
  {
    // A card that promised no inspection credit. The credit lock itself is taken
    // earlier, in the comms -> credit -> customer-row order create_appointment
    // uses; only the projection is judged here.
    code: 'INSPECTION_CREDIT_CHANGED',
    message: 'This customer now has an open inspection credit the card did not show. Nothing was booked.',
    applies: (ctx) => ctx.req.creditFreeCard === true,
    read: async (trx, ctx) => {
      const projected = await require('../inspection-credit')
        .projectRedeemableOfferAmount(ctx.customerId, { dbh: trx, includePaused: true });
      return (Number(projected?.amount ?? projected) || 0) > 0;
    },
    approved: () => false,
  },
  {
    // The series dates the card showed.
    code: 'DATES_CHANGED',
    message: 'The visit dates changed since the card was shown. Nothing was booked.',
    applies: (ctx) => Array.isArray(ctx.req.approvedVisitDates),
    read: async (_trx, ctx) => ctx.seriesDates.join(','),
    approved: (ctx) => ctx.req.approvedVisitDates.join(','),
  },
  {
    // The service address the booking will stamp must be the one the card showed.
    // A lazily created primary (no property before) is the customer address, so
    // only a pinned property id is compared by id.
    code: 'ADDRESS_CHANGED',
    message: 'The service address changed since the card was shown. Nothing was booked.',
    applies: (ctx) => !!ctx.req.approvedServiceAnchor,
    read: async (trx, ctx) => {
      const anchorId = await ctx.resolveAnchorPropertyId(trx);
      const place = anchorId
        ? await trx('customer_properties').where({ id: anchorId }).first(ADDRESS_COLS)
        : await trx('customers').where({ id: ctx.customerId }).first(ADDRESS_COLS);
      return { propertyId: anchorId || null, address: require('../intelligence-bar/start-program').serviceAnchorAddress(place) };
    },
    approved: (ctx) => ({
      propertyId: ctx.req.approvedServiceAnchor.propertyId || null,
      address: ctx.req.approvedServiceAnchor.address,
    }),
    matches: (read, approved) => (!approved.propertyId || String(read.propertyId || '') === String(approved.propertyId))
      && read.address === approved.address,
  },
  {
    // Every overlap on every series date must be one the card listed.
    code: 'OVERLAP_CHANGED',
    message: 'Another visit now overlaps a visit in this series. Nothing was booked.',
    applies: (ctx) => Array.isArray(ctx.req.approvedOverlapFacts),
    read: async (trx, ctx) => {
      const facts = [];
      for (const date of ctx.seriesDates) {
        const clash = await ctx.probeOverlap(trx, date);
        if (clash.length) {
          facts.push(...(await require('../intelligence-bar/tools').bookingOverlapFacts(trx, clash, date)).map((f) => f.fact));
        }
      }
      return facts;
    },
    approved: (ctx) => new Set(ctx.req.approvedOverlapFacts),
    matches: (read, approved) => read.every((fact) => approved.has(fact)),
  },
  {
    // The technician must be assignable on every date the series writes (the
    // Schedule screen's own save-time check, for every caller). The read is the
    // first assertAssignableTechnician error, or null.
    code: 'TECH_NOT_ASSIGNABLE',
    applies: (ctx) => ctx.techDates.length > 0,
    read: async (trx, ctx) => {
      for (const date of ctx.techDates) {
        try {
          await ctx.assertTech(trx, date);
        } catch (err) {
          return err;
        }
      }
      return null;
    },
    approved: () => null,
    fail: (read) => read,
  },
];

function mismatch(rail, read, approved) {
  return rail.matches ? !rail.matches(read, approved) : read !== approved;
}

function railError(rail, read) {
  if (rail.fail) return rail.fail(read);
  return Object.assign(httpError(409, rail.message), { code: rail.code });
}

/**
 * Run every rail that applies. Call once, after every customer/series lock is
 * held and before the first insert.
 */
async function runApprovedBookingRails(trx, ctx, rails = RAILS) {
  const active = rails.filter((rail) => rail.applies(ctx));
  for (const rail of active) {
    if (rail.lock) await rail.lock(trx, ctx);
  }
  for (const rail of active) {
    const read = await rail.read(trx, ctx);
    if (mismatch(rail, read, rail.approved(ctx))) throw railError(rail, read);
  }
}

module.exports = { RAILS, runApprovedBookingRails, BILLING_FINGERPRINT_COLS, PLAN_SYNC_FINGERPRINT_COLS, CARD_BILLING_COLS };
