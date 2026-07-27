// One-time backfill: appointment_notify_primary false -> true.
//
// Owner-authorized 2026-07-24. Companion to 20260725000001, which changed the
// DEFAULT for future rows only. Without this backfill the 1139 existing `false`
// rows keep the original trap: the first one to add an on-location contact
// silently drops the account holder from their own appointment texts (5
// accounts already hit this and were repaired by hand).
//
// Why this is safe rather than an override of real opt-outs: verified against
// prod 2026-07-24, ZERO of the 1139 `false` rows belongs to a customer with any
// on-location contact phone. For those accounts the value has never had an
// observable effect — getAppointmentContacts' `!contacts.length` safety net
// texted the holder regardless. So this flip changes nothing observable today
// while disarming the landmine. From here on, a `false` can only be written by
// someone actively opting out, and this migration never runs again.
//
// Fires ZERO customer communications: pure SQL against notification_prefs, no
// application send path involved.
//
// Reversible: `up` records the exact customer_ids it flipped in audit_log, and
// `down` restores only those rows — so an unrelated later opt-out is not
// clobbered by a rollback.
// updated_at is deliberately NOT restamped (codex #2992 P2):
// `marketingSmsConsentBasisForContract` (server/services/document-contract-delivery.js)
// publishes notification_prefs.updated_at as the marketing-SMS consent
// `capturedAt`. Restamping 1139 rows for an unrelated system correction would
// make every later marketing contract falsely claim consent was captured at
// deploy time. Leaving it untouched also gives `down` a reliable marker: a row
// this migration flipped keeps its ORIGINAL updated_at, while any later change
// through the app stamps a newer one.
const AUDIT_ACTION = 'migration.notify_primary_backfill';
const AUDIT_ROLLBACK_ACTION = 'migration.notify_primary_backfill_rolled_back';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('notification_prefs'))) return;
  if (!(await knex.schema.hasColumn('notification_prefs', 'appointment_notify_primary'))) return;

  const targets = await knex('notification_prefs')
    .where({ appointment_notify_primary: false })
    .pluck('customer_id');
  if (!targets.length) {
    console.log('[20260725000002] no false rows — nothing to backfill');
    return;
  }

  // Visibility if the data shifted between analysis and deploy: a target that
  // DOES have an on-location contact is a real behavior change for that
  // account, so surface the count in the deploy log rather than hiding it.
  let withContacts = 0;
  if (await knex.schema.hasTable('customers')) {
    const [row] = await knex('customers')
      .whereIn('id', targets)
      .where(function hasAnyContactPhone() {
        this.whereRaw("coalesce(service_contact_phone,'')  <> ''")
          .orWhereRaw("coalesce(service_contact2_phone,'') <> ''")
          .orWhereRaw("coalesce(service_contact3_phone,'') <> ''");
      })
      .count({ n: '*' });
    withContacts = Number(row?.n || 0);
  }

  const flippedAt = new Date();
  await knex.transaction(async (trx) => {
    // RETURNING the ids actually written (codex #2992 P2): a row flipped
    // concurrently between the `targets` pluck and this update is skipped by
    // the `= false` guard, and must NOT land in the audit record — otherwise a
    // later rollback would overwrite a value this migration never set.
    const flipped = await trx('notification_prefs')
      .whereIn('customer_id', targets)
      .where({ appointment_notify_primary: false })
      .update({ appointment_notify_primary: true })
      .returning('customer_id');
    const flippedIds = flipped.map((r) => (typeof r === 'string' ? r : r.customer_id)).filter(Boolean);

    const { recordAuditEvent } = require('../../services/audit-log');
    await recordAuditEvent({
      actor_type: 'system:migration',
      action: AUDIT_ACTION,
      resource_type: 'notification_prefs',
      // critical: `down` reads this record to know what to revert, so a lost
      // audit write must fail the migration rather than be swallowed.
      critical: true,
      trx,
      metadata: {
        reason: 'appointment_notify_primary opt-in default silently dropped account holders from appointment texts',
        updated_count: flippedIds.length,
        targets_with_on_location_contacts: withContacts,
        flipped_at: flippedAt.toISOString(),
        customer_ids: flippedIds,
      },
    });
    console.log(`[20260725000002] backfilled ${flippedIds.length} notification_prefs row(s) to appointment_notify_primary=true (${withContacts} had on-location contacts)`);
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
    console.log('[20260725000002] no audit record — nothing to revert');
    return;
  }
  const meta = typeof record.metadata === 'string' ? JSON.parse(record.metadata) : (record.metadata || {});
  const ids = Array.isArray(meta.customer_ids) ? meta.customer_ids : [];
  if (!ids.length) return;

  // Revert ONLY rows this migration actually flipped AND that nobody has
  // touched since (codex #2992 P2). `up` does not restamp updated_at, so a row
  // it flipped still carries its original timestamp, while any later change
  // through the app stamps a newer one — that is the "unchanged since our
  // write" marker. A customer who has since chosen `true` themselves keeps it.
  // Revert + audit atomically on the MIGRATION's own connection: passing trx
  // keeps recordAuditEvent off the service's separate db handle, and
  // critical:true means a lost audit write aborts the rollback instead of
  // leaving reverted data with no forensic record.
  await knex.transaction(async (trx) => {
    const query = trx('notification_prefs')
      .whereIn('customer_id', ids)
      .where({ appointment_notify_primary: true });
    if (meta.flipped_at) {
      query.where(function untouchedSinceBackfill() {
        this.whereNull('updated_at').orWhere('updated_at', '<=', new Date(meta.flipped_at));
      });
    }
    const reverted = await query.update({ appointment_notify_primary: false });
    const skipped = ids.length - reverted;

    // audit_log rows are NEVER deleted (see 20260419000005 header) — the
    // record of a mass customer-preference rewrite must survive its own
    // rollback. Append a rollback event instead.
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
    console.log(`[20260725000002] rollback reverted ${reverted} row(s); left ${skipped} changed-since-backfill row(s) alone`);
  });
};
