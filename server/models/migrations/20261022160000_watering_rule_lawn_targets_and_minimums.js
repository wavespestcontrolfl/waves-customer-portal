// Target rules, label minimums and the herbicides' second watering step for the
// lawn watering text (owner 2026-10-22: "for all combinations, a text goes out,
// but the text is accurate"; "do whatever you recommend"). Read only while
// GATE_LAWN_WATERING_EVERY_VISIT is on (report-data.js resolves targets, the
// instruction builder applies rule E); off, every row reads as before.
//
// Labels read 2026-10-22 (EPA PPLS newest accepted PDFs):
// ~/lawn-watering-coverage-20261022/labels-A.md and labels-B.md.
//
// 1. by_target, for products whose label directions differ by target. A
//    product with no rule today gets a TARGET-ONLY rule (no top-level mode), so
//    with the gate off it stays no claim exactly as today; its FIRST entry is
//    its main use, read when the visit logged no covered target. A product that
//    has a rule (or a derived guess) today keeps that direction as the
//    top-level rule and gains entries for the targets whose label differs.
// 2. label_minimum, on holds that are longer than their own label needs (the
//    owner's 24-hour post-emergent hold, "for best results" lines): the hold a
//    same-day water-in the label requires (Dylox) may shorten to (rule E).
// 3. then_water_in, for the herbicides whose label adds "if no rain within N
//    days, irrigate at least 0.5 inch" after the 24-hour hold.
//
// 4. The CHECK from 20260930000001 required a top-level mode. It now also
//    takes a target-only rule: no "mode" key and a non-empty by_target array
//    (validateRule checks each entry). Any other shape still fails loudly.
//
// FILL rows are written only while the rule is still empty; REPLACE rows only
// while the stored value is still exactly a value read on 2026-10-22 (for
// SpeedZone Southern, the value 20261022120000 writes). Any later admin edit is
// left alone. One
// audit_log row per write. Down is a documented no-op (waves-db SKILL); the
// audit rows keep every before value, and the wider CHECK stays (the old one
// would reject the target-only rows).
const { isDeepStrictEqual } = require('util');
const { recordAuditEvent } = require('../../services/audit-log');
const { validateRule } = require('../../services/service-report/lawn-watering-rule');

const MIGRATION = '20261022160000_watering_rule_lawn_targets_and_minimums';
const VERIFIED_AT = '2026-10-22T00:00:00.000Z';
const VERIFIED_BY = 'label-check-2026-10-22';
const verified = (rule) => ({ ...rule, verified_at: VERIFIED_AT, verified_by: VERIFIED_BY });

const CATERPILLARS = ['caterpillar', 'armyworm', 'webworm', 'cutworm', 'looper', 'grassworm'];
const FOLIAR_DISEASES = ['large patch', 'brown patch', 'dollar spot', 'leaf spot', 'leaf blight'];
const DRY = { mode: 'hold', hold_until: 'dry' };
const sameDay = (inches) => ({ mode: 'water_in', water_in_inches: inches, water_in_by_hours: 24, water_in_same_day: true });
const within = (inches, hours) => ({ mode: 'water_in', water_in_inches: inches, water_in_by_hours: hours });

