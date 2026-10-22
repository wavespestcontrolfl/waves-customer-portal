// Post-application watering rules for the lawn products that had none or only
// a derived guess and whose label gives one direction for every use (owner
// 2026-10-22: "for all combinations, a text goes out, but the text is
// accurate"; "do whatever you recommend").
//
// A lawn visit's watering text combines the rule of every product the
// technician logs, and ONE product with no rule cancels the whole text (on
// 2026-10-14 and 2026-10-20 an unruled fungicide cancelled the water-in text for
// a pre-emergent and a granular insecticide). A product with no stored rule
// also falls back to a guess from its category (deriveDefaultRule), and three
// guessed pre-emergents asked for 0.25 inch within 24 hours where their labels
// say 0.5 inch within 14 days.
//
// Labels read 2026-10-22 (EPA PPLS newest accepted PDFs, SiteOne bag and jug
// labels): ~/lawn-watering-coverage-20261022/labels-A.md and labels-B.md.
// source 'label' = the label's own direction and figure. source 'owner' = the
// label gives no figure and the rule follows a program precedent the owner set
// (granular fertilizer 0.25 inch within 24 hours, liquid fertilizer no change,
// foliar fungicide with no line: hold until the spray has dried, post-emergent
// herbicide: hold 24 hours).
//
// Only products whose ONE label direction fits every labeled use are here (as
// 20261005235500: a product whose targets need different directions gets no
// product-wide rule). Left for target rules: Acelepryn and Acelepryn Xtra
// (caterpillars: no water for 24 hours; grubs: water in), the root-disease
// water-ins of Heritage Action, T-Storm Flowable, Armada, Torque, Headway,
// Headway G, Heritage G and Pillar G, and Talak's mole-cricket water-in.
//
// Also left out: LESCO T-Storm 2G and Endurant PR are not approved for service
// reports, so a stored rule would not reach the instruction (approve them
// first); Dismiss NXT's rule needs its label's second step (if no 0.5 inch of
// rain or irrigation within 10 days, irrigate 0.5 inch), and its catalog row
// carries another product's EPA number and HRAC group (a catalog correction of
// its own).
//
// FILL rows are matched by exact catalog name and written only while the rule
// (or mow_hold_days) is still empty. REPLACE rows are written only while the
// stored value is still exactly the value read on 2026-10-22: any later admin
// edit is left alone. One audit_log row per write with before and after.
// Down is a documented no-op (waves-db SKILL: a data-correction migration never
// reverts on rollback); the audit rows keep every before value.
const { recordAuditEvent } = require('../../services/audit-log');
const { validateRule } = require('../../services/service-report/lawn-watering-rule');

const MIGRATION = '20261022120000_watering_rule_lawn_label_pass';
const VERIFIED_AT = '2026-10-22T00:00:00.000Z';
const VERIFIED_BY = 'label-check-2026-10-22';

const rule = (fields) => ({ ...fields, verified_at: VERIFIED_AT, verified_by: VERIFIED_BY });
const hold = (fields, source, label_note) => rule({ mode: 'hold', ...fields, source, label_note });
const waterIn = (inches, byHours, source, label_note) => rule({ mode: 'water_in', water_in_inches: inches, water_in_by_hours: byHours, source, label_note });
const none = (label_note) => rule({ mode: 'none', source: 'owner', label_note });

const LIQUID_FERT = 'Label: no watering line after application. Owner: a liquid fertilizer needs no watering change (as LESCO Nutra-TECH, 2026-10-05).';
const GRANULAR_FERT = 'Label: "watered into the turf soon after application" (no amount). Owner: 0.25 inch within 24 hours (as LESCO 24-0-11 and 10-0-22).';
const PRE_EM = 'Label: "activated by at least 0.5 inch of rainfall or irrigation prior to weed seed germination and within 14 days following application."';

