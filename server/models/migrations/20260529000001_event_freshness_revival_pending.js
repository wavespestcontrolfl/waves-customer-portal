/**
 * Add an explicit one-shot revival marker to events_raw.
 *
 * The ingestion upsert is the only layer that can see an event's date move
 * PAST→FUTURE (a feed re-dating a previously-expired event). When it does, it
 * sets this flag so the normalizer can recompute freshness for ONLY those rows
 * — rather than inferring "was revived" from `normalized_at IS NULL`, which is
 * not unique to revival (e.g. a geocode re-queue) and would otherwise let the
 * normalizer override an admin's manual `expired` curation of a future event.
 *
 * Lifecycle: ingestion sets it true on a genuine past→future re-date; the
 * normalizer reads it, recomputes, and clears it back to false (one-shot).
 * NOT NULL default false so the ON CONFLICT update never violates a constraint.
 */

exports.up = async function (knex) {
  await knex.schema.alterTable('events_raw', (table) => {
    table.boolean('freshness_revival_pending').notNullable().defaultTo(false);
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable('events_raw', (table) => {
    table.dropColumn('freshness_revival_pending');
  });
};
