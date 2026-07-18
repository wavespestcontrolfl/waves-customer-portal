/**
 * Estimator Engine — orchestrator.
 *
 * Call transcript + SMS thread + profile + property data → composed estimate
 * intent → deterministic pricing → DRAFT estimate in one of three lanes
 * (green / yellow / red). Triggered from the call-recording processor on
 * quote-flavored calls behind GATE_ESTIMATOR_ENGINE (default OFF). The
 * engine posts exactly ONE admin notification per call — a draft-ready
 * notice, or the classic "quote promised — send it" fallback when it can't
 * draft — replacing (not duplicating) the generic quote-promised bells,
 * which are gated off while this engine is on.
 *
 * HARD RULES
 *   - The LLM composes intent only; the pricing engine owns every dollar.
 *   - Drafts only. Sending stays with the operator, always.
 *   - Fail-open: any engine failure degrades to the fallback notification —
 *     a processing error must never eat the quote promise.
 *
 * Kill switch: unset/false GATE_ESTIMATOR_ENGINE. Model override:
 * ESTIMATOR_ENGINE_MODEL (defaults to the DEEP tier).
 */

const db = require('../../models/db');
const logger = require('../logger');
const { buildCallContext, existingDraftForCall } = require('./context-builder');
const { resolvePropertyFacts, normalizeParcelView } = require('./source-arbitration');
const { composeIntent } = require('./intent-composer');
const {
  LANES,
  buildEngineInput,
  deriveTotals,
  compsBand,
  calibrationWarnings,
  classifyLane,
  createDraftEstimate,
} = require('./draft-builder');

function estimatorEngineEnabled() {
  const flag = process.env.GATE_ESTIMATOR_ENGINE;
  return flag === '1' || flag === 'true' || flag === 'on';
}

function addressFromContext(context) {
  const sa = context.extraction?.property?.service_address;
  if (sa?.street_line_1) {
    // Street-only extractions (city/ZIP nullable in the schema) borrow
    // locality — a bare street would geocode ambiguously. But when the
    // extraction supplies its OWN city (possibly a different property than
    // the profile), never graft another record's ZIP onto it — a mixed
    // "Sarasota, FL 34209" locates the wrong parcel. Borrow order: THIS
    // call's lead first (a second-property quote carries its locality on the
    // current lead, not the home on file), then the trusted profile.
    const trusted = (!context.customerPhoneAmbiguous && context.customer) || null;
    if (sa.city || sa.postal_code) {
      return [sa.street_line_1, sa.city, [sa.state || 'FL', sa.postal_code].filter(Boolean).join(' ')]
        .filter(Boolean).join(', ');
    }
    const currentLead = context.leadIsForThisCall ? context.lead : null;
    // City and ZIP must come from the SAME record — borrowing a city from
    // one source and a ZIP from another can compose a locality that exists
    // nowhere ("other property's city, this property's ZIP") and geocode the
    // wrong parcel. Take the first source that has any locality and use only
    // its fields.
    const locality = [currentLead, trusted, context.lead]
      .find((src) => src && (src.city || src.zip)) || null;
    const city = locality?.city || null;
    const zip = locality?.zip || null;
    const stateZip = [city || zip ? 'FL' : null, zip].filter(Boolean).join(' ');
    return [sa.street_line_1, city, stateZip].filter(Boolean).join(', ');
  }
  const leadAddress = context.lead?.address
    ? [context.lead.address, context.lead.city, context.lead.zip].filter(Boolean).join(', ')
    : null;
  // An AMBIGUOUS shared-phone match must not supply the service address —
  // pricing rows[0]'s saved home when the call itself established no address
  // drafts the wrong property. No address → red lane, correctly.
  const customerAddress = (context.customer?.address_line1 && !context.customerPhoneAmbiguous)
    ? [context.customer.address_line1, context.customer.city, [context.customer.state, context.customer.zip].filter(Boolean).join(' ')]
      .filter(Boolean).join(', ')
    : null;
  // THIS call's lead (sid-matched / touched by this call's processing)
  // outranks the saved profile — an existing customer asking about a second
  // or rental property has that address on the current lead, not the home
  // on file. Only STALE phone-history leads yield to the profile.
  if (context.leadIsForThisCall && leadAddress) return leadAddress;
  if (context.isExistingCustomer) return customerAddress || leadAddress;
  return leadAddress || customerAddress;
}

