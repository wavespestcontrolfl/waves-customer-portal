/**
 * Recurring card-on-file: Auto Pay by default at accept.
 *
 * Owner decision 2026-07-12: the $49 recurring acceptance deposit under-protects
 * downside (exposure = every visit's invoice minus one first-visit credit), so
 * NEW recurring customers save a card at accept — ALONGSIDE the deposit, which
 * stays exactly as it is — and are enrolled in Auto Pay by default. Each
 * completed application then auto-charges the saved method through the existing
 * per-application completion collection (admin-dispatch) / monthly billing
 * rails; nothing here charges money itself.
 *
 * Deliberately mirrors the one-time card-hold pattern (estimate-card-holds.js):
 * a CUSTOMERLESS SetupIntent (the estimate may have no customer row until
 * acceptance creates one) captured in the accept UI, verified LIVE against
 * Stripe at accept — never trusted from the client — then attached post-commit.
 * Unlike the hold, there is no fee schedule and no hold row to freeze: the
 * saved card is a payment method, not a commitment device, so this module is
 * stateless — verification re-derives everything from the SetupIntent, and
 * enrollment runs the same save → consent → enroll sequence as the pay page's
 * /setup-complete (payment_method_consents row = the authorization artifact,
 * enrollConsentedMethod = the single enrollment semantics).
 *
 * DARK BY DEFAULT: enforced only when RECURRING_CARD_ON_FILE=true (rollout:
 * ship dark → land the capture UI → flip). Exemptions fail toward REQUIRING
 * the card (a card wrongly captured is harmless; a wrongly granted exemption
 * silently loses the protection) — EXCEPT the payer check, which fails toward
 * EXEMPT (Codex #2668 round-4 P1): a payer lookup outage must never conclude
 * "self-pay" and enroll the homeowner's card for invoices that route to a
 * third-party payer. A missed capture is a recoverable protection gap; a
 * wrong enrollment charges the wrong party.
 */

const db = require('../models/db');
const logger = require('./logger');
const StripeService = require('./stripe');

function isRecurringCardOnFileEnabled() {
  const flag = process.env.RECURRING_CARD_ON_FILE;
  return flag === '1' || flag === 'true' || flag === 'on';
}

// Prepay-annual joins the card lane (owner ruling 2026-08-25, superseding
// the 2026-07-12 "prepay stays an optional upsell, never the gate" carve-out).
// The carve-out's premise — "the year is paid up front at accept" — was never
// true: a prepay accept only minted a draft invoice and emailed a pay link,
// so a customer who ignored the email was serviced with no card and no
// payment (two real accepts, 2026-08). While ON, a prepay accept requires
// the same live-verified SetupIntent capture as per-application, and the
// accept route auto-charges the prepay invoice on the just-enrolled method
// post-commit. Kill = unset GATE_PREPAY_CARD_AND_CHARGE.
// CONJUNCTION with the master gate (pre-push Codex P1): with only the
// prepay gate set, the resolver returns feature_disabled and captures no
// card — /data must not advertise prepayInLane and the accept must not run
// a charge the UI never disclosed. The prepay lane exists only inside the
// recurring card lane.
function isPrepayCardAndChargeEnabled() {
  const flag = process.env.GATE_PREPAY_CARD_AND_CHARGE;
  return isRecurringCardOnFileEnabled() && (flag === '1' || flag === 'true' || flag === 'on');
}

