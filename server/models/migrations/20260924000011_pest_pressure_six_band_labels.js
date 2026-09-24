// Pest Pressure six-band labels (owner ruling 2026-09-24).
//
// The tech's 0–5 tap is now the report score, so the label bands round to
// the nearest integer: 0 = None, 1 = Very Low, 2 = Low, 3 = Moderate,
// 4 = Elevated, 5 = High. Only a config row whose labels still equal the
// original five-band default is rewritten — a label set someone edited in
// Settings is left alone. `down` restores the five-band default on rows
// that still carry exactly the six-band set.
//
// Pure config update: no scores are recalculated and no customer
// communications fire.

const OLD_LABELS = [
  { key: 'very_low', name: 'Very Low', min: 0.0, max: 0.9, description: 'Little to no pest activity.' },
  { key: 'low', name: 'Low', min: 1.0, max: 1.9, description: 'Minor or occasional activity.' },
  { key: 'moderate', name: 'Moderate', min: 2.0, max: 2.9, description: 'Noticeable activity that should be watched.' },
  { key: 'elevated', name: 'Elevated', min: 3.0, max: 3.9, description: 'Recurring or spreading activity.' },
  { key: 'high', name: 'High', min: 4.0, max: 5.0, description: 'Heavy activity, repeated issues, or urgent concern.' },
];

const NEW_LABELS = [
  { key: 'none', name: 'None', min: 0.0, max: 0.4, description: 'No pest activity found.' },
  { key: 'very_low', name: 'Very Low', min: 0.5, max: 1.4, description: 'Little to no pest activity.' },
  { key: 'low', name: 'Low', min: 1.5, max: 2.4, description: 'Minor or occasional activity.' },
  { key: 'moderate', name: 'Moderate', min: 2.5, max: 3.4, description: 'Noticeable activity that should be watched.' },
  { key: 'elevated', name: 'Elevated', min: 3.5, max: 4.4, description: 'Recurring or spreading activity.' },
  { key: 'high', name: 'High', min: 4.5, max: 5.0, description: 'Heavy activity, repeated issues, or urgent concern.' },
];

function parseLabels(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return null; }
  }
  return null;
}

function sameLabels(a, b) {
  if (!Array.isArray(a) || a.length !== b.length) return false;
  return a.every((row, i) => row
    && row.key === b[i].key
    && row.name === b[i].name
    && Number(row.min) === b[i].min
    && Number(row.max) === b[i].max
    && row.description === b[i].description);
}

async function swapLabels(knex, from, to) {
  if (!(await knex.schema.hasTable('pest_pressure_configs'))) return;
  const rows = await knex('pest_pressure_configs').select('id', 'labels');
  for (const row of rows) {
    if (!sameLabels(parseLabels(row.labels), from)) continue;
    await knex('pest_pressure_configs')
      .where({ id: row.id })
      .update({ labels: JSON.stringify(to), updated_at: knex.fn.now() });
  }
}

exports.up = (knex) => swapLabels(knex, OLD_LABELS, NEW_LABELS);
exports.down = (knex) => swapLabels(knex, NEW_LABELS, OLD_LABELS);
exports._internal = { OLD_LABELS, NEW_LABELS, sameLabels, parseLabels };
