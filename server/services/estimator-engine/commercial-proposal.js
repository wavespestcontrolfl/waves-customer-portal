/**
 * Commercial/HOA proposal lane (GATE_ESTIMATOR_COMMERCIAL_PROPOSALS, default
 * OFF; also requires GATE_ESTIMATOR_ENGINE — one kill switch for the whole
 * engine family).
 *
 * The engine's commercial relationship-quote red (is_commercial + building
 * footprint over the 10k-sqft line) is a bell-only dead end today: a
 * high-value HOA / property-manager prospect gets "send it manually" and no
 * artifact. Behind the gate, that red instead produces:
 *
 *   - a COMMERCIAL draft estimate row — UNPRICED: the three total columns
 *     stay NULL (never 0 — the $0-fallback trap)
 *   - a prospect research brief composed from the call/SMS context plus the
 *     property pipeline's parcel intelligence, stamped into
 *     estimate_data.commercialProspect (operator-only JSONB — estimates.notes
 *     is CUSTOMER-VISIBLE and stays NULL)
 *   - an UNPRICED, DISABLED proposal scaffold in the exact operator-authored
 *     estimate_data.proposal shape (buildings + $0 program lines) so the
 *     Commercial Proposal builder opens pre-filled instead of empty
 *
 * DOLLAR AUTHORITY: this lane never prices anything. generateEstimate is the
 * sole dollar authority and it deliberately red-lanes this segment; the LLM
 * brief is scope/intent-only and is REJECTED OUTRIGHT if it contains any
 * dollar figure. Prices enter exclusively through the operator's
 * PUT /:id/proposal, which recomputes the authoritative totals.
 *
 * UNSENDABLE BY CONSTRUCTION (two independent gates): the row carries
 * requiresCustomQuote=true — the admin send gate blocks quote-required
 * estimates until the proposal PUT clears the flag — AND its totals are
 * NULL, so estimateSendableAmount() <= 0 blocks a send even if the flag were
 * lost. proposal.enabled stays false, so no customer surface, send
 * attachment, or self-serve accept path can pick the scaffold up. THIS LANE
 * NEVER SENDS ANYTHING.
 */

const crypto = require('crypto');
const db = require('../../models/db');
const logger = require('../logger');
const MODELS = require('../../config/models');
const { dispatchWithFallback } = require('../llm/call');
const {
  listOpenEstimatesByPhone,
  phoneLookupValues,
  withAutomatedEstimatePhoneLock,
} = require('../estimate-automation-duplicates');
const { normalizeFrequency } = require('../estimate-proposal');

// Commercial relationship quotes are slower conversations than residential
// drafts (walkthrough, board approval) — a 7-day draft window would show the
// row as expired before the visit happens. Low-stakes: the send path
// re-stamps expires_at on every send.
const PROPOSAL_DRAFT_EXPIRY_DAYS = 30;

// Any dollar figure in the composed brief means the model priced something —
// the one thing this lane must never do. Reject the whole brief (the
// deterministic scaffold takes over) rather than trying to scrub it.
const DOLLAR_FIGURE_RE = /\$\s*\d|\b\d+(?:[.,]\d+)?\s*(?:dollars|usd)\b/i;

const MAX_BRIEF_LIST_ITEMS = 12;
const MAX_SCAFFOLD_BUILDINGS = 12;

function commercialProposalsEnabled() {
  const flag = String(process.env.GATE_ESTIMATOR_COMMERCIAL_PROPOSALS || '').toLowerCase();
  if (!['1', 'true', 'on'].includes(flag)) return false;
  const { estimatorEngineEnabled } = require('./index');
  return estimatorEngineEnabled();
}

function trimmedList(value, max = MAX_BRIEF_LIST_ITEMS) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .slice(0, max);
}

// Aggregate/parcel facts for the prompt and the deterministic scaffold. The
// stacked condo/HOA aggregate (#2721) carries its unit/building counts on
// propertyRecord._parcel; everything is optional and fail-soft.
function parcelFacts(propertyRecord, parcelView) {
  const parcel = propertyRecord?._parcel || {};
  const positive = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null);
  return {
    aggregated: parcel.aggregated === true,
    buildingCount: positive(parcel.buildingCount),
    residentialUnits: positive(parcel.residentialUnits),
    landUseDescription: parcelView?.landUseDescription || null,
    county: parcelView?.county || null,
    lotSqft: positive(parcelView?.lotSqft),
    yearBuilt: positive(parcelView?.yearBuilt),
  };
}