const FILL = [
  {
    name: 'Acelepryn Insecticide',
    rule: verified({
      by_target: [
        { match: CATERPILLARS, mode: 'hold', hold_hours: 24, label_minimum: { hold_until: 'dry' },
          label_note: 'Label: "To ensure best control, delay water (irrigation) or mowing for 24 hours after application." (turf caterpillars)' },
        { match: ['grub'], ...within(0.25, 24),
          label_note: 'Label: "Irrigate turf immediately after application or allow rainfall to move the product into the soil." (white grubs; no amount: 0.25 inch within 24 hours)' },
      ],
      source: 'owner',
      label_note: 'Caterpillars first (the protocol use). Other targets (billbugs, chinch bugs): no watering line.',
    }),
  },
  {
    name: 'Acelepryn Xtra',
    rule: verified({
      by_target: [
        { match: CATERPILLARS, mode: 'hold', hold_hours: 24,
          label_note: 'Label: "for turf caterpillars, delay watering (irrigation) or mowing for 24 hours after application."' },
        { match: ['grub', 'ants'], ...within(0.25, 24),
          label_note: 'Label: "Irrigate within 24 hours of application if sufficient rainfall (1/4-1/2 inch of water) does not occur."' },
      ],
      source: 'label',
      label_note: 'Other targets (chinch bugs, mole crickets, billbugs): no watering line.',
    }),
  },
  {
    name: 'Heritage Action Fungicide',
    rule: verified({
      by_target: [
        { match: [...FOLIAR_DISEASES, 'take-all'], ...DRY,
          label_note: 'Label: no watering line for these diseases. Owner (2026-10-22): hold until the spray has dried, as Artavia (same azoxystrobin).' },
        { match: ['root dysfunction'], ...within(0.2, 24),
          label_note: 'Label: "Irrigate with 0.1 to 0.2 inches within 24 hours after application to facilitate movement into the root zone."' },
        { match: ['spring dead spot'], ...sameDay(0.25),
          label_note: 'Label: "1/8-1/4 inch of irrigation directly after application is recommended."' },
      ],
      source: 'owner',
      label_note: 'The label also says "DO NOT apply to residential lawns."',
    }),
  },
  {
    name: 'Torque SC',
    rule: verified({
      by_target: [
        { match: FOLIAR_DISEASES, ...DRY, label_note: 'Label: "allow foliage to dry thoroughly before irrigation."' },
        { match: ['take-all', 'spring dead spot', 'summer patch', 'fairy ring'], ...sameDay(0.25),
          label_note: 'Label: "Immediately after fungicide is applied, irrigate the area with sufficient water to move the active ingredient down into the crown and active root zone." No amount.' },
      ],
      source: 'owner',
      label_note: 'The label is for golf course turf only: "Do not use on home lawns".',
    }),
  },
  {
    name: 'Armada 50 WDG',
    rule: verified({
      by_target: [
        { match: FOLIAR_DISEASES, ...DRY,
          label_note: 'Label: "For control of both foliar and soil-borne diseases, allow sprayed area to completely dry before irrigation."' },
        { match: ['summer patch', 'take-all'], ...sameDay(0.25),
          label_note: 'Label: soil-borne diseases: "irrigate immediately after application with sufficient water to move the active ingredient down into the crown and root zone of the turf." No amount.' },
        { match: ['fairy ring'], ...within(0.25, 8),
          label_note: 'Label: "Water in application with 1/8 to 1/4 inch of irrigation within 6-8 hours after application."' },
      ],
      source: 'owner',
      label_note: 'Foliar first (the common lawn use).',
    }),
  },
  {
    name: 'LESCO T-Storm Flowable Thiophanate-Methyl 46.2 Systemic Liquid Fungicide',
    rule: verified({
      by_target: [
        { match: FOLIAR_DISEASES, ...DRY,
          label_note: 'Label: "allow applications to dry on leaf surfaces. Normal watering may proceed after sprays have dried."' },
        { match: ['take-all', 'spring dead spot', 'summer patch', 'bermudagrass decline'], ...sameDay(0.2),
          label_note: 'Label: "lightly water the treatment area to move the fungicide into the active root zone with one to two tenths inch of water." No time stated.' },
      ],
      source: 'owner',
      label_note: 'Foliar first (the protocol use: large patch, dollar spot, gray leaf spot).',
    }),
  },
  // A derived guess today (0.25 inch within 24 hours, granular): it stays the top-level rule.
  {
    name: 'Headway G',
    rule: verified({
      ...within(0.25, 24),
      by_target: [
        { match: ['fairy ring'], ...within(0.5, 24), label_note: 'Label: "Irrigate with at least 0.5-inch of water within 24 hours after application if rainfall is not expected."' },
        { match: ['spring dead spot'], ...sameDay(0.25), label_note: 'Label: "It is recommended to use 1/4" to 1/2" of irrigation directly after application."' },
      ],
      source: 'owner',
      label_note: 'Other diseases: no label line. Owner: 0.25 inch within 24 hours (granular).',
    }),
  },
  {
    name: 'Heritage G',
    rule: verified({
      ...within(0.25, 24),
      by_target: [
        { match: ['fairy ring'], ...within(0.5, 24), label_note: 'Label: "Irrigate with at least 0.5 inches water within 24 hours after application if rainfall is not expected."' },
        { match: ['root dysfunction'], ...within(0.2, 24), label_note: 'Label: "Irrigate with 0.1 to 0.2 inches within 24 hours after application to facilitate movement into the root zone."' },
        { match: ['spring dead spot'], ...sameDay(0.25), label_note: 'Label: "Irrigate with 1/4" to 1/2" of water after application."' },
      ],
      source: 'owner',
      label_note: 'Other diseases: no label line. Owner: 0.25 inch within 24 hours (granular).',
    }),
  },
  // Either merge order: 20261022120000 fills this rule without the minimum (then REPLACE below adds it); if
  // this migration runs first, the whole rule is written here and 20261022120000's fill-only-empty skips it.
  {
    name: 'SpeedZone Southern',
    rule: verified({
      mode: 'hold', hold_hours: 24, label_minimum: { hold_hours: 3 }, source: 'owner',
      label_note: 'Label: rainfast in 3 hours. Owner (2026-10-09): no rain or irrigation for 24 hours after every post-emergent herbicide. Not on Floratam or Bitterblue St. Augustine.',
    }),
  },
  {
    name: 'Pillar G Intrinsic',
    rule: verified({
      ...within(0.25, 24),
      by_target: [
        { match: ['fairy ring', 'root dysfunction', 'summer patch', 'take-all', 'brown ring patch', 'necrotic ring spot'], ...sameDay(0.25),
          label_note: 'Label: root and soilborne diseases "will require additional irrigation to move product into the soil." No amount.' },
      ],
      source: 'owner',
      label_note: 'Other diseases: no label line. Owner: 0.25 inch within 24 hours (granular).',
    }),
  },
];

