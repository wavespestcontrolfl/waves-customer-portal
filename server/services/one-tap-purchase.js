'use strict';

// =========================================================================
// One-Tap Purchase (portal roadmap bet 3, owner rulings 2026-08-13, final)
//
// The portal-home PRICED offer card (offer-matrix target from
// buildPortalOffer — never a fixed service) gains a purchase flow:
// TERMS → TIME PICKER (ride-along/nearby slots first) → CONFIRM. Everything
// is pay-per-application; nothing is charged at confirm (card capture is a
// SetupIntent through the existing billing endpoints, save-only). The
// confirmation is EMAIL + APP NOTIFICATION — NO SMS anywhere in this flow
// (skipWelcomeSms on the converter; no SMS sender is ever called here).
//
// Money doctrine (each rule has burned a past lane):
//   - Never trust client amounts: the clicked perApplication is only ever
//     COMPARED against the server-recomputed offer (drift ⇒ 409); the price
//     that persists is recomputed server-side from the same machinery that
//     rendered the card (buildPortalPurchaseBasis shares buildPortalOffer's
//     core, so the two can never disagree).
//   - PARITY ASSERT (P0): the synthesized estimate's annual/visits must
//     equal the offer's per-application within $0.005 or nothing persists.
//   - Fail closed everywhere: drift, unpriceable, missing card, snapshot
//     load failure, expired reservation, owned-in-the-meantime, gate off.
//   - The confirm transaction copies the estimate-accept lock ordering
//     EXACTLY (rung-1 date occupancy lock pre-acquired, then the comms
//     lock, then row locks — estimate-public.js documents the real
//     deadlock the ordering prevents).
// =========================================================================

const crypto = require('crypto');
const db = require('../models/db');
const logger = require('./logger');
const slotReservation = require('./slot-reservation');
const { getAvailableSlots } = require('./estimate-slot-availability');
const { buildPortalPurchaseBasis, cacheOnlyPropertyLookup } = require('./service-report/cross-sell');
const { acquireOccupancyLock } = require('./scheduling/occupancy');
const { lockCustomerComms } = require('../utils/customer-comms-lock');
const { customerPreservesMonthlyMembership } = require('./billing-cadence');
const { arrivalWindowRange } = require('../utils/sms-time-format');

// Single source of the terms the customer agrees to. The exact snapshot is
// stored on the purchase row at init and rendered verbatim by the client —
// the version string bumps whenever this copy changes.
const TERMS_VERSION = 'v1';
const TERMS_TEXT = [
  'You are adding a recurring service to your Waves Pest Control plan, billed per application at the price shown.',
  'Nothing is charged today. After each completed visit, the per-application amount is billed to your account like your existing services.',
  'A payment method on file is required to confirm. Saving a card does not charge it.',
  'Visits recur on the cadence shown. You can reschedule any visit, or cancel this service, by contacting Waves Pest Control at any time.',
  'The price shown reflects your current WaveGuard member pricing for this property.',
].join('\n');

// Mirrors slot-reservation.js DEFAULT_HOLD_MINUTES — the client renders the
// hold countdown copy from this; the authoritative expiry rides the reserve
// response's expiresAt.
const HOLD_MINUTES = 15;

const OFFER_CHANGED = 'This offer is no longer available — please refresh the page';

// Ownership vocabulary (waveguard-existing-services) spells the termite
// family 'termite_bait'; the offer vocabulary spells it 'termite' — same
// mapping cross-sell.js applies.
const OWNED_KEY_TO_OFFER_KEY = { termite_bait: 'termite' };

function httpError(status, message, extra = {}) {
  const err = new Error(message);
  err.status = status;
  Object.assign(err, extra);
  return err;
}

function dateOnly(value) {
  if (!value) return '';
  if (value instanceof Date) return value.toISOString().split('T')[0];
  return String(value).split('T')[0];
}

function hhmm(value) {
  return value ? String(value).slice(0, 5) : '';
}

// Customer-facing arrival end = window_start + the standard 2-hour arrival
// window (AGENTS.md: never expose the scheduling window_end — it is the
// duration/overlap block, not the promise made to the customer). Shared
// helper so the picker, the confirm summary, and the notification copy can
// never disagree.
function arrivalEndFor(windowStart) {
  const range = arrivalWindowRange(hhmm(windowStart));
  return range ? range.split('-')[1] : '';
}

// Same STRICT drift rules as routes/property-recommendations.js's request
// path: fingerprint, service key, option id, and the priced amount must all
// match what the server would render RIGHT NOW; Number() coercion traps
// ('', null, false ⇒ 0) are closed by the typeof check. mode==='priced' is
// guaranteed by buildPortalPurchaseBasis, asserted again for belt-and-braces.
function assertNoDrift(offer, clicked = {}) {
  const clickedPrint = String(clicked.fingerprint || '').trim();
  const clickedKey = String(clicked.serviceKey || '').trim();
  const clickedOption = String(clicked.optionId || '').trim();
  const rawPer = clicked.perApplication;
  const clickedPer = typeof rawPer === 'number' && Number.isFinite(rawPer) ? rawPer : null;
  const serverPer = Number(offer?.option?.perVisit);
  const mismatch = !offer
    || offer.mode !== 'priced'
    || !clickedPrint || clickedPrint !== offer.fingerprint
    || !clickedKey || clickedKey !== offer.serviceKey
    || !(clickedPer !== null && clickedPer > 0
      && Number.isFinite(serverPer) && Math.abs(clickedPer - serverPer) < 0.005)
    || !clickedOption || clickedOption !== String(offer.option?.id || '');
  if (mismatch) throw httpError(409, OFFER_CHANGED);
}

// Customer-facing slot serialization: nearbyJob.detourMinutes is a routing
// internal and is deliberately dropped (never rendered — SlotPicker rule).
function serializeSlot(slot) {
  return {
    slotId: slot.slotId,
    date: slot.date,
    windowStart: slot.windowStart,
    // The customer-facing ARRIVAL window (start + 2h), never the scheduling
    // window_end — that is the duration/overlap block (P1, AGENTS.md rule).
    windowEnd: arrivalEndFor(slot.windowStart) || slot.windowEnd,
    techFirstName: slot.techFirstName || null,
    routeOptimal: !!slot.routeOptimal,
  };
}

async function loadSlots(estimateId) {
  const result = await getAvailableSlots(estimateId, {});
  return {
    primary: (result.primary || []).map(serializeSlot),
    expander: (result.expander || []).map(serializeSlot),
    nearby: !!result.nearby,
  };
}

async function loadPurchaseForCustomer(customerId, purchaseId) {
  const row = await db('one_tap_purchases').where({ id: purchaseId }).first();
  // 404 on ownership mismatch, never 403 — a foreign purchase id must be
  // indistinguishable from a nonexistent one.
  if (!row || String(row.customer_id) !== String(customerId)) {
    throw httpError(404, 'Not found');
  }
  return row;
}

function estimateExpired(estimate) {
  return !!(estimate?.expires_at && new Date(estimate.expires_at) < new Date());
}