function briefPrompt({ intent, propertyFacts, facts, context, reasons }) {
  const services = Object.keys(intent.services || {});
  const transcriptExcerpt = String(context?.transcript || '').slice(0, 6000);
  return [
    'You are preparing an internal prospect-research brief for the owner of a',
    'pest control & lawn care company ahead of a COMMERCIAL / HOA walkthrough.',
    'The prospect contacted us; the property is too large for automated',
    'pricing, so the owner will quote it in person.',
    '',
    'HARD RULES:',
    '- NEVER state, estimate, or imply any price, dollar amount, or cost.',
    '- Internal document: factual, terse, no marketing language.',
    '- Only use facts present below; unknowns stay null — never invent.',
    '',
    'Respond with ONLY a JSON object, exactly this shape:',
    '{',
    '  "summary": "2-4 sentence prospect overview",',
    '  "propertyProfile": { "propertyType": string, "footprintSqft": number|null, "units": number|null, "buildings": number|null, "landUse": string|null },',
    '  "riskFactors": [string],',
    '  "servicePrograms": [ { "name": string, "cadence": "monthly"|"bimonthly"|"quarterly"|"annual"|"one_time", "scope": string } ],',
    '  "buildings": [ { "name": string, "note": string|null } ],',
    '  "walkthroughChecklist": [string],',
    '  "openQuestions": [string]',
    '}',
    '',
    'servicePrograms = the service lanes worth proposing (scope in words, no',
    'prices). buildings = how to split the proposal (towers, clubhouse,',
    'common areas) — one entry when there is no basis to split.',
    '',
    `Caller: ${intent.customer_name || 'unknown'}`,
    `Requested services: ${services.join(', ') || 'not specified'}`,
    `Service interest label: ${intent.service_interest_label || 'n/a'}`,
    `Commercial risk type: ${intent.commercial_risk_type || 'not established'}`,
    `Commercial subtype: ${intent.commercial_subtype || 'not established'}`,
    `Address: ${intent.address || 'unknown'}`,
    `Red-lane reasons: ${(reasons || []).join('; ') || 'n/a'}`,
    `Building footprint sqft (arbitrated): ${propertyFacts?.home?.value || 'unknown'}`,
    `Parcel facts: ${JSON.stringify(facts)}`,
    `Intent evidence: ${JSON.stringify((intent.evidence || []).slice(0, 8))}`,
    '',
    'Conversation transcript (excerpt):',
    transcriptExcerpt || '(none available)',
  ].join('\n');
}

function validateBrief(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'not_object';
  if (!String(raw.summary || '').trim()) return 'no_summary';
  if (!Array.isArray(raw.servicePrograms)) return 'no_service_programs';
  if (DOLLAR_FIGURE_RE.test(JSON.stringify(raw))) return 'contains_dollar_figure';
  return null;
}

function normalizeBrief(raw) {
  const profile = raw.propertyProfile && typeof raw.propertyProfile === 'object' && !Array.isArray(raw.propertyProfile)
    ? raw.propertyProfile
    : {};
  const numOrNull = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null);
  return {
    summary: String(raw.summary).trim().slice(0, 1200),
    propertyProfile: {
      propertyType: String(profile.propertyType || '').trim().slice(0, 120) || null,
      footprintSqft: numOrNull(profile.footprintSqft),
      units: numOrNull(profile.units),
      buildings: numOrNull(profile.buildings),
      landUse: String(profile.landUse || '').trim().slice(0, 200) || null,
    },
    riskFactors: trimmedList(raw.riskFactors),
    servicePrograms: (Array.isArray(raw.servicePrograms) ? raw.servicePrograms : [])
      .filter((p) => p && typeof p === 'object' && String(p.name || '').trim())
      .slice(0, MAX_BRIEF_LIST_ITEMS)
      .map((p) => ({
        name: String(p.name).trim().slice(0, 120),
        cadence: normalizeFrequency(p.cadence),
        scope: String(p.scope || '').trim().slice(0, 300),
      })),
    buildings: (Array.isArray(raw.buildings) ? raw.buildings : [])
      .filter((b) => b && typeof b === 'object' && String(b.name || '').trim())
      .slice(0, MAX_SCAFFOLD_BUILDINGS)
      .map((b) => ({
        name: String(b.name).trim().slice(0, 120),
        note: String(b.note || '').trim().slice(0, 300) || null,
      })),
    walkthroughChecklist: trimmedList(raw.walkthroughChecklist),
    openQuestions: trimmedList(raw.openQuestions),
  };
}

