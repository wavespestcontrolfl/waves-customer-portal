/**
 * Call -> PPC attribution. Records an inbound PAID phone-call lead in the PPC
 * funnel table (ad_service_attribution) so phone leads show up in the Google Ads
 * ROI views (revenue-attribution / funnel) alongside web leads — instead of
 * being invisible to PPC reporting.
 *
 * Calls carry no gclid, so campaign attribution comes from Google's own call
 * reporting (the call-reporting bridge passes the campaign id it matched). When
 * no campaign is known yet (e.g. a dedicated Google Ads tracking number before
 * per-campaign numbers exist) the row is still tagged lead_source='google_ads'
 * with a null campaign_id — the "single GA number now, per-campaign-ready" shape.
 *
 * Feeding the call lead BACK to Google Ads (Enhanced Conversions for Leads via
 * hashed phone) is handled separately by offline-conversions.js when the lead is
 * marked qualified — this module only makes the lead visible in OUR funnel.
 */
const db = require('../../models/db');
const logger = require('../logger');
const { etDateString } = require('../../utils/datetime-et');
// Shared with the web lead path so call + web leads bucket identically.
const { inferServiceLine, inferSpecificService, inferServiceBucket } = require('../../utils/service-line-infer');

// Map a lead_sources.source_type to the ad_service_attribution channel key +
// paid flag, so inbound CALLS bucket into the SAME channels as web-form leads
// (which write these keys directly). Without this, an organic call — e.g. someone
// calling the tracking number on a spoke site — creates a lead but never a funnel
// row, so whole organic channels (spoke domains, the hub city pages, GBP) are
// invisible to the LTV:CAC / "where to put ad dollars" surfaces even though they drive real
// business. Paid tracking numbers stay paid; organic marketing sources are unpaid
// but still real acquisition channels the card should show.
//
// IMPORTANT — main_site is the website city-page numbers (migration 20260628000001).
// It's mapped here (waves_website), BUT one of those numbers is the Google Ads
// call-bridge target and is SHARED with paid Google call-extension traffic. The
// CALLER must skip that one number (google-call-bridge.isBridgeTargetNumber) —
// pre-attributing it organic would lock the funnel row (recordCallPpcAttribution
// won't change an existing row's lead_source) so the bridge could never mark the
// call paid. The other (non-bridge) city-page numbers attribute organic normally.
//
// Word-of-mouth / offline sources (referral, walk_in, vehicle, tollfree, direct
// field-observation) and marketplaces (Yelp/Nextdoor share source_type=marketplace
// with different channels) are intentionally NOT mapped — they aren't ad-dollar
// channels and their canonical keys need an owner decision. null ⇒ no funnel row.
const SOURCE_TYPE_ATTRIBUTION = {
  google_ads:      { leadSource: 'google_ads',      isPaid: true },
  facebook:        { leadSource: 'facebook',        isPaid: true },
  spoke_site:      { leadSource: 'domain_website',  isPaid: false },
  main_site:       { leadSource: 'waves_website',   isPaid: false },
  gbp:             { leadSource: 'google_business', isPaid: false },
  website_organic: { leadSource: 'google_business', isPaid: false },
  // Van wrap — offline advertising on a dedicated tracking number. Not click-paid
  // (is_paid=false, so it stays out of the paid ad-platform ratio), but it IS a
  // real cost: the card divides its lifetime value by the wrap's amortized cost
  // (a channel_fixed_costs row for 'van_wrap') to give it an honest LTV:CAC.
  vehicle:         { leadSource: 'van_wrap',        isPaid: false },
  // Customer referral / word-of-mouth. Not click-paid (is_paid=false); its cost is
  // the per-conversion reward ($25 referrer + $25 referee), applied to the channel
  // in fetchChannelAttribution (admin-ads.js) — so a referred lead that calls in
  // lands on the card as its own high-LTV, low-CAC channel instead of vanishing.
  referral:        { leadSource: 'referral',        isPaid: false },
};

/**
 * attributionForSourceType(sourceType)
 * @returns {{leadSource:string, isPaid:boolean}|null} the funnel channel + paid
 *   flag for a lead_sources.source_type, or null when the source shouldn't get a
 *   PPC-funnel row (offline / word-of-mouth / undecided).
 */
function attributionForSourceType(sourceType) {
  return SOURCE_TYPE_ATTRIBUTION[sourceType] || null;
}

async function resolveCampaignId(googleCampaignId) {
  if (!googleCampaignId) return null;
  try {
    const row = await db('ad_campaigns')
      .where({ platform: 'google_ads', platform_campaign_id: String(googleCampaignId) })
      .first();
    return row?.id || null;
  } catch (err) {
    logger.warn(`[call-attribution] campaign lookup failed: ${err.message}`);
    return null;
  }
}

/**
 * Record an inbound paid call lead in the PPC funnel (one row per lead).
 *   - leadId: REQUIRED — a funnel row represents an actual lead, so an
 *     existing-customer call that matched no lead is never counted. Dedupe is by
 *     lead_id, so two distinct leads for one customer on the same day (e.g. a web
 *     form AND a phone call) get distinct rows, while the bridge re-run /
 *     dedicated-number paths stay idempotent on the same call.
 *   - leadDate: the ACTUAL call date (Date or string). The bridge can apply
 *     matches for calls up to ~90 days old, so date the row by the call, not by
 *     the day the bridge/cron runs (keeps /admin/ads period filters correct).
 *   - serviceInterest: the extracted service, passed directly when the lead row
 *     doesn't carry service_interest yet (new call leads get it after a later
 *     enrichment write). service_line/specific_service/service_bucket are filled
 *     via the SHARED inferers so call leads bucket exactly like web leads.
 *   - An existing row is backfilled (campaign / detail / service fields) when a
 *     later path brings richer data, instead of being skipped.
 * @returns {{recorded:boolean, reason?:string, updated?:boolean, campaignId?:string|null}}
 */
