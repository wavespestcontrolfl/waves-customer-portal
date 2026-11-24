'use strict';

/**
 * mail_prospects: each new home's short typed address (mailer step 2d-2). The postcard prints
 * "gowavesfl.com/101-example" beside the QR code; GET /go/:slug (routes/mail-home-go.js) sends that slug to the home's
 * page /h/:page_token. It follows 20261123200000, which is frozen.
 *
 *   page_slug  the house number and the street name, lowercase, joined by dashes ("101-example"); "101-example-34211"
 *              (the ZIP added) when two homes clash; NULL when the home has none yet (the card prints the QR code
 *              only). Set once by services/mail/prospect-store.js and never changed. Unique where not NULL. The CHECK is
 *              the shape the redirect route accepts.
 *
 * Additive and idempotent: a column that is there is kept, the check and the index are replaced under their own names.
 * down drops the check, the index and the column.
 */
const TABLE = 'mail_prospects';
const SLUG = 'page_slug';
const SLUG_INDEX = 'mail_prospects_page_slug_uniq';
const SLUG_CHECK = 'mail_prospects_page_slug_check';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable(TABLE))) return;
  if (!(await knex.schema.hasColumn(TABLE, SLUG))) {
    await knex.schema.alterTable(TABLE, (t) => { t.text(SLUG).nullable(); });
  }
  await knex.raw('CREATE UNIQUE INDEX IF NOT EXISTS ?? ON ?? (??) WHERE ?? IS NOT NULL', [SLUG_INDEX, TABLE, SLUG, SLUG]);
  await knex.raw('ALTER TABLE ?? DROP CONSTRAINT IF EXISTS ??', [TABLE, SLUG_CHECK]);
  await knex.raw(
    `ALTER TABLE ?? ADD CONSTRAINT ?? CHECK (?? IS NULL OR ?? ~ '^[0-9]+-[a-z0-9]+(-[a-z0-9]+)*$')`,
    [TABLE, SLUG_CHECK, SLUG, SLUG],
  );
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable(TABLE))) return;
  await knex.raw('ALTER TABLE ?? DROP CONSTRAINT IF EXISTS ??', [TABLE, SLUG_CHECK]);
  await knex.raw('DROP INDEX IF EXISTS ??', [SLUG_INDEX]);
  if (await knex.schema.hasColumn(TABLE, SLUG)) {
    await knex.schema.alterTable(TABLE, (t) => { t.dropColumn(SLUG); });
  }
};
