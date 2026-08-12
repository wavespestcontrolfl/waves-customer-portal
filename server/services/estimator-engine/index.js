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
const { deliveryClaimFresh } = require('../admin-estimate-persistence');
const { buildCallContext, existingDraftForCall } = require('./context-builder');
const { resolvePropertyFacts, normalizeParcelView } = require('./source-arbitration');
const { hasWrongPremiseFlag } = require('../lookup-confidence');

// A wrong-premise lookup poisons the RECORD leg too, not just the enriched
// payload buildEngineInput already rejects: an 'address' flag means the
// geocoder snapped to a DIFFERENT premise, so the county home/lot
// dimensions describe the SNAPPED parcel — arbitrated in as high-confidence
// 'county' facts they would size and green-lane a draft for the wrong
// house. Strip the parcel-scoped signals before arbitration; caller-stated
// extraction facts and the (address-matched) profile stay, and the draft
// falls to the fallback-source machinery that already routes to review.
// Deliberately NOT the broader global-flag check: an 'all' flag on an
// AI-backed record describes the RIGHT address — arbitration grades those
// dimensions low-confidence LOOKUP_ESTIMATE and routes to a reviewable
// draft, which stripping would needlessly turn red (the strict rule stays
// on the customer-facing path, which has no review lane). The snappedRecord
// check survives an enrichment failure (flags live on the enriched payload,
// the audit marker on the record itself).
function parcelSignalsDescribeGatheredAddress({ enriched, propertyRecord }) {
  if (hasWrongPremiseFlag(enriched)) return false;
  if (propertyRecord?._addressAudit?.snappedRecord) return false;
  return true;
}
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


// Re-point (or clear) an existing draft's lead links when the call's CURRENT
// linkage differs from what the draft recorded (codex P1, PR #3304): an
// in-pipeline draft can persist against a stamp a later retry then cleared
// or repointed, and returning it unreconciled leaves estimate_data.lead_id
// and leads.estimate_id advancing the WRONG pipeline record. Acts only on
// DURABLE evidence: a repoint requires the current lead resolved via sid or
// the metadata stamp (the phone-touched arm is bounded to the call's
// processing window — any later edit makes the same lead read as mere
// history, which must clear nothing); an unlink must be POSITIVELY
// established (lookup succeeded, no stamp on the call, and the draft's lead
// does not carry this call's sid or is gone). All three writes are one
// transaction; the whole reconcile is non-blocking.
async function reconcileExistingDraftLinks(existing, context) {
  try {
    const draftData = (() => {
      try {
        const data = typeof existing.estimate_data === 'string'
          ? JSON.parse(existing.estimate_data) : (existing.estimate_data || {});
        return data && typeof data === 'object' ? data : {};
      } catch { return {}; }
    })();
    const draftLeadId = draftData.lead_id ? String(draftData.lead_id) : null;
    const currentLeadId = (context?.lead?.id && context?.leadIsForThisCall)
      ? String(context.lead.id) : null;
    const durableRepoint = !!currentLeadId && ['sid', 'stamp'].includes(context?.leadLinkage);
    let establishedAbsence = false;
    if (!currentLeadId && draftLeadId && !context?.leadLookupUnavailable) {
      const callStamp = (() => {
        try {
          const md = typeof context?.call?.metadata === 'string'
            ? JSON.parse(context.call.metadata) : (context?.call?.metadata || {});
          return md?.lead_id ? String(md.lead_id) : null;
        } catch { return null; }
      })();
      if (!callStamp) {
        const draftLead = await db('leads')
          .where({ id: draftLeadId })
          .whereNull('deleted_at')
          .first('twilio_call_sid');
        establishedAbsence = !draftLead
          || !(draftLead.twilio_call_sid && context?.call?.twilio_call_sid
            && draftLead.twilio_call_sid === context.call.twilio_call_sid);
      } else {
        // The call CARRIES a stamp, yet the loader (which follows stamps
        // before any fallback) produced no lead while the lookup itself
        // succeeded — the stamped target is soft-deleted or otherwise
        // unusable, i.e. the draft's recorded linkage no longer holds
        // (codex P1, PR #3304 r18: refusing here returned null and the
        // caller presented the former lead's draft as verified). The
        // in-transaction revalidation re-establishes this against live
        // state before anything changes.
        establishedAbsence = true;
      }
    }
    // Fast-path gate on the pre-transaction snapshot; the AUTHORITATIVE
    // comparison re-runs inside the transaction against the LOCKED row
    // (codex P1, PR #3304 r5): with two concurrent reconciles, the loser's
    // snapshot lead is stale, and cleaning up by it would unlink the
    // wrong lead — leaving two leads pointing at one estimate.
    const draftLinkageDurable = ['sid', 'stamp'].includes(draftData.lead_linkage);
    if ((durableRepoint || (establishedAbsence && draftLinkageDurable)) && draftLeadId !== currentLeadId) {
      let relinked = null;
      await db.transaction(async (trx) => {
        // RE-READ under the row lock and patch ONLY the linkage keys
        // (codex P0, PR #3304 r4): a pre-transaction snapshot write would
        // silently erase an admin's concurrent service/pricing edits.
        // Mutable estimator-engine DRAFTS only — a sent/accepted/
        // finalized estimate is a customer-facing record this reconcile
        // must never touch.
        const fresh = await trx('estimates')
          .where({ id: existing.id })
          .forUpdate()
          .first('id', 'status', 'archived_at', 'estimate_data');
        // Every STILL-SENDABLE or RESENDABLE status is in scope (codex
        // P0/P1, PR #3304 r13/r18): scheduled/send_failed can still
        // deliver, and sent/viewed rows support resend and keep live
        // public-token access — archiving blocks all of it. A MID-SEND
        // ('sending') row is marked+archived too (codex P0 r19) — its
        // status stays untouched so the in-flight send's own terminal
        // write can land, and sendEstimateNow's LOCKED pre-delivery
        // verdict check serializes against this transaction and aborts
        // when the marker committed first. Money-bearing terminals
        // (accepted/declined/expired) get a MARKER-ONLY invalidation
        // (codex P0 r26): status, archive state, and money fields are
        // preserved — conversion already happened and is the operator's
        // to unwind — but the marker still lands, because the permanent
        // public token would otherwise keep serving content composed for
        // the wrong lead forever (estimateLinkageInvalidated blocks every
        // public surface on it).
        if (!fresh) return;
        const freshStatus = String(fresh.status || '').toLowerCase();
        const midSend = freshStatus === 'sending';
        const terminalRow = ['accepted', 'declined', 'expired'].includes(freshStatus);
        if (!terminalRow && !['draft', 'scheduled', 'send_failed', 'sent', 'viewed', 'sending'].includes(freshStatus)) return;
        const freshData = (() => {
          try {
            const data = typeof fresh.estimate_data === 'string'
              ? JSON.parse(fresh.estimate_data) : (fresh.estimate_data || {});
            return data && typeof data === 'object' ? data : {};
          } catch { return null; }
        })();
        if (!freshData) return;
        // Already invalidated by a peer (codex P1, PR #3304 r17): a
        // reconciler whose snapshot predates the first commit must not
        // re-process — it would overwrite linkage_invalidated_from with
        // null and lose the audit provenance. The MARKER alone decides
        // (codex P1 r18): an OPERATOR-archived row has no marker, and
        // skipping it would leave it revivable via /unarchive with its
        // stale links intact — it still gets the full invalidation.
        if (freshData.estimatorEngine?.linkage_invalidated_at) return;
        // Everything below keys off the LOCKED row's linkage, never the
        // snapshot: a peer reconcile may have already moved it.
        const freshLeadId = freshData.lead_id ? String(freshData.lead_id) : null;
        if (freshLeadId === currentLeadId) return;
        const freshLinkageDurable = ['sid', 'stamp'].includes(freshData.lead_linkage);
        if (!(durableRepoint || (establishedAbsence && freshLinkageDurable))) return;
        // Re-validate the call's CURRENT linkage inside the transaction
        // (pre-push P1 r6): estimator runs are detached — an older run
        // can acquire this lock LAST and would otherwise undo a retry's
        // correct relink with its stale context; the absence path must
        // also hold for the FRESH lead, not the snapshot's. The call row
        // is the source of truth.
        // Lead lock FIRST, then the CALL row LOCKED for the rest of this
        // transaction (codex P1, PR #3304 GH r9): a plain SELECT let a
        // NEWER retry restore the linkage between this read and the
        // estimate write, so an older reconciler archived a now-valid
        // draft on its stale verdict — and the newer pass, having already
        // scanned, saw the marker and never rebuilt. Order stays
        // estimates → leads → call_log, matching accept/decline.
        if (freshLeadId) await trx('leads').where({ id: freshLeadId }).forUpdate().first('id');
        const callRow = context?.call?.id
          ? await trx('call_log').where({ id: context.call.id }).forUpdate()
            .first('twilio_call_sid', 'metadata')
          : null;
        if (!callRow) return;
        const liveStamp = (() => {
          try {
            const md = typeof callRow.metadata === 'string' ? JSON.parse(callRow.metadata) : (callRow.metadata || {});
            return md?.lead_id ? String(md.lead_id) : null;
          } catch { return null; }
        })();
        if (currentLeadId) {
          const stillLinked = liveStamp === currentLeadId
            || (context?.leadLinkage === 'sid' && !!callRow.twilio_call_sid
              && context?.lead?.twilio_call_sid === callRow.twilio_call_sid);
          if (!stillLinked) return;
        } else {
          if (liveStamp) {
            // An unlink with a LIVE stamp holds only when the stamped
            // target is gone (the decision-phase deleted-target case) —
            // an alive target means the linkage stands and nothing may
            // change (codex P1, PR #3304 r18).
            const stampTarget = await trx('leads')
              .where({ id: liveStamp })
              .whereNull('deleted_at')
              .first('id');
            if (stampTarget) return;
          }
          if (freshLeadId) {
            const freshLead = await trx('leads').where({ id: freshLeadId }).whereNull('deleted_at').first('twilio_call_sid');
            const sidLinked = !!(freshLead?.twilio_call_sid && callRow.twilio_call_sid
              && freshLead.twilio_call_sid === callRow.twilio_call_sid);
            if (sidLinked) return;
          }
        }
        // A FRESH delivery claim means sendEstimateNow read its final
        // verdict under this same row lock and is mid-provider-handoff
        // (codex P0, PR #3304 r20/r22): a marker committed now would land
        // AFTER that verdict while the delivery still runs. The
        // invalidation is DUE (every decision check above passed), so it
        // must not be lost either — record a durable PENDING marker
        // (estimate_data only; status/archive untouched, the send owns
        // the row) that the send's claim release consumes into the full
        // invalidation. The caller still gets the fail-closed 'error'
        // outcome, and sendEstimateNow treats a pending marker as
        // invalidated, so the row can never be resent in the interim.
        if (deliveryClaimFresh(freshData.estimatorEngine)) {
          if (!freshData.estimatorEngine?.invalidation_pending_at) {
            freshData.estimatorEngine = {
              ...(freshData.estimatorEngine && typeof freshData.estimatorEngine === 'object' ? freshData.estimatorEngine : {}),
              invalidation_pending_at: new Date().toISOString(),
              invalidation_pending_from: freshLeadId || null,
              invalidation_pending_to: currentLeadId || null,
            };
            await trx('estimates').where({ id: existing.id })
              .update({ estimate_data: JSON.stringify(freshData), updated_at: new Date() });
          }
          relinked = { deferred: true, from: freshLeadId || 'none', to: currentLeadId || 'none' };
          return;
        }
        // NO durable linkage change ever reuses the draft (codex P0, PR
        // #3304 r8/r10): its composed content — recipient, address,
        // engine inputs, totals — was built from the FORMER lead, and
        // whether the linkage moved (repoint) or dissolved (established
        // unlink), reusing it risks a wrong-customer proposal and PII
        // disclosure. Both paths INVALIDATE: old lead unlinked, linkage
        // keys removed, durable marker set, and the row ARCHIVED
        // atomically — it drops out of admin's sendable surface, and
        // every duplicate guard already excludes archived rows, so the
        // stale draft cannot block its own rebuild
        // (existingDraftForCall excludes marked drafts and the engine
        // rebuilds from the corrected context).
        delete freshData.lead_id;
        delete freshData.lead_linkage;
        freshData.estimatorEngine = {
          ...(freshData.estimatorEngine && typeof freshData.estimatorEngine === 'object' ? freshData.estimatorEngine : {}),
          linkage_invalidated_at: new Date().toISOString(),
          linkage_invalidated_from: freshLeadId || null,
          linkage_invalidated_to: currentLeadId || null,
        };
        await trx('estimates').where({ id: existing.id })
          .update({
            estimate_data: JSON.stringify(freshData),
            // Scheduling is CANCELED atomically (codex P0, PR #3304 r14):
            // a 'scheduled' or 'send_failed' row returns to an inert
            // draft with no due time, so the cron can never claim the
            // invalidated content even through a guard gap. A mid-send
            // row keeps its status — the send flow owns it (P0 r19). A
            // TERMINAL row keeps status, archive state, and money fields
            // — the marker alone kills its public token (P0 r26).
            ...(terminalRow ? {} : { archived_at: new Date() }),
            ...(midSend || terminalRow ? {} : { status: 'draft', scheduled_at: null }),
            updated_at: new Date(),
          });
        if (freshLeadId) {
          // Only if the OLD lead still points at this draft — a lead
          // relinked elsewhere is not ours to touch.
          await trx('leads').where({ id: freshLeadId, estimate_id: existing.id })
            .update({ estimate_id: null });
        }
        relinked = { from: freshLeadId || 'none', to: currentLeadId || 'none', invalidated: true };
      });
      if (relinked?.deferred) {
        logger.info(`[estimator-engine] invalidation of draft ${existing.id} DEFERRED behind a live delivery claim (${relinked.from} → ${relinked.to}) — pending marker recorded`);
        return 'error';
      }
      if (relinked) {
        logger.info(`[estimator-engine] ${relinked.invalidated ? 'invalidated' : 'unlinked'} existing draft ${existing.id} after call linkage change (${relinked.from} → ${relinked.to})`);
        return relinked.invalidated ? 'invalidated' : 'unlinked';
      }
    }
    return null;
  } catch (relinkErr) {
    // Distinct failure outcome (codex P1, PR #3304 r11): a DB error here
    // can hide a durable repoint, and the caller must not surface the
    // draft as reusable on it.
    logger.warn(`[estimator-engine] existing-draft relink failed: ${relinkErr.message}`);
    return 'error';
  }
}

