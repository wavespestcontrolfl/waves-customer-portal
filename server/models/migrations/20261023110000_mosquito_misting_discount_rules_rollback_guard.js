/**
 * Rollback guard for the misting discount rules (misting PR 2a, #6543).
 *
 * 20261023100000_mosquito_misting_catalog_rows seeded one service_discount_rules row per misting service (install, service plan,
 * refill), each stamped with an insertion marker in `notes`. Its down() removes every rule that still carries the marker. The admin
 * discount-rule PUT can change the pricing fields (tier_qualifier, max_discount_pct, flat_credit, flat_credit_min_tier,
 * exclude_from_pct_discount) WITHOUT touching `notes`, so an operator-edited rule still looks "ours" and a rollback would delete the
 * edit. That migration is frozen (already pushed), so the correction is this separate migration.
 *
 * up(): a documented no-op. The rows already exist; nothing is changed or written.
 *
 * down(): runs BEFORE the frozen migration's down() on a rollback (knex rolls back the newest migration first). For each of the three
 * misting rules that still carries the marker, the current pricing fields are compared with the values the frozen migration seeded
 * (SEEDED_RULE below, mirroring insertRules in that file). If ANY pricing field differs, the rule was edited by an operator: the
 * marker is stripped from `notes` (the rest of the notes are kept) and " retained on rollback: operator-edited" is appended. The frozen
 * down() then finds no marker (removeMarked logs "admin-replaced, leaving untouched") and keeps the rule. An unedited rule keeps its
 * marker and is removed by the frozen down() exactly as before.
 *
 * What survives an operator-edited rule: the rule row (keyed by service_key). The frozen down() does not count discount rules as a
 * reference to the service row, so the service row itself is still removed when nothing else references it. That is safe:
 * service_discount_rules.service_key is a plain unique string column with no foreign key to services, so the surviving rule dangles
 * harmlessly, and re-running the frozen up() skips inserting a rule that already exists.
 */
const frozen = require('./20261023100000_mosquito_misting_catalog_rows');

const SUFFIX = 'retained on rollback: operator-edited';

// The pricing fields exactly as 20261023100000 insertRules seeded them (kept in step by a test against that file's own insert).
const SEEDED_RULE = Object.freeze({
  tier_qualifier: false,
  max_discount_pct: null,
  flat_credit: null,
  flat_credit_min_tier: null,
  exclude_from_pct_discount: true,
});

function ruleWasEdited(row) {
  return row.tier_qualifier !== SEEDED_RULE.tier_qualifier
    || row.exclude_from_pct_discount !== SEEDED_RULE.exclude_from_pct_discount
    || row.max_discount_pct != null
    || row.flat_credit != null
    || row.flat_credit_min_tier != null;
}

function strippedNotes(notes) {
  const rest = String(notes || '').split(frozen.MARKER).join('').trim();
  return rest ? `${rest} ${SUFFIX}` : SUFFIX;
}

exports.SEEDED_RULE = SEEDED_RULE;
exports.SUFFIX = SUFFIX;

exports.up = async function up() {
  // Nothing to change: the rules exist (20261023100000 seeded them). This migration only guards the rollback.
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('service_discount_rules'))) return;
  for (const { service_key: key } of frozen.SERVICES) {
    const row = await knex('service_discount_rules').where({ service_key: key }).first();
    if (!row || !String(row.notes || '').includes(frozen.MARKER)) continue;
    if (!ruleWasEdited(row)) continue;
    await knex('service_discount_rules').where({ service_key: key }).update({ notes: strippedNotes(row.notes) });
    console.warn(`[mosquito-misting-discount-rules-guard] down: ${key} was edited by an operator - insertion marker stripped, the rule is kept on rollback`);
  }
};
