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
 * audit_log; `down` leaves the data as corrected and appends a rollback
 * event (see the note on it). No customer communications: pure SQL.
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
    // The joined customers rows are locked too (FOR UPDATE OF cp, c) so a
    // contact_role change cannot commit between this selection and the
    // id-based UPDATE below.
    let managerRows = [];
    let managerIds = [];
    let inferredOnManager = [];
    if (await trx.schema.hasColumn('customers', 'contact_role')) {
      const managers = trx('customer_properties as cp')
        .join('customers as c', 'c.id', 'cp.customer_id')
        .where('c.contact_role', 'property_manager')
        .whereRaw("cp.relationship IS DISTINCT FROM 'managed_for_client'");
      if (inferredIds.length) managers.whereNotIn('cp.id', inferredIds);
      managerRows = await managers.select('cp.id', 'cp.relationship').forUpdate('cp', 'c');
      inferredOnManager = inferredIds.length
        ? (await trx('customer_properties as cp')
          .join('customers as c', 'c.id', 'cp.customer_id')
          .where('c.contact_role', 'property_manager')
          .whereIn('cp.id', inferredIds)
          .select('cp.id')
          .forUpdate('c')).map((r) => r.id)
        : [];
      managerIds = managerRows.map((r) => r.id).concat(inferredOnManager);
    }

    // Stamped after the locked snapshots, for the audit record only (`down`
    // does not use it — see the note there).
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
  // Deliberate no-op for the data: the values this migration cleared were
  // occupancy-derived guesses, not office input, and no stored timestamp can
  // prove a row went untouched afterwards (a PATCH captures updated_at before
  // it waits on this migration's row lock, so it can commit later with an
  // earlier stamp). Every prior value is in the AUDIT_ACTION audit_log row for
  // a deliberate, per-row manual restore; this only appends the rollback event
  // (audit_log is append-only).
  if (!(await knex.schema.hasTable('audit_log'))) return;
  const record = await knex('audit_log').where({ action: AUDIT_ACTION }).orderBy('created_at', 'desc').first('id');
  if (!record) {
    console.log('[20260906000050] no audit record — nothing to revert');
    return;
  }
  const { recordAuditEvent } = require('../../services/audit-log');
  await recordAuditEvent({
    actor_type: 'system:migration',
    action: AUDIT_ROLLBACK_ACTION,
    resource_type: 'customer_properties',
    critical: true,
    metadata: {
      reverted_count: 0,
      from_audit_id: record.id,
      note: 'data left as corrected; prior values remain on the referenced audit row for manual restore',
    },
  });
  console.log('[20260906000050] rollback recorded; relationship values left as corrected');
};
