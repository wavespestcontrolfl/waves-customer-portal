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
        const callRow = context?.call?.id
          ? await trx('call_log').where({ id: context.call.id }).first('twilio_call_sid', 'metadata')
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
            data.estimatorEngine = {
              ...eng,
              invalidation_pending_at: eng.invalidation_pending_at || new Date().toISOString(),
              // The claim release performs the unlink for a deferred
              // quarantine too — it needs the source lead.
              invalidation_pending_from: eng.invalidation_pending_from || quarantinedLeadId,
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
          if (ownershipFence?.procToken) {
            const stillOwned = await trx('call_log')
              .where({ id: ownershipFence.callLogId || callLogId })
              .where('processing_token', ownershipFence.procToken)
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
        if (ownershipFence?.procToken) {
          const owned = await trx('call_log')
            .where({ id: ownershipFence.callLogId || callLogId })
            .where('processing_token', ownershipFence.procToken)
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

// DURABLE retry queue for a quarantine that could not persist (codex P0,
// PR #3304 GH r8d). The estimator runs fire-and-forget, so a transient DB
// outage during an identity conflict or a rejected-call verdict would
// otherwise leave the unmarked draft public and sendable with nothing
// scheduled to try again. The failure is stamped on the CALL row and the
// scheduler sweep below retries it until it lands.
async function markQuarantinePending(callLogId, reason) {
  try {
    await db('call_log').where({ id: callLogId }).update({
      metadata: db.raw(
        "jsonb_set(COALESCE(metadata, '{}'::jsonb), '{estimator_quarantine_pending}', ?::jsonb, true)",
        [JSON.stringify({ reason, at: new Date().toISOString() })],
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
     
    const outcome = await invalidateDraftForCall(row.id, {
      reason: pending.reason,
      identityConflict: String(pending.reason).startsWith('email_'),
    });
    if (!outcome.ok) continue;
    try {
       
      await db('call_log').where({ id: row.id }).update({
        metadata: db.raw("COALESCE(metadata, '{}'::jsonb) - 'estimator_quarantine_pending'"),
        updated_at: new Date(),
      });
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

async function maybeDraftEstimateForCall({ callLogId, dryRun = false, refreshLookup = false, quotePromised = true }) {
  const result = { callLogId, dryRun, lane: null, created: false };
  let context = null;
  try {
    context = await buildCallContext(callLogId);
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
        quarantineOutcome = await invalidateDraftForCallWithRetry(callLogId, { reason: context.error, identityConflict: true });
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

    // Property Facts V2 — scoped measurement selection. Shadow by default:
    // computed and stored on the draft for evaluation, never priced from
    // until GATE_PROPERTY_FACTS_V2 flips. Fail-open (returns null on error).
    // Gate ON: applyV2ToPropertyFacts follows the V2 selection — including
    // CLEARING the V1 area when V2 deliberately left an ambiguous scope
    // unresolved (an arbitrary building must not auto-price).
    const { computePropertyFactsV2Shadow, propertyFactsV2Enabled, applyV2ToPropertyFacts } = require('./property-facts-shadow');
    const propertyFactsV2 = computePropertyFactsV2Shadow({
      propertyRecord: effectiveSignals.propertyRecord,
      extraction: context.extraction,
      intent,
      propertyFacts,
      address: intent.address || result.addressUsed || address,
    });
    result.propertyFactsV2 = propertyFactsV2;
    if (propertyFactsV2 && propertyFactsV2Enabled()) {
      applyV2ToPropertyFacts(propertyFacts, propertyFactsV2);
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
            parcelView: effectiveSignals.parcelView,
            propertyRecord: effectiveSignals.propertyRecord,
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
            if (!intent.address) missing.push('street_address');
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
    const existing = await existingDraftForCall(callLogId);
    if (!existing) return null;
    const context = await buildCallContext(callLogId);
    if (context?.error) {
      if (['email_matches_existing_customer', 'email_identity_conflict'].includes(context.error)) {
        const quarantine = await invalidateDraftForCallWithRetry(callLogId, { reason: context.error, identityConflict: true });
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
      return await reconcileExistingDraftLinks(existing, fallback);
    }
    return await reconcileExistingDraftLinks(existing, context);
  } catch (err) {
    logger.warn(`[estimator-engine] reconcile-only pass failed for call ${callLogId}: ${err.message}`);
    return 'error';
  }
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
  // Origin-specific entries (sms-thread.js) reuse the shared pipeline and
  // bell plumbing instead of re-implementing the lane/notify contract.
  runDraftPipeline,
  notify,
  _private: { addressFromContext, commercialHint, gatherPropertySignals, sameStreetAddress, addressAddsLocality },
};
