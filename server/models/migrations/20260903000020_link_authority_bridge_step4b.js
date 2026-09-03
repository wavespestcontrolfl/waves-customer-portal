/**
 * Backlink Manager v2 — step 4b: the authority bridge's schema
 * (docs/design/backlink-manager-plan.md §3.3b, §3.6b, §6.3 1b — step 4 PR 2a).
 *
 * Additive and reversible. Lands:
 *  - `seo_link_floor_waivers` (§6.3 1b): the owner's "Acquire anyway" — an
 *    immutable record of exactly which quality floors were waived at which
 *    values, bound to the floors-inputs hash. NEVER an approval and never a
 *    dimension level (OWNER_OVERRIDE is this row's audit label only).
 *  - `seo_link_approvals` (§3.6b): one immutable row per OWNER_* click,
 *    freezing the dimension's inputs it approved. Schema only here — the
 *    Owner-queue cards (PR 2b) write it; the bridge only invalidates rows
 *    whose frozen inputs no longer match.
 *  - `seo_link_placement_authorities` gains the §3.3b instance columns the
 *    bridge writes (instance_kind, reason, satisfied_reason, ended_at /
 *    end_outcome, accepted_terms_hash), FKs to the two new tables, and the
 *    ONE-OPEN-INSTANCE rule: partial UNIQUE (prospect_id, dimension,
 *    instance_kind) WHERE ended_at IS NULL.
 *  - `seo_link_prospects.payment_group_id` (§3.3 / bridge): account_wide fee
 *    siblings share one group whose anchor is the first placement's id.
 *
 * Enum literals are FROZEN copies of services/seo/link-registry.js —
 * server/tests/backlink-authority-bridge-step4b-migration.test.js pins them
 * equal. A changed enum is a NEW migration that swaps the CHECK.
 */

const AUTHORITY_DIMENSIONS = ['execution', 'payment', 'communication'];
const APPROVAL_DECISIONS = ['approved', 'rejected', 'watch'];
const APPROVAL_ACTIONS = ['acquire', 'accept_terms', 'purchase', 'renewal', 'outreach_send', 'outreach_followup'];
const APPROVABLE_LEVELS = ['OWNER_FREE', 'OWNER_ACCOUNT', 'OWNER_OUTREACH', 'OWNER_PAYMENT', 'OWNER_MEMBERSHIP', 'OWNER_LEGAL', 'OWNER_HUMAN_STEP'];
const SATISFIED_REASONS = ['sent', 'placed', 'charged', 'manual_charged', 'no_payment_required', 'human_step_done', 'group_purchase'];
const END_OUTCOMES = ['failed', 'skipped', 'not_sent', 'voided', 'superseded', 'terms_changed', 'lost', 'human_step_done', 'path_failed_after_charge'];

const quoted = (arr) => arr.map((v) => `'${v}'`).join(', ');
const check = (table, name, expr) => `ALTER TABLE ${table} ADD CONSTRAINT ${name} CHECK (${expr})`;
const inSet = (col, arr, { nullable = false } = {}) => (nullable ? `${col} IS NULL OR ${col} IN (${quoted(arr)})` : `${col} IN (${quoted(arr)})`);

const AUTH = 'seo_link_placement_authorities';
const OPEN_INSTANCE_INDEX = 'seo_link_placement_authorities_open_instance_uniq';
const WAIVER_ACTIVE_INDEX = 'seo_link_floor_waivers_active_idx';