// Stored values read 2026-10-22 (production, read-only).
const BEFORE = {
  "Atticus Talak 7.9 F": {
    "mode": "hold",
    "source": "label",
    "hold_hours": 24,
    "label_note": "Postpone watering (irrigation) or mowing for 24 hours after application",
    "verified_at": "2026-09-29T00:00:00.000Z",
    "verified_by": "label-check-2026-09-29"
  },
  "Headway Fungicide": {
    "mode": "hold",
    "source": "owner",
    "hold_until": "dry",
    "label_note": "Label: no watering instruction for turf. Owner: hold until the spray has dried.",
    "verified_at": "2026-10-07T00:00:00.000Z",
    "verified_by": "label-check-2026-10-07"
  },
  "Celsius WG": {
    "mode": "hold",
    "source": "owner",
    "hold_hours": 24,
    "hold_until": "dry",
    "label_note": "Label: \"Do not irrigate until the spray has dried.\" Owner (2026-10-09): no rain or irrigation for 24 hours after every post-emergent herbicide.",
    "verified_at": "2026-10-09T00:00:00.000Z",
    "verified_by": "owner-ruling-2026-10-09"
  },
  "Certainty Turf Herbicide": {
    "mode": "hold",
    "source": "owner",
    "hold_hours": 24,
    "label_note": "Label: \"Heavy rainfall or irrigation within 2 hours after application may wash this product off the foliage.\" Owner (2026-10-09): no rain or irrigation for 24 hours after every post-emergent herbicide.",
    "verified_at": "2026-10-09T00:00:00.000Z",
    "verified_by": "owner-ruling-2026-10-09"
  },
  "Sedgehammer Halosulfuron-methyl 75% Post Emergent Soluble Herbicide": {
    "mode": "hold",
    "source": "owner",
    "hold_hours": 24,
    "label_note": "Label: \"Avoid applications when rainfall is forecasted to occur within 4 hours.\" Owner (2026-10-09): no rain or irrigation for 24 hours after every post-emergent herbicide.",
    "verified_at": "2026-10-09T00:00:00.000Z",
    "verified_by": "owner-ruling-2026-10-09"
  },
  "Sedgehammer Plus Halosulfuron-Methyl 5% Post Emergent Soluble Herbicide": {
    "mode": "hold",
    "source": "owner",
    "hold_hours": 24,
    "label_note": "Label: \"Avoid applications when rainfall is forecasted to occur within 4 hours.\" Owner (2026-10-09): no rain or irrigation for 24 hours after every post-emergent herbicide.",
    "verified_at": "2026-10-09T00:00:00.000Z",
    "verified_by": "owner-ruling-2026-10-09"
  },
  "Recognition Post Emergent Herbicide": {
    "mode": "hold",
    "source": "owner",
    "hold_hours": 24,
    "label_note": "Foliar herbicide (bermuda removal mix with Fusilade II): do not water in; rainfast in about 3 hours. Owner (2026-10-09): no rain or irrigation for 24 hours after every post-emergent herbicide.",
    "verified_at": "2026-10-09T00:00:00.000Z",
    "verified_by": "owner-ruling-2026-10-09"
  },
  "Fusilade II Post Emergent Liquid Herbicide": {
    "mode": "hold",
    "source": "owner",
    "hold_hours": 24,
    "label_note": "Foliar herbicide (bermuda removal mix with Recognition): do not water in; rainfast in 1 hour. Owner (2026-10-09): no rain or irrigation for 24 hours after every post-emergent herbicide.",
    "verified_at": "2026-10-09T00:00:00.000Z",
    "verified_by": "owner-ruling-2026-10-09"
  },
  "Dismiss 64 oz": {
    "mode": "hold",
    "source": "owner",
    "hold_hours": 24,
    "label_note": "Label: post-emergent rainfast and irrigation not stated. Owner (2026-10-09): no rain or irrigation for 24 hours after every post-emergent herbicide.",
    "verified_at": "2026-10-09T00:00:00.000Z",
    "verified_by": "owner-ruling-2026-10-09"
  },
  "Dismiss NXT": {
    "mode": "hold",
    "source": "owner",
    "hold_hours": 24,
    "label_note": "Label: post-emergent rainfast and irrigation not stated. Owner (2026-10-09): no rain or irrigation for 24 hours after every post-emergent herbicide.",
    "verified_at": "2026-10-09T00:00:00.000Z",
    "verified_by": "owner-ruling-2026-10-09"
  },
  "Blindside Herbicide": {
    "mode": "hold",
    "source": "label",
    "hold_hours": 24,
    "label_note": "Label: \"Best weed control results will be obtained when no rainfall or irrigation occurs within 24 hours after application.\"",
    "verified_at": "2026-10-05T00:00:00.000Z",
    "verified_by": "label-check-2026-10-05"
  },
  "Drive XLR8 Post Emergent Liquid Herbicide": {
    "mode": "hold",
    "source": "label",
    "hold_hours": 24,
    "label_note": "For best results, do not water or irrigate for 24 hours after application.",
    "verified_at": "2026-09-29T00:00:00.000Z",
    "verified_by": "label-check-2026-09-29"
  },
  "LESCO Chelated Iron Plus": {
    "mode": "hold",
    "source": "label",
    "hold_hours": 24,
    "label_note": "Avoid watering for 24 hours after application for optimal results.",
    "verified_at": "2026-10-03T00:00:00.000Z",
    "verified_by": "label-check-2026-10-03"
  },
  "LESCO High Manganese Combo AM 1% Mg 5.75% S 3% Fe 4% Mn Chelated Micronutrient Liquid Fertilizer": {
    "mode": "hold",
    "source": "label",
    "hold_hours": 24,
    "label_note": "Avoid watering for 24 hours after application for optimal results.",
    "verified_at": "2026-10-03T00:00:00.000Z",
    "verified_by": "label-check-2026-10-03"
  }
};

