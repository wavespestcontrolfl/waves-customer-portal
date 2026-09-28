/**
 * Complete audit record for the owner-directed termite perk catalog changes
 * (20260928110000 / 130000 / 140000). Supersedes the incomplete events
 * 20260928150000 wrote (frozen once pushed): those listed `description` and
 * `is_archived` as changed without their prior values and synthesized the
 * archive state. These events carry the actual before values — read from
 * production on 2026-09-28 before any of these migrations ran — and the live
 * after values. audit_log is append-only, so the earlier rows stay and these
 * reference them via `supersedes_migration`.
 *
 * down() is a no-op: an audit trail is never erased.
 */
const REASON = 'owner 2026-09-28: WDO is not free; WaveGuard members get a free annual termite inspection (PR #5161)';
const SUPERSEDES = '20260928150000_member_termite_perk_audit';

const DISCOUNT_BEFORE = {
  waveguard_member_wdo: {
    name: 'WaveGuard Member Discount (Termite Inspection)',
    description: 'Free WDO / termite inspection for any active WaveGuard member (legacy catalog copy).',
    service_key_filter: 'wdo_inspection',
  },
  free_termite_inspection: {
    name: 'Free Termite Inspection',
    description: 'Free WDO inspection for WaveGuard members (Bronze+). Legacy record — see also waveguard_member_wdo.',
    service_key_filter: 'wdo_inspection',
  },
};
const SERVICE_BEFORE = { is_active: false, is_archived: true, base_price: null };

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('audit_log'))) return;
  const events = [];
  for (const [key, before] of Object.entries(DISCOUNT_BEFORE)) {
    const row = await knex('discounts').where({ discount_key: key }).first('id', 'name', 'description', 'service_key_filter');
    if (!row) continue;
    const after = { name: row.name, description: row.description, service_key_filter: row.service_key_filter };
    events.push({
      actor_type: 'system',
      action: 'discount_catalog.update',
      resource_type: 'discount',
      resource_id: String(row.id),
      metadata: JSON.stringify({
        migration: '20260928110000_member_termite_inspection_perk',
        supersedes_migration: SUPERSEDES,
        reason: REASON,
        ...(key === 'waveguard_member_wdo' ? { note: 'prior description abridged: its retired-provider mapping sentence is omitted per AGENTS.md' } : {}),
        changed_fields: Object.keys(before).filter((f) => before[f] !== after[f]),
        before,
        after,
      }),
    });
  }
  const hasArchived = await knex.schema.hasColumn('services', 'is_archived');
  const service = await knex('services').where({ service_key: 'termite_inspection' })
    .first(...['id', 'is_active', 'base_price', ...(hasArchived ? ['is_archived'] : [])]);
  if (service) {
    const after = { is_active: service.is_active, base_price: service.base_price == null ? null : Number(service.base_price) };
    if (hasArchived) after.is_archived = service.is_archived;
    const before = hasArchived ? SERVICE_BEFORE : { is_active: SERVICE_BEFORE.is_active, base_price: SERVICE_BEFORE.base_price };
    events.push({
      actor_type: 'system',
      action: 'service_catalog.update',
      resource_type: 'service',
      resource_id: String(service.id),
      metadata: JSON.stringify({
        migrations: ['20260928110000_member_termite_inspection_perk', '20260928130000_termite_inspection_unarchive', '20260928140000_termite_inspection_stays_off'],
        supersedes_migration: SUPERSEDES,
        reason: `${REASON}; kept inactive until $0 booking is safe`,
        changed_fields: Object.keys(before).filter((f) => before[f] !== after[f]),
        before,
        after,
      }),
    });
  }
  if (events.length) await knex('audit_log').insert(events);
};

exports.down = async function down() {};
