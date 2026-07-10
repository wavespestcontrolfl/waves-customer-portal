/**
 * Layered spam classifier — zero-triage mission (2026-07-10).
 *
 * Validated offline against 1,000 inbound calls with strong-model-arbitrated
 * ground truth: 100% precision (17/17), ZERO false positives, 50% recall
 * (docs/call-mining-2026-07-10.md). The asymmetric-cost rule is structural:
 * a `spam` verdict requires the CONTENT signal plus at least one independent
 * non-content signal (vendor risk score or line-type risk), and no history
 * override. Never transcript alone, never risk score alone. Anything less is
 * `not_spam` or `insufficient_signals` — both of which simply let the call
 * flow through today's pipeline unchanged.
 *
 * Dark by default: GATE_CALL_SPAM_CLASSIFIER records verdicts to
 * call_spam_verdicts for live-accuracy accrual. Acting on a verdict (the
 * discard path) is gated SEPARATELY by the disposition layer's caller.
 */

const db = require('../models/db');
const logger = require('./logger');

const CLASSIFIER_VERSION = 'layered-v1';
const TRUESPAM_THRESHOLD = Number(process.env.CALL_SPAM_TRUESPAM_THRESHOLD || 50);
const TOLLFREE_RE = /^\+1(800|833|844|855|866|877|888)/;

// Twilio Marketplace AddOns envelope (persisted on call_log.metadata.addons
// since #2556) → per-vendor signals. Fail-open: unparseable → nulls.
function vendorSignalsFromAddOns(addons) {
  const res = addons?.results || {};
  const nomo = res.nomorobo_spamscore || {};
  const ts = res.truecnam_truespam || {};
  const marchex = res.marchex_cleancall || {};
  const nomoScore = nomo.status === 'successful' ? (nomo.result?.score ?? null) : null;
  const tsResult = ts.status === 'successful' ? (ts.result || {}) : {};
  const tsScore = tsResult.spam_score ?? tsResult.score ?? null;
  const marchexRec = marchex.status === 'successful'
    ? ((marchex.result?.result || marchex.result || {}).recommendation || null)
    : null;
  return {
    nomorobo: nomoScore,
    truespam: tsScore,
    marchex: marchexRec,
    vendor_risk: nomoScore === 1 || Number(tsScore) >= TRUESPAM_THRESHOLD || marchexRec === 'BLOCK',
  };
}

/**
 * Classify one call. Deterministic given its inputs; DB reads only (caller
 * history), no writes here.
 *
 * @param {object} args
 * @param {object} args.call        call_log row (from_phone, metadata w/ addons + stir_verstat)
 * @param {object|null} args.extraction  V2 extraction (1.5.0 spam_verdict used when present)
 * @param {object|null} args.legacy      V1 extraction (is_spam fallback content signal)
 * @param {object|null} args.lineType    { type, caller_name } from phone_line_types/Lookup, optional
 * @returns {{ verdict: 'spam'|'not_spam'|'insufficient_signals', signals: object }}
 */
