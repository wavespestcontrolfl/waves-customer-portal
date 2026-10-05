// Post-application watering rules for the lawn protocol v13 products (owner
// "ok go" 2026-10-05, labels read 2026-10-03 and 2026-10-05).
//
// Each lawn visit's watering text and report banner combine the rules of every
// product the technician logs. A product with no rule makes the whole visit
// "no claim", so before GATE_LAWN_V13 is flipped every v13 product needs one.
// Label reads: ~/lawn-report-rebuild-scope-20260929/appendix/
// label-timelines-20261003/ (labels-watering-wave2-20261005.md for this wave).
//
// source 'label' = the figure is the label's own. source 'owner' = the label is
// silent or looser and the owner chose the rule (v13 waters pre-emergents in
// within 24 hours; the labels allow 14 days).
//
// The "avoid applications when rainfall or irrigation is expected to occur
// within 48 hours" sentence on several labels (Artavia, Certainty, Tetrino,
// Velista) is the standard runoff advisory about WHEN to spray, not a
// post-application watering direction, so it never becomes a 48-hour hold.
//
// Rows are matched by exact catalog name (fertilizers carry no EPA number).
// FILL rules write only an empty field. REPLACE rules overwrite only a row whose
// rule is still exactly the 2026-09-29 seed value; any later edit is left
// alone. mow_hold_days is filled only when empty. Every written row gets an
// audit_log entry naming the fields it changed (admin-editable compliance
// fields); down() reads those entries back.
const { recordAuditEvent } = require('../../services/audit-log');

const MIGRATION = '20261005200000_watering_rule_lawn_v13';
const VERIFIED_AT = '2026-10-05T00:00:00.000Z';
const VERIFIED_BY = 'label-check-2026-10-05';

const rule = (fields) => ({ ...fields, verified_at: VERIFIED_AT, verified_by: VERIFIED_BY });

const PRE_EM_NOTE = (label) => `${label} Owner (protocol v13): water in 0.5 inch within 24 hours.`;

