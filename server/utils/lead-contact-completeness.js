/**
 * When a lead counts as "qualified" on contact grounds.
 *
 * A lead is qualified only once we have actually captured the contact info the
 * office needs to work it: first + last name, a service street address, and an
 * email. Phone is implicit (caller ID). It is evaluated against the MERGED
 * record — this call's extraction OR what a prior call already stored — so a
 * follow-up call that restates nothing does not un-qualify a complete lead.
 *
 * Shared because BOTH lead writers must apply it. The recorded-call writer
 * always did; the voice-agent writer (lead-from-extraction.js) retained
 * qualification from the stored boolean alone, so when staff cleared an
 * invalid email or address without touching is_qualified — an update shape
 * admin-leads.js permits — the lead stayed qualified with its supporting
 * evidence gone, and stayed eligible for the Google Ads qualified-lead
 * conversion upload (codex #3675 P1). Same doctrine as
 * utils/workable-lead-signal.js: extracted, not duplicated — never re-inline.
 */

const QUALIFYING_CONTACT_FIELDS = ['first_name', 'last_name', 'service_address', 'email'];

const QUALIFYING_CONTACT_LABELS = {
  first_name: 'first name',
  last_name: 'last name',
  service_address: 'service address',
  email: 'email',
};

function leadContactCompleteness(fields = {}) {
  const present = (v) => !!String(v == null ? '' : v).trim();
  const missing = QUALIFYING_CONTACT_FIELDS.filter((key) => !present(fields[key]));
  return { complete: missing.length === 0, missing };
}

/**
 * The whole is_qualified rule, in one place because THREE writers apply it
 * (the recorded-call Step 4b write, its under-lock re-judge, and the
 * voice-agent writer) and they drifted apart every time it was restated.
 *
 * Qualification is MONOTONIC UNDER EVIDENCE: a call may EARN it (hot/warm) or
 * the lead may RETAIN it, and it is lost only when the supporting contact
 * evidence stops holding. One 'cold' callback must never demote a lead an
 * earlier call qualified — that was the 2026-08-31 incident, and it also
 * drops the lead from the Google Ads qualified-lead upload.
 *
 * A HUMAN disqualification outranks all of it. Staff record that in
 * leads.disqualification_reason, and admin-leads.js lets them set it without
 * touching is_qualified — so a gate that ignores the column let a
 * deliberately disqualified lead keep its qualification through a callback,
 * and let a hot follow-up silently re-qualify it while the reason still
 * stood (codex #3675 P1). Clearing the reason is the human act that makes a
 * lead eligible again.
 */
function leadQualification({ contactComplete, leadQuality, priorQualified, disqualificationReason }) {
  if (String(disqualificationReason || '').trim()) return false;
  return !!contactComplete
    && (['hot', 'warm'].includes(leadQuality) || priorQualified === true);
}

module.exports = {
  QUALIFYING_CONTACT_FIELDS,
  QUALIFYING_CONTACT_LABELS,
  leadContactCompleteness,
  leadQualification,
};
