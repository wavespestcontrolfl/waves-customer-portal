// The dialed number → lead_sources resolution, ONE definition on purpose
// (extracted from call-recording-processor.js, codex P1 PR #3303 r20): the
// processor resolves it on the lead-creation path, and the rejection-repair
// branch at finalization must resolve the SAME channel for a call that
// created no lead this pass — two drifting copies would file the repaired
// funnel row under a different channel than the original write.
//
// `lead_sources.twilio_phone_number` has historically been hand-entered, so
// every plausible shape is matched: E.164 `+19413187612`, 11-digit
// `19413187612`, 10-digit `9413187612`, formatted `(941) 318-7612`.

function leadSourceNumberVariants(toPhone) {
  const digits = String(toPhone || '').replace(/\D/g, '');
  const ten = digits.length >= 10 ? digits.slice(-10) : null;
  const variants = new Set([toPhone].filter(Boolean));
  if (ten) {
    variants.add(ten);
    variants.add(`1${ten}`);
    variants.add(`+1${ten}`);
    variants.add(`(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}`);
  }
  return [...variants];
}

// Returns { row, variants, matchedByNumber }. An explicit referral wins over
// the number-matched source: the PPC funnel must attribute the lead to the
// referral channel (its per-conversion reward cost), not the dialed line.
// The referral lookup is self-guarded, exactly as at the original call site.
async function resolveCallLeadSource({ dbc, toPhone, preferReferral = false }) {
  const variants = leadSourceNumberVariants(toPhone);
  const matched = await dbc('lead_sources')
    .where('is_active', true)
    .whereIn('twilio_phone_number', variants)
    .first();
  let row = matched || null;
  if (preferReferral) {
    const refRow = await dbc('lead_sources')
      .where({ source_type: 'referral', is_active: true })
      .first()
      .catch(() => null);
    if (refRow) row = refRow;
  }
  return { row, variants, matchedByNumber: !!matched };
}


// Referral evidence from a call's own extraction — the input to
// resolveCallLeadSource's preferReferral arm. Extracted VERBATIM from
// call-recording-processor (codex P1 r24): the attribution retire's
// successor-rehome resolved the dialed number ONLY, so a successor that
// explicitly named a referrer had its transferred row relabelled to the
// dialed line's channel and corrupted referral ROI. call-attribution
// cannot require the processor (cycle), so the definition lives here with
// the resolver it feeds.
const REFERRAL_PLACEHOLDER_VALUES = new Set([
  'null', 'none', 'n/a', 'na', 'no', 'false', 'true', 'unknown', 'undefined',
  'not mentioned', 'not stated', 'not specified', 'not provided', 'nobody', 'no one',
]);

function referrerNameFromExtracted(extracted = {}) {
  // Model-generated JSON has no schema enforcement — fail CLOSED: a non-string
  // sentinel (e.g. boolean false) or a placeholder phrase must NOT be read as a
  // referrer name and flip a normal call to lead_source='referral'.
  const v = extracted?.referred_by;
  if (typeof v !== 'string') return '';
  const raw = v.trim();
  if (!raw || REFERRAL_PLACEHOLDER_VALUES.has(raw.toLowerCase())) return '';
  return raw.slice(0, 100); // sane cap for a name/'unnamed' (detail is clamped again at write)
}

module.exports = {
  leadSourceNumberVariants,
  resolveCallLeadSource,
  referrerNameFromExtracted,
  REFERRAL_PLACEHOLDER_VALUES,
};