// Compose the research brief. Fail-soft by contract: any provider failure or
// contract violation returns null and the deterministic scaffold carries the
// lane — a missing brief must never cost the prospect their draft row.
async function composeProspectBrief({ intent, propertyFacts, facts, context, reasons }) {
  try {
    const result = await dispatchWithFallback(MODELS.TEXT_POLICIES.highStakes, {
      text: briefPrompt({ intent, propertyFacts, facts, context, reasons }),
      jsonMode: true,
      maxTokens: 2000,
      // Bounded: this runs inline in the (already detached) engine pipeline.
      timeoutMs: 90000,
    });
    if (!result?.ok || !result.json) {
      logger.warn('[commercial-proposal] brief composition failed (continuing without)', {
        failures: result?.failures || null,
      });
      return null;
    }
    const invalid = validateBrief(result.json);
    if (invalid) {
      logger.warn(`[commercial-proposal] brief rejected: ${invalid}`);
      return null;
    }
    return {
      ...normalizeBrief(result.json),
      composer: { provider: result.provider || null, model: result.model || null },
    };
  } catch (err) {
    logger.warn(`[commercial-proposal] brief composition threw (continuing without): ${err.message}`);
    return null;
  }
}

const SERVICE_LABELS = {
  pest: 'Pest control',
  lawn: 'Lawn care',
  mosquito: 'Mosquito',
  termite: 'Termite',
  rodent: 'Rodent',
  treeAndShrub: 'Tree & shrub',
};

function serviceLabel(key) {
  return SERVICE_LABELS[key] || (key.charAt(0).toUpperCase() + key.slice(1));
}

/**
 * The unpriced scaffold in the exact estimate_data.proposal shape the
 * operator-authored PUT writes (normalizeProposal round-trips it into the
 * Commercial Proposal builder). enabled:false is LOAD-BEARING: it keeps the
 * scaffold off the customer page, out of the send attachment, and the send
 * gate's authored-proposal exemption closed. Every line is $0 — the operator
 * prices after the walkthrough; save-time normalization keeps 0 legal.
 */
function buildProposalScaffold({ intent, brief, facts }) {
  let buildings = (brief?.buildings || []).map((b) => ({ name: b.name, note: b.note }));
  if (!buildings.length && facts.aggregated && facts.buildingCount > 1) {
    buildings = Array.from(
      { length: Math.min(facts.buildingCount, MAX_SCAFFOLD_BUILDINGS) },
      (_, i) => ({ name: `Building ${i + 1}`, note: null }),
    );
  }
  if (!buildings.length) {
    buildings = [{ name: intent.address || 'Service location', note: null }];
  }

  const programs = (brief?.servicePrograms || []).length
    ? brief.servicePrograms
    : Object.keys(intent.services || {}).map((key) => ({
      name: `${serviceLabel(key)} program`,
      cadence: 'monthly',
      scope: 'scope and pricing after walkthrough',
    }));
  const lineItems = (programs.length ? programs : [{
    name: 'Commercial service program',
    cadence: 'monthly',
    scope: 'scope and pricing after walkthrough',
  }]).map((p) => ({
    description: [p.name, p.scope].filter(Boolean).join(' — ').slice(0, 300),
    quantity: 1,
    unitPrice: 0,
    frequency: normalizeFrequency(p.cadence),
    taxable: false,
  }));

  return {
    enabled: false,
    synthesized: false,
    scaffold: true,
    title: 'Commercial Service Proposal',
    preparedFor: intent.customer_name || '',
    propertyAddress: intent.address || '',
    // Same program lines on every building: the operator splits/prunes per
    // building in the builder — guessing per-building scope here would just
    // be noise to delete.
    buildings: buildings.map((b) => ({ ...b, lineItems })),
  };
}

/**
 * Build the commercial proposal draft for a relationship-quote red. Callers
 * gate on commercialProposalsEnabled() + isCommercialRelationshipRed().
 * Non-throwing: every failure path returns { created: false, ... } so the
 * standard red bell can take over.
 */
