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
    leadSourceName: row.lead_source_name || null,
    googleAdsCallResourceName: row.google_ads_call_resource_name || null,
    googleAdsBridgedAt: row.google_ads_bridged_at || null,
  };
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

  return db('call_log as c')
    .leftJoin('customers as cu', 'c.customer_id', 'cu.id')
    .leftJoin('leads as l', 'c.twilio_call_sid', 'l.twilio_call_sid')
    .leftJoin('lead_sources as ls', 'l.lead_source_id', 'ls.id')
    .where('c.direction', 'inbound')
    .whereIn('c.to_phone', phoneVariants(target.number))
    .where('c.created_at', '>=', since)
    .select(
      'c.*',
      'cu.first_name as customer_first_name',
      'cu.last_name as customer_last_name',
      'l.id as lead_id',
      'ls.name as lead_source_name',
    )
    .orderBy('c.created_at', 'desc')
    .limit(500);
}

async function ensureBridgeLeadSource() {
  const existing = await db('lead_sources')
    .where({ name: GOOGLE_ADS_BRIDGE_SOURCE_NAME })
    .first();
  if (existing) return existing;

  const [source] = await db('lead_sources')
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
}

async function findLeadForCall(callLog) {
  const plan = leadMatchPlan(callLog);
  if (!plan) return null;

  let query = db('leads').select('id');
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
  return lead?.id ? { ...plan, leadId: lead.id } : null;
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
  const googleRows = configured ? await googleAds.fetchCallViews(days, limit) : [];
  const googleCalls = googleRows.map(normalizeGoogleCallRow).filter((row) => row.resourceName);
  const matches = buildMatches(googleCalls, crmCalls, target.number);

  return {
    configured,
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
  const readyMatches = preview.matches.filter((match) => match.status === 'ready' && match.callLog?.id);
  const bridgeSource = readyMatches.length > 0 ? await ensureBridgeLeadSource() : null;
  const applied = [];
  const skipped = [];

  for (const match of preview.matches) {
    if (match.status === 'already_bridged') {
      skipped.push({ ...match, skipReason: 'already_bridged' });
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
      const leadMatch = await findLeadForCall(match.callLog);
      if (leadMatch) {
        bridgePayload.leadMatch = leadMatch;
      }

      await db('call_log')
        .where({ id: match.callLog.id })
        .update({
          source: 'google_ads',
          google_ads_call_resource_name: match.googleCall.resourceName,
          google_ads_call_started_at: match.googleCall.startAt,
          google_ads_call_duration_seconds: match.googleCall.durationSeconds,
          google_ads_call_status: match.googleCall.callStatus,
          google_ads_bridge_confidence: match.confidence,
          google_ads_bridged_at: now,
          metadata: db.raw("COALESCE(metadata, '{}'::jsonb) || ?::jsonb", [
            JSON.stringify({ google_ads_call_bridge: bridgePayload }),
          ]),
          updated_at: now,
        });

      if (leadMatch?.leadId) {
        await db('leads')
          .where({ id: leadMatch.leadId })
          .update({
            lead_source_id: bridgeSource?.id,
            updated_at: now,
          });
      }

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

module.exports = {
  previewBridge,
  applyBridge,
  _private: {
    areaCode,
    buildMatches,
    findLeadForCall,
    leadMatchPlan,
    leadTimeWindow,
    mainLine,
    normalizeGoogleCallRow,
    parseGoogleDateTime,
    phoneLast10,
    phoneVariants,
    scoreCallMatch,
    shapeCallLog,
    shapeGoogleCall,
    summarize,
  },
};
