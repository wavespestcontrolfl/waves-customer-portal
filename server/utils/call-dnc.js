'use strict';

/**
 * The one definition of "this call_log row records a do-not-contact request".
 *
 * Both shapes count: the V2 consent object (ai_extraction_enriched), and the
 * legacy extraction's flat field in the ai_extraction JSON text — a call
 * processed with V2 off, unavailable or schema-failed only has the latter.
 * Read from ANY stored extraction, valid or not: an opt-out is honoured
 * wherever it was heard. Shared by messaging/auto-text-holds.js and
 * lead-first-touch-resume's customerCallDoNotContact so the outbound vetoes
 * cannot drift apart.
 */
const V2_SQL = "ai_extraction_enriched->'consent'->>'do_not_contact_request' = 'true'";
const LEGACY_SQL = `COALESCE(ai_extraction, '') ~ '"do_not_contact_request"\\s*:\\s*true'`;

// Apply to a knex query over call_log (or an alias-free builder of it).
function whereCallDoNotContact(query) {
  return query.where((q) => q.whereRaw(V2_SQL).orWhereRaw(LEGACY_SQL));
}

module.exports = { whereCallDoNotContact, V2_SQL, LEGACY_SQL };