const FILL = [
  // No rule today.
  {
    name: 'Medallion SC',
    rule: hold({ hold_until: 'dry' }, 'label', 'Label: "For control of foliar diseases, allow sprayed area to completely dry before irrigation."'),
  },
  {
    name: 'Anuew EZ Plant Growth Regulator',
    rule: hold({ hold_hours: 4 }, 'label', 'Label: "Do not irrigate treated area for 4 hours" after application.'),
  },
  // A derived guess today.
  { name: 'LESCO K-Flow 0-0-25 17% S Turfgrass Liquid Fertilizer', rule: none(LIQUID_FERT) },
  { name: 'LESCO Chelated AM + Micros Turf & Ornamental Liquid Micronutrient', rule: none(LIQUID_FERT) },
  { name: 'LESCO Green Flo Phyte Plus 0-0-26 + Micros Liquid Fertilizer', rule: none(LIQUID_FERT) },
  { name: 'LESCO Green Flo 6-0-0 10% Ca', rule: none(LIQUID_FERT) },
  { name: 'LESCO Elite 0-0-28 AM 7.5% Fe 6.5% Mn 9% S Turfgrass Granular Fertilizer', rule: waterIn(0.25, 24, 'owner', GRANULAR_FERT) },
  { name: 'LESCO 20-2-10 30% PolyPlus', rule: waterIn(0.25, 24, 'owner', GRANULAR_FERT) },
  { name: 'LESCO 0-0-18 Bio KMAG 1% Fe 1% Mg 1% Mn 2.17% S Organic Turf Granular Fertilizer', rule: waterIn(0.25, 24, 'owner', GRANULAR_FERT) },
  { name: 'LESCO Stonewall 0.37% 18-0-10', rule: waterIn(0.5, 336, 'label', PRE_EM) },
  { name: 'LESCO Stonewall 0-0-7', rule: waterIn(0.5, 336, 'label', PRE_EM) },
  { name: 'Prodiamine 65 WDG', rule: waterIn(0.5, 336, 'label', PRE_EM) },
  {
    name: 'Nufarm Arena 0.25G Clothianidin 0.25 Systemic Granular Insecticide',
    rule: waterIn(0.25, 24, 'owner', 'Label: "Follow applications with sufficient irrigation or rainfall to move the active ingredient through the thatch." No amount. Owner: 0.25 inch within 24 hours (as Arena 50 WDG and Topchoice).'),
  },
  {
    name: 'LESCO Moisture Manager',
    rule: waterIn(0.25, 1, 'owner', 'Label: "Water in with at least 1/10 inch of water within the first couple of hours ... Within 24 hours, follow with enough additional water to carry Moisture Manager down to and throughout the root zone" (quart label: within 1 hour). Owner (2026-10-22): one 0.25 inch run within 1 hour covers both steps.'),
  },
  {
    name: 'Hydretain Liquid',
    rule: waterIn(0.25, 2, 'owner', 'Label: "Water in with at least 1/10 inch of water within the first couple of hours ... Within 24 hours, follow with enough additional water to carry Hydretain ES Plus down to and throughout the root zone." Owner (2026-10-22): one 0.25 inch run within 2 hours covers both steps.'),
  },
  {
    name: 'SpeedZone Southern',
    rule: hold({ hold_hours: 24 }, 'owner', 'Label: rainfast in 3 hours. Owner (2026-10-09): no rain or irrigation for 24 hours after every post-emergent herbicide. Not on Floratam or Bitterblue St. Augustine.'),
    mowHoldDays: 2,
  },
];

// Label mow holds for rows whose mow_hold_days is still empty.
const MOW_FILL = [
  // "DO NOT mow 2 days before or after applying Drive XLR8."
  { name: 'Drive XLR8 Post Emergent Liquid Herbicide', days: 2 },
];

// Stored values read 2026-10-22, replaced only while still exactly these.
const ARENA_BEFORE = {
  mode: 'water_in', source: 'label', label_note: 'Apply in sufficient water; avoid mowing until after irrigation or rainfall',
  verified_at: '2026-09-29T00:00:00.000Z', verified_by: 'label-check-2026-09-29', water_in_inches: 0.25, water_in_by_hours: 24,
};

