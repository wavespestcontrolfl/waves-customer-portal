'use strict';

/**
 * mail_prospects: which homes were mailed a postcard, the price that was printed on it, and how often the typed address
 * is used (mailer step 3). It follows 20261124040000, which is frozen.
 *
 *   mailed_at         when the home's card was marked as mailed (ops/agents/mark-mail-batch.js), NULL until then. The
 *                     price hold (60 days) counts from this day.
 *   mail_batch        the name of the print run, at most 40 characters ("2026-11-a"). NULL until mailed.
 *   mailed_price      what the printed label shows, frozen at the moment of marking: a jsonb object
 *                     { plan, annual, monthly, setupFee, pricedAt }. The amounts are dollars as numbers, the unit of
 *                     price_annual and price_setup_fee (numeric(10,2)); monthly is annual / 12 from whole cents (the
 *                     label and the home's page show it); pricedAt is the ISO time of priced_at. NULL until mailed.
 *   page_typed_views  how many times the printed address (gowavesfl.com/<slug> through GET /nh/:slug) found this home.
 *                     NOT NULL, default 0. page_views (20261123200000) counts opens of the page itself.
 *
 * Rules the table keeps, whatever code writes to it:
 *   - the three mailed columns are all set or all NULL, the batch name is not blank, the snapshot holds three numbers
 *     and a plan, and only a priced home can be mailed;
 *   - page_typed_views is not negative;
 *   - once mailed_at is set the row's price (price_status, price_reason, price_annual, price_setup_fee, price_digest,
 *     priced_at) and its mailed record never change: a BEFORE UPDATE trigger refuses with code 23514. A card is in a
 *     mailbox with that price on it, so no later price run, deed save or script may move it. An update that writes the
 *     same value is not a change and passes.
 *
 * Additive and idempotent: a column that is there is kept; the checks and the trigger are replaced under their own
 * names. down refuses once any home is marked as mailed (the record of what was printed would be lost); before that it
 * drops the trigger, the function, the checks and the four columns.
 */
const TABLE = 'mail_prospects';
const FUNCTION = 'mail_prospects_freeze_mailed';
const TRIGGER = 'mail_prospects_freeze_mailed_trg';
const MAILED_CHECK = 'mail_prospects_mailed_record_check';
const TYPED_CHECK = 'mail_prospects_page_typed_views_check';

const COLUMNS = ['mailed_at', 'mail_batch', 'mailed_price', 'page_typed_views'];

// A CHECK passes on NULL, and jsonb_typeof(mailed_price -> 'x') is NULL for a snapshot that is not an object: the second
// branch is wrapped in COALESCE so such a snapshot is refused.
const MAILED_RULE = `(
  mailed_at IS NULL AND mail_batch IS NULL AND mailed_price IS NULL
) OR COALESCE((
  mailed_at IS NOT NULL
  AND mail_batch IS NOT NULL AND btrim(mail_batch) <> ''
  AND price_status = 'priced'
  AND jsonb_typeof(mailed_price) = 'object'
  AND jsonb_typeof(mailed_price -> 'plan') = 'string'
  AND jsonb_typeof(mailed_price -> 'annual') = 'number'
  AND jsonb_typeof(mailed_price -> 'monthly') = 'number'
  AND jsonb_typeof(mailed_price -> 'setupFee') = 'number'
), false)`;