async function recordCallPpcAttribution({
  customerId,
  leadId = null,
  leadSource = 'google_ads',
  leadSourceDetail = null,
  googleCampaignId = null,
  leadDate,
  serviceInterest = null,
  isPaid = true,
  // Which call_log row this attribution derives from — the bridge's
  // repoint reconciliation identifies THE EXACT row a call created by it
  // (codex P1, PR #3303). Written on INSERT only: an existing row with
  // NULL provenance may have been created by a DIFFERENT call reusing the
  // same lead, and claiming it would let a later repoint transfer or
  // delete another call's first-touch row (codex P1 r2) — legacy NULL
  // rows stay untouched and are never reconciled.
  sourceCallId = null,
  // Transaction handle for the ad_service_attribution statements. The
  // google-call bridge attributes while holding a FOR UPDATE lock on the
  // lead; this table's lead_id foreign-key check takes FOR KEY SHARE on
  // that same lead row, so running the insert on the global connection
  // self-deadlocks behind the caller's own lock (pre-push P1, PR
  // stamp-consumers-ops). Reads (leads / ad_campaigns) stay on the global
  // connection — plain SELECTs take no row locks.
  dbc = db,
} = {}) {
  if (!customerId) return { recorded: false, reason: 'no_customer' };
  if (!leadId) return { recorded: false, reason: 'no_lead' };
  const day = leadDate
    ? etDateString(leadDate instanceof Date ? leadDate : new Date(leadDate))
    : etDateString();
  try {
    const campaignId = await resolveCampaignId(googleCampaignId);

    // Resolve the service text (explicit > the lead's stored value), then derive
    // line/specific/bucket with the shared inferers (always concrete — matches
    // the web path so service-line ROI groups call leads the same way).
    let interest = serviceInterest;
    if (!interest) {
      const lead = await db('leads').where({ id: leadId }).select('service_interest').first().catch(() => null);
      interest = lead?.service_interest || null;
    }
    // Composed multi-service labels ("A + B") carry the PRIMARY first — the
    // funnel's single service line/bucket must come from it, not whichever
    // family inferServiceLine's keyword order hits first (lawn-before-pest
    // would bucket a pest-primary composite as lawn). Applies to EVERY
    // caller: immediate call path, attached-lead backfill, and the
    // bridge-unclaimed sweep all read the lead's stored composite here.
    // primaryServiceInterest strips only KNOWN composed tails, so plus-named
    // catalog primaries ("Lawn + Tree & Shrub") survive intact (codex r14).
    const { primaryServiceInterest } = require('../../utils/lead-service-interest');
    const primaryInterest = interest ? primaryServiceInterest(interest) : interest;
    const serviceLine = inferServiceLine(primaryInterest);
    const specificService = inferSpecificService(primaryInterest);
    const serviceBucket = inferServiceBucket(primaryInterest);

    // Provenance recovery BEFORE the lead-scoped lookup (pre-push P1 r13):
    // an interrupted repoint can leave this call's history-bearing row on a
    // DIFFERENT lead with the old stamp already cleared — a fresh insert
    // here would double-count the call. Recover the row by source_call_id
    // and move it to this lead first; a transfer then feeds the existing-
    // row backfill below, and a target-slot conflict retires the orphan
    // while the other_call guard protects the target's own row.
    if (sourceCallId) {
      const provenanced = await dbc('ad_service_attribution')
        .where({ source_call_id: sourceCallId })
        .first('id', 'lead_id');
      if (provenanced && String(provenanced.lead_id) !== String(leadId)) {
        const moved = await reconcileMovedCallAttributionRow(dbc, sourceCallId, provenanced.lead_id, leadId, new Date(), { toCustomerId: customerId });
        // A conflict means the target lead owns a row this call cannot
        // prove is its own — a LEGACY row (NULL source_call_id) would slip
        // past the other_call guard below and get patched with this call's
        // campaign/service data (pre-push P1 r14). Return immediately,
        // exactly like the bridge's conflict handling: unknown-provenance
        // rows stay conservative.
        if (moved === 'retired_conflict') {
          return { recorded: false, reason: 'other_call' };
        }
      }
    }
    // One funnel row per lead — dedupe by lead_id. Backfill richer data onto an
    // existing row (e.g. the bridge later supplies the campaign).
    const existing = await dbc('ad_service_attribution').where({ lead_id: leadId }).first();
    if (existing) {
      // The lead already has a funnel row. If it belongs to a DIFFERENT source
      // (e.g. it was first a WEB-form lead and the customer later called the paid
      // number), don't create a duplicate and don't override its source — the
      // lead keeps its original attribution and is counted once.
      if (existing.lead_source && existing.lead_source !== leadSource) {
        return { recorded: false, reason: 'other_source' };
      }
      // A row PROVENANCED to a DIFFERENT call is that call's evidence
      // (pre-push P1 r10): after a repoint's retired_conflict — the target
      // lead already owned another call's row — this call's later
      // attribution pass must not overwrite that row's campaign/detail/
      // service placeholders. One refusal here closes every caller
      // (processor re-attribution, settleClear transfers, the bridge).
      // Callers WITHOUT call identity (claim-time backfill, the unclaimed
      // sweep) are lead-centric repairs and still patch.
      if (sourceCallId && existing.source_call_id
        && String(existing.source_call_id) !== String(sourceCallId)) {
        return { recorded: false, reason: 'other_call' };
      }
      // A NULL-provenance row is frozen to provenanced callers too (codex
      // P1, PR #3303 r4): after a transfer's retired_conflict against a
      // legacy row, the moving call's later attribution pass would
      // otherwise backfill that unprovenanced row with its campaign and
      // service data — ownership it cannot prove. Legacy rows stay
      // permanently conservative; lead-centric repairs (no call identity)
      // still patch.
      if (sourceCallId && !existing.source_call_id) {
        return { recorded: false, reason: 'unprovenanced_row' };
      }
      // A web-attributed row owns this lead's first-touch PPC attribution — via a
      // click id (Google: gclid/wbraid/gbraid, Meta: fbclid/_fbc) OR, for
      // consent/ad-blocker cases with no click id, via UTM (utm_campaign/utm_term).
      // A later phone call to the same lead must NOT overwrite that. Call rows never
      // carry click ids/cookies or UTMs, so this only excludes genuine web rows.
      if (existing.gclid || existing.wbraid || existing.gbraid
        || existing.fbclid || existing.fbc
        || existing.utm_campaign || existing.utm_term) {
        return { recorded: false, reason: 'web_attributed' };
      }
      // Upgrade placeholders, not just nulls — the first path (dedicated number)
      // inserts a row with a generic detail ("inbound call") + default service
      // bucket, and a later bridge run brings the REAL campaign + a now-known
      // service. Only-fill-null guards would leave those placeholders forever.
      const hasInterest = !!(interest && String(interest).trim());
      const patch = {};
      if (campaignId && !existing.campaign_id) {
        // Bridge brought the real campaign — set it AND replace the generic
        // placeholder detail with the campaign name. (Don't overwrite an
        // already-set campaign: first-touch attribution wins.)
        patch.campaign_id = campaignId;
        if (leadSourceDetail) patch.lead_source_detail = leadSourceDetail;
      } else if (leadSourceDetail && !existing.lead_source_detail) {
        patch.lead_source_detail = leadSourceDetail;
      }
      // A service derived from a KNOWN interest replaces a default-placeholder
      // bucket; an unknown/default inference only fills genuinely-missing fields.
      const applyService = (col, val) => {
        if (!val) return;
        if (hasInterest ? val !== existing[col] : !existing[col]) patch[col] = val;
      };
      applyService('service_line', serviceLine);
      applyService('specific_service', specificService);
      applyService('service_bucket', serviceBucket);
      // Ownership REPAIR, fill-only (pre-push P1 r9): a row transferred to
      // an unclaimed lead carries customer_id NULL, and the claim-time
      // backfill lands here with the newly established owner — without
      // this, customer-scoped attribution queries missed the row
      // permanently. An already-owned row is never repointed.
      if (customerId && !existing.customer_id) patch.customer_id = customerId;
      if (Object.keys(patch).length) {
        patch.updated_at = new Date();
        await dbc('ad_service_attribution').where({ id: existing.id }).update(patch);
        return { recorded: true, updated: true, campaignId: campaignId || existing.campaign_id || null };
      }
      return { recorded: false, reason: 'already_recorded' };
    }

    // ON CONFLICT (lead_id) DO NOTHING — two overlapping bridge-apply runs could
    // both miss the lookup above; the unique index + ignore prevents a duplicate
    // row (the loser is a no-op; a later run backfills any missing campaign).
    await dbc('ad_service_attribution').insert({
      campaign_id: campaignId,
      customer_id: customerId,
      lead_id: leadId,
      service_line: serviceLine,
      specific_service: specificService,
      service_bucket: serviceBucket,
      lead_date: day,
      lead_source: leadSource,
      lead_source_detail: leadSourceDetail,
      source_call_id: sourceCallId,
      funnel_stage: 'lead',
      // Calls carry no click ids (gclid/fbclid), so this flag — not a cookie — is
      // how the paid filters count them: a paid-number call (google_ads/facebook)
      // is is_paid=true so a Facebook call isn't mis-bucketed as organic, while an
      // organic-marketing call (spoke domain / hub / GBP) is is_paid=false so it
      // stays out of the paid ratio. Defaults true for the paid callers.
      is_paid: isPaid,
    }).onConflict('lead_id').ignore();
    logger.info(`[call-attribution] recorded ${leadSource} call lead ${leadId}${campaignId ? ` (campaign ${campaignId})` : ''}`);
    return { recorded: true, campaignId };
  } catch (err) {
    logger.error(`[call-attribution] record failed: ${err.message}`);
    return { recorded: false, reason: 'error', error: err.message };
  }
}

