// One-time backfill: service_report_notify_primary false -> true.
//
// Owner-authorized 2026-07-24. Companion to 20260725000003 (default for future
// rows only). Unlike the appointment sibling, this one repairs customers who are
// ALREADY broken: verified read-only against prod 2026-07-24, THREE account
// holders were receiving none of their own service reports because a contact
// email existed and their stored value was the old `false` default —
// Robert Meelan, Henry Palmer, Chris Whitney. Their reports were going only to
// the on-location contact.
//
// Distribution at that time: 1142 `false`, 5 `true`, 0 NULL.
//
// The 3 with contact emails are the observable breakage; the rest carry the same
// latent trap (adding a contact email would drop them next). A stored `false`
// here is the old default rather than a deliberate choice — the admin checkbox
// was the only way to set it and it read `=== true`, so an untouched row and an
// opted-out row were indistinguishable. From here on a `false` can only be
// written by someone actively unticking it.
//
// Fires ZERO customer communications: pure SQL against notification_prefs, no
// application send path involved.
//
// Reversible: `up` records the exact customer_ids it flipped in audit_log, and
// `down` restores only those rows, and only if still true, so a later genuine
// opt-out is not clobbered by a rollback.
// updated_at is deliberately NOT restamped (codex #2992 P2): notification_prefs
// .updated_at is published as the marketing-SMS consent `capturedAt` by
// marketingSmsConsentBasisForContract, so a system correction must not rewrite
// consent provenance. It also gives `down` its "unchanged since our write"
// marker — see the appointment sibling 20260725000002.
const AUDIT_ACTION = 'migration.service_report_notify_primary_backfill';
const AUDIT_ROLLBACK_ACTION = 'migration.service_report_notify_primary_backfill_rolled_back';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('notification_prefs'))) return;
  if (!(await knex.schema.hasColumn('notification_prefs', 'service_report_notify_primary'))) return;

  const targets = await knex('notification_prefs')
    .where({ service_report_notify_primary: false })
    .pluck('customer_id');
  if (!targets.length) {
    console.log('[20260725000004] no false rows — nothing to backfill');
    return;
  }

  // How many were ALREADY broken (a distinct contact email existed, so the
  // holder was actually being skipped) vs merely latent. Surfaced in the deploy
  // log so the real repair count is visible rather than inferred.
  let alreadyBroken = 0;
  if (await knex.schema.hasTable('customers')) {
    const [row] = await knex('customers')
      .whereIn('id', targets)
      .where(function hasAnyContactEmail() {
        this.whereRaw("coalesce(service_contact_email,'')  <> ''")
          .orWhereRaw("coalesce(service_contact2_email,'') <> ''")
          .orWhereRaw("coalesce(service_contact3_email,'') <> ''");
      })
      .count({ n: '*' });
    alreadyBroken = Number(row?.n || 0);
  }

  const flippedAt = new Date();
  await knex.transaction(async (trx) => {
    // RETURNING the ids actually written — a row changed concurrently between
    // the pluck and this update is skipped by the `= false` guard and must not
    // be recorded as ours (codex #2992 P2).
    const flipped = await trx('notification_prefs')
      .whereIn('customer_id', targets)
      .where({ service_report_notify_primary: false })
      .update({ service_report_notify_primary: true })
      .returning('customer_id');
    const flippedIds = flipped.map((r) => (typeof r === 'string' ? r : r.customer_id)).filter(Boolean);

    const { recordAuditEvent } = require('../../services/audit-log');
    await recordAuditEvent({
      actor_type: 'system:migration',
      action: AUDIT_ACTION,
      resource_type: 'notification_prefs',
      critical: true,
      trx,
      metadata: {
        reason: 'service_report_notify_primary opt-in default silently stopped account holders receiving their own service reports',
        updated_count: flippedIds.length,
        already_broken_with_contact_email: alreadyBroken,
        flipped_at: flippedAt.toISOString(),
        customer_ids: flippedIds,
      },
    });
    console.log(`[20260725000004] backfilled ${flippedIds.length} notification_prefs row(s) to service_report_notify_primary=true (${alreadyBroken} were already missing their reports)`);
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('notification_prefs'))) return;
  if (!(await knex.schema.hasTable('audit_log'))) return;

  const record = await knex('audit_log')
    .where({ action: AUDIT_ACTION })
    .orderBy('created_at', 'desc')
    .first('id', 'metadata');
  if (!record) {
    console.log('[20260725000004] no audit record — nothing to revert');
    return;
  }
  const meta = typeof record.metadata === 'string' ? JSON.parse(record.metadata) : (record.metadata || {});
  const ids = Array.isArray(meta.customer_ids) ? meta.customer_ids : [];
  if (!ids.length) return;

  // Revert ONLY rows this migration flipped AND that nobody has touched since:
  // `up` leaves updated_at alone, so a newer timestamp means a later change
  // through the app, which must be preserved (codex #2992 P2).
  // Revert + audit atomically on the MIGRATION's own connection: passing trx
  // keeps recordAuditEvent off the service's separate db handle, and
  // critical:true means a lost audit write aborts the rollback instead of
  // leaving reverted data with no forensic record.
  await knex.transaction(async (trx) => {
    const query = trx('notification_prefs')
      .whereIn('customer_id', ids)
      .where({ service_report_notify_primary: true });
    if (meta.flipped_at) {
      query.where(function untouchedSinceBackfill() {
        this.whereNull('updated_at').orWhere('updated_at', '<=', new Date(meta.flipped_at));
      });
    }
    const reverted = await query.update({ service_report_notify_primary: false });
    const skipped = ids.length - reverted;

    // audit_log rows are NEVER deleted (20260419000005 header) — append a
    // rollback event rather than erasing the record of the rewrite.
    const { recordAuditEvent } = require('../../services/audit-log');
    await recordAuditEvent({
      actor_type: 'system:migration',
      action: AUDIT_ROLLBACK_ACTION,
      resource_type: 'notification_prefs',
      critical: true,
      trx,
      metadata: {
        reverts_audit_id: record.id,
        reverted_count: reverted,
        skipped_changed_since_backfill: skipped,
      },
    });
    console.log(`[20260725000004] rollback reverted ${reverted} row(s); left ${skipped} changed-since-backfill row(s) alone`);
  });
};