// ── initPurchase ─────────────────────────────────────────────────────────
// Recompute the offer server-side, reject on any drift from what the card
// rendered, synthesize the NEW-SERVICE-ONLY draft estimate, ledger the
// purchase, and return terms + slots.
async function initPurchase({ customerId, clicked }) {
  const basis = await buildPortalPurchaseBasis(customerId, db);
  if (!basis) throw httpError(409, OFFER_CHANGED);
  const offer = basis.payload;
  assertNoDrift(offer, clicked);

  // P0 fence: a monthly-membership customer's converter path PRESERVES the
  // membership and folds the add-on into customers.monthly_rate — billed as
  // a monthly spread, not per application. That contradicts the accepted
  // terms ("billed per application"), so one-tap refuses these accounts
  // entirely (the GET flag hides the button; this is the write-side fence).
  if (customerPreservesMonthlyMembership(basis.customer)) {
    throw httpError(409, 'One-tap purchase is not available on this account — send us a request instead.');
  }
  // Payer fence at the WRITE side too (GH r6 P0): the GET flag hides the
  // button for payer-billed accounts, but init must refuse regardless —
  // otherwise the flow's card-collection step could enroll the homeowner's
  // card on an account whose invoices route to a third-party payer.
  let initPayerBilled = true;
  try {
    initPayerBilled = await customerIsPayerBilled(db, customerId);
  } catch (err) {
    logger.warn(`[one-tap-purchase] payer check failed at init, refusing (fail closed): ${err.message}`);
    initPayerBilled = true;
  }
  if (initPayerBilled) {
    throw httpError(409, 'One-tap purchase is not available on this account — send us a request instead.');
  }

  const pricingAi = require('./customer-pricing-ai');
  const pricingEngine = require('./pricing-engine');

  // The engine-facing variant (tier/frequency/program knobs) behind the
  // quoted option id — same variant ladder the pricer offered from.
  const variant = pricingAi.variantsForService(offer.serviceKey, '', false)
    .find((v) => v.id === offer.option.id);
  if (!variant) throw httpError(409, OFFER_CHANGED);

  // Same property context the offer priced with: same customer row, same
  // turf profile, same CACHE-ONLY lookup discipline, same estimate seed.
  // Any residual divergence is caught by the parity assert below.
  const turfProfile = await pricingAi.loadTurfProfile(db, customerId);
  const propertyContext = await pricingAi.resolvePropertyContext({
    customer: basis.customer,
    turfProfile,
    propertyLookup: cacheOnlyPropertyLookup,
    propertySeed: basis.propertySeed || null,
  });

  if (pricingEngine.needsSync && pricingEngine.needsSync()) {
    await pricingEngine.syncConstantsFromDB(db);
  }

  // NEW-SERVICE-ONLY estimate: services = ONLY the purchased option, with
  // the owned qualifying families as priorQualifyingServices so the engine
  // prices at the COMBINED WaveGuard tier (without them it unions nothing
  // and prices standalone Bronze — estimate-engine tierServiceKeys).
  // Reverse the offer-vocabulary mapping before handing keys to the engine:
  // currentServiceKeys spells termite ownership 'termite' (display vocab),
  // but determineWaveGuardTier's qualifying list only counts the canonical
  // 'termite_bait' — passing the display key would silently drop a tier
  // step (and its discount) for termite owners.
  const ownedFamilyKeys = [...new Set(
    (basis.result?.currentServiceKeys || []).map((k) => (k === 'termite' ? 'termite_bait' : k))
  )];
  const context = { grassType: propertyContext.grassType, palmCount: propertyContext.palmCount };
  const engineInputs = {
    ...propertyContext.propertyInput,
    recurringCustomer: true,
    priorQualifyingServices: ownedFamilyKeys,
    services: pricingAi.optionServices(variant, context),
  };
  const engineResult = pricingEngine.generateEstimate(engineInputs);
  const line = pricingAi.findLineItem(engineResult, offer.serviceKey);
  const amount = pricingAi.quoteAmountFromLine(line);
  const visits = [line?.visitsPerYear, line?.visits, line?.frequency]
    .map(Number).find((n) => Number.isFinite(n) && n > 0) || null;
  const annualAfter = Number(amount.annual);
  if (!(annualAfter > 0) || !visits) throw httpError(409, OFFER_CHANGED);
  // Belt to optionIsPriceable's dueAtStart/oneTime demotion (the offer card
  // never renders priced with a due-at-start component — e.g. termite
  // station installation): if THIS engine run produced one anyway, the
  // per-application-only draft below would silently drop a charge the
  // customer owes. Refuse — never sell an undisclosed one-time component.
  if (Number(amount.dueAtStart) > 0 || Number(amount.oneTime) > 0) {
    throw httpError(409, OFFER_CHANGED);
  }
  const perVisit = Math.round((annualAfter / visits) * 100) / 100;

  // PARITY ASSERT (P0): the synthesized price must equal the offer the
  // customer saw. A mismatch means the two computations diverged — no
  // purchase persists, and the divergence is logged for investigation
  // (amounts only; no customer identifiers beyond the id).
  if (!(Math.abs(perVisit - Number(offer.option.perVisit)) <= 0.005)) {
    logger.error(`[one-tap-purchase] per-application parity failed for customer ${customerId}: synthesized $${perVisit} vs offer $${offer.option.perVisit} (${offer.serviceKey}/${offer.option.id})`);
    throw httpError(409, OFFER_CHANGED);
  }

  // Membership snapshot — the frozen account context acceptance/conversion
  // replays (waived setup, combined tier). Mirrors the IB draft lane: the
  // offer only renders on recurring ownership, so this customer is a proven
  // member — a missing snapshot must refuse, never fall through to
  // new-customer terms. Deliberately NO frozen existingServices extension
  // plan (freezeExtensionPlan stays false): freezing one would reprice the
  // customer's EXISTING visits on accept.
  const { computeMembershipContext } = require('./estimate-membership-context');
  let membershipSnapshot = null;
  try {
    membershipSnapshot = await computeMembershipContext(db, {
      customerId,
      estData: {
        lineItems: engineResult.lineItems || [],
        recurring: {
          annualBeforeDiscount: Number(engineResult.summary?.recurringAnnualBeforeDiscount || 0),
          annualAfterDiscount: Number(engineResult.summary?.recurringAnnualAfterDiscount || 0),
        },
      },
    });
  } catch {
    membershipSnapshot = null;
  }
  if (!membershipSnapshot) {
    throw httpError(503, 'Your account context could not be loaded just now — please try again shortly.');
  }
  // P1 fence: a customer whose owned services do not qualify them as an
  // existing member (snapshot isExistingCustomer false — e.g. rodent
  // monitoring only) owes the $99 WaveGuard setup fee on a new recurring
  // start. This flow suppresses the setup invoice (skipSetupInvoice) and
  // the per-application rail never bills setup, so selling to them here
  // would silently waive a required fee. Members only.
  if (!membershipSnapshot.isExistingCustomer) {
    throw httpError(409, 'One-tap purchase is not available on this account — send us a request instead.');
  }

  // monthly_total derives from the discounted annual so the converter's
  // billing-cadence correspondence guard (|annual − monthly×12| ≤ $0.50)
  // holds by construction and per-application stays cent-exact.
  const monthlyTotal = Math.round((annualAfter / 12) * 100) / 100;

  // The ONE recurring line, from the RAW engine line (the exact shape the
  // converter's recurringLinesFromEngineResult reads in production), with
  // the selection flags acceptance requires. No customerSelection.frequency
  // is ever set — the converter would treat it as the accepted plan cadence.
  const storedLine = {
    ...line,
    name: line.name || offer.option.label || variant.label,
    selected: true,
    isSelected: true,
  };
  const estimateData = {
    result: { ...engineResult, recurring: { services: [storedLine] } },
    engineInputs,
    priorQualifyingServices: ownedFamilyKeys,
    membershipSnapshot,
    oneTapPurchase: {
      fingerprint: offer.fingerprint,
      optionId: offer.option.id,
      perVisit,
      initiatedAt: new Date().toISOString(),
    },
  };

  // Supersede-then-create runs in ONE transaction serialized by a
  // per-customer advisory lock (P2: two tabs initing concurrently could
  // both pass the supersede update before either inserted, leaving two
  // open purchases — and two capacity-blocking holds). The CAS on the
  // still-open states stays (P0): a purchase that COMPLETES between a read
  // and a blind id-keyed update must never be flipped to voided — holds
  // are released post-commit and only for rows the update actually
  // transitioned (releaseReservation only deletes live customer-less
  // holds, so a committed visit is untouchable either way).
  const token = crypto.randomBytes(16).toString('hex');
  const { superseded, estimate, purchase } = await db.transaction(async (trx) => {
    await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`one_tap_init:${customerId}`]);
    const priorOpen = await trx('one_tap_purchases')
      .where({ customer_id: customerId })
      .whereIn('status', ['initiated', 'reserved'])
      .update({ status: 'voided', updated_at: trx.fn.now() })
      .returning(['id', 'estimate_id', 'scheduled_service_id']);
    await trx('estimates')
      .where({ customer_id: customerId, source: 'one_tap_purchase', status: 'draft' })
      .whereNull('archived_at')
      .update({ archived_at: trx.fn.now() });

    // The draft rides the customer's on-file address so resolveEstimateCoords
    // adopts the customer coords (ride-along slot ranking needs them).
    const [estimateRow] = await trx('estimates').insert({
      customer_id: customerId,
      status: 'draft',
      source: 'one_tap_purchase',
      // Denormalized identity: the admin estimate list renders and searches
      // these columns directly (no customers join) — without them a one-tap
      // estimate shows blank and is unfindable by name/phone.
      customer_name: `${basis.customer.first_name || ''} ${basis.customer.last_name || ''}`.trim() || null,
      customer_phone: basis.customer.phone || null,
      customer_email: basis.customer.email || null,
      address: pricingAi.addressForCustomer(basis.customer) || null,
      monthly_total: monthlyTotal,
      annual_total: annualAfter,
      onetime_total: 0,
      waveguard_tier: membershipSnapshot.tierLabel || null,
      token,
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000),
      notes: null,
      estimate_data: JSON.stringify(estimateData),
    }).returning('*');

    const [purchaseRow] = await trx('one_tap_purchases').insert({
      customer_id: customerId,
      estimate_id: estimateRow.id,
      service_key: offer.serviceKey,
      option_id: offer.option.id,
      fingerprint: offer.fingerprint,
      per_visit: perVisit,
      status: 'initiated',
      terms_version: TERMS_VERSION,
      terms_snapshot: TERMS_TEXT,
      // consent_ip / consent_user_agent stay NULL here deliberately: init
      // fires on the first tap, BEFORE the customer has read or accepted
      // anything — an abandoned attempt must not retain what looks like
      // consent evidence. Confirm records them alongside accepted_at.
    }).returning('*');

    return { superseded: priorOpen, estimate: estimateRow, purchase: purchaseRow };
  });

  // Hold release AFTER commit — a rolled-back init must not have freed a
  // hold that still belongs to the (still-open) prior purchase.
  for (const prior of superseded) {
    if (prior.scheduled_service_id) {
      try {
        await slotReservation.releaseReservation({
          scheduledServiceId: prior.scheduled_service_id,
          estimateId: prior.estimate_id,
        });
      } catch (err) {
        // The 15-min reservation sweeper is the backstop.
        logger.warn(`[one-tap-purchase] prior hold release failed (code=${err?.code || 'none'})`);
      }
    }
  }

  // Card presence decides whether CONFIRM shows inline card capture. Lookup
  // errors bubble inside the helper by design; here they degrade to "ask
  // for the card" (the confirm-time check is the authority either way).
  const { findConsentedChargeableCard } = require('./payment-method-consents');
  let hasCardOnFile = false;
  try {
    hasCardOnFile = !!(await findConsentedChargeableCard(customerId));
  } catch {
    hasCardOnFile = false;
  }

  const slots = await loadSlots(estimate.id);

  return {
    purchaseId: purchase.id,
    estimateId: estimate.id,
    serviceKey: offer.serviceKey,
    label: offer.label,
    perVisit,
    cadenceLabel: offer.option.cadence || '',
    visitsPerYear: visits,
    terms: { version: TERMS_VERSION, text: TERMS_TEXT },
    hasCardOnFile,
    slots,
    holdMinutes: HOLD_MINUTES,
  };
}

