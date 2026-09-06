const crypto = require('crypto');
const { isDeepStrictEqual } = require('node:util');
const db = require('../models/db');
const { DELIVERY_CLAIM_NOT_LIVE_SQL, callSideBlockForEstimateData, callReprocessInFlight } = require('../utils/estimate-claim-sql');
const {
  estimateDataHasQuoteRequirement,
  estimateDataHasUnresolvedManagerApproval,
  normalizeEstimateDethatchingManagerApproval,
  validateEstimateDeliveryOptions,
} = require('./estimate-delivery-options');
const {
  attachLeadToEstimate,
  assertLeadCanAttachEstimate,
  leadMatchesEstimateContact,
  normalizeContactPhone,
  normalizeContactEmail,
} = require('./lead-estimate-link');
const { clearEstimatePricingCache } = require('./estimate-pricing-cache');
const { resolveStoredPestPricingVersion } = require('./estimate-pricing-bundle-utils');
const { recordPreSendRevision } = require('./estimate-learning');
const { inferEstimateServiceInterest } = require('./estimate-service-lines');
const logger = require('./logger');
const pricingEngine = require('./pricing-engine');
const { mapV1ToLegacyShape } = require('./pricing-engine/v1-legacy-mapper');
const { loadExistingQualifyingServiceKeys, resolveCustomerQualifyingEvidence, isActivePlanCustomer, isMembershipCustomerRow } = require('./waveguard-existing-services');
const { findCustomersAtAddress } = require('./customer-address-match');
const { computeMembershipContext } = require('./estimate-membership-context');

function errorWithStatus(message, statusCode) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function normalizeLinkedLeadId(leadId) {
  return typeof leadId === 'string' ? leadId.trim() : leadId;
}

function estimateViewUrl(token) {
  return `https://portal.wavespestcontrol.com/estimate/${token}`;
}

// A content witness also catches writers that do not stamp updated_at.
// JSONB is read with stable key ordering by pg; only database rows feed this.
function estimateEditVersion(row) {
  return crypto.createHash('sha256').update(JSON.stringify(row)).digest('hex');
}

// Standard send-time expiry window. Also consumed by the expiration cron
// to tell an operator EXTENSION (expires_at pushed beyond this window)
// apart from the stamp every normal send writes.
const ESTIMATE_SEND_EXPIRY_DAYS = 7;

// Delivery-claim protocol (codex P0, PR #3304 r20). sendEstimateNow stamps
// `estimatorEngine.delivering_at` (+ a per-send `delivering_token`) in the
// SAME locked transaction as its final pre-delivery verdict read, and clears
// it when the send finishes. The linkage reconciler and the identity-conflict
// quarantine refuse to commit an invalidation while a claim is FRESH — that
// closes the window where a marker could commit between the verdict and the
// provider handoff while the delivery still runs on the former lead's
// content. A send that crashes without clearing leaves a claim that simply
// ages out; the TTL bounds how long a crash can defer a correction.
const ESTIMATE_DELIVERY_CLAIM_TTL_MS = 10 * 60 * 1000;


function deliveryClaimFresh(estimatorEngine, nowMs = Date.now()) {
  const at = estimatorEngine?.delivering_at;
  if (!at) return false;
  const t = Date.parse(at);
  return Number.isFinite(t) && (nowMs - t) < ESTIMATE_DELIVERY_CLAIM_TTL_MS;
}

// Complete a DEFERRED linkage invalidation on an ALREADY-LOCKED estimate
// row: the reconciler (or the identity quarantine) recorded
// `invalidation_pending_*` because a delivery claim was live, and this
// applies the real transition. ONE definition, shared by the delivery-claim
// release in admin-estimates.js and the scheduler's stale-claim sweep
// (codex P1, PR #3304 GH r7 — a crash between the marker and the release
// otherwise wedged the estimate forever: sends abort on the pending marker
// with a non-matching token, the former lead stays linked, and no
// corrected rebuild exists).
//
// `row` must come from a FOR UPDATE read carrying status/archived_at, and
// `data` is its parsed estimate_data with the pending keys ALREADY removed
// by the caller (the release also strips its claim keys in the same pass).
// Money-bearing terminals keep status, archive state, and money fields —
// only the marker lands, killing the public token.
async function completePendingInvalidation(trx, estimateId, { row, data, pending }) {
  const eng = data.estimatorEngine && typeof data.estimatorEngine === 'object' ? data.estimatorEngine : {};
  data.estimatorEngine = eng;
  // A LINKAGE-REPOINT verdict can be OBSOLETE by the time it is finalized
  // (codex P2, PR #3304 GH r8): linkage moved A→B during the claim, a
  // second retry moved it back to A, and that later reconcile saw the
  // draft already on its current lead and left the first marker in place.
  // Finalizing then kills a VALID linkage. Re-resolve the call's live
  // linkage against the draft's own: still a match ⇒ the verdict is
  // stale, so drop the marker and keep the row.
  //
  // A FORCED quarantine is never obsolete this way (codex P0, PR #3304 GH
  // r8b): an identity conflict or a spam/voicemail rejection is a verdict
  // about the CALL, not about which lead it points at — linkage legitimately
  // stays unchanged, and treating that as "nothing to do" would leave the
  // wrong or rejected draft public and sendable.
  const forcedQuarantine = !!(pending.conflict || pending.reason);
  // A forced verdict CAN be superseded by a newer processing generation
  // (codex P1, local audit on 3092fbbb8): the spam/identity verdict was
  // deferred behind a delivery claim, then a force-reprocess claimed
  // generation N+1, re-qualified the call, and cleared the call-side
  // verdict — finalizing the stale marker here would archive the valid
  // draft and unlink its lead. Under the call-row lock (leads first,
  // repo-wide estimates → leads → call_log order): a NEWER settled
  // generation whose live verdict is CLEAR downgrades the forced marker
  // to the ordinary obsolete test below; a newer generation still
  // IN FLIGHT defers — the marker goes back on the row and the
  // wedged-invalidation sweep re-attempts once the call settles.
  // Generation-less markers (written before the column deployed) and
  // same-generation markers finalize exactly as before.
  let forcedSuperseded = false;
  // The live generation the supersession judgement was made against —
  // carried to the linkage recheck below so it applies the SAME cutoff.
  let liveGenForRecheck = null;
  const verdictCallId = data?.estimatorEngine?.callLogId || null;
  if (forcedQuarantine && pending.generation != null && verdictCallId) {
    const leadLockIds = [...new Set([data.lead_id, pending.from].filter(Boolean).map(String))].sort();
    for (const leadLockId of leadLockIds) {
      await trx('leads').where({ id: leadLockId }).forUpdate().first('id');
    }
    // created_at is REQUIRED by callReprocessInFlight (codex P1, GH round
    // on 796026122): its extraction_failed arm mirrors the processor's
    // eligibility as attempts-under-cap AND inside the 7-day retry window,
    // and a MISSING timestamp reads as "within the window". Omitting the
    // column therefore made an aged-out row — which production considers
    // settled and will never retry — look forever in-flight, so this
    // deferral restored the pending marker on every sweep and left the
    // estimate and its public token permanently blocked.
    const callRow = await trx('call_log').where({ id: verdictCallId }).forUpdate()
      .first('processing_generation', 'processing_status', 'processing_token',
        'extraction_attempts', 'created_at', 'metadata');
    const liveGen = callRow?.processing_generation != null ? Number(callRow.processing_generation) : null;
    liveGenForRecheck = liveGen;
    if (callRow && liveGen != null && liveGen > Number(pending.generation)) {
      if (callReprocessInFlight(callRow)) {
        restorePendingInvalidation(data, pending);
        await trx('estimates').where({ id: estimateId })
          .update({ estimate_data: JSON.stringify(data), updated_at: trx.fn.now() });
        return { terminal: false, status: String(row.status || '').toLowerCase(), deferred: true };
      }
      // Ask whether the NEWER generation re-rejected the call — not
      // whether generation N's own leftover marker is still lying there
      // (codex P1, GH round on 796026122). N+1 can settle clean through a
      // path that never clears N's estimator_draft_block (reconcile-only:
      // gate off, or no longer quote-flavored), and counting that stale
      // marker as a live rejection kept forcedSuperseded false — so claim
      // release or the wedged sweep archived and unlinked the now-valid
      // draft. Markers at/after liveGen are N+1's own verdict and still
      // count; generation-less markers stay honored (fail closed).
      forcedSuperseded = !(await callRejectedForDrafting(trx, verdictCallId, {
        supersededBelowGeneration: liveGen,
      }));
    }
  }
  if (forcedSuperseded && !data.lead_id) {
    // Superseded forced verdict on a lead-less draft: the newer settled
    // generation's verdict is clear and there is no durable linkage left
    // to compare — the marker is obsolete, the draft stays.
    await trx('estimates').where({ id: estimateId })
      .update({ estimate_data: JSON.stringify(data), updated_at: trx.fn.now() });
    return { terminal: false, status: String(row.status || '').toLowerCase(), obsolete: true };
  }
  if ((!forcedQuarantine || forcedSuperseded) && data.lead_id) {
    // The obsolete-vs-apply decision is made against LOCKED state and the
    // locks are HELD through whichever write follows (codex P1, GH round
    // on a6c3a5c5c): a plain read could observe the call momentarily
    // pointing back at A while another pass repoints it to B before our
    // estimate update commits — discarding the only pending marker
    // against a linkage that no longer holds (or, inverted, applying an
    // invalidation to a re-validated draft). Lock order stays
    // estimates (caller's FOR UPDATE row) → leads → call_log, matching
    // accept/decline; both lead rows this transition can touch are locked
    // up front, in sorted order, so concurrent finalizers can't deadlock
    // each other.
    const leadLockIds = [...new Set([data.lead_id, pending.from].filter(Boolean).map(String))].sort();
    for (const leadLockId of leadLockIds) {
      await trx('leads').where({ id: leadLockId }).forUpdate().first('id');
    }
    // The recheck inherits the supersession cutoff (codex P1, GH round on
    // fe55a83df) — without it, the marker this branch just judged stale
    // came straight back as 'call_draft_block' and archived the draft.
    if (!(await staleCallLinkageReason(trx, data, {
      lockCallRow: true,
      supersededBelowGeneration: forcedSuperseded ? liveGenForRecheck : null,
    }))) {
      await trx('estimates').where({ id: estimateId })
        .update({ estimate_data: JSON.stringify(data), updated_at: trx.fn.now() });
      return { terminal: false, status: String(row.status || '').toLowerCase(), obsolete: true };
    }
  }
  const status = String(row.status || '').toLowerCase();
  const terminal = ['accepted', 'declined', 'expired'].includes(status);
  delete data.lead_id;
  delete data.lead_linkage;
  eng.linkage_invalidated_at = new Date().toISOString();
  eng.linkage_invalidated_from = pending.from || null;
  eng.linkage_invalidated_to = pending.to || null;
  if (pending.conflict) eng.identity_conflict = pending.conflict;
  if (pending.reason) eng.invalidation_reason = pending.reason;
  await trx('estimates').where({ id: estimateId })
    .update({
      estimate_data: JSON.stringify(data),
      ...(terminal ? {} : {
        archived_at: row.archived_at || new Date(),
        status: 'draft',
        scheduled_at: null,
      }),
      updated_at: trx.fn.now(),
    });
  if (pending.from) {
    // Only if the OLD lead still points at this draft — a lead relinked
    // elsewhere is not ours to touch.
    await trx('leads').where({ id: pending.from, estimate_id: estimateId }).update({ estimate_id: null });
  }
  return { terminal, status };
}

// Read the pending-invalidation keys off a parsed estimate_data blob and
// REMOVE them (the transition replaces them with the full marker).
function takePendingInvalidation(data) {
  const eng = data?.estimatorEngine;
  if (!eng || typeof eng !== 'object' || !eng.invalidation_pending_at) return null;
  const pending = {
    at: eng.invalidation_pending_at,
    from: eng.invalidation_pending_from || null,
    to: eng.invalidation_pending_to || null,
    conflict: eng.invalidation_pending_conflict || null,
    // Forced-quarantine reason (spam/voicemail rejection and any future
    // non-identity force) — dropping it lost both the audit trail and the
    // signal that this verdict is not a linkage repoint (codex P0, PR
    // #3304 GH r8b).
    reason: eng.invalidation_pending_reason || null,
    // The processing generation the deferring verdict OBSERVED (codex P1,
    // local audit on 3092fbbb8) — lets the finalizer detect a forced
    // verdict superseded by a newer pass's re-qualification.
    generation: eng.invalidation_pending_generation != null
      ? Number(eng.invalidation_pending_generation) : null,
  };
  delete eng.invalidation_pending_at;
  delete eng.invalidation_pending_from;
  delete eng.invalidation_pending_to;
  delete eng.invalidation_pending_conflict;
  delete eng.invalidation_pending_reason;
  delete eng.invalidation_pending_generation;
  return pending;
}

// Inverse of takePendingInvalidation — used when the finalizer must DEFER
// (a newer processing generation is mid-flight): the marker goes back on
// the row so the wedged-invalidation sweep re-attempts once the call
// settles, and every send/accept guard keeps failing closed on it.
function restorePendingInvalidation(data, pending) {
  const eng = data.estimatorEngine && typeof data.estimatorEngine === 'object' ? data.estimatorEngine : {};
  data.estimatorEngine = eng;
  eng.invalidation_pending_at = pending.at;
  if (pending.from) eng.invalidation_pending_from = pending.from;
  if (pending.to) eng.invalidation_pending_to = pending.to;
  if (pending.conflict) eng.invalidation_pending_conflict = pending.conflict;
  if (pending.reason) eng.invalidation_pending_reason = pending.reason;
  if (pending.generation != null) eng.invalidation_pending_generation = pending.generation;
}

// Sweep estimates wedged on a pending invalidation whose delivery claim is
// GONE or aged past the TTL — the crash case the claim release can no
// longer reach (codex P1, PR #3304 GH r7). Runs from the scheduler's
// stale-claim recovery. Returns the number of rows finalized.
async function sweepWedgedPendingInvalidations(nowMs = Date.now(), { limit = 100 } = {}) {
  let candidates = [];
  try {
    candidates = await db('estimates')
      // A wedged PENDING invalidation, or a DEAD claim with no marker at
      // all (codex P1, PR #3304 GH r8d): a process that died between
      // stamping delivering_at and recording anything left keys that every
      // whole-blob write refuses. The TTL arm makes those writes fall
      // through on their own, and this clears the residue.
      .where(function wedged() {
        this.whereRaw("COALESCE(estimate_data->'estimatorEngine'->>'invalidation_pending_at', '') <> ''")
          .orWhereRaw("COALESCE(estimate_data->'estimatorEngine'->>'delivering_at', '') <> ''");
      })
      .whereRaw("COALESCE(estimate_data->'estimatorEngine'->>'linkage_invalidated_at', '') = ''")
      .orderBy('updated_at', 'asc')
      .limit(limit)
      .select('id');
  } catch (err) {
    logger.warn(`[estimates] wedged pending-invalidation scan failed: ${err.message}`);
    return 0;
  }
  let finalized = 0;
  for (const candidate of candidates) {
    try {
       
      const done = await db.transaction(async (trx) => {
        const row = await trx('estimates').where({ id: candidate.id }).forUpdate()
          .first('id', 'status', 'archived_at', 'estimate_data');
        if (!row) return false;
        let data;
        try {
          data = typeof row.estimate_data === 'string'
            ? JSON.parse(row.estimate_data) : (row.estimate_data || {});
        } catch { return false; }
        if (!data || typeof data !== 'object') return false;
        const eng = data.estimatorEngine;
        if (!eng || eng.linkage_invalidated_at) return false;
        // A FRESH claim means the owning send is still running and will
        // finalize this itself — only a dead claim is ours to complete.
        if (deliveryClaimFresh(eng, nowMs)) return false;
        const pending = takePendingInvalidation(data);
        const hadDeadClaim = !!eng.delivering_at;
        delete eng.delivering_at;
        delete eng.delivering_token;
        if (!pending) {
          // Dead claim, nothing pending: just clear the residue so the
          // ordinary edit paths unblock.
          if (!hadDeadClaim) return false;
          await trx('estimates').where({ id: candidate.id })
            .update({ estimate_data: JSON.stringify(data), updated_at: trx.fn.now() });
          return false;
        }
        const outcome = await completePendingInvalidation(trx, candidate.id, { row, data, pending });
        // deferred = a newer processing generation is mid-flight; the
        // marker went back on the row and a later sweep re-attempts.
        return !outcome.obsolete && !outcome.deferred;
      });
      if (done) {
        finalized += 1;
        logger.warn(`[estimates] finalized a wedged pending invalidation on estimate ${candidate.id} (delivery claim died before its release)`);
      }
    } catch (err) {
      logger.warn(`[estimates] wedged pending-invalidation finalize failed for ${candidate.id}: ${err.message}`);
    }
  }
  return finalized;
}

// call_log.processing_status values that mean a pass is RUNNING or queued
// to run again. Everything else with a cleared processing_token is a
// settled verdict — including the permanent failure terminals.
//
// 'extraction_failed' is in-flight only while the processor would actually
// retry it (codex P1, PR #3304 GH r7b): its sweep requires
// COALESCE(extraction_attempts,0) < CALL_EXTRACTION_MAX_ATTEMPTS, so an
// EXHAUSTED row is settled — treating it as forever-retrying would block
// send, accept, and decline on that draft permanently. Same env default as
// the processor (3) so the two can't drift silently.
// RUNNING, or QUEUED for another pass by processAllPending's sweep — which
// re-processes 'pending' and 'no_transcription' rows as well as the active
// 'processing' claim (codex P1, PR #3304 GH r8c). A legacy NULL status
// stays SETTLED: those are pre-pipeline rows with no retry lane, and
// blocking them would wedge sends on historical estimates.
// callReprocessInFlight now lives in ../utils/estimate-claim-sql (the ONE
// dependency-free in-flight verdict, shared with the public money guard —
// pre-push P0, PR #3304) and is imported above; this module keeps
// re-exporting it so every existing consumer is unchanged.

// Shared live call-linkage revalidation for engine-drafted rows: re-resolve
// the call's current lead with the pipeline's own precedence (sid-owned
// lead first, then the settled stamp) and require it to still be the
// draft's linked lead. Plain reads — no extra locks, and the same
// estimates→(leads/call_log) order the reconciler uses. Returns null when
// the linkage stands (or the row carries no durable linkage), else the
// abort reason.
// A call whose pipeline verdict REJECTED it (spam / non-workable
// voicemail / the durable no-attribution marker) must not receive a new
// draft (codex P0, PR #3304 GH r8e): the terminal path invalidates the
// drafts that exist, but a detached composer can still be running and
// would insert AFTER terminalization — and the linkage check alone permits
// that, because a settled rejection is "not running" and the sid linkage
// is unchanged. Creators call this inside their serialized insert with the
// call row LOCKED, so a rejection either committed first (seen here) or
// waits and its own invalidation pass catches what landed.
// `supersededBelowGeneration`: ignore a DERIVED marker whose recorded
// writer generation is OLDER than this (codex P1, GH round on 796026122).
// The queued/draft-block markers are verdicts of a specific pass, and
// generation N's marker can still be sitting on the row when N+1 settles
// CLEAN through a path that never clears it (the reconcile-only lane: gate
// off, or the call no longer quote-flavored). A caller asking "did the
// NEWER generation re-reject this?" must not read N's leftovers as N+1's
// answer. A marker written AT or AFTER the live generation is N+1's own
// verdict and still counts; a marker with NO generation (pre-column, or
// generation-less maintenance) cannot be proven stale, so it is honored —
// fail closed, matching every other guard on this path.
async function callRejectedForDrafting(dbc, callLogId, {
  lockCallRow = false, ignoreQueuedMarkers = false, supersededBelowGeneration = null,
} = {}) {
  if (!callLogId) return null;
  const q = dbc('call_log').where({ id: callLogId });
  if (lockCallRow) q.forUpdate();
  const row = await q.first('processing_status', 'metadata');
  // A missing row is not a REJECTION verdict — absence is handled by the
  // linkage fence, which fails closed on it for durably linked drafts.
  if (!row) return null;
  const status = String(row.processing_status || '').toLowerCase();
  if (['spam', 'voicemail'].includes(status)) return `call_rejected_${status}`;
  try {
    const md = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : (row.metadata || {});
    if (md?.no_attribution === true) return 'call_rejected_no_attribution';
    // A live IDENTITY-CONFLICT verdict blocks drafting too (codex P0, PR
    // #3304 GH r8f): a detached composer that built its context before the
    // conflict appeared would otherwise insert a wrong-identity draft
    // right after the quarantine swept the existing ones.
    // The queued markers are DERIVED verdicts: the drafting fences must
    // honor them, but the sweep that owns them must NOT read them as
    // proof of the underlying verdict (codex P1, PR #3304 GH r9) — that
    // made its own re-qualification cleanup unreachable.
    if (!ignoreQueuedMarkers) {
      const markerCurrent = (marker) => {
        if (supersededBelowGeneration == null) return true;
        const g = marker?.generation;
        if (g == null) return true;
        return Number(g) >= Number(supersededBelowGeneration);
      };
      if (md?.estimator_draft_block?.reason && markerCurrent(md.estimator_draft_block)) {
        return String(md.estimator_draft_block.reason);
      }
      // A QUEUED quarantine that has not landed yet is equally
      // disqualifying — its estimate-side marker is what failed to write.
      if (md?.estimator_quarantine_pending?.reason && markerCurrent(md.estimator_quarantine_pending)) {
        return String(md.estimator_quarantine_pending.reason);
      }
    }
  } catch { /* unparseable metadata: not a rejection signal */ }
  return null;
}