function commercialHint(context) {
  const propType = String(context.extraction?.property?.property_type || '').toLowerCase();
  return propType === 'commercial' || context.lead?.is_commercial === true;
}

const { sameStreetAddress, addressAddsLocality } = require('./address-compare');

// Property lookup + (when the county roll is unassessed) the
// subdivision-median dig. Both fail-open.
async function gatherPropertySignals(context, { refreshLookup = false, persistLookup = true } = {}) {
  const address = addressFromContext(context);
  let propertyRecord = null;
  let enriched = null;
  if (address) {
    try {
      const { performPropertyLookup } = require('../../routes/property-lookup-v2');
      const lookup = await performPropertyLookup(address, {
        ...(refreshLookup ? { refresh: true } : {}),
        // dryRun replays are documented read-only — no cache rows behind.
        ...(persistLookup ? {} : { persist: false }),
      });
      propertyRecord = lookup?.propertyRecord || null;
      // The normalized profile carries the pricing feature modifiers the raw
      // record doesn't (pool/cage, shrub density, landscape complexity,
      // water adjacency) — dropping it priced known features as absent.
      enriched = lookup?.enriched || null;
    } catch (err) {
      logger.warn(`[estimator-engine] property lookup failed (continuing without): ${err.message}`);
    }
  }

  const parcelView = normalizeParcelView(propertyRecord);

  let subdivisionMedian = null;
  if (parcelView?.unassessedVacant && parcelView.subdivision && parcelView.county) {
    try {
      const { lookupSubdivisionMedianLivingSqft } = require('../property-lookup/county-parcel-gis');
      subdivisionMedian = await lookupSubdivisionMedianLivingSqft({
        county: parcelView.county,
        subdivision: parcelView.subdivision,
      });
    } catch (err) {
      logger.warn(`[estimator-engine] subdivision median failed (continuing without): ${err.message}`);
    }
  }

  return { address, propertyRecord, enriched, parcelView, subdivisionMedian };
}

// One-bell + durability: for PROMISED quotes the processor's generic
// synchronous bell is the durable guarantee (this engine runs as a floating
// promise — a restart mid-draft must not lose the owed-quote task). The
// engine therefore UPGRADES that existing bell in place (title/body/link)
// instead of adding a second one; when no bell exists (request-only calls,
// or the generic path failed) it inserts fresh. Re-runs dedupe on the
// estimator_engine marker.
async function notify({ call, context, title, body, lane, estimateId = null, quotePromised = true, threadKey = null }) {
  const callSid = call?.twilio_call_sid ? String(call.twilio_call_sid) : null;
  const link = estimateId
    ? '/admin/estimates'
    : (context?.lead?.id ? `/admin/leads?lead=${context.lead.id}` : '/admin/communications');
  const metadata = {
    callSid,
    ...(threadKey ? { smsThreadKey: threadKey } : {}),
    estimator_engine: true,
    // Only a real agent commitment counts as an owed quote — a mere pricing
    // question must not create a false "send it" task.
    quote_promised: quotePromised === true,
    lane: lane || null,
    estimateId,
  };
  // SMS-origin bells dedupe on the phone-scoped thread key the way call
  // bells dedupe on callSid — repeated quote-flavored texts upgrade ONE
  // bell instead of ringing per message. Unlike a callSid, the thread key
  // is permanent for the phone, so its dedupe is TIME-BOUNDED to the open
  // life of an estimate: an independent quote request months later must
  // mint a fresh bell, not vanish behind a long-read one.
  const SMS_BELL_DEDUPE_MS = 7 * 86400000;
  const dedupe = callSid
    ? { clause: "metadata->>'callSid' = ?", value: callSid, since: null }
    : (threadKey
      ? { clause: "metadata->>'smsThreadKey' = ?", value: threadKey, since: new Date(Date.now() - SMS_BELL_DEDUPE_MS) }
      : null);
  // Returns true only when a bell durably exists for this event (fresh
  // insert, in-place upgrade, or a standing prior bell) — callers that
  // treat the bell as their restart-loss artifact must know it landed.
  try {
    if (dedupe) {
      // Any prior bell for this call counts: the generic promised bell OR a
      // prior estimator bell (request-only bells carry quote_promised=false
      // but still have the estimator_engine marker — matching only promised
      // bells would duplicate on every reprocess).
      let existingQuery = db('notifications')
        .whereRaw(dedupe.clause, [dedupe.value])
        .whereRaw("(metadata->>'quote_promised' = 'true' OR metadata->>'estimator_engine' = 'true')")
        .orderBy('created_at', 'desc');
      if (dedupe.since) existingQuery = existingQuery.where('created_at', '>=', dedupe.since);
      const existing = await existingQuery.first();
      if (existing) {
        let existingMeta = {};
        try {
          existingMeta = typeof existing.metadata === 'string' ? JSON.parse(existing.metadata) : (existing.metadata || {});
        } catch { existingMeta = {}; }
        // A prior estimator bell stands UNLESS this call now has a draft the
        // old bell doesn't know about (transient red → later success): the
        // stale "send it manually" text must upgrade to the draft link.
        if (existingMeta.estimator_engine === true && (!estimateId || existingMeta.estimateId)) return true;
        await db('notifications')
          .where({ id: existing.id })
          .update({
            title,
            body,
            link,
            metadata: JSON.stringify({ ...existingMeta, ...metadata }),
            // The content changed materially — an already-read bell must
            // come back unread or the upgrade is invisible.
            read_at: null,
          });
        return true;
      }
    }
    await require('../notification-service').notifyAdmin('lead', title, body, { link, metadata });
    return true;
  } catch (err) {
    logger.warn(`[estimator-engine] admin notify failed: ${err.message}`);
    return false;
  }
}

