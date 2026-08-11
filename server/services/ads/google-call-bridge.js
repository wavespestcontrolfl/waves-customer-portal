const db = require('../../models/db');
const logger = require('../logger');
const TWILIO_NUMBERS = require('../../config/twilio-numbers');
const { parseETDateTime, etDateString, addETDays, formatETTime } = require('../../utils/datetime-et');
// The retry horizon bounding the phone-linkage snapshot — shared with the
// processor's own in-flight test so the two can't drift apart.
const { CALL_EXTRACTION_RETRY_WINDOW_MS } = require('../../utils/estimate-claim-sql');

const GOOGLE_ADS_BRIDGE_SOURCE_NAME = 'Google Ads - Call Reporting Bridge';
const GOOGLE_ADS_BRIDGE_LOCATION_ID = 'bradenton';
const LEAD_MATCH_WINDOW_HOURS = 6;
const MIN_AUTO_BRIDGE_CONFIDENCE = 70;
// Score gap within which a runner-up is "equally plausible" — the ambiguity
// test AND the organic sweep's exclusion set both read it (codex P1 r23),
// so it is named once rather than repeated as a bare 10.
const AMBIGUITY_SCORE_MARGIN = 10;
const MAX_MATCH_WINDOW_MINUTES = 20;

function getGoogleAds() {
  return require('./google-ads');
}

function mainLine() {
  const line = TWILIO_NUMBERS.locations?.[GOOGLE_ADS_BRIDGE_LOCATION_ID];
  if (!line?.number) {
    throw new Error(`Google Ads call bridge target is not configured: TWILIO_NUMBERS.locations.${GOOGLE_ADS_BRIDGE_LOCATION_ID}`);
  }
  return line;
}

function phoneDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

function normalizePhone(value) {
  const digits = phoneDigits(value);
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  return value || null;
}

function phoneVariants(value) {
  const normalized = normalizePhone(value);
  const digits = phoneDigits(normalized || value);
  const ten = digits.length >= 10 ? digits.slice(-10) : null;
  const variants = new Set([value, normalized].filter(Boolean));
  if (ten) {
    variants.add(ten);
    variants.add(`1${ten}`);
    variants.add(`+1${ten}`);
    variants.add(`(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}`);
  }
  return [...variants];
}

function areaCode(value) {
  const digits = phoneDigits(value);
  const ten = digits.length >= 10 ? digits.slice(-10) : digits;
  return ten.length >= 3 ? ten.slice(0, 3) : null;
}

function phoneLast10(value) {
  const digits = phoneDigits(value);
  return digits.length >= 10 ? digits.slice(-10) : null;
}

function leadTimeWindow(callLog) {
  const callAt = callLog?.createdAt ? new Date(callLog.createdAt) : null;
  if (!callAt || Number.isNaN(callAt.getTime())) return null;
  const windowMs = LEAD_MATCH_WINDOW_HOURS * 60 * 60 * 1000;
  return {
    callAt,
    startAt: new Date(callAt.getTime() - windowMs),
    endAt: new Date(callAt.getTime() + windowMs),
  };
}

function leadMatchPlan(callLog) {
  const window = leadTimeWindow(callLog);
  if (!window) return null;
  if (callLog?.customerId) {
    return { strategy: 'customer_id', customerId: callLog.customerId, ...window };
  }
  const last10 = phoneLast10(callLog?.fromPhone);
  if (last10) {
    return { strategy: 'phone_last10', phoneLast10: last10, ...window };
  }
  return null;
}

function parseGoogleDateTime(value) {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(raw)) return new Date(raw);
  return parseETDateTime(raw.replace(' ', 'T'));
}

function normalizeGoogleCallRow(row) {
  const callView = row.call_view || row.callView || {};
  const campaign = row.campaign || {};
  const adGroup = row.ad_group || row.adGroup || {};
  const start = parseGoogleDateTime(callView.start_call_date_time || callView.startCallDateTime);
  const end = parseGoogleDateTime(callView.end_call_date_time || callView.endCallDateTime);

  return {
    resourceName: callView.resource_name || callView.resourceName || null,
    startCallDateTime: callView.start_call_date_time || callView.startCallDateTime || null,
    endCallDateTime: callView.end_call_date_time || callView.endCallDateTime || null,
    startAt: start && !Number.isNaN(start.getTime()) ? start : null,
    endAt: end && !Number.isNaN(end.getTime()) ? end : null,
    durationSeconds: Number(callView.call_duration_seconds ?? callView.callDurationSeconds ?? 0) || 0,
    callStatus: callView.call_status || callView.callStatus || null,
    callType: callView.type || null,
    displayLocation: callView.call_tracking_display_location || callView.callTrackingDisplayLocation || null,
    callerAreaCode: callView.caller_area_code || callView.callerAreaCode || null,
    callerCountryCode: callView.caller_country_code || callView.callerCountryCode || null,
    campaignId: campaign.id ? String(campaign.id) : null,
    campaignName: campaign.name || null,
    adGroupId: adGroup.id ? String(adGroup.id) : null,
    adGroupName: adGroup.name || null,
  };
}

function secondsBetween(a, b) {
  if (!a || !b) return null;
  const left = a instanceof Date ? a : new Date(a);
  const right = b instanceof Date ? b : new Date(b);
  if (Number.isNaN(left.getTime()) || Number.isNaN(right.getTime())) return null;
  return Math.abs(left.getTime() - right.getTime()) / 1000;
}

function statusLooksCompatible(googleStatus, crmStatus) {
  const g = String(googleStatus || '').toLowerCase();
  const c = String(crmStatus || '').toLowerCase();
  if (!g || !c) return true;
  if (g.includes('received') || g.includes('answered')) {
    return ['completed', 'bridged', 'in-progress'].includes(c);
  }
  if (g.includes('missed')) {
    return ['no-answer', 'busy', 'failed', 'canceled', 'missed'].includes(c);
  }
  return true;
}

function scoreCallMatch(googleCall, callLog, targetNumber = mainLine().number) {
  const reasons = [];
  let score = 0;

  const targetVariants = phoneVariants(targetNumber);
  if (targetVariants.includes(callLog.to_phone)) {
    score += 25;
    reasons.push('dialed main 7612 line');
  }

  const timeDiffSeconds = secondsBetween(googleCall.startAt, callLog.created_at);
  if (timeDiffSeconds != null) {
    if (timeDiffSeconds <= 120) {
      score += 35;
      reasons.push('start time within 2 minutes');
    } else if (timeDiffSeconds <= 300) {
      score += 25;
      reasons.push('start time within 5 minutes');
    } else if (timeDiffSeconds <= 600) {
      score += 10;
      reasons.push('start time within 10 minutes');
    } else {
      score -= 20;
      reasons.push('start time is outside the preferred window');
    }
  }

  const googleDuration = Number(googleCall.durationSeconds || 0);
  const crmDuration = Number(callLog.duration_seconds || 0);
  if (googleDuration > 0 && crmDuration > 0) {
    const durationDiff = Math.abs(googleDuration - crmDuration);
    if (durationDiff <= 15) {
      score += 25;
      reasons.push('duration within 15 seconds');
    } else if (durationDiff <= 30) {
      score += 15;
      reasons.push('duration within 30 seconds');
    } else if (durationDiff <= 60) {
      score += 5;
      reasons.push('duration within 60 seconds');
    } else {
      score -= 10;
      reasons.push('duration differs by more than 60 seconds');
    }
  } else if (googleDuration === 0 || crmDuration === 0) {
    score += 5;
    reasons.push('duration unavailable on one side');
  }

  const googleArea = phoneDigits(googleCall.callerAreaCode).slice(0, 3);
  const crmArea = areaCode(callLog.from_phone);
  if (googleArea && crmArea) {
    if (googleArea === crmArea) {
      score += 15;
      reasons.push('caller area code matches');
    } else {
      score -= 15;
      reasons.push('caller area code differs');
    }
  }

  if (statusLooksCompatible(googleCall.callStatus, callLog.status)) {
    score += 10;
    reasons.push('call statuses are compatible');
  } else {
    score -= 10;
    reasons.push('call statuses conflict');
  }

  if (callLog.google_ads_call_resource_name === googleCall.resourceName) {
    score += 20;
    reasons.push('already linked to same Google Ads call');
  }

  return {
    score: Math.max(0, Math.min(100, Math.round(score))),
    timeDiffSeconds,
    reasons,
  };
}

function shapeCallLog(row) {
  if (!row) return null;
  const bridgeMetadata = googleAdsBridgeMetadata(row.metadata);
  return {
    id: row.id,
    twilioCallSid: row.twilio_call_sid,
    fromPhone: row.from_phone,
    toPhone: row.to_phone,
    status: row.status,
    source: row.source || null,
    createdAt: row.created_at,
    durationSeconds: row.duration_seconds || 0,
    customerId: row.customer_id || null,
    customerName: [row.customer_first_name, row.customer_last_name].filter(Boolean).join(' ') || null,
    leadId: row.lead_id || null,
    // The joined lead's owner: a phone-less reused lead converted/assigned
    // after the call leaves call_log.customer_id null while the lead knows
    // its customer — attribution needs it (codex P2, PR #3275).
    leadCustomerId: row.lead_customer_id || null,
    // The call's own durable stamp target, independent of whether that
    // lead survived the join's liveness filter (codex P1, PR #3303 r7).
    stampedLeadId: (() => {
      const md = parseCallMetadata(row.metadata);
      return md?.lead_id ? String(md.lead_id) : null;
    })(),
    // Set by dedupeCrmCallRows when a SETTLED stamp names a lead the join
    // could not return (soft-deleted target): the lead columns are cleared
    // and NOTHING may be attributed this scan — see the flag's use in
    // attributeResolvedLead (codex P1, PR #3303 r7).
    stampTargetMissing: row.stamp_target_missing === true,
    leadSourceName: row.lead_source_name || null,
    googleAdsCallResourceName: row.google_ads_call_resource_name || null,
    googleAdsBridgedAt: row.google_ads_bridged_at || null,
    // Terminal no-attribution verdict (codex P1, PR #3303): spam/voicemail
    // terminals by status; the non-lead verdict finalizes 'processed' and
    // carries the metadata marker the processor writes atomically with its
    // attribution retirement. A rejected call still sid-joins its lead in
    // fetchCrmCalls, and without this the next scan recreated the row the
    // processor just retired.
    noAttribution: ['spam', 'voicemail'].includes(String(row.processing_status || '').toLowerCase())
      || parseCallMetadata(row.metadata)?.no_attribution === true,
    googleAdsLeadMatched: !!bridgeMetadata?.leadMatch?.leadId,
    // Which lead the recorded match points at — the repoint detector in
    // shouldRetryLeadAttribution compares it against the CURRENT joined
    // lead (codex P1, PR #3303).
    googleAdsLeadMatchedLeadId: bridgeMetadata?.leadMatch?.leadId || null,
    googleAdsLeadMatchedStrategy: bridgeMetadata?.leadMatch?.strategy || null,
    googleAdsLeadMatchedAt: bridgeMetadata?.leadAttributedAt || null,
  };
}

// Fresh, LOCKED verdict re-check inside an attribution transaction
// (pre-push P1 r16): the snapshot's noAttribution can be minutes old, and a
// processor rejection committing in the gap must win. FOR UPDATE on the
// call row serializes against the rejection's own terminal write (which
// updates the same row), so either we see its verdict, or it waits for us
// and its retire then removes what we wrote. Lock order stays
// leads → call_log, same as every stamp writer.
async function callStillAttributable(trx, callLogId) {
  const row = await trx('call_log')
    .where({ id: callLogId })
    .forUpdate()
    .first('processing_status', 'processing_token', 'metadata');
  if (!row) return false;
  // SETTLED calls only (pre-push P0 r18): a non-null processing_token
  // means a pass is mid-flight — the non-lead path clears its stamp
  // before its verdict becomes durable, and reconciling in that window
  // deleted booked/completed attribution that a failed pass could never
  // restore. The retry lane re-evaluates once the pass settles.
  if (row.processing_token != null) return false;
  // ALLOWLIST, not a denylist (pre-push P1 r16): only 'processed' — the
  // one settled successful verdict — plus the intentional legacy NULL
  // status attribute. Every other state (pending, no_transcription,
  // extraction_failed, the *_creation_failed intervention lanes, spam,
  // voicemail, processing, and anything future) is unresolved or
  // rejected, and attributing before classification would overwrite
  // lead_source_id in a way a later rejection cannot restore.
  const status = String(row.processing_status || '').toLowerCase();
  if (status !== 'processed' && status !== '') return false;
  return parseCallMetadata(row.metadata)?.no_attribution !== true;
}