// `supersededBelowGeneration` has the same meaning here as in
// callRejectedForDrafting, and the linkage recheck needs it for the same
// reason (codex P1, GH round on fe55a83df): once the caller has
// established that a forced verdict was superseded, this recheck must not
// resurrect the very marker that was just judged stale — it would return
// 'call_draft_block', the obsolete test would fail, and the valid draft
// would be archived anyway. Only LEAD-LESS drafts took the caller's early
// return, so the linked-draft path — the production shape — still lost.
async function staleCallLinkageReason(dbc, data, {
  lockCallRow = false, ownerProcToken = null, ownerProcGeneration = null,
  supersededBelowGeneration = null,
} = {}) {
  const linkedLeadId = data?.lead_id ? String(data.lead_id) : null;
  const draftCallLogId = data?.estimatorEngine?.callLogId || null;
  // The CALL-SIDE verdict applies to EVERY engine draft (codex P0, PR
  // #3304 GH r9b) — legacy rows and lead-less drafts carry only a
  // callLogId, and returning early on the missing durable linkage skipped
  // the quarantine markers entirely, leaving those drafts sendable. Only
  // the linkage COMPARISON below needs lead_id + lead_linkage.
  if (!draftCallLogId) return null;
  const durableLinkage = ['sid', 'stamp'].includes(data?.lead_linkage) && !!linkedLeadId;
  // lockCallRow (codex P1, PR #3304 GH r6): inside a money-bearing
  // transaction (accept/decline) the call row is locked FOR UPDATE and
  // HELD through the terminal write — a processor correction (which
  // token-fences under this same row lock) either committed first and is
  // seen here, or waits until the terminal commit and its reconcile then
  // applies the marker-only terminal invalidation. Callers must lock the
  // linked LEAD first (repo-wide leads → call_log order).
  const callQuery = dbc('call_log').where({ id: draftCallLogId });
  if (lockCallRow) callQuery.forUpdate();
  const callRow = await callQuery
    .first('twilio_call_sid', 'metadata', 'processing_token', 'processing_status', 'extraction_attempts', 'created_at', 'processing_generation');
  if (!callRow) return 'invalidated_before_delivery';
  // A reprocess IN FLIGHT means the linkage verdict is about to change —
  // abort; the row is sendable again once the call settles. In-flight is a
  // held claim token or one of the two retry lanes (codex P1, PR #3304 GH
  // r7) — NOT every non-'processed' status: the processor also finishes
  // PERMANENTLY as customer_creation_failed / lead_creation_failed / spam
  // / voicemail / no_transcription with the token cleared, and treating
  // those as forever-reprocessing wedged every send, accept, and decline
  // for a draft the earlier quote-flavored pass had legitimately created.
  // A settled REJECTION still blocks — via the resolution comparison
  // below, which finds no live lead — rather than via this gate.
  // The OWNING pass is not "someone else reprocessing" (codex P1, PR #3304
  // GH r8e): the estimator engine is launched by the call processor while
  // that pass still holds processing_token, so a composition finishing
  // before finalization would otherwise have its own legitimate draft
  // blocked — with no automatic retry, since the call finalizes as
  // processed. A caller that owns the claim passes its token here.
  // CALL-SIDE verdicts FIRST, and for every engine draft (codex P0, PR
  // #3304 GH r8f/r9b): when a quarantine could not write its estimate
  // marker it queues on the CALL, and these paths inspect the estimate
  // only — so the known wrong-identity draft stayed sendable until a
  // scheduler sweep succeeded. Legacy and lead-less drafts carry only a
  // callLogId, so this must precede the durable-linkage bail.
  try {
    const md = typeof callRow.metadata === 'string' ? JSON.parse(callRow.metadata) : (callRow.metadata || {});
    const markerCurrent = (marker) => {
      if (supersededBelowGeneration == null) return true;
      const g = marker?.generation;
      if (g == null) return true;
      return Number(g) >= Number(supersededBelowGeneration);
    };
    if (md?.estimator_draft_block?.reason && markerCurrent(md.estimator_draft_block)) return 'call_draft_block';
    if (md?.estimator_quarantine_pending?.reason && markerCurrent(md.estimator_quarantine_pending)) {
      return 'call_quarantine_pending';
    }
  } catch { /* unparseable metadata: fall through to the linkage compare */ }
  // The REPROCESSING fence applies to every engine draft too (codex P1,
  // PR #3304 GH r10): a legacy or lead-less draft is just as unsafe to
  // send while a retry is actively clearing or repointing its call — the
  // retry has not published its block marker yet, so nothing else would
  // stop it.
  // Owned = the caller's claim token is still live, OR the call is still
  // on the caller's GENERATION — the detached composer's pass finalizes
  // (token cleared) before the composition lands, and the generation is
  // what proves no newer pass has claimed since (PR #3304 — replaces
  // token-NULL interpretation).
  const ownedByCaller = (!!ownerProcToken && callRow.processing_token === ownerProcToken)
    || (ownerProcGeneration != null && callRow.processing_generation != null
      && Number(callRow.processing_generation) === Number(ownerProcGeneration));
  if (!ownedByCaller && callReprocessInFlight(callRow)) {
    return 'call_reprocessing_before_delivery';
  }
  // Everything below is the LINKAGE comparison, which needs a durable
  // linkage to compare against.
  if (!durableLinkage) return null;
  const liveStamp = (() => {
    try {
      const md = typeof callRow.metadata === 'string' ? JSON.parse(callRow.metadata) : (callRow.metadata || {});
      return md?.lead_id ? String(md.lead_id) : null;
    } catch { return null; }
  })();
  let resolvedLeadId = null;
  if (callRow.twilio_call_sid) {
    const sidLead = await dbc('leads')
      .where({ twilio_call_sid: callRow.twilio_call_sid })
      .whereNull('deleted_at')
      // leads.twilio_call_sid carries no unique index — mirror the
      // CANONICAL estimator loader's ordering (context-builder
      // loadLeadForCall: created_at DESC) so this revalidation and the
      // draft's own linkage always name the same owner (codex P1, PR
      // #3304 GH r7). An unordered .first() could pick an older row and
      // either block a valid draft or bless a stale one.
      .orderBy('created_at', 'desc')
      .first('id');
    if (sidLead) resolvedLeadId = String(sidLead.id);
  }
  if (!resolvedLeadId && liveStamp) {
    const stampLead = await dbc('leads').where({ id: liveStamp }).whereNull('deleted_at').first('id');
    if (stampLead) resolvedLeadId = liveStamp;
  }
  if (resolvedLeadId !== linkedLeadId) return 'call_linkage_changed_before_delivery';
  return null;
}


function estimateExpiresAt(now = () => new Date()) {
  const expiresAt = new Date(now().getTime());
  expiresAt.setDate(expiresAt.getDate() + ESTIMATE_SEND_EXPIRY_DAYS);
  return expiresAt;
}

function roundMoney(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function positiveMoney(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? roundMoney(n) : null;
}

function moneyValue(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? roundMoney(n) : null;
}

function nonNegativeMoney(value) {
  const amount = moneyValue(value);
  return amount !== null && amount >= 0 ? amount : null;
}

function fallbackMoney(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? roundMoney(n) : 0;
}

function estimateResultRoot(estimateData) {
  if (!estimateData || typeof estimateData !== 'object') return {};
  return estimateData.result && typeof estimateData.result === 'object'
    ? estimateData.result
    : estimateData;
}

// Pest post-discount program floor is SERVER-authoritative. The deprecated
// client fallback engine stamps floorPa/floorAnn/floorMo from its own
// constants.js literal ($89) AND bakes an 89-based give-back into its
// recurring totals — both ignore the DB-tuned pest_base.floor and the
// enforce_floor_post_discount kill switch. On save this normalizes the
// payload to the live synced constants:
//   1. Rows carrying CLIENT-stamped metadata (the 89-literal basis values)
//      are restamped from the live floor — or stripped when enforcement is
//      off. Rows with no metadata get stamped. Rows with OTHER values are
//      server-stamped (possibly a v2 cadence curve) and are left untouched.
//   2. When the payload is a client-engine result (it carries the
//      pestProgramFloorApplied flag), the baked 89-based lift is replaced in
//      recurring/totals by the server-correct lift, so the persisted
//      monthly_total / annual_total collect per the configured floor.
// Runs before totals resolution; a successful server recompute replaces the
// whole result afterward, making this a no-op for server-priced saves. The
// client fallback prices on the v1 cadence curve, so the restamp mirrors it.
// Manual discounts are warn-only and their computed amount is kept as-is.
const PEST_APPS_TO_FREQUENCY = { 4: 'quarterly', 6: 'bimonthly', 12: 'monthly' };
// round(89 × v1 mult) per cadence — the exact values the client literal produces.
// Pre-stamp client saves floor at 89 × the client mirror's cadence mult.
// The v1-era literals (89/75.65/62.30) are recognized GLOBALLY — ancient
// pre-flag client payloads predate both the isClientEngineResult flag and
// any server v2 stamping, so they cannot collide with a server snapshot.
// The v2 literals (78.32/69.42) are recognized ONLY on flagged client-engine
// payloads: armed server-priced v2 estimates stamp the same default values,
// and classifying those as client stamps would let a floor-config change
// rewrite/reject a server snapshot instead of leaving it untouched
// (codex #2966 r2 P2).
const CLIENT_PEST_FLOOR_PA_LITERALS_V1 = new Set([89, 75.65, 62.30]);
const CLIENT_PEST_FLOOR_PA_LITERALS_V2 = new Set([78.32, 69.42]);
// The client fallback's own cadence multipliers (pestFrequencyTiers ft.disc)
// — used to recognize CONFIGURED-floor client stamps below.
const CLIENT_PEST_V1_MULTS = { 4: 1.0, 6: 0.85, 12: 0.7 };
const CLIENT_PEST_V2_MULTS = { 4: 1.0, 6: 0.88, 12: 0.78 };
function pestFloorLiftForAnnual(pestAnn, discountPct, floorAnn) {
  if (!(discountPct > 0) || !Number.isFinite(pestAnn) || pestAnn <= 0) return 0;
  if (!Number.isFinite(floorAnn) || floorAnn <= 0) return 0;
  const cappedFloor = Math.min(floorAnn, pestAnn);
  return Math.max(0, roundMoney(pestAnn * discountPct - (pestAnn - cappedFloor)));
}
function normalizeClientPestFloorMetadata(estimateData, { liveConfigVerified = true } = {}) {
  const root = estimateResultRoot(estimateData);
  const results = root?.results;
  if (!results || typeof results !== 'object') return;
  const pestRow = results.pest && typeof results.pest === 'object' ? results.pest : null;
  const rows = [
    ...(Array.isArray(results.pestTiers) ? results.pestTiers : []),
    ...(pestRow ? [pestRow] : []),
  ];
  if (!rows.length) return;
  const { PEST } = pricingEngine.constants;

  // Reconstruct the client-baked lift BEFORE mutating the metadata.
  const recurring = root.recurring && typeof root.recurring === 'object' ? root.recurring : null;
  const isClientEngineResult = !!recurring
    && Object.prototype.hasOwnProperty.call(recurring, 'pestProgramFloorApplied');
  const discountPct = Number(recurring?.discount) || 0;
  const pestAnn = Number(pestRow?.ann);
  const clientLift = isClientEngineResult && recurring.pestProgramFloorApplied === true
    ? pestFloorLiftForAnnual(pestAnn, discountPct, Number(pestRow?.floorAnn))
    : 0;

  // The client fallback stamps its resolved per-visit floor into
  // pricingMetadata (post round-9 #2827): a floorPa equal to round(that
  // base × the client's v1 cadence mult) is a CLIENT stamp even when
  // pest_base.floor is configured away from 89 — without this, a config
  // change between fallback calculation and save would preserve stale
  // client floor metadata as if it were a server snapshot (codex P2
  // round 11). The 89-literal set still covers pre-stamp client saves.
  const clientFloorBase = Number(root?.pricingMetadata?.pestProgramFloorPerVisit);
  // Recognize stamps from BOTH client curve generations: the v2 mirror ships
  // with this change, but a cached pre-v2 client keeps stamping v1 mults
  // until refresh — either is a CLIENT stamp, never a server snapshot
  // (codex #2966 P2).
  const clientStampsForRow = (row) => {
    if (!Number.isFinite(clientFloorBase) || clientFloorBase <= 0) return [];
    const apps = Number(row.apps ?? row.v);
    return [CLIENT_PEST_V1_MULTS[apps], CLIENT_PEST_V2_MULTS[apps]]
      .filter((mult) => Number.isFinite(mult) && mult > 0)
      .map((mult) => Math.round(clientFloorBase * mult * 100) / 100);
  };

  // Fail-closed gates BEFORE any mutation (pre-push P0s on the main-merge).
  // A client-priced pest payload cannot be normalized against config we
  // could not verify as live — the restamp would persist billable totals
  // against stale arm/floor values (the client just priced at whatever it
  // fetched; this save is the last authoritative checkpoint).
  if (isClientEngineResult && !liveConfigVerified) {
    throw errorWithStatus('Live pricing configuration could not be verified — retry the save in a moment.', 503);
  }
  // While the floor is ARMED: restamping cannot REPRICE. A client row whose
  // list price sits BELOW the live per-visit floor would persist pa/ann/mo
  // and billable totals beneath the configured floor, and the accept-path
  // lift caps at that old annual — the customer would be saved and charged
  // below the live floor. Fallback payloads have no server recompute, so
  // reject and require regeneration (EstimatePage refreshes config before
  // every fallback quote, so a regenerate prices at live values). Rows at
  // or above the live floor restamp safely — the floor is metadata there
  // (rounds 11/13 behavior kept), and a floor that moved DOWN never binds.
  if (PEST.enforceFloorPostDiscount === true) {
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      const stampedPa = Number(row.floorPa);
      const hasMetadata = Number.isFinite(stampedPa);
      // EVERYTHING in this payload is caller-controlled — there is no in-band
      // signal that trustably proves server provenance, and a spoofed
      // pricingVersion must never skip the armed-floor validation
      // (codex #2966 r4 P1). So the split is: VALIDATION runs for client
      // stamps AND for v2-stamped unmarked rows (a genuine server v2 snapshot
      // at/above the live floor passes untouched; a forged below-floor row
      // 409s); RESTAMPING below stays client-only, so genuine server
      // metadata is never rewritten (r3).
      const isClientStamped = hasMetadata && (
        CLIENT_PEST_FLOOR_PA_LITERALS_V1.has(stampedPa)
        || (isClientEngineResult && (CLIENT_PEST_FLOOR_PA_LITERALS_V2.has(stampedPa) || clientStampsForRow(row).includes(stampedPa)))
      );
      const isV2StampedUnmarked = hasMetadata && !isClientEngineResult && row.pricingVersion === 'v2';
      if (hasMetadata && !isClientStamped && !isV2StampedUnmarked) continue; // server snapshot — untouched below
      if (!hasMetadata && !isClientEngineResult) continue; // legacy no-flag — untouched below
      const frequencyKey = PEST_APPS_TO_FREQUENCY[Number(row.apps ?? row.v)];
      if (!frequencyKey) continue; // stripped below, never stamped
      // Row-curve-aware (codex r10 P1): a legacy v1 row at its own v1 floor
      // must not 409 against the v2 multiplier when config never changed —
      // a regenerate of a REPLAY prices on the sold curve (r7-r9), so
      // validation and restamps compare against the row's own curve.
      const rowCurve = row.pricingVersion === 'v2' ? 'v2' : 'v1';
      const freqMult = (PEST.frequencyDiscounts?.[rowCurve] || {})[frequencyKey] || 1.0;
      const liveFloorPa = pricingEngine.pestProgramFloorPerVisit(freqMult);
      if (liveFloorPa !== null && Number.isFinite(Number(row.pa))
        && Number(row.pa) < liveFloorPa - 0.005) {
        throw errorWithStatus('Pricing configuration changed since this quote was generated — regenerate the estimate to price at the live floor.', 409);
      }
    }
  }

  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const stampedPa = Number(row.floorPa);
    const hasMetadata = Number.isFinite(stampedPa);
    // RESTAMPING stays client-only: a v2-stamped row with no client marker is
    // either a genuine server snapshot (metadata must survive untouched) or a
    // forgery the armed-floor gate above already 409'd when it mattered
    // (below floor). Either way it is never rewritten here (r3 + r4).
    const isServerV2Snapshot = !isClientEngineResult && row.pricingVersion === 'v2';
    const isClientStamped = hasMetadata && !isServerV2Snapshot && (
      CLIENT_PEST_FLOOR_PA_LITERALS_V1.has(stampedPa)
      || (isClientEngineResult && (CLIENT_PEST_FLOOR_PA_LITERALS_V2.has(stampedPa) || clientStampsForRow(row).includes(stampedPa)))
    );
    if (hasMetadata && !isClientStamped) continue; // server-stamped — snapshot, leave alone
    // Metadata-less rows get stamped only on client-engine payloads, where the
    // totals correction below applies the matching lift. Stamping a legacy
    // no-flag payload would let the public reprice collect the floor while
    // the persisted columns keep the old discounted amount — divergence.
    if (!hasMetadata && !isClientEngineResult) continue;
    delete row.floorPa;
    delete row.floorAnn;
    delete row.floorMo;
    if (!PEST.enforceFloorPostDiscount) continue;
    const frequencyKey = PEST_APPS_TO_FREQUENCY[Number(row.apps ?? row.v)];
    if (!frequencyKey) continue;
    // Row-curve-aware restamp (codex r10 P1) — same rule as the gate above.
    const rowCurve = row.pricingVersion === 'v2' ? 'v2' : 'v1';
    const freqMult = (PEST.frequencyDiscounts?.[rowCurve] || {})[frequencyKey] || 1.0;
    const floorAnn = pricingEngine.pestProgramFloorAnnual(freqMult, Number(row.apps ?? row.v));
    if (floorAnn === null) continue;
    row.floorPa = pricingEngine.pestProgramFloorPerVisit(freqMult);
    row.floorAnn = floorAnn;
    row.floorMo = Math.round((floorAnn / 12) * 100) / 100;
  }

  // Replace the client-baked lift with the server-correct one in the totals.
  if (!isClientEngineResult) return;
  // The rows/totals above were normalized to the LIVE config — the replay
  // stamps must record the SAME source atomically, or a floor change
  // between calculation and save leaves pricingMetadata claiming one floor
  // while the persisted rows/totals collect another (pre-push P0, round 13
  // on #2827). Client-priced payloads only; server engine stamps are
  // authoritative snapshots and never pass through here.
  const syncStamps = (meta) => {
    if (!meta || typeof meta !== 'object') return;
    meta.pestProgramFloorArmed = PEST.enforceFloorPostDiscount === true;
    const liveFloor = Number(PEST.floor);
    if (Number.isFinite(liveFloor) && liveFloor > 0) {
      meta.pestProgramFloorPerVisit = liveFloor;
    } else {
      delete meta.pestProgramFloorPerVisit;
    }
  };
  if (!root.pricingMetadata || typeof root.pricingMetadata !== 'object') root.pricingMetadata = {};
  syncStamps(root.pricingMetadata);
  syncStamps(root.routingMetadata);
  const serverLift = pestFloorLiftForAnnual(pestAnn, discountPct, Number(pestRow?.floorAnn));
  const delta = roundMoney(serverLift - clientLift);
  recurring.pestProgramFloorApplied = serverLift > 0;
  if (Math.abs(delta) < 0.005) return;
  const adjust = (obj, key, d) => {
    const v = Number(obj?.[key]);
    if (Number.isFinite(v)) obj[key] = Math.max(0, roundMoney(v + d));
  };
  adjust(recurring, 'savings', -delta);
  adjust(recurring, 'annualAfterDiscount', delta);
  const newAnnualAfter = Number(recurring.annualAfterDiscount);
  if (Number.isFinite(newAnnualAfter)) {
    const oldMonthly = Number(recurring.monthlyTotal);
    const newMonthly = roundMoney(newAnnualAfter / 12);
    recurring.monthlyTotal = newMonthly;
    if (Number.isFinite(oldMonthly)) {
      adjust(recurring, 'grandTotal', roundMoney(newMonthly - oldMonthly));
    }
  }
  const totals = root.totals && typeof root.totals === 'object' ? root.totals : null;
  if (totals) {
    adjust(totals, 'year2', delta);
    const year2 = Number(totals.year2);
    if (Number.isFinite(year2) && Number.isFinite(Number(totals.year2mo))) {
      totals.year2mo = roundMoney(year2 / 12);
    }
    adjust(totals, 'year1', delta);
  }
}

