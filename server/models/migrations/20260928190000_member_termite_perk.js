/**
 * The WaveGuard member perk is a free ANNUAL TERMITE INSPECTION, not a free
 * WDO (real-estate) inspection (owner 2026-09-28: "wdo is not free, if your a
 * waveguard member you get a free annual termite inspection").
 *
 *   1. waveguard_member_wdo and the legacy free_termite_inspection were both
 *      scoped to wdo_inspection (20260408000002). Re-scope both to the
 *      standalone termite_inspection service, so a member discount can no
 *      longer zero a WDO.
 *   2. The Termite Inspection Service is un-archived and priced at $0 (owner:
 *      "just keep it at 0 for now") but stays INACTIVE: the booking paths are
 *      not ready for a $0 catalog service (the Intelligence Bar and phone
 *      booking save $0 as NULL, which bills a per-application customer's fee;
 *      the appointment tagger reads "Termite Inspection" as a WDO). A
 *      follow-up turns it on.
 *
 * Each changed row gets an audit_log event with its live before values,
 * written critical on the migration's own connection, so a lost audit write
 * aborts the change. down() restores only rows that still carry this
 * migration's values (a later staff edit is left alone) and appends a
 * rollback event for each, in the same transaction as the restore.
 */
const REASON = 'owner 2026-09-28: WDO is not free; WaveGuard members get a free annual termite inspection';
const MIGRATION = '20260928190000_member_termite_perk';
const PERK_DESCRIPTION = 'Free annual termite inspection for WaveGuard members (Bronze+). Termite Inspection Service only — never the real-estate WDO inspection.';

const DISCOUNTS = {
  waveguard_member_wdo: {
    perk: {
      name: 'WaveGuard Member Free Annual Termite Inspection',
      description: PERK_DESCRIPTION,
      service_key_filter: 'termite_inspection',
    },
    // The values 20260408000002 left (verified live 2026-09-28; the live
    // description's retired-provider sentence is not restored, per AGENTS.md).
    prior: {
      name: 'WaveGuard Member Discount (Termite Inspection)',
      description: 'Free WDO / termite inspection for any active WaveGuard member.',
      service_key_filter: 'wdo_inspection',
    },
  },
  free_termite_inspection: {
    perk: {
      description: `${PERK_DESCRIPTION} Legacy record — see also waveguard_member_wdo.`,
      service_key_filter: 'termite_inspection',
    },
    prior: {
      description: 'Free WDO inspection for WaveGuard members (Bronze+). Legacy record — see also waveguard_member_wdo.',
      service_key_filter: 'wdo_inspection',
    },
  },
};
const SERVICE_PERK = { is_active: false, is_archived: false, base_price: 0 };
const SERVICE_PRIOR = { is_active: false, is_archived: true, base_price: null };

const pick = (row, fields) => Object.fromEntries(fields.map((f) => [f, f === 'base_price' && row[f] != null ? Number(row[f]) : row[f]]));
const matches = (row, values) => Object.keys(values).every((f) => pick(row, [f])[f] === values[f]);

async function serviceFields(knex) {
  return (await knex.schema.hasColumn('services', 'is_archived'))
    ? ['is_active', 'is_archived', 'base_price']
    : ['is_active', 'base_price'];
}

async function audit(knex, { action, resourceType, id, before, after, direction }) {
  if (!(await knex.schema.hasTable('audit_log'))) return;
  const { recordAuditEvent } = require('../../services/audit-log');
  await recordAuditEvent({
    actor_type: 'system:migration',
    action,
    resource_type: resourceType,
    resource_id: String(id),
    metadata: {
      migration: MIGRATION,
      direction,
      reason: REASON,
      changed_fields: Object.keys(after).filter((f) => before[f] !== after[f]),
      before,
      after,
    },
    critical: true,
    trx: knex,
  });
}

// Moves each row from `fromKey` values to `toKey` values; a row already at
// `toKey` is left as is. `onlyIfAt` limits the move to rows still carrying
// the `fromKey` values (used by down()).
async function move(knex, { fromKey, toKey, direction, onlyIfAt }) {
  for (const [discountKey, values] of Object.entries(DISCOUNTS)) {
    const target = values[toKey];
    const fields = Object.keys(target);
    const row = await knex('discounts').where({ discount_key: discountKey }).forUpdate().first('id', ...fields);
    if (!row || matches(row, target) || (onlyIfAt && !matches(row, values[fromKey]))) continue;
    await knex('discounts').where({ id: row.id }).update({ ...target, updated_at: new Date() });
    await audit(knex, { action: 'discount_catalog.update', resourceType: 'discount', id: row.id, before: pick(row, fields), after: target, direction });
  }
  const fields = await serviceFields(knex);
  const target = pick(toKey === 'perk' ? SERVICE_PERK : SERVICE_PRIOR, fields);
  const source = pick(fromKey === 'perk' ? SERVICE_PERK : SERVICE_PRIOR, fields);
  const service = await knex('services').where({ service_key: 'termite_inspection' }).forUpdate().first('id', ...fields);
  if (!service || matches(service, target) || (onlyIfAt && !matches(service, source))) return;
  await knex('services').where({ id: service.id }).update({ ...target, updated_at: new Date() });
  await audit(knex, { action: 'service_catalog.update', resourceType: 'service', id: service.id, before: pick(service, fields), after: target, direction });
}

exports.up = async function up(knex) {
  await move(knex, { fromKey: 'prior', toKey: 'perk', direction: 'up', onlyIfAt: false });
};

exports.down = async function down(knex) {
  await move(knex, { fromKey: 'perk', toKey: 'prior', direction: 'down', onlyIfAt: true });
};

exports.DISCOUNTS = DISCOUNTS;
exports.SERVICE_PERK = SERVICE_PERK;
exports.SERVICE_PRIOR = SERVICE_PRIOR;