function parseCallMetadata(metadata) {
  if (!metadata) return {};
  if (typeof metadata === 'string') {
    try { return JSON.parse(metadata) || {}; } catch { return {}; }
  }
  return metadata;
}

function googleAdsBridgeMetadata(metadata) {
  if (!metadata) return {};
  if (typeof metadata === 'string') {
    try {
      return JSON.parse(metadata)?.google_ads_call_bridge || {};
    } catch {
      return {};
    }
  }
  return metadata.google_ads_call_bridge || {};
}

function shouldRetryLeadAttribution(match) {
  if (match?.status !== 'already_bridged' || !match.callLog?.id) return false;
  // A terminal no-attribution verdict (spam/voicemail/non-lead) is final:
  // nothing to attribute, and re-attributing would recreate rows the
  // processor retired (codex P1, PR #3303).
  if (match.callLog.noAttribution) return false;
  if (!match.callLog.googleAdsLeadMatched) return true;
  // A SETTLED stamp can still be repointed by a later force-reprocess
  // (codex P1, PR #3303): the recorded leadMatch then references the OLD
  // lead while the fetch join surfaces the new one — without this arm the
  // scan only ever backfilled the new lead's funnel row, leaving the
  // former lead's paid attribution intact alongside it. A recorded lead
  // that differs from the CURRENT joined lead re-enters the retry lane,
  // which re-runs attribution against the live linkage and reconciles the
  // old funnel row.
  const recordedLeadId = match.callLog.googleAdsLeadMatchedLeadId;
  if (!recordedLeadId) return false;
  const joinedLeadId = match.callLog.leadId;
  // A joined lead that DIFFERS from the recorded one is a repoint — stale
  // either way. A missing joined lead is stale ONLY when the recorded
  // match was itself joined-linkage (codex P1, PR #3303: a cleared stamp
  // or deleted joined lead must enter reconciliation, or the old lead's
  // paid attribution stands indefinitely) — plan-attributed calls
  // (customer/phone strategies) never had a joined lead, and treating
  // their normal state as stale would churn re-attribution every scan.
  if (joinedLeadId) return String(recordedLeadId) !== String(joinedLeadId);
  return match.callLog.googleAdsLeadMatchedStrategy === 'joined_lead';
}

function redactedLeadMatch(leadMatch) {
  if (!leadMatch?.leadId) return null;
  return {
    leadId: leadMatch.leadId,
    strategy: leadMatch.strategy,
    customerId: leadMatch.customerId || null,
  };
}

function bridgeMetadataPatch(bridgePayload) {
  return db.raw(`
    COALESCE(metadata, '{}'::jsonb)
    || jsonb_build_object(
      'google_ads_call_bridge',
      COALESCE(metadata->'google_ads_call_bridge', '{}'::jsonb) || ?::jsonb
    )
  `, [JSON.stringify(bridgePayload)]);
}

function shapeGoogleCall(row) {
  return {
    resourceName: row.resourceName,
    startCallDateTime: row.startCallDateTime,
    startAt: row.startAt ? row.startAt.toISOString() : null,
    startLabel: row.startAt ? `${etDateString(row.startAt)} ${formatETTime(row.startAt)}` : row.startCallDateTime,
    durationSeconds: row.durationSeconds,
    callStatus: row.callStatus,
    callerAreaCode: row.callerAreaCode,
    campaignId: row.campaignId,
    campaignName: row.campaignName,
    adGroupId: row.adGroupId,
    adGroupName: row.adGroupName,
  };
}

function buildMatches(googleCalls, crmCalls, targetNumber = mainLine().number) {
  const usedCallIds = new Set();
  const matches = [];

  for (const googleCall of googleCalls) {
    const scored = crmCalls
      .map((call) => ({
        call,
        ...scoreCallMatch(googleCall, call, targetNumber),
      }))
      .filter((candidate) => candidate.timeDiffSeconds == null
        || candidate.timeDiffSeconds <= MAX_MATCH_WINDOW_MINUTES * 60)
      .sort((a, b) => b.score - a.score);

    const best = scored[0] || null;
    const second = scored[1] || null;
    const alreadyBridged = !!(best?.call?.google_ads_call_resource_name);
    const ambiguous = !!(best && second && best.score - second.score < AMBIGUITY_SCORE_MARGIN && second.score >= MIN_AUTO_BRIDGE_CONFIDENCE);
    // EVERY equally-plausible candidate, untruncated (codex P1 r23):
    // `alternatives` below is a display preview capped at two, and the
    // organic sweep built its exclusion set from it — so a fourth
    // candidate inside the ambiguity margin was omitted and its lead took
    // the irreversible organic fallback while the bridge still considered
    // the match ambiguous. Correctness reads this list; the UI keeps the
    // preview.
    const ambiguousCandidates = ambiguous
      ? scored
        .filter((c) => c === best
          || (c.score >= MIN_AUTO_BRIDGE_CONFIDENCE && best.score - c.score < AMBIGUITY_SCORE_MARGIN))
        .map((c) => shapeCallLog(c.call))
      : [];
    const ready = !!(best && best.score >= MIN_AUTO_BRIDGE_CONFIDENCE && !ambiguous && !usedCallIds.has(best.call.id));

    if (ready) usedCallIds.add(best.call.id);

    matches.push({
      status: ready
        ? (alreadyBridged ? 'already_bridged' : 'ready')
        : (ambiguous ? 'ambiguous' : 'unmatched'),
      googleCall: shapeGoogleCall(googleCall),
      callLog: best ? shapeCallLog(best.call) : null,
      confidence: best?.score || 0,
      reasons: best?.reasons || [],
      alternatives: scored.slice(1, 3).map((candidate) => ({
        callLog: shapeCallLog(candidate.call),
        confidence: candidate.score,
        reasons: candidate.reasons,
      })),
      ambiguousCandidates,
    });
  }

  return matches;
}

// The CRM-side fetch cap — FIXED, independent of the Google-side `limit`
// option (codex P1, ambiguity-record r5 GH round: rescan trust must compare
// crmMainLineCalls against THIS bound, not the caller's Google limit, or a
// healthy manual apply at the UI's default limit reads 200–499 CRM calls as
// a capped scan and can never clear its old ambiguity records).
const CRM_FETCH_LIMIT = 500;

async function fetchCrmCalls(days = 30) {
  const safeDays = Math.min(Math.max(parseInt(days, 10) || 30, 1), 90);
  const since = addETDays(new Date(), -safeDays);
  const target = mainLine();

  // The 500-call bound stays INSIDE Postgres (codex P2, PR #3275). Capping
  // in JS made the cron/admin bridge materialize every call in the window
  // plus every OR-join duplicate before discarding the tail — memory and
  // latency growing with 90 days of history to keep 500 rows. This subquery
  // has no joins, so its LIMIT counts DISTINCT calls; the join below then
  // adds at most the stale-stamp twin for each of them.
  const newestCallIds = db('call_log')
    .select('id')
    .where('direction', 'inbound')
    .whereIn('to_phone', phoneVariants(target.number))
    .where('created_at', '>=', since)
    .orderBy('created_at', 'desc')
    .limit(CRM_FETCH_LIMIT);

  return db('call_log as c')
    .leftJoin('customers as cu', 'c.customer_id', 'cu.id')
    // The sid join misses a phone-less reused-lead call: the lead keeps its
    // ORIGINAL call's sid and the later call links via the durable
    // call_log.metadata.lead_id stamp instead (codex P1, PR #3275). A stale
    // stamp CAN transiently coexist with a different sid-linked lead (a
    // retry that minted before its cleanup ran), which would duplicate the
    // call row through this OR join and make buildMatches read the twin as
    // an equal-score second candidate → false ambiguity; dedupeCrmCallRows
    // below collapses that shape, sid-linked lead winning. Two live leads
    // genuinely sharing one sid stay multi-row, so their ambiguity — and
    // the conservative no-bridge it triggers — survives.
    .leftJoin('leads as l', function joinLeadForCall() {
      this.on(function linkageArms() {
        this.on('c.twilio_call_sid', 'l.twilio_call_sid')
          .orOn(db.raw("c.metadata->>'lead_id' = l.id::text"));
      // A soft-deleted lead must never ride the join into attribution —
      // findLeadForCall enforces whereNull(deleted_at), and the joined
      // shortcut must match its eligibility (codex P2, PR #3275).
      }).andOn(db.raw('l.deleted_at IS NULL'));
    })
    .leftJoin('lead_sources as ls', 'l.lead_source_id', 'ls.id')
    .whereIn('c.id', newestCallIds)
    .select(
      'c.*',
      'cu.first_name as customer_first_name',
      'cu.last_name as customer_last_name',
      'l.id as lead_id',
      'l.customer_id as lead_customer_id',
      'l.twilio_call_sid as lead_call_sid',
      'ls.name as lead_source_name',
    )
    .orderBy('c.created_at', 'desc')
    // No LIMIT here — it would count JOIN ROWS, so a call kept ambiguous
    // below could push an older DISTINCT call out of the window and leave a
    // paid call unbridged for the organic sweep. The distinct-call bound is
    // the newestCallIds subquery above (codex P2, PR #3275).
    .then(dedupeCrmCallRows);
}