exports.up = async function up(knex) {
  // ---- §6.3 1b floor waivers ---------------------------------------------
  if (!(await knex.schema.hasTable('seo_link_floor_waivers'))) {
    await knex.schema.createTable('seo_link_floor_waivers', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('domain_id').notNullable().references('id').inTable('seo_link_domains').onDelete('CASCADE');
      t.uuid('path_id').notNullable().references('id').inTable('seo_link_acquisition_paths').onDelete('CASCADE');
      t.jsonb('overridden_floors').notNullable();   // [{ floor, value, threshold }] — exactly what the owner looked at
      t.text('decision_inputs_hash').notNullable(); // floorInputsHash at the click; a moved floor/input invalidates
      t.text('note');
      t.string('approved_by').notNullable();
      t.timestamp('approved_at').notNullable().defaultTo(knex.fn.now());
      t.timestamp('invalidated_at');
      t.text('invalidated_reason');
      t.timestamps(true, true);
    });
    await knex.raw(`CREATE INDEX IF NOT EXISTS ${WAIVER_ACTIVE_INDEX} ON seo_link_floor_waivers (domain_id, path_id) WHERE invalidated_at IS NULL`);
  }

  // ---- §3.6b approvals -----------------------------------------------------
  if (!(await knex.schema.hasTable('seo_link_approvals'))) {
    await knex.schema.createTable('seo_link_approvals', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('prospect_id').notNullable().references('id').inTable('seo_link_prospects').onDelete('CASCADE');
      t.uuid('path_id').notNullable().references('id').inTable('seo_link_acquisition_paths').onDelete('CASCADE');
      t.integer('path_revision').notNullable();     // the path's revision_<dimension> at approval time
      t.text('decision_inputs_hash').notNullable(); // this dimension's inputs only
      t.boolean('money_action').notNullable();      // = (dimension = 'payment'); same-row so the money CHECKs can see it
      t.string('decision').notNullable();
      t.string('authority').notNullable();          // the OWNER_* level granted
      t.integer('approved_amount_cents');
      t.integer('max_payable_cents');               // IMMUTABLE ceiling = approved + tolerance AS OF approval
      t.jsonb('terms_snapshot').notNullable();      // exactly the fields of this dimension's decision_inputs
      t.string('dimension').notNullable();
      t.string('action').notNullable();
      t.text('instance_key').notNullable();         // must equal the authority row's instance_key it attaches to
      t.text('action_hash');                        // send/followup: sha256(recipient, subject, body); renewal: the period key
      t.string('approved_by').notNullable();
      t.timestamp('approved_at').notNullable().defaultTo(knex.fn.now());
      t.timestamp('invalidated_at');
      t.text('invalidated_reason');
      t.timestamp('consumed_at');
      t.timestamps(true, true);
      t.index(['prospect_id', 'dimension', 'instance_key']);
    });
    await knex.raw(check('seo_link_approvals', 'seo_link_approvals_decision_check', inSet('decision', APPROVAL_DECISIONS)));
    await knex.raw(check('seo_link_approvals', 'seo_link_approvals_authority_check', inSet('authority', APPROVABLE_LEVELS)));
    await knex.raw(check('seo_link_approvals', 'seo_link_approvals_dimension_check', inSet('dimension', AUTHORITY_DIMENSIONS)));
    await knex.raw(check('seo_link_approvals', 'seo_link_approvals_action_check', inSet('action', APPROVAL_ACTIONS)));
    await knex.raw(check('seo_link_approvals', 'seo_link_approvals_dimension_action_check', [
      "(dimension = 'execution' AND action IN ('acquire', 'accept_terms'))",
      "(dimension = 'payment' AND action IN ('purchase', 'renewal'))",
      "(dimension = 'communication' AND action IN ('outreach_send', 'outreach_followup'))",
    ].join(' OR ')));
    await knex.raw(check('seo_link_approvals', 'seo_link_approvals_money_action_check', "money_action = (dimension = 'payment')"));
    // a paid APPROVAL without a ceiling cannot exist; a rejected/watch decision carries no approved terms
    await knex.raw(check('seo_link_approvals', 'seo_link_approvals_money_terms_check', [
      "(NOT (money_action AND decision = 'approved') OR (approved_amount_cents IS NOT NULL AND approved_amount_cents > 0 AND max_payable_cents IS NOT NULL AND max_payable_cents >= approved_amount_cents))",
      "(decision = 'approved' OR (approved_amount_cents IS NULL AND max_payable_cents IS NULL))",
      '(money_action OR (approved_amount_cents IS NULL AND max_payable_cents IS NULL))',
    ].join(' AND ')));
  }

  // ---- §3.3b instance columns on the authority rows --------------------------
  const has = async (col) => knex.schema.hasColumn(AUTH, col);
  if (!(await has('instance_kind'))) {
    await knex.schema.alterTable(AUTH, (t) => {
      t.string('instance_kind').notNullable().defaultTo('-');
      t.text('reason');
      t.string('satisfied_reason');
      t.timestamp('ended_at');
      t.string('end_outcome');
      t.text('accepted_terms_hash');
    });
    // the kind is the `${kind}` half of instance_key — persisted explicitly so the open-instance rule is indexable
    await knex.raw(`UPDATE ${AUTH} SET instance_kind = split_part(instance_key, ':', 1) WHERE instance_kind = '-' AND instance_key NOT LIKE '-:%'`);
    await knex.raw(check(AUTH, 'seo_link_placement_authorities_satisfied_check', '(satisfied_at IS NULL) = (satisfied_reason IS NULL)'));
    await knex.raw(check(AUTH, 'seo_link_placement_authorities_satisfied_reason_check', inSet('satisfied_reason', SATISFIED_REASONS, { nullable: true })));
    await knex.raw(check(AUTH, 'seo_link_placement_authorities_ended_check', '(ended_at IS NULL) = (end_outcome IS NULL)'));
    await knex.raw(check(AUTH, 'seo_link_placement_authorities_end_outcome_check', inSet('end_outcome', END_OUTCOMES, { nullable: true })));
    await knex.raw(check(AUTH, 'seo_link_placement_authorities_accepted_terms_check', "accepted_terms_hash IS NULL OR dimension = 'execution'"));
    await knex.raw(`ALTER TABLE ${AUTH} ADD CONSTRAINT seo_link_placement_authorities_approval_id_fkey FOREIGN KEY (approval_id) REFERENCES seo_link_approvals(id) ON DELETE SET NULL`);
    await knex.raw(`ALTER TABLE ${AUTH} ADD CONSTRAINT seo_link_placement_authorities_floor_waiver_id_fkey FOREIGN KEY (floor_waiver_id) REFERENCES seo_link_floor_waivers(id) ON DELETE SET NULL`);
  }
  // exactly ONE open (current) instance per (prospect, dimension, kind)
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS ${OPEN_INSTANCE_INDEX} ON ${AUTH} (prospect_id, dimension, instance_kind) WHERE ended_at IS NULL`);

  // ---- payment group on placements --------------------------------------------
  if (!(await knex.schema.hasColumn('seo_link_prospects', 'payment_group_id'))) {
    await knex.schema.alterTable('seo_link_prospects', (t) => {
      t.uuid('payment_group_id').references('id').inTable('seo_link_prospects').onDelete('SET NULL');
      t.index(['payment_group_id']);
    });
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasColumn('seo_link_prospects', 'payment_group_id')) {
    await knex.schema.alterTable('seo_link_prospects', (t) => { t.dropColumn('payment_group_id'); });
  }
  await knex.raw(`DROP INDEX IF EXISTS ${OPEN_INSTANCE_INDEX}`);
  if (await knex.schema.hasColumn(AUTH, 'instance_kind')) {
    for (const c of ['satisfied_check', 'satisfied_reason_check', 'ended_check', 'end_outcome_check', 'accepted_terms_check', 'approval_id_fkey', 'floor_waiver_id_fkey']) {
      await knex.raw(`ALTER TABLE ${AUTH} DROP CONSTRAINT IF EXISTS seo_link_placement_authorities_${c}`);
    }
    await knex.schema.alterTable(AUTH, (t) => {
      t.dropColumn('instance_kind'); t.dropColumn('reason'); t.dropColumn('satisfied_reason');
      t.dropColumn('ended_at'); t.dropColumn('end_outcome'); t.dropColumn('accepted_terms_hash');
    });
  }
  await knex.schema.dropTableIfExists('seo_link_approvals');
  await knex.raw(`DROP INDEX IF EXISTS ${WAIVER_ACTIVE_INDEX}`);
  await knex.schema.dropTableIfExists('seo_link_floor_waivers');
};