const FILL = [
  {
    name: 'LESCO Stonewall 4FL Prodiamine 40.7% Pre-Emergent Liquid Herbicide',
    rule: rule({ mode: 'water_in', water_in_inches: 0.5, water_in_by_hours: 24, source: 'owner',
      label_note: PRE_EM_NOTE('Label: activate by at least 0.5 inch of rainfall or irrigation within 14 days following application.') }),
  },
  {
    name: 'Dimension 2EW Dithiopyr 24% Pre-Emergent Liquid Herbicide',
    rule: rule({ mode: 'water_in', water_in_inches: 0.5, water_in_by_hours: 24, source: 'owner',
      label_note: PRE_EM_NOTE('Label: "For preemergence residual control of crabgrass, apply at least 0.5 inch of water after application."') }),
  },
  {
    name: 'LESCO Stonewall 0.43% 15-0-15 50% PolyPlus OPTI45 Pre-Emergent Plus Fertilizer',
    rule: rule({ mode: 'water_in', water_in_inches: 0.5, water_in_by_hours: 24, source: 'owner',
      label_note: PRE_EM_NOTE('Label: activated by at least 0.5 inch of rainfall or irrigation within 14 days following application.') }),
  },
  {
    name: 'LESCO 24-0-11 with PolyPlus OPTI',
    rule: rule({ mode: 'water_in', water_in_inches: 0.25, water_in_by_hours: 24, source: 'owner',
      label_note: 'Label: "watered into the turf soon after application" (no amount). Owner: 0.25 inch within 24 hours.' }),
  },
  {
    name: 'Dylox 6.2 G Granular Insecticide',
    rule: rule({ mode: 'water_in', water_in_inches: 0.25, water_in_by_hours: 12, source: 'owner',
      label_note: 'Label: the property owner "must water-in the product promptly or within the same day." Owner: 0.25 inch within 12 hours.' }),
  },
  {
    name: 'LESCO Nutra-TECH T&O Micronutrient Package',
    rule: rule({ mode: 'none', source: 'label', label_note: 'Label: no watering-in instruction.' }),
  },
  {
    name: 'Dispatch Sprayable Wetting Agent',
    rule: rule({ mode: 'none', source: 'label',
      label_note: 'Label: "Dispatch Sprayable does not need to be watered in following application."' }),
  },
  {
    name: 'LESCO 90/10 Nonionic Surfactant',
    rule: rule({ mode: 'none', source: 'owner',
      label_note: 'Tank-mix surfactant: the herbicide in the mix sets the watering rule.' }),
  },
  {
    name: 'Tetrino Insecticide',
    rule: rule({ mode: 'none', source: 'owner',
      label_note: 'Label: watering-in is stated only for soil pests; nothing for foliar pests. Owner: no change (v13 uses it for chinch bugs).' }),
  },
  {
    name: 'Velista',
    rule: rule({ mode: 'hold', hold_until: 'dry', source: 'label', label_note: 'Label: "Allow treated area to dry before irrigation."' }),
  },
  {
    name: 'Gravex 20 EW',
    rule: rule({ mode: 'hold', hold_until: 'dry', source: 'owner',
      label_note: 'Label: no watering instruction for turf. Owner: hold until the spray has dried.' }),
  },
  {
    name: 'Certainty Turf Herbicide',
    rule: rule({ mode: 'hold', hold_hours: 2, source: 'label',
      label_note: 'Label: "Heavy rainfall or irrigation within 2 hours after application may wash this product off the foliage."' }),
    mowHoldDays: 2,
  },
  {
    name: 'Dismiss 64 oz',
    // Not 24 hours: a 24-hour hold reaches the 24-hour pre-emergent water-in
    // deadline, and the pair cancels the visit's whole instruction (v13 pairs
    // Dismiss sedge spots with water-in products Nov to Mar).
    rule: rule({ mode: 'hold', hold_until: 'dry', source: 'owner',
      label_note: 'Label: post-emergent rainfast and irrigation not stated. Owner: hold until the spray has dried.' }),
  },
  {
    name: 'Acelepryn Insecticide',
    rule: rule({ mode: 'hold', hold_hours: 24, source: 'label',
      label_note: 'Label, turf caterpillars: "delay water (irrigation) or mowing for 24 hours after application." (Grubs: water in; v13 uses it for caterpillars.)' }),
    mowHoldDays: 1,
  },
  {
    name: 'Sedgehammer Halosulfuron-methyl 75% Post Emergent Soluble Herbicide',
    rule: rule({ mode: 'hold', hold_hours: 4, source: 'label',
      label_note: 'Label: "Avoid applications when rainfall is forecasted to occur within 4 hours."' }),
    mowHoldDays: 2,
  },
];

// The 2026-09-29 seed values these replace, matched whole (jsonb equality).
const REPLACE = [
  {
    name: 'Artavia 2 SC (Azoxy)',
    seeded: {
      mode: 'hold', source: 'label', hold_hours: 48,
      label_note: 'No rain or watering within 48 hours after application',
      verified_at: '2026-09-29T00:00:00.000Z', verified_by: 'label-check-2026-09-29',
    },
    rule: rule({ mode: 'hold', hold_until: 'dry', source: 'owner',
      label_note: 'Label: no watering instruction for turf; the 48-hour line is the runoff advisory about when to spray. Owner: hold until the spray has dried.' }),
  },
  {
    name: 'Sedgehammer Plus Halosulfuron-Methyl 5% Post Emergent Soluble Herbicide',
    seeded: {
      mode: 'hold', source: 'label', hold_hours: 48,
      label_note: 'Rainfast within 4 hours; avoid irrigation within 48 hours after application (label read 2026-09-29)',
      verified_at: '2026-09-29T00:00:00.000Z', verified_by: 'label-check-2026-09-29',
    },
    rule: rule({ mode: 'hold', hold_hours: 4, source: 'label',
      label_note: 'Label: "Avoid applications when rainfall is forecasted to occur within 4 hours."' }),
  },
];

// audit_log.actor_id is a uuid column: the migration identifies itself in
// action + metadata, as the other data migrations do. The metadata records
// exactly which fields this run changed; down() restores only those.
async function audit(knex, row, kind, metadata) {
  await recordAuditEvent({
    actor_type: 'system',
    action: `migration:${MIGRATION}:${kind}`,
    resource_type: 'products_catalog',
    resource_id: String(row.id),
    metadata: { migration: MIGRATION, product: row.name, ...metadata },
    critical: true,
    trx: knex,
  });
}