// Collapse ONLY the stamp-plus-sid duplicate the OR join above can
// transiently produce (a stale stamp coexisting with a different sid-linked
// lead); the sid-linked lead is authoritative — same precedence
// findReusableCallLead uses (codex P2, PR #3275).
//
// Genuine ambiguity is PRESERVED: leads.twilio_call_sid carries no unique
// index, so two live leads can share one sid. Those rows made buildMatches
// see an equal-score second candidate and mark the google call ambiguous —
// a conservative no-bridge. Collapsing them to whichever row Postgres
// returned first would let the bridge rewrite an arbitrary lead's source
// and leave the real one unattributed, so multi-sid-linked calls keep every
// sid-linked row (codex P2, PR #3275).
function dedupeCrmCallRows(rows) {
  const isSidLinked = (r) => !!(r.lead_call_sid && r.twilio_call_sid && r.lead_call_sid === r.twilio_call_sid);
  // The joined row came through the STAMP arm and the call's own metadata
  // stamp still targets this lead.
  const isStampLinked = (r) => {
    if (isSidLinked(r)) return false;
    try {
      const md = typeof r.metadata === 'string' ? JSON.parse(r.metadata) : (r.metadata || {});
      return md?.lead_id != null && String(md.lead_id) === String(r.lead_id);
    } catch { return false; }
  };
  const callSettled = (r) => r.processing_token == null
    && (r.processing_status == null || String(r.processing_status).toLowerCase() === 'processed');
  const byId = new Map();
  for (const row of rows) {
    if (!byId.has(row.id)) byId.set(row.id, []);
    byId.get(row.id).push(row);
  }
  // The call's own stamp target, regardless of whether the join could
  // return that lead row.
  const stampTargetOf = (r) => {
    try {
      const md = typeof r.metadata === 'string' ? JSON.parse(r.metadata) : (r.metadata || {});
      return md?.lead_id != null ? String(md.lead_id) : null;
    } catch { return null; }
  };
  // A SETTLED stamp whose target the join could not return — the target
  // lead is soft-deleted (the join's deleted_at filter hides it) or gone
  // (codex P1, PR #3303 r7). The stamp is still the processor's verdict,
  // so the sid row left behind must NOT be treated as authoritative: it
  // would let the bridge rewrite the obsolete sid lead's source and
  // transfer the history-bearing funnel row back to it. Clear the lead
  // columns and flag the call — attributeResolvedLead then attributes
  // nothing (and never falls to the plan), so a recorded match settles
  // through the cleared-link path instead of moving.
  const withMissingStampTarget = (group) => {
    const target = stampTargetOf(group[0]);
    if (!target || !callSettled(group[0])) return null;
    if (group.some((r) => r.lead_id != null && String(r.lead_id) === target)) return null;
    return {
      ...group[0], lead_id: null, lead_customer_id: null, lead_call_sid: null, stamp_target_missing: true,
    };
  };
  const deduped = [];
  for (const group of byId.values()) {
    const stampMissing = withMissingStampTarget(group);
    if (stampMissing) { deduped.push(stampMissing); continue; }
    if (group.length === 1) { deduped.push(group[0]); continue; }
    const seenLeadIds = new Set();
    const sidLinked = group.filter((r) => {
      if (!isSidLinked(r)) return false;
      const key = String(r.lead_id);
      if (seenLeadIds.has(key)) return false;
      seenLeadIds.add(key);
      return true;
    });
    // SETTLED-STAMP AUTHORITY FIRST (codex P1, PR #3303 r5; pre-push P1
    // r6/r14): a settled stamp targeting a lead OUTSIDE the sid-linked
    // set is the processor's CURRENT verdict for this call — a
    // force-reprocess repointed it after the sid lead(s) lost
    // eligibility, and findReusableCallLead's sid precedence only ever
    // applied to ELIGIBLE leads. This applies regardless of how many
    // leads share the sid: collapsing to the sid row would hide the
    // repoint, and preserving multi-sid ambiguity would starve the
    // transfer reconciliation forever. A stamp AGREEING with a sid lead,
    // or an UNSETTLED stamp twin (a retry that minted before its cleanup
    // ran), falls through to the sid branches — that stamp is either
    // redundant or not yet a verdict.
    const settledStampVerdict = group.find((r) => isStampLinked(r) && callSettled(r));
    if (settledStampVerdict
      && !sidLinked.some((r) => String(r.lead_id) === String(settledStampVerdict.lead_id))) {
      deduped.push(settledStampVerdict);
    } else if (sidLinked.length === 1) deduped.push(sidLinked[0]);
    else if (sidLinked.length > 1) deduped.push(...sidLinked);
    else deduped.push(group[0]);
  }
  return deduped;
}

async function ensureBridgeLeadSource() {
  const existing = await db('lead_sources')
    .where({ name: GOOGLE_ADS_BRIDGE_SOURCE_NAME })
    .first();
  if (existing) return existing;

  // lead_sources.name has no unique index, so the select-then-insert above is a
  // race: concurrent callers — the daily 6:20 cron and a manual admin "apply",
  // or two instances during a Railway deploy overlap — could each miss the row
  // and both insert, creating duplicate "Google Ads - Call Reporting Bridge"
  // sources that split lead attribution across IDs. Serialize creation with a
  // transaction-scoped Postgres advisory lock keyed to the source name and
  // re-check inside the lock; the lock auto-releases on commit/rollback. Every
  // caller funnels through here, so this is the single place the race is closed.
  return db.transaction(async (trx) => {
    await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`lead_source:${GOOGLE_ADS_BRIDGE_SOURCE_NAME}`]);
    const again = await trx('lead_sources')
      .where({ name: GOOGLE_ADS_BRIDGE_SOURCE_NAME })
      .first();
    if (again) return again;

    const [source] = await trx('lead_sources')
      .insert({
        name: GOOGLE_ADS_BRIDGE_SOURCE_NAME,
        source_type: 'google_ads',
        channel: 'paid',
        cost_type: 'paid',
        is_active: true,
        notes: 'Google Ads call reporting bridge for main-line call assets. No phone number is stored here so ordinary 7612 calls do not auto-map to paid.',
        created_at: new Date(),
        updated_at: new Date(),
      })
      .returning('*');
    return source;
  });
}

// The linkage predicate shared by every joined-lead revalidation: the call
// still points at THIS lead, by sid or by the metadata stamp. Applied as a
// correlated EXISTS inside the leads query/update so the check is atomic
// with whatever rides on it — `callLog.leadId` is a snapshot taken before
// the awaited Google Ads scan, and call-processing reconciliation can clear
// or repoint a provisional stamp in that gap (pre-push P1 r1).
function whereCallStillLinked(builder, callLogId) {
  return builder.whereExists(function stillLinked() {
    this.select(db.raw('1'))
      .from('call_log')
      .where('call_log.id', callLogId)
      .andWhere(function linkageArms() {
        this.where(function sidArm() {
          this.whereRaw('call_log.twilio_call_sid = leads.twilio_call_sid')
            // The sid arm YIELDS to a settled dissenting stamp (codex P0,
            // PR #3303 r8): fetchCrmCalls can capture the old sid lead and
            // a force-reprocess commit a settled stamp to a DIFFERENT lead
            // before apply — accepting the sid lead then moves the
            // provenanced funnel row back, or conflict-retires it and
            // deletes booked/completed revenue. Evaluated INSIDE the same
            // correlated EXISTS every write already re-runs under the
            // lead's row lock, so the check is atomic with the write.
            // A stamp that is absent, AGREES, or is not yet settled leaves
            // the sid arm untouched — sid stays authoritative there.
            .andWhere(function noSettledStampDissent() {
              this.whereRaw("COALESCE(call_log.metadata->>'lead_id', '') = ''")
                .orWhereRaw('call_log.metadata->>\'lead_id\' = leads.id::text')
                .orWhereNotNull('call_log.processing_token')
                .orWhereRaw("COALESCE(call_log.processing_status, '') <> 'processed'");
            });
        })
          .orWhere(function settledStampArm() {
            // Only a SETTLED call's stamp is authoritative (pre-push P1
            // r2/r8): settled = token NULL **and** a durable successful
            // pass (processing_status 'processed'). Token nullness alone
            // is not proof — the error path clears the token while the
            // stamp stays pending the extraction_failed retry, which may
            // clear or repoint it. A non-null token means a pass is
            // mid-flight. The sid arm is stable linkage and carries no
            // such condition.
            this.whereRaw("call_log.metadata->>'lead_id' = leads.id::text")
              .whereNull('call_log.processing_token')
              .where('call_log.processing_status', 'processed');
          });
      });
  });
}

// Revalidation for paths that only write the FUNNEL row (no lead
// mutation): the joined lead's live row — with its CURRENT owner — while it
// is still linked to this call; null otherwise. Pass `{ dbc: trx,
// lock: true }` to take the lead's row lock so the check stays valid until
// the caller's transaction releases (pre-push P1 r3).
async function joinedLeadLiveRow(callLog, { dbc = db, lock = false } = {}) {
  if (!callLog?.leadId || !callLog?.id) return null;
  if (lock) {
    // TWO statements, deliberately (pre-push P1 r6): take the row lock
    // first, then re-check linkage in a fresh statement. Combined into
    // one, READ COMMITTED evaluates the call_log EXISTS against the
    // snapshot taken BEFORE this statement blocked on reconciliation's
    // lead lock — returning the lead on the strength of a stamp that was
    // just cleared. The second statement runs with the lock already held,
    // so its snapshot sees reconciliation's committed writes.
    const locked = await dbc('leads')
      .where({ id: callLog.leadId })
      .whereNull('deleted_at')
      .forUpdate()
      .first('id');
    if (!locked) return null;
  }
  const row = await whereCallStillLinked(
    dbc('leads').where({ id: callLog.leadId }).whereNull('deleted_at'),
    callLog.id,
  ).first('id', 'customer_id');
  return row || null;
}

// The JOINED lead (sid- or metadata-stamp-linked in fetchCrmCalls) is
// authoritative when present — findLeadForCall's plan needs a customer link
// or a usable caller phone and returns null for exactly the phone-less
// reused-lead calls the stamp join exists for, so the confirmed Google call
// never repointed its lead and the unclaimed sweep later recorded that paid
// lead as organic (codex P1 ×2, PR #3275 — the first fix covered only the
// already-bridged retry path; the primary ready path is the one that marks
// the call Google Ads). The joined lead's own customer rides along so
// writeCallPpcAttribution can create the funnel row for a lead claimed
// after the call.
//
// Resolution and ATTRIBUTION are one step, inside the CALLER'S transaction
// (`trx` is required): the joined arm first takes the lead's row lock — the
// same lock every stamp writer and the rejection reconciliation take — so
// the linkage check, the lead update, and the caller's durable call_log
// write commit as one unit that reconciliation cannot interleave (pre-push
// P1 r1/r2: the single-statement EXISTS left the later call_log and funnel
// writes attributing a lead whose stamp had just been cleared). The joined
// lead's CURRENT owner — read under the lock — wins over the call's own
// customer link, so a reused lead claimed by a different customer never
// produces a mismatched funnel pair. A stale joined arm falls back to the
// plan; only a match whose live-lead update actually landed is returned.
// Returns { match } on success; { match: null, reason } for skip
// bookkeeping.
// SID-only joins re-apply the processor's OWNERSHIP eligibility (codex P1,
// PR #3303 r7): when a phone-bearing reprocess rejected the original sid
// lead as foreign-owned and reused a phone-matched lead, that path writes
// no stamp — so the next scan joins the obsolete sid lead, and without this
// check the bridge would rewrite ITS source and move another customer's
// paid call onto it. A CONFLICT is the test — the call knows customer A
// while the lead is owned by B. A claimed lead on a customer-less call is
// NOT a conflict and stays eligible (the ordinary call → lead → customer
// progression; codex P2 #3275). Lifecycle terminals stay attributable by
// design: a WON lead is precisely the paid outcome the bridge credits.
// A STAMP-confirmed join is exempt — the stamp IS the processor's verdict.
// Shared by attributeResolvedLead and the already-bridged backfill (codex
// P1 r8: the backfill bypassed it, and source_call_id recovery would then
// transfer the history-bearing row onto the foreign owner).
function sidJoinOwnerConflict(callLog, lockedLead) {
  if (!callLog || !lockedLead) return false;
  const stampConfirmed = callLog.stampedLeadId
    && String(callLog.stampedLeadId) === String(callLog.leadId);
  if (stampConfirmed) return false;
  return !!(lockedLead.customer_id && callLog.customerId
    && String(lockedLead.customer_id) !== String(callLog.customerId));
}

// The owner-conflict test's blind spot (codex P1, PR #3303 r15): an
// ANONYMOUS call repointed from its sid lead to a phone-matched lead
// leaves call_log.customer_id NULL and writes no stamp, so when the
// obsolete sid lead is later claimed there is no owner to conflict with —
// yet the provenanced funnel row on the NEW lead records the repoint.
// Accepting the sid join would let source_call_id recovery transfer that
// history-bearing row back to the obsolete lead. Defer whenever this
// call's attribution already resides on a DIFFERENT lead than the one the
// sid join proposes. Stamp-confirmed joins are exempt (the stamp IS the
// processor's verdict); runs on the caller's transaction, next to
// sidJoinOwnerConflict at both its call sites.
async function sidJoinAttributionElsewhere(trx, callLog) {
  if (!callLog?.id || !callLog?.leadId) return false;
  const stampConfirmed = callLog.stampedLeadId
    && String(callLog.stampedLeadId) === String(callLog.leadId);
  if (stampConfirmed) return false;
  const prov = await trx('ad_service_attribution')
    .where({ source_call_id: callLog.id })
    .first('id', 'lead_id');
  // ORPHANED provenance is NOT "elsewhere" (codex P1 r32): lead_id is ON
  // DELETE SET NULL, so a hard-deleted lead leaves this call's row with a
  // NULL lead_id — String(null) read that as a different lead and returned
  // the conflict before recordCallPpcAttribution could reach
  // reconcileMovedCallAttributionRow's orphan-transfer arm. Only a live,
  // DIFFERENT lead proves a repoint; a NULL orphan proceeds to recovery.
  return !!(prov && prov.lead_id != null && String(prov.lead_id) !== String(callLog.leadId));
}

