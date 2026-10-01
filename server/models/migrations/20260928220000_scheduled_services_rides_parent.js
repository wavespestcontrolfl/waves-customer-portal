/**
 * Rider-series link (pest-rides-the-lawn-rhythm PR 1, scope doc
 * ~/lawn-pest-rhythm-scope-20260928.md — "PR 1 (rider core, dark by
 * construction)").
 *
 * `scheduled_services.rides_parent_id` — nullable, self-referencing FK to
 * `scheduled_services(id)`. Set ONLY on a recurring series PARENT row (the
 * rider, e.g. a quarterly-pest series) and points at another series'
 * PARENT row (the host, e.g. an every-6-weeks lawn series). When set, the
 * rider's future visit dates are derived from the host's actual dates
 * (server/services/rider-series.js#planRiderDates /
 * #syncRiderSeries) instead of the rider walking its own cadence — see the
 * scope doc's "Date rule" section.
 *
 * ON DELETE SET NULL (not CASCADE): deleting a host series parent must
 * detach its riders, never cascade-delete them — a rider with a cleared
 * link simply falls back to walking its own interval again (its own
 * recurring_pattern column is untouched by this migration and never
 * cleared), matching the scope doc's "host cancelled ... rider detaches"
 * design for PR 2/3 to wire up.
 *
 * Schema only — nothing in this PR sets or reads this column on real data.
 * It only becomes active once a series parent's rides_parent_id is set
 * (PR 2 = estimate accept, PR 3 = existing-customer backfill, both later).
 *
 * hasColumn-guarded up/down, matching this table's other additive
 * migrations (see 20260921000002_scheduled_services_pricing_provenance.js).
 */
const TABLE = 'scheduled_services';
const COL = 'rides_parent_id';
const INDEX = 'scheduled_services_rides_parent_id_index';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasColumn(TABLE, COL))) {
    await knex.schema.alterTable(TABLE, (t) => {
      t.uuid(COL).nullable().references('id').inTable(TABLE).onDelete('SET NULL');
    });
  }
  const hasIndex = await knex.raw(
    'SELECT 1 FROM pg_indexes WHERE tablename = ? AND indexname = ?',
    [TABLE, INDEX],
  );
  if (!hasIndex.rows.length) {
    await knex.schema.alterTable(TABLE, (t) => {
      t.index(COL, INDEX);
    });
  }
};

exports.down = async function down(knex) {
  const hasIndex = await knex.raw(
    'SELECT 1 FROM pg_indexes WHERE tablename = ? AND indexname = ?',
    [TABLE, INDEX],
  );
  if (hasIndex.rows.length) {
    await knex.schema.alterTable(TABLE, (t) => {
      t.dropIndex(COL, INDEX);
    });
  }
  if (await knex.schema.hasColumn(TABLE, COL)) {
    await knex.schema.alterTable(TABLE, (t) => {
      t.dropColumn(COL);
    });
  }
};