// ── reserve ──────────────────────────────────────────────────────────────
async function reserve({ customerId, purchaseId, slotId }) {
  const purchase = await loadPurchaseForCustomer(customerId, purchaseId);
  if (!['initiated', 'reserved'].includes(purchase.status)) throw httpError(409, OFFER_CHANGED);
  const estimate = await db('estimates')
    .where({ id: purchase.estimate_id })
    .first('id', 'status', 'expires_at');
  if (!estimate || estimate.status !== 'draft' || estimateExpired(estimate)) {
    throw httpError(409, OFFER_CHANGED);
  }
  try {
    // Re-reserving the same estimate deletes the prior hold in-txn
    // (slot-reservation's own semantics) — re-picks need no explicit release.
    // NO outer transaction here (P1): reserveSlot opens its own
    // db.transaction, and holding a pool connection while waiting for a
    // second one starves the pool under a reservation wave. The concurrent-
    // reserve interleave (B replaces A's hold, then A's later pointer write
    // lands a DELETED hold id) is closed by the CAS below instead: the
    // pointer only persists while its hold row is still a LIVE reservation.
    const { scheduledServiceId, expiresAt } = await slotReservation.reserveSlot({
      estimateId: estimate.id,
      slotId,
    });
    // CAS: still-open purchase (a concurrent re-init can void it — a blind
    // update would revive the voided row) AND the just-created hold must
    // still exist as a live reservation (a concurrent reserve may have
    // replaced it). Either miss ⇒ release our hold (a no-op if already
    // replaced) and bounce the client to re-pick.
    const reserved = await db('one_tap_purchases')
      .where({ id: purchase.id })
      .whereIn('status', ['initiated', 'reserved'])
      .whereExists((qb) => qb.select(1).from('scheduled_services')
        .where({ id: scheduledServiceId })
        .whereNotNull('reservation_expires_at'))
      .update({
        scheduled_service_id: scheduledServiceId,
        slot_id: String(slotId),
        status: 'reserved',
        updated_at: db.fn.now(),
      });
    if (!reserved) {
      try {
        await slotReservation.releaseReservation({ scheduledServiceId, estimateId: estimate.id });
      } catch (releaseErr) {
        logger.warn(`[one-tap-purchase] lost-CAS hold release failed (code=${releaseErr?.code || 'none'})`);
      }
      throw httpError(409, OFFER_CHANGED);
    }
    return { scheduledServiceId, expiresAt, holdMinutes: HOLD_MINUTES };
  } catch (err) {
    if (err.code === 'INVALID_SLOT_ID') throw httpError(400, 'invalid slotId format');
    if (err.code === 'SLOT_UNAVAILABLE') {
      throw httpError(409, 'That time was just taken — pick another slot.', { code: 'SLOT_UNAVAILABLE' });
    }
    if (['ESTIMATE_NOT_FOUND', 'ESTIMATE_EXPIRED', 'ESTIMATE_TERMINAL'].includes(err.code)) {
      throw httpError(409, OFFER_CHANGED);
    }
    throw err;
  }
}