/**
 * Backfill the CALL-source funnel row for a call-pipeline lead at the moment
 * it gains a customer — the voicemail text-back attach paths (/calculate and
 * the lead-webhook). The call processor's own attribution is gated on
 * leadId && customerId, so a customer-less voicemail recovery lead has no
 * ad_service_attribution row at call time; the attach paths suppress their
 * web-channel row so the CALL source keeps the unique lead_id slot — without
 * this backfill an attached paid/GBP voicemail lead would end up with NO
 * funnel row at all. Resolves the channel from the lead's preserved
 * lead_source_id (the tracking number dialed), honors the shared
 * bridge-target suppression, and delegates to recordCallPpcAttribution
 * (lead_id dedupe + first-touch, so a pre-existing web row is never
 * overwritten and re-runs are idempotent).
 */
// Shared source-call provenance resolution — sid arm first (unambiguous +
// settled-attributable), then the SINGLE settled stamped call, with the
// chosen candidate locked FOR UPDATE and its verdict re-checked under that
// lock. The caller MUST already hold the lead row lock (global leads →
// call_log acquisition order). Returns { sourceCallId } — null when
// linkage is ambiguous, permanently conservative — or { refusedReason }
// when the candidate's locked verdict forbids attribution this pass.
async function resolveSourceCallProvenanceLocked(trx, { leadId, twilioCallSid }) {
  let candidateId = null;
  let candidateArm = null;
  let sidAmbiguous = false;
  if (twilioCallSid) {
    const sidRows = await trx('call_log')
      .where('twilio_call_sid', twilioCallSid)
      .orderBy('created_at', 'desc')
      .limit(2)
      .select('id');
    if (sidRows.length === 1) {
      candidateId = sidRows[0].id;
      candidateArm = 'sid';
    }
    // >1 rows: ambiguous — provenance stays NULL, and the stamp fallback
    // is skipped too (codex P1, PR #3303 r5): attaching a stamped call's
    // id despite ambiguous sid ownership lets a later rejection/repoint
    // retire or move another call's funnel history.
    if (sidRows.length > 1) sidAmbiguous = true;
  }
  if (!candidateId && !sidAmbiguous) {
    // Up to TWO settled stamped calls (codex P1, PR #3303 r5): multiple
    // successor stamps on one reused lead are supported, and newest-wins
    // would hand this funnel row to an arbitrary call. Exactly one
    // candidate or provenance stays NULL.
    const stampRows = await trx('call_log')
      .whereRaw("metadata->>'lead_id' = ?", [String(leadId)])
      .whereNull('processing_token')
      .where('processing_status', 'processed')
      .orderBy('created_at', 'desc')
      .limit(2)
      .select('id');
    if (stampRows.length === 1) {
      candidateId = stampRows[0].id;
      candidateArm = 'stamp';
    }
  }
  if (!candidateId) return { sourceCallId: null };
  const locked = await trx('call_log')
    .where({ id: candidateId })
    .forUpdate()
    .first('id', 'processing_token', 'processing_status', 'metadata');
  const status = String(locked?.processing_status || '').toLowerCase();
  const marker = (() => {
    try {
      const md = typeof locked?.metadata === 'string' ? JSON.parse(locked.metadata) : (locked?.metadata || {});
      return md?.no_attribution === true;
    } catch { return false; }
  })();
  const attributable = !!locked
    && locked.processing_token == null
    && (status === 'processed' || status === '')
    && !marker;
  if (!attributable) {
    // Sid arm: the ORIGINATING call is rejected/unsettled — the retired
    // funnel row must not resurrect. Stamp arm: the settled read raced a
    // reprocess whose verdict is unknown — refuse this pass rather than
    // mint a NULL-provenance row nothing could retire.
    return { refusedReason: candidateArm === 'sid' ? 'call_rejected' : 'call_unsettled' };
  }
  if (candidateArm === 'stamp') {
    // Re-verify the STAMP under the lock (codex P1, PR #3303 r8): the
    // unlocked scan found this call stamped to our lead, but a concurrent
    // force-reprocess can repoint metadata.lead_id to a DIFFERENT lead
    // before we acquire the row lock — and the repointed call is still
    // settled and attributable, so the status checks above pass. Claiming
    // its id as our provenance would let recordCallPpcAttribution recover
    // and transfer the other lead's history-bearing row to us.
    const lockedStamp = (() => {
      try {
        const md = typeof locked.metadata === 'string' ? JSON.parse(locked.metadata) : (locked.metadata || {});
        return md?.lead_id ? String(md.lead_id) : null;
      } catch { return null; }
    })();
    if (lockedStamp !== String(leadId)) return { refusedReason: 'call_repointed' };
  }
  if (candidateArm === 'sid') {
    // A SETTLED stamp on the sid candidate pointing at a DIFFERENT lead
    // is the processor's current verdict (GH P1 r6, same authority rule
    // as the bridge dedupe): a force-reprocess repointed this call away
    // from its sid lead, so the OLD lead's claim to this call — and to a
    // funnel row derived from it — is gone. Attaching the call id here
    // would let provenance recovery transfer the history-bearing row
    // back to the obsolete lead, undoing the reconciliation.
    const lockedStamp = (() => {
      try {
        const md = typeof locked.metadata === 'string' ? JSON.parse(locked.metadata) : (locked.metadata || {});
        return md?.lead_id ? String(md.lead_id) : null;
      } catch { return null; }
    })();
    if (lockedStamp && lockedStamp !== String(leadId)) {
      return { refusedReason: 'call_repointed' };
    }
    // STAMP-LESS repoint (codex P1, PR #3303 r9): when a force-reprocess
    // moved this call from its obsolete sid lead to a PHONE-matched lead,
    // that path writes no stamp at all — so there is no dissent to see
    // here. Apply the same ownership eligibility the bridge applies to an
    // unstamped sid join: a lead owned by a customer OTHER than the
    // call's is not this call's lead, and claiming it as provenance would
    // let recovery transfer the history-bearing row back to it.
    if (!lockedStamp) {
      const callOwner = await trx('call_log').where({ id: locked.id }).first('customer_id');
      const leadOwner = await trx('leads').where({ id: leadId }).first('customer_id');
      if (callOwner?.customer_id && leadOwner?.customer_id
        && String(callOwner.customer_id) !== String(leadOwner.customer_id)) {
        return { refusedReason: 'lead_owner_conflict' };
      }
      // The owner test's ANONYMOUS blind spot (codex P1 r16, the same
      // shape the bridge closes with sidJoinAttributionElsewhere): a
      // stamp-less repoint of a customer-less call leaves no owner to
      // conflict with — but the provenanced funnel row on the NEW lead
      // records the move. A row already residing on a DIFFERENT lead
      // means this sid candidate is not ours: claiming it would let
      // provenance recovery transfer the history-bearing row back to the
      // obsolete lead.
      const prov = await trx('ad_service_attribution')
        .where({ source_call_id: locked.id })
        .first('id', 'lead_id');
      if (prov && String(prov.lead_id) !== String(leadId)) {
        return { refusedReason: 'call_repointed' };
      }
    }
  }
  return { sourceCallId: locked.id };
}