function sumPositiveAmounts(rows = [], fields = ['price']) {
  return roundMoney((rows || []).reduce((sum, row) => {
    if (!row || typeof row !== 'object') return sum;
    for (const field of fields) {
      const amount = positiveMoney(row[field]);
      if (amount !== null) return sum + amount;
    }
    return sum;
  }, 0));
}

function sumSignedAmounts(rows = [], fields = ['price']) {
  return roundMoney((rows || []).reduce((sum, row) => {
    if (!row || typeof row !== 'object') return sum;
    for (const field of fields) {
      const amount = moneyValue(row[field]);
      if (amount !== null) return sum + amount;
    }
    return sum;
  }, 0));
}

function isApprovedDethatchingManagerRow(row = {}) {
  if (!row || typeof row !== 'object') return false;
  const service = String(row.service || row.key || '').toLowerCase();
  const label = String(row.name || row.label || row.displayName || '').toLowerCase();
  return (service.includes('dethatch') || label.includes('dethatch')) &&
    row.managerApproved === true &&
    row.managerApprovalSatisfied === true &&
    !!row.managerApprovalOverrideReason &&
    moneyValue(row.price) !== null;
}

function deriveTotalsFromEstimateData(estimateData) {
  const result = estimateResultRoot(estimateData);
  const recurring = result.recurring && typeof result.recurring === 'object'
    ? result.recurring
    : {};
  const nestedRecurring = result.results?.recurring && typeof result.results.recurring === 'object'
    ? result.results.recurring
    : {};
  const recurringRows = [
    ...(Array.isArray(recurring.services) ? recurring.services : []),
    ...(Array.isArray(nestedRecurring.services) ? nestedRecurring.services : []),
  ];
  const recurringRowsMonthly = sumPositiveAmounts(recurringRows, ['mo', 'monthly']);
  const monthlyTotal = positiveMoney(recurring.grandTotal) ??
    positiveMoney(recurring.monthlyTotal) ??
    positiveMoney(recurring.monthly) ??
    positiveMoney(nestedRecurring.grandTotal) ??
    positiveMoney(nestedRecurring.monthlyTotal) ??
    positiveMoney(result.totals?.year2mo) ??
    positiveMoney(recurringRowsMonthly);

  const oneTime = result.oneTime && typeof result.oneTime === 'object' ? result.oneTime : {};
  const oneTimeRows = [
    ...(Array.isArray(oneTime.items) ? oneTime.items : []),
    ...(Array.isArray(oneTime.specItems) ? oneTime.specItems : []),
  ];
  const oneTimeMembershipFee = positiveMoney(oneTime.membershipFee) ?? 0;
  const oneTimeRowsTotal = roundMoney(
    sumSignedAmounts(oneTimeRows, ['price', 'estimatedPrice', 'baseEstimatePrice']) +
    oneTimeMembershipFee
  );
  const topLevelSpecRows = Array.isArray(result.specItems)
    ? result.specItems.filter((row) => row?.onProg !== true && row?.includedOnProgram !== true)
    : [];
  const topLevelSpecRowsTotal = sumSignedAmounts(
    topLevelSpecRows,
    ['price', 'estimatedPrice', 'baseEstimatePrice']
  );
  const explicitOneTimeTotal = nonNegativeMoney(oneTime.total);
  const hasOneTimeDerivedSource = oneTimeRows.length > 0 || oneTimeMembershipFee > 0;
  const derivedOneTimeTotal = (
    hasOneTimeDerivedSource ? nonNegativeMoney(oneTimeRowsTotal) : null
  ) ?? (
    topLevelSpecRows.length > 0
      ? nonNegativeMoney(topLevelSpecRowsTotal)
      : null
  );
  const hasApprovedDethatchingManagerRow = oneTimeRows.some((row) => isApprovedDethatchingManagerRow(row));
  const oneTimeTotal = explicitOneTimeTotal !== null
    ? (
        hasApprovedDethatchingManagerRow && derivedOneTimeTotal !== null && derivedOneTimeTotal > explicitOneTimeTotal
          ? derivedOneTimeTotal
          : explicitOneTimeTotal
      )
    : derivedOneTimeTotal;

  const annualTotal = positiveMoney(result.totals?.year2) ??
    positiveMoney(recurring.annualTotal) ??
    positiveMoney(nestedRecurring.annualTotal) ??
    (monthlyTotal !== null ? roundMoney(monthlyTotal * 12) : null) ??
    positiveMoney(recurring.annualAfterDiscount) ??
    positiveMoney(nestedRecurring.annualAfterDiscount);

  return {
    monthlyTotal,
    annualTotal,
    onetimeTotal: oneTimeTotal,
  };
}

function resolveBillableTotals(body, estimateData, quoteRequired) {
  if (quoteRequired) {
    return { monthlyTotal: 0, annualTotal: 0, onetimeTotal: 0 };
  }
  const derived = deriveTotalsFromEstimateData(estimateData);
  const monthlyTotal = derived.monthlyTotal ?? fallbackMoney(body.monthlyTotal);
  const onetimeTotal = derived.onetimeTotal ?? fallbackMoney(body.onetimeTotal);
  const annualTotal = derived.annualTotal ??
    (monthlyTotal > 0 ? roundMoney(monthlyTotal * 12) : fallbackMoney(body.annualTotal));
  return { monthlyTotal, annualTotal, onetimeTotal };
}

function applyResolvedTotalsToEstimateData(estimateData, totals, quoteRequired) {
  if (!estimateData || typeof estimateData !== 'object' || quoteRequired) return;
  const result = estimateResultRoot(estimateData);
  if (!result || typeof result !== 'object') return;

  if (result.oneTime && typeof result.oneTime === 'object' && totals.onetimeTotal > 0) {
    result.oneTime.total = totals.onetimeTotal;
    if (Object.prototype.hasOwnProperty.call(result.oneTime, 'otSubtotal')) {
      result.oneTime.otSubtotal = roundMoney(totals.onetimeTotal - fallbackMoney(result.oneTime.tmInstall));
    }
  }

  if (result.recurring && typeof result.recurring === 'object' && totals.monthlyTotal > 0) {
    result.recurring.grandTotal = totals.monthlyTotal;
    result.recurring.monthlyTotal = totals.monthlyTotal;
    if (totals.annualTotal > 0 && Object.prototype.hasOwnProperty.call(result.recurring, 'annualTotal')) {
      result.recurring.annualTotal = totals.annualTotal;
    }
  }

  if (result.totals && typeof result.totals === 'object') {
    if (totals.monthlyTotal > 0) result.totals.year2mo = totals.monthlyTotal;
    if (totals.annualTotal > 0) result.totals.year2 = totals.annualTotal;
    const year1 = roundMoney(fallbackMoney(totals.annualTotal) + fallbackMoney(totals.onetimeTotal));
    if (year1 > 0) result.totals.year1 = year1;
  }
}

// Decision #2 — the server is authoritative on the persisted/billed price.
// We replay the engine inputs the client captured back through the SAME pricing
// engine the live preview used, then persist the server-computed totals. The
// client number is retained only as an auditable preview. "Authoritative" here
// means authoritative over the COMPUTATION, conditional on the client-captured
// inputs (turf sf, services, shade, etc.) — input provenance is out of scope.
function compareClientToServer(clientTotals, serverTotals, now = () => new Date()) {
  const cA = fallbackMoney(clientTotals && clientTotals.annualTotal);
  const sA = fallbackMoney(serverTotals && serverTotals.annualTotal);
  const cM = fallbackMoney(clientTotals && clientTotals.monthlyTotal);
  const sM = fallbackMoney(serverTotals && serverTotals.monthlyTotal);
  const cO = fallbackMoney(clientTotals && clientTotals.onetimeTotal);
  const sO = fallbackMoney(serverTotals && serverTotals.onetimeTotal);
  const annualDelta = roundMoney(sA - cA);
  const monthlyDelta = roundMoney(sM - cM);
  const onetimeDelta = roundMoney(sO - cO);
  return {
    annualDelta,
    monthlyDelta,
    onetimeDelta,
    pctAnnual: cA > 0 ? Math.round((annualDelta / cA) * 10000) / 10000 : null,
    // Annual is the source of truth (the 55% lawn floor is defined on annual);
    // a few cents of monthly rounding is not drift.
    hasDrift: Math.abs(annualDelta) >= 0.5 || Math.abs(onetimeDelta) >= 0.5,
    computedAt: now().toISOString(),
  };
}

// Resolve a replayable engine input from the persisted estimate_data and re-run
// the engine. Supports both shapes: the admin save's `engineRequest`
// ({ profile, selectedServices, options } — the exact /calculate-estimate
// payload) and the public/lead `engineInputs` (already a v1 engine input).
// Returns { recomputed:true, source, serverResult, serverTotals } or
// { recomputed:false, reason } so callers can fail open.
// The identity/recurring fields the browser must never set on a
// SERVER-authoritative estimate: they drive the WaveGuard tier and the
// recurring-customer perk, which are earned on a verified customer_id. The
// server re-derives them; these are stripped from both the transient recompute
// input AND every stored replay shape so a later public reprice
// (extractEngineInputs) can't restore a forged value.
// treeShrubPricingKnobs overrides DB-authoritative pricing_config values, so
// a browser-supplied one would let a save price off knobs the admin never
// set (or a stale pre-flip preview). It is stripped here like every other
// client-claimed pricing identity and re-derived server-side ONLY when the
// caller declares a replay of an already-persisted estimate.
// commercialFloorsArmedServices is the replay-only commercial-minimum
// re-arm flag (commercial-floor-replay): browser-supplied, it would restore
// the retired minimums on a FRESH save (codex #3432 r3 P1). Stripped here
// and re-derived server-side only under the declared persisted-replay
// branch below — same lifecycle as treeShrubPricingKnobs.
// setupWaiverPriorQualifyingServices is the public-quote wizard's
// pre-pricing account lookup (codex #3591 r14) — a setup-waiver-only
// identity the engine unions with priorQualifyingServices. Browser-supplied
// it would forge a $99 waiver, so it is stripped like the rest; the admin
// save re-supplies its own ACCOUNT-wide server-derived list (codex #3591
// r15 P1 / r34 P1).
const CLIENT_IDENTITY_FIELDS = ['priorQualifyingServices', 'setupWaiverPriorQualifyingServices', 'recurringCustomer', 'isRecurringCustomer', 'treeShrubPricingKnobs', 'palmAnnualRounding', 'commercialFloorsArmedServices', 'commercialFloorsArmed', 'rodentBaitLegacyReplay', 'rodentWaveguardPostureReplay'];
function sanitizeClientIdentityFields(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj;
  for (const field of CLIENT_IDENTITY_FIELDS) delete obj[field];
  return obj;
}

// A linked draft that must never be reused by the generic create: one that
// carries ANY stored proposal object — enabled, disabled or scaffold alike.
// The COMMERCIAL category alone is NOT the signal (GH codex P2 r9): the
// estimator engine and Agent Estimate stamp it on ordinary engine-priced
// commercial drafts that carry no proposal and must keep being reusable.
function linkedDraftCarriesProposal(row = {}) {
  let data = row.estimate_data;
  if (typeof data === 'string') { try { data = JSON.parse(data); } catch { data = null; } }
  const proposal = data && typeof data === 'object' ? data.proposal : null;
  return !!(proposal && typeof proposal === 'object' && !Array.isArray(proposal));
}

// estimate_data.proposal is SERVER-OWNED. PUT /:id/proposal is the only
// authoring path (it validates the proposal and stamps category=COMMERCIAL
// in the same UPDATE) and the commercial-proposal lane seeds scaffolds; the
// generic create/revise save must never accept one from the browser —
// `proposal.enabled` exempts a row from the pricing-authority send gate
// (admin-estimates sendRequiresServerPricingFor) and from its rollout
// telemetry, so a forged flag on a CLIENT_FALLBACK draft would deliver
// un-audited browser pricing (pre-push P0 on #3750). A revision carries the
// ROW's stored proposal forward verbatim instead of the client's copy.
function stripClientProposal(estimateData, storedProposal = null) {
  if (!estimateData || typeof estimateData !== 'object' || Array.isArray(estimateData)) return estimateData;
  delete estimateData.proposal;
  if (storedProposal && typeof storedProposal === 'object' && !Array.isArray(storedProposal)) {
    estimateData.proposal = storedProposal;
  }
  return estimateData;
}