function callerLabel(intent, context) {
  return intent?.customer_name
    || [context?.lead?.first_name, context?.lead?.last_name].filter(Boolean).join(' ')
    || [context?.customer?.first_name, context?.customer?.last_name].filter(Boolean).join(' ')
    || 'Unknown caller';
}

// Origin descriptor for the call channel. The strings are byte-identical to
// the pre-refactor call-only pipeline — the refactor into runDraftPipeline
// must not change one character of the live call bells.
const CALL_ORIGIN = {
  channel: 'call',
  noun: 'call',
  threadKey: null,
  strings: {
    redTitle: 'Quote promised on call — send it',
    redBody: (label, reasons) => `${label}: quote promised, no auto-draft (${reasons}). Send it manually before end of day.`,
    composerFailBody: (label) => `${label}: a quote was promised but the estimator engine could not compose a draft. Send it manually before end of day.`,
    errorBody: 'A quote was promised on a call but the estimator engine hit an error. Send the estimate manually before end of day.',
    blockedTitle: 'Quote promised on call — estimate already open',
    blockedBody: (label) => `${label}: quote promised on a new call, but an automated estimate is already open for this phone number. Review and send the existing one.`,
  },
};

/**
 * Main entry. Non-throwing by contract: every path resolves to a result
 * object; failures degrade to the red-lane fallback notification.
 *
 * @param {object} args
 *   callLogId     — call_log.id (uuid)
 *   dryRun        — replay/test mode: full pipeline, NO draft row, NO
 *                   notification, returns complete diagnostics.
 *   refreshLookup — force a live property lookup past the cache (replay use).
 *   quotePromised — the agent COMMITTED to send a quote (vs a mere pricing
 *                   question). Red-lane fallbacks only notify when true — a
 *                   request-only call that can't draft must not mint a false
 *                   owed-quote task.
 */