// The value 20261022120000 writes for SpeedZone Southern.
const SPEEDZONE_LABEL_PASS = {
  mode: 'hold', hold_hours: 24, source: 'owner',
  label_note: 'Label: rainfast in 3 hours. Owner (2026-10-09): no rain or irrigation for 24 hours after every post-emergent herbicide. Not on Floratam or Bitterblue St. Augustine.',
  verified_at: VERIFIED_AT, verified_by: VERIFIED_BY,
};

const withMinimum = (before, label_minimum, extra = {}) => verified({ ...before, label_minimum, ...extra });
const TWO_STEP = (days) => ({ water_in_inches: 0.5, water_in_by_hours: days * 24 });

const REPLACE = [
  {
    name: 'Headway Fungicide',
    befores: [BEFORE['Headway Fungicide']],
    after: verified({
      ...DRY,
      by_target: [
        { match: ['spring dead spot'], ...sameDay(0.25), label_note: 'Label: "1/4" to 1/2" of irrigation directly after application is recommended."' },
        { match: ['root dysfunction'], ...within(0.2, 24), label_note: 'Label: "Irrigate with 0.1 to 0.2 inches within 24 hours after application to facilitate movement into the root zone."' },
      ],
      source: 'owner',
      label_note: 'Label: no watering line for large patch, brown patch, take-all root rot or gray leaf spot. Owner: hold until the spray has dried.',
    }),
  },
  {
    name: 'Atticus Talak 7.9 F',
    befores: [BEFORE['Atticus Talak 7.9 F']],
    after: withMinimum(BEFORE['Atticus Talak 7.9 F'], { hold_until: 'dry' }, {
      label_note: 'Label: "For best results, postpone watering (irrigation) or mowing for 24 hours after application" (caterpillars; also the rule for chinch bugs and fire ants, whose lines say nothing after application). Mole crickets: the label\'s water-in ("water immediately with up to 0.5 inches") is done by the technician with the hose before leaving (v13 protocol), so the customer\'s 24-hour hold applies to every use.',
    }),
  },
  // Label minimums under the owner's 24-hour post-emergent hold (owner 2026-10-09).
  { name: 'Celsius WG', befores: [BEFORE['Celsius WG']], after: withMinimum(BEFORE['Celsius WG'], { hold_until: 'dry' }) },
  { name: 'Certainty Turf Herbicide', befores: [BEFORE['Certainty Turf Herbicide']], after: withMinimum(BEFORE['Certainty Turf Herbicide'], { hold_hours: 2 }) },
  {
    name: 'Sedgehammer Halosulfuron-methyl 75% Post Emergent Soluble Herbicide',
    befores: [BEFORE['Sedgehammer Halosulfuron-methyl 75% Post Emergent Soluble Herbicide']],
    after: withMinimum(BEFORE['Sedgehammer Halosulfuron-methyl 75% Post Emergent Soluble Herbicide'], { hold_hours: 4 }),
  },
  {
    name: 'Sedgehammer Plus Halosulfuron-Methyl 5% Post Emergent Soluble Herbicide',
    befores: [BEFORE['Sedgehammer Plus Halosulfuron-Methyl 5% Post Emergent Soluble Herbicide']],
    after: withMinimum(BEFORE['Sedgehammer Plus Halosulfuron-Methyl 5% Post Emergent Soluble Herbicide'], { hold_hours: 4 }),
  },
  { name: 'Recognition Post Emergent Herbicide', befores: [BEFORE['Recognition Post Emergent Herbicide']], after: withMinimum(BEFORE['Recognition Post Emergent Herbicide'], { hold_hours: 3 }) },
  { name: 'Fusilade II Post Emergent Liquid Herbicide', befores: [BEFORE['Fusilade II Post Emergent Liquid Herbicide']], after: withMinimum(BEFORE['Fusilade II Post Emergent Liquid Herbicide'], { hold_hours: 1 }) },
  { name: 'Dismiss 64 oz', befores: [BEFORE['Dismiss 64 oz']], after: withMinimum(BEFORE['Dismiss 64 oz'], { hold_until: 'dry' }) },
  { name: 'SpeedZone Southern', befores: [SPEEDZONE_LABEL_PASS], after: withMinimum(SPEEDZONE_LABEL_PASS, { hold_hours: 3 }) },
  // "For best results" holds, and the label's second step after them.
  {
    name: 'Dismiss NXT',
    befores: [BEFORE['Dismiss NXT']],
    after: verified({
      mode: 'hold', hold_hours: 24, label_minimum: { hold_until: 'dry' }, then_water_in: TWO_STEP(10), source: 'label',
      label_note: 'Label: "Best weed control results will be obtained when no rainfall or irrigation occurs within 24 hours after application. If no rainfall or irrigation occurs within 10 days after application [...] then irrigation of at least 0.5 inches is recommended."',
    }),
  },
  {
    name: 'Blindside Herbicide',
    befores: [BEFORE['Blindside Herbicide']],
    after: withMinimum(BEFORE['Blindside Herbicide'], { hold_until: 'dry' }, {
      then_water_in: TWO_STEP(7),
      label_note: 'Label: "Best weed control results will be obtained when no rainfall or irrigation occurs within 24 hours after application." Then: "If no rainfall or irrigation occurs within 7 days after application [...] in the amount of 0.5 inches, then irrigation of at least 0.5 inches is recommended."',
    }),
  },
  {
    name: 'Drive XLR8 Post Emergent Liquid Herbicide',
    befores: [BEFORE['Drive XLR8 Post Emergent Liquid Herbicide']],
    after: withMinimum(BEFORE['Drive XLR8 Post Emergent Liquid Herbicide'], { hold_until: 'dry' }, {
      then_water_in: TWO_STEP(7),
      label_note: 'Label: "For best results, DO NOT water or irrigate for 24 hours after application. If rainfall does not occur in 2 to 7 days after application, irrigation of at least 1/2 inch is desirable."',
    }),
  },
  { name: 'LESCO Chelated Iron Plus', befores: [BEFORE['LESCO Chelated Iron Plus']], after: withMinimum(BEFORE['LESCO Chelated Iron Plus'], { hold_until: 'dry' }) },
  {
    name: 'LESCO High Manganese Combo AM 1% Mg 5.75% S 3% Fe 4% Mn Chelated Micronutrient Liquid Fertilizer',
    befores: [BEFORE['LESCO High Manganese Combo AM 1% Mg 5.75% S 3% Fe 4% Mn Chelated Micronutrient Liquid Fertilizer']],
    after: withMinimum(BEFORE['LESCO High Manganese Combo AM 1% Mg 5.75% S 3% Fe 4% Mn Chelated Micronutrient Liquid Fertilizer'], { hold_until: 'dry' }),
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

const CONSTRAINT = 'products_catalog_post_application_watering_mode_check';

// jsonb_exists, not the ? operator: knex reads a ? in raw SQL as a binding.
// Every term is COALESCEd: a CHECK that evaluates to NULL passes ({} did).
async function widenModeCheck(knex) {
  await knex.raw(`
    ALTER TABLE products_catalog
    DROP CONSTRAINT IF EXISTS ${CONSTRAINT},
    ADD CONSTRAINT ${CONSTRAINT}
    CHECK (
      post_application_watering IS NULL
      OR (
        jsonb_typeof(post_application_watering) = 'object'
        AND (
          COALESCE(post_application_watering->>'mode', '') IN ('hold', 'water_in', 'none')
          OR (
            NOT jsonb_exists(post_application_watering, 'mode')
            AND COALESCE(jsonb_typeof(post_application_watering->'by_target'), '') = 'array'
            AND post_application_watering->'by_target' <> '[]'::jsonb
          )
        )
      )
    )
  `);
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('products_catalog'))) return;
  if (!(await knex.schema.hasColumn('products_catalog', 'post_application_watering'))) return;
  const canAudit = await knex.schema.hasTable('audit_log');
  await widenModeCheck(knex);

  for (const item of FILL) {
    if (!validateRule(item.rule).valid) continue; // never write a rule the validator rejects
    const rows = await knex('products_catalog').where({ name: item.name }).whereNull('post_application_watering').select('id', 'name');
    for (const row of rows) {
      const updated = await knex('products_catalog').where({ id: row.id }).whereNull('post_application_watering')
        .update({ post_application_watering: JSON.stringify(item.rule), updated_at: knex.fn.now() });
      if (updated) await audit(knex, canAudit, row, 'seeded', null, item.rule);
    }
  }

  for (const item of REPLACE) {
    if (!validateRule(item.after).valid) continue;
    const rows = await knex('products_catalog').where({ name: item.name }).select('id', 'name', 'post_application_watering');
    for (const row of rows) {
      // Compare VALUES: Postgres returns jsonb with its own key order.
      const before = item.befores.find((value) => isDeepStrictEqual(parseJson(row.post_application_watering), value));
      if (!before) continue;
      const updated = await knex('products_catalog').where({ id: row.id })
        .whereRaw('post_application_watering = ?::jsonb', [JSON.stringify(before)])
        .update({ post_application_watering: JSON.stringify(item.after), updated_at: knex.fn.now() });
      if (updated) await audit(knex, canAudit, row, 'targets_minimums', before, item.after);
    }
  }
};

// Documented no-op: see the header. The audit rows keep every before value.
exports.down = async function down() {};

exports.FILL = FILL;
exports.REPLACE = REPLACE;
