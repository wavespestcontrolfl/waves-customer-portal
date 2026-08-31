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

module.exports = {
  QUALIFYING_CONTACT_FIELDS,
  QUALIFYING_CONTACT_LABELS,
  leadContactCompleteness,
};