// ── release (= abandon) ──────────────────────────────────────────────────
// Client calls on overlay close. TERMINAL: the attempt is voided and its
// synthesized draft archived — an abandoned one-tap draft must never sit in
// the admin estimate pipeline (the default admin query lists every
// unarchived draft). Re-picks inside the flow never call this (reserveSlot
// replaces prior holds itself); a fresh open just inits a fresh purchase.
async function release({ customerId, purchaseId }) {
  const purchase = await loadPurchaseForCustomer(customerId, purchaseId);
  if (purchase.status === 'completed') throw httpError(409, 'This purchase is already confirmed.');
  if (purchase.scheduled_service_id) {
    await slotReservation.releaseReservation({
      scheduledServiceId: purchase.scheduled_service_id,
      estimateId: purchase.estimate_id,
    });
  }
  // CAS on the still-open states + the snapshot's hold identity (P1): if
  // confirm commits while releaseReservation above is in flight, a blind
  // id-keyed update would corrupt the completed ledger row. A lost CAS is
  // fine — the row moved on.
  const voided = await db('one_tap_purchases')
    .where({ id: purchase.id, scheduled_service_id: purchase.scheduled_service_id })
    .whereIn('status', ['initiated', 'reserved'])
    .update({
      status: 'voided',
      scheduled_service_id: null,
      slot_id: null,
      updated_at: db.fn.now(),
    });
  if (voided) {
    await db('estimates')
      .where({ id: purchase.estimate_id, status: 'draft', source: 'one_tap_purchase' })
      .whereNull('archived_at')
      .update({ archived_at: db.fn.now() })
      .catch(() => {});
  }
  return { released: true };
}

// ── purchase state (resume) ──────────────────────────────────────────────
// Read-only snapshot for the client's resume path (return from a hosted
// SetupIntent redirect): enough to reopen the overlay at the right step
// without re-initing. Everything re-derives from stored rows — nothing the
// client sends is trusted.
async function getPurchaseState({ customerId, purchaseId }) {
  const purchase = await loadPurchaseForCustomer(customerId, purchaseId);
  const estimate = await db('estimates')
    .where({ id: purchase.estimate_id })
    .first('id', 'status', 'expires_at', 'estimate_data');
  let line = null;
  try {
    const estData = typeof estimate?.estimate_data === 'string'
      ? JSON.parse(estimate.estimate_data)
      : estimate?.estimate_data;
    line = estData?.result?.recurring?.services?.[0] || null;
  } catch { line = null; }

  let slot = null;
  let holdLive = false;
  if (purchase.scheduled_service_id) {
    const hold = await db('scheduled_services')
      .where({ id: purchase.scheduled_service_id })
      .first('scheduled_date', 'window_start', 'reservation_expires_at');
    if (hold) {
      holdLive = !!(hold.reservation_expires_at && new Date(hold.reservation_expires_at) > new Date());
      slot = {
        date: dateOnly(hold.scheduled_date),
        windowStart: hhmm(hold.window_start),
        windowEnd: arrivalEndFor(hold.window_start),
        holdExpiresAt: hold.reservation_expires_at || null,
      };
    }
  }

  const { findConsentedChargeableCard } = require('./payment-method-consents');
  let hasCardOnFile = false;
  try {
    hasCardOnFile = !!(await findConsentedChargeableCard(customerId));
  } catch { hasCardOnFile = false; }

  return {
    purchaseId: purchase.id,
    estimateId: purchase.estimate_id,
    status: purchase.status,
    open: ['initiated', 'reserved'].includes(purchase.status)
      && estimate?.status === 'draft' && !estimateExpired(estimate),
    serviceKey: purchase.service_key,
    label: line?.name || String(purchase.service_key || 'service').replace(/_/g, ' '),
    perVisit: Number(purchase.per_visit),
    cadenceLabel: line?.frequencyLabel || '',
    visitsPerYear: Number(line?.visitsPerYear) || null,
    terms: { version: purchase.terms_version, text: purchase.terms_snapshot },
    hasCardOnFile,
    slot,
    holdLive,
    holdMinutes: HOLD_MINUTES,
  };
}

// ── stale-draft sweep ────────────────────────────────────────────────────
// Backstop for abandons that never fired release (closed laptop, crashed
// tab): void open purchases whose synthesized estimate has expired and
// archive those drafts so they age out of the admin pipeline. Runs from the
// scheduler beside the slot-reservation hold cleanup.
async function sweepStaleOneTapDrafts() {
  // 'expired' included alongside 'draft' (Codex r9 P1): the generic 06:00
  // runEstimateExpiration sweep used to flip past-due one-tap drafts to
  // 'expired' before this sweep saw them, permanently excluding them here
  // (open ledger, unarchived estimate). That sweep now skips one-tap rows,
  // but any row it already flipped — or any other path that expires one —
  // must still age out.
  const staleEstimates = await db('estimates')
    .where({ source: 'one_tap_purchase' })
    .whereIn('status', ['draft', 'expired'])
    .whereNull('archived_at')
    .where('expires_at', '<', new Date())
    .select('id');
  if (!staleEstimates.length) return { voided: 0 };
  const ids = staleEstimates.map((e) => e.id);
  const voided = await db('one_tap_purchases')
    .whereIn('estimate_id', ids)
    .whereIn('status', ['initiated', 'reserved'])
    .update({ status: 'voided', scheduled_service_id: null, slot_id: null, updated_at: db.fn.now() });
  // Re-assert non-terminal status inside the UPDATE (P2): a confirm that
  // started just before expiry can convert one of the selected drafts to
  // accepted while this sweep runs — the status CAS keeps a successfully
  // accepted estimate out of the archive.
  const archived = await db('estimates')
    .whereIn('id', ids)
    .whereIn('status', ['draft', 'expired'])
    .whereNull('archived_at')
    .update({ archived_at: db.fn.now() });
  logger.info(`[one-tap-purchase] stale-draft sweep archived ${archived} draft(s), voided ${voided} purchase(s)`);
  return { voided };
}

// ── slots (re-fetch) ─────────────────────────────────────────────────────
async function slots({ customerId, purchaseId }) {
  const purchase = await loadPurchaseForCustomer(customerId, purchaseId);
  if (!['initiated', 'reserved'].includes(purchase.status)) throw httpError(409, OFFER_CHANGED);
  try {
    return await loadSlots(purchase.estimate_id);
  } catch (err) {
    if (['ESTIMATE_NOT_FOUND', 'ESTIMATE_EXPIRED', 'ESTIMATE_TERMINAL'].includes(err.code)) {
      throw httpError(409, OFFER_CHANGED);
    }
    throw err;
  }
}

// Ownership + billing-lane fence, shared by the advisory pre-check and the
// authoritative in-transaction re-check. `database` is db or the confirm trx.
// Fail closed everywhere: an unprovable premises or a thrown ownership read
// means we cannot prove the family is un-owned, so nothing may be sold.
// Payer-billed accounts are fenced out of one-tap ENTIRELY (GH r6 P0): the
// existing card-collection endpoint (/api/billing/cards) enrolls Auto Pay
// the moment a card saves — BEFORE any confirm-time guard could run — and
// enrolling the homeowner's card on a payer-routed account points self-pay
// charging at the wrong party. throwOnError because the resolver's default
// fail-soft contract returns self-pay on a lookup outage, which would
// silently defeat the fence; callers treat a throw as payer-billed (fail
// closed). Mirrored by the GET oneTap flag.
async function customerIsPayerBilled(database, customerId) {
  const PayerService = require('./payer');
  const resolved = await PayerService.resolveForInvoice({
    database,
    customerId,
    throwOnError: true,
  });
  return !!resolved?.payerId;
}