async function attributeResolvedLead(callLog, bridgeSource, now, trx, { noPlanFallback = false } = {}) {
  let joinedWentStale = false;
  let verdictChecked = false;
  // A settled stamp naming a lead the join could not return (soft-deleted
  // target) means the authoritative linkage is UNAVAILABLE, not absent
  // (codex P1, PR #3303 r7): attribute nothing and never fall to the plan,
  // or the obsolete sid/phone lead would absorb this paid call.
  if (callLog?.stampTargetMissing) {
    // Verdict FIRST, even on this early return (codex P1, PR #3303 r9): a
    // force-reprocess can hold processing_token by now, and the caller
    // reads every non-'call_rejected' miss WITH a recorded lead as a
    // definitive unlink — deleting this call's funnel row and writing the
    // tombstone. If that in-flight pass then fails or lands on a policy
    // hold, booked/completed attribution the processor meant to keep is
    // gone. A mid-flight call reports 'call_rejected', which the caller
    // treats as "touch nothing this scan".
    if (!(await callStillAttributable(trx, callLog.id))) {
      return { match: null, reason: 'call_rejected' };
    }
    return { match: null, reason: 'lead_not_live' };
  }
  if (callLog?.leadId) {
    const lockedLead = await trx('leads')
      .where({ id: callLog.leadId })
      .whereNull('deleted_at')
      .forUpdate()
      .first('id', 'customer_id');
    // Terminal verdict re-checked fresh under the CALL row lock, taken
    // AFTER the lead lock so the leads → call_log order every stamp
    // writer uses is preserved (pre-push P1 r16) — the pre-scan
    // snapshot's noAttribution is not proof against a rejection that
    // committed mid-scan. It runs BEFORE the ownership verdict (codex P1,
    // PR #3303 r9): a mid-flight pass must report 'call_rejected' — which
    // the caller treats as "touch nothing this scan" — rather than an
    // ownership conflict the caller would read as a settled unlink and
    // act on by deleting this call's funnel row.
    if (!(await callStillAttributable(trx, callLog.id))) {
      return { match: null, reason: 'call_rejected' };
    }
    verdictChecked = true;
    if (lockedLead && (sidJoinOwnerConflict(callLog, lockedLead)
      || await sidJoinAttributionElsewhere(trx, callLog))) {
      // Both shapes report the non-retiring conflict reason — the caller
      // touches nothing this scan (only 'linkage_cleared' retires).
      return { match: null, reason: 'lead_owner_conflict' };
    }
    if (lockedLead) {
      const joined = {
        strategy: 'joined_lead',
        leadId: callLog.leadId,
        // The joined lead's CURRENT owner ONLY — an UNCLAIMED lead stays
        // customer-less (codex P1, PR #3303 r2): borrowing the call's own
        // customer link would pair the lead with a customer it does not
        // own; the funnel write declines on a null customer and the
        // unclaimed→organic sweep / claim-time backfill attribute it once
        // the lead is actually claimed.
        customerId: lockedLead.customer_id || null,
      };
      if (await updateLeadAttribution(joined, bridgeSource, now, { linkageCallId: callLog.id, dbc: trx })) {
        return { match: joined };
      }
    }
    joinedWentStale = true;
  }
  // A STALE joined arm never falls back to the plan either (codex P1,
  // PR #3303 r4, extending r2's cleared-trigger rule): when a concurrent
  // reprocess repointed the stamp between the fetch and this lock, the
  // customer/phone plan can re-select the FORMER lead — and through
  // sourceCallId recovery move the freshly transferred history row back
  // or conflict-retire it. The next scan resolves with fresh join state.
  if (noPlanFallback || joinedWentStale) {
    // A STALE joined arm is TRANSIENT — never a clear (codex P0, PR #3303
    // r10): the caller deletes the provenanced row and tombstones the
    // match on a clear, so a concurrent repoint racing this scan would
    // destroy booked/completed revenue. Only the noPlanFallback path can
    // report a clear, and only once the absence is POSITIVELY established
    // under the call row lock: the call is settled, carries no stamp, and
    // no live lead holds its sid. Anything else stays transient and the
    // next scan re-resolves.
    if (joinedWentStale) return { match: null, reason: 'lead_not_live' };
    if (!(await callStillAttributable(trx, callLog.id))) {
      return { match: null, reason: 'call_rejected' };
    }
    const liveCall = await trx('call_log').where({ id: callLog.id }).first('twilio_call_sid', 'metadata', 'from_phone');
    const liveStamp = (() => {
      try {
        const md = typeof liveCall?.metadata === 'string' ? JSON.parse(liveCall.metadata) : (liveCall?.metadata || {});
        return md?.lead_id ? String(md.lead_id) : null;
      } catch { return null; }
    })();
    // A live stamp — resolvable or not — means the linkage is not
    // CLEARED, only unavailable to this scan.
    if (liveStamp || !liveCall) return { match: null, reason: 'lead_not_live' };
    if (liveCall?.twilio_call_sid) {
      const sidLead = await trx('leads')
        .where({ twilio_call_sid: liveCall.twilio_call_sid })
        .whereNull('deleted_at')
        .first('id');
      if (sidLead) return { match: null, reason: 'lead_not_live' };
    }
    // STAMP-LESS PHONE LINKAGE (codex P1 r23) — the third durable mode the
    // stamp and sid arms cannot see. When a force-reprocess moves an
    // already-bridged call from stamped lead A onto phone-matched lead B,
    // the processor clears A's stamp and writes NONE for B (stampThisPass
    // requires !phone) and B keeps its own originating sid, so the two
    // arms above both miss and this returned a CLEAR — tombstoning the
    // joined match and permanently disabling the plan fallback while B was
    // the current linked lead.
    //   1. This call's own provenanced funnel row on a live lead is exact
    //      proof the linkage survives.
    //   2. Otherwise a live lead on the caller's number (RIGHT-10) is
    //      treated as linkage, deliberately BROADER than the processor's
    //      reuse decision: the only cost of a false positive here is
    //      staying transient one more scan, while a false CLEAR deletes
    //      the provenanced row and tombstones the match irreversibly.
    //      Any-doubt-waits, the same ladder the ambiguity exclusion uses.
    const provenancedLive = await trx('ad_service_attribution as a')
      .join('leads as l', 'l.id', 'a.lead_id')
      .where('a.source_call_id', callLog.id)
      .whereNull('l.deleted_at')
      .first('a.id');
    if (provenancedLive) return { match: null, reason: 'lead_not_live' };
    const callerTen = String(liveCall.from_phone || '').replace(/\D/g, '').slice(-10);
    if (callerTen.length === 10) {
      const phoneLead = await trx('leads')
        .whereNull('deleted_at')
        .whereRaw("RIGHT(regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g'), 10) = ?", [callerTen])
        .first('id');
      if (phoneLead) return { match: null, reason: 'lead_not_live' };
    }
    return { match: null, reason: 'linkage_cleared' };
  }
  // Plan-only flow: no lead is locked yet, so the call-row check runs
  // first — a rare call_log → leads inversion against a concurrent
  // stamped rejection; PostgreSQL resolves the deadlock by aborting one
  // side and both callers land in retry lanes.
  if (!verdictChecked && !(await callStillAttributable(trx, callLog.id))) {
    return { match: null, reason: 'call_rejected' };
  }
  const planned = await findLeadForCall(callLog, { dbc: trx });
  if (!planned?.leadId) {
    return { match: null, reason: joinedWentStale ? 'lead_not_live' : 'lead_not_found' };
  }
  if (!await updateLeadAttribution(planned, bridgeSource, now, { dbc: trx })) {
    return { match: null, reason: 'lead_not_live' };
  }
  // The landed update holds the row exclusively for the rest of this
  // transaction — re-read the owner on the same connection so the funnel
  // pair carries the lead's CURRENT customer, not the plan's unlocked
  // snapshot (same rule as the joined arm; pre-push P1 r2/r5).
  // The LOCKED owner is exact — never fall back to the plan's pre-lock
  // snapshot (pre-push P1 r6): a lead unassigned while we waited has a
  // live owner of NULL, and restoring the former customer would mint a
  // permanently mismatched lead/customer funnel pair.
  const plannedOwner = await trx('leads').where({ id: planned.leadId }).first('customer_id');
  return { match: { ...planned, customerId: plannedOwner?.customer_id || null } };
}

// ONE definition of the plan's matching predicate, used by the resolver AND
// re-applied atomically inside the attribution UPDATE (pre-push P1 r7): the
// lead's customer, phone, or contact time can change between resolution and
// the write, and a lead that no longer matches the call must not be
// attributed. The match object carries the plan fields, so the write-time
// recheck needs no second lookup.
function applyLeadPlanPredicates(query, plan) {
  let q = query;
  if (plan.strategy === 'customer_id') {
    q = q.where({ customer_id: plan.customerId });
  } else {
    q = q.whereRaw(
      "RIGHT(REGEXP_REPLACE(COALESCE(phone, ''), '[^0-9]', '', 'g'), 10) = ?",
      [plan.phoneLast10],
    );
  }
  return q
    .where('first_contact_at', '>=', plan.startAt)
    .where('first_contact_at', '<=', plan.endAt);
}

async function findLeadForCall(callLog, { dbc = db } = {}) {
  const plan = leadMatchPlan(callLog);
  if (!plan) return null;

  const lead = await applyLeadPlanPredicates(
    dbc('leads').select('id', 'customer_id').whereNull('deleted_at'),
    plan,
  )
    .orderByRaw('ABS(EXTRACT(EPOCH FROM (first_contact_at - ?::timestamptz))) ASC', [plan.callAt])
    .orderBy('created_at', 'desc')
    .first();
  // A phone-matched plan has no customerId; surface the matched lead's so PPC
  // attribution can run even when the call_log row isn't customer-linked.
  return lead?.id ? { ...plan, leadId: lead.id, customerId: plan.customerId || lead.customer_id || null } : null;
}

// Reconcile the funnel row THIS call created when its attribution moves
// (codex P1, PR #3303) — identified by EXACT provenance
// (ad_service_attribution.source_call_id), never a heuristic that could hit
// a same-day row another paid call legitimately owns or miss a row
// lead-funnel-bridge advanced past funnel_stage='lead'. TRANSFERRED to the
// new lead when that slot is free (funnel stage and metrics ride along),
// retired when the new lead already owns a row or the link cleared
// entirely. Pre-provenance rows (NULL source_call_id, written before the
// column shipped or by writers without call identity) are PERMANENTLY left
// alone — NULL provenance cannot prove ownership, and claiming such a row
// could move another call's first-touch attribution (codex P1 r2). The
// transfer carries the new lead's CURRENT customer (read under the lead
// lock by the caller) so the row never pairs the new lead with the former
// lead's customer.
// The shared transfer/retire primitive lives in call-attribution
// (reconcileMovedCallAttributionRow) — the processor's stamp settles use
// the SAME definition. This wrapper only fixes the argument shape the
// bridge call sites use.
async function reconcileMovedCallAttribution(trx, callLogId, recordedLeadId, newLeadId, newCustomerId, now) {
  return require('./call-attribution').reconcileMovedCallAttributionRow(
    trx, callLogId, recordedLeadId, newLeadId, now, { toCustomerId: newCustomerId },
  );
}