async function backfillCallLeadAttribution({ leadId, customerId, serviceInterest = null } = {}) {
  if (!leadId || !customerId) return { recorded: false, reason: 'missing_ids' };
  try {
    // The WHOLE flow — lead read, source resolution, provenance, funnel
    // write — runs in ONE transaction with the lead row locked FIRST
    // (global leads → call_log order), and EVERY lead field read under
    // that lock (pre-push P1 r9): a pre-lock snapshot can go stale while
    // waiting, stamping attribution with the wrong call or customer. The
    // chosen source call is locked FOR UPDATE and its verdict re-checked
    // under the lock (codex P1, PR #3303 r5) — see
    // resolveSourceCallProvenanceLocked.
    return await db.transaction(async (trx) => {
      const lead = await trx('leads')
        .where({ id: leadId })
        .forUpdate()
        .first('id', 'customer_id', 'lead_source_id', 'service_interest', 'created_at', 'twilio_call_sid');
      if (!lead?.lead_source_id) return { recorded: false, reason: 'no_lead_source' };
      const sourceRow = await trx('lead_sources').where({ id: lead.lead_source_id }).first();
      if (!sourceRow) return { recorded: false, reason: 'source_not_found' };
      const attr = attributionForSourceType(sourceRow.source_type);
      if (!attr) return { recorded: false, reason: 'no_channel' };
      // Same exception as the call pipeline: the Google Ads call-bridge
      // target number is SHARED (organic hub + paid call-extension),
      // resolved by the bridge after the fact — never pre-attribute it or
      // the row would lock before the bridge can mark the call paid. The
      // unclaimed-bridge sweep below picks these up as organic after the
      // claim window. Lazy require: google-call-bridge lazily requires
      // this module (require cycle).
      const { isBridgeTargetNumber } = require('./google-call-bridge');
      if (isBridgeTargetNumber(sourceRow.twilio_phone_number)) {
        return { recorded: false, reason: 'bridge_target' };
      }
      const prov = await resolveSourceCallProvenanceLocked(trx, { leadId, twilioCallSid: lead.twilio_call_sid });
      if (prov.refusedReason) return { recorded: false, reason: prov.refusedReason };
      return recordCallPpcAttribution({
        // The LOCKED lead's owner, not the caller snapshot (GH-audit P1):
        // both attach paths write leads.customer_id BEFORE calling this
        // backfill, so a mismatch means the lead was reassigned while we
        // waited for the lock — the funnel row must pair with the live
        // owner (a NULL owner refuses inside recordCallPpcAttribution).
        customerId: lead.customer_id || null,
        leadId,
        leadSource: attr.leadSource,
        isPaid: attr.isPaid,
        leadSourceDetail: sourceRow.name || 'inbound call',
        serviceInterest: serviceInterest || lead.service_interest || null,
        sourceCallId: prov.sourceCallId,
        // Date by the actual call — the call pipeline mints the lead row at
        // call time, so created_at is the call date (not the day the
        // prospect finally clicked the text-back link).
        leadDate: lead.created_at || null,
        dbc: trx,
      });
    });
  } catch (err) {
    logger.warn(`[call-attribution] attached-lead backfill failed for lead ${leadId}: ${err.message}`);
    return { recorded: false, reason: 'error' };
  }
}

