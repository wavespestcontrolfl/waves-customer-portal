/**
 * Audit trail for the owner-directed catalog changes in 20260928110000,
 * 20260928130000 and 20260928140000 (all frozen once pushed): the member
 * perk discounts re-scoped from wdo_inspection to termite_inspection, and the
 * Termite Inspection Service priced at $0, un-archived and left inactive.
 * Writes the same audit_log events the admin catalog writers record
 * (discount_catalog.update / service_catalog.update), so the change is
 * distinguishable from an unaudited edit and the prior values are recoverable.
 *
 * down() is a no-op: an audit trail is never erased.
 */
const REASON = 'owner 2026-09-28: WDO is not free; WaveGuard members get a free annual termite inspection (PR #5161)';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('audit_log'))) return;
  const events = [];
  const discountBefore = {
    waveguard_member_wdo: {
      name: 'WaveGuard Member Discount (Termite Inspection)',
      service_key_filter: 'wdo_inspection',
    },
    free_termite_inspection: { service_key_filter: 'wdo_inspection' },
  };
  for (const [key, before] of Object.entries(discountBefore)) {
    const row = await knex('discounts').where({ discount_key: key }).first('id', 'name', 'description', 'service_key_filter');
    if (!row) continue;
    events.push({
      actor_type: 'system',
      actor_id: null,
      action: 'discount_catalog.update',
      resource_type: 'discount',
      resource_id: String(row.id),
      metadata: JSON.stringify({
        migration: '20260928110000_member_termite_inspection_perk',
        reason: REASON,
        changed_fields: Object.keys(before).concat('description'),
        before,
        after: { name: row.name, service_key_filter: row.service_key_filter, description: row.description },
      }),
    });
  }
  const service = await knex('services').where({ service_key: 'termite_inspection' }).first('id', 'is_active', 'base_price');
  if (service) {
    events.push({
      actor_type: 'system',
      actor_id: null,
      action: 'service_catalog.update',
      resource_type: 'service',
      resource_id: String(service.id),
      metadata: JSON.stringify({
        migrations: ['20260928110000_member_termite_inspection_perk', '20260928130000_termite_inspection_unarchive', '20260928140000_termite_inspection_stays_off'],
        reason: `${REASON}; kept inactive until $0 booking is safe`,
        changed_fields: ['base_price', 'is_archived', 'is_active'],
        before: { is_active: false, base_price: null },
        after: { is_active: service.is_active, base_price: service.base_price, is_archived: false },
      }),
    });
  }
  if (events.length) await knex('audit_log').insert(events);
};

exports.down = async function down() {};
