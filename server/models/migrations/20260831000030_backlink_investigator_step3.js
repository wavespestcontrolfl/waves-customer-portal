/**
 * Backlink Manager v2 — step 3: path investigator
 * (docs/design/backlink-manager-plan.md §3.2 currency/fee_scope, §5, §14 step 3).
 *
 * Additive and reversible. Adds the two §3.2 payment-input columns the
 * investigator writes and steps 1–2 deferred:
 *   - seo_link_acquisition_paths.currency — NOT NULL DEFAULT 'unknown';
 *     'USD' only with authoritative evidence (§5 currency gate), 'foreign' =
 *     confirmed non-USD (manual settlement only, step 4+), 'unknown' = parks
 *     for the step-4 price-entry card. No conversion is ever performed.
 *   - seo_link_acquisition_paths.fee_scope — nullable; required (by the
 *     investigator schema, and by the §6.3 validity step in step 4) when
 *     payment_required.
 *
 * `currency_attestation_id` (§3.2) is deliberately NOT added here — its FK
 * target `seo_link_currency_attestations` is a step-4 owner-flow table.
 *
 * Enum literals below are FROZEN copies of services/seo/link-registry.js —
 * server/tests/backlink-investigator-step3-migration.test.js pins them equal.
 * A changed enum is a NEW migration that swaps the CHECK, never an edit here.
 */

const CURRENCIES = ['USD', 'unknown', 'foreign'];
const FEE_SCOPES = ['per_location', 'account_wide'];

const quoted = (arr) => arr.map((v) => `'${v}'`).join(', ');
const check = (table, name, expr) => `ALTER TABLE ${table} ADD CONSTRAINT ${name} CHECK (${expr})`;
const inSet = (col, arr, { nullable = false } = {}) => (nullable ? `${col} IS NULL OR ${col} IN (${quoted(arr)})` : `${col} IN (${quoted(arr)})`);

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('seo_link_acquisition_paths'))) return;
  const cols = await knex('seo_link_acquisition_paths').columnInfo();
  if (!cols.currency) {
    await knex.schema.alterTable('seo_link_acquisition_paths', (t) => {
      t.string('currency').notNullable().defaultTo('unknown');
    });
    await knex.raw(check('seo_link_acquisition_paths', 'seo_link_acquisition_paths_currency_check', inSet('currency', CURRENCIES)));
  }
  if (!cols.fee_scope) {
    await knex.schema.alterTable('seo_link_acquisition_paths', (t) => {
      t.string('fee_scope');
    });
    await knex.raw(check('seo_link_acquisition_paths', 'seo_link_acquisition_paths_fee_scope_check', inSet('fee_scope', FEE_SCOPES, { nullable: true })));
  }
};

exports.down = async function down(knex) {
  await knex.raw('ALTER TABLE seo_link_acquisition_paths DROP COLUMN IF EXISTS fee_scope');
  await knex.raw('ALTER TABLE seo_link_acquisition_paths DROP COLUMN IF EXISTS currency');
};