async function updateLeadAttribution(leadMatch, bridgeSource, now, { linkageCallId = null, dbc = db } = {}) {
  if (!leadMatch?.leadId) return false;
  // Live-lead check happens HERE, at write time, not only in the fetch join
  // (codex P2, PR #3275): previewBridge awaits the Google Ads scan between
  // fetchCrmCalls and apply, and a lead soft-deleted in that gap would
  // otherwise be updated and stamped as this call's match — blocking later
  // retries from resolving a live replacement. findLeadForCall enforces the
  // same predicate; the joined shortcut now matches it. A zero-row update
  // reports false so the caller does not record a bridge match.
  // With `linkageCallId` (the joined-lead arm), the sid/stamp linkage is
  // revalidated ATOMICALLY with the write via the correlated EXISTS —
  // never from the pre-scan snapshot (pre-push P1 r1).
  // A PLAN-resolved match re-applies its own matching predicate here
  // (pre-push P1 r7) — the match object carries the plan fields — so a
  // lead whose customer/phone/contact time changed since resolution
  // writes zero rows instead of being attributed anyway.
  let query = dbc('leads')
    .where({ id: leadMatch.leadId })
    .whereNull('deleted_at');
  if (linkageCallId) query = whereCallStillLinked(query, linkageCallId);
  else if (leadMatch.strategy && leadMatch.strategy !== 'joined_lead') query = applyLeadPlanPredicates(query, leadMatch);
  const updated = await query.update({
    lead_source_id: bridgeSource.id,
    updated_at: now,
  });
  return !!updated;
}

function summarize(matches, crmCalls) {
  return {
    googleCalls: matches.length,
    // DISTINCT calls, not join rows (codex P2, PR #3303): preserved
    // shared-sid ambiguity keeps multiple rows for one call, and the
    // scheduler reads a value >= 500 as the fetch subquery's cap being
    // hit — 499 distinct calls plus one ambiguity twin must not block
    // the unclaimed→organic sweep.
    crmMainLineCalls: new Set(crmCalls.map((call) => String(call.id))).size,
    ready: matches.filter((m) => m.status === 'ready').length,
    alreadyBridged: matches.filter((m) => m.status === 'already_bridged').length,
    ambiguous: matches.filter((m) => m.status === 'ambiguous').length,
    unmatched: matches.filter((m) => m.status === 'unmatched').length,
  };
}

async function previewBridge(options = {}) {
  const days = Math.min(Math.max(parseInt(options.days, 10) || 30, 1), 90);
  const limit = Math.min(Math.max(parseInt(options.limit, 10) || 200, 1), 500);
  const googleAds = getGoogleAds();
  const configured = googleAds.isConfigured();
  const target = mainLine();
  const crmCalls = await fetchCrmCalls(days);
  // strict fetch: an API failure must surface as scanFailed, not as an empty
  // call list — the cron's unclaimed→organic fallback treats "bridge saw
  // nothing to claim" as license to attribute, which is only true when the
  // scan actually ran. Unconfigured stays a plain empty scan (configured:false
  // already tells that story).
  let scanFailed = false;
  let googleRows = [];
  if (configured) {
    try {
      googleRows = await googleAds.fetchCallViews(days, limit, { strict: true });
    } catch (err) {
      scanFailed = true;
      logger.error(`[google-call-bridge] Google call-report scan FAILED — no matches this run: ${err.message}`);
    }
  }
  const googleCalls = googleRows.map(normalizeGoogleCallRow).filter((row) => row.resourceName);
  const matches = buildMatches(googleCalls, crmCalls, target.number);

  return {
    configured,
    scanFailed,
    period: { days, limit },
    targetNumber: target,
    sourceName: GOOGLE_ADS_BRIDGE_SOURCE_NAME,
    summary: summarize(matches, crmCalls),
    matches,
    recentMainLineCalls: crmCalls.slice(0, 20).map(shapeCallLog),
  };
}