async function serverRecomputeFromEstimateData(estimateData, deps = {}) {
  const generateEstimate = deps.generateEstimate || pricingEngine.generateEstimate;
  const needsSync = deps.needsSync || pricingEngine.needsSync;
  const syncConstantsFromDB = deps.syncConstantsFromDB || pricingEngine.syncConstantsFromDB;
  const mapResult = deps.mapV1ToLegacyShape || mapV1ToLegacyShape;
  // Lazy-require the route adapter to avoid a service→route load-order cycle.
  let translate = deps.translateV2CallToV1Input;
  if (translate === undefined) {
    try {
      translate = require('../routes/property-lookup-v2').translateV2CallToV1Input;
    } catch (_) {
      translate = null;
    }
  }

  if (!estimateData || typeof estimateData !== 'object') {
    return { recomputed: false, reason: 'NO_INPUTS' };
  }

  let v1Input = null;
  let source = null;
  const req = estimateData.engineRequest;
  if (req && typeof req === 'object' && req.profile && typeof translate === 'function') {
    try {
      v1Input = translate(req.profile, Array.isArray(req.selectedServices) ? req.selectedServices : [], req.options || {});
      source = 'ENGINE_REQUEST';
    } catch (err) {
      // failClosed = a policy rejection (e.g. a gated add-on in the replayed
      // request), never engine breakage: swallowing it here would fall through
      // to NO_INPUTS → CLIENT_FALLBACK and persist the very thing the
      // validation rejected (codex #3272 r1). Propagate; the save 400s.
      if (err && err.failClosed === true) throw err;
      v1Input = null;
    }
  }
  if (!v1Input && estimateData.engineInputs && typeof estimateData.engineInputs === 'object') {
    v1Input = estimateData.engineInputs;
    source = 'ENGINE_INPUTS';
  }
  if (!v1Input) return { recomputed: false, reason: 'NO_INPUTS' };

  // SERVER-AUTHORITATIVE identity override. priorQualifyingServices (the
  // WaveGuard tier input) and the recurring-customer flag (the 15% one-time
  // perk) are EXISTING-CUSTOMER benefits that must be earned on a verified
  // customer_id — never claimed by the browser. The replayed estimateData
  // (engineRequest.options / engineInputs) is fully client-controlled, so on
  // this SERVER-stamped path we overwrite them from the server-derived deps
  // (loaded from body.customerId by the caller), UNCONDITIONALLY — including
  // the empty/non-member case. Without this, a forged priorQualifyingServices
  // lifted a lead's mosquito quote Bronze→Platinum, and a forged
  // recurringCustomer:true stole the one-time perk.
  const priorQualifyingServices = Array.isArray(deps.priorQualifyingServices)
    ? deps.priorQualifyingServices
    : [];
  // Strip the client-claimed identity/recurring flags, then set the
  // server-authoritative values. priorQualifyingServices is set unconditionally
  // (empty for a non-member); recurringCustomer is forced true ONLY for a
  // verified active-plan customer or one with prior qualifying services.
  // Everyone else is left to the engine's own cart-based auto-derivation
  // (activeServiceKeys), so a bundle that itself buys a recurring service still
  // legitimately earns the perk while a one-time-only lead cannot forge it.
  v1Input = sanitizeClientIdentityFields({ ...v1Input });
  v1Input.priorQualifyingServices = priorQualifyingServices;
  // Account-wide rodent setup-waiver evidence, server-derived by the caller
  // alongside the property-scoped tier list (codex #3591 r34 P1); set
  // unconditionally (empty for a non-member) so a client-claimed list can
  // never survive into the engine.
  v1Input.setupWaiverPriorQualifyingServices = Array.isArray(deps.setupWaiverPriorQualifyingServices)
    ? deps.setupWaiverPriorQualifyingServices
    : [];
  if (deps.recurringCustomer === true || priorQualifyingServices.length > 0) {
    v1Input.recurringCustomer = true;
  }

  // Operator-stated price adjustment (agent flows): persisted OUTSIDE the
  // replay inputs and re-injected transiently on every reprice, mirroring
  // the public replay (extractEngineInputs in estimate-public). Without
  // this, an admin-editor save or lapse-reconcile reprice of an adjusted
  // agent quote silently restores the undiscounted anchor while the stored
  // adjustment metadata still claims otherwise. A manualDiscount already in
  // the stored inputs (admin-editor discounts) wins; internalReason is
  // audit-only and deliberately never injected.
  const opAdj = estimateData.operatorPriceAdjustment;
  if (opAdj && typeof opAdj === 'object' && !v1Input.manualDiscount && Number(opAdj.value) > 0) {
    v1Input.manualDiscount = {
      source: 'agent_operator',
      type: opAdj.type === 'PERCENT' ? 'PERCENT' : 'FIXED',
      value: Number(opAdj.value),
      label: opAdj.label || 'Discount',
      eligibility: null,
      eligibilityConfirmed: true,
      floorBreachAcknowledged: opAdj.floorBreachAcknowledged === true,
    };
  }
  // Admin-editor discounts never round-trip as an assembled manualDiscount
  // object (the editor posts the raw form), so a save-path replay repriced
  // the quote undiscounted while the stored summary still showed the
  // discount. Reconstruct from the stored summary — same mechanism as the
  // operatorPriceAdjustment branch above, shared with the public replay
  // (estimate-public extractEngineInputs).
  if (!v1Input.manualDiscount) {
    const storedManual = require('./estimate-manual-discount-replay')
      .storedManualDiscountForReplay(estimateData);
    if (storedManual) v1Input.manualDiscount = storedManual;
  }

  // Saved Tree & Shrub knob state (v4.7), REPLAY PATHS ONLY. This recompute
  // is authoritative — membership-lapse reconciliation replaces the stored
  // result and totals with it — so replaying an already-SENT quote must
  // reuse its quote-time knobs, or an admin flip between send and reconcile
  // would re-price it well beyond the intended membership change.
  //
  // But `estimateData` is browser-controlled on create/revision saves, and
  // these knobs override DB-authoritative pricing_config: honoring a
  // submitted snapshot there would let a save price off knobs the admin
  // never set. So the caller must DECLARE a persisted-estimate replay
  // (replaySavedPricingKnobs), the client-claimed value is always stripped
  // above, and every other save prices off freshly synced live config and
  // stamps the resulting server values afterward.
  if (deps.replaySavedPricingKnobs === true) {
    // Lawn cost floor, lawn program minimum and pest program floor. The public
    // read path has threaded these since #2827 (savedFloorReplayOverrides);
    // this branch did not, so an authoritative recompute resolved them from
    // the LIVE globals and — because callers persist this result — wrote the
    // live state over the estimate's quote-time pricingMetadata stamps. The
    // next replay then read the overwritten stamps as the saved evidence.
    // Same reader, same tri-state: a signal absent here means replay live.
    Object.assign(v1Input, require('./estimate-floor-signal-replay')
      .savedFloorReplaySignals(estimateData));
    const tsKnobs = require('./estimate-tree-shrub-knob-replay')
      .treeShrubKnobSignalForReplay(estimateData);
    if (tsKnobs) v1Input.treeShrubPricingKnobs = tsKnobs;
    // v4.8 palm provenance (pre-push r2 P0): a translator-based replay of a
    // persisted engineRequest whose stored T&S line priced no service-line
    // palms must not adopt the new property-palm promotion — same
    // stored-result evidence rule as the pest curve above. Declared replays
    // only: on a browser-posted save the operator just regenerated the
    // preview under the new translator and sees the price.
    if (source === 'ENGINE_REQUEST') {
      require('./estimate-tree-shrub-knob-replay').applyTreeShrubPalmReplay(v1Input, estimateData);
    }
    // Commercial account-minimum replay (codex #3432 r2 P0): a pre-disarm
    // commercial estimate stored at its era's minimum must keep its quoted
    // price through this authoritative recompute too (membership-lapse
    // reconciliation writes the result back over the stored totals). Same
    // PER-SERVICE row evidence the public replay uses
    // (savedFloorReplayOverrides; codex r3 P0 — never a global re-arm).
    const commercialArmed = require('./commercial-floor-replay').commercialFloorBoundServices(estimateData);
    if (commercialArmed.length) v1Input.commercialFloorsArmedServices = commercialArmed;
    // Legacy rodent-bait price pin (codex #3591 r2 P0): same stored-row
    // evidence the public replay uses — a pre-realignment rodent line must
    // keep its disclosed price through this authoritative recompute too.
    const rodentPin = require('./rodent-bait-legacy-replay').rodentBaitLegacyReplaySignal(estimateData);
    if (rodentPin) v1Input.rodentBaitLegacyReplay = rodentPin;
    // New-model rodent posture freeze (codex #3591 r43 P1) — same stored-row
    // evidence the public replay injects.
    const rodentPosture = require('./rodent-bait-legacy-replay').rodentWaveguardPostureReplaySignal(estimateData);
    if (rodentPosture) v1Input.rodentWaveguardPostureReplay = rodentPosture;
  }

  try {
    if (typeof needsSync === 'function' && needsSync() && typeof syncConstantsFromDB === 'function') {
      await syncConstantsFromDB();
    }
    // REPLAY-vs-NEW curve normalization (codex #2966 r7-r9 P1s): pre-stamp
    // replay shapes carry no services.pest.version — stored engineInputs AND
    // persisted Admin-V2 engineRequests (translateV2CallToV1Input emits no
    // stamp) — and forwarding them unchanged would silently reprice an
    // already-SOLD bi-monthly/monthly pest quote on the v2 default at the
    // next save / membership reconcile / revision. The provenance signal is
    // the STORED RESULT: an unstamped pest input with a priced stored pest
    // line is a replay of that line's curve (unstamped line = v1),
    // regardless of which replay shape carried it. No stored pest line =
    // pest was just added: genuinely new, keeps the live v2 default. The
    // caller's write-back then persists the resolved curve into engineInputs
    // so future replays are stamped at the source.
    if (v1Input?.services?.pest && typeof v1Input.services.pest === 'object'
      && !v1Input.services.pest.version) {
      // Shared with the public read path (estimate-public extractEngineInputs)
      // so save-time and view-time replays resolve the same curve from the
      // same stored-result evidence — incl. raw agent-draft engineResult
      // lineItems (codex #2966 r8 P1).
      const resolvedVersion = resolveStoredPestPricingVersion(estimateData);
      if (resolvedVersion) {
        v1Input.services.pest.version = resolvedVersion;
      }
    }
    const v1 = generateEstimate(v1Input);
    // True setup-fee waiver: the legacy mapper counts the pest line's
    // initialFee into oneTime.total/year1, which would reintroduce the
    // waived $99 into the stored totals on every reprice of an
    // operator-waived agent quote. Zero it on the transient result before
    // mapping — recurring rows/totals are untouched, and the waiver stays
    // honored downstream (estimateOperatorSetupFeeWaived) exactly as at
    // first send.
    if (opAdj && typeof opAdj === 'object' && opAdj.waiveSetupFee === true && Array.isArray(v1?.lineItems)) {
      for (const li of v1.lineItems) {
        if (li && Number(li.initialFee) > 0) li.initialFee = 0;
      }
    }
    const serverResult = mapResult(v1);
    const serverTotals = deriveTotalsFromEstimateData({ result: serverResult });
    // The curve the recompute actually priced pest with — persisted into the
    // replayable engineInputs by the caller so a later stored-inputs replay
    // reprices on the SAME curve (codex #2966 r2 P1).
    const pestPricingVersion = (Array.isArray(v1?.lineItems)
      ? v1.lineItems.find((li) => li?.service === 'pest_control')?.pricingVersion
      : null) || null;
    // rawEngineResult: the unmapped generateEstimate output. The click-to-
    // estimate mint reads its per-line discounted annual/visit cadence for
    // the cent-exact cross-check against the card's shown price — the same
    // raw shape the card's own quote derivation consumed, so the check can
    // never diverge on mapping differences. Additive; existing callers read
    // only serverResult/serverTotals.
    return { recomputed: true, source, serverResult, serverTotals, pestPricingVersion, rawEngineResult: v1 };
  } catch (error) {
    // failClosed policy rejections (gated/invalid add-on inside the replayed
    // inputs) propagate — wrapping them as ENGINE_ERROR would hand them to
    // the fail-open CLIENT_FALLBACK rail and persist the rejected price.
    if (error && error.failClosed === true) throw error;
    return { recomputed: false, reason: 'ENGINE_ERROR', error };
  }
}