// What a recurring accept requires. Exempt lanes:
//  - one-time accepts (the card-hold lane owns those),
//  - invoice-mode (admin opted into manual/auto invoicing — its own billing
//    path, and commercial accepts live here),
//  - prepay-annual ONLY while GATE_PREPAY_CARD_AND_CHARGE is off (legacy
//    carve-out — see isPrepayCardAndChargeEnabled; with the gate on, prepay
//    accepts require the card like any other recurring accept),
//  - existing plan customers (mirrors the deposit exemption: this protection
//    is for NEW recurring signups; members' billing behavior is established
//    — and many are already enrolled),
//  - payer-billed customers (invoices route to the third-party payer's AP
//    inbox; auto-charging the HOMEOWNER's card would collect from the wrong
//    party),
//  - customers already on Auto Pay with a chargeable method (nothing to add).
async function resolveRecurringCardPolicyForEstimate({
  estimate,
  membership = null,
  treatAsOneTime = false,
  billByInvoice = false,
  paymentMethodPreference = null,
  scheduledServiceId = null,
  useLinkedFallback = true,
} = {}) {
  if (!isRecurringCardOnFileEnabled()) {
    return { enforced: false, required: false, exemptReason: 'feature_disabled' };
  }
  if (treatAsOneTime) {
    return { enforced: true, required: false, exemptReason: 'one_time_card_hold_lane' };
  }
  if (billByInvoice) {
    return { enforced: true, required: false, exemptReason: 'invoice_mode' };
  }
  if (paymentMethodPreference === 'prepay_annual' && !isPrepayCardAndChargeEnabled()) {
    // Legacy carve-out only — see isPrepayCardAndChargeEnabled. With the
    // gate ON, prepay continues into the customer-dependent exemptions
    // below (plan member / payer-billed / autopay-active / saved-method)
    // exactly like a per-application accept.
    return { enforced: true, required: false, exemptReason: 'prepay_annual' };
  }

  // Customer-dependent exemptions need the customer accept will actually
  // land on. Sent estimates often carry only customer_phone — the accept
  // transaction phone-matches an existing profile — so run the SAME
  // unambiguous match here (Codex #2680 r3): an existing customer with an
  // enrollment-qualified saved card or active Auto Pay must not be forced
  // through a fresh SetupIntent (auto-satisfy contract, spec §3.2). A
  // failed lookup keeps the card required (fail toward protection).
  let resolvedCustomerId = estimate?.customer_id || null;
  if (!resolvedCustomerId && estimate?.customer_phone) {
    try {
      const gates = require('../routes/estimate-public');
      if (typeof gates.matchAcceptCustomerByPhone === 'function') {
        const { match } = await gates.matchAcceptCustomerByPhone(estimate);
        resolvedCustomerId = match?.id || null;
      }
    } catch (err) {
      logger.warn('[recurring-cof] phone-match customer lookup failed — card stays required', { error: err.message });
    }
  }

  // Existing plan customer — snapshot first, then the LIVE fallback the
  // deposit resolver uses (legacy customer-linked estimates have no
  // membershipSnapshot). A failed live check keeps the card required.
  let isPlanMember = !!membership?.isExistingCustomer;
  if (resolvedCustomerId) {
    try {
      // An auto-derived tier LABEL (waveguard_tier_source = 'auto') has no
      // established membership billing or saved-card protection — it must
      // not waive the card-on-file capture gate (Codex #3011 r8 P1). Live
      // provenance overrides the frozen membershipSnapshot too (Codex r9):
      // an estimate saved after the auto-stamp freezes
      // isExistingCustomer: true, and that snapshot must not skip the
      // SetupIntent for a label-only customer.
      // Fail-CLOSED (Codex r10 P1): anything except a verified 'not_label'
      // — including 'unknown' from a lookup error or a pre-migration schema
      // — keeps the SetupIntent required.
      const { tierLabelStatus } = require('./self-booking-plan-sync');
      const labelOnly = (await tierLabelStatus(resolvedCustomerId)) !== 'not_label';
      if (labelOnly) {
        isPlanMember = false;
      } else if (!isPlanMember) {
        const { loadExistingRecurringQualifyingRows } = require('./waveguard-existing-services');
        const rows = await loadExistingRecurringQualifyingRows(db, resolvedCustomerId);
        isPlanMember = Array.isArray(rows) && rows.length > 0;
      }
    } catch (err) {
      logger.warn('[recurring-cof] live plan-customer check failed — card stays required', { error: err.message });
    }
  }
  if (isPlanMember) {
    return { enforced: true, required: false, exemptReason: 'existing_plan_customer' };
  }

  if (resolvedCustomerId) {
    // Payer-billed: match the eventual invoice's payer precedence
    // (scheduled_services.payer_id ?? customers.payer_id), scoped to the
    // appointment actually being accepted when the caller resolved one.
    // throwOnError — resolveForInvoice is fail-soft by default (returns
    // self-pay on a lookup outage), which would require + capture + enroll
    // the homeowner's card for a payer-billed account. An uncertain payer
    // state EXEMPTS the card instead (Codex #2668 round-4 P1).
    try {
      const PayerService = require('./payer');
      let linkedSsId = scheduledServiceId ? String(scheduledServiceId) : null;
      if (!linkedSsId && useLinkedFallback) {
        try {
          const gates = require('../routes/estimate-public');
          const appt = typeof gates.findLinkedUpcomingAppointment === 'function'
            ? await gates.findLinkedUpcomingAppointment(estimate)
            : null;
          linkedSsId = appt?.id ? String(appt.id) : null;
        } catch { /* scope narrowing only — customer-default still checked below */ }
      }
      const resolved = await PayerService.resolveForInvoice({ customerId: resolvedCustomerId, scheduledServiceId: linkedSsId, throwOnError: true });
      if (resolved?.payerId) {
        return { enforced: true, required: false, exemptReason: 'payer_billed' };
      }
    } catch (err) {
      logger.warn('[recurring-cof] payer check failed — exempting card capture (never risk enrolling the wrong party)', { error: err.message });
      return { enforced: true, required: false, exemptReason: 'payer_check_uncertain' };
    }

    // Already protected: enrolled AND a chargeable method in charge.
    try {
      const { customerOnAutopay } = require('./autopay-eligibility');
      const customer = await db('customers').where({ id: resolvedCustomerId }).first();
      if (customer && await customerOnAutopay(customer)) {
        return { enforced: true, required: false, exemptReason: 'autopay_already_active' };
      }
    } catch (err) {
      logger.warn('[recurring-cof] autopay-active check failed — card stays required', { error: err.message });
    }

    // Auto-satisfy (spec §3.2: existing customers with a saved card are
    // never re-asked): a saved CARD carrying an enrollment-qualifying v8+
    // consent skips capture, and the accept enrolls THAT method post-commit
    // (savedMethodRowId) — identical protection to a fresh capture. Lookup
    // failure keeps the card required (fail toward protection).
    try {
      const ConsentService = require('./payment-method-consents');
      const savedCard = await ConsentService.findConsentedChargeableCard(resolvedCustomerId);
      if (savedCard) {
        return {
          enforced: true,
          required: false,
          exemptReason: 'saved_method_consented',
          savedMethodRowId: savedCard.id,
        };
      }
    } catch (err) {
      logger.warn('[recurring-cof] saved-method check failed — card stays required', { error: err.message });
    }
  }

  return { enforced: true, required: true, exemptReason: null };
}