async function maybeDraftEstimateForCall({ callLogId, dryRun = false, refreshLookup = false, quotePromised = true }) {
  const result = { callLogId, dryRun, lane: null, created: false };
  let context = null;
  try {
    context = await buildCallContext(callLogId);
    if (context.error) {
      result.lane = LANES.RED;
      result.reasons = [context.error];
      if (!dryRun && context.call && quotePromised) {
        await notify({
          call: context.call,
          context,
          lane: LANES.RED,
          quotePromised,
          title: 'Quote promised on call — send it',
          body: 'A quote was promised on a call the estimator engine could not read '
            + `(${context.error}). Review the call and send the estimate manually.`,
        });
      }
      return result;
    }

    if (!dryRun) {
      const existing = await existingDraftForCall(callLogId);
      if (existing) {
        result.lane = 'existing';
        result.reasons = ['draft already exists for this call'];
        result.estimateId = existing.id;
        // A prior run can have created the draft but failed to notify — with
        // the generic quote-promised bells suppressed behind the gate, that
        // would leave a silent draft forever. notify() dedupes internally,
        // so this is a no-op when the bell already rang.
        const existingLane = (() => {
          try {
            const data = typeof existing.estimate_data === 'string'
              ? JSON.parse(existing.estimate_data) : existing.estimate_data;
            return data?.estimatorEngine?.lane || 'yellow';
          } catch { return 'yellow'; }
        })();
        await notify({
          call: context.call,
          context,
          lane: existingLane,
          quotePromised,
          estimateId: existing.id,
          title: `AI estimate draft ${existingLane === 'green' ? 'ready' : 'needs review'} — $${existing.monthly_total || 0}/mo`,
          body: `${callerLabel(null, context)}: an estimate draft from this call is waiting (${String(existingLane).toUpperCase()}). Review in admin/estimates and send.`,
        });
        return result;
      }
    }
  } catch (err) {
    logger.error(`[estimator-engine] unexpected failure: ${err.message}`);
    result.lane = LANES.RED;
    result.reasons = [`engine error: ${err.message}`];
    if (!dryRun && context?.call && quotePromised) {
      await notify({
        call: context.call,
        context,
        lane: LANES.RED,
        quotePromised,
        title: CALL_ORIGIN.strings.redTitle,
        body: CALL_ORIGIN.strings.errorBody,
      });
    }
    return result;
  }
  return runDraftPipeline({ context, origin: CALL_ORIGIN, result, dryRun, refreshLookup, quotePromised });
}

/**
 * Channel-agnostic draft pipeline: property signals → composed intent →
 * deterministic pricing → lane classification → draft + one bell. `origin`
 * carries the channel's dedupe key and notification strings — the call
 * origin's strings are byte-identical to the pre-refactor call pipeline.
 * Non-throwing: same red-lane degradation contract as the entries above it.
 */
