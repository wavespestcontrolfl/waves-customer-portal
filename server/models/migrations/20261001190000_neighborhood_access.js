/**
 * Neighborhood access directory — PR 1 of the gate-code directory
 * (scope ~/gate-directory-scope-20261001.md, owner approved D1–D6 2026-10-01).
 *
 * Today a community gate code lives once per customer profile
 * (property_preferences.neighborhood_gate_code), so the same Del Webb gate is
 * stored per customer, a code change is fixed customer by customer, and a
 * tech cannot look a gate up by neighborhood. This adds:
 *   - neighborhoods: one row per community, named from the county parcel
 *     roll's recorded subdivision (phases collapsed to the base name) or
 *     picked by the office (Sarasota's layer returns a numeric code).
 *   - neighborhood_access: the community's way in — a keypad code, a
 *     guard/call-box instruction, or pass instructions (D1: passes are never
 *     stored, only how to get one). Owner ruling 10-01: a neighborhood gate
 *     code is SHARED by every stop in that neighborhood (techs only).
 *     A customer's own property codes (door, side gate, lockbox) stay on
 *     property_preferences and are never filed here (D5).
 *   - customer_properties.neighborhood_id (+ the raw county name and how the
 *     link was made). The link sits on the PROPERTY, not the profile, so a
 *     profile with two addresses can no longer leave a code's owner ambiguous.
 *
 * Purely additive: nothing reads these tables yet. The one-time fill is
 * ops/agents/neighborhood-access-backfill.js (dry-run default).
 */

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('neighborhoods'))) {
    await knex.schema.createTable('neighborhoods', (t) => {
      t.uuid('id').primary().defaultTo(knex.fn.uuid());
      t.string('name', 120).notNullable();
      t.string('county', 30);
      // county|lower(name) — the dedup key the service computes, so every
      // writer collapses "DEL WEBB PH II" and "DEL WEBB PH IV" onto one row.
      t.string('match_key', 200).notNullable().unique();
      // Every raw county subdivision name already mapped here.
      t.jsonb('subdivision_names').notNullable().defaultTo(knex.raw("'[]'::jsonb"));
      t.string('source', 20).notNullable(); // 'county' | 'office'
      t.boolean('active').notNullable().defaultTo(true);
      t.timestamps(true, true);
    });
  }

  if (!(await knex.schema.hasTable('neighborhood_access'))) {
    await knex.schema.createTable('neighborhood_access', (t) => {
      t.uuid('id').primary().defaultTo(knex.fn.uuid());
      t.uuid('neighborhood_id').notNullable().references('id').inTable('neighborhoods').onDelete('CASCADE');
      t.string('gate_label', 60).notNullable().defaultTo('Main gate');
      t.enu('access_type', ['keypad', 'callbox', 'guard', 'pass', 'open', 'instructions'], {
        useNative: false,
        enumName: 'neighborhood_access_type',
      }).notNullable();
      t.string('code', 100);
      t.text('instructions');
      // needs_confirm = conflicting codes, an unconfirmed source, or a tech's
      // "didn't work"; retired rows are kept for history, never deleted.
      t.enu('status', ['active', 'needs_confirm', 'retired'], {
        useNative: false,
        enumName: 'neighborhood_access_status',
      }).notNullable().defaultTo('active');
      t.string('source', 20).notNullable(); // 'backfill' | 'customer_sms' | 'office' | 'call' | 'tech'
      t.uuid('source_customer_id').references('id').inTable('customers').onDelete('SET NULL');
      t.timestamp('last_confirmed_at', { useTz: true });
      t.timestamps(true, true);

      t.index(['neighborhood_id']);
    });
    // One live row per code per neighborhood — the backstop for every writer's
    // read-then-insert, so a code given by ten neighbors files once.
    await knex.raw(
      'CREATE UNIQUE INDEX IF NOT EXISTS neighborhood_access_live_code_uniq '
      + "ON neighborhood_access (neighborhood_id, lower(code)) WHERE code IS NOT NULL AND status <> 'retired'"
    );
  }

  if (!(await knex.schema.hasColumn('customer_properties', 'neighborhood_id'))) {
    await knex.schema.alterTable('customer_properties', (t) => {
      t.uuid('neighborhood_id').references('id').inTable('neighborhoods').onDelete('SET NULL');
      t.string('neighborhood_source', 20); // 'county' | 'office' — an office pick is never overwritten
      t.string('county_subdivision', 200); // raw roll name, kept for re-matching
      t.timestamp('neighborhood_checked_at', { useTz: true });
      t.index(['neighborhood_id']);
    });
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasColumn('customer_properties', 'neighborhood_id')) {
    await knex.schema.alterTable('customer_properties', (t) => {
      t.dropIndex(['neighborhood_id']);
      t.dropColumn('neighborhood_id');
      t.dropColumn('neighborhood_source');
      t.dropColumn('county_subdivision');
      t.dropColumn('neighborhood_checked_at');
    });
  }
  await knex.schema.dropTableIfExists('neighborhood_access');
  await knex.schema.dropTableIfExists('neighborhoods');
};
