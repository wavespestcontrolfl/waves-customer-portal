/**
 * Estimate versioning — immutable history table for estimate line-item changes.
 *
 * Ships as the first piece of the estimate funnel consolidation PR. Addresses
 * the "no audit of what was offered vs. accepted" gap: every write to an
 * estimate's pricing body goes through estimate_versions as a new row;
 * estimates.current_version_id / accepted_version_id point at the right
 * version for admin display and customer-accepted record respectively.
 *
 * This migration is SCHEMA ONLY. Callers (EstimateCreator in the next commit)
 * are responsible for writing version rows. Backfill here seeds one v1 row
 * per existing estimate so every row has a current_version_id before the
 * NOT NULL constraint lands.
 *
 * Kept columns on estimates (estimate_data, monthly_total, annual_total,
 * onetime_total, waveguard_tier) mirror the current version for query
 * convenience. Not dropped here — read sites need to be audited in a
 * follow-up PR before the mirror columns come off.
 *
 * Vocabularies (matched to existing estimates.source so BI queries don't
 * need translation):
 *   created_by_type: manual | lead_webhook | lead_agent | voice_agent
 *                    | ai_agent | self_booked
 *   pricing_source:  server_engine | client_submitted | placeholder
 *
 * Note on pricing_mismatch: column exists for forward compatibility. No
 * code writes to it in this PR. Mismatch detection waits for Session 11
 * when the modular server engine emits tier arrays / modifiers / urgency /
 * specItems that the client-side legacy engine currently produces. Until
 * then there is nothing to compare against, so the check would be noise.
 */

exports.up = async function (knex) {
  await knex.schema.createTable('estimate_versions', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('estimate_id').notNullable().references('id').inTable('estimates').onDelete('CASCADE');
    t.integer('version_number').notNullable();
    t.jsonb('estimate_data').notNullable();
    t.decimal('monthly_total', 10, 2);
    t.decimal('annual_total', 10, 2);
    t.decimal('onetime_total', 10, 2);
    t.string('waveguard_tier', 20);
    t.string('pricing_version', 20);
    t.string('pricing_source', 20).notNullable();
    t.string('created_by_type', 30).notNullable();
    t.uuid('created_by_id');
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.text('reason');
    t.jsonb('pricing_mismatch');
  });

  await knex.raw(
    'CREATE UNIQUE INDEX idx_estimate_versions_unique ' +
    'ON estimate_versions (estimate_id, version_number)'
  );
  await knex.raw(
    'CREATE INDEX idx_estimate_versions_estimate ' +
    'ON estimate_versions (estimate_id, created_at DESC)'
  );

  // Version pointers on the estimates row. Nullable initially so backfill
  // can complete before we flip current_version_id to NOT NULL.
  await knex.schema.alterTable('estimates', (t) => {
    t.uuid('current_version_id').references('id').inTable('estimate_versions');
    t.uuid('accepted_version_id').references('id').inTable('estimate_versions');
  });

  // Backfill: one v1 row per existing estimate, from the mirror columns.
  //
  // created_by_type maps from existing estimates.source (same vocabulary).
  // Rows that predate the source column get 'manual' — consistent with how
  // admin-created estimates (which never set source explicitly) have been
  // writing since day one.
  //
  // pricing_source is 'client_submitted' for all backfilled rows, per the
  // spec — even draft placeholders from lead-webhook/voice-agent. The
  // 'placeholder' value only appears on rows created after EstimateCreator
  // ships in a subsequent commit. Labeling existing drafts as client_submitted
  // is technically imprecise but matches how the code that wrote them
  // treated them (no engine call, no explicit placeholder stamp).
  //
  // reason='backfilled' is a deliberate literal — distinguishable from the
  // forward 'initial' / 'lead_webhook_placeholder' / etc values EstimateCreator
  // will write, so BI can separate "this version pre-dated versioning" from
  // "this is how the estimate was created going forward."
  await knex.raw(`
    INSERT INTO estimate_versions (
      estimate_id, version_number, estimate_data,
      monthly_total, annual_total, onetime_total,
      waveguard_tier, pricing_version, pricing_source,
      created_by_type, created_by_id, created_at, reason
    )
    SELECT
      id,
      1,
      COALESCE(estimate_data, '{}'::jsonb),
      monthly_total,
      annual_total,
      onetime_total,
      waveguard_tier,
      pricing_version,
      'client_submitted',
      COALESCE(source, 'manual'),
      created_by_technician_id,
      created_at,
      'backfilled'
    FROM estimates
  `);

  // Link every row to its v1 version.
  await knex.raw(`
    UPDATE estimates e
       SET current_version_id = v.id
      FROM estimate_versions v
     WHERE v.estimate_id = e.id AND v.version_number = 1
  `);

  // Already-accepted estimates: accepted_version_id = current_version_id
  // (there's only one version per estimate at this point, and that IS what
  // the customer accepted — it's just been mutating silently since then).
  await knex.raw(`
    UPDATE estimates
       SET accepted_version_id = current_version_id
     WHERE status = 'accepted'
  `);

  // Now safe to require current_version_id on every row.
  await knex.raw(
    'ALTER TABLE estimates ALTER COLUMN current_version_id SET NOT NULL'
  );
};

exports.down = async function (knex) {
  // Drop the NOT NULL first so ALTER TABLE DROP COLUMN doesn't fight a constraint.
  await knex.raw(
    'ALTER TABLE estimates ALTER COLUMN current_version_id DROP NOT NULL'
  );
  await knex.schema.alterTable('estimates', (t) => {
    t.dropColumn('current_version_id');
    t.dropColumn('accepted_version_id');
  });
  await knex.raw('DROP INDEX IF EXISTS idx_estimate_versions_estimate');
  await knex.raw('DROP INDEX IF EXISTS idx_estimate_versions_unique');
  await knex.schema.dropTableIfExists('estimate_versions');
};