// Decide the authoritative totals + audit columns for a save. Fails OPEN to the
// client preview (so a broken engine never blocks Virginia's save) but LOUDLY:
// every non-authoritative save is stamped CLIENT_FALLBACK (queryable column) and
// an engine error is logged at error level.
async function resolveServerAuthoritativePricing({ estimateData, clientPreview, quoteRequired, now, recompute, priorQualifyingServices, setupWaiverPriorQualifyingServices, recurringCustomer }) {
  const recomputeFn = recompute || serverRecomputeFromEstimateData;
  const audit = {
    pricing_authority: null,
    server_computed_price: null,
    client_preview_price: positiveMoney(clientPreview.annualTotal),
    pricing_drift: null,
  };

  // Quote-required / manager-approval estimates carry no billable price yet —
  // leave them exactly as today (authority null, no recompute).
  if (quoteRequired) {
    return { totals: clientPreview, audit, fallbackReason: null };
  }

  let result;
  try {
    result = await recomputeFn(estimateData, { now, priorQualifyingServices, setupWaiverPriorQualifyingServices, recurringCustomer });
  } catch (error) {
    // Fail-open is for BROKEN engines only. A failClosed policy rejection
    // (gated/invalid add-on in the replay) must block the save outright —
    // stamping it CLIENT_FALLBACK would persist and send the rejected price.
    if (error && error.failClosed === true) throw error;
    result = { recomputed: false, reason: 'ENGINE_ERROR', error };
  }
  // Belt-and-suspenders for injected/legacy recompute fns that WRAP the
  // error instead of throwing: a wrapped failClosed rejection must not
  // reach the CLIENT_FALLBACK branch either.
  if (result && result.error && result.error.failClosed === true) throw result.error;

  if (result.recomputed) {
    // Overwrite the embedded result so the stored blob and the persisted
    // columns agree — blob/column divergence is exactly the bug class this fixes.
    estimateData.result = result.serverResult;
    // The RAW server engine result rides along with its mapped twin: the
    // send-time pricing audit enriches mapped lines from engineResult
    // (commercial costs.total, installation costs, cadence), and leaving
    // the client-supplied / previous-revision container behind fed a
    // server-priced audit stale cost metadata (GH codex P1 on #3628).
    if (result.rawEngineResult && typeof result.rawEngineResult === 'object') {
      estimateData.engineResult = result.rawEngineResult;
    }
    // Stamp the priced pest curve into the replayable engineInputs: replay
    // sites treat UNSTAMPED saved inputs as legacy v1, so every new save must
    // carry the version it was actually priced with or a stored-inputs replay
    // would reprice a v2 quote on the v1 curve (codex #2966 r2 P1).
    if (result.pestPricingVersion && estimateData.engineInputs && typeof estimateData.engineInputs === 'object') {
      estimateData.engineInputs.services = estimateData.engineInputs.services || {};
      const pestInput = estimateData.engineInputs.services.pest;
      if (pestInput && typeof pestInput === 'object') {
        pestInput.version = result.pestPricingVersion;
      } else if (pestInput) {
        estimateData.engineInputs.services.pest = { version: result.pestPricingVersion };
      }
    }
    // An authoritative reprice supersedes the lapse-reconcile's fail-closed
    // quote-required flag (set when a lapsed member's row could not be
    // repriced) — otherwise a revised/re-saved estimate stays permanently
    // quote-required.
    delete estimateData.membershipLapsedRequote;
    const drift = compareClientToServer(clientPreview, result.serverTotals, now);
    audit.pricing_authority = 'SERVER';
    audit.server_computed_price = positiveMoney(result.serverTotals.annualTotal);
    audit.pricing_drift = drift;
    if (drift.hasDrift) {
      logger.warn(`[pricing-authority] server recompute corrected client preview annualDelta=${drift.annualDelta} pctAnnual=${drift.pctAnnual}`);
    }
    return { totals: result.serverTotals, audit, fallbackReason: null };
  }

  audit.pricing_authority = 'CLIENT_FALLBACK';
  if (result.reason === 'ENGINE_ERROR') {
    // Deploy-bug signal: a billed price that came from a broken engine.
    logger.error(`[pricing-authority] CLIENT_FALLBACK reason=ENGINE_ERROR — persisted client preview as NON-authoritative price${result.error ? ` err=${result.error.message}` : ''}`);
  } else {
    // No replayable input (legacy/transitional estimate). Findable via the
    // pricing_authority column; warn rather than page.
    logger.warn(`[pricing-authority] CLIENT_FALLBACK reason=${result.reason} — no replayable engine input; persisted client preview`);
  }
  // fallbackReason rides OUTSIDE audit (audit spreads into the row): the
  // route rings the admin bell for ENGINE_ERROR only after the save's
  // transaction committed, never from a dryRun preflight (pre-push codex P1).
  return { totals: clientPreview, audit, fallbackReason: result.reason || 'UNKNOWN' };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Multi-property linkage (migration 20260806200000): resolve the OPTIONAL
// property_id / estimate_group_id write fields. Keys are only present in the
// returned object when the caller explicitly sent them — revise spreads these
// fields over the existing row, so a save from a caller that never loaded the
// linkage must leave the stored values untouched rather than null them.
async function resolveEstimatePropertyLinkage(database, body) {
  const fields = {};
  if (body.propertyId !== undefined) {
    if (body.propertyId === null || body.propertyId === '') {
      fields.property_id = null;
    } else {
      const propertyId = String(body.propertyId);
      if (!UUID_RE.test(propertyId)) throw errorWithStatus('propertyId must be a UUID', 400);
      const property = await database('customer_properties').where({ id: propertyId }).first();
      if (!property || property.active === false) throw errorWithStatus('Property not found', 404);
      if (body.customerId && String(property.customer_id) !== String(body.customerId)) {
        throw errorWithStatus('Property belongs to a different customer', 400);
      }
      fields.property_id = propertyId;
    }
  }
  if (body.estimateGroupId !== undefined) {
    if (body.estimateGroupId === null || body.estimateGroupId === '') {
      fields.estimate_group_id = null;
    } else {
      const groupId = String(body.estimateGroupId);
      if (!UUID_RE.test(groupId)) throw errorWithStatus('estimateGroupId must be a UUID', 400);
      fields.estimate_group_id = groupId;
    }
  }
  return fields;
}

// Ensure the anchor estimate of a group has an estimate_group_id, minting one
// on first use. Locks the anchor row so two concurrent "add another property"
// saves against the same anchor converge on a single group id.
//
// Same-customer guard (codex #3244 r1): a group is ONE customer's properties —
// the group publishes under one bearer link that exposes every sibling's
// token, address, and totals, and acceptance can reuse a sibling's customer
// account. If the operator switched customers after "Add another property",
// refuse the group rather than silently linking strangers. Identity =
// customer_id when both sides have one; otherwise a matching normalized
// phone OR email (the builder clones contact info, so a legitimate sibling
// always matches).
async function ensureEstimateGroupId(trx, anchorEstimateId, sibling = {}, randomUUID = crypto.randomUUID, { expectUngrouped = false } = {}) {
  const anchorId = String(anchorEstimateId);
  if (!UUID_RE.test(anchorId)) throw errorWithStatus('groupWithEstimateId must be a UUID', 400);
  const anchor = await firstForUpdate(trx('estimates').where({ id: anchorId }));
  if (!anchor) throw errorWithStatus('Estimate to group with not found', 404);
  // LOCK ORDER (uncapped codex P1 r26): the caller locks an EXISTING group's
  // advisory lock before this row lock. An anchor it observed ungrouped that
  // acquired a group while this FOR UPDATE waited would have its group lock
  // taken after the row lock — the inverse of the send path — so refuse for
  // a retry (the retry observes the group and locks it first).
  if (expectUngrouped && anchor.estimate_group_id) {
    throw errorWithStatus('Estimate group changed; refresh and try again.', 409);
  }
  const normPhone = (v) => String(v || '').replace(/\D/g, '').slice(-10);
  const normEmail = (v) => String(v || '').trim().toLowerCase();
  const anchorCustomerId = anchor.customer_id ? String(anchor.customer_id) : null;
  const siblingCustomerId = sibling.customer_id ? String(sibling.customer_id) : null;
  const sameCustomer = anchorCustomerId || siblingCustomerId
    ? anchorCustomerId === siblingCustomerId
    : (
      (normPhone(anchor.customer_phone).length === 10
        && normPhone(anchor.customer_phone) === normPhone(sibling.customer_phone))
      || (normEmail(anchor.customer_email)
        && normEmail(anchor.customer_email) === normEmail(sibling.customer_email))
    );
  if (!sameCustomer) {
    throw errorWithStatus('Grouped estimates must belong to the same customer as the anchor estimate', 400);
  }
  // Duplicate-address guard (codex #3244 r5): quoting the same street twice
  // in one group would double-message one property and hand the added copy
  // an unearned 10% multi-home preset. Compare normalized streets against
  // every live member (the anchor alone when minting).
  const { normalizedEstimatePropertyKey, samePropertyKey } = require('./estimate-property-linkage');
  const siblingKey = normalizedEstimatePropertyKey(sibling.address);
  if (siblingKey?.street) {
    const members = anchor.estimate_group_id
      ? await trx('estimates').where({ estimate_group_id: anchor.estimate_group_id }).whereNull('archived_at').select('address')
      : [anchor];
    for (const member of members) {
      // Full property tuple (codex #3248 r1): identical street+unit in
      // different cities/ZIPs are DISTINCT properties.
      if (samePropertyKey(normalizedEstimatePropertyKey(member.address), siblingKey)) {
        throw errorWithStatus('This address is already in the group — each property is quoted once', 400);
      }
    }
  }
  if (anchor.estimate_group_id) return anchor.estimate_group_id;
  const groupId = randomUUID();
  await trx('estimates').where({ id: anchorId }).update({ estimate_group_id: groupId });
  return groupId;
}

// Direct estimateGroupId assignments (create/revision payloads) must clear
// the same same-customer bar as the anchor path (codex #3244 r4): without
// this, any caller-supplied UUID joins two strangers' estimates under one
// bearer link. Every existing member (excluding self on revision) must match
// the writing estimate's identity — customer_id when either side has one,
// else normalized phone/email.
async function assertGroupAssignmentAllowed(dbc, groupId, identity = {}, selfId = null) {
  const members = await dbc('estimates')
    .where({ estimate_group_id: groupId })
    .whereNull('archived_at')
    .select('id', 'customer_id', 'customer_phone', 'customer_email');
  const others = members.filter((m) => !selfId || String(m.id) !== String(selfId));
  if (!others.length) return;
  const normPhone = (v) => String(v || '').replace(/\D/g, '').slice(-10);
  const normEmail = (v) => String(v || '').trim().toLowerCase();
  const identityCustomerId = identity.customer_id ? String(identity.customer_id) : null;
  for (const member of others) {
    const memberCustomerId = member.customer_id ? String(member.customer_id) : null;
    const same = identityCustomerId || memberCustomerId
      ? identityCustomerId === memberCustomerId
      : (
        (normPhone(member.customer_phone).length === 10
          && normPhone(member.customer_phone) === normPhone(identity.customer_phone))
        || (normEmail(member.customer_email)
          && normEmail(member.customer_email) === normEmail(identity.customer_email))
      );
    if (!same) {
      throw errorWithStatus('estimateGroupId belongs to a different customer\'s group', 400);
    }
  }
}

function buildEstimatePersistenceFields(body, context = {}) {
  const estimateData = normalizeEstimateDethatchingManagerApproval(body.estimateData, context);
  const quoteRequired = estimateDataHasQuoteRequirement(estimateData) ||
    estimateDataHasUnresolvedManagerApproval(estimateData);
  const totals = resolveBillableTotals(body, estimateData, quoteRequired);
  applyResolvedTotalsToEstimateData(estimateData, totals, quoteRequired);
  const serviceInterest = inferEstimateServiceInterest({
    serviceInterest: body.serviceInterest,
    estimateData,
    monthlyTotal: totals.monthlyTotal,
    onetimeTotal: totals.onetimeTotal,
    notes: body.notes,
  });

  // Stamp the engine version that actually priced this estimate (varchar(80)
  // since migration 20260713000020 — lawn mechanism tokens like
  // LAWN_PRICING_V2_DENSE_35_FLOOR don't fit the original 10. Gated on the
  // resolved pricing authority, NOT just the blob: on CLIENT_FALLBACK the
  // blob is still the caller-supplied payload and may carry a stale
  // engineVersion from an earlier server price — a row the server did not
  // recompute must keep the column default rather than claim a version.
  const pricingVersion = context.pricingAuthority === 'SERVER'
    && typeof estimateData?.result?.engineVersion === 'string'
    ? estimateData.result.engineVersion.slice(0, 80)
    : null;

  return {
    // Always emitted: a non-SERVER rewrite RESETS the column to its migration
    // default, so a draft first stamped by a server price can't keep claiming
    // that version after a CLIENT_FALLBACK/quote-required rewrite replaced
    // its estimate_data (updates spread these fields over the existing row).
    pricing_version: pricingVersion || 'v4.2',
    customer_id: body.customerId || null,
    estimate_data: estimateData ? JSON.stringify(estimateData) : null,
    address: body.address,
    customer_name: body.customerName,
    customer_phone: body.customerPhone,
    customer_email: body.customerEmail,
    monthly_total: totals.monthlyTotal,
    annual_total: totals.annualTotal,
    onetime_total: totals.onetimeTotal,
    waveguard_tier: body.waveguardTier,
    service_interest: serviceInterest,
    notes: body.notes,
    satellite_url: body.satelliteUrl,
    show_one_time_option: !!body.showOneTimeOption,
    bill_by_invoice: !!body.billByInvoice,
  };
}

async function firstForUpdate(query) {
  const lockableQuery = typeof query.forUpdate === 'function' ? query.forUpdate() : query;
  return lockableQuery.first();
}

function parseStoredEstimateData(estimateData) {
  if (!estimateData) return null;
  if (typeof estimateData === 'string') {
    try {
      return JSON.parse(estimateData);
    } catch {
      return null;
    }
  }
  return typeof estimateData === 'object' ? estimateData : null;
}

// The full save-time pricing pipeline shared by create and revise: trust-strip
// the client payload, normalize the pest floor metadata, recompute the
// server-authoritative price, freeze membership artifacts, and validate the
// delivery options. Returns the estimates-table write fields (everything
// except the identity/lifecycle columns the caller owns: id, token, status,
// expires_at, created_by_technician_id).
// GATE_TERMITE_BOND_OPTION dark: a client-priced save (the legacy builder
// posts {inputs, result} with no replayable engineRequest, so the server
// falls back to the client preview) could persist a bond line the server
// engine would never emit — rendered, acceptable, and billed despite the
// kill switch (codex #2915 r1). Reject rather than strip: silently deleting
// a line the operator saw priced would desync the client-computed totals
// this save path trusts.
// Selected bond rows across EVERY persisted shape: mapped recurring lists
// AND the raw engine line items (engineResult.lineItems / result.lineItems)
// — the public/converter paths merge raw rows back into pricing and
// billing, so a guard that only scans recurring.services misses
// engine-backed saves (codex #2915 r6).
function selectedTermiteBondRows(estimateData) {
  const mapped = [estimateData?.result?.recurring?.services, estimateData?.recurring?.services]
    .flatMap((list) => (Array.isArray(list) ? list : []));
  const raw = [estimateData?.engineResult?.lineItems, estimateData?.result?.lineItems]
    .flatMap((list) => (Array.isArray(list) ? list : []));
  return [...mapped, ...raw].filter((svc) => String(svc?.service || '').toLowerCase().startsWith('termite_bond')
    || /termite bond/i.test(String(svc?.name || '')));
}

function assertNoDarkTermiteBondPayload(estimateData) {
  const gateOn = ['1', 'true', 'on'].includes(String(process.env.GATE_TERMITE_BOND_OPTION || '').toLowerCase());
  if (gateOn) return;
  const hasBondRow = selectedTermiteBondRows(estimateData).length > 0;
  if (hasBondRow) {
    throw errorWithStatus('Termite bond option is disabled (GATE_TERMITE_BOND_OPTION) — remove the bond selection and save again.', 422);
  }
}

// Station-rental twin of the bond guard above (codex P2, #2998 round 3):
// the engine enforces GATE_TERMITE_STATION_RENTAL only when IT prices, but
// client-priced payloads (no replayable engineRequest) fall back to their
// embedded result — without this check a fallback-shaped payload carrying a
// termite_station_rental row could be persisted, sent, accepted, and billed
// while the kill switch is off. Scans both the mapped rows and raw engine
// line items, same sweep as the bond selector.
function selectedTermiteStationRentalRows(estimateData) {
  const mapped = [estimateData?.result?.recurring?.services, estimateData?.recurring?.services]
    .flatMap((list) => (Array.isArray(list) ? list : []));
  const raw = [estimateData?.engineResult?.lineItems, estimateData?.result?.lineItems]
    .flatMap((list) => (Array.isArray(list) ? list : []));
  return [...mapped, ...raw].filter((svc) => String(svc?.service || '').toLowerCase() === 'termite_station_rental'
    || /termite station rental/i.test(String(svc?.name || '')));
}

function assertNoDarkTermiteRentalPayload(estimateData) {
  const gateOn = ['1', 'true', 'on'].includes(String(process.env.GATE_TERMITE_STATION_RENTAL || '').toLowerCase());
  if (gateOn) return;
  if (selectedTermiteStationRentalRows(estimateData).length > 0) {
    throw errorWithStatus('Termite station rental is disabled (GATE_TERMITE_STATION_RENTAL) — switch the estimate to purchased stations and save again.', 422);
  }
}

// Rental twin of assertLiveTermiteBondRates (codex P1, round 4): a
// client-priced save without a replayable engineRequest carries the uplift
// the CLIENT computed — if pricing_config.termite_rental changed since that
// bundle loaded, the stale horizon would be persisted and billed. The
// unconditional syncConstantsFromDB has already refreshed
// TERMITE.rental.recoveryQuarters; fail the save closed on any mismatch
// between the row's uplift and round(retailValue / live horizon) — never
// silently rewrite a line the operator saw priced.
function assertLiveTermiteRentalRates(estimateData, { liveConfigVerified = false } = {}) {
  const { TERMITE } = require('./pricing-engine/constants');
  const rentalRows = selectedTermiteStationRentalRows(estimateData);
  if (!rentalRows.length) return;
  const staleError = () => errorWithStatus('Termite station rental pricing has changed — recalculate the estimate before saving.', 422);
  // Fail closed when the live config could not be loaded (codex P1, round
  // 5): with the sync down, the cached recoveryQuarters may itself be the
  // stale value another pod already replaced — "matches the cache" proves
  // nothing. Same unverifiable-config posture as the pest floor normalizer.
  if (!liveConfigVerified) {
    throw errorWithStatus('Live rental pricing could not be verified — try the save again in a moment.', 422);
  }
  const quarters = Number(TERMITE.rental?.recoveryQuarters);
  if (!(quarters > 0)) throw staleError();
  for (const row of rentalRows) {
    const retail = Number(row.retailValue);
    const rowPerApp = Number(row.perTreatment ?? row.perApp);
    if (!(retail > 0) || !(rowPerApp > 0)) throw staleError();
    if (Math.abs(rowPerApp - Math.round(retail / quarters)) > 0.005) throw staleError();
  }
}

// A stale client bundle prices pest from its baked base (the mirror
// hardcoded $117 until #3182, DB-synced since), and the fallback save path
// has no replayable engineRequest — persistence would keep that price under
// CLIENT_FALLBACK authority. The unconditional syncConstantsFromDB above has
// refreshed the live constants; require a client-engine pest payload to have
// priced from the live pest_base.base and fail the save closed otherwise.
// An ABSENT stamp IS a stale bundle (pre-#3182 clients never stamped it),
// never a pass (codex #3182 r2 P1). Server-shaped payloads are untouched
// (their totals are server-recomputed); legacy pre-flag payloads keep the
// floor machinery's untouched posture — they also predate the fallback flag
// entirely.
function assertLivePestBaseForClientPayload(estimateData, { liveConfigVerified = false } = {}) {
  const root = estimateResultRoot(estimateData);
  const results = root?.results;
  if (!results || typeof results !== 'object') return;
  // One-time pest derives from the same base (quarterly × 2.2) but a
  // one-time-only fallback stores it ONLY under oneTime items — no
  // results.pest/pestTiers rows — so it must be gated too (codex r3 P0).
  const oneTimeItems = [
    ...(Array.isArray(root?.oneTime?.items) ? root.oneTime.items : []),
    ...(Array.isArray(results.oneTime) ? results.oneTime : []),
  ];
  const hasPestRows = (Array.isArray(results.pestTiers) && results.pestTiers.length > 0)
    || (results.pest && typeof results.pest === 'object')
    || oneTimeItems.some((item) => item && item.service === 'one_time_pest');
  if (!hasPestRows) return;
  const recurring = root.recurring && typeof root.recurring === 'object' ? root.recurring : null;
  const isClientEngineResult = !!recurring
    && Object.prototype.hasOwnProperty.call(recurring, 'pestProgramFloorApplied');
  if (!isClientEngineResult) return;
  // Fail closed when the live config could not be loaded: a one-time-only
  // pest payload skips the floor normalizer's 503 gate (no recurring rows),
  // so without this check a stamp matching the process-CACHED base would
  // pass while another pod's edit made that cache stale (codex r4 P0).
  // Same unverifiable-config posture as the rental assert.
  if (!liveConfigVerified) {
    throw errorWithStatus('Live pest pricing could not be verified — try the save again in a moment.', 422);
  }
  const liveBase = Math.round(Number(pricingEngine.constants.PEST.base));
  if (!(liveBase > 0)) {
    // An unusable live base proves nothing about the stamp — never wave
    // the save through.
    throw errorWithStatus('Live pest pricing could not be verified — try the save again in a moment.', 422);
  }
  const stamped = Number(root?.pricingMetadata?.pestBasePerVisit);
  if (!Number.isFinite(stamped) || Math.abs(stamped - liveBase) > 0.005) {
    throw errorWithStatus('Pest pricing has changed since this quote was generated — regenerate the estimate to price at the live base.', 409);
  }
}

// Client-priced saves can't server-recompute (the legacy builder ships no
// replayable engineRequest), so a stale client bundle could persist
// yesterday's bond rates after an admin edits pricing_config.termite_bond
// (codex #2915 r2). The unconditional syncConstantsFromDB above has already
// refreshed the live constants; fail the save closed on any mismatch —
// never silently rewrite a line the operator saw priced.
function assertLiveTermiteBondRates(estimateData) {
  const { TERMITE } = require('./pricing-engine/constants');
  const staleError = () => errorWithStatus('Termite bond rates have changed — recalculate the estimate before saving.', 422);

  const bondRows = selectedTermiteBondRows(estimateData);
  for (const row of bondRows) {
    const term = row.bondTerm || String(row.service || '').replace(/^termite_bond_/, '');
    const quarterly = Number(TERMITE.bond?.[term]?.quarterly);
    const rowPerApp = Number(row.perTreatment ?? row.perApp);
    if (!(quarterly > 0) || !(Math.abs(rowPerApp - quarterly) <= 0.005)) throw staleError();
  }

  // The quote-time OPTIONS snapshot must be live too (codex #2915 r3): a
  // "No bond" save still persists selectable rates, and PUT /:token/bond
  // later charges from that snapshot. But REJECTING an unselected stale
  // snapshot would brick every legacy-fallback termite save after an admin
  // rate edit until the client bundle redeploys (codex #2915 r4 — the
  // fallback engine bakes its table at build time). Nothing was chosen, no
  // total depends on it, and the builder shows term-only labels — so the
  // server RESTAMPS unselected snapshots to the live rates instead
  // (server-authoritative correction; both persisted shapes). Selected
  // rows above still fail closed — those the operator saw priced.
  const optionLists = [
    estimateData?.result?.results?.tmBait?.bondOptions,
    ...[estimateData?.engineResult?.lineItems, estimateData?.result?.lineItems]
      .map((items) => (Array.isArray(items)
        ? items.find((li) => li && li.service === 'termite_bait' && Array.isArray(li.bondOptions))?.bondOptions
        : null)),
  ];
  for (const options of optionLists) {
    if (!Array.isArray(options)) continue;
    for (const opt of options) {
      const cfg = TERMITE.bond?.[opt?.key];
      const quarterly = Number(cfg?.quarterly);
      if (!(quarterly > 0)) throw staleError(); // unknown term — never guess a rate
      const annual = Math.round(quarterly * 4 * 100) / 100;
      opt.quarterly = quarterly;
      opt.perApp = quarterly;
      opt.annual = annual;
      opt.monthly = Math.round((annual / 12) * 100) / 100;
    }
  }
}

async function resolveEstimateWritePayload({
  database = db,
  body,
  technicianId,
  technician,
  now = () => new Date(),
  recompute, // injectable for tests; defaults to serverRecomputeFromEstimateData
  pricingOut = null, // optional side-channel: { fallbackReason } for post-commit alerts
  storedProposal = null, // revise only: the ROW's estimate_data.proposal (server-owned, see stripClientProposal)
}) {
  const {
    showOneTimeOption,
    billByInvoice,
    estimateData,
  } = body;
  const trustedEstimateData = normalizeEstimateDethatchingManagerApproval(estimateData, {
    technician,
    technicianId,
    now,
  });
  // Delivery receipts are authored only under the send claim. A browser
  // cannot forge a completed attempt or clear the retry guard on revision.
  if (trustedEstimateData) delete trustedEstimateData.manualSendAttempts;
  // Before anything downstream derives from the payload (quoteRequired reads
  // proposal.enabled through buildPricingBundle): the browser's proposal is
  // discarded, the row's own is restored.
  stripClientProposal(trustedEstimateData, storedProposal);
  // Server-authoritative pest program floor: normalize client-stamped floor
  // metadata AND the client-baked lift in the totals BEFORE resolving the
  // billable preview, so CLIENT_FALLBACK persists collect per the live
  // DB-synced floor/kill switch. The sync is UNCONDITIONAL — the process-
  // local 60s cache is not authority when another pod just edited
  // pricing_config, and a client-priced payload has no server recompute to
  // correct a stale restamp (pre-push P0 on the main-merge). A failed sync
  // makes live config UNVERIFIABLE: the normalizer then fails the save
  // CLOSED for client-priced pest payloads instead of normalizing billable
  // totals against stale arm/floor values; every other save shape keeps the
  // last-synced constants as before.
  let liveConfigVerified = false;
  try {
    liveConfigVerified = typeof pricingEngine.syncConstantsFromDB === 'function'
      ? (await pricingEngine.syncConstantsFromDB(database)) !== false
      : true;
  } catch (err) {
    logger.warn(`[admin-estimate] pricing-config sync before floor normalize failed: ${err.message}`);
  }
  normalizeClientPestFloorMetadata(trustedEstimateData, { liveConfigVerified });
  assertLivePestBaseForClientPayload(trustedEstimateData, { liveConfigVerified });
  assertNoDarkTermiteBondPayload(trustedEstimateData);
  assertNoDarkTermiteRentalPayload(trustedEstimateData);
  assertLiveTermiteBondRates(trustedEstimateData);
  assertLiveTermiteRentalRates(trustedEstimateData, { liveConfigVerified });
  const quoteRequired = estimateDataHasQuoteRequirement(trustedEstimateData) ||
    estimateDataHasUnresolvedManagerApproval(trustedEstimateData);
  const clientPreview = resolveBillableTotals(body, trustedEstimateData, quoteRequired);
  // For an estimate linked to an existing customer, load the WaveGuard-qualifying
  // recurring services they already have so the engine reprices at the COMBINED
  // tier. Best-effort: a failure here must not block the save, it just means the
  // estimate prices on its own services as before.
  let priorQualifyingServices = [];
  // Server-verified recurring-customer status (gates the 15% one-time perk).
  // Fail-closed to false: a lookup miss/error charges as a non-member, never
  // silently grants the perk — same posture as isActivePlanCustomer itself.
  let recurringCustomer = false;
  // Existing-customer evidence, split by PURPOSE (codex #3591 r34 P1) through
  // the resolver the estimator preview shares (resolveCustomerQualifyingEvidence):
  //   • priorQualifyingServices — the TIER context, per-property (codex #3244
  //     r1/r5/r6; owner ruling 2026-08-06: a grouped estimate, or one quoting
  //     a NON-primary street, prices at its own property's service count).
  //   • setupWaiverPriorQualifyingServices — the rodent bait-station setup
  //     waiver, ACCOUNT-wide (owner 2026-08-29: any other qualifying plan on
  //     the account waives it, whichever address it serves).
  // The recurring-customer 15% one-time perk below stays account-level too.
  // A lookup failure refuses the save retryably: reading it as "no other
  // qualifier" would persist a lower tier and an unwarranted $99 setup row
  // for an existing member (codex #3591 r31 P1).
  let setupWaiverPriorQualifyingServices = [];
  let groupedEstimate = !!(body.groupWithEstimateId || body.estimateGroupId);
  let perPropertyStreetScope = null;
  if (body.customerId) {
    try {
      const evidence = await resolveCustomerQualifyingEvidence(database, {
        customerId: body.customerId,
        address: body.address || null,
        groupedEstimate,
        logger,
        loadKeys: loadExistingQualifyingServiceKeys,
      });
      priorQualifyingServices = evidence.tierKeys;
      setupWaiverPriorQualifyingServices = evidence.setupWaiverKeys;
      groupedEstimate = evidence.groupedEstimate;
      perPropertyStreetScope = evidence.perPropertyStreetScope;
    } catch (err) {
      logger.warn(`[admin-estimate] prior qualifying services lookup failed — refusing save: ${err.message}`);
      throw errorWithStatus('Could not confirm this customer\'s existing services. Retry the save.', 503);
    }
    try {
      recurringCustomer = await isActivePlanCustomer(database, body.customerId);
    } catch (err) {
      logger.warn(`[admin-estimate] active-plan lookup skipped: ${err.message}`);
    }
  }
  const pricing = await resolveServerAuthoritativePricing({
    estimateData: trustedEstimateData,
    clientPreview,
    quoteRequired,
    now,
    recompute,
    priorQualifyingServices,
    setupWaiverPriorQualifyingServices,
    recurringCustomer,
  });
  if (pricingOut && typeof pricingOut === 'object') pricingOut.fallbackReason = pricing.fallbackReason || null;
  const totals = pricing.totals;
  applyResolvedTotalsToEstimateData(trustedEstimateData, totals, quoteRequired);
  // The combined-tier reprice only landed in the persisted/charged totals when
  // the server authoritatively recomputed. On CLIENT_FALLBACK (no replayable
  // engine input) the saved totals are the un-repriced client preview, so we
  // must NOT write any membership artifacts that would advertise a discount the
  // charge doesn't include.
  const repricedAtServer = pricing.audit?.pricing_authority === 'SERVER';
  // Persist the prior qualifying services into the replayable estimate data so
  // any LATER recompute from stored inputs (public bundle CTA, frequency
  // slider) keeps the combined WaveGuard tier (extractEngineInputs re-injects).
  if (repricedAtServer && priorQualifyingServices.length) {
    trustedEstimateData.priorQualifyingServices = priorQualifyingServices;
  } else {
    delete trustedEstimateData.priorQualifyingServices;
  }
  // Same round-trip for the ACCOUNT-wide setup-waiver evidence (codex #3591
  // r34 P1): a grouped/secondary-property rodent quote whose tier list is
  // property-scoped must not re-add the $99 setup on a public replay when
  // the account holds another plan. Server-derived only, like the tier list.
  if (repricedAtServer && setupWaiverPriorQualifyingServices.length) {
    trustedEstimateData.setupWaiverPriorQualifyingServices = setupWaiverPriorQualifyingServices;
  } else {
    delete trustedEstimateData.setupWaiverPriorQualifyingServices;
  }
  // Strip the client-claimed identity/recurring flags from every STORED replay
  // shape (engineInputs + engineRequest.options). extractEngineInputs replays
  // from engineInputs on the public reprice, so a forged
  // priorQualifyingServices / recurringCustomer left in the stored blob would
  // otherwise be restored at accept/charge time even though the initial save
  // is stamped SERVER. The authoritative combined-tier value lives in the
  // top-level trustedEstimateData.priorQualifyingServices set above (which
  // extractEngineInputs re-injects); recurring status re-derives from those
  // priors + the cart on replay — so a non-member cannot restore a forged one.
  sanitizeClientIdentityFields(trustedEstimateData.engineInputs);
  sanitizeClientIdentityFields(trustedEstimateData.inputs);
  if (trustedEstimateData.engineRequest && typeof trustedEstimateData.engineRequest === 'object') {
    sanitizeClientIdentityFields(trustedEstimateData.engineRequest.options);
  }
  // Persist the SERVER-verified recurring-customer status into the stored
  // engineInputs so a public reprice reapplies the perk a verified active-plan
  // member earned at save — even when they hold NO WaveGuard-qualifying prior
  // services (so priorQualifyingServices is empty and can't carry it, and the
  // cart alone wouldn't re-derive it). Written AFTER the sanitize so it is the
  // server value, never a replayed client claim; only for a verified member,
  // so a non-member's replay still can't gain the perk.
  if (repricedAtServer && recurringCustomer) {
    if (trustedEstimateData.engineInputs && typeof trustedEstimateData.engineInputs === 'object') {
      trustedEstimateData.engineInputs.recurringCustomer = true;
    }
    if (trustedEstimateData.inputs && typeof trustedEstimateData.inputs === 'object') {
      trustedEstimateData.inputs.recurringCustomer = true;
      // `inputs` is the admin builder's FORM snapshot: edit mode seeds the
      // form from it and prices from the string toggle isRecurringCustomer
      // (EstimateToolViewV2), not the engine boolean. Without this a member's
      // reopened estimate shows the toggle "NO" and edit previews price as a
      // non-member until the save's server recompute corrects it.
      trustedEstimateData.inputs.isRecurringCustomer = 'YES';
    }
  }
  // Freeze the WaveGuard membership card onto the estimate, computed from the
  // SAME repriced data + prior services, so the customer-facing card reflects
  // exactly what was priced/charged and never re-derives from mutable service
  // rows at view time. Cleared if the estimate no longer qualifies or wasn't
  // server-repriced, and never blocks the save on error.
  let membershipSnapshot = null;
  if (repricedAtServer && body.customerId) {
    try {
      membershipSnapshot = await computeMembershipContext(database, {
        customerId: body.customerId,
        estData: trustedEstimateData,
        // The snapshot sees exactly the rows the priors lookup above priced
        // with (codex #3338 r22): grouped estimates scope to the quoted
        // street; a grouped estimate whose street could not be parsed
        // priced with NO priors, so the snapshot sees none either. The
        // primary-address lane prices priors ACCOUNT-WIDE (long-standing),
        // so its tier context stays account-wide to match — but its frozen
        // PLAN is still bounded to the quoted street (codex #3338 r8): a
        // multi-property customer's other-property series must never be
        // frozen (or later repriced) by a primary-address estimate.
        ...(groupedEstimate
          ? (perPropertyStreetScope
            ? { streetScope: perPropertyStreetScope }
            : { excludeExistingRows: true })
          : (perPropertyStreetScope
            ? { extensionStreetScope: perPropertyStreetScope }
            : {})),
        // This lane resolves property scope, so it may freeze an
        // existing-service extension plan — but only when the quoted street
        // actually resolved (no parsed street = no way to bound the plan =
        // review-bell fallback, fail closed). Agent lanes (IB estimate
        // tools, estimator engine) pass no scope and deliberately stay
        // plan-less (codex #3338 r7).
        freezeExtensionPlan: !!perPropertyStreetScope,
      });
      if (membershipSnapshot) trustedEstimateData.membershipSnapshot = membershipSnapshot;
      else delete trustedEstimateData.membershipSnapshot;
    } catch (err) {
      logger.warn(`[admin-estimate] membership snapshot skipped: ${err.message}`);
      delete trustedEstimateData.membershipSnapshot;
    }
  } else {
    delete trustedEstimateData.membershipSnapshot;
  }
  // When prior services raised the combined tier, persist that authoritative
  // tier into the estimates.waveguard_tier column (the client preview may still
  // say Bronze). The public bundle + acceptance read this column for badges and
  // some tier math, so it must match the repriced estimate_data totals.
  const resolvedWaveguardTier = (repricedAtServer && priorQualifyingServices.length && membershipSnapshot?.tierLabel)
    ? membershipSnapshot.tierLabel
    : body.waveguardTier;
  const deliveryError = validateEstimateDeliveryOptions({
    showOneTimeOption: !!showOneTimeOption,
    billByInvoice: !!billByInvoice,
    onetimeTotal: totals.onetimeTotal,
    monthlyTotal: totals.monthlyTotal,
    annualTotal: totals.annualTotal,
    estimateData: trustedEstimateData,
  });
  if (deliveryError) throw errorWithStatus(deliveryError, 400);

  return {
    ...buildEstimatePersistenceFields(
      { ...body, waveguardTier: resolvedWaveguardTier, estimateData: trustedEstimateData },
      { technician, technicianId, now, pricingAuthority: pricing.audit?.pricing_authority },
    ),
    ...(await resolveEstimatePropertyLinkage(database, body)),
    ...pricing.audit,
  };
}

// Save-time member-linkage guard (workstream-1 hardening, 2026-08-10): the
// combined-tier machinery only engages when the builder LINKS the customer
// (body.customerId) — the auto-link needs Lookup to run AND the typed
// address to contain the stored street, and missing either silently prices
// an active member's add-on estimate as a new lead (no combined tier, no
// member card, full setup fee), with nothing anywhere saying so. Detect
// that shape server-side and hand the builder a warning to surface.
// Read-only, fail-soft, response-only: never blocks the save, never
// persists, never auto-links (an in-place revise must not silently move a
// row between accounts — the operator confirms and re-saves).
async function detectUnlinkedMemberAddress(database, body = {}) {
  try {
    if (body.customerId || !body.address) return null;
    // Same candidate set the builder's link suggestions and the Customer 360
    // "Others at this address" block use (customer-address-match.js).
    const rows = await findCustomersAtAddress(database, body.address);
    const candidate = rows.find(isMembershipCustomerRow);
    if (!candidate) return null;
    const name = `${candidate.first_name || ''} ${candidate.last_name || ''}`.trim() || 'an active member';
    return {
      customerId: candidate.id,
      customerName: name,
      waveguardTier: candidate.waveguard_tier || null,
      message: `This address matches ${name}'s account${candidate.waveguard_tier ? ` (WaveGuard ${candidate.waveguard_tier})` : ''}, but the estimate isn't linked to a customer — member pricing (combined WaveGuard tier) was NOT applied. Link the customer and save again to price at the member rate.`,
    };
  } catch (err) {
    logger.warn(`[admin-estimate] unlinked-member address check skipped: ${err.message}`);
    return null;
  }
}

async function createOrReuseAdminEstimate({
  database = db,
  body,
  technicianId,
  technician,
  now = () => new Date(),
  randomBytes = crypto.randomBytes,
  recompute, // injectable for tests; defaults to serverRecomputeFromEstimateData
}) {
  const clientDraftId = body.clientDraftId || null;
  if (clientDraftId && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(clientDraftId)) {
    throw errorWithStatus('Invalid draft identifier.', 400);
  }
  const linkedLeadId = normalizeLinkedLeadId(body.leadId);
  const pricingOut = {};
  const writeFields = await resolveEstimateWritePayload({
    database,
    body,
    technicianId,
    technician,
    now,
    recompute,
    pricingOut,
  });
  const expiresAt = estimateExpiresAt(now);
  const memberLinkageWarning = await detectUnlinkedMemberAddress(database, body);

  return database.transaction(async (trx) => {
    // Reuse the estimate's primary identity for a retried create. The lock
    // serializes double submissions before the existing lead/group writers.
    if (clientDraftId) {
      await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?))', ['estimate-draft', clientDraftId]);
      const prior = await trx('estimates').where({ id: clientDraftId }).first();
      if (prior) {
        const priorData = parseStoredEstimateData(prior.estimate_data) || {};
        if (String(prior.created_by_technician_id) !== String(technicianId)
            || !isDeepStrictEqual(priorData.inputs, parseStoredEstimateData(writeFields.estimate_data)?.inputs)
            || ['customer_id', 'address', 'customer_name', 'customer_phone', 'customer_email', 'notes', 'show_one_time_option', 'bill_by_invoice']
              .some((key) => (prior[key] ?? null) !== (writeFields[key] ?? null))) {
          throw errorWithStatus('This draft was already saved with different inputs. Reopen it before making changes.', 409);
        }
        return { estimate: prior, reused: true, memberLinkageWarning };
      }
    }
    let canReplaceLinkedEstimate = false;

    // "Add another property": the builder passes the FIRST estimate's id and
    // the new sibling joins (or starts) its group. Resolved inside the
    // transaction so the anchor's minted group id and the sibling's insert
    // commit together.
    // A NEW property joining a group is judged like a revision moving into
    // it (uncapped codex P1 r13), in the ONE lock order every send/schedule
    // path uses — the group's advisory lock BEFORE any estimate row lock
    // (pre-push codex P1 r15: ensureEstimateGroupId FOR UPDATEs the anchor,
    // so the anchor's current group is read and locked first; a group minted
    // for a still-ungrouped anchor has no sends to race and is locked once
    // its id exists). Then the scheduled / mid-send verdict for an
    // unverified write: a fallback-priced property added after the anchor
    // was scheduled would otherwise be refused by the cron's group preflight
    // and fail the anchor. Re-acquiring a held advisory xact lock is a no-op.
    const joining = { id: null, estimate_group_id: null };
    if (body.groupWithEstimateId) {
      const anchorRow = await trx('estimates').where({ id: body.groupWithEstimateId }).first('estimate_group_id');
      const anchorGroupId = anchorRow?.estimate_group_id || null;
      if (anchorGroupId) {
        await lockScheduledGroupGuardGroups(trx, joining, { ...writeFields, estimate_group_id: anchorGroupId });
      }
      writeFields.estimate_group_id = await ensureEstimateGroupId(trx, body.groupWithEstimateId, writeFields, undefined, { expectUngrouped: !anchorGroupId });
      if (anchorGroupId && String(writeFields.estimate_group_id) !== String(anchorGroupId)) {
        throw errorWithStatus('Estimate group changed; refresh and try again.', 409);
      }
    } else if (writeFields.estimate_group_id) {
      await lockScheduledGroupGuardGroups(trx, joining, writeFields);
      await assertGroupAssignmentAllowed(trx, writeFields.estimate_group_id, writeFields);
    }
    if (writeFields.estimate_group_id) {
      await lockScheduledGroupGuardGroups(trx, joining, writeFields);
      await assertNoFallbackRevisionInScheduledGroup(trx, joining, writeFields);
    }

    // Linked-draft reuse (pre-push codex P1 r18): a create that omits the
    // grouping fields may still REUSE the lead's existing GROUPED draft and
    // stamp it unverified — its stored group is judged like a revision's,
    // in lock order: the draft's group is read unlocked and its advisory
    // lock taken BEFORE the lead/draft row locks below; the locked draft's
    // group is re-checked against what was locked, and the scheduled /
    // mid-send verdict runs on the locked row before the reuse update.
    let reuseGroupLocked = null;
    if (linkedLeadId) {
      const linkedLead = await trx('leads').where({ id: linkedLeadId }).whereNull('deleted_at').first('estimate_id');
      if (linkedLead?.estimate_id) {
        const linkedDraft = await trx('estimates').where({ id: linkedLead.estimate_id }).first('estimate_group_id', 'status');
        if (linkedDraft?.estimate_group_id) {
          reuseGroupLocked = String(linkedDraft.estimate_group_id);
          await lockScheduledGroupGuardGroups(trx, { id: linkedLead.estimate_id, estimate_group_id: reuseGroupLocked }, writeFields);
        }
      }
    }

    if (linkedLeadId) {
      const lead = await firstForUpdate(trx('leads').where({ id: linkedLeadId }).whereNull('deleted_at'));
      if (!lead) throw errorWithStatus('Lead not found', 404);

      if (lead.estimate_id) {
        const existingEstimate = await firstForUpdate(trx('estimates').where({ id: lead.estimate_id }));
        if (existingEstimate?.status === 'draft') {
          // A linked COMMERCIAL PROPOSAL draft is never reused by the generic
          // save (GH codex P2 r6 on #3750): its proposal is server-owned and
          // its totals come from the authored line items — the generic
          // payload would strip the proposal and clobber the totals while
          // the COMMERCIAL category stayed behind. Same refusal as the
          // generic revise (estimateReviseBlock).
          // Guarded on the COMMERCIAL category OR any stored proposal object —
          // not only the editor-routing flags (enabled/scaffold): an authored
          // proposal later saved DISABLED carries neither, and losing it is
          // data loss all the same (pre-push codex P0).
          if (linkedDraftCarriesProposal(existingEstimate)) {
            throw errorWithStatus('This lead already has a commercial proposal draft — edit it with the Commercial proposal editor instead of saving a new estimate over it.', 409);
          }
          // The locked draft's group must be the one locked above (a group
          // change in the gap would need an out-of-order lock — refuse for a
          // retry); then the scheduled / mid-send verdict on the locked row.
          if (fallbackRevisionGroupIds(existingEstimate, writeFields).some((groupId) => groupId !== reuseGroupLocked && groupId !== String(writeFields.estimate_group_id || ''))) {
            throw errorWithStatus('Estimate group changed; refresh and try again.', 409);
          }
          await assertNoFallbackRevisionInScheduledGroup(trx, existingEstimate, writeFields);
          const existingAttempts = parseStoredEstimateData(existingEstimate.estimate_data)?.manualSendAttempts;
          if (Array.isArray(existingAttempts)) {
            writeFields.estimate_data = JSON.stringify({
              ...parseStoredEstimateData(writeFields.estimate_data), manualSendAttempts: existingAttempts,
            });
          }
          const nextEstimate = { ...existingEstimate, ...writeFields, expires_at: expiresAt };
          assertLeadCanAttachEstimate({
            lead,
            estimate: nextEstimate,
            estimateId: existingEstimate.id,
          });
          const [updated] = await trx('estimates')
            .where({ id: existingEstimate.id, status: 'draft' })
            .update({
              ...writeFields,
              expires_at: expiresAt,
              updated_at: now(),
            })
            .returning('*');
          if (!updated) {
            throw errorWithStatus('Estimate draft changed; refresh and try again.', 409);
          }
          // The builder just wholesale-replaced whatever composition this
          // linked draft held, and `source` is not part of the write payload
          // so an AI draft stays an AI draft. Capture the locked pre-edit
          // row: an operator discarding the AI composition entirely is a
          // maximal edit, not a sent-unedited (same contract as
          // reviseAdminEstimate — see estimate-learning.js).
          await recordPreSendRevision({ priorEstimate: existingEstimate, trx });
          clearEstimatePricingCache(existingEstimate.id);
          return {
            estimate: updated,
            reused: true,
            memberLinkageWarning,
            pricingFallbackReason: pricingOut.fallbackReason || null,
          };
        }

        if (existingEstimate && !existingEstimate.archived_at) {
          throw errorWithStatus(
            'Lead is already linked to an active estimate. Archive or delete the existing estimate before creating a new one.',
            409,
          );
        }

        canReplaceLinkedEstimate = true;
      }
    }

    const token = randomBytes(16).toString('hex');
    const [created] = await trx('estimates').insert({
      ...writeFields,
      ...(clientDraftId ? { id: clientDraftId } : {}),
      created_by_technician_id: technicianId,
      token,
      expires_at: expiresAt,
    }).returning('*');

    if (linkedLeadId) {
      await attachLeadToEstimate({
        database: trx,
        leadId: linkedLeadId,
        estimateId: created.id,
        estimate: created,
        technician,
        allowReplacingEstimateId: canReplaceLinkedEstimate,
      });
    }

    return {
      estimate: created,
      reused: false,
      memberLinkageWarning,
      pricingFallbackReason: pricingOut.fallbackReason || null,
    };
  });
}

