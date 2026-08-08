const db = require('../../models/db');
const logger = require('../logger');
const TWILIO_NUMBERS = require('../../config/twilio-numbers');
const { parseETDateTime, etDateString, addETDays, formatETTime } = require('../../utils/datetime-et');

const GOOGLE_ADS_BRIDGE_SOURCE_NAME = 'Google Ads - Call Reporting Bridge';
const GOOGLE_ADS_BRIDGE_LOCATION_ID = 'bradenton';
const LEAD_MATCH_WINDOW_HOURS = 6;
const MIN_AUTO_BRIDGE_CONFIDENCE = 70;
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
    leadSourceName: row.lead_source_name || null,
    googleAdsCallResourceName: row.google_ads_call_resource_name || null,
    googleAdsBridgedAt: row.google_ads_bridged_at || null,
    googleAdsLeadMatched: !!bridgeMetadata?.leadMatch?.leadId,
    googleAdsLeadMatchedAt: bridgeMetadata?.leadAttributedAt || null,
  };
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
  return match?.status === 'already_bridged'
    && !!match.callLog?.id
    && !match.callLog.googleAdsLeadMatched;
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
    const ambiguous = !!(best && second && best.score - second.score < 10 && second.score >= MIN_AUTO_BRIDGE_CONFIDENCE);
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
    });
  }

  return matches;
}

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
    .limit(500);

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
  const byId = new Map();
  for (const row of rows) {
    if (!byId.has(row.id)) byId.set(row.id, []);
    byId.get(row.id).push(row);
  }
  const deduped = [];
  for (const group of byId.values()) {
    if (group.length === 1) { deduped.push(group[0]); continue; }
    const seenLeadIds = new Set();
    const sidLinked = group.filter((r) => {
      if (!isSidLinked(r)) return false;
      const key = String(r.lead_id);
      if (seenLeadIds.has(key)) return false;
      seenLeadIds.add(key);
      return true;
    });
    if (sidLinked.length === 1) deduped.push(sidLinked[0]);
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
        this.whereRaw('call_log.twilio_call_sid = leads.twilio_call_sid')
          .orWhere(function settledStampArm() {
            // Only a SETTLED call's stamp is authoritative (pre-push P1
            // r2): every stamp mutation is fenced on processing_token, so
            // a non-null token means a pass is mid-flight and its
            // maintenance may still clear or repoint this stamp — skip,
            // and the retry lane re-evaluates on the next cron pass. The
            // sid arm is stable linkage and carries no such condition.
            this.whereRaw("call_log.metadata->>'lead_id' = leads.id::text")
              .whereNull('call_log.processing_token');
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
async function attributeResolvedLead(callLog, bridgeSource, now, trx) {
  let joinedWentStale = false;
  if (callLog?.leadId) {
    const lockedLead = await trx('leads')
      .where({ id: callLog.leadId })
      .whereNull('deleted_at')
      .forUpdate()
      .first('id', 'customer_id');
    if (lockedLead) {
      const joined = {
        strategy: 'joined_lead',
        leadId: callLog.leadId,
        customerId: lockedLead.customer_id || callLog.customerId || null,
      };
      if (await updateLeadAttribution(joined, bridgeSource, now, { linkageCallId: callLog.id, dbc: trx })) {
        return { match: joined };
      }
    }
    joinedWentStale = true;
  }
  const planned = await findLeadForCall(callLog);
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
  const plannedOwner = await trx('leads').where({ id: planned.leadId }).first('customer_id');
  return { match: { ...planned, customerId: plannedOwner?.customer_id || planned.customerId || null } };
}

async function findLeadForCall(callLog) {
  const plan = leadMatchPlan(callLog);
  if (!plan) return null;

  let query = db('leads').select('id', 'customer_id').whereNull('deleted_at');
  if (plan.strategy === 'customer_id') {
    query = query.where({ customer_id: plan.customerId });
  } else {
    query = query.whereRaw(
      "RIGHT(REGEXP_REPLACE(COALESCE(phone, ''), '[^0-9]', '', 'g'), 10) = ?",
      [plan.phoneLast10],
    );
  }

  const lead = await query
    .where('first_contact_at', '>=', plan.startAt)
    .where('first_contact_at', '<=', plan.endAt)
    .orderByRaw('ABS(EXTRACT(EPOCH FROM (first_contact_at - ?::timestamptz))) ASC', [plan.callAt])
    .orderBy('created_at', 'desc')
    .first();
  // A phone-matched plan has no customerId; surface the matched lead's so PPC
  // attribution can run even when the call_log row isn't customer-linked.
  return lead?.id ? { ...plan, leadId: lead.id, customerId: plan.customerId || lead.customer_id || null } : null;
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
  let query = dbc('leads')
    .where({ id: leadMatch.leadId })
    .whereNull('deleted_at');
  if (linkageCallId) query = whereCallStillLinked(query, linkageCallId);
  const updated = await query.update({
    lead_source_id: bridgeSource.id,
    updated_at: now,
  });
  return !!updated;
}

function summarize(matches, crmCalls) {
  return {
    googleCalls: matches.length,
    crmMainLineCalls: crmCalls.length,
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
    period: { days },
    targetNumber: target,
    sourceName: GOOGLE_ADS_BRIDGE_SOURCE_NAME,
    summary: summarize(matches, crmCalls),
    matches,
    recentMainLineCalls: crmCalls.slice(0, 20).map(shapeCallLog),
  };
}

async function applyBridge(options = {}) {
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
        if (bridgedToThisCall) {
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
              let backfillLeadId = match.callLog?.leadId || null;
              let backfillCustomerId = match.callLog?.customerId || null;
              if (backfillLeadId) {
                const liveJoined = await joinedLeadLiveRow(match.callLog, { dbc: trx, lock: true });
                if (liveJoined) {
                  backfillCustomerId = liveJoined.customer_id || backfillCustomerId;
                } else {
                  backfillLeadId = null;
                }
              }
              if (!backfillLeadId) {
                // The plan fallback resolves on the global connection —
                // lock and revalidate the selected lead INSIDE this
                // transaction before it feeds the funnel (pre-push P1 r5):
                // live-ness and the CURRENT owner are read under the row
                // lock, so a concurrent soft-delete or customer
                // reassignment can't produce a stale attribution pair.
                const lm = await findLeadForCall(match.callLog).catch(() => null);
                if (lm?.leadId) {
                  const lockedFallback = await trx('leads')
                    .where({ id: lm.leadId })
                    .whereNull('deleted_at')
                    .forUpdate()
                    .first('id', 'customer_id');
                  if (lockedFallback) {
                    backfillLeadId = lm.leadId;
                    backfillCustomerId = lockedFallback.customer_id || lm.customerId || backfillCustomerId;
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
        const attribution = await db.transaction(async (trx) => {
          const res = await attributeResolvedLead(match.callLog, bridgeSource, now, trx);
          if (!res.match) return res;
          await trx('call_log')
            .where({ id: match.callLog.id })
            .update({
              metadata: bridgeMetadataPatch({
                leadMatch: redactedLeadMatch(res.match),
                leadAttributedAt: now.toISOString(),
              }),
              updated_at: now,
            });
          // Funnel write while the lead lock is still held, on the SAME
          // connection (pre-push P1 r3/r4): reconciliation queues on this
          // lock, so the verified linkage cannot be cleared before the
          // funnel row lands — and the FK check's FOR KEY SHARE on the
          // locked lead must not come from a second connection. A funnel
          // SQL failure rolls the round back to the retry lane,
          // attribution and funnel staying consistent.
          if (bridgedToThisCall) {
            await writeCallPpcAttribution(match, res.match.customerId || match.callLog?.customerId || null, res.match.leadId, trx);
          }
          return res;
        });
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
        const { match: attributed } = await attributeResolvedLead(match.callLog, bridgeSource, now, trx);
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
        await writeCallPpcAttribution(
          match,
          attributed?.customerId || match.callLog?.customerId || null,
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

  return {
    ...preview,
    appliedCount: applied.length,
    skippedCount: skipped.length,
    applied,
    skipped,
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

module.exports = {
  previewBridge,
  applyBridge,
  isBridgeTargetNumber,
  _private: {
    areaCode,
    buildMatches,
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
    summarize,
  },
};
