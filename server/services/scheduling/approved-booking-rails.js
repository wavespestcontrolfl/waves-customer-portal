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
// The catalog row the card was built on (start_program's resolveProgramService reads these columns). The fingerprint is
// one string, so a rename, a re-key, a deactivation, a duration or cadence edit, or any updated_at bump refuses.
const CATALOG_COLS = ['id', 'name', 'short_name', 'service_key', 'base_price', 'price_range_min', 'category', 'billing_type', 'default_duration_minutes', 'frequency', 'visits_per_year', 'updated_at'];
function catalogFingerprint(row) {
  if (!row) return null;
  const cell = (v) => (v instanceof Date ? v.toISOString() : (v ?? null));
  return JSON.stringify([...CATALOG_COLS.map((c) => cell(row[c])), row.is_active !== false]);
}

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
    // The account must still be residential. The card refuses a commercial or business account through the canonical
    // isCommercialAccount predicate (the tier sentinel or the customer's property_type), which reads columns the billing
    // fingerprint does not carry: a property_type flipped to business after the card, under the customer lock, refuses.
    code: 'COMMERCIAL_CHANGED',
    message: 'This is now a commercial or business account. The program card is for residential customers. Nothing was booked.',
    applies: (ctx) => ctx.req.approvedNotCommercial === true,
    lock: (trx, ctx) => trx('customers').where({ id: ctx.customerId }).forUpdate().first('id'),
    read: async (trx, ctx) => require('../self-booking-plan-sync').isCommercialAccount(
      await trx('customers').where({ id: ctx.customerId }).first('waveguard_tier', 'property_type'),
    ),
    approved: () => false,
  },
  {
    // The catalog service the card named: same row, same name and key, still active, same duration and cadence, same
    // updated_at. The row is share-locked first so a catalog edit waits for this booking instead of slipping between
    // the read and the visit inserts.
    code: 'CATALOG_CHANGED',
    message: 'The service catalog entry changed since the card was shown. Nothing was booked.',
    applies: (ctx) => typeof ctx.req.approvedCatalog === 'string' && !!ctx.req.body?.serviceId,
    lock: (trx, ctx) => trx('services').where({ id: ctx.req.body.serviceId }).forShare().first('id'),
    read: async (trx, ctx) => catalogFingerprint(await trx('services').where({ id: ctx.req.body.serviceId }).first(...CATALOG_COLS, 'is_active')),
    approved: (ctx) => ctx.req.approvedCatalog,
  },
  {
    // The monthly bill lines the card was built on: the ledger pin (rate and every plan-rate line). The billing
    // fingerprint carries the scalar rate only; a ledger line moved under the customer lock must refuse too.
    code: 'LEDGER_CHANGED',
    message: 'The customer\'s monthly bill lines changed since the card was shown. Nothing was booked.',
    applies: (ctx) => typeof ctx.req.approvedLedgerPin === 'string',
    lock: (trx, ctx) => trx('customers').where({ id: ctx.customerId }).forUpdate().first('id'),
    read: async (trx, ctx) => {
      const row = await trx('customers').where({ id: ctx.customerId }).first('monthly_rate');
      const components = await require('../plan-rate-ledger').loadComponents(trx, ctx.customerId);
      return require('../intelligence-bar/rate-change').ledgerPin(components, row?.monthly_rate);
    },
    approved: (ctx) => ctx.req.approvedLedgerPin,
  },
  {
    // The consultations the booking marks won (the handler's markWonForCustomer hook): the card listed
    // them by id and outcome. The read is the hook's own selection (openConsultationCandidates), taken
    // under the customer row lock every consultation writer also takes, so a consultation recorded
    // while the booking waited is seen.
    code: 'CONSULTATIONS_CHANGED',
    message: 'The customer\'s open consultations changed since the card was shown. Nothing was booked.',
    applies: (ctx) => Array.isArray(ctx.req.approvedConsultations),
    lock: (trx, ctx) => trx('customers').where({ id: ctx.customerId }).forUpdate().first('id'),
    read: async (trx, ctx) => {
      const StartProgram = require('../intelligence-bar/start-program');
      const rows = await require('../consultation-outcomes').openConsultationCandidates(trx, ctx.customerId);
      return StartProgram.consultationPinKeys(StartProgram.consultationPinList(
        rows.map((r) => ({ id: r.outcome_id, outcome: r.outcome })),
      )).join(',');
    },
    approved: (ctx) => ctx.req.approvedConsultations.join(','),
  },
  {
    // Who the booking confirmation and the welcome reach, and whether those messages are on: the recipient
    // key the card pinned (booking-contact-state.js, read through the senders' own lookups). Re-read after the
    // customer row lock, so a phone, email or notification-setting change that committed while the booking
    // waited is seen.
    code: 'CONTACT_CHANGED',
    message: 'The customer\'s phone, email or notification settings changed since the card was shown. Nothing was booked.',
    applies: (ctx) => typeof ctx.req.approvedContact === 'string',
    lock: (trx, ctx) => trx('customers').where({ id: ctx.customerId }).forUpdate().first('id'),
    // Two keys, as the senders split them: the confirmation for the property the visits are stamped with
    // (property-level toggles and recipient overrides), and the account-level welcome.
    // Every read goes through the booking transaction: a second connection from the pool would wait on a pool the
    // booking already holds one connection of (a deadlock at a pool of two).
    read: async (trx, ctx) => {
      const Contact = require('../booking-contact-state');
      return {
        confirmation: await Contact.currentContactKey(ctx.customerId, { propertyId: ctx.req.approvedServiceAnchor?.propertyId || null, conn: trx }),
        welcome: typeof ctx.req.approvedWelcomeContact === 'string' ? await Contact.currentContactKey(ctx.customerId, { kind: 'welcome', conn: trx }) : null,
      };
    },
    approved: (ctx) => ({ confirmation: ctx.req.approvedContact, welcome: typeof ctx.req.approvedWelcomeContact === 'string' ? ctx.req.approvedWelcomeContact : null }),
    matches: (read, approved) => read.confirmation === approved.confirmation && read.welcome === approved.welcome,
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

module.exports = { catalogFingerprint, CATALOG_COLS, RAILS, runApprovedBookingRails, BILLING_FINGERPRINT_COLS, PLAN_SYNC_FINGERPRINT_COLS, CARD_BILLING_COLS };