// Engine-authoritative pricing on a LIVE link (validation audit SEC-002,
// pre-push codex P0s): a delivered estimate's bearer link renders whatever
// is stored, so a revision whose recompute fell back to the browser preview
// is not persisted while GATE_SEND_REQUIRES_SERVER_PRICING is on — nothing
// is saved (dryRun preflights surface the same refusal), the operator fixes
// the inputs and retries. Drafts keep the fail-open save; the send gate
// holds them. A SCHEDULED row is protected too (GH codex P1 on #3750): it
// stays editable, and a fallback revision that kept status='scheduled'
// would be claimed by the cron, rejected by assertEstimateSendable, and
// burn its retries into send_failed. Called on the pre-read row (fast
// refusal, preflight-visible) AND on the locked row inside the write
// transaction (the send-versus-revise race), so the verdict can never
// depend on a stale read.
// "Unverified" = the write stamps ANY authority other than SERVER — the
// engine-error CLIENT_FALLBACK, and the NULL a quote-required revision is
// deliberately stamped with (pre-push codex P1): with the gate on neither
// can be sent, and a grouped send must not deliver either beside a SERVER
// anchor. A write that carries no pricing_authority at all is not a
// pricing write and is never judged here.
function writeStampsUnverifiedPricing(writeFields) {
  if (!writeFields || !Object.prototype.hasOwnProperty.call(writeFields, 'pricing_authority')) return false;
  return String(writeFields.pricing_authority || '').toUpperCase() !== 'SERVER';
}

function assertNoFallbackRevisionOfLiveLink(row, writeFields) {
  if (!row) return;
  const live = row.sent_at || row.viewed_at || String(row.status || '') === 'scheduled';
  if (!live) return;
  if (!writeStampsUnverifiedPricing(writeFields)) return;
  if (!require('../config/feature-gates').isEnabled('sendRequiresServerPricing')) return;
  throw errorWithStatus(
    String(row.status || '') === 'scheduled' && !(row.sent_at || row.viewed_at)
      ? 'The pricing engine could not verify this revision and the estimate is scheduled to send — nothing was saved. Fix the inputs and try again, or unschedule it first.'
      : 'The pricing engine could not verify this revision and the estimate is already with the customer — nothing was saved. Fix the inputs and try again.',
    409,
  );
}

// A DRAFT member of a group whose anchor is SCHEDULED is a live link in
// waiting (GH codex P2 r5 on #3750): the cron's group claim publishes every
// active sibling and refuses a fallback one, failing the anchor without a
// retry. So a fallback revision of such a member is refused like a live
// link's. Runs on the LOCKED row inside the write transaction; the schedule
// route locks the sibling rows FOR UPDATE inside its own scheduling
// transaction, so the two serialize and this read is never stale.
// The groups a FALLBACK revision must be judged against: the row's CURRENT
// group and the revision's DESTINATION group (GH codex P2 r7 — a fallback
// move into a group whose anchor is scheduled would be refused by the
// cron's group preflight later and fail that anchor). Gate-independent:
// the mid-send verdict below applies with the rollout gate off too.
// Sorted, so every path takes the groups' advisory locks in one order.
function fallbackRevisionGroupIds(row, writeFields) {
  if (!writeStampsUnverifiedPricing(writeFields)) return [];
  return [...new Set([row?.estimate_group_id, writeFields?.estimate_group_id].filter(Boolean).map(String))].sort();
}

// A LIVE row moving into another group exposes that group's viewable
// siblings through its link the moment the revision commits, with no send
// preflight in between (GH codex P1 r10): even a SERVER-priced revision
// must therefore have the DESTINATION group judged and locked. "Live" is
// the same set assertNoFallbackRevisionOfLiveLink uses — sent, viewed, OR
// scheduled (GH codex P2 r11: a scheduled first-send row keeps its schedule
// while joining the group, and the cron's group preflight would fail the
// anchor later instead of this save refusing now). Gate-scoped like the
// delivery verdict it mirrors.
function liveGroupMoveDestinationIds(row, writeFields) {
  if (!require('../config/feature-gates').isEnabled('sendRequiresServerPricing')) return [];
  const live = !!(row?.sent_at || row?.viewed_at || String(row?.status || '') === 'scheduled');
  const destination = writeFields?.estimate_group_id ? String(writeFields.estimate_group_id) : null;
  if (!live || !destination || destination === String(row?.estimate_group_id || '')) return [];
  return [destination];
}

// Every offer revision locks its current and destination groups before
// its row, so a reviewed group cannot change during provider handoff.
function revisionGroupLockIds(row, writeFields) {
  return [...new Set([row?.estimate_group_id, writeFields?.estimate_group_id].filter(Boolean).map(String))].sort();
}

// The destination group's viewable siblings must each be engine-verified
// (or an editor-authored proposal by provenance) before a live row joins
// them — the same verdict the send claims apply, mirrored here because the
// join itself publishes them (GH codex P1 r10).
async function assertLiveRowMayJoinGroup(trx, row, writeFields) {
  const { applyLinkVisibleSiblingScope, rowPassesGatedSendAuthority } = require('./pricing-authority-gate');
  for (const groupId of liveGroupMoveDestinationIds(row, writeFields)) {
    // The siblings the joined link will actually render — the shared
    // link-visible scope (uncapped codex P1 r19), terminal rows included.
    const siblings = await applyLinkVisibleSiblingScope(
      trx('estimates')
        .where({ estimate_group_id: groupId })
        .whereNot({ id: row?.id }),
    ).select('id', 'status', 'price_locked_at', 'pricing_authority', 'estimate_data');
    for (const sibling of siblings) {
      // The ONE shared row verdict (uncapped codex P1 r21).
      if (rowPassesGatedSendAuthority(sibling)) continue;
      throw errorWithStatus(
        'That multi-property group has a property without an engine-verified price — re-save it from the estimate tool before moving this estimate into the group (the group link shows every property together). Nothing was saved.',
        409,
      );
    }
  }
}