async function assertTargetStillPurchasable(database, customer, serviceKey) {
  if (!customer || customer.active === false || customer.deleted_at) throw httpError(409, OFFER_CHANGED);
  if (customerPreservesMonthlyMembership(customer)) {
    throw httpError(409, 'One-tap purchase is not available on this account — send us a request instead.');
  }
  let payerBilled = true;
  try {
    payerBilled = await customerIsPayerBilled(database, customer.id);
  } catch (err) {
    logger.warn(`[one-tap-purchase] payer re-check failed, refusing (fail closed): ${err.message}`);
    payerBilled = true;
  }
  if (payerBilled) {
    throw httpError(409, 'One-tap purchase is not available on this account — send us a request instead.');
  }
  const linkage = require('./estimate-property-linkage');
  const { loadOwnedRecurringServiceKeys } = require('./waveguard-existing-services');
  let ownedKeys;
  try {
    const primaryStreet = linkage.normalizedStampedStreet(
      customer.address_line1, customer.address_line2, customer.city, customer.zip
    );
    if (!primaryStreet || linkage.scopeKeyLacksLocality(primaryStreet)) {
      throw new Error('unprovable primary premises');
    }
    ownedKeys = await loadOwnedRecurringServiceKeys(database, customer.id, {
      streetScope: {
        estimateStreet: primaryStreet,
        customerPrimaryStreet: primaryStreet,
        requireSharedLocality: true,
      },
    });
  } catch (err) {
    logger.warn(`[one-tap-purchase] ownership re-check failed, refusing (code=${err?.code || 'none'})`);
    throw httpError(409, OFFER_CHANGED);
  }
  const ownedVocab = new Set(ownedKeys.map((k) => OWNED_KEY_TO_OFFER_KEY[k] || k));
  if (ownedVocab.has(serviceKey)) {
    throw httpError(409, 'This service is already on your account — nothing was purchased.', { code: 'OWNED_MEANWHILE' });
  }
  // Membership must still hold at confirm time (P1): the frozen snapshot
  // replays isExistingCustomer:true and skipSetupInvoice waives the $99
  // setup fee — if the customer's last qualifying service was cancelled
  // between init and confirm, that waiver (and member-tier pricing) no
  // longer applies. Same qualifying-rows authority the snapshot froze from.
  const { loadExistingQualifyingServiceKeys } = require('./waveguard-existing-services');
  let qualifyingKeys;
  try {
    qualifyingKeys = await loadExistingQualifyingServiceKeys(database, customer.id);
  } catch (err) {
    logger.warn(`[one-tap-purchase] qualifying re-check failed, refusing (code=${err?.code || 'none'})`);
    throw httpError(409, OFFER_CHANGED);
  }
  if (!qualifyingKeys.length) {
    throw httpError(409, OFFER_CHANGED, { code: 'OWNED_MEANWHILE' });
  }
}

async function voidPurchase(purchase) {
  if (purchase.scheduled_service_id) {
    try {
      await slotReservation.releaseReservation({
        scheduledServiceId: purchase.scheduled_service_id,
        estimateId: purchase.estimate_id,
      });
    } catch (err) {
      logger.warn(`[one-tap-purchase] void-time hold release failed (code=${err?.code || 'none'})`);
    }
  }
  // Same CAS discipline as release: only a still-open row may be voided —
  // a purchase that completed since this snapshot keeps its committed state.
  // When the void lands, archive the synthesized draft too (mirror release):
  // an unsellable draft must not sit in the admin estimate pipeline where
  // staff could act on it and duplicate already-owned service.
  try {
    const voided = await db('one_tap_purchases')
      .where({ id: purchase.id })
      .whereIn('status', ['initiated', 'reserved'])
      .update({
        status: 'voided',
        scheduled_service_id: null,
        updated_at: db.fn.now(),
      });
    if (voided) {
      await db('estimates')
        .where({ id: purchase.estimate_id, status: 'draft', source: 'one_tap_purchase' })
        .whereNull('archived_at')
        .update({ archived_at: db.fn.now() });
    }
  } catch (err) {
    logger.warn(`[one-tap-purchase] void cleanup incomplete (code=${err?.code || 'none'})`);
  }
}

function formatVisitWhen(firstVisit) {
  if (!firstVisit?.date) return '';
  const [y, m, d] = firstVisit.date.split('-').map(Number);
  const dt = new Date(Date.UTC(y, (m || 1) - 1, d || 1, 12));
  const dateText = Number.isNaN(dt.getTime())
    ? firstVisit.date
    : dt.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'UTC' });
  const window = firstVisit.windowStart && firstVisit.windowEnd
    ? `, ${to12h(firstVisit.windowStart)}–${to12h(firstVisit.windowEnd)}`
    : '';
  return `${dateText}${window}`;
}

function to12h(value) {
  const [h, m] = String(value || '').split(':').map(Number);
  if (!Number.isFinite(h)) return String(value || '');
  const suffix = h >= 12 ? 'PM' : 'AM';
  const hour = ((h + 11) % 12) + 1;
  return `${hour}:${String(m || 0).padStart(2, '0')} ${suffix}`;
}

// Canonical success payload for a purchase that already completed —
// rebuilt from stored rows; no notifications or emails are re-sent (all
// sends are dedupe-keyed/idempotent anyway).
async function completedRetryResponse(customerId, completedPurchase) {
  const visit = completedPurchase.scheduled_service_id
    ? await db('scheduled_services')
      .where({ id: completedPurchase.scheduled_service_id })
      .first('scheduled_date', 'window_start', 'service_type')
    : null;
  const retryCustomer = await db('customers').where({ id: customerId }).first('email');
  return {
    success: true,
    firstVisit: visit ? {
      date: dateOnly(visit.scheduled_date),
      windowStart: hhmm(visit.window_start),
      windowEnd: arrivalEndFor(visit.window_start),
    } : null,
    perVisit: Number(completedPurchase.per_visit),
    label: visit?.service_type || String(completedPurchase.service_key || 'service').replace(/_/g, ' '),
    emailQueued: !!(retryCustomer?.email && String(retryCustomer.email).includes('@')),
  };
}

