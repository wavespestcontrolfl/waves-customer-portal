// Backfill default_rate_per_1000 for the three St. Augustine protocol products
// whose catalog rows have no rate, so the protocol-reference mix preview
// (GET /admin/protocols/lawn-mix) can compute label-rate math for them.
//
// Rates are NOT invented here — each one copies the owner-approved program
// rate already merged in the lawn protocol operating layer:
//   - Arena 50 WDG        0.29 oz/1K   (20260529000003, jul_blackout_survival)
//   - Atrazine 4L         0.75 fl_oz/1K (20260529000003, nov/dec windows, ≤85°F gate)
//   - Sedgehammer Plus    0.5 oz/1K    (20260630000002, owner curative rates:
//                                       max label rate 0.5, ≤4 apps/yr, ≥14d interval)
//
// Guarded to rows that still have no rate, so an owner-set catalog rate is
// never clobbered.

const BACKFILLS = [
  {
    name: 'Arena 50 WDG',
    rate: 0.29,
    unit: 'oz',
    note: 'Rate mirrors lawn protocol operating layer (20260529000003) July chinch-rescue seed: 0.29 oz/1,000 sq ft.',
  },
  {
    name: 'Atrazine 4L',
    rate: 0.75,
    unit: 'fl_oz',
    note: 'Rate mirrors lawn protocol operating layer (20260529000003) Nov/Dec winter-weed seed: 0.75 fl oz/1,000 sq ft, weather-gated below 85°F.',
  },
  {
    name: 'Sedgehammer Plus Halosulfuron-Methyl 5% Post Emergent Soluble Herbicide',
    rate: 0.5,
    unit: 'oz',
    note: 'Rate mirrors owner curative rate seeded in 20260630000002: 0.5 oz/1,000 sq ft spot rate, max 4 apps/yr, min 14-day interval.',
  },
];

exports.up = async function up(knex) {
  const hasTable = await knex.schema.hasTable('products_catalog');
  if (!hasTable) return;

  for (const fill of BACKFILLS) {
    const row = await knex('products_catalog')
      .where({ name: fill.name })
      .first('id', 'default_rate_per_1000', 'label_source_note');
    if (!row) continue;
    const existingRate = Number(row.default_rate_per_1000 || 0);
    if (existingRate > 0) continue;

    const note = row.label_source_note
      ? `${row.label_source_note} ${fill.note}`
      : fill.note;
    await knex('products_catalog')
      .where({ id: row.id })
      .update({
        default_rate_per_1000: fill.rate,
        rate_unit: fill.unit,
        label_source_note: note,
        updated_at: knex.fn.now(),
      });
  }
};

exports.down = async function down(knex) {
  const hasTable = await knex.schema.hasTable('products_catalog');
  if (!hasTable) return;

  for (const fill of BACKFILLS) {
    // Only revert rows that still hold exactly the value this migration set.
    await knex('products_catalog')
      .where({ name: fill.name, rate_unit: fill.unit })
      .where('default_rate_per_1000', fill.rate)
      .update({
        default_rate_per_1000: null,
        updated_at: knex.fn.now(),
      });
  }
};
