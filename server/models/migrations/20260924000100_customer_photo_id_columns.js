/**
 * Customer Photo ID (server, dark) — schema support.
 *
 * 1. `pest_identifications.mode` and `lawn_diagnostics.mode` gain a third
 *    value, 'customer', for photo-id submissions a logged-in customer files
 *    from the portal (distinct from 'internal' tech-captured rows and
 *    'prospect' public-funnel rows). Same drop/re-add CHECK pattern as
 *    20260707000030_prospect_photo_assessments.js.
 * 2. `tree_shrub_assessments` gains `source` (string, default 'tech') and
 *    `mode` (string, default 'internal') to mirror the other two tables —
 *    it had neither column before this migration.
 * 3. All three tables gain `note` (free-text customer note, nullable) and
 *    `location` (one of requests.js's VALID_LOCATIONS, nullable) ONLY where
 *    no equivalent column already exists.
 */

const PEST_MODES = ['internal', 'prospect', 'customer'];
const LAWN_MODES = ['internal', 'prospect', 'customer'];

function quoted(values) {
  return values.map((value) => `'${value}'`).join(', ');
}

async function addIfMissing(knex, table, column, build) {
  if (await knex.schema.hasTable(table) && !(await knex.schema.hasColumn(table, column))) {
    await knex.schema.alterTable(table, (t) => { build(t); });
  }
}

// down() narrowing the mode CHECK back to ('internal','prospect') is DDL that
// Postgres validates against every existing row — once a real customer photo-
// id submission exists (mode='customer'), that ADD CONSTRAINT throws and
// aborts the whole rollback (codex r2 P1). Narrowing the constraint back is
// safe only while no row actually uses the value being removed; otherwise
// leave the wider (3-value) CHECK in place — permissive-but-working beats a
// rollback that can't run at all.
async function canNarrowModeCheck(knex, table) {
  try {
    const row = await knex(table).where({ mode: 'customer' }).first('id');
    return !row;
  } catch {
    // Can't verify — stay on the wider (3-value) CHECK rather than risk the
    // same ADD CONSTRAINT failure this guard exists to avoid.
    return false;
  }
}

exports.up = async function up(knex) {
  if (await knex.schema.hasTable('pest_identifications')) {
    await knex.raw('ALTER TABLE pest_identifications DROP CONSTRAINT IF EXISTS pest_identifications_mode_check');
    await knex.raw(`
      ALTER TABLE pest_identifications
      ADD CONSTRAINT pest_identifications_mode_check CHECK (mode IN (${quoted(PEST_MODES)}))
    `);
    await addIfMissing(knex, 'pest_identifications', 'note', (t) => t.text('note').nullable());
    await addIfMissing(knex, 'pest_identifications', 'location', (t) => t.string('location', 30).nullable());
  }

  if (await knex.schema.hasTable('lawn_diagnostics')) {
    await knex.raw('ALTER TABLE lawn_diagnostics DROP CONSTRAINT IF EXISTS lawn_diagnostics_mode_check');
    await knex.raw(`
      ALTER TABLE lawn_diagnostics
      ADD CONSTRAINT lawn_diagnostics_mode_check CHECK (mode IN (${quoted(LAWN_MODES)}))
    `);
    await addIfMissing(knex, 'lawn_diagnostics', 'note', (t) => t.text('note').nullable());
    await addIfMissing(knex, 'lawn_diagnostics', 'location', (t) => t.string('location', 30).nullable());
  }

  if (await knex.schema.hasTable('tree_shrub_assessments')) {
    await addIfMissing(knex, 'tree_shrub_assessments', 'source', (t) => t.string('source', 30).notNullable().defaultTo('tech'));
    await addIfMissing(knex, 'tree_shrub_assessments', 'mode', (t) => t.string('mode', 20).notNullable().defaultTo('internal'));
    await addIfMissing(knex, 'tree_shrub_assessments', 'note', (t) => t.text('note').nullable());
    await addIfMissing(knex, 'tree_shrub_assessments', 'location', (t) => t.string('location', 30).nullable());
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasTable('tree_shrub_assessments')) {
    if (await knex.schema.hasColumn('tree_shrub_assessments', 'location')) {
      await knex.schema.alterTable('tree_shrub_assessments', (t) => { t.dropColumn('location'); });
    }
    if (await knex.schema.hasColumn('tree_shrub_assessments', 'note')) {
      await knex.schema.alterTable('tree_shrub_assessments', (t) => { t.dropColumn('note'); });
    }
    if (await knex.schema.hasColumn('tree_shrub_assessments', 'mode')) {
      await knex.schema.alterTable('tree_shrub_assessments', (t) => { t.dropColumn('mode'); });
    }
    if (await knex.schema.hasColumn('tree_shrub_assessments', 'source')) {
      await knex.schema.alterTable('tree_shrub_assessments', (t) => { t.dropColumn('source'); });
    }
  }

  if (await knex.schema.hasTable('lawn_diagnostics')) {
    if (await knex.schema.hasColumn('lawn_diagnostics', 'location')) {
      await knex.schema.alterTable('lawn_diagnostics', (t) => { t.dropColumn('location'); });
    }
    if (await knex.schema.hasColumn('lawn_diagnostics', 'note')) {
      await knex.schema.alterTable('lawn_diagnostics', (t) => { t.dropColumn('note'); });
    }
    if (await canNarrowModeCheck(knex, 'lawn_diagnostics')) {
      await knex.raw('ALTER TABLE lawn_diagnostics DROP CONSTRAINT IF EXISTS lawn_diagnostics_mode_check');
      await knex.raw(`
        ALTER TABLE lawn_diagnostics
        ADD CONSTRAINT lawn_diagnostics_mode_check CHECK (mode IN (${quoted(['internal', 'prospect'])}))
      `);
    }
    // else: a real 'customer' row exists — leave the 3-value CHECK in place.
  }

  if (await knex.schema.hasTable('pest_identifications')) {
    if (await knex.schema.hasColumn('pest_identifications', 'location')) {
      await knex.schema.alterTable('pest_identifications', (t) => { t.dropColumn('location'); });
    }
    if (await knex.schema.hasColumn('pest_identifications', 'note')) {
      await knex.schema.alterTable('pest_identifications', (t) => { t.dropColumn('note'); });
    }
    if (await canNarrowModeCheck(knex, 'pest_identifications')) {
      await knex.raw('ALTER TABLE pest_identifications DROP CONSTRAINT IF EXISTS pest_identifications_mode_check');
      await knex.raw(`
        ALTER TABLE pest_identifications
        ADD CONSTRAINT pest_identifications_mode_check CHECK (mode IN (${quoted(['internal', 'prospect'])}))
      `);
    }
    // else: a real 'customer' row exists — leave the 3-value CHECK in place.
  }
};