// ---------------------------------------------------------------------------
// Unclaimed bridge-target leads → organic, after a claim window.
//
// Calls to the Google Ads call-bridge target (the shared Bradenton city-page /
// office number) are NOT organically pre-attributed at call time: writing the
// funnel row first would lock out the bridge (recordCallPpcAttribution never
// flips an existing row's lead_source), so the call processor skips them and
// the bridge gets first claim. But when the bridge never matches the call to a
// Google Ads call report, the lead stayed funnel-invisible FOREVER — 57 leads
// in 90d on the busiest city page when this shipped, with the bridge having
// claimed none of them, ever.
//
// This daily job closes the hole: a lead still sitting on a bridge-target
// lead_sources row (an actual bridge claim repoints leads.lead_source_id to
// the bridge source, so claimed leads self-exclude) with no funnel row after
// `olderThanDays` is declared organic and recorded through the normal
// recordCallPpcAttribution path (channel from the shared source_type map).
// Google call reports surface within hours and the bridge re-scans a 30-day
// window, so a claim after 7 quiet days is not a real scenario; if one ever
// happened it would still repoint the LEAD row to paid — only the funnel row
// would stay organic (accepted tradeoff: the window IS the decision boundary).
// ---------------------------------------------------------------------------
async function attributeUnclaimedBridgeLeads({ olderThanDays = 7, limit = 200 } = {}) {
  // Lazy: google-call-bridge lazily requires this module (applyBridge), so a
  // module-scope import back at it would be a require cycle.
  const { isBridgeTargetNumber } = require('./google-call-bridge');

  let bridgeSources = [];
  try {
    const rows = await db('lead_sources').whereNotNull('twilio_phone_number');
    bridgeSources = (rows || []).filter((s) => {
      try { return isBridgeTargetNumber(s.twilio_phone_number); } catch { return false; }
    });
  } catch (err) {
    logger.error(`[call-attribution] bridge-unclaimed source scan failed: ${err.message}`);
    return { candidates: 0, recorded: 0, skipped: 0 };
  }
  if (!bridgeSources.length) return { candidates: 0, recorded: 0, skipped: 0 };

  const sourceById = new Map(bridgeSources.map((s) => [s.id, s]));
  const days = Math.max(1, parseInt(olderThanDays, 10) || 7);
  const cap = Math.max(1, parseInt(limit, 10) || 200);

  const leads = await db('leads as l')
    .whereIn('l.lead_source_id', bridgeSources.map((s) => s.id))
    // Live leads only (codex P1 r14): a soft-deleted lead with a customer
    // still passed recordCallPpcAttribution, so deleted leads kept feeding
    // acquisition/ROI data after deletion. Revalidated under the lock too.
    .whereNull('l.deleted_at')
    // Customer-less leads are DEFERRED to the claim-time backfill (codex
    // P2 r14): recordCallPpcAttribution refuses them ('no_customer'), so
    // this oldest-first limited scan re-selected the same refusable rows
    // every day — `limit` of them would permanently starve every newer
    // claimed lead. backfillCallLeadAttribution writes their row at the
    // moment they gain a customer, so exclusion loses nothing.
    .whereNotNull('l.customer_id')
    // CALL leads only. Bridge suppression only ever applied to the call path;
    // web leads on this source row got their funnel row at webhook time — and
    // the LEGACY ones link it by customer_id with lead_id NULL, which the
    // lead_id NOT EXISTS below cannot see (prod check: every form lead in the
    // first-run selection carried such a row → 18 guaranteed duplicates).
    .where('l.first_contact_channel', 'call')
    .whereRaw("COALESCE(l.first_contact_at, l.created_at) < now() - (? * interval '1 day')", [days])
    .whereRaw("COALESCE(l.status,'') NOT IN ('duplicate','disqualified','spam')")
    // Lead-level only — the funnel table's model (and recordCallPpcAttribution's
    // contract) is one row per LEAD: a returning customer's new unclaimed bridge
    // lead still counts, exactly as a second webhook form lead would. Revenue
    // can't double-count: ad-attribution-sync credits one primary row per
    // customer and demotes the rest.
    .whereNotExists(function noFunnelRow() {
      this.select(1).from('ad_service_attribution as a').whereRaw('a.lead_id = l.id');
    })
    // A bridged CALL whose lead was never repointed (e.g. no lead matched at
    // claim time, or the funnel write skipped on a then-customer-less lead) is
    // still a CLAIMED Google Ads call — "unclaimed" means no bridge stamp
    // anywhere, not just an un-repointed lead row. call_log has NO lead_id
    // column: the lead↔call linkage is twilio_call_sid, the same join the
    // bridge's own fetchCrmCalls uses (a NULL sid on the lead matches nothing
    // and passes, correctly — no linked call, no bridge stamp).
    .whereNotExists(function callAlreadyBridged() {
      this.select(1).from('call_log as cl')
        .whereRaw('cl.twilio_call_sid = l.twilio_call_sid')
        .whereNotNull('cl.google_ads_call_resource_name');
    })
    // Same claim check on the STAMP linkage arm (pre-push P1 r14): a
    // phone-less reused lead links through call_log.metadata.lead_id, and
    // its call being bridged is just as much a Google Ads claim as a
    // sid-linked one — sweeping it organic would double-bucket the lead.
    .whereNotExists(function stampedCallAlreadyBridged() {
      this.select(1).from('call_log as clb')
        .whereRaw("clb.metadata->>'lead_id' = l.id::text")
        .whereNotNull('clb.google_ads_call_resource_name');
    })
    // A lead whose linked call is not SETTLED-ATTRIBUTABLE must not be
    // swept into organic attribution. Rejection (spam/voicemail terminal,
    // retryable failure, durable no-attribution verdict) means the
    // processor just retired its funnel row and this sweep would recreate
    // paid-adjacent attribution for a rejected call (codex P1, PR #3303
    // r3); an IN-FLIGHT call (processing_token held, or any non-processed
    // status — e.g. a force-reprocess mid-decision) means the verdict is
    // about to land, and a row minted now carries no sourceCallId, so a
    // subsequent rejection could never retire it (codex P1 r5). Same
    // allowlist as callStillAttributable — token NULL and status
    // 'processed' or legacy NULL — expressed as its complement, on both
    // linkage arms: the lead's own sid AND the metadata stamp (phone-less
    // reuse). A blocked lead simply waits for the next sweep run.
    .whereNotExists(function sidCallNotAttributable() {
      this.select(1).from('call_log as clr')
        .whereRaw('clr.twilio_call_sid = l.twilio_call_sid')
        .where(function notSettled() {
          this.whereNotNull('clr.processing_token')
            .orWhere(function badStatus() {
              this.whereNotNull('clr.processing_status')
                .whereNot('clr.processing_status', 'processed');
            })
            .orWhereRaw("clr.metadata->>'no_attribution' = 'true'");
        });
    })
    .whereNotExists(function stampedCallNotAttributable() {
      this.select(1).from('call_log as cls')
        .whereRaw("cls.metadata->>'lead_id' = l.id::text")
        .where(function notSettled() {
          this.whereNotNull('cls.processing_token')
            .orWhere(function badStatus() {
              this.whereNotNull('cls.processing_status')
                .whereNot('cls.processing_status', 'processed');
            })
            .orWhereRaw("cls.metadata->>'no_attribution' = 'true'");
        });
    })
    .orderBy('l.created_at')
    .limit(cap)
    .select('l.id', 'l.customer_id', 'l.service_interest', 'l.first_contact_at', 'l.created_at', 'l.lead_source_id', 'l.twilio_call_sid');

  let recorded = 0;
  let skipped = 0;
  for (const lead of leads) {
    const source = sourceById.get(lead.lead_source_id);
    const channel = attributionForSourceType(source?.source_type);
    if (!channel) { skipped += 1; continue; } // unmapped source_type → fail closed
    let res;
    try {
      // Same locking rules as backfillCallLeadAttribution (pre-push P1
      // r9): lead locked first, the linked call's provenance resolved and
      // verified under the call-row lock, and the funnel write riding the
      // same transaction — so the sweep's rows carry source_call_id and a
      // later force-reprocess that rejects or repoints the call can
      // retire or transfer EXACTLY them, instead of leaving a
      // NULL-provenance organic row standing indefinitely. Ambiguous
      // linkage still records with NULL provenance (permanently
      // conservative); a candidate whose locked verdict refuses skips
      // this pass and waits for the next run.
      res = await db.transaction(async (trx) => {
        // EVERY attribution field re-read under the lock (pre-push P1
        // r10): the selection snapshot can go stale while waiting — a
        // reassigned customer or changed source must not pair a funnel
        // row with the wrong owner or channel. Channel re-derived from
        // the LOCKED row; a source that left the bridge set skips.
        const locked = await trx('leads')
          .where({ id: lead.id })
          // Live-lead predicate re-applied under the lock (codex P1 r14):
          // a lead soft-deleted between selection and lock must not gain
          // an organic funnel row.
          .whereNull('deleted_at')
          // Terminal-status exclusion re-applied too (codex P2 r16): an
          // admin marking the lead duplicate/disqualified/spam while this
          // transaction waited must not receive the irreversible organic
          // row off the stale candidate snapshot.
          .whereRaw("COALESCE(status,'') NOT IN ('duplicate','disqualified','spam')")
          .forUpdate()
          .first('id', 'customer_id', 'lead_source_id', 'service_interest', 'first_contact_at', 'created_at', 'twilio_call_sid');
        if (!locked) return { recorded: false, reason: 'lead_gone' };
        const lockedSource = sourceById.get(locked.lead_source_id);
        const lockedChannel = attributionForSourceType(lockedSource?.source_type);
        if (!lockedChannel) return { recorded: false, reason: 'no_channel' };
        const prov = await resolveSourceCallProvenanceLocked(trx, { leadId: locked.id, twilioCallSid: locked.twilio_call_sid });
        if (prov.refusedReason) return { recorded: false, reason: prov.refusedReason };
        return recordCallPpcAttribution({
          customerId: locked.customer_id,
          leadId: locked.id,
          leadSource: lockedChannel.leadSource,
          leadSourceDetail: lockedSource.name || null,
          leadDate: locked.first_contact_at || locked.created_at, // date by the call, not this run
          serviceInterest: locked.service_interest || null,
          isPaid: lockedChannel.isPaid, // main_site → false: unclaimed ⇒ organic
          sourceCallId: prov.sourceCallId,
          dbc: trx,
        });
      });
    } catch (sweepErr) {
      logger.warn(`[call-attribution] bridge-unclaimed sweep failed for lead ${lead.id}: ${sweepErr.message}`);
      res = { recorded: false, reason: 'error' };
    }
    if (res.recorded) recorded += 1; else skipped += 1;
  }
  if (leads.length) {
    logger.info(`[call-attribution] bridge-unclaimed sweep — candidates ${leads.length}, recorded ${recorded}, skipped ${skipped}`);
  }
  return { candidates: leads.length, recorded, skipped };
}