function estimatorEngineEnabled() {
  const flag = process.env.GATE_ESTIMATOR_ENGINE;
  return flag === '1' || flag === 'true' || flag === 'on';
}

// Headline amount for the draft bell. One-time work (fire ant treatment, a
// single ant job) prices entirely into oneTime with monthly=0, so keying the
// title off monthly alone rendered real $242–$301 jobs as "$0/mo" in the
// review queue — the title is the triage signal, and a $0 draft reads as
// nothing to send. Recurring still leads with /mo; a genuinely unpriced draft
// says so instead of quoting zero.
function draftAmountLabel({ monthly, oneTime }) {
  const mo = Number(monthly) || 0;
  const once = Number(oneTime) || 0;
  if (mo) return `$${mo}/mo`;
  if (once) return `$${once} one-time`;
  return 'amount TBD';
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
async function notify({ call, context, title, body, lane, estimateId = null, quotePromised = true, threadKey = null, link = null, forceUpdate = false }) {
  const callSid = call?.twilio_call_sid ? String(call.twilio_call_sid) : null;
  // Callers may pass a specific link (the proposal builder deep-link);
  // otherwise derive the historical default from what the bell references.
  link = link
    || (estimateId
      ? '/admin/estimates'
      : (context?.lead?.id ? `/admin/leads?lead=${context.lead.id}` : '/admin/communications'));
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
        let insertFresh = false;
        if (existingMeta.estimator_engine === true) {
          if (forceUpdate) {
            // The fail-closed reconciliation alerts REPLACE whatever the
            // bell said (codex P1, PR #3304 r18): the prior ready-to-send
            // title/link can point at a wrong-lead draft, and the dedupe's
            // stand rules would keep it there.
          } else if (callSid) {
            // Same callSid = same request. A prior estimator bell stands
            // UNLESS this run now has a draft the old bell doesn't know
            // about (transient red → later success), OR the bell tells a
            // DIFFERENT draft's story — after an invalidation+rebuild the
            // old link points at the archived stale draft and must
            // upgrade to the replacement (codex P1, PR #3304 r13).
            if (!estimateId) return true;
            if (existingMeta.estimateId === estimateId) return true;
          } else {
            // A thread key spans REQUESTS on one phone. Only a true retry
            // stands (same draft again, or both sides still-open
            // owed-quotes). An open placeholder upgrades to its outcome —
            // but a bell that already tells a COMPLETED draft's story is
            // history: a new request or a different draft gets a FRESH
            // bell instead of overwriting it.
            const sameDraft = !!estimateId && existingMeta.estimateId === estimateId;
            const bothOpen = !estimateId && !existingMeta.estimateId;
            if (sameDraft || bothOpen) return true;
            if (existingMeta.estimateId && existingMeta.estimateId !== estimateId) insertFresh = true;
          }
        }
        if (!insertFresh) {
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
    }
    // notifyAdmin catches insert failures and returns null — that is NOT a
    // durable bell, and callers gating detached work on durability (the SMS
    // handoff) must hear about it. Intentional suppression returns a truthy
    // sentinel and correctly counts as handled.
    const created = await require('../notification-service').notifyAdmin('lead', title, body, { link, metadata });
    return !!created;
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
    proposalTitle: 'Commercial prospect on call — proposal scaffold ready',
    proposalBody: (label) => `${label}: commercial relationship quote — prospect research and an unpriced proposal scaffold are drafted. Price it in the proposal builder.`,
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
// FORCED invalidation of a call's existing draft, independent of any
// linkage comparison. Two callers (codex P0 r19; generalized GH r8):
//   - an identity conflict, where the draft may target the conflicting
//     identity and leaving it sendable with a live public token is the
//     exposure; and
//   - a TERMINAL rejection (a forced retry reclassifying the call as spam
//     or a non-workable voicemail), where the draft was composed from a
//     call the pipeline now rejects — and clearing the metadata stamp does
//     NOT help, because a sid-linked lead still resolves for send/accept.
// Same marked-archive as a linkage invalidation, so every guard (unarchive
// 409, send claims, duplicate exclusion) applies; the audit reason and the
// lead unlink ride along. Money-bearing terminals get the marker only.
// Never throws — the caller's review bell is the durable signal.
async function invalidateDraftForCall(callLogId, { reason, identityConflict = false, ownershipFence = null }) {
  // EXPLICIT result, never a swallowed failure (codex P0, PR #3304 GH
  // r8c): callers finalized spam/voicemail processing — or reported an
  // identity-conflict draft as invalidated — while no marker or archive
  // had been persisted, leaving the old bearer token and a sendable
  // wrong-identity draft live indefinitely. Returns
  // { ok, invalidated, error }; the caller decides whether to retry.
  try {
    // DURABLE VERDICT FIRST, scan second (codex P0, PR #3304 GH r8g):
    // stamping the call before enumerating drafts is what closes the
    // late-composer window — a detached composer that locks the call
    // between the scan and a later stamp would otherwise insert an
    // unmarked wrong-identity (or rejected-call) draft that stays
    // sendable. The creators' in-lock fence and the send/accept/decline
    // revalidation both read this marker.
    await markDraftBlockOnCall(callLogId, reason, {
      procToken: ownershipFence?.procToken || null,
      procGeneration: ownershipFence?.procGeneration ?? null,
    });
    // STRICT lookup: existingDraftForCall converts DB errors to null,
    // which would read here as "no draft to invalidate". EVERY
    // uninvalidated row for this call is quarantined, not just the newest
    // (codex P0, PR #3304 GH r8d): concurrent composers and historical
    // duplicates both exist, and leaving an older row unmarked keeps a
    // PERMANENT public token sendable.
    const conflictedRows = await strictExistingDraftForCall(callLogId);
    let invalidatedAny = false;
    for (const conflicted of conflictedRows) {
       
      await db.transaction(async (trx) => {
        const fresh = await trx('estimates')
          .where({ id: conflicted.id })
          .forUpdate()
          .first('id', 'status', 'archived_at', 'estimate_data');
        if (!fresh) return;
        const data = (() => {
          try {
            const d = typeof fresh.estimate_data === 'string'
              ? JSON.parse(fresh.estimate_data) : (fresh.estimate_data || {});
            return d && typeof d === 'object' ? d : {};
          } catch { return null; }
        })();
        if (!data || data.estimatorEngine?.linkage_invalidated_at) return;
        // Same scope rule as the linkage reconcile (codex P0, PR
        // #3304 r20/r26): a money-bearing terminal
        // (accepted/declined/expired) keeps status, archive state,
        // and money fields, but still receives the MARKER-ONLY
        // quarantine below — the permanent public token must die on
        // an identity conflict too.
        const freshQStatus = String(fresh.status || '').toLowerCase();
        const terminalQRow = ['accepted', 'declined', 'expired'].includes(freshQStatus);
        if (!terminalQRow && !['draft', 'scheduled', 'send_failed', 'sent', 'viewed', 'sending'].includes(freshQStatus)) return;
        // And the same delivery-claim fence (codex P0 r22): never
        // commit an archive inside a live send's verdict-to-handoff
        // window — record a durable PENDING marker the send's claim
        // release consumes instead, so the quarantine is never lost.
        // The quarantined lead is unlinked exactly like an ordinary
        // invalidation (codex P1 r5 GH): leaving lead_id and
        // leads.estimate_id pointing at the archived draft made the
        // operator's replacement-link action bounce off the
        // "already linked" pipeline guard, and agent context kept
        // treating the wrong-identity draft as current.
        const quarantinedLeadId = data.lead_id ? String(data.lead_id) : null;
        if (deliveryClaimFresh(data.estimatorEngine)) {
          const eng = data.estimatorEngine && typeof data.estimatorEngine === 'object'
            ? data.estimatorEngine : {};
          const forcedKey = identityConflict ? 'invalidation_pending_conflict' : 'invalidation_pending_reason';
          // MERGE the forced verdict into an existing marker (codex P0, PR
          // #3304 GH r8c): a pending LINKAGE marker already present carried
          // neither reason nor conflict, so the finalizer read this
          // quarantine as an ordinary repoint — and discarded it as
          // obsolete whenever the linkage was unchanged (the sid-linked
          // case), leaving the rejected or wrong-identity draft live.
          if (!eng.invalidation_pending_at || eng[forcedKey] !== reason) {
            // The generation this forced verdict rides on (codex P1,
            // local audit on 3092fbbb8): the finalizer compares it to the
            // call's live generation to detect a verdict superseded by a
            // newer pass's re-qualification. The fence's generation IS
            // the verdict pass's own (the fence check below rolls the
            // marker back if the row has moved past it); without a fence,
            // the live row observed inside this txn is the verdict's
            // generation. A newer forced verdict overwrites an older
            // marker's generation — supersession is judged against the
            // LATEST verdict.
            const verdictGeneration = ownershipFence?.procGeneration
              ?? (await trx('call_log').where({ id: callLogId })
                .first('processing_generation')
                .then((r) => (r?.processing_generation != null ? Number(r.processing_generation) : null))
                .catch(() => null));
            data.estimatorEngine = {
              ...eng,
              invalidation_pending_at: eng.invalidation_pending_at || new Date().toISOString(),
              // The claim release performs the unlink for a deferred
              // quarantine too — it needs the source lead.
              invalidation_pending_from: eng.invalidation_pending_from || quarantinedLeadId,
              ...(verdictGeneration != null ? { invalidation_pending_generation: verdictGeneration } : {}),
              [forcedKey]: reason,
            };
            await trx('estimates').where({ id: conflicted.id })
              .update({ estimate_data: JSON.stringify(data), updated_at: new Date() });
          }
          // The SAME ownership fence the full path applies (codex P0, PR
          // #3304 GH r8d): this branch returned early, so a stale worker
          // that lost its processing_token could queue a forced
          // quarantine whose claim-release later archived the REPLACEMENT
          // worker's valid draft. Throwing rolls the marker back.
          if (ownershipFence?.procToken || ownershipFence?.procGeneration != null) {
            const stillOwned = await trx('call_log')
              .where({ id: ownershipFence.callLogId || callLogId })
              // Generation arm (PR #3304): "same generation" means no newer
              // pass has claimed the call since ours — true across our own
              // finalization, false forever after a reclaim, even once the
              // reclaiming pass finalizes and clears its token. The bare
              // token-NULL arm remains only for legacy fences without a
              // generation (a pass claimed before the column deployed).
              // A GENERATION-ONLY fence (no token) is the settled-replay
              // shape — the quarantine sweep and the reconcile-only
              // identity branch observed a settled call at generation N
              // and must not replay their verdict after a reclaim bumps it.
              .where(function ownedOrCurrentGeneration() {
                if (!ownershipFence.procToken) {
                  this.where('processing_generation', ownershipFence.procGeneration);
                  return;
                }
                this.where('processing_token', ownershipFence.procToken);
                if (ownershipFence.procGeneration != null) {
                  this.orWhere('processing_generation', ownershipFence.procGeneration);
                } else {
                  this.orWhereNull('processing_token');
                }
              })
              .forUpdate()
              .first('id');
            if (!stillOwned) {
              const lost = new Error('processing claim lost before deferred quarantine');
              lost.ownershipLost = true;
              throw lost;
            }
          }
          logger.info(`[estimator-engine] invalidation of draft ${conflicted.id} DEFERRED behind a live delivery claim (${reason}) — pending marker recorded`);
          return;
        }
        delete data.lead_id;
        delete data.lead_linkage;
        data.estimatorEngine = {
          ...(data.estimatorEngine && typeof data.estimatorEngine === 'object' ? data.estimatorEngine : {}),
          linkage_invalidated_at: new Date().toISOString(),
          ...(identityConflict ? { identity_conflict: reason } : { invalidation_reason: reason }),
        };
        const midSend = freshQStatus === 'sending';
        await trx('estimates').where({ id: conflicted.id }).update({
          estimate_data: JSON.stringify(data),
          ...(terminalQRow ? {} : { archived_at: fresh.archived_at || new Date() }),
          ...(midSend || terminalQRow ? {} : { status: 'draft', scheduled_at: null }),
          updated_at: new Date(),
        });
        if (quarantinedLeadId) {
          // Only if the lead still points at this draft — a lead
          // relinked elsewhere is not ours to touch.
          await trx('leads').where({ id: quarantinedLeadId, estimate_id: conflicted.id })
            .update({ estimate_id: null });
        }
        // OWNERSHIP FENCE, last so the lock order stays estimates → leads
        // → call_log (codex P0, PR #3304 GH r8c): the terminal caller can
        // lose its processing_token before its own fenced write, and a
        // stale worker must not invalidate a draft the REPLACEMENT worker
        // legitimately owns — that would delete a valid public draft with
        // no rebuild. Throwing rolls the whole invalidation back.
        if (ownershipFence?.procToken || ownershipFence?.procGeneration != null) {
          const owned = await trx('call_log')
            .where({ id: ownershipFence.callLogId || callLogId })
            // Owned-or-CURRENT-GENERATION, matching markDraftBlockOnCall
            // (codex P0, PR #3304 GH r10b; generation arm replaces the
            // token-NULL arm): the estimator runs DETACHED while normal
            // processing clears the token, so an identity conflict
            // detected after finalization is not an ownership loss — but
            // the bare token-NULL arm ALSO admitted a stale worker after
            // a RECLAIMING pass finalized, letting it invalidate the
            // replacement's valid draft. The generation distinguishes the
            // two: our own finalization leaves it unchanged; any reclaim
            // bumps it, and it never comes back down. A GENERATION-ONLY
            // fence (settled replay — no claim token exists) tests the
            // observed generation alone.
            .where(function ownedOrCurrentGeneration() {
              if (!ownershipFence.procToken) {
                this.where('processing_generation', ownershipFence.procGeneration);
                return;
              }
              this.where('processing_token', ownershipFence.procToken);
              if (ownershipFence.procGeneration != null) {
                this.orWhere('processing_generation', ownershipFence.procGeneration);
              } else {
                this.orWhereNull('processing_token');
              }
            })
            .forUpdate()
            .first('id');
          if (!owned) {
            const lost = new Error('processing claim lost before draft invalidation');
            lost.ownershipLost = true;
            throw lost;
          }
        }
      });
      logger.info(`[estimator-engine] invalidated draft ${conflicted.id} (${reason})`);
      invalidatedAny = true;
    }
    return { ok: true, invalidated: invalidatedAny };
  } catch (qErr) {
    if (qErr.ownershipLost) {
      // NOT a failure: a peer owns this call now and will re-decide.
      logger.info(`[estimator-engine] draft invalidation for call ${callLogId} skipped — processing claim lost to a peer`);
      return { ok: true, invalidated: false, ownershipLost: true };
    }
    logger.error(`[estimator-engine] forced draft invalidation FAILED for call ${callLogId} (${reason}): ${qErr.message}`);
    return { ok: false, invalidated: false, error: qErr.message };
  }
}

// ONE call-side verdict marker for every forced invalidation — identity
// conflict OR pipeline rejection. Written BEFORE the draft scan so no
// composer can slip a draft in behind it; read by the creators' in-lock
// fence (callRejectedForDrafting) and by send/accept/decline
// revalidation (staleCallLinkageReason).
async function markDraftBlockOnCall(callLogId, reason, { procToken = null, procGeneration = null } = {}) {
  // THROWS on failure (codex P0, PR #3304 GH r8h): this marker is the only
  // thing standing between a detached composer and an unmarked
  // wrong-identity or rejected-call draft with a permanent public token.
  // Swallowing the error let the scan succeed — or find nothing — and
  // report ok with no durable block in place. Retried, then propagated.
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      // The WRITE itself carries the ownership predicate (codex P1, PR
      // #3304 GH r9): a separate pre-check let a stale worker commit an
      // unconditional block after a replacement reclaimed the call — and
      // because that block is NEWER than the replacement pass's
      // generation fence, the valid pass could never clear it and its own
      // draft stayed blocked indefinitely.
      const q = db('call_log').where({ id: callLogId });
      // Ownership is lost only when a PEER holds the call — a token
      // CLEARED by this pass's own normal finalization is not a reclaim
      // (codex P1, PR #3304 GH r10). The estimator is launched
      // un-awaited, so its context builder routinely reports a conflict
      // after finalization; treating that as ownershipLost reported
      // success while nothing was invalidated. The generation arm closes
      // the other direction: after a RECLAIMING pass finalizes (token
      // null again), a stale worker's late block no longer lands — the
      // bumped generation fails both arms.
      if (procToken) {
        q.where(function ownedOrCurrentGeneration() {
          this.where('processing_token', procToken);
          if (procGeneration != null) this.orWhere('processing_generation', procGeneration);
          else this.orWhereNull('processing_token');
        });
      } else if (procGeneration != null) {
        // GENERATION-ONLY fence (settled replay — the quarantine sweep and
        // the reconcile-only identity branch hold no claim token): the
        // marker lands only while the call is still on the observed
        // generation; a reclaim bumps it and this write goes 0-row, which
        // the caller reads as ownership lost and defers.
        q.where('processing_generation', procGeneration);
      }
      const wrote = await q.update({
        metadata: db.raw(
          "jsonb_set(COALESCE(metadata, '{}'::jsonb), '{estimator_draft_block}', ?::jsonb, true)",
          // The marker records its writer's generation so a later pass's
          // clear can distinguish "older verdict, mine to retire" from "a
          // concurrent NEWER verdict I must not delete" without trusting
          // wall clocks (PR #3304 — same doctrine as leads.lead_stamp_seq).
          [JSON.stringify({ reason, at: new Date().toISOString(), ...(procGeneration != null ? { generation: procGeneration } : {}) })],
        ),
        updated_at: new Date(),
      });
      // 0 rows with a fence (token OR observed generation) means the claim
      // moved on — the reclaiming pass owns the verdict; without any fence
      // it means the call is gone, so there is nothing to draft against
      // and nothing to block.
      if (!wrote && (procToken || procGeneration != null)) {
        const lost = new Error('processing claim lost before the draft-block stamp');
        lost.ownershipLost = true;
        throw lost;
      }
      return;
    } catch (err) {
      // An ownership loss is a VERDICT, not a transient failure (codex P1,
      // PR #3304 GH r10): flattening it into a generic error made the
      // caller report a quarantine failure and queue an unconditional
      // retry marker — which the replacement pass would then have to
      // fight. Propagate it unchanged, immediately.
      if (err.ownershipLost) throw err;
      lastErr = err;
    }
  }
  throw new Error(`draft-block marker write failed for call ${callLogId}: ${lastErr?.message || 'unknown'}`);
}