async function runDraftPipeline({ context, origin, result, dryRun = false, refreshLookup = false, quotePromised = true }) {
  const S = origin.strings;
  const threadKey = origin.threadKey || null;
  try {
    const { address, propertyRecord, enriched, parcelView, subdivisionMedian } = await gatherPropertySignals(context, { refreshLookup, persistLookup: !dryRun });
    result.addressUsed = address;

    // An ambiguous shared-phone profile must not size the draft either —
    // its saved sqft/lot describe SOMEBODY's home on this number, not
    // verifiably the caller's.
    const trustedCustomer = context.customerPhoneAmbiguous ? null : context.customer;

    let propertyFacts = resolvePropertyFacts({
      extraction: context.extraction,
      propertyRecord,
      parcelView,
      customer: trustedCustomer,
      isCommercial: commercialHint(context),
      subdivisionMedian,
    });

    const composed = await composeIntent(context, propertyFacts);
    if (!composed.intent) {
      result.lane = LANES.RED;
      result.reasons = [`composer failed schema validation: ${(composed.errors || []).join('; ')}`];
      if (!dryRun && quotePromised) {
        await notify({
          call: context.call,
          context,
          lane: LANES.RED,
          quotePromised,
          threadKey,
          title: S.redTitle,
          body: S.composerFailBody(callerLabel(null, context)),
        });
      }
      return result;
    }
    const { intent, model } = composed;
    result.intent = intent;

    // The composer establishes the FINAL service address (spelled-out
    // corrections, quote-for-a-different-property, transcript-only addresses
    // the extraction missed). When it differs from — or fills in — the
    // address the property signals were gathered for, re-gather; otherwise
    // the draft is priced off the wrong (or no) parcel.
    let effectiveSignals = { propertyRecord, enriched, parcelView, subdivisionMedian };
    let addressRegathered = false;
    if (intent.address
      && (!address || !sameStreetAddress(intent.address, address) || addressAddsLocality(intent.address, address))) {
      logger.info('[estimator-engine] composer-final address differs from gathered address — re-gathering property signals');
      const regathered = await gatherPropertySignals(
        { ...context, extraction: null, lead: { address: intent.address }, customer: null },
        { refreshLookup, persistLookup: !dryRun },
      );
      effectiveSignals = regathered;
      addressRegathered = true;
      result.addressUsed = regathered.address;
    }

    // The composer may also reclassify commercial vs the pre-intent hint —
    // the tenant/building arbitration rules depend on it. Re-run (pure) off
    // the effective signals either way to keep one code path.
    // The matched profile's saved measurements (lot_sqft; property_sqft is
    // turf) may ONLY backfill when the profile's saved address street-matches
    // the property actually being quoted — an extraction/lead-supplied
    // different address never re-gathers, so absence-of-regather is not
    // proof; second-property quotes must not inherit the home on file.
    const quotedAddress = intent.address || result.addressUsed || address;
    const customerSavedAddress = trustedCustomer?.address_line1
      ? [trustedCustomer.address_line1, trustedCustomer.city, trustedCustomer.zip].filter(Boolean).join(', ')
      : null;
    const profileDescribesQuotedProperty = !addressRegathered
      && !!(customerSavedAddress && quotedAddress && sameStreetAddress(customerSavedAddress, quotedAddress));

    propertyFacts = resolvePropertyFacts({
      // Caller-stated facts (extraction) describe the property discussed on
      // THIS call — they stay.
      extraction: context.extraction,
      propertyRecord: effectiveSignals.propertyRecord,
      parcelView: effectiveSignals.parcelView,
      customer: profileDescribesQuotedProperty ? trustedCustomer : null,
      isCommercial: intent.is_commercial,
      subdivisionMedian: effectiveSignals.subdivisionMedian,
    });
    result.propertyFacts = propertyFacts;

    // Existing-customer pricing context: qualifying services for the combined
    // WaveGuard tier (the snapshot itself is computed AFTER pricing — it
    // derives the NEW services from the priced line items). Fail-open.
    let priorQualifyingServices = [];
    if (context.isExistingCustomer && context.customer?.id) {
      try {
        const { loadExistingQualifyingServiceKeys } = require('../waveguard-existing-services');
        priorQualifyingServices = await loadExistingQualifyingServiceKeys(db, context.customer.id) || [];
      } catch (err) {
        logger.warn(`[estimator-engine] prior qualifying services load failed: ${err.message}`);
      }
    }

    let engineResult = null;
    let engineInput = null;
    let totals = { monthly: 0, annual: 0, oneTime: 0 };
    if (intent.decision === 'draft' && Object.keys(intent.services || {}).length) {
      engineInput = buildEngineInput({
        intent,
        propertyFacts,
        context,
        priorQualifyingServices,
        profileDescribesQuotedProperty,
        // Feature modifiers resolved by the lookup of the QUOTED address
        // (effectiveSignals tracks the re-gather) — pool/cage, landscaping,
        // water adjacency feed real pricing adjustments.
        lookupEnriched: effectiveSignals.enriched,
      });
      try {
        engineResult = generateEstimateSafely(engineInput);
        totals = deriveTotals(engineResult);
      } catch (err) {
        logger.error(`[estimator-engine] pricing engine failed: ${err.message}`);
        engineResult = null;
      }
    }
    result.engineInput = engineInput;
    result.totals = totals;

    // Membership snapshot AFTER pricing: computeMembershipContext derives the
    // NEW qualifying services from the priced line items — computed before
    // pricing it saw newKeys=[] and understated the combined tier.
    let membershipSnapshot = null;
    if (context.isExistingCustomer && context.customer?.id && engineResult) {
      try {
        const { computeMembershipContext } = require('../estimate-membership-context');
        membershipSnapshot = await computeMembershipContext(db, {
          customerId: context.customer.id,
          estData: { lineItems: engineResult.lineItems || [] },
        });
      } catch (err) {
        logger.warn(`[estimator-engine] membership context load failed: ${err.message}`);
      }
    }

    const comps = engineResult
      ? await compsBand({
        serviceInterestLabel: intent.service_interest_label,
        category: intent.category,
        monthlyTotal: totals.monthly,
        serviceKeys: Object.keys(intent.services || {}),
      })
      : null;
    const calibration = engineResult ? await calibrationWarnings(engineResult) : [];
    result.comps = comps;
    result.calibration = calibration;

    // classifyLane owns skip / no-services / no-address messaging; the bare
    // engine-failure fallback applies ONLY when a draftable intent existed
    // and generateEstimate itself threw — otherwise a composer skip would be
    // misreported as a fake engine failure.
    const draftable = intent.decision === 'draft'
      && Object.keys(intent.services || {}).length > 0
      && !!intent.address;
    const { lane, reasons } = (engineResult || !draftable)
      ? classifyLane({ intent, propertyFacts, engineResult, totals, comps, calibration, context })
      : { lane: LANES.RED, reasons: ['pricing engine failed for the selected services'] };
    result.lane = lane;
    result.reasons = reasons;
    result.engineResult = dryRun ? engineResult : undefined;

    if (dryRun) return result;

    if (lane === LANES.RED) {
      if (quotePromised) {
        await notify({
          call: context.call,
          context,
          lane,
          quotePromised,
          threadKey,
          title: S.redTitle,
          body: S.redBody(callerLabel(intent, context), reasons.join('; ')),
        });
      }
      return result;
    }

    const draft = await createDraftEstimate({
      intent, engineInput, engineResult, totals, lane, laneReasons: reasons,
      propertyFacts, comps, calibration, model, call: context.call, context,
      membershipSnapshot, priorQualifyingServices, origin,
    });

    if (draft.blocked) {
      result.blocked = true;
      // Request-only + already-open estimate = nothing is owed and nothing
      // new exists — a "quote promised" bell here would mint a false task.
      if (quotePromised) {
        await notify({
          call: context.call,
          context,
          lane,
          quotePromised,
          threadKey,
          title: S.blockedTitle,
          body: S.blockedBody(callerLabel(intent, context)),
        });
      }
      return result;
    }

    result.created = true;
    result.estimateId = draft.estimate.id;
    const laneWord = lane === LANES.GREEN ? 'ready to send' : 'needs a look before send';
    await notify({
      call: context.call,
      context,
      lane,
      quotePromised,
      threadKey,
      estimateId: draft.estimate.id,
      title: `AI estimate draft ${lane === LANES.GREEN ? 'ready' : 'needs review'} — $${totals.monthly}/mo`,
      body: `${callerLabel(intent, context)}: ${intent.service_interest_label || 'estimate'} drafted from the ${origin.noun} (${lane.toUpperCase()} — ${laneWord}). `
        + `$${totals.monthly}/mo · $${totals.annual}/yr${totals.oneTime ? ` · $${totals.oneTime} one-time` : ''}. `
        + `${lane === LANES.YELLOW ? `Flags: ${reasons.slice(0, 3).join('; ')}. ` : ''}Review in admin/estimates and send.`,
    });
    logger.info('[estimator-engine] draft created', {
      estimateId: draft.estimate.id, lane, monthly: totals.monthly, origin: origin.channel,
    });
    return result;
  } catch (err) {
    logger.error(`[estimator-engine] unexpected failure: ${err.message}`);
    result.lane = LANES.RED;
    result.reasons = [`engine error: ${err.message}`];
    if (!dryRun && (context?.call || threadKey) && quotePromised) {
      await notify({
        call: context?.call || null,
        context,
        lane: LANES.RED,
        quotePromised,
        threadKey,
        title: S.redTitle,
        body: S.errorBody,
      });
    }
    return result;
  }
}

// Isolated so tests can stub the pricing engine without loading DB config.
function generateEstimateSafely(engineInput) {
  const { generateEstimate } = require('../pricing-engine');
  return generateEstimate(engineInput);
}

module.exports = {
  estimatorEngineEnabled,
  maybeDraftEstimateForCall,
  // Origin-specific entries (sms-thread.js) reuse the shared pipeline and
  // bell plumbing instead of re-implementing the lane/notify contract.
  runDraftPipeline,
  notify,
  _private: { addressFromContext, commercialHint, gatherPropertySignals, sameStreetAddress, addressAddsLocality },
};