// Retire the funnel row a specific call created for a specific lead —
// EXACT provenance only (lead_id + source_call_id both match; NULL-
// provenance rows never match, so another call's or a web path's row can
// never be touched). The ONE definition shared by every stamp
// reconciliation: the google bridge's repoint/clear paths and the call
// processor's own stamp clear (codex P1, PR #3303 — the processor path
// creates provenanced rows for organic/dedicated-number calls the bridge
// never scans, and a cleared stamp there must retire its row the same
// way). Runs on the caller's connection so it can ride a lead-locking
// transaction.
async function retireCallAttributionRow(dbc, callLogId, leadId) {
  if (!callLogId || !leadId) return 0;
  return dbc('ad_service_attribution')
    .where({ lead_id: leadId, source_call_id: callLogId })
    .del();
}

// Retire EVERY funnel row a call created, whichever lead they sit on —
// definitive rejection (spam / voicemail / implausible / non-lead verdict)
// means the call supports no lead at all. Provenance-only on purpose
// (pre-push P1 r11): sid-linked calls carry source_call_id but no metadata
// stamp, and stamp-gated retirement left their rows reporting funnel
// stage/revenue for a rejected call.
async function retireAllCallAttributionRows(dbc, callLogId) {
  if (!callLogId) return 0;
  return dbc('ad_service_attribution').where({ source_call_id: callLogId }).del();
}