// Mint the SetupIntent that captures the Auto Pay card for a recurring accept.
// Deterministic idempotency key per (estimate, generation), so reopening the
// capture step within Stripe's idempotency window replays the SAME intent
// instead of stacking them; a succeeded replay short-circuits in the modal
// (retrieveSetupIntent → onSuccess). This module is stateless (no hold-row
// generation counter), so a TERMINAL-without-success replay (canceled — e.g.
// abandoned and swept) self-heals by walking the generation salt forward until
// Stripe returns a confirmable or succeeded intent (Codex #2668 P2: a fixed
// key would replay the dead intent for the whole idempotency window). Returns
// { clientSecret, setupIntentId } or null when Stripe isn't configured.
const MAX_SETUP_INTENT_GENERATIONS = 5;
async function createRecurringCardSetupIntentForEstimate(estimate) {
  for (let generation = 0; generation < MAX_SETUP_INTENT_GENERATIONS; generation += 1) {
    const setupIntent = await StripeService.createRecurringCardSetupIntent({ estimateId: estimate.id, generation });
    if (!setupIntent) return null;
    if (setupIntent.status === 'canceled') continue;
    return { clientSecret: setupIntent.client_secret, setupIntentId: setupIntent.id };
  }
  logger.error(`[recurring-cof] exhausted SetupIntent generations for estimate ${estimate.id} — all replays terminal`);
  return null;
}

// A live-retrieved SetupIntent counts only when Stripe says it succeeded, it
// carries a saved payment_method, AND its metadata pins it to THIS estimate
// as a recurring card-on-file capture (a one-time HOLD intent must never
// satisfy this gate — different consent, different semantics).
function recurringCardIntentMatchesEstimate(setupIntent, estimateId) {
  return !!setupIntent
    && setupIntent.status === 'succeeded'
    && setupIntent.metadata?.purpose === 'estimate_recurring_card'
    && String(setupIntent.metadata?.estimate_id) === String(estimateId)
    && !!setupIntent.payment_method;
}

// Accept GATE (pre-commit): live-verify the named SetupIntent WITHOUT writing.
// Trust is re-derived from Stripe, never the client. Stateless — the client
// echoes the id (or the 3DS redirect param restores it); there is no pending
// row to fall back on, and a lost id simply re-opens the capture modal, where
// the deterministic idempotency key replays the already-succeeded intent.
async function verifyRecurringCardIntent({ estimate, setupIntentId }) {
  if (!setupIntentId) return { ok: false, reason: 'no_setup_intent' };
  let setupIntent = null;
  try {
    setupIntent = await StripeService.retrieveSetupIntent(setupIntentId);
  } catch (err) {
    logger.warn('[recurring-cof] live SetupIntent verification failed', { error: err.message });
    return { ok: false, reason: 'verification_failed' };
  }
  if (!recurringCardIntentMatchesEstimate(setupIntent, estimate.id)) {
    return { ok: false, reason: 'intent_mismatch' };
  }
  const pm = setupIntent.payment_method;
  return {
    ok: true,
    paymentMethodId: typeof pm === 'string' ? pm : pm.id,
    setupIntentId: setupIntent.id,
  };
}

// Post-commit: attach the captured card + record consent + enroll in Auto Pay.
// Runs the same idempotent save → consent → enrollment sequence as the pay
// page's /setup-complete, so the enrollment semantics can't drift between
// save surfaces. Best-effort by design: the accept (and its verified deposit)
// stands either way — a failure here parks an exception for the office
// (hands-off, exception-based) instead of blocking the booking.
async function completeRecurringCardEnrollment({
  customerId,
  stripePaymentMethodId,
  setupIntentId,
  estimateId,
  ip = null,
  userAgent = null,
  // Visit scope for the enrollment's in-lock payer check (Codex #3395
  // r13 P1): the accept-path policy resolver admits self_pay_override
  // visits on payer-billed accounts — the enrollment must judge at the
  // same scope or it refuses on the account payer.
  scheduledServiceId = null,
  // 'prepay_card' for in-lane annual-prepay accepts: the capture UI rendered
  // the prepay authorization (immediate 12-month charge), so the recorded
  // snapshot must be that same variant.
  consentVariant = null,
}) {
  if (!customerId || !stripePaymentMethodId) return { enrolled: false, reason: 'missing_args' };
  try {
    // Idempotent save: stripe_payment_method_id is unique — a retry after a
    // partial first attempt must continue with the existing row.
    let saved = await db('payment_methods').where({ stripe_payment_method_id: stripePaymentMethodId }).first();
    if (saved && String(saved.customer_id) !== String(customerId)) {
      logger.warn(`[recurring-cof] pm ownership mismatch: pm ${stripePaymentMethodId} belongs to ${saved.customer_id}, accept customer ${customerId}`);
      await alertEnrollmentNeedsReview({ customerId, estimateId, reason: 'pm_ownership_mismatch' });
      return { enrolled: false, reason: 'pm_ownership_mismatch' };
    }
    if (!saved) {
      saved = await StripeService.savePaymentMethod(customerId, stripePaymentMethodId, {
        enableAutopay: false,
        // enrollConsentedMethod owns the default decision (claims it only
        // when no healthy method is already in charge).
        makeDefault: false,
      });
    }
    const ConsentService = require('./payment-method-consents');
    // ENROLLMENT-scoped check (Codex #2680 r6 P1): a hold-only
    // estimate_card_hold row on this pm passes the plain version check but
    // only ever authorized that visit's charges — the estimate_accept row
    // IS the audit artifact for recurring Auto Pay, so it must be recorded
    // unless a real save-and-charge consent already exists. A VARIANT
    // consent (prepay immediate charge) is checked against its own snapshot
    // (Codex r5 P1): an older future-invoice consent must not suppress the
    // immediate-charge authorization the prepay checkbox rendered.
    const consentAlreadyRecorded = consentVariant
      ? await ConsentService.hasConsentSnapshotForVariant(customerId, stripePaymentMethodId, { methodType: saved?.method_type || 'card', variant: consentVariant })
      : await ConsentService.hasEnrollmentScopedConsent(customerId, stripePaymentMethodId);
    if (!consentAlreadyRecorded) {
      // The capture modal rendered the locked v8 card consent verbatim
      // (checkbox-gated) before confirmSetup — this row is the faithful
      // record of what the customer agreed to.
      await ConsentService.recordConsent({
        customerId,
        paymentMethodId: saved?.id || null,
        stripePaymentMethodId,
        source: 'estimate_accept',
        methodType: saved?.method_type || 'card',
        ip,
        userAgent,
        consentVariant,
      });
    }
    if (saved?.id) {
      await ConsentService.linkPaymentMethodId(stripePaymentMethodId, saved.id);
    }
    const { enrollConsentedMethod } = require('./autopay-enrollment');
    const enrollment = await enrollConsentedMethod({
      customerId,
      paymentMethodId: saved?.id,
      source: 'estimate_accept',
      details: { via: 'recurring_card_on_file', estimate_id: estimateId, setup_intent_id: setupIntentId },
      scheduledServiceId,
    });
    if (!enrollment.enrolled && enrollment.reason !== 'already_enrolled') {
      logger.warn(`[recurring-cof] enrollment refused (${enrollment.reason}) for customer ${customerId} pm ${saved?.id}`);
      await alertEnrollmentNeedsReview({ customerId, estimateId, reason: enrollment.reason });
      return { enrolled: false, reason: enrollment.reason };
    }
    logger.info(`[recurring-cof] customer ${customerId} card saved + Auto Pay enrolled at accept (estimate ${estimateId})`);
    return { enrolled: true, paymentMethodRowId: saved?.id || null };
  } catch (err) {
    logger.error(`[recurring-cof] enrollment failed post-accept for customer ${customerId}: ${err.message}`);
    await alertEnrollmentNeedsReview({ customerId, estimateId, reason: err.message });
    // transient: a thrown error (Stripe/DB hiccup) is retryable — the
    // webhook backstop rethrows on it so Stripe's retry schedule re-runs
    // the idempotent enrollment; policy refusals above are not.
    return { enrolled: false, reason: err.message, transient: true };
  }
}

