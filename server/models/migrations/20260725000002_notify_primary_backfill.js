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
const { randomUUID } = require('crypto');

const AUDIT_ACTION = 'migration.notify_primary_backfill';

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

  await knex.transaction(async (trx) => {
    const updated = await trx('notification_prefs')
      .whereIn('customer_id', targets)
      .where({ appointment_notify_primary: false })
      .update({ appointment_notify_primary: true, updated_at: new Date() });

    if (await trx.schema.hasTable('audit_log')) {
      await trx('audit_log').insert({
        id: randomUUID(),
        actor_type: 'system:migration',
        action: AUDIT_ACTION,
        resource_type: 'notification_prefs',
        // Row-level ids live in metadata; this backfill is account-wide.
        resource_id: null,
        metadata: JSON.stringify({
          reason: 'appointment_notify_primary opt-in default silently dropped account holders from appointment texts',
          updated_count: updated,
          targets_with_on_location_contacts: withContacts,
          customer_ids: targets,
        }),
      });
    }
    console.log(`[20260725000002] backfilled ${updated} notification_prefs row(s) to appointment_notify_primary=true (${withContacts} had on-location contacts)`);
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

  // Restore ONLY the rows this migration flipped, and only if they are still
  // true — a customer who has since opted out on their own is left alone.
  await knex('notification_prefs')
    .whereIn('customer_id', ids)
    .where({ appointment_notify_primary: true })
    .update({ appointment_notify_primary: false, updated_at: new Date() });
  await knex('audit_log').where({ id: record.id }).del();
};