// Move the funnel row a specific call created when its linkage moves to a
// different lead — the ONE transfer/retire primitive shared by the google
// bridge's repoint reconciliation and the call processor's stamp settles
// (codex P0, PR #3303: rows accumulate booked/completed stages and revenue
// via lead-funnel-bridge, so delete-and-recreate loses history — a moved
// linkage TRANSFERS the row, stages and metrics intact). Exact provenance
// only. Outcomes: 'transferred' (row now on toLeadId, owner set to the
// target lead's CURRENT customer — read here on the same connection unless
// the caller already holds it), 'retired_conflict' (the target already
// owns a DIFFERENT row — this call's row retires; callers must NOT then
// backfill the target's row), 'retired_cleared' (no target — definitive
// unlink), 'none' (no provenanced row).
async function reconcileMovedCallAttributionRow(dbc, callLogId, fromLeadId, toLeadId, now, { toCustomerId } = {}) {
  if (!callLogId || !fromLeadId) return 'none';
  // The source row is LOCKED and the move conditioned on its expected
  // ownership (codex P1, PR #3303 r5): not every caller holds the call
  // row lock (the claim-time backfill runs on the global connection), so
  // two repoints could both read the old location and the stale one
  // overwrite the newer transfer. A zero-row conditioned update means
  // ownership changed under us — report 'none' and touch nothing.
  const oldRow = await dbc('ad_service_attribution')
    .where({ lead_id: fromLeadId, source_call_id: callLogId })
    .forUpdate()
    .first('id');
  if (!oldRow) return 'none';
  if (toLeadId) {
    // The conflicting row is LOCKED and RE-READ (codex P1, PR #3303 r10):
    // with two calls repointing at once — one arriving at this lead while
    // the row currently sitting here departs — an unlocked read saw the
    // departing row, the other transaction then moved it away, and this
    // one still retired its OWN source row as a conflict. The target slot
    // ended up empty and the incoming call's booked/completed stage and
    // revenue were deleted instead of transferred. Locking serializes the
    // pair; the second re-read after the lock releases tells us whether a
    // conflict genuinely remains.
    const conflictLocked = await dbc('ad_service_attribution')
      .where({ lead_id: toLeadId })
      .forUpdate()
      .first('id');
    const conflict = conflictLocked
      ? await dbc('ad_service_attribution').where({ lead_id: toLeadId }).first('id')
      : null;
    if (!conflict) {
      let owner = toCustomerId;
      if (owner === undefined) {
        // Under the target lead's ROW LOCK (pre-push P1 r12): consumers
        // prefer the attribution row's non-null customer over the lead
        // owner, so a claim/reassignment racing this unlocked read would
        // persist a stale association indefinitely. Callers that already
        // hold the target lock (the bridge; the in-stamp-txn transfer)
        // pass the owner instead; a second FOR UPDATE here is a no-op on
        // the same transaction. Cross-lead lock ordering can deadlock in
        // principle — PostgreSQL aborts one side and every caller's
        // failure path lands in a retry lane.
        const lead = await dbc('leads').where({ id: toLeadId }).forUpdate().first('customer_id');
        owner = lead?.customer_id || null;
      }
      const moved = await dbc('ad_service_attribution')
        .where({ id: oldRow.id, lead_id: fromLeadId, source_call_id: callLogId })
        .update({ lead_id: toLeadId, customer_id: owner || null, updated_at: now });
      if (!moved) return 'none';
      return 'transferred';
    }
    await retireCallAttributionRow(dbc, callLogId, fromLeadId);
    return 'retired_conflict';
  }
  await retireCallAttributionRow(dbc, callLogId, fromLeadId);
  return 'retired_cleared';
}