// The scheduled-group verdict applies only while the rollout gate is on —
// with it off, a scheduled group's members deliver fallback pricing by design
// (shadow mode) and the cron's claim refuses nothing.
function scheduledGroupGuardGroupIds(row, writeFields) {
  if (!require('../config/feature-gates').isEnabled('sendRequiresServerPricing')) return [];
  return fallbackRevisionGroupIds(row, writeFields);
}

// LOCK ORDER (pre-push codex P1): group advisory xact lock(s) FIRST, then
// the estimate row FOR UPDATE — the order the schedule route (group lock,
// then the siblings FOR UPDATE) and the group send claim (group lock, then
// the anchor claim) already use. The revise calls this BEFORE its row lock,
// so a revision racing a schedule of the same group waits instead of
// deadlocking (row held + waiting for the group lock vs group lock held +
// waiting for the row).
async function lockScheduledGroupGuardGroups(trx, row, writeFields) {
  const groupIds = revisionGroupLockIds(row, writeFields);
  for (const groupId of groupIds) {
    await trx.raw(
      'SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))',
      ['estimate-group-send', groupId],
    );
  }
  return groupIds;
}

// A grouped send in flight (any member 'sending' — manual, cron or lead
// auto-send) holds the group's viewable siblings for the customer's link
// through the provider handoff, and the auto-send lane publishes only
// engine-verified prices GATE OR NO GATE (AGENTS.md estimator-engine
// authority). Any revision during that window could change the confirmed
// group document, so it is refused, gate-independent, under the
// group lock: the send's claim (group lock, then anchor 'sending') either
// committed first (refused here) or runs after this revision commits and
// judges the new stamp in its own preflight.
// "In flight" is a member that is 'sending' OR still holds a fresh delivery
// claim (uncapped codex P0 r35): an anchor accepted or declined mid-handoff
// leaves 'sending' while the automated group link is still being delivered
// under its claim — the same verdict the proposal editor applies.
async function assertNoRevisionDuringGroupSend(trx, row, writeFields) {
  const groupIds = revisionGroupLockIds(row, writeFields);
  for (const groupId of groupIds) {
    const sendingMember = await trx('estimates')
      .where({ estimate_group_id: groupId })
      .whereNot({ id: row?.id })
      .whereNull('archived_at')
      .where((q) => q.where({ status: 'sending' }).orWhereRaw(`NOT (${DELIVERY_CLAIM_NOT_LIVE_SQL})`))
      .first('id');
    if (!sendingMember) continue;
    throw errorWithStatus(
      'This multi-property group is being sent right now — nothing was saved. Wait a moment and try again.',
      409,
    );
  }
}

// The verdict itself never locks: the write path holds the group locks from
// lockScheduledGroupGuardGroups (taken before the row lock), and the dryRun
// preflight reads unlocked, best-effort — the locked recheck in the write is
// authoritative.
async function assertNoFallbackRevisionInScheduledGroup(trx, row, writeFields) {
  await assertNoRevisionDuringGroupSend(trx, row, writeFields);
  const groupIds = scheduledGroupGuardGroupIds(row, writeFields);
  for (const groupId of groupIds) {
    const scheduledMember = await trx('estimates')
      .where({ estimate_group_id: groupId, status: 'scheduled' })
      .whereNot({ id: row?.id })
      .whereNull('archived_at')
      .first('id');
    if (!scheduledMember) continue;
    const destination = String(row?.estimate_group_id || '') !== groupId;
    throw errorWithStatus(
      destination
        ? 'The pricing engine could not verify this revision and the multi-property group it would join is scheduled to send — nothing was saved. Fix the inputs and try again, or unschedule that group first.'
        : 'The pricing engine could not verify this revision and this property\'s multi-property group is scheduled to send — nothing was saved. Fix the inputs and try again, or unschedule the group first.',
      409,
    );
  }
}

// Statuses a revise can never touch. Acceptance locks the price and spins up
// downstream records; declined/expired are closed; `sending` means a send is
// mid-flight (editing under it would race the sender's pre-send read into a
// stale-content send). draft / scheduled / sent / viewed / send_failed remain
// editable — the whole point is fixing a quote the customer already has.
const REVISE_BLOCKED_STATUSES = ['accepted', 'declined', 'expired', 'sending'];

// Single source of truth for "can this estimate be edited in place?" —
// consumed by the revise write below and by GET /:id/edit-source so the
// builder can explain a non-editable row instead of failing on save.
// Returns null when editable, otherwise { message, statusCode }.
// An EXPIRED row the pricing-authority gate refuses has no other way back
// (GH codex P1 r30 on #3750): extension is refused until the row is
// engine-verified, and the expiry rule refuses the revise until extended.
// While the gate is on, such a row may be revised — the write leaves it
// expired, and only an engine-verified reprice can land on it (a fallback
// or NULL write is refused by the live-link guard) — so the operator
// re-saves it through the engine and then extends it.
function expiredRowRecoverableUnderGate(row) {
  const gate = require('./pricing-authority-gate');
  return gate.gatedSendAuthorityPredicateApplies() && !gate.rowPassesGatedSendAuthority(row || {});
}

function estimateReviseBlock(estimate, estimateData, now = new Date()) {
  const parsed = estimateData === undefined
    ? parseStoredEstimateData(estimate?.estimate_data)
    : estimateData;
  const expiredRecovery = expiredRowRecoverableUnderGate(estimate);
  if (estimate?.archived_at) {
    return { message: 'Estimate is archived. Unarchive it before editing.', statusCode: 400 };
  }
  // Scaffolds (enabled:false, machine-seeded by the commercial proposal
  // lane) count too — the revise write below rejects COMMERCIAL rows, so
  // letting one into the builder loses the operator's edits at save time.
  if (require('./estimate-proposal').isCommercialProposalData(parsed)) {
    return { message: 'This estimate is a commercial proposal — edit it with the Commercial proposal editor.', statusCode: 400 };
  }
  if (estimate?.price_locked_at) {
    return { message: 'This estimate is price-locked (accepted) and can no longer be edited.', statusCode: 409 };
  }
  // Customer plan-restart quotes are never revised in place (codex GH r17
  // P1 on #3671): their scope is fixed by the cancellation attempt and
  // their price is always today's mint (owner ruling — one honorable
  // price). An edited copy either bricked acceptance (planRestart dropped
  // wholesale) or, preserved, let a changed composition restart work
  // outside the cancellation scope; blocking is the only shape that keeps
  // both invariants.
  if (String(estimate?.source || '') === 'plan_restart') {
    return { message: 'This is a customer plan-restart quote — its scope is fixed by the cancellation and it always prices at the current mint. It cannot be edited in place; the customer re-taps "Restart my plan" for a fresh quote.', statusCode: 409 };
  }
  const status = String(estimate?.status || '');
  if (status === 'sending') {
    return { message: 'This estimate is being sent right now. Wait for the send to finish, then retry.', statusCode: 409 };
  }
  if (REVISE_BLOCKED_STATUSES.includes(status) && !(status === 'expired' && expiredRecovery)) {
    return { message: `A ${status} estimate can no longer be edited.`, statusCode: 409 };
  }
  // Date-expired rows the daily expiration worker hasn't flipped yet are
  // expired all the same: the public route serves the expired page off the
  // timestamp, so a revise would report saved while the customer's link keeps
  // showing nothing new. Same verdict as status='expired'.
  const expiresAt = estimate?.expires_at ? new Date(estimate.expires_at) : null;
  if (expiresAt && !Number.isNaN(expiresAt.getTime()) && expiresAt <= now && !expiredRecovery) {
    return { message: 'This estimate has passed its expiration date and can no longer be edited. Extend it first, then edit.', statusCode: 409 };
  }
  return null;
}

// Row-level keys that live INSIDE estimate_data but are linkage, not quote
// content: the lead_id mirror (lead rows with no leads.estimate_id FK rely on
// it for send/view/acceptance advancement) and the schedule-stitch pointer
// the pipeline list + booking flows resolve appointments through. A revise
// replaces estimate_data wholesale, so these must be carried across.
// lead_linkage rides with lead_id (codex P0, PR #3304): it is the durable
// provenance the estimator's existing-draft reconciliation needs to judge
// whether an unlink may invalidate the draft — dropping it on revise made
// a later stamp-clear skip invalidation and leave the former lead's draft
// sendable to the wrong recipient.
const REVISE_PRESERVED_ESTIMATE_DATA_KEYS = ['lead_id', 'lead_linkage', 'scheduled_service_id', 'manualSendAttempts'];
// Click-to-estimate mints (#3391 audit P0): both markers are
// lifecycle-critical and PRIOR-WINS across a revise — the zero-comms
// opt-out is the lane's owner-approved contract (a revise must never
// re-enable automated outreach), and reportCtaMint is the durable lineage
// the mint resolves reuse/supersession through (dropping it permits a
// second live estimate at a second honorable price). The offer FINGERPRINT
// inside the lineage does NOT survive: staff just changed the terms, so a
// later identical card tap must supersede this row, never reuse it as the
// card's unchanged offer.
function preserveClickMintMarkersAcrossRevise(nextData, priorData) {
  if (!nextData || typeof nextData !== 'object' || !priorData || typeof priorData !== 'object') return false;
  let changed = false;
  if (priorData.noEngagementAutomation === true && nextData.noEngagementAutomation !== true) {
    nextData.noEngagementAutomation = true;
    changed = true;
  }
  const mark = priorData.reportCtaMint;
  if (mark && typeof mark === 'object') {
    const { fingerprint: _droppedFingerprint, ...lineage } = mark;
    nextData.reportCtaMint = {
      ...lineage,
      ...(mark.fingerprint ? { fingerprintInvalidatedAt: new Date().toISOString() } : {}),
    };
    changed = true;
  }
  // The delivery witness survives a revise, prior-wins (uncapped audit on
  // 573ee332e P1): a revise replaces estimate_data wholesale, and dropping
  // deliveryState turned a genuinely DELIVERED click-mint back into
  // "unsent" for source-performance and both watcher predicates. A revise
  // never authors delivery state, so the prior row's is authoritative.
  // Scoped to click-mint rows (this function's contract) — other sources'
  // revise behavior is unchanged. MONOTONIC, not undefined-only (uncapped
  // audit on bf357980f): this helper runs once pre-lock and again against
  // the LOCKED re-read — if a real resend finished in between, the first
  // pass already planted the older deliveryState in the pending payload,
  // and an undefined-only guard would let the revision overwrite the
  // locked row's newer witness. Whichever side carries the newer delivery
  // evidence wins.
  if (mark && typeof mark === 'object'
    && priorData.deliveryState && typeof priorData.deliveryState === 'object') {
    const witnessTs = (ds) => {
      const value = ds?.lastDeliveredAt || ds?.firstDeliveredAt || null;
      const ts = value ? new Date(value).getTime() : NaN;
      return Number.isFinite(ts) ? ts : -Infinity;
    };
    const nextDs = nextData.deliveryState;
    if (nextDs === undefined || witnessTs(priorData.deliveryState) > witnessTs(nextDs)) {
      nextData.deliveryState = priorData.deliveryState;
      changed = true;
    }
  }
  return changed;
}
// Nested estimatorEngine keys preserved across a revise — the call
// provenance every linkage consumer resolves through, plus the
// invalidation markers a revise must never clear.
const REVISE_PRESERVED_ESTIMATOR_ENGINE_KEYS = [
  'callLogId',
  'callSid',
  'linkage_invalidated_at',
  'linkage_invalidated_from',
  'linkage_invalidated_to',
  'invalidation_pending_at',
  'invalidation_pending_from',
  'invalidation_pending_to',
  'invalidation_pending_conflict',
  // The forced reason and the observed generation ride the same marker —
  // a revise clearing either downgrades a deferred forced quarantine to a
  // plain linkage repoint (the r8c bug class) or strips the supersession
  // evidence the finalizer needs.
  'invalidation_pending_reason',
  'invalidation_pending_generation',
  'identity_conflict',
  // The clarify re-price guard (estimate-clarify-asks): a reply can stamp
  // it between this revision's pre-read and its row lock, and a wholesale
  // rewrite that dropped it would let the whole-building draft go out
  // unpriced. The LOCKED row's marker survives; the route lifts only the
  // attempt the revision observed BEFORE recomputation (pre-push codex P1
  // on #3796).
  'reprice_pending_at',
  'reprice_attempt',
];

