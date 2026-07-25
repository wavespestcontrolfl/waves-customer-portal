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
const { randomUUID } = require('crypto');

const AUDIT_ACTION = 'migration.service_report_notify_primary_backfill';

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

  await knex.transaction(async (trx) => {
    const updated = await trx('notification_prefs')
      .whereIn('customer_id', targets)
      .where({ service_report_notify_primary: false })
      .update({ service_report_notify_primary: true, updated_at: new Date() });

    if (await trx.schema.hasTable('audit_log')) {
      await trx('audit_log').insert({
        id: randomUUID(),
        actor_type: 'system:migration',
        action: AUDIT_ACTION,
        resource_type: 'notification_prefs',
        resource_id: null,
        metadata: JSON.stringify({
          reason: 'service_report_notify_primary opt-in default silently stopped account holders receiving their own service reports',
          updated_count: updated,
          already_broken_with_contact_email: alreadyBroken,
          customer_ids: targets,
        }),
      });
    }
    console.log(`[20260725000004] backfilled ${updated} notification_prefs row(s) to service_report_notify_primary=true (${alreadyBroken} were already missing their reports)`);
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

  await knex('notification_prefs')
    .whereIn('customer_id', ids)
    .where({ service_report_notify_primary: true })
    .update({ service_report_notify_primary: false, updated_at: new Date() });
  await knex('audit_log').where({ id: record.id }).del();
};
