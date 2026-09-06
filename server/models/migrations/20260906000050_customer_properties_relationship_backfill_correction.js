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
    // Snapshot BOTH sets before any write, locked, so `down` can restore each
    // row's real prior value and a concurrent property PATCH cannot land
    // between the SELECT and the UPDATE and be recorded with a stale prior.
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
    const inferredRows = await inferred.select('id', 'relationship').forUpdate();
    const inferredIds = inferredRows.map((r) => r.id);

    // Manager-profile rows: those not already managed_for_client are
    // snapshotted with their prior value; an inferred row on a manager profile
    // goes straight to managed_for_client, its prior value recorded once above.
    let managerRows = [];
    let managerIds = [];
    let inferredOnManager = [];
    if (await trx.schema.hasColumn('customers', 'contact_role')) {
      const managers = trx('customer_properties as cp')
        .join('customers as c', 'c.id', 'cp.customer_id')
        .where('c.contact_role', 'property_manager')
        .whereRaw("cp.relationship IS DISTINCT FROM 'managed_for_client'");
      if (inferredIds.length) managers.whereNotIn('cp.id', inferredIds);
      managerRows = await managers.select('cp.id', 'cp.relationship').forUpdate('cp');
      inferredOnManager = inferredIds.length
        ? await trx('customer_properties as cp')
          .join('customers as c', 'c.id', 'cp.customer_id')
          .where('c.contact_role', 'property_manager')
          .whereIn('cp.id', inferredIds)
          .pluck('cp.id')
        : [];
      managerIds = managerRows.map((r) => r.id).concat(inferredOnManager);
    }

    // Stamp AFTER the locked snapshots: a PATCH that held a row lock when this
    // started commits before our SELECTs return and must read as "before the
    // correction" so `down` still treats the row as untouched by the office.
    const correctedAt = new Date();
    const clearIds = inferredIds.filter((id) => !inferredOnManager.includes(id));
    let cleared = 0;
    if (clearIds.length) {
      cleared = await trx('customer_properties').whereIn('id', clearIds).update({ relationship: null });
    }
    let managed = 0;
    if (managerIds.length) {
      managed = await trx('customer_properties').whereIn('id', managerIds).update({ relationship: 'managed_for_client' });
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
          corrected_at: correctedAt.toISOString(),
          cleared_count: cleared,
          managed_for_client_set_count: managed,
          prior_values: inferredRows.concat(managerRows),
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
      // Restore only rows the office has not touched since the correction:
      // the migration's UPDATEs do not restamp updated_at, every property
      // PATCH does — so a later "Not recorded" (NULL) edit is distinguishable
      // from the NULL this migration wrote and wins.
      const query = trx('customer_properties').where({ id: row.id });
      if (meta.corrected_at) {
        query.where(function untouchedSinceCorrection() {
          this.whereNull('updated_at').orWhere('updated_at', '<=', new Date(meta.corrected_at));
        });
      }
      reverted += await query.update({ relationship: row.relationship === undefined ? null : row.relationship });
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
