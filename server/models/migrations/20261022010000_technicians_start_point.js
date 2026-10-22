'use strict';

/**
 * technicians.start_address / start_lat / start_lng — where a technician starts
 * and ends the day (owner 2026-10-21/22: a second tech may take the truck home).
 *
 * Today every route starts and ends at one office point. This gives each
 * technician an OPTIONAL start point; the scheduling engine reads it behind its
 * own dark gate, so this migration changes no routing by itself.
 *
 * NULL in all three columns = "start from the office" (today's behavior). Set by
 * the admin Team tab (PUT /admin/timetracking/technicians/:id, `startPoint`),
 * which always writes the three columns together and refuses a point without both
 * coordinates. That both-or-neither rule lives in the route, deliberately NOT in a
 * CHECK constraint: a pushed migration is frozen, and a constraint could fail on
 * rows written by an older deploy or a manual fix.
 *
 * start_address is staff home-address PII: admin-only in every response, never
 * logged. Nullable, no backfill, additive only, idempotent (hasColumn guards).
 */
const COLUMNS = ['start_address', 'start_lat', 'start_lng'];

exports.up = async function up(knex) {
  const has = {};
  for (const c of COLUMNS) has[c] = await knex.schema.hasColumn('technicians', c);
  if (COLUMNS.every((c) => has[c])) return;
  await knex.schema.alterTable('technicians', (t) => {
    if (!has.start_address) t.text('start_address').nullable();
    if (!has.start_lat) t.decimal('start_lat', 10, 7).nullable();
    if (!has.start_lng) t.decimal('start_lng', 10, 7).nullable();
  });
};

exports.down = async function down(knex) {
  const present = [];
  for (const c of COLUMNS) {
    if (await knex.schema.hasColumn('technicians', c)) present.push(c);
  }
  if (!present.length) return;
  await knex.schema.alterTable('technicians', (t) => {
    for (const c of present) t.dropColumn(c);
  });
};