async function maybeBuildCommercialProposalDraft({
  intent, propertyFacts, parcelView, propertyRecord, context, origin, model, reasons,
}) {
  try {
    if (!commercialProposalsEnabled()) return { created: false, skipped: 'gate_off' };
    if (!intent?.address) {
      // No address = nothing to research and no property to propose on; the
      // clarify-ask lane owns missing-address reds.
      return { created: false, skipped: 'no_address' };
    }

    const facts = parcelFacts(propertyRecord, parcelView);
    const brief = await composeProspectBrief({ intent, propertyFacts, facts, context, reasons });
    const scaffold = buildProposalScaffold({ intent, brief, facts });

    // Shared with the residential draft path — one phone-resolution and one
    // duplicate-conflict rule set, so the two lanes can never drift.
    const { resolveDraftCustomerPhone, conflictingOpenEstimate } = require('./draft-builder');
    const customerPhone = resolveDraftCustomerPhone(intent, context);

    const token = crypto.randomBytes(16).toString('hex');
    const expiresAt = new Date(Date.now() + PROPOSAL_DRAFT_EXPIRY_DAYS * 86400000);
    const call = context?.call || null;

    // Same serialization ladder as the engine's residential drafts: phone
    // advisory lock when the caller has a usable number, else a call-scoped
    // advisory transaction lock with an in-lock recheck (a forced reprocess
    // racing the first run must not insert twice), else bare.
    const runSerialized = (callback) => {
      if (phoneLookupValues(customerPhone).last10) {
        return withAutomatedEstimatePhoneLock(customerPhone, callback);
      }
      if (!call?.id) return callback(db);
      return db.transaction(async (trx) => {
        await trx.raw(
          'select pg_advisory_xact_lock(hashtext(?), hashtext(?))',
          ['estimator_engine_call', String(call.id)],
        );
        const existingForCall = await trx('estimates')
          .select('id')
          .whereRaw("estimate_data #>> '{estimatorEngine,callLogId}' = ?", [String(call.id)])
          .whereNull('archived_at')
          .first();
        if (existingForCall) return { duplicate: existingForCall };
        return callback(trx);
      });
    };

    const creation = await runSerialized(async (trx) => {
      const openEstimates = await listOpenEstimatesByPhone(customerPhone, { database: trx });
      const conflicting = conflictingOpenEstimate(openEstimates, intent.address);
      if (conflicting) return { duplicate: conflicting };

      const [estimate] = await trx('estimates').insert({
        estimate_data: JSON.stringify({
          // Blocks the admin send gate until the operator authors the real
          // proposal (the proposal PUT clears it). One of two independent
          // unsendable guarantees — the NULL totals are the other.
          requiresCustomQuote: true,
          ...(brief ? { commercialProspect: { ...brief, researchedAt: new Date().toISOString() } } : {}),
          proposal: scaffold,
          // Same lead-mirror rule as the residential drafts: only a lead
          // this call created or touched may be linked.
          ...(context?.lead?.id && context?.leadIsForThisCall ? { lead_id: context.lead.id } : {}),
          estimatorEngine: {
            version: 1,
            callLogId: call?.id || null,
            callSid: call?.twilio_call_sid || null,
            ...(origin?.channel && origin.channel !== 'call'
              ? { origin: origin.channel, ...(origin.threadKey ? { smsThreadKey: origin.threadKey } : {}) }
              : {}),
            // Truthfully red — existing lane readers keep working; the
            // proposal lane rides the marker below, not a new lane value.
            lane: 'red',
            laneReasons: reasons || [],
            commercialProposal: true,
            evidence: intent.evidence || [],
            constraintFlags: intent.constraint_flags || [],
            propertyFacts,
            composer: { model: model || null, confidence: intent.confidence },
          },
        }),
        address: intent.address,
        customer_name: intent.customer_name || 'Unknown caller',
        customer_phone: customerPhone,
        // Post-quarantine sources only — the composer's verbatim email can be
        // a misheard dictated address (same rule as residential drafts).
        customer_email: (context?.leadIsForThisCall && context?.lead?.email)
          || (!context?.customerPhoneAmbiguous && context?.customer?.email)
          || null,
        customer_id: (context?.customer?.id && !context?.customerPhoneAmbiguous)
          ? context.customer.id
          : null,
        // Price columns deliberately untouched: NULL, never 0. notes stays
        // NULL — estimates.notes is CUSTOMER-VISIBLE.
        token,
        expires_at: expiresAt,
        status: 'draft',
        source: 'estimator_engine',
        service_interest: intent.service_interest_label || 'Commercial service program',
        category: 'COMMERCIAL',
      }).returning(['id', 'token']);

      return { estimate };
    });

    if (creation.duplicate) {
      logger.info('[commercial-proposal] scaffold suppressed by existing open estimate', {
        existingEstimateId: creation.duplicate.id,
      });
      return { created: false, blocked: true, existingEstimateId: creation.duplicate.id };
    }

    // Lead link after the creation transaction commits — an in-transaction
    // failure would roll back the estimate itself (same rationale as the
    // residential draft path).
    if (context?.lead?.id && context?.leadIsForThisCall) {
      try {
        await db('leads').where({ id: context.lead.id }).update({ estimate_id: creation.estimate.id });
      } catch (linkErr) {
        logger.warn(`[commercial-proposal] lead link update failed (non-blocking): ${linkErr.message}`);
      }
    }

    logger.info('[commercial-proposal] proposal scaffold created', {
      estimateId: creation.estimate.id,
      briefComposed: !!brief,
      buildings: scaffold.buildings.length,
    });
    return { created: true, estimateId: creation.estimate.id, briefComposed: !!brief };
  } catch (err) {
    logger.warn(`[commercial-proposal] scaffold build failed (red bell takes over): ${err.message}`);
    return { created: false, skipped: 'error' };
  }
}

module.exports = {
  commercialProposalsEnabled,
  maybeBuildCommercialProposalDraft,
  _private: {
    briefPrompt,
    validateBrief,
    normalizeBrief,
    buildProposalScaffold,
    parcelFacts,
    DOLLAR_FIGURE_RE,
  },
};