// Fill-only-empty, field by field: a rule already set keeps its value, and so
// does a mow hold already set.
async function fillRow(knex, item, row, hasMow) {
  const ruleWritten = row.post_application_watering == null
    && (await knex('products_catalog').where({ id: row.id }).whereNull('post_application_watering')
      .update({ post_application_watering: JSON.stringify(item.rule), updated_at: knex.fn.now() })) > 0;
  const mowWritten = hasMow && item.mowHoldDays != null && row.mow_hold_days == null
    && (await knex('products_catalog').where({ id: row.id }).whereNull('mow_hold_days')
      .update({ mow_hold_days: item.mowHoldDays, updated_at: knex.fn.now() })) > 0;
  return { ruleWritten, mowWritten };
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('products_catalog'))) return;
  if (!(await knex.schema.hasColumn('products_catalog', 'post_application_watering'))) return;
  const hasMow = await knex.schema.hasColumn('products_catalog', 'mow_hold_days');
  const canAudit = await knex.schema.hasTable('audit_log');

  for (const item of FILL) {
    const rows = await knex('products_catalog').where({ name: item.name })
      .select('id', 'name', 'post_application_watering', ...(hasMow ? ['mow_hold_days'] : []));
    for (const row of rows) {
      const { ruleWritten, mowWritten } = await fillRow(knex, item, row, hasMow);
      if (!canAudit || !(ruleWritten || mowWritten)) continue;
      await audit(knex, row, 'seeded', {
        before: null,
        after: ruleWritten ? item.rule : null,
        mow_hold_days_after: mowWritten ? item.mowHoldDays : null,
      });
    }
  }

  for (const item of REPLACE) {
    const rows = await knex('products_catalog').where({ name: item.name })
      .whereRaw('post_application_watering = ?::jsonb', [JSON.stringify(item.seeded)])
      .select('id', 'name');
    for (const row of rows) {
      const updated = await knex('products_catalog').where({ id: row.id })
        .whereRaw('post_application_watering = ?::jsonb', [JSON.stringify(item.seeded)])
        .update({ post_application_watering: JSON.stringify(item.rule), updated_at: knex.fn.now() });
      if (updated && canAudit) await audit(knex, row, 'corrected', { before: item.seeded, after: item.rule, mow_hold_days_after: null });
    }
  }
};

// Restores only the fields this migration's own audit rows say it changed, and
// only while each still holds the value it wrote: a rule goes back to its
// before value (empty, or the 2026-09-29 seed), a filled mow hold goes back to
// empty. Any later admin edit differs and is left alone. Without audit_log
// nothing is provably this migration's, so nothing changes. Audit rows stay.
exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('products_catalog'))) return;
  if (!(await knex.schema.hasColumn('products_catalog', 'post_application_watering'))) return;
  if (!(await knex.schema.hasTable('audit_log'))) return;
  const hasMow = await knex('products_catalog').columnInfo().then((cols) => 'mow_hold_days' in cols);
  const entries = await knex('audit_log').where('action', 'like', `migration:${MIGRATION}:%`).select('resource_id', 'metadata');
  for (const entry of entries) {
    const meta = typeof entry.metadata === 'string' ? JSON.parse(entry.metadata) : (entry.metadata || {});
    if (meta.after) {
      await knex('products_catalog').where({ id: entry.resource_id })
        .whereRaw('post_application_watering = ?::jsonb', [JSON.stringify(meta.after)])
        .update({ post_application_watering: meta.before ? JSON.stringify(meta.before) : null, updated_at: knex.fn.now() });
    }
    if (hasMow && meta.mow_hold_days_after != null) {
      await knex('products_catalog').where({ id: entry.resource_id, mow_hold_days: meta.mow_hold_days_after })
        .update({ mow_hold_days: null, updated_at: knex.fn.now() });
    }
  }
};

exports.FILL = FILL;
exports.REPLACE = REPLACE;
