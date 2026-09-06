/**
 * Correction to 20260906000020_customer_properties_relationship.
 *
 * That migration's first revision backfilled `relationship` from
 * occupancy_type (owner_occupied → own_home, rental_investment →
 * rental_owned). Codex r4 on #3998: occupancy is NOT ownership evidence —
 * 20260629000001 defaulted it to owner_occupied broadly and the call
 * pipeline infers it, so it says how the property is used, not whether THIS
 * customer owns it (a tenant's or a family member's owner-occupied home
 * would read as own_home). The fix was first made by editing the applied
 * file in place, which knex tracks by filename — a silent no-op wherever
 * the first revision had already run (the PR's Railway preview). The
 * original file is restored to the revision those environments ran, and
 * this migration carries the correction under its own stamp.
 *
 * Nulls the occupancy-derived values ONLY on rows nobody has edited since
 * the original backfill (customer_properties.updated_at at or before that
 * migration's knex_migrations.migration_time — the app restamps updated_at
 * on every property PATCH, the raw backfill did not), then re-asserts
 * managed_for_client for property-manager profiles. Prior values land in
 * audit_log so `down` can restore exactly those rows; the rollback appends
 * its own event. No customer communications: pure SQL.
 */
const ORIGINAL_MIGRATION = '20260906000020_customer_properties_relationship.js';
const AUDIT_ACTION = 'migration.customer_properties_relationship_backfill_correction';
const AUDIT_ROLLBACK_ACTION = 'migration.customer_properties_relationship_backfill_correction_rolled_back';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('customer_properties'))) return;
  if (!(await knex.schema.hasColumn('customer_properties', 'relationship'))) return;

  const original = await knex('knex_migrations').where({ name: ORIGINAL_MIGRATION }).first('migration_time');
  const backfilledAt = original?.migration_time ? new Date(original.migration_time) : null;

  await knex.transaction(async (trx) => {
    const inferred = trx('customer_properties')
      .where(function occupancyDerived() {
        this.where({ relationship: 'own_home', occupancy_type: 'owner_occupied' })
          .orWhere({ relationship: 'rental_owned', occupancy_type: 'rental_investment' });
      });
    if (backfilledAt) {
      inferred.where(function untouchedSinceBackfill() {
        this.whereNull('updated_at').orWhere('updated_at', '<=', backfilledAt);
      });
    }
    // Lock the snapshot so a concurrent property PATCH cannot land between
    // the SELECT and the UPDATE and be recorded with a stale prior value.
    const before = await inferred.select('id', 'relationship').forUpdate();
    const ids = before.map((r) => r.id);
    let cleared = 0;
    if (ids.length) {
      cleared = await trx('customer_properties').whereIn('id', ids).update({ relationship: null });
    }

    let managed = 0;
    if (await trx.schema.hasColumn('customers', 'contact_role')) {
      const res = await trx.raw(
        "UPDATE customer_properties cp SET relationship = 'managed_for_client' "
        + "FROM customers c WHERE c.id = cp.customer_id AND c.contact_role = 'property_manager' "
        + "AND cp.relationship IS DISTINCT FROM 'managed_for_client'",
      );
      managed = res?.rowCount || 0;
    }

    if (await trx.schema.hasTable('audit_log')) {
      const { recordAuditEvent } = require('../../services/audit-log');
      await recordAuditEvent({
        actor_type: 'system:migration',
        action: AUDIT_ACTION,
        resource_type: 'customer_properties',
        critical: true,
        trx,
        metadata: {
          reason: 'occupancy_type is not ownership evidence (Codex r4 on #3998); occupancy-derived relationship values cleared, manager-only backfill re-asserted',
          original_migration: ORIGINAL_MIGRATION,
          original_backfilled_at: backfilledAt ? backfilledAt.toISOString() : null,
          cleared_count: cleared,
          managed_for_client_set_count: managed,
          prior_values: before,
        },
      });
    }
    console.log(`[20260906000050] cleared ${cleared} occupancy-derived relationship value(s); set managed_for_client on ${managed} row(s)`);
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('customer_properties')) || !(await knex.schema.hasTable('audit_log'))) return;
  if (!(await knex.schema.hasColumn('customer_properties', 'relationship'))) return;
  const record = await knex('audit_log').where({ action: AUDIT_ACTION }).orderBy('created_at', 'desc').first('id', 'metadata');
  if (!record) {
    console.log('[20260906000050] no audit record — nothing to revert');
    return;
  }
  const meta = typeof record.metadata === 'string' ? JSON.parse(record.metadata) : (record.metadata || {});
  const prior = Array.isArray(meta.prior_values) ? meta.prior_values : [];

  await knex.transaction(async (trx) => {
    let reverted = 0;
    for (const row of prior) {
      // Restore only rows still NULL — an office edit since the correction wins.
      reverted += await trx('customer_properties')
        .where({ id: row.id })
        .whereNull('relationship')
        .update({ relationship: row.relationship });
    }
    const { recordAuditEvent } = require('../../services/audit-log');
    await recordAuditEvent({
      actor_type: 'system:migration',
      action: AUDIT_ROLLBACK_ACTION,
      resource_type: 'customer_properties',
      critical: true,
      trx,
      metadata: { reverted_count: reverted, from_audit_id: record.id },
    });
    console.log(`[20260906000050] restored ${reverted} row(s)`);
  });
};