async function setCheck(knex, name, check) {
  await knex.raw('ALTER TABLE ?? DROP CONSTRAINT IF EXISTS ??', [TABLE, name]);
  await knex.raw(`ALTER TABLE ?? ADD CONSTRAINT ?? CHECK (${check})`, [TABLE, name]);
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable(TABLE))) return;
  if (!(await knex.schema.hasColumn(TABLE, 'mailed_at'))) {
    await knex.schema.alterTable(TABLE, (t) => { t.timestamp('mailed_at', { useTz: true }).nullable(); });
  }
  if (!(await knex.schema.hasColumn(TABLE, 'mail_batch'))) {
    await knex.schema.alterTable(TABLE, (t) => { t.string('mail_batch', 40).nullable(); });
  }
  if (!(await knex.schema.hasColumn(TABLE, 'mailed_price'))) {
    await knex.schema.alterTable(TABLE, (t) => { t.jsonb('mailed_price').nullable(); });
  }
  if (!(await knex.schema.hasColumn(TABLE, 'page_typed_views'))) {
    await knex.schema.alterTable(TABLE, (t) => { t.integer('page_typed_views').notNullable().defaultTo(0); });
  }
  await setCheck(knex, MAILED_CHECK, MAILED_RULE);
  await setCheck(knex, TYPED_CHECK, 'page_typed_views >= 0');

  await knex.raw(`
    CREATE OR REPLACE FUNCTION ${FUNCTION}() RETURNS trigger AS $fn$
    BEGIN
      IF OLD.mailed_at IS NOT NULL AND (
        NEW.mailed_at IS DISTINCT FROM OLD.mailed_at
        OR NEW.mail_batch IS DISTINCT FROM OLD.mail_batch
        OR NEW.mailed_price IS DISTINCT FROM OLD.mailed_price
        OR NEW.price_status IS DISTINCT FROM OLD.price_status
        OR NEW.price_reason IS DISTINCT FROM OLD.price_reason
        OR NEW.price_annual IS DISTINCT FROM OLD.price_annual
        OR NEW.price_setup_fee IS DISTINCT FROM OLD.price_setup_fee
        OR NEW.price_digest IS DISTINCT FROM OLD.price_digest
        OR NEW.priced_at IS DISTINCT FROM OLD.priced_at
      ) THEN
        RAISE EXCEPTION 'mail_prospects row % was mailed: its price and mailed record are frozen', OLD.id
          USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END
    $fn$ LANGUAGE plpgsql`);
  await knex.raw('DROP TRIGGER IF EXISTS ?? ON ??', [TRIGGER, TABLE]);
  await knex.raw(`CREATE TRIGGER ${TRIGGER} BEFORE UPDATE ON ?? FOR EACH ROW EXECUTE FUNCTION ${FUNCTION}()`, [TABLE]);
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable(TABLE))) return;
  // The record of what was printed on a mailed card must not be dropped. Block writers until the drop commits (knex
  // runs a migration in a transaction), so no row is marked after the check.
  if (await knex.schema.hasColumn(TABLE, 'mailed_at')) {
    await knex.raw('LOCK TABLE ?? IN SHARE ROW EXCLUSIVE MODE', [TABLE]);
    const mailed = await knex(TABLE).whereNotNull('mailed_at').first('id');
    if (mailed) throw new Error('mail_prospects has homes marked as mailed (their printed price is recorded here); refusing to drop the columns');
  }
  // Typed-link visits are counted before any home is mailed: keep those counts too (same lock, same transaction).
  if (await knex.schema.hasColumn(TABLE, 'page_typed_views')) {
    await knex.raw('LOCK TABLE ?? IN SHARE ROW EXCLUSIVE MODE', [TABLE]);
    const visited = await knex(TABLE).where('page_typed_views', '>', 0).first('id');
    if (visited) throw new Error('mail_prospects has typed-link visit counts; refusing to drop the columns');
  }
  await knex.raw('DROP TRIGGER IF EXISTS ?? ON ??', [TRIGGER, TABLE]);
  await knex.raw(`DROP FUNCTION IF EXISTS ${FUNCTION}()`);
  await knex.raw('ALTER TABLE ?? DROP CONSTRAINT IF EXISTS ??', [TABLE, MAILED_CHECK]);
  await knex.raw('ALTER TABLE ?? DROP CONSTRAINT IF EXISTS ??', [TABLE, TYPED_CHECK]);
  for (const column of COLUMNS) {
    if (await knex.schema.hasColumn(TABLE, column)) {
      await knex.schema.alterTable(TABLE, (t) => { t.dropColumn(column); });
    }
  }
};