// Low-key office alert: the accept committed but the Auto Pay card didn't
// land — a human re-adds it (portal/admin) or calls the customer. Without
// this the gap would be silent until the first uncollected invoice.
async function alertEnrollmentNeedsReview({ customerId, estimateId, reason }) {
  try {
    await require('./notification-service').notifyAdmin(
      'billing',
      'Recurring accept: Auto Pay card not enrolled',
      `A recurring accept completed but the saved card could not be enrolled (${reason}) — re-add a payment method or the visits will invoice unprotected.`,
      { link: customerId ? `/admin/customers/${customerId}` : '/admin/dashboard', metadata: { customerId, estimateId, reason } },
    );
  } catch (e) { logger.warn('[recurring-cof] enrollment review alert failed', { error: e.message }); }
}

// In-lane prepay (GATE_PREPAY_CARD_AND_CHARGE): resolve which method the
// accept will charge, plus the funding needed to quote the EXACT surcharged
// total BEFORE the customer authorizes the charge. Sources, in the same
// precedence the enrollment paths use:
//   1. the live-verified SetupIntent's payment method (fresh capture — no
//      payment_methods row exists yet; funding comes from Stripe),
//   2. the policy's auto-satisfy saved method (savedMethodRowId),
//   3. the customer's active Auto Pay method (autopay_already_active —
//      pre-push Codex P0: these customers previously resolved NO method and
//      every such prepay accept skipped the charge).
// Returns { stripePaymentMethodId, paymentMethodRowId, methodType, funding,
// last4 } or null when no chargeable source resolves. Read-only; never
// throws (a resolution failure quotes/charges nothing — the pay-link
// fallback owns the miss).
async function resolvePrepayChargeMethod({ policy = {}, verification = null, customerId = null }) {
  try {
    if (verification?.ok && verification.paymentMethodId) {
      const pm = await StripeService.retrievePaymentMethod(verification.paymentMethodId);
      if (pm) {
        return {
          stripePaymentMethodId: pm.id,
          paymentMethodRowId: null, // saved at enrollment, post-commit
          methodType: pm.type || 'card',
          funding: pm.card?.funding || null,
          last4: pm.card?.last4 || null,
        };
      }
      return null;
    }
    let rowId = policy.savedMethodRowId || null;
    if (!rowId && policy.exemptReason === 'autopay_already_active' && customerId) {
      const customer = await db('customers').where({ id: customerId }).first('autopay_payment_method_id');
      rowId = customer?.autopay_payment_method_id || null;
    }
    if (!rowId) return null;
    const row = await db('payment_methods').where({ id: rowId }).first();
    if (!row || String(row.customer_id) !== String(customerId || row.customer_id) || !row.stripe_payment_method_id) return null;
    let funding = row.card_funding || null;
    if (row.method_type === 'card' && !funding) {
      const pm = await StripeService.retrievePaymentMethod(row.stripe_payment_method_id).catch(() => null);
      funding = pm?.card?.funding || null;
    }
    return {
      stripePaymentMethodId: row.stripe_payment_method_id,
      paymentMethodRowId: row.id,
      methodType: row.method_type || 'card',
      funding,
      last4: row.last_four || null,
    };
  } catch (err) {
    logger.warn(`[recurring-cof] prepay charge-method resolution failed: ${err.message}`);
    return null;
  }
}

