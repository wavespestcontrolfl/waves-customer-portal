/**
 * decision_reviews.provider: which provider answered (typesafe = Jev). The
 * unique key gains it, so a second provider answering the SAME subject and
 * question keeps its own row instead of overwriting the first one's answer or
 * being discarded by the labeled / held-out merge guard (Codex r1 on #5546).
 *
 * Existing rows are Jev's: the NOT NULL column backfills 'typesafe' through
 * its default. The set is closed by CHECK and mirrors DECISION_PROVIDERS in
 * services/typed-decisions/packages.js; a new provider is a new migration.
 * The new unique lands before the old one is dropped, so the table is never
 * without one.
 */
const TABLE = 'decision_reviews';
const OLD_UNIQUE = 'decision_reviews_subject_question_uniq';
const NEW_UNIQUE = 'decision_reviews_provider_subject_question_uniq';
const CHECK = 'decision_reviews_provider_check';
const PROVIDERS = ['typesafe', 'cloudflare'];
const DEFAULT_PROVIDER = 'typesafe';
const inList = PROVIDERS.map((p) => `'${p}'`).join(', ');

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable(TABLE))) return;
  if (!(await knex.schema.hasColumn(TABLE, 'provider'))) {
    await knex.schema.alterTable(TABLE, (t) => { t.string('provider', 30).notNullable().defaultTo(DEFAULT_PROVIDER); });
  }
  await knex.raw(`ALTER TABLE ${TABLE} DROP CONSTRAINT IF EXISTS ${CHECK}`);
  await knex.raw(`ALTER TABLE ${TABLE} ADD CONSTRAINT ${CHECK} CHECK (provider IN (${inList}))`);
  await knex.raw(`ALTER TABLE ${TABLE} DROP CONSTRAINT IF EXISTS ${NEW_UNIQUE}`);
  await knex.raw(`ALTER TABLE ${TABLE} ADD CONSTRAINT ${NEW_UNIQUE} UNIQUE (capability, package_id, provider, subject_type, subject_id, question_id)`);
  await knex.raw(`ALTER TABLE ${TABLE} DROP CONSTRAINT IF EXISTS ${OLD_UNIQUE}`);
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable(TABLE))) return;
  if (!(await knex.schema.hasColumn(TABLE, 'provider'))) return;
  // The old key has no provider: a second provider's rows would collide on
  // it. Refuse rather than delete review evidence to make the rollback fit.
  const other = await knex(TABLE).whereNot({ provider: DEFAULT_PROVIDER }).first('id');
  if (other) {
    throw new Error(`${TABLE} holds rows from a provider other than ${DEFAULT_PROVIDER}; export or remove them before rolling back the provider key`);
  }
  await knex.raw(`ALTER TABLE ${TABLE} DROP CONSTRAINT IF EXISTS ${OLD_UNIQUE}`);
  await knex.raw(`ALTER TABLE ${TABLE} ADD CONSTRAINT ${OLD_UNIQUE} UNIQUE (capability, package_id, subject_type, subject_id, question_id)`);
  await knex.raw(`ALTER TABLE ${TABLE} DROP CONSTRAINT IF EXISTS ${NEW_UNIQUE}`);
  await knex.raw(`ALTER TABLE ${TABLE} DROP CONSTRAINT IF EXISTS ${CHECK}`);
  await knex.schema.alterTable(TABLE, (t) => { t.dropColumn('provider'); });
};

exports.PROVIDERS = PROVIDERS;
