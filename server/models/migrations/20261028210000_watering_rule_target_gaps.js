// Final watering-rule audit (owner 2026-10-28, "do one final audit, make sure every product has it").
//
// The audit ran the app's own path (approval, report facts, rulesForTargets, buildWateringInstruction; every lawn
// watering gate is on) for all 151 active products a lawn visit can log, with every target case: none, the completion
// form's prefill, each catalog target alone, all catalog targets, and every target logged on a lawn visit in a year.
// 141 built a customer text in every case. Of the other ten, three are lawn treatments whose catalog lists a target
// their rule does not name. Their rule has no product-wide direction, so a visit logging that target gets no watering
// text and an office alert:
//   - Armada 50 WDG, "Anthracnose". Its label: "For control of both foliar and soil-borne diseases, allow sprayed area to
//     completely dry before irrigation." That line becomes the product-wide rule (hold until dry); summer patch,
//     take-all and fairy ring keep their water-in entries.
//   - Acelepryn Insecticide, "Billbugs" (and chinch bugs, also on its label); Acelepryn Xtra, "Southern chinch bugs"
//     (and billbugs and mole crickets, also on its label). Those label rows have no watering line (EPA 100-1489 stamped
//     2024-01-11; 100-1680 stamped 2023-06-26). Owner rule for a label-silent use: no watering until the spray has
//     dried, the caterpillar entry's own label minimum. Acelepryn Xtra's rule becomes source 'owner' (its entries
//     inherit the rule's source, and the new one is the owner's), as Acelepryn Insecticide already is.
// One more lawn-tagged product, the Victor rat snap trap, is approved for reports but had no rule: it gets the
// not-turf rule (no watering change), as the Arborjet trunk injections. The other six (yard signs, a sign stake, a
// sticker, a glue board, a vinegar cleaner) are not approved for reports and are not applied to turf; none was ever
// logged on any visit, so they are left alone.
//
// A REPLACE row is written only while the stored rule is exactly the value read from production on 2026-10-28 (by
// value, any key order), so any admin edit stands; the FILL row only while the rule is empty. validateRule runs before
// every write. One audit_log row per write with before and after. Down is a documented no-op (waves-db SKILL: a
// data-correction migration never reverts on rollback); the audit rows keep every before value.
const { isDeepStrictEqual } = require('util');
const { recordAuditEvent } = require('../../services/audit-log');
const { validateRule } = require('../../services/service-report/lawn-watering-rule');

const MIGRATION = '20261028210000_watering_rule_target_gaps';
const VERIFIED = { verified_at: '2026-10-28T00:00:00.000Z', verified_by: 'label-check-2026-10-28' };
const SILENT_NOTE = 'Owner (2026-10-28): no watering until the spray has dried, the caterpillar entry\'s own label minimum.';

// The stored values read 2026-10-28.
const ARMADA_BEFORE = {
      source: 'owner',
      by_target: [
        {
          mode: 'hold',
          match: ['large patch', 'brown patch', 'dollar spot', 'leaf spot', 'leaf blight'],
          hold_until: 'dry',
          label_note: 'Label: "For control of both foliar and soil-borne diseases, allow sprayed area to completely dry before irrigation."',
        },
        {
          mode: 'water_in',
          match: ['summer patch', 'take-all'],
          label_note: 'Label: soil-borne diseases: "irrigate immediately after application with sufficient water to move the active ingredient down into the crown and root zone of the turf." No amount.',
          water_in_inches: 0.25,
          water_in_by_hours: 24,
          water_in_same_day: true,
        },
        {
          mode: 'water_in',
          match: ['fairy ring'],
          label_note: 'Label: "Water in application with 1/8 to 1/4 inch of irrigation within 6-8 hours after application."',
          label_window: 'directs',
          water_in_inches: 0.25,
          water_in_by_hours: 8,
        },
      ],
      label_note: 'Foliar first (the common lawn use).',
      verified_at: '2026-10-24T00:00:00.000Z',
      verified_by: 'label-check-2026-10-24',
    };
const ACELEPRYN_BEFORE = {
      source: 'owner',
      by_target: [
        {
          mode: 'hold',
          match: ['caterpillar', 'armyworm', 'webworm', 'cutworm', 'looper', 'grassworm'],
          hold_hours: 24,
          label_note: 'Label: "To ensure best control, delay water (irrigation) or mowing for 24 hours after application." (turf caterpillars)',
          label_minimum: {
            hold_until: 'dry',
          },
          label_best_results: true,
        },
        {
          mode: 'water_in',
          match: ['grub'],
          label_note: 'Label: "Irrigate turf immediately after application or allow rainfall to move the product into the soil." (white grubs; no amount: 0.25 inch within 24 hours)',
          label_window: 'directs',
          water_in_inches: 0.25,
          water_in_by_hours: 24,
        },
      ],
      label_note: 'Caterpillars first (the protocol use). Other targets (billbugs, chinch bugs): no watering line.',
      verified_at: '2026-10-24T00:00:00.000Z',
      verified_by: 'label-check-2026-10-24',
    };
