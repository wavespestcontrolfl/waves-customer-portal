/**
 * Adds facts_pack to content_briefs — the verified facts-bank facts the
 * writer agent is given for a city x service draft, so it can ground every
 * local claim in a real fact_id and emit a claims_ledger the gate validates.
 *
 * jsonb shape:
 *   {
 *     city: { id, facts: [{ id, type, value, evidence_strength }], internal_links },
 *     service: { id, facts: [...] },
 *     county: { id, facts: [...] },
 *     allowed_claim_patterns: [...],
 *     disallowed_claim_patterns: [...]
 *   }
 *
 * Only populated for facts-gated city x service briefs; null otherwise.
 */

exports.up = async function (knex) {
  const has = await knex.schema.hasColumn('content_briefs', 'facts_pack');
  if (!has) {
    await knex.schema.alterTable('content_briefs', (t) => {
      t.jsonb('facts_pack').nullable();
    });
  }
};

exports.down = async function (knex) {
  const has = await knex.schema.hasColumn('content_briefs', 'facts_pack');
  if (has) {
    await knex.schema.alterTable('content_briefs', (t) => {
      t.dropColumn('facts_pack');
    });
  }
};