// Drain the durable retry markers the processor writes when a repoint found
// the FORMER lead holding a legacy (NULL source_call_id) row (codex P1,
// PR #3303 r12): the funnel write was suppressed to avoid double-counting,
// but a dedicated/organic call finalizes as 'processed' and nothing ever
// rescans it — so once an operator resolves the legacy row, the new lead
// would stay unattributed forever. This sweep (daily, after the bridge/
// organic pair) completes the write against the LIVE stamped lead.
//
// Per row, in ONE transaction under the repo lock order (leads →
// call_log): re-verify the call is still SETTLED (a held processing_token
// means an in-flight pass owns the decision — skip), the marker still
// present, and the live stamp still names the lead we locked (a repoint
// since the scan retries next run against the right lead). The marker is
// CLEARED without writing when the linkage is positively gone (no stamp /
// dead lead / durable no_attribution verdict) or the row already exists —
// a later pass, or provenance recovery, beat us to it and the partial
// UNIQUE on source_call_id would refuse a second insert anyway. A still-
// present legacy row, or an unclaimed live lead (recordCallPpcAttribution
// refuses a NULL owner), leaves the marker for the next run. Failures keep
// the marker too — this IS the retry lane.
async function sweepPendingAttributionTransfers({ limit = 100 } = {}) {
  const summary = { scanned: 0, recorded: 0, cleared: 0, blocked: 0, skipped: 0, failed: 0, scanFailed: false };
  const parseMd = (raw) => {
    if (!raw) return {};
    if (typeof raw === 'string') { try { return JSON.parse(raw); } catch { return {}; } }
    return raw;
  };
  let rows = [];
  try {
    rows = await db('call_log')
      // NOT the jsonb `?` existence operator — knex.raw consumes a bare ?
      // as a binding placeholder.
      .whereRaw("metadata->'attribution_transfer_pending' IS NOT NULL")
      .whereNull('processing_token')
      // FAIR ordering (codex P2 r13): a fixed created_at order plus the
      // limit lets `limit` permanently-blocked markers starve every newer
      // one. Blocked attempts stamp last_attempt_at (below); never-tried
      // markers go first ('' sorts before any timestamp), then the
      // longest-untouched — persistent blockers rotate to the back
      // instead of pinning the window.
      .orderByRaw("COALESCE(metadata->'attribution_transfer_pending'->>'last_attempt_at', '') ASC")
      .orderBy('created_at', 'asc')
      .limit(limit)
      .select('id', 'metadata', 'created_at');
  } catch (e) {
    logger.warn(`[attribution-transfer-sweep] scan failed: ${e.code || e.name || 'db_error'}`);
    // Reported, not just logged (codex P2 r16): the caller inspects this
    // so a persistent scan failure surfaces in the cron's job health
    // instead of counting as a healthy tick with zero work.
    summary.scanFailed = true;
    return summary;
  }
  for (const row of rows) {
    summary.scanned += 1;
    const scannedMd = parseMd(row.metadata);
    const scannedLeadId = scannedMd.lead_id ? String(scannedMd.lead_id) : null;
    try {
      const outcome = await db.transaction(async (trx) => {
        // Leads FIRST (repo-wide order): the scanned stamp names the lead
        // to lock; the locked call row below re-verifies the stamp still
        // points there before the lock is trusted.
        const lockedLead = scannedLeadId
          ? await trx('leads')
            .where({ id: scannedLeadId })
            .whereNull('deleted_at')
            .forUpdate()
            .first('id', 'customer_id')
          : null;
        const lockedCall = await trx('call_log')
          .where({ id: row.id })
          .forUpdate()
          .first('id', 'processing_token', 'processing_status', 'metadata', 'created_at');
        if (!lockedCall) return 'skipped';
        const md = parseMd(lockedCall.metadata);
        const pending = md.attribution_transfer_pending;
        if (!pending) return 'skipped'; // resolved since the scan
        if (lockedCall.processing_token) return 'skipped'; // in-flight pass owns it
        const clearMarker = () => trx('call_log')
          .where({ id: row.id })
          .whereNull('processing_token')
          .update({
            metadata: db.raw("COALESCE(metadata, '{}'::jsonb) - 'attribution_transfer_pending'"),
            updated_at: new Date(),
          });
        // A deferred/blocked marker stamps last_attempt_at so the fair
        // ordering rotates it behind never-tried markers (codex P2 r13).
        const stampAttempt = () => trx('call_log')
          .where({ id: row.id })
          .whereNull('processing_token')
          .update({
            metadata: db.raw(
              "jsonb_set(COALESCE(metadata, '{}'::jsonb), '{attribution_transfer_pending,last_attempt_at}', ?::jsonb, true)",
              [JSON.stringify(new Date().toISOString())],
            ),
            updated_at: new Date(),
          });
        const blocked = async () => { await stampAttempt(); return 'blocked'; };
        // SUCCESSFUL settled passes only — the same allowlist as
        // callStillAttributable (codex P1 r13): extraction_failed also
        // carries a NULL token, but it is a retryable FAILED attempt whose
        // retry re-derives linkage; attributing (or clearing) from it
        // would act on an unfinished verdict. '' covers the intentional
        // legacy NULL status. The skip still stamps last_attempt_at
        // (codex P2 r14): a call whose retry budget is exhausted stays
        // extraction_failed forever, and without the stamp its marker
        // sorts first every day — `limit` such markers would permanently
        // starve every actionable transfer behind them.
        const status = String(lockedCall.processing_status || '').toLowerCase();
        if (status !== 'processed' && status !== '') {
          await stampAttempt();
          return 'skipped';
        }
        const liveLeadId = md.lead_id ? String(md.lead_id) : null;
        // Positively-established dead linkage: a settled call with no live
        // stamp (or a durable non-lead verdict) can never take the write.
        if (!liveLeadId || md.no_attribution === true) {
          await clearMarker();
          return 'cleared';
        }
        if (liveLeadId !== scannedLeadId) return 'skipped'; // repointed since the scan — next run locks the right lead
        if (!lockedLead) {
          // The stamp still names this lead but the row is gone/soft-deleted.
          await clearMarker();
          return 'cleared';
        }
        const existing = await trx('ad_service_attribution')
          .where({ source_call_id: row.id })
          .first('id', 'lead_id');
        if (existing) {
          // Already on the LIVE lead — genuinely done. On any OTHER lead
          // (codex P1 r13: the operator resolved the former lead's legacy
          // row by assigning it THIS call's provenance), clearing here
          // would strand the history on the obsolete lead while the stamp
          // names the new one — TRANSFER it through the shared
          // reconciliation instead. 'retired_conflict' is definitive (the
          // live lead owns another row; this call's row retired); 'none'
          // means ownership moved under us — retry next run.
          if (String(existing.lead_id) === liveLeadId) {
            await clearMarker();
            return 'cleared';
          }
          const moved = await reconcileMovedCallAttributionRow(
            trx, row.id, existing.lead_id, liveLeadId, new Date(),
            { toCustomerId: lockedLead.customer_id || null },
          );
          if (moved === 'transferred') {
            await clearMarker();
            return 'recorded';
          }
          if (moved === 'retired_conflict') {
            await clearMarker();
            return 'cleared';
          }
          return blocked();
        }
        const legacy = await trx('ad_service_attribution')
          .where({ lead_id: pending.from_lead_id })
          .whereNull('source_call_id')
          .first('id');
        if (legacy) return blocked(); // operator hasn't resolved it yet
        const owner = lockedLead.customer_id || null;
        if (!owner) return blocked(); // unclaimed lead — retry once claimed
        const res = await recordCallPpcAttribution({
          customerId: owner,
          leadId: liveLeadId,
          leadSource: pending.lead_source,
          isPaid: pending.is_paid !== false,
          leadSourceDetail: pending.detail || 'inbound call',
          serviceInterest: pending.service_interest || null,
          leadDate: lockedCall.created_at || row.created_at || null,
          sourceCallId: row.id,
          dbc: trx,
        });
        if (res && res.recorded) {
          await clearMarker();
          return 'recorded';
        }
        // Definitive refusals can never take the write on this lead: the
        // lead already carries another call's / another channel's
        // first-touch row ('other_call' / 'other_source' /
        // 'web_attributed' — the lead is counted once by design). Clear
        // rather than retry forever. 'unprovenanced_row' (a legacy row on
        // the LIVE lead) and transient errors keep the marker — the same
        // operator-resolution retry lane as the former lead's block.
        if (res && ['other_call', 'other_source', 'web_attributed'].includes(res.reason)) {
          await clearMarker();
          return 'cleared';
        }
        return blocked();
      });
      summary[outcome] += 1;
    } catch (e) {
      summary.failed += 1;
      logger.warn(`[attribution-transfer-sweep] call ${row.id} failed: ${e.code || e.name || 'error'}`);
    }
  }
  if (summary.scanned) logger.info(`[attribution-transfer-sweep] ${JSON.stringify(summary)}`);
  return summary;
}

module.exports = {
  recordCallPpcAttribution,
  attributionForSourceType,
  backfillCallLeadAttribution,
  attributeUnclaimedBridgeLeads,
  retireCallAttributionRow,
  retireAllCallAttributionRows,
  reconcileMovedCallAttributionRow,
  sweepPendingAttributionTransfers,
  _private: { resolveCampaignId, SOURCE_TYPE_ATTRIBUTION },
};