const ACELEPRYN_XTRA_BEFORE = {
      source: 'label',
      by_target: [
        {
          mode: 'hold',
          match: ['caterpillar', 'armyworm', 'webworm', 'cutworm', 'looper', 'grassworm'],
          hold_hours: 24,
          label_note: 'Label: "for turf caterpillars, delay watering (irrigation) or mowing for 24 hours after application."',
          label_minimum: {
            hold_until: 'dry',
          },
          label_best_results: true,
        },
        {
          mode: 'water_in',
          match: ['grub', 'ants'],
          label_note: 'Label: "Irrigate within 24 hours of application if sufficient rainfall (1/4-1/2 inch of water) does not occur."',
          label_window: 'directs',
          water_in_inches: 0.25,
          water_in_by_hours: 24,
        },
      ],
      label_note: 'Other targets (chinch bugs, mole crickets, billbugs): no watering line.',
      verified_at: '2026-10-24T00:00:00.000Z',
      verified_by: 'label-check-2026-10-24',
    };

const REPLACE = [
  {
    name: 'Armada 50 WDG',
    before: ARMADA_BEFORE,
    after: {
      ...ARMADA_BEFORE,
      mode: 'hold',
      hold_until: 'dry',
      label_note: 'Label: "For control of both foliar and soil-borne diseases, allow sprayed area to completely dry before irrigation." The rule for every disease the entries do not name (anthracnose, red thread, pink patch and the rest); summer patch, take-all and fairy ring water in as their entries say.',
      ...VERIFIED,
    },
  },
  {
    name: 'Acelepryn Insecticide',
    before: ACELEPRYN_BEFORE,
    after: {
      ...ACELEPRYN_BEFORE,
      by_target: [
        ...ACELEPRYN_BEFORE.by_target,
        { mode: 'hold', match: ['billbug', 'chinch'], hold_until: 'dry', label_note: `Label (EPA 100-1489): the billbug and chinch bug rows have no watering line. ${SILENT_NOTE}` },
      ],
      label_note: 'Caterpillars first (the protocol use). Billbugs and chinch bugs: no watering line, so no watering until the spray has dried.',
      ...VERIFIED,
    },
  },
  {
    name: 'Acelepryn Xtra',
    before: ACELEPRYN_XTRA_BEFORE,
    after: {
      ...ACELEPRYN_XTRA_BEFORE,
      source: 'owner',
      by_target: [
        ...ACELEPRYN_XTRA_BEFORE.by_target,
        { mode: 'hold', match: ['chinch', 'billbug', 'mole cricket'], hold_until: 'dry', label_note: `Label (EPA 100-1680): the chinch bug, billbug and mole cricket rows have no watering line. ${SILENT_NOTE}` },
      ],
      label_note: 'Chinch bugs, billbugs and mole crickets: no watering line, so no watering until the spray has dried.',
      ...VERIFIED,
    },
  },
];

const FILL = [
  {
    name: 'Victor Expanded Trigger Rat Snap Trap',
    rule: { mode: 'none', source: 'owner', label_note: 'Not applied to turf (a rodent snap trap): no lawn watering change.', ...VERIFIED },
  },
];

function parseJson(value) {
  if (value == null) return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return null; }
}

async function audit(knex, canAudit, row, kind, before, after) {
  if (!canAudit) return;
  // audit_log.actor_id is a uuid column: the migration names itself in action + metadata.
  await recordAuditEvent({
    actor_type: 'system',
    action: `migration:${MIGRATION}:${kind}`,
    resource_type: 'products_catalog',
    resource_id: String(row.id),
    metadata: { migration: MIGRATION, product: row.name, before, after },
    critical: true,
    trx: knex,
  });
}

async function replaceRules(knex, canAudit) {
  for (const item of REPLACE) {
    if (!validateRule(item.after).valid) continue; // never write a rule the validator rejects
    const rows = await knex('products_catalog').where({ name: item.name }).select('id', 'name', 'post_application_watering');
    for (const row of rows) {
      // Compare VALUES: Postgres returns jsonb with its own key order.
      if (!isDeepStrictEqual(parseJson(row.post_application_watering), item.before)) continue;
      const updated = await knex('products_catalog').where({ id: row.id })
        .whereRaw('post_application_watering = ?::jsonb', [JSON.stringify(item.before)])
        .update({ post_application_watering: JSON.stringify(item.after), updated_at: knex.fn.now() });
      if (updated) await audit(knex, canAudit, row, 'target_gap', item.before, item.after);
    }
  }
}

async function fillRules(knex, canAudit) {
  for (const item of FILL) {
    if (!validateRule(item.rule).valid) continue;
    const rows = await knex('products_catalog').where({ name: item.name }).whereNull('post_application_watering').select('id', 'name');
    for (const row of rows) {
      const updated = await knex('products_catalog').where({ id: row.id }).whereNull('post_application_watering')
        .update({ post_application_watering: JSON.stringify(item.rule), updated_at: knex.fn.now() });
      if (updated) await audit(knex, canAudit, row, 'seeded', null, item.rule);
    }
  }
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('products_catalog'))) return;
  if (!(await knex.schema.hasColumn('products_catalog', 'post_application_watering'))) return;
  const canAudit = await knex.schema.hasTable('audit_log');
  await replaceRules(knex, canAudit);
  await fillRules(knex, canAudit);
};

// Documented no-op: see the header. The audit rows keep every before value.
exports.down = async function down() {};

exports.REPLACE = REPLACE;
exports.FILL = FILL;