async function applyBridge(options = {}) {
  // DB clock, captured BEFORE the scan reads anything: rescan_clear may
  // only resolve records not re-reported since the scan started
  // (last_seen_at < scanStartedAt), and last_seen_at is written by the DB
  // clock, so the boundary must come from the same clock.
  const scanStartedAt = (await db.raw('SELECT now() AS db_now')).rows[0].db_now;
  const preview = await previewBridge(options);
  const now = new Date();
  const sourceNeeded = preview.matches.some((match) => (
    (match.status === 'ready' || shouldRetryLeadAttribution(match)) && match.callLog?.id
  ));
  const bridgeSource = sourceNeeded ? await ensureBridgeLeadSource() : null;
  const applied = [];
  const skipped = [];

  // Idempotent PPC-funnel write (ad_service_attribution) for a confirmed Google
  // Ads call. Used by both the fresh-bridge path and the already-bridged path so
  // calls bridged BEFORE this shipped (and lead-retry calls) also land in the
  // funnel. customerId may come from a freshly-matched lead or the call_log.
  const writeCallPpcAttribution = async (match, customerId, leadId, trx) => {
    // Require an actual lead — a confirmed Google Ads call from an EXISTING
    // customer that matched no lead (e.g. a service/support call) must not be
    // counted as a new PPC lead. Mirrors the lead-creation gate in
    // call-recording-processor (LEAD_PIPELINE_STAGES).
    if (!customerId || !leadId) return;
    // `trx` is the caller's lead-locking transaction — the funnel insert's
    // lead_id FK check takes FOR KEY SHARE on the locked lead row, so it
    // MUST ride the same connection or it self-deadlocks behind our own
    // FOR UPDATE (pre-push P1 r4).
    const result = await require('./call-attribution').recordCallPpcAttribution({
      customerId,
      leadId: leadId || null,
      leadSource: 'google_ads',
      leadSourceDetail: match.googleCall.campaignName || GOOGLE_ADS_BRIDGE_SOURCE_NAME,
      googleCampaignId: match.googleCall.campaignId,
      leadDate: match.callLog?.createdAt || null, // date by the actual call, not this run
      sourceCallId: match.callLog?.id || null,
      dbc: trx,
    });
    // recordCallPpcAttribution CATCHES its own SQL errors and returns
    // { reason: 'error' } — but a failed statement has already put this
    // transaction in aborted state, and PostgreSQL turns the COMMIT into
    // a silent ROLLBACK without a protocol error. Swallowing it here
    // would record the match as applied while every write in the round
    // was rolled back — and the scheduler's irreversible
    // unclaimed→organic sweep could then run against a paid lead the
    // bridge believes it attributed (pre-push P1 r5). Throw so the
    // transaction visibly fails into the caller's skip/error handling;
    // declined outcomes (other_source / web_attributed /
    // already_recorded / no_lead) are clean returns and roll nothing
    // back.
    if (result?.reason === 'error') {
      throw new Error(`PPC attribution failed: ${result.error || 'unknown'}`);
    }
  };

  for (const match of preview.matches) {
    if (match.status === 'already_bridged') {
      // Only attribute when the CRM call is bridged to THIS Google call. A call
      // can score 'already_bridged' off a resource_name linked to a DIFFERENT
      // nearby Google call, and using this match.googleCall's campaign then would
      // mis-attribute. (PPC write only — lead-attribution retry is campaign-
      // agnostic and still runs.)
      const bridgedToThisCall = !!match.callLog?.googleAdsCallResourceName
        && match.callLog.googleAdsCallResourceName === match.googleCall.resourceName;

      if (!shouldRetryLeadAttribution(match)) {
        if (bridgedToThisCall && !match.callLog?.noAttribution) {
          // Backfill the funnel row for calls bridged before this shipped (idempotent).
          // call_log.lead_id is only populated by the twilio_call_sid join; a call
          // lead-matched by phone/customer (recorded in metadata) has it null, so
          // resolve the lead in that case before attributing.
          // Same snapshot-staleness rule as the attribution paths (pre-push
          // P1 r1/r2/r3): the joined lead only feeds the funnel row while
          // it is still live AND still linked to this call — revalidated
          // UNDER THE LEAD'S ROW LOCK, held until the funnel write
          // commits on the SAME connection (pre-push P1 r4: the FK check
          // takes FOR KEY SHARE on the locked lead, so a second
          // connection self-deadlocks), and reconciliation queues on this
          // lock so the verified linkage cannot be cleared in between.
          // Its CURRENT owner wins over the call's own customer link.
          // Otherwise drop to the plan. Best-effort at the BLOCK level:
          // a failure rolls back only this backfill and is logged.
          try {
            await db.transaction(async (trx) => {
              // Unavailable stamp target (soft-deleted): attribute nothing
              // this scan — same rule as attributeResolvedLead (codex P1,
              // PR #3303 r7).
              if (match.callLog?.stampTargetMissing) return;
              let backfillLeadId = match.callLog?.leadId || null;
              let backfillCustomerId = null;
              if (backfillLeadId) {
                const liveJoined = await joinedLeadLiveRow(match.callLog, { dbc: trx, lock: true });
                // Fresh verdict under the call row lock, AFTER the lead
                // lock (leads → call_log order; pre-push P1 r16) — a
                // rejection committing after the scan must win.
                if (!(await callStillAttributable(trx, match.callLog.id))) return;
                if (liveJoined) {
                  // The SAME unstamped-sid ownership test the resolver
                  // applies (codex P1, PR #3303 r8) — this non-retry
                  // backfill bypassed it, and source_call_id recovery
                  // would then hand the history-bearing funnel row to a
                  // foreign owner.
                  if (sidJoinOwnerConflict(match.callLog, liveJoined)
                    || await sidJoinAttributionElsewhere(trx, match.callLog)) return;
                  // The joined lead's CURRENT owner ONLY — an unclaimed
                  // lead stays customer-less and the funnel write
                  // declines (codex P1, PR #3303 r2); never the call's
                  // own customer link.
                  backfillCustomerId = liveJoined.customer_id || null;
                } else {
                  // A STALE joined arm never falls through to the plan
                  // (codex P1, PR #3303 r5, matching attributeResolvedLead):
                  // a concurrent repoint would be undone by plan-matching
                  // the FORMER lead and moving the provenanced history row
                  // back. The next scan resolves with fresh join state.
                  return;
                }
              }
              if (!backfillLeadId) {
                // Plan-only flow (or joined lead gone): verify the verdict
                // fresh here too when the joined arm didn't already —
                // rare call_log-first inversion, PostgreSQL-resolved.
                if (!match.callLog?.leadId && !(await callStillAttributable(trx, match.callLog.id))) return;
                // The plan fallback resolves on the global connection —
                // lock and revalidate the selected lead INSIDE this
                // transaction before it feeds the funnel (pre-push P1 r5):
                // live-ness and the CURRENT owner are read under the row
                // lock, so a concurrent soft-delete or customer
                // reassignment can't produce a stale attribution pair.
                // The PERSISTED match wins over a fresh plan lookup (codex
                // P1, PR #3303 r7): shouldRetryLeadAttribution deliberately
                // leaves plan-strategy matches in the NON-retry branch, so
                // this backfill must not silently re-resolve. A new lead
                // closer to the call timestamp would otherwise win the
                // 6-hour-window plan lookup and — through source_call_id
                // recovery — take the history-bearing funnel row, while
                // metadata.leadMatch still named the old lead and the new
                // one never received the bridge source. The persisted lead
                // needs no plan-predicate re-check: it IS the durable
                // decision, not a re-resolution — only liveness and its
                // current owner are read under the lock. A persisted
                // JOINED match with no live join is the cleared-link case
                // (or its tombstone), which the retry branch owns.
                const persistedLeadId = match.callLog?.googleAdsLeadMatchedLeadId || null;
                const persistedStrategy = match.callLog?.googleAdsLeadMatchedStrategy || null;
                if (persistedStrategy === 'joined_lead') return;
                if (persistedLeadId) {
                  const lockedPersisted = await trx('leads')
                    .where({ id: persistedLeadId })
                    .whereNull('deleted_at')
                    .forUpdate()
                    .first('id', 'customer_id');
                  if (!lockedPersisted) return;
                  backfillLeadId = persistedLeadId;
                  backfillCustomerId = lockedPersisted.customer_id || null;
                }
                const lm = backfillLeadId
                  ? null
                  : await findLeadForCall(match.callLog, { dbc: trx }).catch(() => null);
                if (lm?.leadId) {
                  const lockedFallback = await trx('leads')
                    .where({ id: lm.leadId })
                    .whereNull('deleted_at')
                    .forUpdate()
                    .first('id', 'customer_id');
                  // Lock, THEN re-check the plan predicate as a second
                  // statement (same two-statement rule as the linkage
                  // check; pre-push P1 r6/r7) — a lead whose matching
                  // fields changed while we waited must not feed the
                  // funnel.
                  const stillMatches = lockedFallback && await applyLeadPlanPredicates(
                    trx('leads').where({ id: lm.leadId }).whereNull('deleted_at'),
                    lm,
                  ).first('id');
                  if (stillMatches) {
                    backfillLeadId = lm.leadId;
                    // Locked owner EXACTLY — no pre-lock fallback (pre-push
                    // P1 r6): an unassigned-while-waiting lead's live owner
                    // is NULL, and the plan snapshot would resurrect the
                    // former customer into a mismatched funnel pair.
                    backfillCustomerId = lockedFallback.customer_id || null;
                  }
                }
              }
              await writeCallPpcAttribution(match, backfillCustomerId, backfillLeadId, trx);
            });
          } catch (backfillErr) {
            logger.warn(`[google-call-bridge] PPC attribution backfill failed: ${backfillErr.message}`);
          }
        }
        skipped.push({ ...match, skipReason: 'already_bridged' });
        continue;
      }

      try {
        // Resolution + attribution + the durable call_log record commit as
        // ONE transaction under the lead's row lock (pre-push P1 r1/r2): a
        // stale or soft-deleted joined lead falls back to the plan, only a
        // landed update proceeds, and stamp reconciliation cannot
        // interleave between the lead write and the call record. Not a
        // write_failed on skip: the retry lane re-evaluates next pass.
        const recordedLeadId = match.callLog.googleAdsLeadMatchedLeadId || null;
        // A retry triggered by a CLEARED joined stamp must not re-resolve
        // by plan — the deliberate clear would be rewritten as a plan
        // match and the cleared-link reconciliation below would never run
        // (codex P1, PR #3303 r2). Covers BOTH a live recorded joined
        // match whose join vanished this scan AND the persisted clear
        // TOMBSTONE from a prior scan (leadId null, strategy retained —
        // pre-push P1 r7): without the tombstone arm, a cleared call
        // retried as never-attributed and plan matching could reselect
        // the former lead, recreating the attribution the clear retired.
        // Repoints (joined lead present) and plain unmatched retries keep
        // the plan fallback.
        const clearedJoinedTrigger = !match.callLog.leadId
          && match.callLog.googleAdsLeadMatchedStrategy === 'joined_lead';
        const attribution = await db.transaction(async (trx) => {
          const res = await attributeResolvedLead(match.callLog, bridgeSource, now, trx, { noPlanFallback: clearedJoinedTrigger });
          if (!res.match) {
            // 'call_rejected' is NOT a cleared linkage (pre-push P0 r19):
            // it covers a MID-FLIGHT pass — whose provisional stamp state
            // must not be read as a settled unlink while the pass could
            // still fail — and settled terminal rejections, whose retire
            // the processor already committed atomically with the verdict.
            // Either way this scan touches nothing; the retry lane
            // re-evaluates once the call settles.
            if (res.reason === 'call_rejected') return res;
            // ONLY a POSITIVELY established clear may retire history
            // (codex P0, PR #3303 r10): 'lead_not_live' and
            // 'lead_not_found' also cover transient stale-join and
            // pre-lock states, and treating them as definitive deleted
            // booked/completed revenue on a concurrent repoint.
            if (res.reason !== 'linkage_cleared') return res;
            // Recorded match with NO resolvable lead — the CLEARED-link
            // case (codex P1, PR #3303): retire this call's own funnel row
            // (exact provenance) and clear the recorded match, so the
            // bridge stops asserting an attribution its linkage no longer
            // supports and a future re-link can attribute cleanly. The
            // google call itself stays bridged.
            if (recordedLeadId) {
              await reconcileMovedCallAttribution(trx, match.callLog.id, recordedLeadId, null, null, now);
              await trx('call_log')
                .where({ id: match.callLog.id })
                .update({
                  // TOMBSTONE, not erasure (pre-push P1 r7): leadId null
                  // keeps googleAdsLeadMatched false so a future re-link
                  // can still attribute cleanly, while the retained
                  // joined_lead strategy keeps every retry of this call
                  // on noPlanFallback — erasing the match entirely let
                  // plan matching reselect the former lead and recreate
                  // the attribution this branch just retired.
                  metadata: bridgeMetadataPatch({ leadMatch: { leadId: null, strategy: 'joined_lead' }, leadAttributedAt: null }),
                  updated_at: now,
                });
              return { match: null, cleared: true };
            }
            return res;
          }
          // Stamp REPOINTED since the recorded match (codex P1, PR #3303):
          // this call's paid funnel row moves with it — transferred or
          // retired by EXACT provenance (source_call_id), never a
          // heuristic. The old lead's lead_source_id is left as-is: the
          // prior value was never recorded, and guessing would corrupt
          // real attribution.
          let reconcileOutcome = 'none';
          let unprovenancedStrandedRow = false;
          if (recordedLeadId && String(recordedLeadId) !== String(res.match.leadId)) {
            reconcileOutcome = await reconcileMovedCallAttribution(trx, match.callLog.id, recordedLeadId, res.match.leadId, res.match.customerId, now);
            // A LEGACY row on the recorded lead cannot be reconciled —
            // NULL provenance is permanently frozen (another call may own
            // it), so the move reports 'none' with the old row still in
            // place. Writing a fresh provenanced row for the target would
            // DOUBLE-COUNT this call across two leads (codex P1, PR #3303
            // r10). Suppress the write and leave both the legacy row and
            // the recorded match for an operator to resolve.
            if (reconcileOutcome === 'none') {
              const stranded = await trx('ad_service_attribution')
                .where({ lead_id: recordedLeadId })
                .whereNull('source_call_id')
                .first('id');
              unprovenancedStrandedRow = !!stranded;
              if (unprovenancedStrandedRow) {
                logger.warn(`[google-call-bridge] repoint of call ${match.callLog.id} left a legacy unprovenanced row on lead ${recordedLeadId} — funnel write suppressed to avoid double-counting`);
              }
            }
          }
          // The recorded match is NOT advanced when a legacy row blocked
          // the transfer (codex P1, PR #3303 r11): rewriting it to the new
          // lead would make the next scan see recorded == joined, exit the
          // retry lane, and leave the old lead's row stranded with the new
          // lead unattributed — permanently. Leaving it stale keeps the
          // repoint in the retry lane, so every scan re-detects it (and
          // re-warns), and the transfer completes on its own the moment
          // the legacy row is resolved.
          if (!unprovenancedStrandedRow) {
            await trx('call_log')
              .where({ id: match.callLog.id })
              .update({
                metadata: bridgeMetadataPatch({
                  leadMatch: redactedLeadMatch(res.match),
                  leadAttributedAt: now.toISOString(),
                }),
                updated_at: now,
              });
          }
          // Funnel write while the lead lock is still held, on the SAME
          // connection (pre-push P1 r3/r4): reconciliation queues on this
          // lock, so the verified linkage cannot be cleared before the
          // funnel row lands — and the FK check's FOR KEY SHARE on the
          // locked lead must not come from a second connection. A funnel
          // SQL failure rolls the round back to the retry lane. SKIPPED
          // after a conflict-retire (codex P1, PR #3303 r2): the target
          // lead's existing row belongs to a DIFFERENT call, and this
          // write would backfill campaign/detail/service onto it. The
          // customer is the match's own resolved owner — never the call's
          // customer link, which a lead does not necessarily own.
          if (bridgedToThisCall && reconcileOutcome !== 'retired_conflict' && !unprovenancedStrandedRow) {
            await writeCallPpcAttribution(match, res.match.customerId || null, res.match.leadId, trx);
          }
          return res;
        });
        if (attribution.cleared) {
          applied.push({ ...match, status: 'lead_attribution_cleared' });
          continue;
        }
        const leadMatch = attribution.match;
        if (!leadMatch) {
          skipped.push({ ...match, skipReason: attribution.reason });
          continue;
        }

        applied.push({ ...match, status: 'lead_attribution_retried' });
      } catch (err) {
        logger.error(`[google-call-bridge] Failed to retry lead attribution ${match.googleCall.resourceName}: ${err.message}`);
        skipped.push({ ...match, skipReason: 'lead_retry_failed', error: err.message });
      }
      continue;
    }
    if (match.status !== 'ready' || !match.callLog?.id) {
      skipped.push({ ...match, skipReason: match.status });
      continue;
    }

    try {
      const bridgePayload = {
        resourceName: match.googleCall.resourceName,
        campaignId: match.googleCall.campaignId,
        campaignName: match.googleCall.campaignName,
        adGroupId: match.googleCall.adGroupId,
        adGroupName: match.googleCall.adGroupName,
        confidence: match.confidence,
        reasons: match.reasons,
        bridgedAt: now.toISOString(),
      };
      // The google call is confirmed either way; only the LEAD attribution
      // is conditional. Resolution + attribution + the bridge confirm
      // commit as ONE transaction under the lead's row lock (pre-push P1
      // r1/r2) — a lead soft-deleted or unlinked between fetch and apply
      // writes zero rows and is NEVER recorded, and stamp reconciliation
      // cannot interleave between the lead write and the call record.
      await db.transaction(async (trx) => {
        // A terminal no-attribution verdict skips lead attribution and the
        // funnel entirely (codex P1, PR #3303) — the google call itself
        // still bridges, so the ads-side record stays accurate.
        const { match: attributed } = match.callLog?.noAttribution
          ? { match: null }
          : await attributeResolvedLead(match.callLog, bridgeSource, now, trx);
        if (attributed) {
          bridgePayload.leadMatch = redactedLeadMatch(attributed);
          bridgePayload.leadAttributedAt = now.toISOString();
        }
        await trx('call_log')
          .where({ id: match.callLog.id })
          .update({
            source: 'google_ads',
            google_ads_call_resource_name: match.googleCall.resourceName,
            google_ads_call_started_at: match.googleCall.startAt,
            google_ads_call_duration_seconds: match.googleCall.durationSeconds,
            google_ads_call_status: match.googleCall.callStatus,
            google_ads_bridge_confidence: match.confidence,
            google_ads_bridged_at: now,
            metadata: bridgeMetadataPatch(bridgePayload),
            updated_at: now,
          });
        // Surface this confirmed Google Ads call in the PPC funnel
        // (ad_service_attribution), tagged with the campaign Google
        // reported, so phone leads stop being invisible to PPC ROI.
        // Idempotent; best-effort (the wrapper swallows its own errors).
        // Only an ATTRIBUTED lead reaches the funnel row (pre-push P1 r1):
        // the snapshot leadId could belong to a lead whose update just
        // wrote zero rows — a permanent funnel row for a deleted lead that
        // later double-counts when retry finds the live replacement. The
        // call's own customer link stands on its own either way. Written
        // while the lead lock is still held, on the SAME connection
        // (pre-push P1 r3/r4): the verified linkage cannot be cleared
        // before the row lands, and the FK check's FOR KEY SHARE on the
        // locked lead must not come from a second connection. A funnel
        // SQL failure rolls this bridge write back to write_failed and
        // the next run re-applies it.
        // The customer is the match's own resolved owner — never the
        // call's customer link (codex P1, PR #3303 r2): an UNCLAIMED
        // joined lead stays customer-less and the write declines; the
        // unclaimed sweep / claim-time backfill attribute it once the
        // lead is actually claimed.
        await writeCallPpcAttribution(
          match,
          attributed?.customerId || null,
          attributed?.leadId || null,
          trx,
        );
      });

      applied.push(match);
    } catch (err) {
      logger.error(`[google-call-bridge] Failed to bridge ${match.googleCall.resourceName}: ${err.message}`);
      skipped.push({ ...match, skipReason: 'write_failed', error: err.message });
    }
  }

  // Persist this scan's AMBIGUOUS candidates HERE, on EVERY apply path
  // (codex P1, ambiguity-record r2): the admin manual apply supports
  // 31–90-day scans whose candidates the fixed 30-day scheduler scan can
  // never rediscover — recording only in the cron let a manual run's
  // strong ambiguous paid evidence evaporate before the next organic
  // fallback. Read from `ambiguousCandidates` — the COMPLETE qualifying
  // set (codex P1, PR #3303 r23): `alternatives` is a display preview
  // capped at two; the preview stays the fallback for match shapes that
  // predate the field. Errors PROPAGATE: in the cron they land in
  // bridgePairError (which also skips the organic sweep), in the manual
  // route they fail the request — never report an applied bridge whose
  // ambiguity record silently failed.
  const ambiguousCandidates = skipped
    .filter((m) => m?.skipReason === 'ambiguous')
    .flatMap((m) => ((m.ambiguousCandidates || []).length
      ? m.ambiguousCandidates
      : [m.callLog, ...(m.alternatives || []).map((a) => a?.callLog)]))
    .filter(Boolean);
  await recordAmbiguousBridgeCalls(ambiguousCandidates);
  const ambiguousCandidateCallIds = [...new Set(ambiguousCandidates.map((c) => c.id).filter(Boolean).map(String))];

  // Resolution rides EVERY apply path too (codex P1, ambiguity-record r3
  // GH round): a 31–90-day manual apply can record an ambiguity the fixed
  // ~29-day cron window will never reach again, so cron-only resolution
  // left it open FOREVER even after a later trusted manual rescan covering
  // the call found it clean. This scan knows its own trust (scan health,
  // row cap, write failures) and its own window coverage — the exact
  // inputs the resolver needs — and the day's candidate ids plus the
  // scanStartedAt freshness gate keep it from clearing anything this or a
  // concurrent scan still reports.
  const scanDays = preview.period?.days || 30;
  const scanLimit = preview.period?.limit || 200;
  // Each side compares against ITS OWN cap (codex P1, r5 GH round): the
  // Google fetch is bounded by the caller's limit option, the CRM fetch by
  // the fixed CRM_FETCH_LIMIT — comparing CRM rows to the (default 200)
  // Google limit read healthy scans as capped and left old records
  // permanently unclearable.
  const capHit = (preview.summary?.googleCalls || 0) >= scanLimit
    || (preview.summary?.crmMainLineCalls || 0) >= CRM_FETCH_LIMIT;
  const writeFailed = skipped.some((m) => m?.skipReason === 'write_failed' || m?.skipReason === 'lead_retry_failed');
  await resolveAmbiguousBridgeCalls({
    ambiguousCallIds: ambiguousCandidateCallIds,
    scanWindowStart: new Date(Date.now() - (scanDays - 1) * 24 * 60 * 60 * 1000),
    scanStartedAt,
    // configured is part of trust (codex P2, r4 GH round): an apply while
    // Google Ads is unconfigured runs NO scan (configured:false,
    // scanFailed:false, empty matches) — absence of ambiguity from a scan
    // that never ran must not rescan-clear anything. The scheduler treats
    // unconfigured as uncertainty; this path now does too.
    rescanTrusted: !!preview.configured && !preview.scanFailed && !capHit && !writeFailed,
  });

  return {
    ...preview,
    appliedCount: applied.length,
    skippedCount: skipped.length,
    applied,
    skipped,
    // The day's fresh candidate ids — the cron feeds these to the phone
    // exclusion arm (fresh-only; persisted holds take the durable arms).
    ambiguousCandidateCallIds,
  };
}