// Cleared the moment a pass reads a CONCLUSIVELY clean context — the
// verdict is gone and drafting must resume. Both call-side keys go
// together (codex P1, PR #3304 GH r8g): a leftover quarantine-queue entry
// blocks the valid replacement draft just as hard as the verdict itself.
// A clear that will not land THROWS: the pass fails and retries, which
// defers the draft rather than losing it to a permanent block.
async function clearDraftBlockOnCall(callLogId, { notNewerThan, generation = null } = {}) {
  // GENERATION FENCE (codex P0, PR #3304 GH r8h; hardened with the real
  // processing_generation, PR #3304): only markers this pass may retire
  // are cleared. A concurrent pass can write a NEWER conflict or
  // rejection between our unlocked read and this update, and a blind
  // clear would delete the only durable guard for it. A marker that
  // recorded its writer's generation is cleared only by a pass of the
  // same or later generation — monotonic, wall-clock-free. Markers
  // without one (written pre-column, or by generation-less maintenance)
  // keep the original timestamp fence: `notNewerThan` is the ISO instant
  // this pass started, and a marker stamped after it survives untouched.
  const fenceAt = notNewerThan || new Date().toISOString();
  const markerClearable = (key) => `(
    CASE WHEN (metadata->'${key}'->>'generation') ~ '^[0-9]+$'
         THEN ${generation != null ? `(metadata->'${key}'->>'generation')::int <= ?` : 'FALSE'}
         ELSE COALESCE(metadata->'${key}'->>'at', '') <= ?
    END
  )`;
  const markerBindings = generation != null ? [generation, fenceAt] : [fenceAt];
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await db('call_log').where({ id: callLogId })
        .where(function anyMarker() {
          this.whereRaw("COALESCE(metadata->'estimator_draft_block'->>'reason', '') <> ''")
            .orWhereRaw("COALESCE(metadata->'estimator_quarantine_pending'->>'reason', '') <> ''");
        })
        .whereRaw(markerClearable('estimator_draft_block'), markerBindings)
        .whereRaw(markerClearable('estimator_quarantine_pending'), markerBindings)
        .update({
          metadata: db.raw("(COALESCE(metadata, '{}'::jsonb) - 'estimator_draft_block') - 'estimator_quarantine_pending'"),
          updated_at: new Date(),
        });
      return;
    } catch (err) { lastErr = err; }
  }
  const blocked = new Error(`draft-block marker clear failed for call ${callLogId}: ${lastErr?.message || 'unknown'}`);
  blocked.draftBlockClearFailed = true;
  throw blocked;
}