// Opaque binding of a prepay charge quote to the method it was quoted for
// (pre-push Codex P0 r3): the client echoes this key with its
// acknowledgement, and the accept re-derives it from the CURRENT method —
// a default-method switch between quote and resubmit changes the key even
// when the total happens to match, forcing a fresh quote instead of
// charging a card the customer never saw. Truncated digest, never the raw
// Stripe id, so the public page learns nothing about the stored method.
function prepayChargeMethodKey(stripePaymentMethodId) {
  if (!stripePaymentMethodId) return null;
  return require('crypto').createHash('sha256').update(String(stripePaymentMethodId)).digest('hex').slice(0, 16);
}

// Crash-recovery sweep (pre-push Codex P0 r3): the accept transaction
// stamps a durable prepayAutoChargeJob (invoice, bound method, the exact
// acknowledged cents) BEFORE it commits; the in-flow executor resolves the
// stamp in the same request. A process restart in the commit→charge gap
// leaves the stamp 'pending' — this sweep (billing-cron) resumes it:
// re-charge under the FROZEN authorization (expectedTotal equality on the
// acknowledged cents, bound method row, live Auto Pay re-check in-lock —
// never a fresh eligibility guess), or, when the charge can't complete,
// deliver the pay link + office alert so an accepted prepay booking can
// never sit silently unpaid. Idempotent: the charge service's durable
// claim fences a concurrent in-flow executor, and every outcome resolves
// the stamp.
async function sweepStrandedPrepayAutoCharges({ olderThanMinutes = 15, claimStaleMinutes = 60, limit = 20 } = {}) {
  // The kill switch stops NEW quoting/charging, but committed jobs must
  // still drain (pre-push Codex P0 r6): with the gate off, a stranded
  // pending job resolves through pay-link delivery + an office alert
  // instead of a charge — never a silently unpaid accepted booking, which
  // is the exact incident this lane exists to prevent.
  const chargingOn = isPrepayCardAndChargeEnabled();
  const cutoff = new Date(Date.now() - olderThanMinutes * 60 * 1000);
  let rows = [];
  try {
    // 'pending' stamps are unstarted recoveries; a 'claimed' stamp older
    // than claimStaleMinutes is a recovery worker that died mid-flight —
    // safe to re-attempt because the charge service's durable attempt
    // claim (stripe_invoice_charge_attempts) fences any still-active or
    // ambiguous charge underneath it.
    // Age predicates live IN the query and selection is oldest-first
    // (Codex r9 P1): filtering fresh pending jobs only after the LIMIT let
    // a burst of new accepts fill every batch while older stranded jobs
    // were never selected. The in-lock re-checks below stay as the atomic
    // guard; missing timestamps coalesce to epoch (= old) exactly like the
    // in-lock logic treats them.
    rows = await db('estimates')
      .where({ status: 'accepted' })
      .whereRaw(
        "(((estimate_data)::jsonb -> 'prepayAutoChargeJob' ->> 'status' = 'pending'"
        + " AND COALESCE(((estimate_data)::jsonb -> 'prepayAutoChargeJob' ->> 'created_at')::timestamptz, 'epoch'::timestamptz) < now() - (? * interval '1 minute'))"
        + " OR ((estimate_data)::jsonb -> 'prepayAutoChargeJob' ->> 'status' = 'claimed'"
        + " AND COALESCE(((estimate_data)::jsonb -> 'prepayAutoChargeJob' ->> 'claimed_at')::timestamptz, 'epoch'::timestamptz) < now() - (? * interval '1 minute')))",
        [olderThanMinutes, claimStaleMinutes],
      )
      .orderByRaw("COALESCE(((estimate_data)::jsonb -> 'prepayAutoChargeJob' ->> 'created_at')::timestamptz, 'epoch'::timestamptz) asc")
      .limit(limit)
      .select('id', 'estimate_data');
  } catch (err) {
    logger.warn(`[recurring-cof] prepay charge sweep query failed: ${err.message}`);
    return { scanned: 0 };
  }
  let resumed = 0;
  for (const row of rows) {
    // ATOMIC per-estimate claim (pre-push Codex P0 r4): two pods selecting
    // the same stamp must not both proceed — the second would treat the
    // first's in-flight charge (STRIPE_CHARGE_IN_PROGRESS) as a failure and
    // open a pay-link rail beside a charge that may still settle. The
    // advisory xact lock serializes claimers; the re-read inside the lock
    // makes claim-if-still-pending atomic.
    let job = null;
    try {
      await db.transaction(async (trx) => {
        await trx.raw('SELECT pg_advisory_xact_lock(hashtextextended(?, 42))', [`prepay-job:${row.id}`]);
        const fresh = await trx('estimates').where({ id: row.id }).first('estimate_data');
        let base = fresh?.estimate_data;
        if (typeof base === 'string') { try { base = JSON.parse(base); } catch { base = null; } }
        const current = base?.prepayAutoChargeJob;
        if (!current || !current.invoice_id) return;
        const claimStale = current.status === 'claimed'
          && (!current.claimed_at || new Date(current.claimed_at) < new Date(Date.now() - claimStaleMinutes * 60 * 1000));
        if (current.status !== 'pending' && !claimStale) return; // another worker owns it / already resolved
        if (current.status === 'pending' && current.created_at && new Date(current.created_at) > cutoff) return; // in-flow executor may still be running
        const claim = { status: 'claimed', claimed_at: new Date().toISOString() };
        // Atomic JSON-path merge (pre-push Codex P0 r5): the advisory lock
        // serializes SWEEP workers only — other estimate writers (linkage
        // invalidation etc.) are not under it, so the update must touch
        // ONLY the job key, never rewrite the whole blob.
        await trx('estimates').where({ id: row.id }).update({
          estimate_data: trx.raw(
            "jsonb_set(estimate_data, '{prepayAutoChargeJob}', (estimate_data -> 'prepayAutoChargeJob') || ?::jsonb)",
            [JSON.stringify(claim)],
          ),
        });
        job = { ...current, ...claim };
      });
    } catch (claimErr) {
      logger.warn(`[recurring-cof] prepay sweep claim failed for estimate ${row.id}: ${claimErr.message}`);
      continue;
    }
    if (!job) continue;
    const resolve = async (status, extra = {}) => {
      try {
        // Atomic JSON-path merge — same rationale as the claim above.
        await db('estimates')
          .where({ id: row.id })
          .whereRaw("estimate_data -> 'prepayAutoChargeJob' IS NOT NULL")
          .update({
            estimate_data: db.raw(
              "jsonb_set(estimate_data, '{prepayAutoChargeJob}', (estimate_data -> 'prepayAutoChargeJob') || ?::jsonb)",
              [JSON.stringify({ status, resolved_at: new Date().toISOString(), resolved_by: 'sweep', ...extra })],
            ),
          });
      } catch (stampErr) {
        logger.warn(`[recurring-cof] prepay sweep stamp update failed for estimate ${row.id}: ${stampErr.message}`);
      }
    };
    const alertUncollected = async (title, body) => require('./notification-service').notifyAdmin(
      'billing', title, body,
      { link: '/admin/invoices', metadata: { estimateId: row.id, invoiceId: job.invoice_id } },
    ).catch(() => {});
    // Hoisted above the try so the catch's payer-guard handler (Codex r10
    // P0) can reach the invoice row and the shared payer-delivery helper.
    let invoice = null;
    let deliverToPayerAndResolve = async () => {};
    try {
      invoice = await db('invoices').where({ id: job.invoice_id }).first('id', 'status', 'customer_id', 'payer_id', 'payment_method');
      if (!invoice) { await resolve('skipped', { reason: 'invoice_missing' }); continue; }
      const invStatus = String(invoice.status || '').toLowerCase();
      // Terminal classification (pre-push Codex P1 r4): only paid/prepaid
      // means the year was collected; 'processing' is an initiated ACH
      // debit; refunded/canceled/void mean NO collected prepay — record the
      // real outcome and hand it to the office, never mark it paid.
      if (['paid', 'prepaid'].includes(invStatus)) { await resolve('paid', { reason: 'already_settled' }); continue; }
      if (invStatus === 'processing') {
        // 'processing' is ALSO how an ambiguous saved-card attempt parks an
        // invoice for reconciliation (pre-push Codex P0 r7) — that status
        // alone does not prove an initiated ACH debit. An unresolved
        // charge-attempt fence or orphan charge means reconciliation still
        // owns the outcome: leave the job claimed (retryable via the
        // stale-claim lease) so a reconciliation that reopens the invoice
        // gets re-swept instead of stranding an unpaid accepted plan.
        let reconciliationPending = false;
        try {
          const fence = await db('stripe_invoice_charge_attempts')
            .where({ invoice_id: invoice.id })
            .whereIn('status', ['claimed', 'ambiguous'])
            .whereNull('resolved_at')
            .first('id');
          const orphan = fence ? null : await db('stripe_orphan_charges')
            .where({ invoice_id: invoice.id, resolved: false })
            .first('id');
          reconciliationPending = !!(fence || orphan);
        } catch (fenceErr) {
          // Unknown fence state — err toward retryable, never retire.
          logger.warn(`[recurring-cof] prepay sweep fence check failed for invoice ${invoice.id}: ${fenceErr.message}`);
          reconciliationPending = true;
        }
        if (reconciliationPending) {
          logger.info(`[recurring-cof] prepay sweep deferring estimate ${row.id}: invoice ${invoice.id} processing with reconciliation pending`);
          continue;
        }
        // Bank tender only (Codex r9 P0): the charge service stamps every
        // non-succeeded PaymentIntent as 'processing' — a CARD intent
        // parked mid-flight is NOT an initiated collection and must stay
        // unresolved (the lease retries after the intent settles or dies),
        // never retired as if the money were moving.
        if (String(invoice.payment_method || '') !== 'us_bank_account') {
          logger.warn(`[recurring-cof] prepay sweep deferring estimate ${row.id}: invoice ${invoice.id} processing on a non-bank tender (incomplete card intent)`);
          continue;
        }
        await resolve('processing', { reason: 'already_initiated' });
        continue;
      }
      if (['refunded', 'canceled', 'cancelled', 'void', 'voided'].includes(invStatus)) {
        await resolve('skipped', { reason: `invoice_${invStatus}` });
        await alertUncollected(
          'Annual prepay accept — invoice terminal without collection',
          `The accepted prepay invoice is ${invStatus}; the authorized auto-charge never collected the year. Review the account and re-bill if the plan stands.`,
        );
        continue;
      }
      // Payer-billed recovery must still DELIVER the invoice (Codex r9
      // P0): the in-request path reopens payer delivery when it skips the
      // charge, but a crash before that leaves this sweep as the only
      // collection path — retiring the job without a confirmed send
      // would strand an accepted annual plan unpaid with no recovery.
      // sendViaSMSAndEmail routes payer-billed invoices to the payer AP
      // inbox; resolve only on a confirmed {ok} delivery, else the
      // stale-claim lease retries. Shared with the in-charge payer-guard
      // refusal below (Codex r10 P0).
      deliverToPayerAndResolve = async () => {
        let payerDelivered = false;
        try {
          const delivery = await require('./invoice').sendViaSMSAndEmail(job.invoice_id);
          payerDelivered = !!delivery?.ok;
        } catch (sendErr) {
          logger.error(`[recurring-cof] prepay sweep payer delivery failed for invoice ${job.invoice_id}: ${sendErr.message}`);
        }
        await alertUncollected(
          'Annual prepay accepted — invoice routes to a third-party payer',
          `The accepted prepay booking is payer-billed, so no card was charged. ${payerDelivered
            ? 'The invoice was delivered to the payer — follow up if it goes unpaid.'
            : 'Payer invoice delivery FAILED — the sweep will retry; the payer currently has no copy.'}`,
        );
        if (payerDelivered) await resolve('skipped', { reason: 'payer_billed', delivered: true });
      };
      if (invoice.payer_id) {
        await deliverToPayerAndResolve();
        continue;
      }
      // Reproduce the promised inspection credit BEFORE any recovery path
      // (Codex r9 P0): the acknowledged quote projected the redeemable
      // offer, but in-flow redemption runs post-commit — a crash in the
      // gap leaves the offer unredeemed, so both the frozen-total charge
      // (expectedTotal mismatch → decline) and the fallback pay link
      // (delivers the GROSS invoice) would collect more than the customer
      // acknowledged. Redemption is idempotent (open offers only) and a
      // clean no-offer result is the normal case; an ERROR leaves the
      // credit state unknown — defer (stamp stays claimed, stale-claim
      // lease retries) rather than recover at a possibly-wrong amount.
      if (job.scheduled_service_id) {
        // The service reports most failures via { redeemed: 0, reason }
        // rather than throwing (Codex r9 P0) — an INCONCLUSIVE reason
        // (lookup/evidence/db failure) leaves the credit's fate unknown, so
        // defer exactly like a thrown error; a redeemed>0 or conclusive
        // no-offer result lets the frozen-total charge (and its equality
        // guard) proceed honestly.
        const INCONCLUSIVE_REDEMPTION = ['booking_lookup_failed', 'booking_event_lookup_failed', 'no_booking_evidence', 'error'];
        let redemption = null;
        try {
          redemption = await require('./inspection-credit').redeemInspectionCreditForBooking({
            customerId: invoice.customer_id,
            scheduledServiceId: job.scheduled_service_id,
            createdBy: 'system:inspection_credit_prepay_recovery',
          });
        } catch (redeemErr) {
          redemption = { redeemed: 0, reason: 'error', error: redeemErr.message };
        }
        const redeemedOk = !!redemption && Number(redemption.redeemed) > 0;
        if (!redemption || (!redeemedOk && INCONCLUSIVE_REDEMPTION.includes(redemption.reason))) {
          logger.warn(`[recurring-cof] prepay sweep deferring estimate ${row.id}: inspection-credit redemption inconclusive (${redemption?.reason || 'no result'}${redemption?.error ? `: ${redemption.error}` : ''})`);
          continue;
        }
      }
      if (!chargingOn) throw new Error('gate_disabled — charging suppressed, resolving via pay link');
      let pmRow = job.payment_method_row_id
        ? await db('payment_methods').where({ id: job.payment_method_row_id }).first('id', 'customer_id', 'stripe_payment_method_id')
        : await db('payment_methods').where({ stripe_payment_method_id: job.stripe_payment_method_id }).first('id', 'customer_id', 'stripe_payment_method_id');
      // Fresh capture that crashed BEFORE enrollment (pre-push Codex P1
      // r6): no payment_methods row exists yet, and the setup_intent
      // webhook backstop skips accepted prepay terms — idempotently
      // complete the save → prepay consent → enrollment here from the
      // job's persisted SetupIntent context, then charge the enrolled row.
      if (!pmRow && job.setup_intent_id && job.stripe_payment_method_id) {
        const enrollment = await completeRecurringCardEnrollment({
          customerId: invoice.customer_id,
          stripePaymentMethodId: job.stripe_payment_method_id,
          setupIntentId: job.setup_intent_id,
          estimateId: row.id,
          consentVariant: 'prepay_card',
        });
        if (enrollment?.paymentMethodRowId) {
          pmRow = await db('payment_methods').where({ id: enrollment.paymentMethodRowId }).first('id', 'customer_id', 'stripe_payment_method_id');
        }
      }
      // The BOUND method only — a different row (method swapped/removed)
      // was never quoted to the customer.
      if (pmRow && (String(pmRow.customer_id) !== String(invoice.customer_id)
        || (job.stripe_payment_method_id && pmRow.stripe_payment_method_id !== job.stripe_payment_method_id))) {
        pmRow = null;
      }
      // ZERO acknowledged cents is a legitimate authorization (Codex r9
      // P0): projected credit fully covered the quote — the charge call
      // with expectedTotal 0 applies the credit in-lock and settles the
      // invoice 'prepaid' with no card charge; rejecting it here would
      // route a fully-covered accept to a pay link instead.
      if (pmRow && Number.isInteger(job.authorized_total_cents) && job.authorized_total_cents >= 0) {
        await StripeService.chargeInvoiceWithSavedCard(invoice.id, pmRow.id, {
          expectedTotal: Number(job.authorized_total_cents) / 100,
          maxAuthorizedTotalCents: Number(job.authorized_total_cents),
          requireAutopayForCustomerId: invoice.customer_id,
          // Live payer re-resolve IN the charge lock (Codex r9): the
          // payer_id check above is a snapshot, and a delayed recovery is
          // exactly when billing may have assigned a customer-DEFAULT
          // payer while the invoice's payer_id stayed null — re-resolve
          // under the lock and refuse rather than charge the homeowner's
          // card for a bill that now routes to a third-party payer.
          requireSelfPayCustomerId: invoice.customer_id,
        });
        const freshInvoice = await db('invoices').where({ id: invoice.id }).first('status', 'payment_method');
        const freshStatus = String(freshInvoice?.status || '').toLowerCase();
        if (['paid', 'prepaid'].includes(freshStatus)) { resumed += 1; await resolve('paid'); continue; }
        // Same bank-tender guard as the pre-charge classification (Codex
        // r9 P0): only a confirmed bank debit resolves as 'processing'; a
        // card intent stamped 'processing' stays unresolved for the lease.
        if (freshStatus === 'processing' && String(freshInvoice?.payment_method || '') === 'us_bank_account') { resumed += 1; await resolve('processing'); continue; }
        if (freshStatus === 'processing') {
          logger.warn(`[recurring-cof] prepay sweep leaving estimate ${row.id} claimed: post-charge invoice ${invoice.id} processing on a non-bank tender`);
          continue;
        }
        throw new Error(`post-charge status ${freshStatus || 'unknown'}`);
      }
      throw new Error(pmRow ? 'no authorized total on job' : 'bound method not found');
    } catch (err) {
      // An ACTIVE or AMBIGUOUS charge attempt means money may already be
      // moving — NEVER open the pay-link rail beside it (pre-push Codex P0
      // r4). Leave the stamp claimed; the next sweep pass re-reads the
      // invoice after the attempt/reconciliation resolves.
      if (['STRIPE_CHARGE_IN_PROGRESS', 'STRIPE_AMBIGUOUS_OUTCOME', 'STRIPE_CHARGED_DB_FAILED'].includes(err.code) || err.reconciliationRequired) {
        logger.warn(`[recurring-cof] prepay sweep deferring estimate ${row.id} invoice ${job.invoice_id}: ${err.code || 'reconciliation pending'}`);
        continue;
      }
      // In-lock payer-guard refusal (Codex r10 P0): a payer was assigned
      // AFTER the mint while the invoice's frozen payer_id is still null.
      // Falling through to the generic fallback would hand the HOMEOWNER a
      // pay link for the payer's bill — instead re-resolve, STAMP the live
      // payer onto the invoice, and route through confirmed payer
      // delivery; if the payer can't be confirmed, defer (claimed, lease
      // retries) with no delivery at all.
      if (err.code === 'PAYER_BILLED_GUARD') {
        let payerStamped = false;
        try {
          const invoiceRow = await db('invoices').where({ id: job.invoice_id }).first('payer_id', 'scheduled_service_id');
          if (invoiceRow?.payer_id) {
            payerStamped = true; // another writer already stamped it
          } else {
            const resolved = await require('./payer').resolveForInvoice({
              customerId: invoice?.customer_id,
              scheduledServiceId: invoiceRow?.scheduled_service_id || null,
              throwOnError: true,
            });
            if (resolved?.payerId) {
              await db('invoices').where({ id: job.invoice_id }).whereNull('payer_id').update({
                payer_id: resolved.payerId,
                ...(resolved.poNumber ? { po_number: resolved.poNumber } : {}),
                ...(resolved.snapshot ? { payer_snapshot: JSON.stringify(resolved.snapshot) } : {}),
              });
              payerStamped = true;
            }
          }
        } catch (payerErr) {
          logger.warn(`[recurring-cof] prepay sweep payer re-stamp failed for invoice ${job.invoice_id}: ${payerErr.message}`);
        }
        if (payerStamped) {
          await deliverToPayerAndResolve();
        } else {
          logger.warn(`[recurring-cof] prepay sweep deferring estimate ${row.id}: payer guard refused the charge but the payer could not be confirmed`);
        }
        continue;
      }
      // A DETERMINISTIC failure (decline, guard refusal, missing method) —
      // no funds moved; fall back to the delivered pay link + office alert
      // (never silent, never a different amount/method than quoted).
      logger.warn(`[recurring-cof] prepay sweep charge failed for estimate ${row.id} invoice ${job.invoice_id}: ${err.message}`);
      let fallbackDelivered = false;
      try {
        const delivery = await require('./invoice').sendViaSMSAndEmail(job.invoice_id);
        fallbackDelivered = !!delivery?.ok;
      } catch (sendErr) {
        logger.error(`[recurring-cof] prepay sweep pay-link delivery failed for invoice ${job.invoice_id}: ${sendErr.message}`);
      }
      await alertUncollected(
        'Annual prepay accepted — stranded auto-charge could not complete',
        `The accept committed but the prepay auto-charge was interrupted and the recovery charge failed (${err.message}). ${fallbackDelivered
          ? 'The pay link was sent — follow up if it goes unpaid.'
          : 'Pay-link delivery ALSO failed — the customer currently has no payment path; the sweep will retry.'}`,
      );
      // Resolve only on CONFIRMED delivery (pre-push Codex P1 r7): a
      // no-channel {ok:false} send must leave the job retryable (the
      // stale-claim lease re-attempts) instead of retiring it with no
      // collection path at all.
      if (fallbackDelivered) {
        await resolve('delivered_fallback', { reason: err.message });
      }
    }
  }
  return { scanned: rows.length, resumed };
}

module.exports = {
  isRecurringCardOnFileEnabled,
  isPrepayCardAndChargeEnabled,
  resolveRecurringCardPolicyForEstimate,
  resolvePrepayChargeMethod,
  prepayChargeMethodKey,
  sweepStrandedPrepayAutoCharges,
  createRecurringCardSetupIntentForEstimate,
  verifyRecurringCardIntent,
  completeRecurringCardEnrollment,
  _private: {
    recurringCardIntentMatchesEstimate,
  },
};
