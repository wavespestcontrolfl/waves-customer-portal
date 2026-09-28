/**
 * Rollback audit for the termite perk catalog change (PR #5161). The forward
 * events 20260928150000 / 20260928160000 wrote (frozen once pushed) stay in
 * the append-only audit_log; without a compensating event a rollback would
 * leave them as the latest word while 20260928110000 down() restores the WDO
 * scope and the inactive, unpriced service.
 *
 * Deliberately timestamped BEFORE 20260928110000: a batch rollback runs
 * down() in reverse order and commits each migration on its own, so this
 * down() runs only after 20260928110000 down() has committed its restore
 * (and never, when that restore fails and stops the batch). It reads the
 * rows back and appends an event only for a row that now carries the
 * restored values, so it never records a restore that did not happen — for
 * instance on a database where this file ran in a later batch.
 *
 * up() is a no-op.
 */
const REASON = 'rollback of PR #5161 (member termite perk catalog change)';
const RESTORED_BY = '20260928110000_member_termite_inspection_perk';
const PERK_DESCRIPTION = 'Free annual termite inspection for WaveGuard members (Bronze+). Termite Inspection Service only — never the real-estate WDO inspection.';

// Exactly what 20260928110000 down() writes.
const DISCOUNT_RESTORED = {
  waveguard_member_wdo: {
    name: 'WaveGuard Member Discount (Termite Inspection)',
    description: 'Free WDO / termite inspection for any active WaveGuard member.',
    service_key_filter: 'wdo_inspection',
  },
  free_termite_inspection: {
    description: 'Free WDO inspection for WaveGuard members (Bronze+). Legacy record — see also waveguard_member_wdo.',
    service_key_filter: 'wdo_inspection',
  },
};
// is_archived is not listed: 20260928130000 down() is a no-op, so the
// service stays un-archived after a rollback.
const SERVICE_RESTORED = { is_active: false, base_price: null };

// What the forward migrations left (20260928110000 up, then 140000).
const DISCOUNT_FORWARD = {
  waveguard_member_wdo: {
    name: 'WaveGuard Member Free Annual Termite Inspection',
    description: PERK_DESCRIPTION,
    service_key_filter: 'termite_inspection',
  },
  free_termite_inspection: {
    description: `${PERK_DESCRIPTION} Legacy record — see also waveguard_member_wdo.`,
    service_key_filter: 'termite_inspection',
  },
};
const SERVICE_FORWARD = { is_active: false, base_price: 0 };

const moneyOrNull = (v) => (v == null ? null : Number(v));

function rollbackEvent(action, resourceType, id, before, after) {
  return {
    actor_type: 'system',
    action,
    resource_type: resourceType,
    resource_id: String(id),
    metadata: JSON.stringify({
      migration: RESTORED_BY,
      direction: 'down',
      reason: REASON,
      changed_fields: Object.keys(after).filter((f) => before[f] !== after[f]),
      before,
      after,
    }),
  };
}

exports.up = async function up() {};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('audit_log'))) return;
  const events = [];
  for (const [key, restored] of Object.entries(DISCOUNT_RESTORED)) {
    const fields = Object.keys(restored);
    const row = await knex('discounts').where({ discount_key: key }).first('id', ...fields);
    if (!row || fields.some((f) => row[f] !== restored[f])) continue;
    events.push(rollbackEvent('discount_catalog.update', 'discount', row.id, DISCOUNT_FORWARD[key], restored));
  }
  const service = await knex('services').where({ service_key: 'termite_inspection' })
    .first('id', 'is_active', 'base_price');
  if (service && service.is_active === SERVICE_RESTORED.is_active
    && moneyOrNull(service.base_price) === SERVICE_RESTORED.base_price) {
    events.push(rollbackEvent('service_catalog.update', 'service', service.id, SERVICE_FORWARD, SERVICE_RESTORED));
  }
  if (events.length) await knex('audit_log').insert(events);
};

exports.DISCOUNT_RESTORED = DISCOUNT_RESTORED;
exports.SERVICE_RESTORED = SERVICE_RESTORED;
exports.DISCOUNT_FORWARD = DISCOUNT_FORWARD;
exports.SERVICE_FORWARD = SERVICE_FORWARD;
