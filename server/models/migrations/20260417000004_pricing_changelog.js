/**
 * Migration — Create pricing_changelog table
 *
 * v4.3 Session 1, Step 1b. Queryable record of every pricing change —
 * business rule, cost input, bug fix, architecture change. rationale is
 * NOT NULL intentionally: no entry ships without a why.
 */
exports.up = async function (knex) {
  const hasTable = await knex.schema.hasTable('pricing_changelog');
  if (hasTable) return;

  await knex.schema.createTable('pricing_changelog', (t) => {
    t.increments('id').primary();
    t.string('version_from', 10).notNullable();
    t.string('version_to', 10).notNullable();
    t.timestamp('changed_at').notNullable().defaultTo(knex.fn.now());
    t.string('changed_by', 100).notNullable();
    t.string('category', 30).notNullable();
    t.text('summary').notNullable();
    t.jsonb('affected_services').defaultTo('[]');
    t.jsonb('before_value');
    t.jsonb('after_value');
    t.text('rationale').notNullable();

    t.index('version_to', 'idx_changelog_version');
    t.index('category', 'idx_changelog_category');
    t.index('changed_at', 'idx_changelog_changed_at');
  });

  // Category CHECK constraint — enforces the enum without fighting knex alter-table
  await knex.raw(`
    ALTER TABLE pricing_changelog
    ADD CONSTRAINT pricing_changelog_category_check
    CHECK (category IN ('bug', 'leak', 'rule', 'cost', 'architecture', 'documentation', 'infrastructure'))
  `);

  // Seed entry marking Session 1 completion
  await knex('pricing_changelog').insert({
    version_from: 'v4.2',
    version_to: 'v4.2',
    changed_by: 'claude-code-session-1',
    category: 'infrastructure',
    summary: 'Session 1 of v4.3 build: change-tracking infrastructure in place.',
    affected_services: JSON.stringify([]),
    before_value: null,
    after_value: null,
    rationale: 'First session of the v4.3 pricing engine build. Adds pricing_version column to estimates, pricing_changelog table (this one), and pricing_engine_proposals table. Engine still runs v4.2 logic — version bump to v4.3 happens after all ten sessions complete. No customer-facing pricing changes in this session.',
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('pricing_changelog');
};