// ── confirm ──────────────────────────────────────────────────────────────
async function confirm({ customerId, purchaseId, termsAccepted, ip, userAgent }) {
  if (termsAccepted !== true) throw httpError(400, 'You must agree to the terms to confirm.');
  const purchase = await loadPurchaseForCustomer(customerId, purchaseId);
  // Idempotent retry (P1): a conversion that committed but whose HTTP
  // response was lost leaves the customer on the confirm button. Their
  // retry must get the canonical success back — a generic 409 renders the
  // client's "nothing was purchased" screen over a purchase that EXISTS.
  if (purchase.status === 'completed') {
    return completedRetryResponse(customerId, purchase);
  }
  if (purchase.status !== 'reserved' || !purchase.scheduled_service_id) {
    throw httpError(409, 'Pick a time before confirming.');
  }
  const preEstimate = await db('estimates').where({ id: purchase.estimate_id }).first('id', 'status', 'expires_at', 'price_locked_at');
  if (!preEstimate || preEstimate.status !== 'draft' || preEstimate.price_locked_at || estimateExpired(preEstimate)) {
    throw httpError(409, OFFER_CHANGED);
  }

  const customer = await db('customers').where({ id: customerId }).first();
  if (!customer || customer.active === false || customer.deleted_at) throw httpError(409, OFFER_CHANGED);

  // Fast-fail ownership pre-check (fail closed → release + void). This runs
  // UNLOCKED and is advisory only — the authoritative re-check runs again
  // INSIDE the confirm transaction after the comms lock (P0: two concurrent
  // confirms for the same family both passed a pre-lock check, serialized on
  // the lock, and both converted).
  try {
    await assertTargetStillPurchasable(db, customer, purchase.service_key);
  } catch (err) {
    await voidPurchase(purchase);
    throw err.status ? err : httpError(409, OFFER_CHANGED);
  }

  // Consented chargeable card — REQUIRED, no fallback, never proceed
  // cardless. The client collects via the existing setup-intent + save-card
  // pair, then retries confirm.
  const { findConsentedChargeableCard } = require('./payment-method-consents');
  let card = null;
  try {
    card = await findConsentedChargeableCard(customerId);
  } catch (err) {
    logger.warn(`[one-tap-purchase] card lookup failed, asking for card (code=${err?.code || 'none'})`);
    card = null;
  }
  if (!card) throw httpError(402, 'A saved payment method is required to confirm.', { needsCard: true });

  const EstimateConverter = require('./estimate-converter');
  let txOut;
  try {
    txOut = await db.transaction(async (trx) => {
      // RUNG 1 FIRST (ORDERING CONTRACT, services/scheduling/occupancy.js —
      // copied from the estimate-accept txn, which documents the real
      // deadlock): the hold's date occupancy key is taken BEFORE any row
      // lock; commitReservation re-checks its own pre-read against the key
      // we pass down (preLockedDate) and a moved hold fails into the
      // RESERVATION_EXPIRED re-pick recovery.
      const holdDateRow = await trx('scheduled_services')
        .where({ id: purchase.scheduled_service_id })
        .first('scheduled_date');
      if (!holdDateRow) {
        throw httpError(409, 'Your held time expired — pick a slot again.', { code: 'RESERVATION_EXPIRED' });
      }
      const preLockedDate = dateOnly(holdDateRow.scheduled_date) || null;
      if (preLockedDate) await acquireOccupancyLock(trx, preLockedDate);
      // Rung 6 — comms lock before this txn's first row lock (the converter
      // inserts scheduled_services rows on this trx).
      await lockCustomerComms(trx, customerId);

      // AUTHORITATIVE re-checks, now serialized behind the comms lock (P0:
      // concurrent confirms both passed the unlocked pre-check). The
      // purchase row lock + status check also closes the double-confirm and
      // confirm-vs-reinit races; the fresh customer read re-runs the
      // ownership and monthly-membership fences against committed state —
      // a first confirm's converted rows are visible here.
      const purchaseRow = await trx('one_tap_purchases')
        .where({ id: purchase.id })
        .forUpdate()
        .first();
      // Concurrent-confirm idempotency (GH r7 P2): two confirms that BOTH
      // started while the row was reserved serialize on this lock — the
      // loser must get the canonical success back, not a 409 that renders
      // "nothing was purchased" over a conversion that just committed.
      if (purchaseRow && purchaseRow.status === 'completed') {
        return { alreadyCompleted: purchaseRow };
      }
      if (!purchaseRow || purchaseRow.status !== 'reserved') throw httpError(409, OFFER_CHANGED);
      const freshCustomer = await trx('customers').where({ id: customerId }).first();
      await assertTargetStillPurchasable(trx, freshCustomer, purchase.service_key);

      const est = await trx('estimates')
        .where({ id: purchase.estimate_id })
        .forUpdate()
        .first();
      if (!est || est.status !== 'draft' || estimateExpired(est)) throw httpError(409, OFFER_CHANGED);

      // Frozen-offer revalidation (codex P1): while open, the synthesized
      // draft is an ordinary editable draft — PUT /api/admin/estimates/:id
      // can rewrite its totals/estimate_data while purchase.per_visit and
      // the terms the customer accepted stay frozen at the original offer.
      // Reassert the stored snapshot against the ledger before converting:
      // fingerprint/option/per-visit must match the purchase row, the draft
      // must still be the single-recurring-line one-tap shape, and the
      // persisted annual total must still divide to the accepted
      // per-application amount. Any divergence ⇒ 409, never a conversion of
      // terms the customer never saw.
      let estData = null;
      try {
        estData = typeof est.estimate_data === 'string'
          ? JSON.parse(est.estimate_data)
          : est.estimate_data;
      } catch { estData = null; }
      const frozen = estData?.oneTapPurchase || null;
      const storedServices = estData?.result?.recurring?.services || [];
      const storedLine = storedServices[0] || null;
      const storedVisits = [storedLine?.visitsPerYear, storedLine?.visits, storedLine?.frequency]
        .map(Number).find((n) => Number.isFinite(n) && n > 0) || null;
      const ledgerPer = Number(purchase.per_visit);
      const totalsPer = storedVisits
        ? Math.round((Number(est.annual_total) / storedVisits) * 100) / 100
        : null;
      const snapshotIntact = !!frozen
        && frozen.fingerprint === purchase.fingerprint
        && String(frozen.optionId || '') === String(purchase.option_id || '')
        && Math.abs(Number(frozen.perVisit) - ledgerPer) < 0.005
        && storedServices.length === 1
        && totalsPer !== null && Math.abs(totalsPer - ledgerPer) <= 0.005;
      if (!snapshotIntact) throw httpError(409, OFFER_CHANGED);

      // CAS double-confirm guard: acceptance is where money commits.
      const locked = await trx('estimates')
        .where({ id: est.id, status: 'draft' })
        .whereNull('price_locked_at')
        .update({
          status: 'accepted',
          accepted_at: trx.fn.now(),
          price_locked_at: trx.fn.now(),
          price_locked_by: 'customer_accept',
          pricing_authority: 'LOCKED',
          server_computed_price: est.annual_total,
        });
      if (!locked) throw httpError(409, OFFER_CHANGED);

      let committed;
      try {
        committed = await slotReservation.commitReservation({
          scheduledServiceId: purchase.scheduled_service_id,
          customerId,
          estimatedPrice: Number(purchase.per_visit),
          estimate: { ...est, status: 'accepted' },
          serviceMode: 'recurring',
          preLockedDate,
          trx,
        });
      } catch (commitErr) {
        // RESERVATION_NOT_FOUND joins the expiry lane (P1): the cleanup
        // sweep or a release can DELETE the hold between our pre-txn read
        // and commitReservation's own — same recovery (re-pick), never a
        // 500 that leaves the purchase pointing at a missing hold.
        if (commitErr.code === 'RESERVATION_EXPIRED' || commitErr.code === 'RESERVATION_NOT_FOUND') {
          throw httpError(409, 'Your held time expired — pick a slot again.', { code: 'RESERVATION_EXPIRED' });
        }
        if (commitErr.code === 'SLOT_UNAVAILABLE') {
          throw httpError(409, 'That time is no longer available — pick a slot again.', { code: 'SLOT_UNAVAILABLE' });
        }
        throw commitErr;
      }

      // T&S accepts: stamp the committed row with the purchased tier's
      // catalog identity — the same treeShrubTierCatalogStamp step every
      // accept-path reservation branch runs (commitReservation canonicalizes
      // the row to the generic label with no service_id, and the converter's
      // seeded follow-ups copy service_id from this parent row, so the stamp
      // must land BEFORE convertEstimate).
      if (committed?.id && purchase.service_key === 'tree_shrub') {
        const { treeShrubTierCatalogStamp } = require('../routes/estimate-public');
        const tsVariant = require('./customer-pricing-ai')
          .variantsForService('tree_shrub', '', false)
          .find((v) => v.id === purchase.option_id);
        const tierStamp = await treeShrubTierCatalogStamp(trx, {
          selectedFrequency: tsVariant?.tier
            ? { serviceCategory: 'tree_shrub', key: tsVariant.tier }
            : null,
          estData,
          rowServiceType: committed.service_type,
        });
        if (tierStamp) {
          await trx('scheduled_services').where({ id: committed.id }).update(tierStamp);
          Object.assign(committed, tierStamp);
        }
      }

      // The converter detects the committed reservation on this trx and
      // anchors the series to it. NO SMS (skipWelcomeSms), no setup invoice
      // (later per-visit charges ride the existing invoice-on-complete
      // rail), no auto-send; the deferred email/notification payloads fire
      // post-commit below so a rollback can't page anyone.
      const conversion = await EstimateConverter.convertEstimate(est.id, {
        database: trx,
        billingTerm: 'standard',
        skipSetupInvoice: true,
        autoSendInvoice: false,
        skipWelcomeSms: true,
        skipMembershipEmail: true,
        deferFollowUpReminderRegistration: true,
        deferCommercialScheduleNotification: true,
      });

      // CAS on the reserved state (belt to the forUpdate braces above): a
      // zero-row update means someone else transitioned this purchase — the
      // whole conversion must roll back rather than complete a voided row.
      const completedCount = await trx('one_tap_purchases')
        .where({ id: purchase.id, status: 'reserved' })
        .update({
          status: 'completed',
          accepted_at: trx.fn.now(),
          consent_ip: ip || null,
          consent_user_agent: userAgent || null,
          updated_at: trx.fn.now(),
        });
      if (!completedCount) throw httpError(409, OFFER_CHANGED);

      return { conversion, committed };
    });
  } catch (err) {
    // Owned-in-the-meantime discovered under the lock: the conversion rolled
    // back; void the purchase (releases the hold) so it cannot be retried.
    if (err && err.code === 'OWNED_MEANWHILE') {
      await voidPurchase(purchase);
      throw err;
    }
    // Re-pick recovery: the hold died mid-confirm — everything rolled back;
    // put the purchase back in pick-a-time state (best-effort).
    if (err && (err.code === 'RESERVATION_EXPIRED' || err.code === 'SLOT_UNAVAILABLE')) {
      // Hold-identity CAS: only reset the row if it still points at the hold
      // THIS confirm ran with — a concurrent re-reserve (customer re-picked
      // while this confirm was in flight) has already replaced the pointer,
      // and a blind reset would erase their newly held slot.
      await db('one_tap_purchases')
        .where({ id: purchase.id, status: 'reserved', scheduled_service_id: purchase.scheduled_service_id })
        .update({ status: 'initiated', scheduled_service_id: null, slot_id: null, updated_at: db.fn.now() })
        .catch(() => {});
    }
    throw err;
  }

  // Concurrent-confirm loser: the first confirm did all the work (and its
  // post-commit sends are dedupe-keyed) — just answer canonically.
  if (txOut.alreadyCompleted) {
    return completedRetryResponse(customerId, txOut.alreadyCompleted);
  }

  // ── Post-commit (best-effort — never roll back the purchase) ──────────
  const { conversion, committed } = txOut;

  // Multi-property linkage — same standard step the public accept flow runs
  // post-commit (gated internally on GATE_CUSTOMER_PROPERTIES): resolve the
  // customer_properties row for the accepted address, link
  // estimates.property_id, stamp the booked visits' service address. AWAITED
  // like the accept route so a deploy right after the response can't strand
  // the accept unlinked; the helper never throws — the purchase stands.
  await require('./estimate-property-linkage').linkAcceptedEstimateProperty({
    estimateId: purchase.estimate_id,
    customerId,
  });

  // Auto Pay enrollment (codex P1): a qualifying consent row alone is not
  // charging protection — completion charging requires ACTIVE Auto Pay with
  // an in-charge method, and a consent whose earlier enrollment failed
  // half-way satisfies the card check above without it. Run the same
  // saved-method enrollment semantics the accept path's auto-satisfy branch
  // uses (idempotent; defers to a healthy incumbent). A refusal parks an
  // office exception — the committed purchase stands, but never silently
  // unprotected. Ownership is inherent: the card row was looked up BY this
  // customerId.
  // Payer routing first (GH r6 P1): a member whose invoices route to a
  // third-party payer must never have the homeowner's card flipped into
  // Auto Pay — the enrollment would point OTHER self-pay charging at the
  // wrong party. Same resolveForInvoice authority the accept path's policy
  // resolver consults; throwOnError because the default fail-soft contract
  // returns self-pay on a lookup outage, which would silently defeat this
  // check. Payer-billed ⇒ skip enrollment (invoices route to the payer);
  // a failed check fails CLOSED (skip + office exception).
  let payerBilled = false;
  let payerCheckFailed = false;
  try {
    const PayerService = require('./payer');
    const resolvedPayer = await PayerService.resolveForInvoice({
      customerId,
      scheduledServiceId: committed?.id || null,
      throwOnError: true,
    });
    payerBilled = !!resolvedPayer?.payerId;
  } catch (err) {
    payerCheckFailed = true;
    logger.warn(`[one-tap-purchase] payer re-check failed — skipping Auto Pay enrollment (fail closed): ${err.message}`);
  }
  if (payerBilled) {
    logger.info(`[one-tap-purchase] Auto Pay enrollment skipped: customer ${customerId} is payer-billed`);
  } else if (payerCheckFailed) {
    await require('./notification-service').notifyAdmin(
      'billing',
      'One-tap purchase: Auto Pay enrollment skipped (payer check failed)',
      'A one-tap purchase confirmed but the payer-routing check failed, so Auto Pay was NOT enrolled (fail closed) — review the account or self-pay visits will invoice unprotected.',
      { link: `/admin/customers/${customerId}`, metadata: { customerId, estimateId: purchase.estimate_id, purchaseId: purchase.id } },
    ).catch(() => {});
  } else {
    try {
      const { enrollConsentedMethod } = require('./autopay-enrollment');
      const enrollment = await enrollConsentedMethod({
        customerId,
        paymentMethodId: card.id,
        source: 'one_tap_purchase',
        details: { via: 'one_tap_confirm', estimate_id: purchase.estimate_id, purchase_id: purchase.id },
      });
      if (!enrollment.enrolled && enrollment.reason !== 'already_enrolled') {
        await require('./notification-service').notifyAdmin(
          'billing',
          'One-tap purchase: Auto Pay enrollment refused',
          `A one-tap purchase confirmed with a consented saved card but Auto Pay enrollment was refused (${enrollment.reason}) — re-add a payment method or the visits will invoice unprotected.`,
          { link: `/admin/customers/${customerId}`, metadata: { customerId, estimateId: purchase.estimate_id, purchaseId: purchase.id, reason: enrollment.reason } },
        ).catch(() => {});
      }
    } catch (e) {
      logger.error(`[one-tap-purchase] Auto Pay enrollment failed for customer ${customerId}: ${e.message}`);
      await require('./notification-service').notifyAdmin(
        'billing',
        'One-tap purchase: Auto Pay enrollment failed',
        'A one-tap purchase confirmed but Auto Pay enrollment threw — review the account or the visits will invoice unprotected.',
        { link: `/admin/customers/${customerId}`, metadata: { customerId, estimateId: purchase.estimate_id, purchaseId: purchase.id } },
      ).catch(() => {});
    }
  }
  const serviceLabel = committed?.service_type
    || String(purchase.service_key || 'service').replace(/_/g, ' ');
  const firstVisit = committed ? {
    date: dateOnly(committed.scheduled_date),
    windowStart: hhmm(committed.window_start),
    // Customer-facing arrival window (start + 2h), never the scheduling
    // window_end (duration/overlap block — AGENTS.md arrival-copy rule).
    windowEnd: arrivalEndFor(committed.window_start) || hhmm(committed.window_end),
  } : null;

  // Standard accept-path emails, nothing else: the booked-onboarding email
  // (idempotent per estimate) + the membership email the converter deferred.
  try {
    const { sendEstimateAcceptedOnboarding } = require('./estimate-accepted-email');
    void sendEstimateAcceptedOnboarding({
      customerId,
      estimateId: purchase.estimate_id,
      serviceLabel,
      appointment: committed || null,
    });
  } catch (e) {
    logger.error(`[one-tap-purchase] onboarding email failed for customer ${customerId}: ${e.message}`);
  }
  if (conversion?.membershipEmail && conversion?.recurringConversionSkipped !== true) {
    try {
      const AccountMembershipEmail = require('./account-membership-email');
      void AccountMembershipEmail.sendMembershipStarted(conversion.membershipEmail)
        .catch((e) => logger.error(`[one-tap-purchase] membership email failed for customer ${customerId}: ${e.message}`));
    } catch (e) {
      logger.error(`[one-tap-purchase] membership email setup failed: ${e.message}`);
    }
  }

  // Reminder + appointment-type automations for the COMMITTED first visit
  // (codex P2 ×2): deferredFollowUpReminderRows carries only the seeded
  // follow-ups — the standard accept route registers the committed parent
  // separately, so this path must too, or the customer's selected first
  // visit rides only the 15-min self-heal sweep. Same for the tagger: the
  // parent row otherwise keeps a null appointment_type (children classify
  // themselves in the seeder; nothing backfills the parent).
  const committedAndDeferred = [
    ...(committed?.id ? [committed] : []),
    ...(Array.isArray(conversion?.deferredFollowUpReminderRows)
      ? conversion.deferredFollowUpReminderRows
      : []),
  ];
  if (committed?.id) {
    try {
      const AppointmentTagger = require('./appointment-tagger');
      // suppressWelcome: same accept-path contract — the converter's
      // candidacy gate owns any new-recurring welcome, and this flow is
      // NO-SMS by ruling anyway.
      void AppointmentTagger.onServiceScheduled(committed.id, { suppressWelcome: true })
        .catch((e) => logger.error(`[one-tap-purchase] appointment automations failed for ${committed.id}: ${e.message}`));
    } catch (e) {
      logger.error(`[one-tap-purchase] appointment automations setup failed: ${e.message}`);
    }
  }
  for (const appointment of committedAndDeferred) {
    try {
      const AppointmentReminders = require('./appointment-reminders');
      await AppointmentReminders.registerAppointment(
        appointment.id,
        customerId,
        `${dateOnly(appointment.scheduled_date)}T${hhmm(appointment.window_start) || '08:00'}`,
        appointment.service_type || serviceLabel,
        'estimate_accept_slot',
        { sendConfirmation: false },
      );
    } catch (e) {
      logger.error(`[one-tap-purchase] reminder registration failed for ${appointment.id}: ${e.message}`);
    }
  }

  // Termite accepts prep the signable program agreement (codex P2 — same
  // post-commit hook the public and manual acceptance paths run; the service
  // never throws and skips silently for non-termite estimates). Re-read the
  // row so the agreement prefills from the ACCEPTED figures, not the
  // pre-accept snapshot in memory. billingTerm 'standard' matches the
  // converter call above.
  if (purchase.service_key === 'termite') {
    try {
      const { maybeCreateTermiteProgramAgreement } = require('./termite-program-agreement');
      const acceptedRow = await db('estimates').where({ id: purchase.estimate_id }).first();
      if (acceptedRow) {
        void maybeCreateTermiteProgramAgreement({
          estimate: acceptedRow,
          customerId,
          billingTerm: 'standard',
        }).catch((e) => logger.error(`[one-tap-purchase] termite agreement prep failed for estimate ${purchase.estimate_id}: ${e.message}`));
      }
    } catch (e) {
      logger.error(`[one-tap-purchase] termite agreement prep setup failed: ${e.message}`);
    }
  }

  // Deferred admin notifications the converter returned (tier upgrade,
  // plan-rate review, commercial schedule) — dispatched post-commit exactly
  // like the accept route does.
  const NotificationService = require('./notification-service');
  for (const key of ['commercialScheduleNotification', 'tierUpgradeNotification', 'planRateReviewNotification']) {
    const n = conversion?.[key];
    if (!n) continue;
    try {
      void NotificationService.notifyAdmin(n.type, n.title, n.body, n.options)
        .catch((e) => logger.error(`[one-tap-purchase] deferred admin notify (${key}) failed: ${e.message}`));
    } catch (e) {
      logger.error(`[one-tap-purchase] deferred admin notify (${key}) setup failed: ${e.message}`);
    }
  }

  // App notification (bell + native push). Transactional confirmation of
  // the customer's own purchase — deliberately NO preferenceKey, so a
  // marketing pref can never suppress it; deduped per purchase.
  const perVisitText = `$${Number(purchase.per_visit).toFixed(2)}`;
  const visitLine = firstVisit?.date ? ` First visit: ${formatVisitWhen(firstVisit)}.` : '';
  // Only promise an email that can actually send: portal auth is phone-based
  // and customer email is nullable — both email services skip silently
  // without an address, so the copy must not claim otherwise.
  const emailQueued = !!(customer.email && String(customer.email).includes('@'));
  const emailLine = emailQueued ? ' A confirmation email is on the way.' : '';
  try {
    void Promise.resolve(NotificationService.notifyCustomer(
      customerId,
      'service',
      `${serviceLabel} is confirmed`,
      `${serviceLabel} was added to your plan at ${perVisitText} per application.${visitLine}${emailLine}`,
      {
        link: '/',
        dedupeKey: `one_tap_purchase:${purchase.id}`,
        metadata: { purchaseId: purchase.id, estimateId: purchase.estimate_id },
      },
    )).catch((e) => logger.error(`[one-tap-purchase] customer notification failed: ${e.message}`));
  } catch (e) {
    logger.error(`[one-tap-purchase] customer notification setup failed: ${e.message}`);
  }

  // Staff bell — staff-only visibility of the self-served purchase.
  try {
    const { triggerNotification } = require('./notification-triggers');
    void triggerNotification('one_tap_purchase_completed', {
      customerId,
      customerName: `${customer.first_name || ''} ${customer.last_name || ''}`.trim() || null,
      serviceLabel,
      perVisit: Number(purchase.per_visit),
      firstVisitDate: firstVisit?.date || null,
      estimateId: purchase.estimate_id,
    }).catch((e) => logger.error(`[one-tap-purchase] staff bell failed: ${e.message}`));
  } catch (e) {
    logger.error(`[one-tap-purchase] staff bell setup failed: ${e.message}`);
  }

  return {
    success: true,
    firstVisit,
    perVisit: Number(purchase.per_visit),
    label: serviceLabel,
    emailQueued,
  };
}

module.exports = {
  initPurchase,
  reserve,
  release,
  slots,
  confirm,
  getPurchaseState,
  sweepStaleOneTapDrafts,
  TERMS_VERSION,
  TERMS_TEXT,
  HOLD_MINUTES,
  _private: { assertNoDrift, serializeSlot, formatVisitWhen, to12h },
};