// DURABLE retry queue for a quarantine that could not persist (codex P0,
// PR #3304 GH r8d). The estimator runs fire-and-forget, so a transient DB
// outage during an identity conflict or a rejected-call verdict would
// otherwise leave the unmarked draft public and sendable with nothing
// scheduled to try again. The failure is stamped on the CALL row and the
// scheduler sweep below retries it until it lands.
// `procGeneration` stamps the QUEUED marker with the generation whose
// verdict it carries (codex P1, GH round on fe55a83df). Without it the
// queue entry looked generation-less, and a generation-less marker is
// deliberately honored as un-provably-stale — so a queue written by
// generation N kept a later supersession check from firing, and the stale
// N quarantine archived a draft N+1 had already re-qualified. (The wedged
// -invalidation sweep runs BEFORE the quarantine sweep, so the queue is
// not cleared first.) Only genuinely legacy markers should need that
// fail-closed fallback.
async function markQuarantinePending(callLogId, reason, { procGeneration = null } = {}) {
  try {
    await db('call_log').where({ id: callLogId }).update({
      metadata: db.raw(
        "jsonb_set(COALESCE(metadata, '{}'::jsonb), '{estimator_quarantine_pending}', ?::jsonb, true)",
        [JSON.stringify({
          reason,
          at: new Date().toISOString(),
          ...(procGeneration != null ? { generation: Number(procGeneration) } : {}),
        })],
      ),
      updated_at: new Date(),
    });
    logger.warn(`[estimator-engine] queued a DURABLE quarantine retry for call ${callLogId} (${reason})`);
    return true;
  } catch (markErr) {
    logger.error(`[estimator-engine] could not queue the quarantine retry for call ${callLogId}: ${markErr.message}`);
    return false;
  }
}

// DURABLE retry queue for a reconcile-only pass that failed (local audit
// P0, PR #3304): reconcileDraftLinksForCall runs post-finalization and
// non-blocking, so a transient failure left stale draft links — possibly
// pointing at the WRONG lead after a repoint — with nothing scheduled to
// try again; the call is 'processed' and never re-enters the pipeline on
// its own. The scheduler sweep below re-runs the reconcile until it lands.
async function markReconcilePending(callLogId) {
  try {
    await db('call_log').where({ id: callLogId }).update({
      metadata: db.raw(
        "jsonb_set(COALESCE(metadata, '{}'::jsonb), '{estimator_reconcile_pending}', ?::jsonb, true)",
        [JSON.stringify({ at: new Date().toISOString() })],
      ),
      updated_at: new Date(),
    });
    logger.warn(`[estimator-engine] queued a DURABLE reconcile retry for call ${callLogId}`);
    return true;
  } catch (markErr) {
    logger.error(`[estimator-engine] could not queue the reconcile retry for call ${callLogId}: ${markErr.message}`);
    return false;
  }
}

// Drains the reconcile-retry queue. Each row re-runs the SAME reconcile
// the failed pass attempted — reconcileDraftLinksForCall re-derives the
// verdict from live state, so a marker replayed after the call was
// legitimately re-qualified simply reconciles to the current truth. An
// in-flight pass defers (its own finalization reconciles); only a
// non-'error' outcome clears the marker (CAS on the stamped instant).
async function sweepPendingReconciles({ limit = 50 } = {}) {
  let rows = [];
  try {
    rows = await db('call_log')
      .whereRaw("COALESCE(metadata->'estimator_reconcile_pending'->>'at', '') <> ''")
      .orderBy('updated_at', 'asc')
      .limit(limit)
      .select('id', 'metadata');
  } catch (err) {
    logger.warn(`[estimator-engine] pending-reconcile scan failed: ${err.message}`);
    return 0;
  }
  let cleared = 0;
  for (const row of rows) {
    const pending = (() => {
      try {
        const md = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : (row.metadata || {});
        return md?.estimator_reconcile_pending || null;
      } catch { return null; }
    })();
    if (!pending?.at) continue;
    try {
      const live = await db('call_log').where({ id: row.id })
        .first('processing_token', 'processing_status', 'extraction_attempts', 'created_at');
      if (!live) continue;
      {
        const { callReprocessInFlight } = require('../admin-estimate-persistence');
        if (callReprocessInFlight(live)) continue;
      }
      const outcome = await reconcileDraftLinksForCall(row.id);
      if (outcome === 'error') continue; // keep the marker — retried next sweep
      await db('call_log').where({ id: row.id })
        .whereRaw("metadata->'estimator_reconcile_pending'->>'at' = ?", [String(pending.at)])
        .update({
          metadata: db.raw("COALESCE(metadata, '{}'::jsonb) - 'estimator_reconcile_pending'"),
          updated_at: new Date(),
        });
      cleared += 1;
      logger.info(`[estimator-engine] drained a queued reconcile retry for call ${row.id} (${outcome || 'no_draft'})`);
    } catch (sweepErr) {
      logger.warn(`[estimator-engine] reconcile retry failed for call ${row.id}: ${sweepErr.message}`);
    }
  }
  return cleared;
}

// CAS clear of the EXACT marker processed (codex P0, PR #3304 GH r8e): a
// peer can replace it between the scan and the clear, and dropping the
// NEWER request would lose the only durable backstop for a concurrently
// created wrong-identity or rejected-call draft.
async function clearQuarantineMarker(callLogId, pending) {
  return db('call_log').where({ id: callLogId })
    .whereRaw("metadata->'estimator_quarantine_pending'->>'at' = ?", [String(pending?.at || '')])
    .update({
      metadata: db.raw("COALESCE(metadata, '{}'::jsonb) - 'estimator_quarantine_pending'"),
      updated_at: new Date(),
    });
}