// Is this phone number the Google Ads call-bridge target line? That number is
// SHARED — organic hub/city-page calls AND paid Google call-extension calls both
// land on it, and the bridge resolves paid vs organic AFTER the fact. Callers use
// this to avoid pre-attributing that one number (which would lock the funnel row
// before the bridge can mark the call paid). Config-driven via mainLine() so it
// tracks GOOGLE_ADS_BRIDGE_LOCATION_ID; returns false when the target isn't
// configured (no bridge ⇒ nothing to protect).
function isBridgeTargetNumber(phone) {
  if (!phone) return false;
  try {
    const target = normalizePhone(mainLine().number);
    return !!target && normalizePhone(phone) === target;
  } catch { return false; }
}

// ---------------------------------------------------------------------------
// Persisted ambiguity records (owner ruling 2026-08-11, closing the GH-r24
// P1 on PR #3303). The day's ambiguous candidate set used to be the ONLY
// record of ambiguity, rebuilt each morning from the fixed 30-day scan —
// the day a candidate aged past the window the exclusion evaporated and the
// organic sweep stamped its lead with the irreversible organic label. These
// three functions make the hold durable: record on every scan, resolve only
// on POSITIVE evidence, and feed the organic exclusions from ALL open rows.
// ---------------------------------------------------------------------------

// The phone-linkage snapshot INSERT — ONE definition shared by the record
// path and the pre-sweep refresh (codex P1, ambiguity-record r6 GH round).
// Insert-only and idempotent; the temporal bound reads the call's CURRENT
// processing evidence, so re-running it after a later pass picks up leads
// that pass linked.
function insertPhoneLinkageSnapshot(dbc, callIds) {
  return dbc.raw(
    `INSERT INTO bridge_ambiguous_call_leads (call_log_id, lead_id)
     SELECT cl.id, l.id
       FROM call_log cl
       JOIN leads l
         ON LENGTH(regexp_replace(COALESCE(l.phone, ''), '[^0-9]', '', 'g')) >= 10
        AND RIGHT(regexp_replace(COALESCE(cl.from_phone, ''), '[^0-9]', '', 'g'), 10)
          = RIGHT(regexp_replace(COALESCE(l.phone, ''), '[^0-9]', '', 'g'), 10)
        AND l.created_at < COALESCE(cl.processing_started_at + interval '10 minutes', cl.created_at + make_interval(secs => ?))
      WHERE cl.id IN (${callIds.map(() => '?').join(', ')})
     ON CONFLICT DO NOTHING`,
    [CALL_EXTRACTION_RETRY_WINDOW_MS / 1000, ...callIds],
  );
}

