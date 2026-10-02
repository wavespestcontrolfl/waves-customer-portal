/**
 * seo_citations.nap_consistent must agree with status (follow-up to
 * 20260929230000_seo_citations_audit_states, which is pushed and frozen).
 *
 * That migration remapped legacy `active` rows (created with nap_consistent = true) to
 * `unverified` because no directory page was ever checked, but left the old boolean in
 * place: the dashboard and the backlink strategy agent then read rows that were
 * simultaneously "unverified" and "consistent". The auditor's own rule is
 *   verified -> true, mismatched -> false, every other status -> NULL.
 * This nulls the flag wherever it contradicts the status. Nothing else is touched.
 *
 * Idempotent: a second run matches no rows. down() is a no-op — the nulled values were
 * unaudited claims, so there is nothing true to restore.
 */
exports.up = async function up(knex) {
  await knex.raw(`
    UPDATE seo_citations
       SET nap_consistent = NULL
     WHERE nap_consistent IS NOT NULL
       AND (status IN ('unverified', 'fetch-blocked', 'missing')
            OR (status = 'verified' AND nap_consistent = false)
            OR (status = 'mismatched' AND nap_consistent = true))
  `);
};

exports.down = async function down() {
  // Intentionally empty: see header.
};