// Revise an existing estimate in place: same body + pricing pipeline as
// create, but the row keeps its id, token, status, expiry, creator, and
// lead/customer linkage — so the link the customer already received simply
// starts showing the updated quote. A later send/resend re-stamps the send
// snapshot and expiry exactly like a first send.
async function reviseAdminEstimate({
  database = db,
  estimateId,
  body,
  technicianId,
  technician,
  now = () => new Date(),
  recompute, // injectable for tests; defaults to serverRecomputeFromEstimateData
  // Run every guard and the full pricing pipeline but skip the write — the
  // builder preflights an edit-mode save with this so the operator confirms a
  // server-repriced total BEFORE it publishes to the customer's live link.
  dryRun = false,
}) {
  const estimate = await database('estimates').where({ id: estimateId }).first();
  // The clarify re-price marker this revision OBSERVES before recomputing —
  // the only attempt its prices can claim to incorporate. It is removed
  // INSIDE the locked write below (never after commit: a detached re-draft
  // resuming in that gap could still match the token, lock the revised
  // row and archive the operator's correction — codex r3 P1 on #3796); a
  // DIFFERENT attempt the locked row carries was stamped after this
  // pre-read and survives the rewrite. null = none observed.
  let observedRepriceAttempt = null;
  try {
    const preData = typeof estimate?.estimate_data === 'string' ? JSON.parse(estimate.estimate_data) : (estimate?.estimate_data || {});
    const preEngine = preData?.estimatorEngine || {};
    if (preEngine.reprice_pending_at) observedRepriceAttempt = String(preEngine.reprice_attempt || '');
  } catch { observedRepriceAttempt = null; }
  if (!estimate) throw errorWithStatus('Estimate not found', 404);
  const observedVersion = estimateEditVersion(estimate);
  if (body.expectedEditVersion && body.expectedEditVersion !== observedVersion) {
    throw errorWithStatus('This estimate changed since you opened it. Your edits are still here; reopen the saved estimate in another tab to compare before retrying.', 409);
  }
  const block = estimateReviseBlock(estimate, undefined, now());
  if (block) throw errorWithStatus(block.message, block.statusCode);
  // A revise is a full quote rewrite — without a payload it would null the
  // stored blob (and silently orphan the linkage keys preserved below).
  if (!body?.estimateData || typeof body.estimateData !== 'object') {
    throw errorWithStatus('estimateData is required to revise an estimate.', 400);
  }
  // An in-place revision can never move the row to another account: the token
  // already in the customer's hands would become a bearer link into someone
  // else's quote and acceptance. A different explicit customerId (customer
  // lookup picking another match in the builder) is a new-estimate job.
  if (estimate.customer_id && body.customerId
      && String(body.customerId) !== String(estimate.customer_id)) {
    throw errorWithStatus(
      'This estimate is linked to a customer and an in-place edit cannot move it to a different customer. Create a new estimate for the other customer.',
      409,
    );
  }
  const existingData = parseStoredEstimateData(estimate.estimate_data) || {};

  // The satellite snapshot describes a PROPERTY, not the quote: it may only
  // survive the revise while the address still matches. An address edit made
  // without a fresh property lookup sends no replacement, and falling back to
  // the row would pin the previous property's image to the revised quote.
  const addressKey = (value) => String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  const sameAddress = addressKey(body.address) === addressKey(estimate.address);

  // The builder may reopen an estimate whose contact/customer linkage it did
  // not capture (auto-send or agent-drafted rows) — never let a blank field in
  // the edit payload sever the row's existing linkage or satellite snapshot.
  // Same unlinked-member guard as creation, against the EFFECTIVE linkage
  // (a linked row stays linked through a blank edit payload — see below).
  const memberLinkageWarning = await detectUnlinkedMemberAddress(database, {
    customerId: body.customerId || estimate.customer_id || null,
    address: body.address,
  });
  const pricingOut = {};
  // The ROW's proposal survives a generic revision (an enabled or scaffold
  // proposal is refused above by estimateReviseBlock; a disabled authored one
  // stays exactly as PUT /:id/proposal left it). The browser's copy is never
  // written — see stripClientProposal.
  let storedProposal = null;
  try {
    const parsedPrior = typeof estimate.estimate_data === 'string' ? JSON.parse(estimate.estimate_data) : estimate.estimate_data;
    storedProposal = parsedPrior?.proposal ?? null;
  } catch {
    storedProposal = null;
  }
  const writeFields = await resolveEstimateWritePayload({
    database,
    storedProposal,
    body: {
      ...body,
      customerId: body.customerId || estimate.customer_id || null,
      // The V2 revision payload sends no grouping fields — derive them from
      // the row so a revision of a grouped estimate keeps its per-property
      // tier scoping instead of repricing at the combined account tier
      // (codex #3244 r3).
      estimateGroupId: body.estimateGroupId ?? (estimate.estimate_group_id || undefined),
      satelliteUrl: body.satelliteUrl || (sameAddress ? estimate.satellite_url : null) || null,
    },
    technicianId,
    technician,
    now,
    recompute,
    pricingOut,
  });
  // Engine-authoritative pricing on a LIVE link (validation audit SEC-002,
  // pre-push codex P0): a delivered estimate's bearer link renders whatever
  // is stored, so a revision whose recompute fell back to the browser
  // preview is not persisted while GATE_SEND_REQUIRES_SERVER_PRICING is on
  // — nothing is saved (dryRun preflights surface the same refusal), the
  // operator fixes the inputs and retries. Drafts keep the fail-open save;
  // the send gate holds them.
  assertNoFallbackRevisionOfLiveLink(estimate, writeFields);

  // A revision that changes or introduces a group id — OR changes the
  // estimate's contact identity while grouped (codex #3244 r5: a lead-only
  // sibling has no customer_id, so an in-place contact edit could hand its
  // group slot to a different person) — must clear the same same-customer
  // bar as creation. The unchanged self-derived id with unchanged identity
  // passes trivially.
  const groupIdChanged = writeFields.estimate_group_id
    && String(writeFields.estimate_group_id) !== String(estimate.estimate_group_id || '');
  const groupIdentityChanged = writeFields.estimate_group_id && (
    String(writeFields.customer_id ?? '') !== String(estimate.customer_id ?? '')
    || String(writeFields.customer_phone ?? '') !== String(estimate.customer_phone ?? '')
    || String(writeFields.customer_email ?? '') !== String(estimate.customer_email ?? '')
  );
  const groupAddressChanged = writeFields.estimate_group_id
    && writeFields.address !== undefined
    && String(writeFields.address || '') !== String(estimate.address || '');
  if (groupIdChanged || groupIdentityChanged) {
    await assertGroupAssignmentAllowed(database, writeFields.estimate_group_id, writeFields, estimate.id);
  }
  // An address-only revision of a grouped sibling must not land on another
  // member's property (codex #3244 r8): the duplicate copy would keep its
  // multi-home discount while accept-time linkage dedupes to one property.
  // Serialized + tuple-compared inside the write transaction (codex #3248
  // r1): two operators revising different siblings to the same address must
  // not both pass a pre-transaction read, and same street in different
  // cities is NOT a duplicate. The flag rides to the transaction below.
  const groupDuplicateRecheckNeeded = !!groupAddressChanged;

  // Carry the linkage keys across the wholesale estimate_data rewrite.
  if (writeFields.estimate_data) {
    let nextData = null;
    try {
      nextData = JSON.parse(writeFields.estimate_data);
    } catch {
      nextData = null;
    }
    if (nextData && typeof nextData === 'object') {
      let preserved = false;
      for (const key of REVISE_PRESERVED_ESTIMATE_DATA_KEYS) {
        if (existingData[key] !== undefined && nextData[key] === undefined) {
          nextData[key] = existingData[key];
          preserved = true;
        }
      }
      if (preserveClickMintMarkersAcrossRevise(nextData, existingData)) preserved = true;
      // Durable CALL PROVENANCE survives a revise even though the rest of
      // the estimator metadata is deliberately replaced (codex P1, PR
      // #3304 GH r8): the V2 client sends a fresh blob carrying only
      // inputs/result/summary/engineRequest, and dropping
      // estimatorEngine.callLogId orphaned the row — existingDraftForCall
      // could no longer find it for a later reprocess, and send/accept
      // revalidation returned early with no call id, leaving the revised
      // draft and its public token on the former lead. The invalidation
      // markers ride along for the same reason: a revise must never
      // resurrect a row the reconcile killed.
      for (const key of REVISE_PRESERVED_ESTIMATOR_ENGINE_KEYS) {
        const priorValue = existingData?.estimatorEngine?.[key];
        if (priorValue === undefined) continue;
        const nextEngine = nextData.estimatorEngine && typeof nextData.estimatorEngine === 'object'
          ? nextData.estimatorEngine : {};
        // FORCED from the stored row, not merely filled when absent (codex
        // P1, PR #3304 GH r8c): these keys are immutable provenance and
        // invalidation verdicts, so a stale or malformed admin payload
        // carrying null — or a different call id — must not erase or
        // repoint them and orphan the draft from later call corrections.
        if (nextEngine[key] === priorValue) continue;
        nextEngine[key] = priorValue;
        nextData.estimatorEngine = nextEngine;
        preserved = true;
      }
      if (preserved) writeFields.estimate_data = JSON.stringify(nextData);
    }
  }

  // Lead-contact revalidation: the lead send/view/acceptance flows treat the
  // linkage (leads.estimate_id FK, or the estimate_data.lead_id mirror) as
  // authoritative and would advance/convert the ORIGINAL lead on the revised
  // estimate's events. If the revise moves the estimate to a different
  // contact, refuse — the operator should fix the lead or quote the other
  // customer on a new estimate. Same contact-match rule as lead attach
  // (normalized phone/email, so a pure reformat still passes). Gated on an
  // actual contact change so a service-only edit on a row whose linkage was
  // already imperfect never gets bricked by this check.
  const contactChanged =
    String(writeFields.customer_id ?? '') !== String(estimate.customer_id ?? '') ||
    String(writeFields.customer_phone ?? '') !== String(estimate.customer_phone ?? '') ||
    String(writeFields.customer_email ?? '') !== String(estimate.customer_email ?? '');
  if (contactChanged) {
    let linkedLead = await database('leads')
      .where({ estimate_id: estimate.id })
      .whereNull('deleted_at')
      .first();
    if (!linkedLead && existingData.lead_id) {
      linkedLead = await database('leads')
        .where({ id: existingData.lead_id })
        .whereNull('deleted_at')
        .first();
    }
    if (linkedLead && !leadMatchesEstimateContact(linkedLead, { ...estimate, ...writeFields })) {
      throw errorWithStatus(
        'This estimate is linked to a lead whose contact does not match the revised customer. Update the lead first, or create a new estimate for the other customer.',
        409,
      );
    }

    // Customer-linkage revalidation, same idea as the lead guard: public
    // acceptance converts/schedules/invoices against estimate.customer_id
    // (estimate-public accept flow), so a revise that moves the contact while
    // the preserve above keeps the link would show one contact's quote and
    // commit the accepted work to the previous customer's account. Match with
    // the same normalized phone/email rule the lead guard uses; a preserved
    // id pointing at a missing customer row fails the same way.
    if (writeFields.customer_id) {
      const linkedCustomer = await database('customers')
        .where({ id: writeFields.customer_id })
        .first();
      const revised = { ...estimate, ...writeFields };
      const customerPhone = normalizeContactPhone(linkedCustomer?.phone);
      const revisedPhone = normalizeContactPhone(revised.customer_phone);
      const customerEmail = normalizeContactEmail(linkedCustomer?.email);
      const revisedEmail = normalizeContactEmail(revised.customer_email);
      const matchesCustomer = !!linkedCustomer && (
        (customerPhone && revisedPhone && customerPhone === revisedPhone)
        || (customerEmail && revisedEmail && customerEmail === revisedEmail)
      );
      if (!matchesCustomer) {
        throw errorWithStatus(
          'This estimate is linked to a customer whose contact does not match the revised contact. Update the customer record first, or create a new estimate for the other customer.',
          409,
        );
      }
    }

    // Token-only rows (no lead, no ORIGINAL customer link — attaching one in
    // this same revise doesn't count, that's how an audience swap would dress
    // itself up) have nothing to revalidate against, but the same-audience
    // rule still holds: once the quote is delivered, the token in the
    // recipient's hands is a bearer link, and a contact move would point it
    // at another person's quote. Normalized compare so a pure reformat of
    // the same phone/email still saves.
    const delivered = !!(estimate.sent_at || estimate.viewed_at);
    if (delivered && !linkedLead && !estimate.customer_id) {
      const phoneMoved = normalizeContactPhone(writeFields.customer_phone)
        !== normalizeContactPhone(estimate.customer_phone);
      const emailMoved = normalizeContactEmail(writeFields.customer_email)
        !== normalizeContactEmail(estimate.customer_email);
      if (phoneMoved || emailMoved) {
        throw errorWithStatus(
          'This estimate was already sent and has no linked customer or lead to validate a contact change against. Create a new estimate for the other contact.',
          409,
        );
      }
    }
  }

  // Preflight stops here: same guards, same pricing pipeline, no write — the
  // returned totals let the builder confirm a server reprice with the
  // operator before anything reaches the customer's live link. The grouped
  // duplicate-address guard runs here too (codex #3248 r2): without it the
  // preflight reports success and walks the operator through a reprice
  // confirm, only for the identical real save to 400. Best-effort unlocked
  // read — the serialized in-transaction recheck below stays authoritative.
  if (dryRun) {
    // Scheduled-group guard at preflight too (GH codex P2 r7): an unlocked
    // best-effort read, so the builder never walks the operator through a
    // reprice confirm the identical real save would refuse; the locked
    // recheck inside the write transaction stays authoritative.
    await assertNoFallbackRevisionInScheduledGroup(database, estimate, writeFields);
    await assertLiveRowMayJoinGroup(database, estimate, writeFields);
    if (groupDuplicateRecheckNeeded) {
      const { normalizedEstimatePropertyKey, samePropertyKey } = require('./estimate-property-linkage');
      const revisedKey = normalizedEstimatePropertyKey(writeFields.address);
      if (revisedKey?.street) {
        const members = await database('estimates')
          .where({ estimate_group_id: writeFields.estimate_group_id })
          .whereNot({ id: estimate.id })
          .whereNull('archived_at')
          .select('address');
        for (const member of members) {
          if (samePropertyKey(normalizedEstimatePropertyKey(member.address), revisedKey)) {
            throw errorWithStatus('This address is already in the group — each property is quoted once', 400);
          }
        }
      }
    }
    return { estimate: { ...estimate, ...writeFields }, dryRun: true, memberLinkageWarning, pricingFallbackReason: pricingOut.fallbackReason || null };
  }

  // Atomic revise guard: the editability check above ran on a pre-read, so
  // scope the UPDATE to the same editable conditions — a customer accept or
  // an in-flight send landing between SELECT and UPDATE must win, not be
  // silently overwritten. The category predicate closes the proposal race:
  // PUT /:id/proposal is the only writer that turns a row into a commercial
  // proposal and it always stamps category='COMMERCIAL' in the same UPDATE,
  // so a conversion landing after our pre-read can't be clobbered either.
  // Replacing estimate_data wholesale also drops the prior send's pricing
  // snapshot and any customer-picked preferences, which is intended: they
  // described the PREVIOUS quote (the public view falls back to live pricing
  // until the next send re-stamps a snapshot).
  const updated = await database.transaction(async (trx) => {
    if (groupDuplicateRecheckNeeded) {
      const { normalizedEstimatePropertyKey, samePropertyKey } = require('./estimate-property-linkage');
      await trx.raw(
        'SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))',
        ['estimate-group-revise', String(writeFields.estimate_group_id)],
      );
      const revisedKey = normalizedEstimatePropertyKey(writeFields.address);
      if (revisedKey?.street) {
        const members = await trx('estimates')
          .where({ estimate_group_id: writeFields.estimate_group_id })
          .whereNot({ id: estimate.id })
          .whereNull('archived_at')
          .select('address');
        for (const member of members) {
          if (samePropertyKey(normalizedEstimatePropertyKey(member.address), revisedKey)) {
            throw errorWithStatus('This address is already in the group — each property is quoted once', 400);
          }
        }
      }
    }
    // Re-read the row under its lock before rewriting: the pre-read
    // `estimate` above goes stale during payload resolution, and an Agent
    // Estimate recomposition landing in that gap replaces the composition
    // and resets its baseline. The baseline must snapshot the composition
    // this UPDATE actually replaces, so the locked row — not the pre-read —
    // feeds the capture below.
    // Group advisory lock(s) BEFORE the row lock — see
    // lockScheduledGroupGuardGroups for the deadlock this order prevents.
    const lockedGuardGroups = await lockScheduledGroupGuardGroups(trx, estimate, writeFields);
    const lockedPrior = await trx('estimates')
      .where({ id: estimate.id })
      .forUpdate()
      .first();
    if (!lockedPrior) return null;
    // The revise block re-run on the LOCKED row (pre-push codex P0 r14): a
    // proposal authored by PUT /:id/proposal while this payload resolved
    // turns the row into a commercial proposal the generic save must not
    // rewrite — the throw rolls back with nothing written.
    const lockedBlock = estimateReviseBlock(lockedPrior, undefined, now());
    if (lockedBlock) throw errorWithStatus(lockedBlock.message, lockedBlock.statusCode);
    if (body.expectedEditVersion && estimateEditVersion(lockedPrior) !== observedVersion) {
      throw errorWithStatus('This estimate changed while saving. Nothing was overwritten. Reopen the saved estimate to compare your changes.', 409);
    }
    // Live-link guard re-asserted on the LOCKED row (pre-push codex P0): a
    // first send finishing between the pre-read and this lock turns the
    // row live, and the fallback revision must lose to it — the throw rolls
    // this transaction back with nothing written.
    assertNoFallbackRevisionOfLiveLink(lockedPrior, writeFields);
    // The locked row's group must be one we already hold the lock for — a
    // concurrent group change between the pre-read and the row lock would
    // otherwise need an out-of-order lock; refuse and let the operator retry.
    if (revisionGroupLockIds(lockedPrior, writeFields).some((groupId) => !lockedGuardGroups.includes(groupId))) {
      throw errorWithStatus('Estimate group changed; refresh and try again.', 409);
    }
    await assertNoFallbackRevisionInScheduledGroup(trx, lockedPrior, writeFields);
    await assertLiveRowMayJoinGroup(trx, lockedPrior, writeFields);
    // Protocol keys re-applied from the LOCKED row (codex P0, PR #3304 GH
    // r8c): writeFields.estimate_data was built from the pre-read
    // snapshot, so a delivery claim or an invalidation marker recorded
    // during payload resolution would be overwritten by this whole-blob
    // write — after which clearEstimateDeliveryClaim finds no matching
    // token and the wrong-lead content stays public. The UPDATE also
    // refuses outright when either is present (predicates below); this
    // rebuild is the belt to that suspenders, and is what guarantees
    // callLogId survives a payload that never carried it.
    const revisedFields = { ...writeFields };
    if (typeof revisedFields.estimate_data === 'string') {
      // Only the PARSE is guarded (unparseable on either side: fall through
      // to the predicates). The hold check below is a DB read and runs
      // OUTSIDE the catch — a swallowed failure there would continue with
      // the pre-lock blob, dropping a hold stamped between the pre-read and
      // the row lock (pre-push codex P0 on #3804 r4).
      let lockedData = null;
      let pendingData = null;
      try {
        lockedData = typeof lockedPrior.estimate_data === 'string'
          ? JSON.parse(lockedPrior.estimate_data) : (lockedPrior.estimate_data || {});
        pendingData = JSON.parse(revisedFields.estimate_data);
      } catch { lockedData = null; pendingData = null; }
      {
        if (pendingData && typeof pendingData === 'object' && lockedData && typeof lockedData === 'object') {
          for (const key of REVISE_PRESERVED_ESTIMATE_DATA_KEYS) {
            if (lockedData[key] !== undefined) pendingData[key] = lockedData[key];
          }
          preserveClickMintMarkersAcrossRevise(pendingData, lockedData);
          // The server-owned proposal is carried from the LOCKED row, never
          // from the pre-read copy stripClientProposal restored earlier
          // (pre-push codex P0 r14): a proposal authored (or disabled) in
          // the gap would otherwise be replaced by the stale/absent one.
          if (lockedData.proposal && typeof lockedData.proposal === 'object' && !Array.isArray(lockedData.proposal)) {
            pendingData.proposal = lockedData.proposal;
          } else {
            delete pendingData.proposal;
          }
          for (const key of REVISE_PRESERVED_ESTIMATOR_ENGINE_KEYS) {
            const lockedValue = lockedData?.estimatorEngine?.[key];
            if (lockedValue === undefined) continue;
            pendingData.estimatorEngine = {
              ...(pendingData.estimatorEngine && typeof pendingData.estimatorEngine === 'object'
                ? pendingData.estimatorEngine : {}),
              [key]: lockedValue,
            };
          }
          // The observed re-price marker is lifted HERE, atomically with the
          // revision that incorporates it (see observedRepriceAttempt).
          const lockedEngine = pendingData.estimatorEngine && typeof pendingData.estimatorEngine === 'object' ? pendingData.estimatorEngine : null;
          if (lockedEngine && observedRepriceAttempt !== null && lockedEngine.reprice_pending_at
            && String(lockedEngine.reprice_attempt || '') === observedRepriceAttempt) {
            // A UNIT hold is lifted only once the revised address carries the
            // answered unit — a pricing-only edit keeps the whole-building
            // quote held (codex r1 P1 on #3804).
            const { unitHoldSatisfied } = require('../utils/estimate-claim-sql');
            const revisedAddress = revisedFields.address !== undefined ? revisedFields.address : lockedPrior.address;
            if (await unitHoldSatisfied(trx, lockedEngine.callLogId || null, revisedAddress)) {
              delete lockedEngine.reprice_pending_at;
              delete lockedEngine.reprice_attempt;
            }
          }
          revisedFields.estimate_data = JSON.stringify(pendingData);
        }
      }
    }
    const [row] = await trx('estimates')
      .where({ id: estimate.id })
      .whereNull('price_locked_at')
      .whereNull('archived_at')
      // A revise NEVER lands on an invalidated row or inside a live
      // delivery claim (codex P0, PR #3304 GH r8c) — 0 rows becomes the
      // caller's 409 "refresh and retry".
      .whereRaw("COALESCE(estimate_data->'estimatorEngine'->>'linkage_invalidated_at', '') = ''")
      .whereRaw("COALESCE(estimate_data->'estimatorEngine'->>'invalidation_pending_at', '') = ''")
      .whereRaw(DELIVERY_CLAIM_NOT_LIVE_SQL)
      // The expired-row recovery (expiredRowRecoverableUnderGate) relaxes
      // the two expiry predicates for the LOCKED row's verdict only.
      .whereNotIn('status', expiredRowRecoverableUnderGate(lockedPrior)
        ? REVISE_BLOCKED_STATUSES.filter((s) => s !== 'expired')
        : REVISE_BLOCKED_STATUSES)
      .whereRaw("COALESCE(category, '') <> 'COMMERCIAL'")
      // Mirrors the pre-read's date-expiry verdict: the payload resolution
      // above (pricing recompute, DB lookups) leaves a window in which the
      // row can pass its expires_at, and a commit after that would report
      // saved while the public link already serves the expired page.
      .modify((qb) => {
        if (!expiredRowRecoverableUnderGate(lockedPrior)) qb.where((q) => q.whereNull('expires_at').orWhere('expires_at', '>', now()));
      })
      .update({
        ...revisedFields,
        updated_at: now(),
      })
      .returning('*');
    if (!row) return null;
    // Learning-loop capture rides the same transaction as the rewrite: the
    // locked pre-edit row is the AI composition this wholesale rewrite
    // replaces, and committing the new composition before its baseline
    // exists would let a concurrent send read the draft as "unedited" (see
    // estimate-learning.js for the concurrency contract).
    await recordPreSendRevision({ priorEstimate: lockedPrior, trx });
    return row;
  });
  if (!updated) {
    throw errorWithStatus('Estimate was accepted, locked, converted, or expired while you were editing. Refresh and retry.', 409);
  }
  clearEstimatePricingCache(estimate.id);
  // The revised address can change the estimate's service zone, and the
  // slot wrapper cache (5-min TTL) was keyed for the OLD address — left in
  // place it keeps serving (and letting the customer redeem) offers built
  // without the new zone's funnel/collision context (codex #3473 r2 P2).
  // Best-effort, same as reserveSlot's invalidation; lazy require keeps
  // this module free of a slot-availability import at load time.
  try {
    require('./estimate-slot-availability').invalidateEstimate(estimate.id);
  } catch { /* best-effort */ }
  return { estimate: updated, memberLinkageWarning, pricingFallbackReason: pricingOut.fallbackReason || null, observedRepriceAttempt };
}

module.exports = {
  estimateEditVersion,
  detectUnlinkedMemberAddress,
  assertLivePestBaseForClientPayload,
  assertLiveTermiteBondRates,
  assertNoDarkTermiteBondPayload,
  assertNoDarkTermiteRentalPayload,
  assertLiveTermiteRentalRates,
  buildEstimatePersistenceFields,
  createOrReuseAdminEstimate,
  ensureEstimateGroupId,
  resolveEstimatePropertyLinkage,
  estimateExpiresAt,
  ESTIMATE_SEND_EXPIRY_DAYS,
  REVISE_PRESERVED_ESTIMATOR_ENGINE_KEYS,
  ESTIMATE_DELIVERY_CLAIM_TTL_MS,
  DELIVERY_CLAIM_NOT_LIVE_SQL,
  deliveryClaimFresh,
  staleCallLinkageReason,
  callRejectedForDrafting,
  callReprocessInFlight,
  callSideBlockForEstimateData,
  completePendingInvalidation,
  takePendingInvalidation,
  sweepWedgedPendingInvalidations,
  estimateViewUrl,
  estimateReviseBlock,
  normalizeClientPestFloorMetadata,
  reviseAdminEstimate,
  serverRecomputeFromEstimateData,
  resolveServerAuthoritativePricing,
  compareClientToServer,
  sanitizeClientIdentityFields,
  // Exported for the monotonic delivery-witness contract test (#3391): the
  // helper runs once pre-lock and again against the locked re-read, and
  // the newer witness must always win.
  preserveClickMintMarkersAcrossRevise,
};
module.exports.stripClientProposal = stripClientProposal;
module.exports.assertNoFallbackRevisionInScheduledGroup = assertNoFallbackRevisionInScheduledGroup;
module.exports.lockScheduledGroupGuardGroups = lockScheduledGroupGuardGroups;
module.exports.scheduledGroupGuardGroupIds = scheduledGroupGuardGroupIds;
module.exports.assertNoRevisionDuringGroupSend = assertNoRevisionDuringGroupSend;
module.exports.fallbackRevisionGroupIds = fallbackRevisionGroupIds;
module.exports.linkedDraftCarriesProposal = linkedDraftCarriesProposal;
module.exports.writeStampsUnverifiedPricing = writeStampsUnverifiedPricing;
module.exports.assertNoFallbackRevisionOfLiveLink = assertNoFallbackRevisionOfLiveLink;
module.exports.assertLiveRowMayJoinGroup = assertLiveRowMayJoinGroup;
module.exports.liveGroupMoveDestinationIds = liveGroupMoveDestinationIds;
module.exports.revisionGroupLockIds = revisionGroupLockIds;
module.exports.expiredRowRecoverableUnderGate = expiredRowRecoverableUnderGate;
