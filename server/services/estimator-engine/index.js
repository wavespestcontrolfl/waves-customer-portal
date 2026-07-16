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
    return [sa.street_line_1, sa.city, [sa.state, sa.postal_code].filter(Boolean).join(' ')]
      .filter(Boolean).join(', ');
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
  // An established customer's service address beats a phone-matched lead —
  // leads.loadByPhone returns the NEWEST lead on the line, which on shared or
  // long-lived numbers can be a stale record for a different property.
  if (context.isExistingCustomer) return customerAddress || leadAddress;
  return leadAddress || customerAddress;
}

function commercialHint(context) {
  const propType = String(context.extraction?.property?.property_type || '').toLowerCase();
  return propType === 'commercial' || context.lead?.is_commercial === true;
}

// Compare the full first address segment (house number + entire street
// line), normalizing the common suffix/directional abbreviations, so a
// spelled-out correction like "123 Palm St" → "123 Palm Ave" is treated as a
// DIFFERENT property. False negatives here are cheap (an extra re-lookup);
// a false positive prices the wrong parcel.
const STREET_TOKEN_ALIASES = {
  street: 'st', avenue: 'ave', road: 'rd', drive: 'dr', lane: 'ln', court: 'ct',
  boulevard: 'blvd', place: 'pl', circle: 'cir', terrace: 'ter', parkway: 'pkwy',
  highway: 'hwy', north: 'n', south: 's', east: 'e', west: 'w',
  northeast: 'ne', northwest: 'nw', southeast: 'se', southwest: 'sw',
};
function sameStreetAddress(a, b) {
  const normSegment = (s) => String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => STREET_TOKEN_ALIASES[t] || t)
    .join(' ');
  const first = (s) => normSegment(String(s || '').split(',')[0]);
  const [na, nb] = [first(a), first(b)];
  if (!na || !nb || na !== nb) return false;
  // Same house number + street is NOT enough — SWFL street names repeat
  // across cities, so a city/ZIP correction alone means a different parcel.
  const zip = (s) => (String(s || '').match(/\b(\d{5})\b(?!.*\b\d{5}\b)/) || [])[1] || null;
  const [za, zb] = [zip(a), zip(b)];
  if (za && zb && za !== zb) return false;
  // Full-city equality, not token overlap — North Port vs Port Charlotte
  // share a token but are different parcels. A spurious mismatch only costs
  // a re-lookup.
  const cityString = (s) => normSegment(String(s || '').split(',').slice(1).join(' '))
    .split(' ')
    .filter((t) => t && t !== 'fl' && t !== 'florida' && !/^\d+$/.test(t))
    .join(' ');
  const [ca, cb] = [cityString(a), cityString(b)];
  if (ca && cb && ca !== cb) return false;
  return true;
}