// Upsert a scan's ambiguous candidate calls. A repeat refreshes
// last_seen_at; a candidate that was previously RESOLVED re-opens — today's
// scan saying "ambiguous" supersedes any older resolution.
async function recordAmbiguousBridgeCalls(candidates = []) {
  const byId = new Map();
  for (const c of candidates) {
    if (!c?.id) continue;
    if (!byId.has(String(c.id))) {
      byId.set(String(c.id), {
        call_log_id: c.id,
        twilio_call_sid: c.twilioCallSid || null,
      });
    }
  }
  const rows = [...byId.values()];
  if (!rows.length) return 0;
  // A REOPEN is evidence WITHDRAWN, not just a hold re-armed (codex P1,
  // ambiguity-record r2): a rescan_clear lifts the hold and the same
  // tick's organic sweep can write the linked lead's irreversible organic
  // row — if the ambiguity then returns, the re-armed hold cannot repair
  // that row on its own (recordCallPpcAttribution dedupes by lead and
  // refuses a different existing source). Detect reopens BEFORE the
  // upsert and retire the rows provenanced to those calls. Bridge-target
  // calls are excluded from call-time attribution AND claim-time backfill,
  // so a row carrying such a call's provenance can only be the sweep's own
  // write — and the shared retire primitive preserves any accumulated
  // history (reassign-else-demote). The re-held lead re-attributes when
  // the ambiguity genuinely resolves.
  //
  // ONE transaction for the whole lifecycle write (pre-push audit P1 r3):
  // the reopen check, the upsert, the phone-linkage snapshot, and the
  // interim-row retirement were separate autocommit statements, so a
  // concurrent resolve could land between the reopen SELECT and the
  // upsert — the record re-opened, but the interim organic row written in
  // that gap was never retired. The existing records are locked FOR
  // UPDATE first, which serializes this against
  // resolveAmbiguousBridgeCalls' atomic UPDATEs (blocked until commit,
  // their re-evaluated predicates then see the refreshed last_seen_at /
  // cleared resolved_at and stand down). Lock order: bridge_ambiguous_calls
  // rows first, then the retire primitive takes leads → call_log (the repo
  // order); resolution touches only bridge_ambiguous_calls, so no path
  // takes these locks in reverse.
  const ids = rows.map((r) => String(r.call_log_id));
  let retired = 0;
  const reconcile = await db.transaction(async (trx) => {
    // Lock EVERY existing row for the batch — open ones included (pre-push
    // audit P1 r5): filtering the locked read to resolved rows left open
    // rows unlocked, so a concurrent resolver could resolve one (and its
    // tick sweep the lead organic) between this read and the upsert — the
    // upsert then re-opened it silently, off the reopened list, and the
    // interim row was never retired. With all rows locked, a resolver
    // blocks until commit and its re-evaluated predicates stand down; one
    // that committed first is visible here as resolved and gets retired.
    const existing = await trx('bridge_ambiguous_calls')
      .whereIn('call_log_id', ids)
      .forUpdate()
      .select('call_log_id', 'resolved_at', 'resolve_reason');
    // 'bridged' resolutions are STICKY (codex P1, ambiguity-record r3 GH
    // round): an already-bridged CRM call can score ambiguously against a
    // DIFFERENT nearby Google call, and reopening its record would retire
    // the call's VALID paid attribution — which nothing recreates, since
    // the apply path skipped the ambiguous match. The paid claim on the
    // call row is durable positive evidence and outranks a later
    // ambiguity report; only rescan_clear resolutions reopen.
    const reopened = existing
      .filter((r) => r.resolved_at != null && r.resolve_reason !== 'bridged')
      .map((r) => String(r.call_log_id));
    const existingIds = new Set(existing.map((r) => String(r.call_log_id)));
    // FIRST sightings reconcile too (codex P1, r3 GH round): a call whose
    // ambiguous paid evidence is first discovered LATE — a 31–90-day
    // manual scan — may already carry a provenanced organic row from the
    // seven-day fallback, written back when nothing suggested ambiguity.
    // The new hold stops FUTURE organic writes but cannot undo that row,
    // and per-lead dedupe would block a later paid attribution forever.
    const firstSightings = ids.filter((id) => !existingIds.has(id));
    const reconcileIds = [...reopened, ...firstSightings];
    await trx('bridge_ambiguous_calls')
      .insert(rows)
      .onConflict('call_log_id')
      .merge({
        last_seen_at: trx.fn.now(),
        resolved_at: trx.raw("CASE WHEN bridge_ambiguous_calls.resolve_reason = 'bridged' THEN bridge_ambiguous_calls.resolved_at ELSE NULL END"),
        resolve_reason: trx.raw("CASE WHEN bridge_ambiguous_calls.resolve_reason = 'bridged' THEN bridge_ambiguous_calls.resolve_reason ELSE NULL END"),
      });
    // Snapshot the call→lead PHONE linkage (pre-push audit P1 r3): the sid
    // and stamp arms are durable links and carry an indefinite hold
    // safely, but the broad last-10 phone arm takes only the day's fresh
    // candidates (r2) — so a findReusableCallLead association with
    // neither sid nor stamp lost its hold the day its call aged past the
    // scan window. The snapshot names the CANDIDATE leads the processor
    // could have reused for this call, and it is TEMPORALLY BOUNDED
    // (pre-push audit P1 r4): a REUSED lead necessarily existed before
    // the call's last processing pass ENDED. The bound is that pass's
    // actual evidence (codex P1s, r3+r4+r5 GH rounds + audit r10): every
    // pass that can link a lead — the age-unlimited admin force-reprocess
    // included — claims first, stamping processing_started_at (which
    // finalization deliberately preserves), and findReusableCallLead runs
    // late in the pass, so the anchor is that stamp plus the processor's
    // own 10-minute stale-pass allowance (a pass older than that is the
    // processor's own definition of dead). The created_at + retry-window
    // fallback applies ONLY to pre-column rows with no stamp — keeping it
    // in a GREATEST let the seven-day term dominate every
    // normally-processed call and re-widened the very window the stamp
    // makes precise. A pass tomorrow that links a lead created tonight
    // bumps the stamp, and the daily re-record of a still-open ambiguity
    // (or the reopen's re-record) refreshes the snapshot behind it.
    // Generic updated_at was rejected (disposition edits and triage sync
    // move it, widening the horizon with non-processing writes). The exact pick ("newest eligible exact-phone match at
    // processing time") is not reconstructible post-hoc — claim states
    // move under it — so the hold keeps every candidate (over-holding a
    // coexisting same-number lead is recoverable; a wrong organic label
    // is not), and a distinct lead minted after the last processing
    // evidence can never join the hold, however long the ambiguity
    // re-reports. Leads the call itself minted carry its sid and ride the
    // sid arm instead. Deliberately no deleted_at filter — a hold on a
    // soft-deleted lead is dormant until an undelete, then protective.
    await insertPhoneLinkageSnapshot(trx, ids);
    if (reconcileIds.length) {
      // Lazy require: this module and call-attribution require each other.
      const { retireCallAttributionRow, retireRowPreservingHistory } = require('./call-attribution');
      // A call already carrying the durable paid claim is NEVER a
      // retirement target (codex P1, r4 GH round): record-level 'bridged'
      // stickiness only protects calls that HAVE a record — an
      // already-bridged call first sighted as an ambiguous candidate (or
      // one bridged since its record resolved) would enter this loop and
      // lose its valid paid row, which nothing recreates while the
      // ambiguity persists (the apply path skipped the match). The
      // resolver marks these records 'bridged' right after this
      // transaction commits.
      const bridgedCalls = new Set((await trx('call_log')
        .whereIn('id', reconcileIds)
        .whereNotNull('google_ads_call_resource_name')
        .select('id')).map((r) => String(r.id)));
      const resolvedAtById = new Map(existing
        .filter((r) => r.resolved_at != null && r.resolve_reason !== 'bridged')
        .map((r) => [String(r.call_log_id), r.resolved_at]));
      // The snapshot retire arm needs the bridge-target source set — the
      // same discovery the unclaimed sweep runs.
      const sourceRows = await trx('lead_sources')
        .whereNotNull('twilio_phone_number')
        .select('id', 'twilio_phone_number');
      const bridgeSourceIds = sourceRows
        .filter((s) => { try { return isBridgeTargetNumber(s.twilio_phone_number); } catch { return false; } })
        .map((s) => s.id);
      for (const callId of reconcileIds) {
        if (bridgedCalls.has(callId)) continue;
        // PROVENANCED arm — reopens AND first sightings. On a non-bridged
        // bridge-target call a provenanced row can only be the seven-day
        // fallback's organic write (call-time attribution is suppressed
        // for bridge targets, and a paid claim implies 'bridged', which
        // never reaches this loop): late-discovered ambiguity must undo
        // it or per-lead dedupe blocks the eventual paid attribution
        // forever (codex P1, r3 GH round).
        const provRows = await trx('ad_service_attribution')
          .where({ source_call_id: callId })
          .whereNotNull('lead_id')
          .select('lead_id');
        for (const leadId of new Set(provRows.map((r) => String(r.lead_id)))) {
          // Same transaction as the reopen upsert: the primitive's FOR
          // UPDATE reads stay held through its demote-vs-delete decision
          // (the r30 lock-before-judging rule), and a crash between the
          // reopen and the retire can no longer strand the interim row —
          // they commit or roll back together.
          retired += await retireCallAttributionRow(trx, callId, leadId);
        }
        // SNAPSHOT arm (pre-push audit P1 r6): a PHONE-linked lead's
        // interim organic row carries NO provenance — the provenance
        // resolver deliberately has no phone arm (r25) — so the
        // provenanced retire above cannot see it. On a snapshotted
        // BRIDGE-TARGET lead, every other NULL-provenance writer is out:
        // call-time attribution and claim-time backfill both suppress
        // bridge-target calls/leads, and web rows carry click/UTM markers
        // (the same discriminators recordCallPpcAttribution's own
        // web_attributed guard reads). A marker-free NULL-provenance row
        // born AFTER this record resolved can therefore only be the
        // unclaimed sweep's interim write. History-free rows delete (the
        // lead returns to held/unattributed); a row that accumulated
        // stage/revenue stays as permanently-conservative legacy — the
        // identical end-state the provenanced arm's demote produces.
        // REOPENS ONLY, deliberately: the born-after-resolution bound is
        // what proves the row is the sweep's post-lift write. A first
        // sighting has no such anchor, and an unanchored NULL-provenance
        // match could be a pre-provenance-era legacy row — which doctrine
        // holds permanently conservative and untouchable.
        const resolvedAt = resolvedAtById.get(callId);
        if (!resolvedAt || !bridgeSourceIds.length) continue;
        const snapLeadIds = (await trx('bridge_ambiguous_call_leads')
          .where({ call_log_id: callId })
          .select('lead_id')).map((r) => String(r.lead_id));
        if (!snapLeadIds.length) continue;
        // Repo lock order: leads before attribution rows.
        await trx('leads').whereIn('id', snapLeadIds).forUpdate().select('id');
        const interimRows = await trx('ad_service_attribution as asa')
          .join('leads as l', 'l.id', 'asa.lead_id')
          .whereIn('asa.lead_id', snapLeadIds)
          .whereIn('l.lead_source_id', bridgeSourceIds)
          .whereNull('asa.source_call_id')
          .whereNull('asa.gclid')
          .whereNull('asa.wbraid')
          .whereNull('asa.gbraid')
          .whereNull('asa.fbclid')
          .whereNull('asa.fbc')
          .whereNull('asa.utm_campaign')
          .whereNull('asa.utm_term')
          .where('asa.created_at', '>', resolvedAt)
          .select('asa.id');
        for (const row of interimRows) {
          retired += await retireRowPreservingHistory(trx, row.id);
        }
      }
    }
    return { reopened, firstSightings };
  });
  if (reconcile.reopened.length || retired) {
    logger.info(`[bridge-ambiguity] reopened ${reconcile.reopened.length} record(s), ${reconcile.firstSightings.length} first sighting(s), retired ${retired} interim attribution row(s)`);
  }
  return rows.length;
}

// Resolve open records on POSITIVE evidence only — never on absence from an
// aged-out scan (that non-evidence is exactly the bug the table closes):
//   'bridged'      — the call now carries google_ads_call_resource_name (a
//                    durable paid claim on the call row itself); safe to
//                    resolve even on a degraded scan day.
//   'rescan_clear' — a TRUSTED scan (healthy, uncapped, writes landed) that
//                    still COVERS the call's date no longer reports it
//                    ambiguous. The caller passes the coverage boundary with
//                    its own safety margin; calls older than it are never
//                    rescan-cleared and wait for 'bridged' or hold forever —
//                    the owner chose a permanent hold over a silent wrong
//                    paid/organic label.
//
// Both resolutions are single atomic UPDATEs (pre-push audit P1 r3) — no
// read-then-write gap for a concurrent record pass to land inside — and
// 'rescan_clear' additionally requires the record NOT refreshed since this
// scan STARTED (last_seen_at < scanStartedAt): a slow scan can never clear
// an ambiguity a concurrent manual apply re-reported while it ran, and a
// record pass holding the row FOR UPDATE blocks these UPDATEs until it
// commits, after which the re-evaluated predicates see the refreshed
// last_seen_at and stand down. scanStartedAt is captured from the DB clock
// (SELECT now() before scanning) so it compares against last_seen_at in
// one clock domain. A missing scanStartedAt fails CLOSED — no
// rescan_clear, same as an untrusted scan.
async function resolveAmbiguousBridgeCalls({
  ambiguousCallIds = [], scanWindowStart, scanStartedAt, rescanTrusted = false,
} = {}) {
  const bridged = await db('bridge_ambiguous_calls')
    .whereNull('resolved_at')
    .whereExists(function bridgedCall() {
      this.select(1).from('call_log as cl')
        .whereRaw('cl.id = bridge_ambiguous_calls.call_log_id')
        .whereNotNull('cl.google_ads_call_resource_name');
    })
    .update({ resolved_at: db.fn.now(), resolve_reason: 'bridged' });
  let rescanCleared = 0;
  if (rescanTrusted && scanWindowStart && scanStartedAt) {
    rescanCleared = await db('bridge_ambiguous_calls')
      .whereNull('resolved_at')
      .where('last_seen_at', '<', scanStartedAt)
      .modify((qb) => {
        // Belt to the last_seen gate's suspenders: the day's candidate ids
        // were refreshed by applyBridge before this runs, so the gate
        // already protects them — the explicit exclusion also covers a
        // caller that captured scanStartedAt late.
        if (ambiguousCallIds.length) qb.whereNotIn('call_log_id', ambiguousCallIds);
      })
      .whereExists(function rescanCoveredCall() {
        this.select(1).from('call_log as cl')
          .whereRaw('cl.id = bridge_ambiguous_calls.call_log_id')
          .where('cl.created_at', '>=', scanWindowStart);
      })
      .update({ resolved_at: db.fn.now(), resolve_reason: 'rescan_clear' });
  }
  if (bridged || rescanCleared) {
    logger.info(`[bridge-ambiguity] resolved ${bridged} bridged, ${rescanCleared} rescan-cleared`);
  }
  return { bridged, rescanCleared };
}

// ALL open records, shaped for attributeUnclaimedBridgeLeads' exclusion
// parameters. Reading the table (not the day's scan) is the point: the hold
// survives the scan window.
async function openAmbiguousCallExclusions() {
  const open = await db('bridge_ambiguous_calls')
    .whereNull('resolved_at')
    .select('call_log_id', 'twilio_call_sid');
  // REFRESH the snapshots BEFORE reading them (codex P1, r6 GH round): an
  // open ambiguity older than the 90-day max scan window is never
  // re-recorded by applyBridge, but an admin force-reprocess has no age
  // limit and can attach a NEW phone-reuse lead to such a call — the
  // temporal bound follows the bumped processing_started_at, yet nothing
  // re-ran the snapshot. Every sweep path calls this read immediately
  // before attributing, so refresh-then-read-then-sweep leaves no gap; a
  // refresh failure throws to bridgePairError, which also skips the sweep.
  const openIds = [...new Set(open.map((r) => String(r.call_log_id)))];
  if (openIds.length) await insertPhoneLinkageSnapshot(db, openIds);
  // The phone-linkage snapshot for OPEN records: the exact leads each
  // indefinite hold covers (see recordAmbiguousBridgeCalls) — the durable
  // replacement for routing persisted holds through the broad phone arm
  // (pre-push audit P1 r3).
  const heldLeads = await db('bridge_ambiguous_call_leads as bal')
    .join('bridge_ambiguous_calls as bac', 'bac.call_log_id', 'bal.call_log_id')
    .whereNull('bac.resolved_at')
    .select('bal.lead_id');
  return {
    excludeCallIds: openIds,
    excludeCallSids: [...new Set(open.map((r) => r.twilio_call_sid).filter(Boolean))],
    excludeLeadIds: [...new Set(heldLeads.map((r) => String(r.lead_id)))],
  };
}

module.exports = {
  previewBridge,
  applyBridge,
  isBridgeTargetNumber,
  recordAmbiguousBridgeCalls,
  resolveAmbiguousBridgeCalls,
  openAmbiguousCallExclusions,
  _private: {
    areaCode,
    attributeResolvedLead,
    whereCallStillLinked,
    buildMatches,
    callStillAttributable,
    dedupeCrmCallRows,
    findLeadForCall,
    googleAdsBridgeMetadata,
    leadMatchPlan,
    leadTimeWindow,
    mainLine,
    normalizeGoogleCallRow,
    parseGoogleDateTime,
    phoneLast10,
    phoneVariants,
    redactedLeadMatch,
    scoreCallMatch,
    shapeCallLog,
    shapeGoogleCall,
    shouldRetryLeadAttribution,
    sidJoinAttributionElsewhere,
    summarize,
  },
};
