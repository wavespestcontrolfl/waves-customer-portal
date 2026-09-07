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
 * on every property PATCH, the raw backfill did not). The original
 * migration's own managed_for_client stamp on property-manager rows stands
 * (it was and is correct) and is NOT re-asserted: an office edit made after
 * it wins. Prior values, plus a retrospective snapshot of the manager rows
 * the original stamped without an audit event, land in audit_log; `down`
 * leaves the data as corrected and appends a rollback event (see the note on
 * it). No customer communications: pure SQL.
 */
const ORIGINAL_MIGRATION = '20260906000020_customer_properties_relationship.js';
const AUDIT_ACTION = 'migration.customer_properties_relationship_backfill_correction';
const AUDIT_ROLLBACK_ACTION = 'migration.customer_properties_relationship_backfill_correction_rolled_back';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('customer_properties'))) return;
  if (!(await knex.schema.hasColumn('customer_properties', 'relationship'))) return;

  const original = await knex('knex_migrations').where({ name: ORIGINAL_MIGRATION }).first('migration_time');
  const backfilledAt = original?.migration_time ? new Date(original.migration_time) : null;

  const hasContactRole = await knex.schema.hasColumn('customers', 'contact_role');
  const untouchedSinceBackfill = (qb) => (backfilledAt
    ? qb.where(function untouched() {
      this.whereNull('updated_at').orWhere('updated_at', '<=', backfilledAt);
    })
    : qb);

  await knex.transaction(async (trx) => {
    // Only customer_properties rows are locked, and only the ones this
    // migration writes; no customers row is ever locked or waited on. The
    // admin address save locks the customers row first and then updates the
    // primary property (admin-customers.js → customer-properties.js), so an
    // overlapping save can only wait on this transaction, never form a cycle
    // with it (Codex r10 P1). The snapshot is taken before the write so a
    // concurrent PATCH cannot land between SELECT and UPDATE and be recorded
    // with a stale prior.
    const inferredRows = await untouchedSinceBackfill(
      trx('customer_properties').where(function occupancyDerived() {
        this.where({ relationship: 'own_home', occupancy_type: 'owner_occupied' })
          .orWhere({ relationship: 'rental_owned', occupancy_type: 'rental_investment' });
      }),
    ).select('id', 'relationship').forUpdate();
    const inferredIds = inferredRows.map((r) => r.id);

    // Retrospective snapshot (Codex r11): the original migration created the
    // column and stamped managed_for_client on every property_manager
    // profile's rows in the same migration, without an audit event — so
    // those rows' prior value is NULL by construction. Recorded here, read
    // only, limited to rows untouched since that stamp; nothing is written
    // to them (a later office edit, if any, already won).
    let originalManagerIds = [];
    if (hasContactRole) {
      originalManagerIds = (await untouchedSinceBackfill(trx('customer_properties'))
        .where({ relationship: 'managed_for_client' })
        .whereIn('customer_id', trx('customers').select('id').where('contact_role', 'property_manager'))
        .select('id')).map((r) => r.id);
    }

    // Stamped after the locked snapshot, for the audit record only (`down`
    // does not use it — see the note there).
    const correctedAt = new Date();
    let cleared = 0;
    if (inferredIds.length) {
      cleared = await trx('customer_properties').whereIn('id', inferredIds).update({ relationship: null });
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
          reason: 'occupancy_type is not ownership evidence (Codex r4 on #3998); occupancy-derived relationship values cleared; the original manager stamp stands and is snapshotted below',
          original_migration: ORIGINAL_MIGRATION,
          original_backfilled_at: backfilledAt ? backfilledAt.toISOString() : null,
          corrected_at: correctedAt.toISOString(),
          cleared_count: cleared,
          prior_values: inferredRows,
          original_backfill_manager_rows: originalManagerIds.map((id) => ({ id, relationship: null, now: 'managed_for_client' })),
          original_backfill_manager_count: originalManagerIds.length,
        },
      });
    }
    console.log(`[20260906000050] cleared ${cleared} occupancy-derived relationship value(s); snapshotted ${originalManagerIds.length} manager row(s) stamped by the original backfill`);
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
    trx: knex,
    metadata: {
      reverted_count: 0,
      from_audit_id: record.id,
      note: 'data left as corrected; prior values remain on the referenced audit row for manual restore',
    },
  });
  console.log('[20260906000050] rollback recorded; relationship values left as corrected');
};