// Property lookup + (when the county roll is unassessed) the
// subdivision-median dig. Both fail-open.
async function gatherPropertySignals(context, { refreshLookup = false } = {}) {
  const address = addressFromContext(context);
  let propertyRecord = null;
  if (address) {
    try {
      const { performPropertyLookup } = require('../../routes/property-lookup-v2');
      const lookup = await performPropertyLookup(address, refreshLookup ? { refresh: true } : {});
      propertyRecord = lookup?.propertyRecord || null;
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

  return { address, propertyRecord, parcelView, subdivisionMedian };
}

// One-bell dedupe across processing retries: the engine's notifications all
// carry estimator_engine + callSid metadata (and quote_promised, so the
// processor's own dedupe guard also recognizes them).
async function alreadyNotifiedForCall(callSid) {
  if (!callSid) return false;
  try {
    const row = await db('notifications')
      .whereRaw("metadata->>'callSid' = ?", [String(callSid)])
      .whereRaw("metadata->>'estimator_engine' = 'true'")
      .first();
    return !!row;
  } catch (err) {
    logger.warn(`[estimator-engine] notification dedupe check failed: ${err.message}`);
    return false;
  }
}

async function notify({ call, context, title, body, lane, estimateId = null }) {
  if (await alreadyNotifiedForCall(call?.twilio_call_sid)) return;
  const link = estimateId
    ? '/admin/estimates'
    : (context?.lead?.id ? `/admin/leads?lead=${context.lead.id}` : '/admin/communications');
  try {
    await require('../notification-service').notifyAdmin('lead', title, body, {
      link,
      metadata: {
        callSid: call?.twilio_call_sid || null,
        estimator_engine: true,
        quote_promised: true,
        lane: lane || null,
        estimateId,
      },
    });
  } catch (err) {
    logger.warn(`[estimator-engine] admin notify failed: ${err.message}`);
  }
}

function callerLabel(intent, context) {
  return intent?.customer_name
    || [context?.lead?.first_name, context?.lead?.last_name].filter(Boolean).join(' ')
    || [context?.customer?.first_name, context?.customer?.last_name].filter(Boolean).join(' ')
    || 'Unknown caller';
}

/**
 * Main entry. Non-throwing by contract: every path resolves to a result
 * object; failures degrade to the red-lane fallback notification.
 *
 * @param {object} args
 *   callLogId     — call_log.id (uuid)
 *   dryRun        — replay/test mode: full pipeline, NO draft row, NO
 *                   notification, returns complete diagnostics.
 *   refreshLookup — force a live property lookup past the cache (replay use).
 */
async function maybeDraftEstimateForCall({ callLogId, dryRun = false, refreshLookup = false }) {
  const result = { callLogId, dryRun, lane: null, created: false };
  let context = null;
  try {
    context = await buildCallContext(callLogId);
    if (context.error) {
      result.lane = LANES.RED;
      result.reasons = [context.error];
      if (!dryRun && context.call) {
        await notify({
          call: context.call,
          context,
          lane: LANES.RED,
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
          estimateId: existing.id,
          title: `AI estimate draft ${existingLane === 'green' ? 'ready' : 'needs review'} — $${existing.monthly_total || 0}/mo`,
          body: `${callerLabel(null, context)}: an estimate draft from this call is waiting (${String(existingLane).toUpperCase()}). Review in admin/estimates and send.`,
        });
        return result;
      }
    }

    const { address, propertyRecord, parcelView, subdivisionMedian } = await gatherPropertySignals(context, { refreshLookup });
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
      if (!dryRun) {
        await notify({
          call: context.call,
          context,
          lane: LANES.RED,
          title: 'Quote promised on call — send it',
          body: `${callerLabel(null, context)}: a quote was promised but the estimator engine could not compose a draft. Send it manually before end of day.`,
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
    let effectiveSignals = { propertyRecord, parcelView, subdivisionMedian };
    let addressRegathered = false;
    if (intent.address && (!address || !sameStreetAddress(intent.address, address))) {
      logger.info('[estimator-engine] composer-final address differs from gathered address — re-gathering property signals');
      const regathered = await gatherPropertySignals(
        { ...context, extraction: null, lead: { address: intent.address }, customer: null },
        { refreshLookup },
      );
      effectiveSignals = regathered;
      addressRegathered = true;
      result.addressUsed = regathered.address;
    }

    // The composer may also reclassify commercial vs the pre-intent hint —
    // the tenant/building arbitration rules depend on it. Re-run (pure) off
    // the effective signals either way to keep one code path. After an
    // address re-gather the matched profile's saved measurements describe the
    // OLD property — they must not backfill the new one.
    propertyFacts = resolvePropertyFacts({
      // Caller-stated facts (extraction) describe the property discussed on
      // THIS call — they stay. Only the matched profile's saved measurements
      // belong to the old property.
      extraction: context.extraction,
      propertyRecord: effectiveSignals.propertyRecord,
      parcelView: effectiveSignals.parcelView,
      customer: addressRegathered ? null : trustedCustomer,
      isCommercial: intent.is_commercial,
      subdivisionMedian: effectiveSignals.subdivisionMedian,
    });
    result.propertyFacts = propertyFacts;

    // Existing-customer pricing context: qualifying services for the combined
    // WaveGuard tier + the membership snapshot the accept path reads to waive
    // the setup fee. Both fail-open.
    let priorQualifyingServices = [];
    let membershipSnapshot = null;
    if (context.isExistingCustomer && context.customer?.id) {
      try {
        const { loadExistingQualifyingServiceKeys } = require('../waveguard-existing-services');
        priorQualifyingServices = await loadExistingQualifyingServiceKeys(db, context.customer.id) || [];
      } catch (err) {
        logger.warn(`[estimator-engine] prior qualifying services load failed: ${err.message}`);
      }
      try {
        const { computeMembershipContext } = require('../estimate-membership-context');
        membershipSnapshot = await computeMembershipContext(db, { customerId: context.customer.id });
      } catch (err) {
        logger.warn(`[estimator-engine] membership context load failed: ${err.message}`);
      }
    }

    let engineResult = null;
    let engineInput = null;
    let totals = { monthly: 0, annual: 0, oneTime: 0 };
    if (intent.decision === 'draft' && Object.keys(intent.services || {}).length) {
      engineInput = buildEngineInput({ intent, propertyFacts, context, priorQualifyingServices });
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

    const { lane, reasons } = engineResult
      ? classifyLane({ intent, propertyFacts, engineResult, totals, comps, calibration, context })
      : { lane: LANES.RED, reasons: ['pricing engine failed for the selected services'] };
    result.lane = lane;
    result.reasons = reasons;
    result.engineResult = dryRun ? engineResult : undefined;

    if (dryRun) return result;

    if (lane === LANES.RED) {
      await notify({
        call: context.call,
        context,
        lane,
        title: 'Quote promised on call — send it',
        body: `${callerLabel(intent, context)}: quote promised, no auto-draft (${reasons.join('; ')}). Send it manually before end of day.`,
      });
      return result;
    }

    const draft = await createDraftEstimate({
      intent, engineInput, engineResult, totals, lane, laneReasons: reasons,
      propertyFacts, comps, calibration, model, call: context.call, context,
      membershipSnapshot, priorQualifyingServices,
    });

    if (draft.blocked) {
      result.blocked = true;
      await notify({
        call: context.call,
        context,
        lane,
        title: 'Quote promised on call — estimate already open',
        body: `${callerLabel(intent, context)}: quote promised on a new call, but an automated estimate is already open for this phone number. Review and send the existing one.`,
      });
      return result;
    }

    result.created = true;
    result.estimateId = draft.estimate.id;
    const laneWord = lane === LANES.GREEN ? 'ready to send' : 'needs a look before send';
    await notify({
      call: context.call,
      context,
      lane,
      estimateId: draft.estimate.id,
      title: `AI estimate draft ${lane === LANES.GREEN ? 'ready' : 'needs review'} — $${totals.monthly}/mo`,
      body: `${callerLabel(intent, context)}: ${intent.service_interest_label || 'estimate'} drafted from the call (${lane.toUpperCase()} — ${laneWord}). `
        + `$${totals.monthly}/mo · $${totals.annual}/yr${totals.oneTime ? ` · $${totals.oneTime} one-time` : ''}. `
        + `${lane === LANES.YELLOW ? `Flags: ${reasons.slice(0, 3).join('; ')}. ` : ''}Review in admin/estimates and send.`,
    });
    logger.info('[estimator-engine] draft created', {
      estimateId: draft.estimate.id, lane, monthly: totals.monthly,
    });
    return result;
  } catch (err) {
    logger.error(`[estimator-engine] unexpected failure: ${err.message}`);
    result.lane = LANES.RED;
    result.reasons = [`engine error: ${err.message}`];
    if (!dryRun && context?.call) {
      await notify({
        call: context.call,
        context,
        lane: LANES.RED,
        title: 'Quote promised on call — send it',
        body: 'A quote was promised on a call but the estimator engine hit an error. Send the estimate manually before end of day.',
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
  _private: { addressFromContext, commercialHint, gatherPropertySignals, sameStreetAddress },
};
