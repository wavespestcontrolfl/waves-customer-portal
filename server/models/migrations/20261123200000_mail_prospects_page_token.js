'use strict';

/**
 * mail_prospects: each home's own page token and view counter (mailer step 2c). A later postcard carries a QR code to
 * the page of that one home (GET /api/public/home/:token, routes/mail-home-public.js). It follows 20261122200100, which
 * is frozen.
 *
 *   page_token            the page's credential: 32 lowercase hex characters, NOT NULL, unique. The default builds it
 *                         from gen_random_uuid(); a volatile default in ADD COLUMN is evaluated once for each existing
 *                         row, so every row that is already there gets its own value and the unique index holds.
 *   page_views            how many real opens the page had (bots and staff are not counted). NOT NULL, default 0.
 *   page_first_viewed_at  the first real open, NULL until then.
 *   page_last_viewed_at   the latest real open, NULL until then.
 *
 * Additive and idempotent: a column that is there is kept, a check and the index are replaced under their own names.
 * down drops the checks, the index and the four columns.
 */
const TABLE = 'mail_prospects';
const TOKEN = 'page_token';
const TOKEN_INDEX = 'mail_prospects_page_token_uniq';
const TOKEN_CHECK = 'mail_prospects_page_token_check';
const VIEWS_CHECK = 'mail_prospects_page_views_check';

async function setCheck(knex, name, check) {
  await knex.raw('ALTER TABLE ?? DROP CONSTRAINT IF EXISTS ??', [TABLE, name]);
  await knex.raw(`ALTER TABLE ?? ADD CONSTRAINT ?? CHECK (${check})`, [TABLE, name]);
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable(TABLE))) return;
  if (!(await knex.schema.hasColumn(TABLE, TOKEN))) {
    await knex.raw(
      `ALTER TABLE ?? ADD COLUMN ?? text NOT NULL DEFAULT replace(gen_random_uuid()::text, '-', '')`,
      [TABLE, TOKEN],
    );
  }
  if (!(await knex.schema.hasColumn(TABLE, 'page_views'))) {
    await knex.schema.alterTable(TABLE, (t) => { t.integer('page_views').notNullable().defaultTo(0); });
  }
  if (!(await knex.schema.hasColumn(TABLE, 'page_first_viewed_at'))) {
    await knex.schema.alterTable(TABLE, (t) => { t.timestamp('page_first_viewed_at', { useTz: true }); });
  }
  if (!(await knex.schema.hasColumn(TABLE, 'page_last_viewed_at'))) {
    await knex.schema.alterTable(TABLE, (t) => { t.timestamp('page_last_viewed_at', { useTz: true }); });
  }
  await knex.raw('CREATE UNIQUE INDEX IF NOT EXISTS ?? ON ?? (??)', [TOKEN_INDEX, TABLE, TOKEN]);
  await setCheck(knex, TOKEN_CHECK, `${TOKEN} ~ '^[0-9a-f]{32}$'`);
  await setCheck(knex, VIEWS_CHECK, 'page_views >= 0');
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable(TABLE))) return;
  await knex.raw('ALTER TABLE ?? DROP CONSTRAINT IF EXISTS ??', [TABLE, TOKEN_CHECK]);
  await knex.raw('ALTER TABLE ?? DROP CONSTRAINT IF EXISTS ??', [TABLE, VIEWS_CHECK]);
  await knex.raw('DROP INDEX IF EXISTS ??', [TOKEN_INDEX]);
  for (const column of ['page_last_viewed_at', 'page_first_viewed_at', 'page_views', TOKEN]) {
    if (await knex.schema.hasColumn(TABLE, column)) {
      await knex.schema.alterTable(TABLE, (t) => { t.dropColumn(column); });
    }
  }
};