const REPLACE = [
  {
    name: 'Arena 50 WDG',
    before: ARENA_BEFORE,
    // The label line has no amount or window: those are the program's, as Topchoice (owner 2026-10-09).
    after: waterIn(0.25, 24, 'owner', 'Label: "Follow application with sufficient irrigation or rainfall to move the active ingredient through the thatch." No amount. Owner: 0.25 inch within 24 hours.'),
  },
];

// mow_hold_days replaced only while it still holds the value read on 2026-10-22.
const MOW_REPLACE = [
  // "Disturbance (such as mowing, hand weeding, etc.) of treated grass weeds is not recommended within 7 days
  // prior to or within 7 days after" application.
  { name: 'Fusilade II Post Emergent Liquid Herbicide', before: 2, after: 7 },
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

async function fillRules(knex, canAudit, hasMow) {
  for (const item of FILL) {
    if (!validateRule(item.rule).valid) continue; // never write a rule the validator rejects
    const rows = await knex('products_catalog').where({ name: item.name }).whereNull('post_application_watering').select('id', 'name');
    for (const row of rows) {
      const updated = await knex('products_catalog').where({ id: row.id }).whereNull('post_application_watering')
        .update({ post_application_watering: JSON.stringify(item.rule), updated_at: knex.fn.now() });
      if (updated) await audit(knex, canAudit, row, 'seeded', null, item.rule);
    }
    if (hasMow && item.mowHoldDays) await fillMow(knex, canAudit, item.name, item.mowHoldDays);
  }
  if (hasMow) for (const item of MOW_FILL) await fillMow(knex, canAudit, item.name, item.days);
}

async function fillMow(knex, canAudit, name, days) {
  const rows = await knex('products_catalog').where({ name }).whereNull('mow_hold_days').select('id', 'name');
  for (const row of rows) {
    const updated = await knex('products_catalog').where({ id: row.id }).whereNull('mow_hold_days')
      .update({ mow_hold_days: days, updated_at: knex.fn.now() });
    if (updated) await audit(knex, canAudit, row, 'mow_hold_seeded', { mow_hold_days: null }, { mow_hold_days: days });
  }
}

async function replaceRules(knex, canAudit) {
  for (const item of REPLACE) {
    if (!validateRule(item.after).valid) continue;
    const rows = await knex('products_catalog').where({ name: item.name }).select('id', 'name', 'post_application_watering');
    for (const row of rows) {
      // Compare VALUES: Postgres returns jsonb with its own key order.
      if (!require('util').isDeepStrictEqual(parseJson(row.post_application_watering), item.before)) continue;
      const updated = await knex('products_catalog').where({ id: row.id })
        .whereRaw('post_application_watering = ?::jsonb', [JSON.stringify(item.before)])
        .update({ post_application_watering: JSON.stringify(item.after), updated_at: knex.fn.now() });
      if (updated) await audit(knex, canAudit, row, 'label_pass', item.before, item.after);
    }
  }
}

async function replaceMow(knex, canAudit) {
  for (const item of MOW_REPLACE) {
    const rows = await knex('products_catalog').where({ name: item.name, mow_hold_days: item.before }).select('id', 'name');
    for (const row of rows) {
      const updated = await knex('products_catalog').where({ id: row.id, mow_hold_days: item.before })
        .update({ mow_hold_days: item.after, updated_at: knex.fn.now() });
      if (updated) await audit(knex, canAudit, row, 'mow_hold', { mow_hold_days: item.before }, { mow_hold_days: item.after });
    }
  }
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('products_catalog'))) return;
  if (!(await knex.schema.hasColumn('products_catalog', 'post_application_watering'))) return;
  const canAudit = await knex.schema.hasTable('audit_log');
  const hasMow = await knex.schema.hasColumn('products_catalog', 'mow_hold_days');
  await fillRules(knex, canAudit, hasMow);
  await replaceRules(knex, canAudit);
  if (hasMow) await replaceMow(knex, canAudit);
};

// Documented no-op: see the header. The audit rows keep every before value.
exports.down = async function down() {};

exports.FILL = FILL;
exports.MOW_FILL = MOW_FILL;
exports.REPLACE = REPLACE;
exports.MOW_REPLACE = MOW_REPLACE;
