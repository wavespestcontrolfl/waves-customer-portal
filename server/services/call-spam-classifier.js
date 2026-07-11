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

const CLASSIFIER_VERSION = 'layered-v2';
const TRUESPAM_THRESHOLD = Number(process.env.CALL_SPAM_TRUESPAM_THRESHOLD || 50);
const TOLLFREE_RE = /^\+1(800|833|844|855|866|877|888)/;

// Verbatim-script robocall signature (the "Google listing / press 9 /
// toll-free callback" family). Confirmed against live transcripts: the
// 2026-07 call audit named five triage-landing numbers running this script
// (+19417026646, +12404268098, +19412100592, +19416622127, +19417408169) and
// the 04-01 straggler voicemail (+19412053987) read the whole script
// verbatim: "…press 9 at any time. You may also call our toll-free number at
// 877-922-4011 to be removed from our call list. Again, please press 0 to
// speak with a support specialist."
//
// Each entry is a marker CATEGORY; a signature match requires >= 2 DISTINCT
// categories, so a legitimate caller mentioning their Google listing — or an
// agent reading back a toll-free number — can never trip it alone. This
// keeps the classifier's zero-false-positive ethos: the signature is a
// mechanical script match, not an inference.
const ROBOCALL_SCRIPT_MARKERS = [
  // The pitch: "your Google/business listing", "verify your listing",
  // "front page of Google".
  { key: 'listing_pitch', re: /\b(google|business|online)\s+listing\b|\bfront\s+page\s+of\s+google\b|\bverify\s+your\s+(business|listing)\b/i },
  // IVR prompt spoken AT the callee — live humans don't say "press 9".
  { key: 'ivr_prompt', re: /\bpress\s+(zero|one|two|three|nine|[0-9])\b/i },
  // Opt-out boilerplate.
  { key: 'call_list_removal', re: /\bremoved?\s+from\s+(our|the|this)\s+call(ing)?\s+list\b|\bdo[\s-]not[\s-]call\s+list\b/i },
  // A dictated toll-free callback number.
  { key: 'tollfree_callback', re: /\b8(00|33|44|55|66|77|88)[\s.-]?\d{3}[\s.-]?\d{4}\b/ },
];

/**
 * Deterministic script-signature check on the raw transcript. Returns
 * { match, markers } — match only when >= 2 distinct marker categories hit.
 * Pure; safe on null/empty transcripts.
 */
function detectRobocallScriptSignature(transcript) {
  const text = String(transcript || '');
  if (!text.trim()) return { match: false, markers: [] };
  const markers = ROBOCALL_SCRIPT_MARKERS.filter((m) => m.re.test(text)).map((m) => m.key);
  return { match: markers.length >= 2, markers };
}

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
 * @param {string|null} args.transcript  raw transcript for the deterministic
 *                                        script-signature check, optional
 * @returns {{ verdict: 'spam'|'not_spam'|'insufficient_signals', signals: object }}
 */
async function classifyCall({ call, extraction = null, legacy = null, lineType = null, transcript = null }) {
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

  // Deterministic script-signature: a verbatim robocall-script match is a
  // signal INDEPENDENT of the model's content judgment (mechanical regex vs
  // inference), so it can serve as the second leg the asymmetric-cost rule
  // requires — this is what catches the Google-listing family, whose rotating
  // LOCAL numbers carry no vendor or line risk and were landing in triage as
  // insufficient_signals despite reading the same script every time.
  const script = detectRobocallScriptSignature(transcript);

  // History override: any prior legitimate relationship on this number wins.
  const history = await callerHistory(call.from_phone);

  let verdict;
  if (history.override) verdict = 'not_spam';
  else if (!contentAvailable) verdict = 'insufficient_signals';
  else if (contentSpam && (risk.vendor_risk || line.line_risk || script.match)) verdict = 'spam';
  else if (contentSpam) verdict = 'insufficient_signals'; // content alone never discards
  else verdict = 'not_spam';

  return {
    verdict,
    signals: {
      risk, line, script,
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

module.exports = { classifyCall, recordVerdict, detectRobocallScriptSignature, CLASSIFIER_VERSION };