// Drains the queue above; runs from the scheduler's recovery pass. Each
// success clears its marker, so the sweep is idempotent and self-limiting.
async function sweepPendingQuarantines({ limit = 50 } = {}) {
  let rows = [];
  try {
    rows = await db('call_log')
      .whereRaw("COALESCE(metadata->'estimator_quarantine_pending'->>'reason', '') <> ''")
      .orderBy('updated_at', 'asc')
      .limit(limit)
      .select('id', 'metadata');
  } catch (err) {
    logger.warn(`[estimator-engine] pending-quarantine scan failed: ${err.message}`);
    return 0;
  }
  let cleared = 0;
  for (const row of rows) {
    const pending = (() => {
      try {
        const md = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : (row.metadata || {});
        return md?.estimator_quarantine_pending || null;
      } catch { return null; }
    })();
    if (!pending?.reason) continue;
    // A queued retry is only valid while its VERDICT still stands (codex
    // P0, PR #3304 GH r8e): a later reprocessing pass can legitimately
    // re-qualify the call, and replaying the stale reason would archive
    // every current draft — including the valid replacement — and then
    // clear the queue. Defer while a pass is running; for a rejection,
    // require the call to still be rejected; for an identity conflict,
    // require the context to still report one.
    const live = await db('call_log').where({ id: row.id })
      .first('processing_token', 'processing_status', 'metadata', 'extraction_attempts', 'created_at', 'processing_generation');
    if (!live) continue;
    // EVERY unsettled status defers, not just a live token or literal
    // 'processing' (codex P1, PR #3304 GH r10): the failed spam/voicemail
    // path deliberately queues the quarantine and THEN enters
    // extraction_failed, so a narrow check let this sweep immediately
    // decide the call was no longer rejected and drop its own queue entry.
    {
      const { callReprocessInFlight } = require('../admin-estimate-persistence');
      if (callReprocessInFlight(live)) continue;
    }
    const identityConflict = String(pending.reason).startsWith('email_');
    if (!identityConflict) {
      const { callRejectedForDrafting } = require('../admin-estimate-persistence');
      // The LIVE pipeline verdict only (codex P1, PR #3304 GH r9): the
      // queued markers are this sweep's own artifacts, so counting them
      // as proof made the re-qualification cleanup unreachable — the
      // sweep would replay an obsolete rejection forever and keep
      // drafting and delivery blocked.
      const stillRejected = await callRejectedForDrafting(db, row.id, { ignoreQueuedMarkers: true });
      if (!stillRejected) {
        // The re-qualified call must lose BOTH markers (pre-push P1, PR
        // #3304): the rejection's invalidateDraftForCall also stamped
        // estimator_draft_block, which every draft creator and public-
        // estimate guard honors — clearing only the queue left a now-valid
        // estimate suppressed forever when reprocessing took the
        // reconcile-only path and no drafting pass ever ran the clean-
        // context clear. Same generation-aware clear as the identity
        // branch below; a NEWER generation-stamped marker survives.
        await clearDraftBlockOnCall(row.id, {
          notNewerThan: String(pending.at || new Date().toISOString()),
          generation: live.processing_generation != null ? Number(live.processing_generation) : null,
        });
        await clearQuarantineMarker(row.id, pending);
        logger.info(`[estimator-engine] dropped a stale queued quarantine for call ${row.id} — the call was re-qualified (${pending.reason})`);
        continue;
      }
    } else {
      const freshContext = await buildCallContext(row.id).catch(() => null);
      // CONCLUSIVE clean only (codex P0, PR #3304 GH r8f): buildCallContext
      // RETURNS error objects for lookup failures rather than throwing, so
      // `customer_lookup_unavailable` would otherwise read as "conflict
      // cleared" and discard the only durable retry for a conflict that
      // was never disproved.
      if (freshContext && !freshContext.error) {
        // The call is SETTLED (the in-flight check above deferred
        // otherwise) and the verdict re-verified clean — clearing with the
        // call's LIVE generation retires every marker (marker generations
        // never exceed the call's), while the timestamp still fences any
        // generation-less legacy marker.
        await clearDraftBlockOnCall(row.id, {
          notNewerThan: String(pending.at || new Date().toISOString()),
          generation: live.processing_generation != null ? Number(live.processing_generation) : null,
        });
        await clearQuarantineMarker(row.id, pending);
        logger.info(`[estimator-engine] dropped a stale queued quarantine for call ${row.id} — the identity conflict cleared`);
        continue;
      }
      // Only an explicitly RE-OBSERVED conflict may replay the forced
      // invalidation (codex P1, PR #3304 — generation-rework GH round): a
      // transient context failure (customer_lookup_unavailable,
      // no_usable_transcript, a thrown build) proves nothing about the
      // conflict, and replaying the OBSOLETE queued verdict would archive
      // every current draft — including a valid replacement a newer pass
      // composed after re-qualifying the call. DEFER instead: the queue
      // entry itself keeps every creator and public guard failing closed
      // ('call_quarantine_pending') until a sweep can actually re-verify.
      const reObserved = ['email_matches_existing_customer', 'email_identity_conflict']
        .includes(freshContext?.error);
      if (!reObserved) continue;
    }
    const outcome = await invalidateDraftForCall(row.id, {
      reason: pending.reason,
      identityConflict,
      // Fence the REPLAY to the generation this sweep OBSERVED settled
      // (codex P1, GH round on a6c3a5c5c): between the settled read /
      // re-observation above and this write, a force-reprocess can claim
      // generation N+1 and re-qualify the call — an unfenced replay would
      // stamp the obsolete verdict and archive the newer pass's
      // replacement drafts. A fence miss reports ownershipLost and the
      // queue entry is KEPT: the next sweep re-verifies against the new
      // generation (and its in-flight check defers while N+1 runs).
      ownershipFence: live.processing_generation != null
        ? { callLogId: row.id, procGeneration: Number(live.processing_generation) }
        : null,
    });
    if (!outcome.ok) continue;
    if (outcome.ownershipLost) continue;
    try {
      const clearedRows = await clearQuarantineMarker(row.id, pending);
      if (!clearedRows) continue;
      cleared += 1;
      logger.info(`[estimator-engine] drained a queued quarantine for call ${row.id} (${pending.reason})`);
    } catch (clearErr) {
      logger.warn(`[estimator-engine] quarantine marker clear failed for call ${row.id}: ${clearErr.message}`);
    }
  }
  return cleared;
}

// Bounded retry around the forced invalidation (codex P0, PR #3304 GH
// r8c): the estimator runs detached, so a transient DB failure would
// otherwise leave the wrong-identity or rejected draft live with no
// scheduled retry. Three attempts; the operation is idempotent (it skips
// an already-marked row), and the caller still fails closed if all miss.
async function invalidateDraftForCallWithRetry(callLogId, options, attempts = 3) {
  let last = { ok: false, invalidated: false, error: 'not_attempted' };
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
     
    last = await invalidateDraftForCall(callLogId, options);
    if (last.ok) return last;
  }
  return last;
}

// existingDraftForCall's error-tolerant sibling for the paths where a
// lookup failure must NOT read as "no draft" (codex P0, PR #3304 GH r8c).
// Same predicate: this call's draft, not archived, not already invalidated.
async function strictExistingDraftForCall(callLogId) {
  return db('estimates')
    .whereRaw("estimate_data #>> '{estimatorEngine,callLogId}' = ?", [String(callLogId)])
    // ARCHIVED rows included (codex P0, PR #3304 GH r8c): an
    // operator-archived draft keeps a PERMANENT public token, and
    // /unarchive rejects only MARKED rows — so an unmarked wrong-identity
    // or rejected-call draft could be revived and served again. The
    // invalidation preserves whatever archive state it finds
    // (`fresh.archived_at || new Date()`), so marking one is safe.
    .whereRaw("COALESCE(estimate_data->'estimatorEngine'->>'linkage_invalidated_at', '') = ''")
    // EVERY row, oldest first — a deterministic order for the per-row
    // locks taken below.
    .orderBy('created_at', 'asc')
    .select('id', 'status', 'estimate_data');
}

