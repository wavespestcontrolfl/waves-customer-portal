/**
 * Backlink Manager v2 — step 4a: acquisition-authority policy
 * (docs/design/backlink-manager-plan.md §3.8, §6.1, §6.2, §14 step 4 — PR 1 of 4).
 *
 * Additive and reversible. Creates the single-row `seo_link_policy` (the ONLY
 * source of authority/spend thresholds; env may only tighten) seeded with the
 * §6.2 SHIPPED DEFAULTS — every AUTO capability off/null, so enabling
 * GATE_LINK_AUTHORITY changes nothing until the owner edits the Policy panel —
 * and `seo_link_policy_audit` (who, when, field, old → new; one row per edited
 * field). Widens `seo_link_placement_authorities.level` with
 * OWNER_INPUT_REQUIRED (§6.1: a valid paid path whose price is unparseable or
 * whose currency is unknown parks for a price-entry card).
 *
 * Nothing reads the policy row yet: the bridge job, owner cards and the claim
 * predicate arrive in the later step-4 PRs. Enum literals are FROZEN copies of
 * services/seo/link-registry.js — server/tests/backlink-authority-policy-step4a-migration.test.js
 * pins them equal. A changed enum is a NEW migration that swaps the CHECK.
 */

const AUTHORITY_LEVELS = ['AUTO_FREE', 'AUTO_ACCOUNT', 'AUTO_OUTREACH', 'AUTO_PAID_WITHIN_POLICY', 'OWNER_FREE', 'OWNER_ACCOUNT', 'OWNER_OUTREACH', 'OWNER_PAYMENT', 'OWNER_MANUAL_PAYMENT', 'OWNER_MEMBERSHIP', 'OWNER_LEGAL', 'OWNER_HUMAN_STEP', 'DENY', 'INVALID', 'OWNER_INPUT_REQUIRED'];
const AUTHORITY_LEVELS_STEP1 = AUTHORITY_LEVELS.slice(0, 14);
const ATTEMPT_PROVIDERS = ['deterministic_runner', 'openai_cua', 'claude_cu', 'stagehand', 'grok', 'human'];

const quoted = (arr) => arr.map((v) => `'${v}'`).join(', ');
const check = (table, name, expr) => `ALTER TABLE ${table} ADD CONSTRAINT ${name} CHECK (${expr})`;
const inSet = (col, arr) => `${col} IN (${quoted(arr)})`;

const LEVEL_CHECK = 'seo_link_placement_authorities_level_check';

exports.up = async function up(knex) {
  // ---- §3.8 / §6.2 policy row -------------------------------------------
  if (!(await knex.schema.hasTable('seo_link_policy'))) {
    await knex.schema.createTable('seo_link_policy', (t) => {
      t.integer('id').primary();                       // CHECK (id = 1): exactly one row
      t.boolean('auto_free_acquisition').notNullable().defaultTo(false);
      t.boolean('auto_account_creation').notNullable().defaultTo(false);
      t.integer('auto_outreach_min_score');            // null ⇒ AUTO_OUTREACH never granted
      t.integer('auto_outreach_daily_cap').notNullable().defaultTo(0);
      t.integer('auto_submission_daily_cap').notNullable().defaultTo(0);
      t.integer('owner_price_tolerance_cents').notNullable().defaultTo(0);
      t.integer('presentment_window_days').notNullable().defaultTo(10); // may only be raised
      t.integer('monthly_paid_budget_cents').notNullable().defaultTo(0);
      t.integer('owner_monthly_budget_cents');         // null ⇒ no software cap on owner-approved spend
      t.integer('max_auto_purchase_cents').notNullable().defaultTo(0);
      t.integer('auto_paid_min_score');
      t.decimal('auto_paid_min_d30_confidence', 3, 2);
      t.integer('min_score').notNullable().defaultTo(60);
      t.boolean('membership_requires_owner').notNullable().defaultTo(true);
      t.boolean('legal_attestation_requires_owner').notNullable().defaultTo(true);
      t.decimal('min_path_confidence', 3, 2).notNullable().defaultTo(0.6);
      t.integer('max_spam_score').notNullable().defaultTo(10);
      t.string('preferred_provider').notNullable().defaultTo('deterministic_runner');
      t.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
      t.string('updated_by');
    });
    await knex.raw(check('seo_link_policy', 'seo_link_policy_singleton_check', 'id = 1'));
    await knex.raw(check('seo_link_policy', 'seo_link_policy_preferred_provider_check', inSet('preferred_provider', ATTEMPT_PROVIDERS)));
    await knex.raw(check('seo_link_policy', 'seo_link_policy_nonnegative_check', [
      'auto_outreach_daily_cap >= 0', 'auto_submission_daily_cap >= 0', 'owner_price_tolerance_cents >= 0',
      'presentment_window_days >= 0', 'monthly_paid_budget_cents >= 0', 'max_auto_purchase_cents >= 0', 'max_spam_score >= 0',
      '(owner_monthly_budget_cents IS NULL OR owner_monthly_budget_cents >= 0)',
    ].join(' AND ')));
    await knex.raw(check('seo_link_policy', 'seo_link_policy_ranges_check', [
      '(auto_outreach_min_score IS NULL OR (auto_outreach_min_score >= 0 AND auto_outreach_min_score <= 100))',
      '(auto_paid_min_score IS NULL OR (auto_paid_min_score >= 0 AND auto_paid_min_score <= 100))',
      '(min_score >= 0 AND min_score <= 100)',
      '(auto_paid_min_d30_confidence IS NULL OR (auto_paid_min_d30_confidence >= 0 AND auto_paid_min_d30_confidence <= 1))',
      '(min_path_confidence >= 0 AND min_path_confidence <= 1)',
    ].join(' AND ')));
  }
  // the shipped defaults, exactly once — an existing row (admin-edited) is never overwritten
  await knex.raw('INSERT INTO seo_link_policy (id) VALUES (1) ON CONFLICT (id) DO NOTHING');

  // ---- §3.8 audit -------------------------------------------------------
  if (!(await knex.schema.hasTable('seo_link_policy_audit'))) {
    await knex.schema.createTable('seo_link_policy_audit', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.string('field').notNullable();
      t.text('old_value');
      t.text('new_value');
      t.string('changed_by');
      t.timestamp('changed_at').notNullable().defaultTo(knex.fn.now());
      t.index(['changed_at']);
    });
  }

  // ---- §6.1 OWNER_INPUT_REQUIRED level ----------------------------------
  await knex.raw(`ALTER TABLE seo_link_placement_authorities DROP CONSTRAINT IF EXISTS ${LEVEL_CHECK}`);
  await knex.raw(check('seo_link_placement_authorities', LEVEL_CHECK, inSet('level', AUTHORITY_LEVELS)));
};

exports.down = async function down(knex) {
  // the step-1 level set is restored only when no row carries the new level
  // (none can before the step-4 bridge ships); a row that does blocks the down.
  await knex.raw(`ALTER TABLE seo_link_placement_authorities DROP CONSTRAINT IF EXISTS ${LEVEL_CHECK}`);
  await knex.raw(check('seo_link_placement_authorities', LEVEL_CHECK, inSet('level', AUTHORITY_LEVELS_STEP1)));
  await knex.schema.dropTableIfExists('seo_link_policy_audit');
  await knex.schema.dropTableIfExists('seo_link_policy');
};
