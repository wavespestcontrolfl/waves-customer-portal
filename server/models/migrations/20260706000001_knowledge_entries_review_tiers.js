/**
 * Agronomic wiki — exception-based review tiers (owner directive 2026-07-06:
 * "exception-based review, not manual approval of everything").
 *
 * Adds to knowledge_entries:
 *   review_tier   — green (auto-update) | yellow (auto + weekly digest) |
 *                   red (excluded from agent-facing reads until reviewed)
 *   review_status — auto | pending_review | approved | blocked
 *   risk_flags    — jsonb array of classifier reasons (auditable)
 *
 * Backfills the existing corpus with the same rules the runtime classifier
 * applies: low confidence or compliance-touching content → red/pending_review,
 * moderate confidence → yellow/auto, high+ → green/auto.
 */

// Mirrors COMPLIANCE_PATTERNS in server/services/agronomic-wiki.js —
// migrations must stay self-contained (never edited after they run).
const COMPLIANCE_PATTERNS = [
  /\bblackout\b/i,
  /\bordinance\b/i,
  /\bREI\b/,
  /re-entry interval/i,
  /\bdo[- ]not[- ]apply\b/i,
  /phytotox/i,
  /restricted[- ]use\b/i,
];

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('knowledge_entries'))) return;

  if (!(await knex.schema.hasColumn('knowledge_entries', 'review_tier'))) {
    await knex.schema.alterTable('knowledge_entries', (t) => {
      t.string('review_tier', 12).nullable();
      t.string('review_status', 20).notNullable().defaultTo('auto');
      t.jsonb('risk_flags').nullable();
    });
  }

  // Backfill unclassified rows only — idempotent, and never overwrites a
  // tier a human has already touched.
  const rows = await knex('knowledge_entries')
    .whereNull('review_tier')
    .select('id', 'confidence', 'content');

  // Pre-existing open contradictions must gate their pages from day one —
  // the trusted-read filters go live with this deploy.
  let contradictedIds = new Set();
  if (await knex.schema.hasTable('knowledge_contradictions')) {
    const contradicted = await knex('knowledge_contradictions')
      .whereNotIn('status', ['resolved', 'dismissed'])
      .whereNotNull('wiki_entry_id')
      .select('wiki_entry_id');
    contradictedIds = new Set(contradicted.map((c) => c.wiki_entry_id));
  }

  for (const row of rows) {
    const flags = [];
    if (contradictedIds.has(row.id)) flags.push('open_contradiction');
    if (COMPLIANCE_PATTERNS.some((p) => p.test(row.content || ''))) flags.push('compliance_content');
    if (row.confidence === 'low') flags.push('low_confidence');
    else if (row.confidence === 'moderate') flags.push('moderate_confidence');
    else if (row.confidence !== 'high' && row.confidence !== 'very_high') flags.push('unclassified_confidence');

    let tier = 'green';
    if (flags.includes('moderate_confidence') || flags.includes('unclassified_confidence')) tier = 'yellow';
    if (flags.includes('low_confidence') || flags.includes('compliance_content') || flags.includes('open_contradiction')) tier = 'red';

    await knex('knowledge_entries').where({ id: row.id }).update({
      review_tier: tier,
      review_status: tier === 'red' ? 'pending_review' : 'auto',
      risk_flags: JSON.stringify(flags),
    });
  }

  // Existing wiki-sync KB mirrors of now-untrusted pages must be gated from
  // the same deploy — status for bridge/search readers AND the `active`
  // boolean that wiki-qa filters on.
  if (
    (await knex.schema.hasTable('knowledge_base')) &&
    (await knex.schema.hasColumn('knowledge_base', 'wiki_entry_id'))
  ) {
    await knex('knowledge_base')
      .where({ source: 'wiki-sync' })
      .whereIn(
        'wiki_entry_id',
        knex('knowledge_entries').select('id').whereNotIn('review_status', ['auto', 'approved']),
      )
      .update({ status: 'flagged', active: false, updated_at: knex.fn.now() });
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('knowledge_entries'))) return;
  if (await knex.schema.hasColumn('knowledge_entries', 'review_tier')) {
    await knex.schema.alterTable('knowledge_entries', (t) => {
      t.dropColumn('review_tier');
      t.dropColumn('review_status');
      t.dropColumn('risk_flags');
    });
  }
};
