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

module.exports = { leadSourceNumberVariants, resolveCallLeadSource };
