// Adds the lawn_assessment_photos columns that migration
// 20260414000018_lawn_photos_and_knowledge_bridge_v2.js intended to
// land but never did.
//
// Drift fix #2 of PR 0.4. The v1 migration (20260414000015) created
// the table with a smaller column set including `is_best`. The v2
// migration tried to (re-)create the table with a richer column set
// including customer_id/filename/photo_type/photo_order/is_best_photo/
// etc., but its createTable is gated on `!hasTable` — and since v1
// already created the table, v2's columns never made it into the
// schema. The /assess photo-storage block writes all of those columns
// and silently 500s inside its try/catch.
//
// This migration is purely additive (hasColumn guards on every
// alterTable call) so it can run safely on:
//   - prod (which has the v1 shape and zero rows in lawn_assessment_photos
//     because the insert path has been failing)
//   - dev DBs that for whatever reason have a hand-patched mix
//   - fresh DBs that get the full migration chain in one batch
// Down migration drops only what we added.
//
// is_best vs is_best_photo: the v1 column `is_best` stays in place
// (don't drop unused columns in this PR). is_best_photo gets added
// and back-filled from is_best where it makes sense — preserves
// whatever audit signal the v1 column captured.

const COLUMNS = [
  // [knex method, name, optional config]
  ['uuid',     'customer_id'],
  ['string',   'filename', 300],
  ['integer',  'file_size_bytes'],
  ['string',   'photo_type', 30, { default: 'general' }],
  ['string',   'zone', 50],
  ['integer',  'photo_order', null, { default: 0 }],
  ['boolean',  'customer_visible', null, { default: true }],
  ['boolean',  'is_best_photo', null, { default: false }],
  ['timestamp', 'taken_at'],
];

exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('lawn_assessment_photos'))) return;

  for (const [method, name, len, opts] of COLUMNS) {
    if (await knex.schema.hasColumn('lawn_assessment_photos', name)) continue;
    await knex.schema.alterTable('lawn_assessment_photos', (t) => {
      const col = len != null ? t[method](name, len) : t[method](name);
      if (opts && Object.prototype.hasOwnProperty.call(opts, 'default')) {
        col.defaultTo(opts.default);
      }
    });
  }

  // Backfill is_best_photo from is_best where the v1 column exists.
  // We keep is_best around — dropping a populated column risks losing
  // an audit signal we don't fully own.
  if (
    (await knex.schema.hasColumn('lawn_assessment_photos', 'is_best')) &&
    (await knex.schema.hasColumn('lawn_assessment_photos', 'is_best_photo'))
  ) {
    await knex('lawn_assessment_photos')
      .whereNull('is_best_photo')
      .orWhere('is_best_photo', false)
      .update({ is_best_photo: knex.ref('is_best') });
  }

  // Backfill customer_id from the parent assessment so the column
  // becomes useful immediately. Doesn't change row count, doesn't
  // affect audit. Only touches rows where customer_id is NULL.
  await knex.raw(`
    UPDATE lawn_assessment_photos lap
    SET customer_id = la.customer_id
    FROM lawn_assessments la
    WHERE lap.assessment_id = la.id
      AND lap.customer_id IS NULL
  `);

  // Indexes intended by the v2 migration. Idempotent — knex's index
  // creation throws if the index already exists, so guard with raw.
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_lap_customer_created
    ON lawn_assessment_photos (customer_id, created_at)
  `);
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_lap_customer_best
    ON lawn_assessment_photos (customer_id, is_best_photo)
  `);
};

exports.down = async function (knex) {
  if (!(await knex.schema.hasTable('lawn_assessment_photos'))) return;

  await knex.raw('DROP INDEX IF EXISTS idx_lap_customer_best');
  await knex.raw('DROP INDEX IF EXISTS idx_lap_customer_created');

  // Drop in reverse so default-bearing columns drop cleanly.
  for (const [, name] of [...COLUMNS].reverse()) {
    if (await knex.schema.hasColumn('lawn_assessment_photos', name)) {
      await knex.schema.alterTable('lawn_assessment_photos', (t) => {
        t.dropColumn(name);
      });
    }
  }
};