async function maybeDraftEstimateForCall({ callLogId, dryRun = false, refreshLookup = false, quotePromised = true, ownerProcToken = null, ownerProcGeneration = null }) {
  const result = { callLogId, dryRun, lane: null, created: false };
  let context = null;
  // This pass's ordering stamp: markers written after it began belong to
  // a newer verdict and are never cleared by it. The wall-clock instant
  // fences generation-less legacy markers; ownerProcGeneration (the claim
  // that launched this composer) fences generation-stamped ones.
  const passStartedAt = new Date().toISOString();
  try {
    context = await buildCallContext(callLogId);
    // The caller's own processing claim rides the context so the creators'
    // in-lock fences can tell it apart from a competing reprocess — the
    // generation is the arm that stays valid after that claim finalizes.
    if (context && ownerProcToken) context.ownerProcToken = ownerProcToken;
    if (context && ownerProcGeneration != null) context.ownerProcGeneration = ownerProcGeneration;
    // A CONCLUSIVELY clean context retires the call-side conflict verdict.
    if (!dryRun && context && !context.error) {
      await clearDraftBlockOnCall(callLogId, { notNewerThan: passStartedAt, generation: ownerProcGeneration });
    }
    if (context.error) {
      result.lane = LANES.RED;
      result.reasons = [context.error];
      let quarantineOutcome = null;
      // A POSITIVE identity conflict QUARANTINES the same-call draft
      // (codex P0, PR #3304 r19): the prior draft may target the
      // conflicting identity, and returning with only a review bell left
      // it sendable with a live public token. Same marked-archive as the
      // linkage invalidation, so every guard (unarchive 409, send claims,
      // duplicate exclusion) applies; the audit reason rides along.
      if (!dryRun && ['email_matches_existing_customer', 'email_identity_conflict'].includes(context.error)) {
        quarantineOutcome = await invalidateDraftForCallWithRetry(callLogId, {
          reason: context.error,
          identityConflict: true,
          // A stale run must not stamp a block or archive the drafts of
          // the pass that RECLAIMED this call (codex P0, PR #3304 GH r8h);
          // the generation arm keeps this fence valid after our own pass
          // finalizes (the composer runs detached). A generation WITHOUT a
          // token (booking pre-draft adopting a settled call's generation)
          // fences the same way (codex P1, GH round on a6c3a5c5c).
          ownershipFence: (ownerProcToken || ownerProcGeneration != null)
            ? { callLogId, procToken: ownerProcToken || null, procGeneration: ownerProcGeneration ?? null }
            : null,
        });
      }
      // A context failure means NO reconciliation ran for whatever draft
      // this call already has (pre-push P0, PR #3304): on a quote-flavored
      // retry, returning RED here left the FORMER lead's draft and its
      // public token live indefinitely — the processor's fallback pass only
      // fires on the non-drafting branch. Queue the durable reconcile
      // retry: the sweep's reconcileDraftLinksForCall degrades to the
      // linkage-only fallback context when the full context still fails,
      // so the stale draft is corrected even if this error never clears.
      // Identity conflicts are excluded — their quarantine above IS the
      // (stronger) reconciliation.
      if (!dryRun && !['email_matches_existing_customer', 'email_identity_conflict'].includes(context.error)) {
        await markReconcilePending(callLogId);
      }
      if (!dryRun && context.call && quotePromised) {
        await notify({
          call: context.call,
          context,
          lane: LANES.RED,
          quotePromised,
          title: 'Quote promised on call — send it',
          body: 'A quote was promised on a call the estimator engine could not read '
            + `(${context.error}). Review the call and send the estimate manually.`,
          // An identity conflict must REPLACE a prior ready-to-send
          // notification for the same call (codex P1, PR #3304 r21):
          // without forceUpdate the dedupe keeps the old title + stale
          // draft link and the operator never sees the conflict.
          forceUpdate: ['email_matches_existing_customer', 'email_identity_conflict'].includes(context.error),
        });
      }
      // FAIL CLOSED on a quarantine that did not persist (codex P0, PR
      // #3304 GH r8c): continuing would report the pass as handled while
      // the conflicting draft and its bearer token stay live, with no
      // later reconcile scheduled. The RED review bell above has already
      // fired, so the operator still sees the call; the throw is what
      // makes the failure visible and retryable.
      if (quarantineOutcome && !quarantineOutcome.ok) {
        const qFail = new Error(`identity-conflict quarantine failed for call ${callLogId}: ${quarantineOutcome.error || 'unknown'}`);
        qFail.quarantineFailed = true;
        throw qFail;
      }
      return result;
    }

    if (!dryRun) {
      const existing = await existingDraftForCall(callLogId);
      if (existing) {
        // Stale-linkage reconciliation (codex P1, PR #3304) — shared with
        // the duplicate-guard exit below, where a corrected retry that
        // lost the insert race to a stale detached run lands instead. An
        // INVALIDATED draft (durable repoint — its content was composed
        // from the old lead) does NOT short-circuit: existingDraftForCall
        // excludes it from now on, and this run rebuilds from the
        // corrected context (codex P0 r8).
        const reconcileOutcome = await reconcileExistingDraftLinks(existing, context);
        if (reconcileOutcome === 'error') {
          // Fail CLOSED (codex P1, PR #3304 r11): the failed reconcile
          // may have hidden a durable repoint, and surfacing this draft
          // risks the exact wrong-recipient exposure the reconcile
          // protects against. Manual review instead.
          result.lane = LANES.RED;
          result.reasons = ['existing-draft reconciliation unavailable'];
          if (quotePromised) {
            await notify({
              call: context.call,
              context,
              lane: LANES.RED,
              quotePromised,
              title: 'Quote promised on call — review the existing draft',
              body: 'A draft exists for this call but its lead linkage could not be verified '
                + '(reconciliation unavailable). Review the call and the draft in admin/estimates before sending.',
              forceUpdate: true,
            });
          }
          return result;
        }
        if (reconcileOutcome !== 'invalidated') {

        result.lane = 'existing';
        result.reasons = ['draft already exists for this call'];
        result.estimateId = existing.id;
        // A prior run can have created the draft but failed to notify — with
        // the generic quote-promised bells suppressed behind the gate, that
        // would leave a silent draft forever. notify() dedupes internally,
        // so this is a no-op when the bell already rang.
        const existingMeta = (() => {
          try {
            const data = typeof existing.estimate_data === 'string'
              ? JSON.parse(existing.estimate_data) : existing.estimate_data;
            return {
              lane: data?.estimatorEngine?.lane || 'yellow',
              commercialProposal: data?.estimatorEngine?.commercialProposal === true,
            };
          } catch { return { lane: 'yellow', commercialProposal: false }; }
        })();
        if (existingMeta.commercialProposal) {
          // A proposal scaffold recovered on re-entry must keep its proposal
          // semantics: the generic draft bell would read "$0/mo" (the row is
          // deliberately unpriced) and link the estimates list instead of
          // the proposal builder.
          await notify({
            call: context.call,
            context,
            lane: existingMeta.lane,
            quotePromised,
            estimateId: existing.id,
            link: `/admin/estimates/${existing.id}/proposal`,
            title: CALL_ORIGIN.strings.proposalTitle,
            body: CALL_ORIGIN.strings.proposalBody(callerLabel(null, context)),
          });
          return result;
        }
        await notify({
          call: context.call,
          context,
          lane: existingMeta.lane,
          quotePromised,
          estimateId: existing.id,
          title: `AI estimate draft ${existingMeta.lane === 'green' ? 'ready' : 'needs review'} — ${draftAmountLabel({ monthly: existing.monthly_total, oneTime: existing.onetime_total })}`,
          body: `${callerLabel(null, context)}: an estimate draft from this call is waiting (${String(existingMeta.lane).toUpperCase()}). Review in admin/estimates and send.`,
        });
        return result;
        }
      }
    }
  } catch (err) {
    logger.error(`[estimator-engine] unexpected failure: ${err.message}`);
    // A failed identity QUARANTINE is not an ordinary engine error (codex
    // P0, PR #3304 GH r8c): degrading it to a RED result would report the
    // pass as handled while the wrong-identity draft and its bearer link
    // stay public and sendable. Its own RED bell already fired inside the
    // branch, so rethrow — the caller's failure path is the durable
    // signal, and the next call pass re-quarantines through the
    // reconcile-only entry (which now also runs on terminal verdicts).
    if (err.quarantineFailed) throw err;
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

    const initialParcelOk = parcelSignalsDescribeGatheredAddress({ enriched, propertyRecord });
    let propertyFacts = resolvePropertyFacts({
      extraction: context.extraction,
      propertyRecord: initialParcelOk ? propertyRecord : null,
      parcelView: initialParcelOk ? parcelView : null,
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

    // Wrong-premise parcel signals (global flag / snapped record) are
    // stripped here exactly as in the pre-compose arbitration — the
    // re-gathered signals carry their OWN audit, so a corrected address is
    // judged on its own lookup, not the original one's.
    const effectiveParcelOk = parcelSignalsDescribeGatheredAddress(effectiveSignals);
    propertyFacts = resolvePropertyFacts({
      // Caller-stated facts (extraction) describe the property discussed on
      // THIS call — they stay.
      extraction: context.extraction,
      propertyRecord: effectiveParcelOk ? effectiveSignals.propertyRecord : null,
      parcelView: effectiveParcelOk ? effectiveSignals.parcelView : null,
      customer: profileDescribesQuotedProperty ? trustedCustomer : null,
      isCommercial: intent.is_commercial,
      // Deliberately NOT stripped: the subdivision median is
      // neighborhood-level (a snap lands on the same street), and facts
      // sized from it carry a fallback source that already routes the
      // draft to review.
      subdivisionMedian: effectiveSignals.subdivisionMedian,
    });
    result.propertyFacts = propertyFacts;

    // Property Facts V2 — scoped measurement selection. Shadow by default:
    // computed and stored on the draft for evaluation, never priced from
    // until GATE_PROPERTY_FACTS_V2 flips. Fail-open (returns null on error).
    // Gate ON: applyV2ToPropertyFacts follows the V2 selection — including
    // CLEARING the V1 area when V2 deliberately left an ambiguous scope
    // unresolved (an arbitrary building must not auto-price).
    const { computePropertyFactsV2Shadow, propertyFactsV2Enabled, applyV2ToPropertyFacts } = require('./property-facts-shadow');
    const propertyFactsV2 = computePropertyFactsV2Shadow({
      // Same wrong-premise strip as V1 arbitration — with the V2 gate ON,
      // applyV2ToPropertyFacts would otherwise re-adopt the snapped parcel.
      propertyRecord: effectiveParcelOk ? effectiveSignals.propertyRecord : null,
      extraction: context.extraction,
      intent,
      propertyFacts,
      address: intent.address || result.addressUsed || address,
    });
    result.propertyFactsV2 = propertyFactsV2;
    if (propertyFactsV2 && propertyFactsV2Enabled()) {
      applyV2ToPropertyFacts(propertyFacts, propertyFactsV2);
    }

    // Unit-scope model (GATE_UNIT_SCOPE_GUARDRAILS): first-class
    // propertyUse × serviceScope × customerRelationship × sizeBasis so a
    // unit tenant, an association, and a whole-property owner stop sharing
    // one overloaded propertyType (owner ruling 2026-08-11). Always
    // computed and stored (audit); gate ON additionally marks a unit's
    // absent lot NOT APPLICABLE so classifyLane stops flagging a lot the
    // property doesn't have. Fail-open: a model failure never sinks a draft.
    try {
      const {
        unitScopeGuardrailsEnabled, resolveUnitScopeModel, applyUnitScopeToPropertyFacts,
        commercialCategoryConflict, lookupCategoryConflict,
      } = require('./unit-scope-model');
      // The cross-property fence applies only when the composer quoted a
      // genuinely DIFFERENT property. addressRegathered also fires on
      // same-property refinements — no prior gathered address at all, or
      // the same street gaining city/ZIP (addressAddsLocality) — where the
      // extraction still describes the quoted property and discarding its
      // signals would bypass the category guard (codex r6 P1: a condo
      // common-area extraction that merely added locality kept residential
      // pricing). Only a street-level mismatch means another property
      // (codex r4 P1: a primary-address tenant extraction must not
      // classify a different quoted property, or clear its real lot).
      const crossPropertyRegather = addressRegathered
        && !!address && !sameStreetAddress(intent.address, address);
      const unitScope = resolveUnitScopeModel({
        propertyRecord: effectiveParcelOk ? effectiveSignals.propertyRecord : null,
        extraction: crossPropertyRegather ? null : context.extraction,
        intent,
        propertyFacts: crossPropertyRegather ? { ...propertyFacts, tenant: false } : propertyFacts,
        address: intent.address || result.addressUsed || address,
      });
      if (crossPropertyRegather) unitScope.crossPropertyExtraction = true;
      propertyFacts.unitScope = unitScope;
      result.unitScope = unitScope;
      // Category-conflict signal, resolved HERE where the re-gather is
      // known (codex r3 P1): when the composer quoted a DIFFERENT
      // property, the primary extraction must neither red-lane the quoted
      // one (commercial primary, residential secondary) nor is it evidence
      // about it; the re-gathered lookup's own signals carry the quoted
      // property's category. classifyLane consumes the stamp.
      // On a cross-property re-gather the primary extraction is not
      // evidence — but the re-gathered lookup's OWN classification is: a
      // residential intent quoting a property the lookup typed COMMERCIAL
      // must still conflict (codex r8 P1: the unconditional null let a
      // residential intent survive for a secondary office/warehouse).
      // detectCategory types EVERY apartment/multifamily record COMMERCIAL
      // (it answers the whole-property question), so a residential-unit
      // scope must be exempt or a valid second-property apartment quote
      // would always red-lane (codex r13 P2) — the exact conflation this
      // lane exists to end: a unit tenant is a residential customer.
      // The LOOKUP's own verdict on the quoted property, applied on BOTH
      // paths (codex r14 P1: the primary path checked only the extraction,
      // so a county-typed office/warehouse with a residential-or-unknown
      // extraction slipped through). The residential-unit exemption is
      // decided by the VERDICT's own subtype/source, not the scope label
      // alone — see lookupCategoryConflict (codex r15/r16 P1s).
      const lookupConflict = effectiveParcelOk
        ? lookupCategoryConflict({
          isCommercialIntent: intent.is_commercial,
          enrichedCategory: effectiveSignals.enriched?.category,
          commercialSubtype: effectiveSignals.enriched?.commercialSubtype,
          commercialDetectionSource: effectiveSignals.enriched?.commercialDetectionSource,
          serviceScope: unitScope.serviceScope,
        })
        : null;
      propertyFacts.categoryConflict = crossPropertyRegather
        ? lookupConflict
        : (commercialCategoryConflict({ extraction: context.extraction, intent })
          || lookupConflict);
      // The lot-clearing mutation runs on BOTH paths: the cross-property
      // fence already lives at the model's INPUT (extraction nulled,
      // tenancy suppressed above), so any unit scope the model still
      // infers comes from the QUOTED property's own evidence — its
      // re-gathered record and composed address. Skipping the apply there
      // let a second-property Unit/Suite quote keep the master-parcel lot
      // (codex r10 P1, refining the r4 fence).
      if (unitScopeGuardrailsEnabled()) {
        applyUnitScopeToPropertyFacts(propertyFacts, unitScope);
      }
    } catch (err) {
      logger.warn(`[estimator-engine] unit-scope model failed: ${err.message}`);
    }

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
      // Stamp what ACTUALLY fed pricing (gate ON only — the kill switch
      // must restore the previous lane behavior exactly, codex r1 P2): a
      // residential draft parks for review when the type that reached the
      // pest pricer is 'unknown' OR outside the pricer's own alias
      // vocabulary (it silently defaults those to single_family — checked
      // via its normalizer, never a literal-string list, codex r1 P1), OR
      // the raw extraction/lookup type is a multifamily/apartment family
      // that pricingSafePropertyType's substring match collapsed into
      // 'single_family' (the '…family…' regex swallows 'multi_family' —
      // the exact silent default the motivating apartment draft hit).
      try {
        const { unitScopeGuardrailsEnabled } = require('./unit-scope-model');
        if (unitScopeGuardrailsEnabled() && !intent.is_commercial) {
          const { normalizePestPropertyType } = require('../pricing-engine/service-pricing');
          // The raw source that actually SUPPLIED engineInput.propertyType,
          // in the exact precedence the pricing chain uses: the lookup
          // record first (resolvePropertyFacts prefers it over the
          // extraction — codex r4 P1: extraction-first here let a
          // multifamily lookup priced single-family stay green), then the
          // extraction, then the matched profile (buildEngineInput's
          // fallback — codex r3 P1: customers.property_type='multifamily'
          // collapses through pricingSafePropertyType's /family/ branch
          // exactly like the others).
          const rawType = String(
            (effectiveParcelOk ? effectiveSignals.propertyRecord?.propertyType : '')
            || context.extraction?.property?.property_type
            || (profileDescribesQuotedProperty ? trustedCustomer?.property_type : '')
            || '',
          ).toLowerCase();
          const meta = normalizePestPropertyType(engineInput.propertyType);
          const multiCollapsed = /multi.?family|apartment/.test(rawType)
            && meta.propertyType === 'single_family';
          if (engineInput.propertyType === 'unknown'
            || meta.propertyTypeWasDefaulted
            || multiCollapsed) {
            propertyFacts.propertyTypeUnresolved = true;
          }
        }
      } catch (err) {
        logger.warn(`[estimator-engine] property-type stamp failed: ${err.message}`);
      }
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
    const { lane, reasons, causes = [] } = (engineResult || !draftable)
      ? classifyLane({ intent, propertyFacts, engineResult, totals, comps, calibration, context })
      : { lane: LANES.RED, reasons: ['pricing engine failed for the selected services'] };
    result.lane = lane;
    result.reasons = reasons;
    result.engineResult = dryRun ? engineResult : undefined;

    if (dryRun) return result;

    if (lane === LANES.RED) {
      // Commercial/HOA proposal lane (GATE_ESTIMATOR_COMMERCIAL_PROPOSALS,
      // default OFF): the relationship-quote red produces a prospect
      // research brief + unpriced proposal scaffold instead of a bell-only
      // dead end. Routed on classifyLane's machine-readable CAUSE, not the
      // raw commercial predicate — a commercial property that redded for an
      // unrelated reason (no line items, pricing failure) must keep the
      // standard red + clarify path. Strictly fail-soft — any miss (gate
      // off, no address, duplicate block, insert failure) falls through to
      // the standard red path below, so the owed-quote bell can never be
      // lost to this lane.
      try {
        const { commercialProposalsEnabled, maybeBuildCommercialProposalDraft } = require('./commercial-proposal');
        if (commercialProposalsEnabled() && causes.includes('commercial_relationship_quote')) {
          const proposalOutcome = await maybeBuildCommercialProposalDraft({
            intent,
            propertyFacts,
            // Same wrong-premise strip as the arbitration passes above — the
            // proposal brief and building-count scaffold must not be
            // composed from a snapped neighboring parcel either.
            parcelView: effectiveParcelOk ? effectiveSignals.parcelView : null,
            propertyRecord: effectiveParcelOk ? effectiveSignals.propertyRecord : null,
            context,
            origin,
            model,
            reasons,
          });
          if (proposalOutcome?.created) {
            result.created = true;
            result.estimateId = proposalOutcome.estimateId;
            result.commercialProposal = true;
            // Unconditional like the created-draft bell below — an artifact
            // now exists either way; the scaffold deep-links the builder.
            await notify({
              call: context.call,
              context,
              lane,
              quotePromised,
              threadKey,
              estimateId: proposalOutcome.estimateId,
              link: `/admin/estimates/${proposalOutcome.estimateId}/proposal`,
              title: S.proposalTitle,
              body: S.proposalBody(callerLabel(intent, context)),
            });
            return result;
          }
          let commercialOutcome = proposalOutcome;
          if (commercialOutcome?.blocked && !dryRun && context?.call?.id) {
            // Same late-race handling as the residential path (codex P1,
            // PR #3304 r10): a stale composer committing after the
            // corrected retry's initial check blocks it here — reconcile
            // the same-call blocker and retry ONCE when invalidated.
            const lateExisting = await existingDraftForCall(context.call.id);
            const lateOutcome = lateExisting ? await reconcileExistingDraftLinks(lateExisting, context) : null;
            if (lateOutcome === 'error') {
              // Fail CLOSED (codex P1, PR #3304 r12) — same rule as the
              // residential branch.
              result.lane = LANES.RED;
              result.reasons = ['existing-draft reconciliation unavailable'];
              if (quotePromised) {
                await notify({
                  call: context.call,
                  context,
                  lane: LANES.RED,
                  quotePromised,
                  threadKey,
                  title: 'Quote promised — review the existing draft',
                  body: 'A draft blocks this proposal but its lead linkage could not be verified '
                    + '(reconciliation unavailable). Review the call and the draft in admin/estimates before sending.',
                  forceUpdate: true,
                });
              }
              return result;
            }
            if (lateOutcome === 'invalidated') {
              commercialOutcome = await maybeBuildCommercialProposalDraft({
                intent,
                propertyFacts,
                parcelView: effectiveSignals.parcelView,
                propertyRecord: effectiveSignals.propertyRecord,
                context,
                origin,
                model,
                reasons,
              });
              if (commercialOutcome?.created) {
                result.created = true;
                result.estimateId = commercialOutcome.estimateId;
                result.commercialProposal = true;
                await notify({
                  call: context.call,
                  context,
                  lane,
                  quotePromised,
                  threadKey,
                  estimateId: commercialOutcome.estimateId,
                  link: `/admin/estimates/${commercialOutcome.estimateId}/proposal`,
                  title: S.proposalTitle,
                  body: S.proposalBody(callerLabel(intent, context)),
                });
                return result;
              }
            }
          }
          if (commercialOutcome?.blocked) {
            // Mirror the created-draft blocked path below: an open estimate
            // already covers this prospect, and the generic red "send it
            // manually" bell would prompt the operator to build a duplicate.
            result.blocked = true;
            if (quotePromised) {
              await notify({
                call: context.call,
                context,
                lane,
                quotePromised,
                threadKey,
                estimateId: commercialOutcome.existingEstimateId || null,
                title: S.blockedTitle,
                body: S.blockedBody(callerLabel(intent, context)),
              });
            }
            return result;
          }
        }
      } catch (proposalErr) {
        logger.warn(`[estimator-engine] commercial proposal lane failed (red bell takes over): ${proposalErr.message}`);
      }
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
        // Ask-the-customer loop (GATE_ESTIMATE_CLARIFY_ASKS): the two
        // machine-readable red causes are askable — park an approval-gated
        // clarifying SMS ALONGSIDE the operator bell, never instead of it.
        // Fail-soft: a clarify hiccup must not change the red-lane result.
        if (!dryRun) {
          try {
            const missing = [];
            // A NONEMPTY but numberless address (incomplete_address red)
            // needs the same ask as a missing one — without this the
            // machine-readable cause stalled with only an operator bell
            // (codex r8 P1).
            if (!intent.address || causes.includes('incomplete_address')) missing.push('street_address');
            if (!Object.keys(intent.services || {}).length) missing.push('specific_service');
            // Scope guards: a skip with nothing to clarify must not text
            // the customer a which-service question — out-of-scope work
            // (power washing), non-quotes, and existing-job coordination
            // are indistinguishable from "ambiguous" by the empty services
            // object alone; skip_category is the composer's disambiguator.
            const { scopeGuardsEnabled } = require('./scope-guards');
            // A gated skip with NO category counts as unclarifiable too:
            // the composer retries once to obtain one, so a still-missing
            // category means the model isn't honoring the contract — and
            // the conservative failure mode is "don't text the customer",
            // never "ask a which-service question that may be nonsense".
            const unclarifiableSkip = scopeGuardsEnabled()
              && intent.decision === 'skip'
              && (['out_of_scope', 'not_a_quote', 'existing_job'].includes(intent.skip_category)
                || !intent.skip_category);
            if (missing.length && context.phone && !unclarifiableSkip) {
              const { parkClarifyAsk } = require('../estimate-clarify-asks');
              await parkClarifyAsk({
                missing,
                phone: context.phone,
                firstName: context.lead?.first_name || context.customer?.first_name || null,
                customerId: (!context.customerPhoneAmbiguous && context.customer?.id) || null,
                leadId: (context.leadIsForThisCall && context.lead?.id) || null,
                source: origin.channel === 'sms_thread' ? 'estimator_engine_sms_red' : 'estimator_engine_red',
                // They texted or called Waves from this number themselves.
                channelProvenance: origin.channel === 'sms_thread' ? 'sms' : 'voice',
              });
            }
          } catch (askErr) {
            logger.warn(`[estimator-engine] clarify ask failed: ${askErr.message}`);
          }
        }
      }
      return result;
    }

    let draft = await createDraftEstimate({
      intent, engineInput, engineResult, totals, lane, laneReasons: reasons,
      propertyFacts, propertyFactsV2, comps, calibration, model, call: context.call, context,
      membershipSnapshot, priorQualifyingServices, origin,
    });

    if (draft.blocked && !dryRun && context?.call?.id) {
      // The corrected retry can LOSE the insert race to a stale detached
      // composer (codex P1, PR #3304 r3): it passed existingDraftForCall
      // before the old run committed and lands here via the duplicate
      // guard. Reconcile now that the race is settled — and when the
      // stale draft was INVALIDATED (archived), the blocker is gone:
      // retry the creation ONCE so the corrected content actually lands
      // this run instead of waiting for an external retry (codex P1 r9).
      const lateExisting = await existingDraftForCall(context.call.id);
      if (lateExisting) {
        const lateOutcome = await reconcileExistingDraftLinks(lateExisting, context);
        if (lateOutcome === 'error') {
          // Fail CLOSED, same as the early existing-draft handling
          // (codex P1, PR #3304 r12): telling the operator the blocker
          // validly covers the prospect could stand a wrong-lead draft.
          result.lane = LANES.RED;
          result.reasons = ['existing-draft reconciliation unavailable'];
          if (quotePromised) {
            await notify({
              call: context.call,
              context,
              lane: LANES.RED,
              quotePromised,
              threadKey,
              title: 'Quote promised — review the existing draft',
              body: 'A draft blocks this quote but its lead linkage could not be verified '
                + '(reconciliation unavailable). Review the call and the draft in admin/estimates before sending.',
              forceUpdate: true,
            });
          }
          return result;
        }
        if (lateOutcome === 'invalidated') {
          draft = await createDraftEstimate({
            intent, engineInput, engineResult, totals, lane, laneReasons: reasons,
            propertyFacts, propertyFactsV2, comps, calibration, model, call: context.call, context,
            membershipSnapshot, priorQualifyingServices, origin,
          });
        }
      }
    }

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
      title: `AI estimate draft ${lane === LANES.GREEN ? 'ready' : 'needs review'} — ${draftAmountLabel(totals)}`,
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

// Reconcile-only entry (codex P1, PR #3304 GH r6): a linkage correction
// must invalidate a stale draft even when the current pass is NOT an
// eligible drafting run — the gate is off, the retry no longer reads as
// quote-flavored, or the call is spam-classified. Without this, the
// eligible-run reconcile was the only production call site, and a stale
// draft kept its old lead links and a live public token indefinitely.
// Deliberately runs regardless of GATE_ESTIMATOR_ENGINE: it corrects
// drafts that already exist, it never creates one.
//
// A FAILED context is not a reason to leave a stale draft standing (codex
// P1, PR #3304 GH r7): a positive identity conflict routes to the shared
// quarantine, and any other context error (no_usable_transcript,
// customer_lookup_unavailable, …) falls back to the CALL'S OWN durable
// linkage — sid-owned lead first, then the settled stamp — which is all
// the reconcile needs to decide. The composer-race half of this is closed
// inside the creator's serialized insert (draft-builder re-checks the live
// linkage under the same lock), so a run that started before a correction
// cannot land a stale draft after this pass.
async function reconcileDraftLinksForCall(callLogId) {
  if (!callLogId) return null;
  try {
    // EVERY live same-call row (codex P1, PR #3304 — generation-rework GH
    // round): historical races — duplicates that predate the serialized
    // creator — can leave several uninvalidated estimates carrying this
    // callLogId, and the singular lookup reconciled one arbitrary row
    // while the rest kept permanent public tokens and stale lead links.
    // Same strict enumeration the forced-quarantine path uses; a lookup
    // failure throws to the outer catch, whose 'error' keeps the durable
    // retry marker.
    const existingRows = await strictExistingDraftForCall(callLogId);
    if (!existingRows.length) return null;
    // The generation this reconcile OBSERVES before deciding (codex P1, GH
    // round on a6c3a5c5c — same replay gap as the quarantine sweep): the
    // identity quarantine below must be fenced to it, or a stale
    // reconcile-only pass whose call was since reclaimed and re-qualified
    // would archive the newer pass's valid replacement drafts.
    // NO catch here (codex P1, GH round on 796026122): swallowing a
    // transient SELECT failure into `null` dropped the fence entirely, and
    // an UNFENCED replay is exactly the race this lookup exists to close —
    // a force-reprocess could claim and re-qualify the call after the
    // stale context was read, and this pass would stamp the obsolete
    // conflict over the newer pass's valid drafts. The failure reaches the
    // outer catch instead, whose 'error' keeps the durable reconcile
    // marker for a properly fenced retry. A MISSING row still yields null
    // (the legacy, generation-less shape), which is absence, not failure.
    const observedRow = await db('call_log').where({ id: callLogId }).first('processing_generation');
    const observedGeneration = observedRow?.processing_generation != null
      ? Number(observedRow.processing_generation) : null;
    const context = await buildCallContext(callLogId);
    if (context?.error) {
      if (['email_matches_existing_customer', 'email_identity_conflict'].includes(context.error)) {
        const quarantine = await invalidateDraftForCallWithRetry(callLogId, {
          reason: context.error,
          identityConflict: true,
          ownershipFence: observedGeneration != null
            ? { callLogId, procGeneration: observedGeneration }
            : null,
        });
        // A fence miss is a VERDICT, not success: a newer pass claimed the
        // call after our observation — its own finalization reconciles.
        // 'error' keeps the caller's durable retry marker, so the sweep
        // re-verifies once the newer pass settles.
        if (quarantine.ownershipLost) return 'error';
        // REPLACE the stale bell (codex P1, PR #3304 GH r8): the operator
        // is otherwise left with the prior ready-to-send notification and
        // a link to the draft this pass just archived, with no visible
        // sign of the conflict. Same forceUpdate replacement the full
        // drafting path performs; a notify failure must not undo the
        // quarantine, so it is best-effort.
        try {
          if (context.call) {
            await notify({
              call: context.call,
              context,
              lane: LANES.RED,
              quotePromised: true,
              title: 'Identity conflict on this call — review before sending',
              body: `A caller-identity conflict (${context.error}) invalidated the AI draft for this call. `
                + 'Confirm who the caller is, then quote them manually.',
              forceUpdate: true,
            });
          }
        } catch (bellErr) {
          logger.warn(`[estimator-engine] reconcile-only quarantine bell failed: ${bellErr.message}`);
        }
        // Never REPORT an invalidation that did not persist (codex P0, PR
        // #3304 GH r8c) — 'error' is the caller's fail-closed outcome.
        return quarantine.ok ? 'invalidated' : 'error';
      }
      const fallback = await callLinkageContext(callLogId);
      if (!fallback) return null;
      return await reconcileAllDraftLinks(existingRows, fallback);
    }
    return await reconcileAllDraftLinks(existingRows, context);
  } catch (err) {
    logger.warn(`[estimator-engine] reconcile-only pass failed for call ${callLogId}: ${err.message}`);
    return 'error';
  }
}

// Reconcile every enumerated same-call row; ANY row's 'error' makes the
// whole pass 'error' so the caller's durable retry marker survives and the
// full set is retried (the per-row reconcile is idempotent — a row already
// marked by a peer returns early on its marker).
async function reconcileAllDraftLinks(rows, context) {
  let outcome = null;
  for (const row of rows) {
    const rowOutcome = await reconcileExistingDraftLinks(row, context);
    if (rowOutcome === 'error') outcome = 'error';
    else if (outcome !== 'error' && rowOutcome) outcome = rowOutcome;
  }
  return outcome;
}

// Minimal reconcile context built from the CALL ROW alone — the durable
// linkage the pipeline itself writes, with no transcript, property, or
// customer lookups to fail. Mirrors context-builder's precedence (sid-owned
// lead ordered created_at DESC, then the settled stamp) so a fallback
// reconcile can never disagree with the canonical loader.
async function callLinkageContext(callLogId) {
  const call = await db('call_log').where({ id: callLogId })
    .first('id', 'twilio_call_sid', 'metadata', 'processing_token', 'processing_status');
  if (!call) return null;
  // An in-flight pass owns the linkage — its own finalization reconciles.
  const status = call.processing_status == null ? null : String(call.processing_status).toLowerCase();
  if (call.processing_token != null || status === 'processing') return null;
  const stamped = (() => {
    try {
      const md = typeof call.metadata === 'string' ? JSON.parse(call.metadata) : (call.metadata || {});
      return md?.lead_id ? String(md.lead_id) : null;
    } catch { return null; }
  })();
  let lead = null;
  let linkage = null;
  if (call.twilio_call_sid) {
    lead = await db('leads').where({ twilio_call_sid: call.twilio_call_sid })
      .whereNull('deleted_at').orderBy('created_at', 'desc').first('id', 'twilio_call_sid');
    if (lead) linkage = 'sid';
  }
  if (!lead && stamped) {
    lead = await db('leads').where({ id: stamped }).whereNull('deleted_at').first('id', 'twilio_call_sid');
    if (lead) linkage = 'stamp';
  }
  return {
    call: { id: call.id, twilio_call_sid: call.twilio_call_sid, metadata: call.metadata },
    lead: lead || null,
    leadIsForThisCall: !!lead,
    leadLinkage: linkage,
  };
}

module.exports = {
  _reconcileExistingDraftLinks: reconcileExistingDraftLinks,
  estimatorEngineEnabled,
  maybeDraftEstimateForCall,
  reconcileDraftLinksForCall,
  invalidateDraftForCall: invalidateDraftForCallWithRetry,
  markQuarantinePending,
  sweepPendingQuarantines,
  markReconcilePending,
  sweepPendingReconciles,
  // Origin-specific entries (sms-thread.js) reuse the shared pipeline and
  // bell plumbing instead of re-implementing the lane/notify contract.
  runDraftPipeline,
  notify,
  _private: {
    addressFromContext, commercialHint, gatherPropertySignals, sameStreetAddress, addressAddsLocality,
    parcelSignalsDescribeGatheredAddress,
  },
};