async function classifyCall({ call, extraction = null, legacy = null, lineType = null }) {
  const meta = typeof call.metadata === 'string' ? safeParse(call.metadata) : (call.metadata || {});
  const risk = vendorSignalsFromAddOns(meta?.addons);
  const tollfree = TOLLFREE_RE.test(call.from_phone || '');
  // CNAM comes from the caller-supplied lineType (offline validation) or,
  // live, from the Twilio Caller Name add-on riding call_log.metadata.addons
  // (#2556) — phone_line_types caches only the line type. When NO CNAM
  // source exists, voip must NOT count as the independent risk signal:
  // "unknown name" and "known-nameless" are different facts, and only the
  // latter is evidence (keeps the zero-false-positive property live).
  const cnamFromAddOns = cnamFromEnvelope(meta?.addons);
  const cnam = lineType && 'caller_name' in lineType ? (lineType.caller_name ?? cnamFromAddOns) : cnamFromAddOns;
  const cnamKnown = (lineType && 'caller_name' in lineType && lineType.caller_name !== undefined) || cnamFromAddOns !== undefined;
  const line = {
    type: lineType?.type || null,
    cnam: cnam ?? null,
    line_risk: (lineType?.type === 'nonFixedVoip' && cnamKnown && !cnam) || tollfree,
  };

  // Content signal: schema-1.5.0 spam_verdict preferred; V1 is_spam fallback.
  const sv = extraction?.spam_verdict || null;
  const contentAvailable = !!(sv || legacy);
  const contentSpam = sv ? sv.is_spam_content === true : (legacy ? legacy.is_spam === true : null);

  // History override: any prior legitimate relationship on this number wins.
  const history = await callerHistory(call.from_phone);

  let verdict;
  if (history.override) verdict = 'not_spam';
  else if (!contentAvailable) verdict = 'insufficient_signals';
  else if (contentSpam && (risk.vendor_risk || line.line_risk)) verdict = 'spam';
  else if (contentSpam) verdict = 'insufficient_signals'; // content alone never discards
  else verdict = 'not_spam';

  return {
    verdict,
    signals: {
      risk, line,
      content: { available: contentAvailable, content_spam: contentSpam, source: sv ? 'v2_spam_verdict' : (legacy ? 'v1_is_spam' : null) },
      history,
      stir_verstat: meta?.stir_verstat || null,
    },
  };
}

async function callerHistory(fromPhone) {
  const key = String(fromPhone || '').replace(/\D/g, '').slice(-10);
  if (key.length < 10) return { override: false, reason: 'no_usable_number' };
  try {
    // Same columns the inbound identity matcher consults: the customer's own
    // number PLUS the three service-contact slot phones — a spouse/tenant
    // calling from a stored slot number is legitimate history.
    const PHONE_COLS = ['phone', 'service_contact_phone', 'service_contact2_phone', 'service_contact3_phone'];
    const phoneMatch = PHONE_COLS
      .map((c) => `RIGHT(regexp_replace(COALESCE(${c},''),'[^0-9]','','g'),10) = ?`)
      .join(' OR ');
    const [customer, lead] = await Promise.all([
      db('customers')
        .whereRaw(`(${phoneMatch})`, PHONE_COLS.map(() => key))
        .whereIn('pipeline_stage', ['active_customer', 'won', 'at_risk'])
        .first('id'),
      db('leads')
        .whereRaw("RIGHT(regexp_replace(COALESCE(phone,''),'[^0-9]','','g'),10) = ?", [key])
        .whereNull('deleted_at')
        .first('id'),
    ]);
    return { override: !!(customer || lead), real_customer: !!customer, any_lead: !!lead };
  } catch (err) {
    // Fail toward NOT overriding is wrong here — a DB hiccup must not let a
    // real customer be classified spam. Fail toward the safe side: override.
    logger.warn(`[spam-classifier] history lookup failed (failing safe → override): ${err.message}`);
    return { override: true, error: err.message };
  }
}

/** Persist a verdict row; idempotent on (call_log_id, classifier_version). */
async function recordVerdict(callLogId, { verdict, signals }) {
  try {
    await db('call_spam_verdicts')
      .insert({ call_log_id: callLogId, verdict, signals: JSON.stringify(signals), classifier_version: CLASSIFIER_VERSION })
      .onConflict(['call_log_id', 'classifier_version'])
      .merge({ verdict, signals: JSON.stringify(signals) });
  } catch (err) {
    logger.warn(`[spam-classifier] verdict write failed for ${callLogId}: ${err.message}`);
  }
}

// Twilio Caller Name add-on result from the AddOns envelope. Returns the
// name string, null when the add-on ran and found none (known-nameless),
// or undefined when the add-on didn't run (unknown — never a risk signal).
function cnamFromEnvelope(addons) {
  const cn = addons?.results?.twilio_caller_name;
  if (!cn || cn.status !== 'successful') return undefined;
  const payload = cn.result?.caller_name || cn.result || {};
  return payload.caller_name || null;
}

function safeParse(s) { try { return JSON.parse(s); } catch { return {}; } }

module.exports = { classifyCall, recordVerdict, CLASSIFIER_VERSION };
