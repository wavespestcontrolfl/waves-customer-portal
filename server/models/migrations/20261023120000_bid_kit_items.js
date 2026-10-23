/**
 * Bid kit (GATE_BID_KIT, dark). One admin-only table that holds the documents and company facts every government bid
 * asks for (the business license copy, the certified operator's certificate, the insurance certificate, references, the
 * company fact sheet), each with its private file, limits, source document, checked-on date, expiry and the owner's
 * sign-off. Nothing here is public and nothing is sent to anyone.
 *
 * It is a NEW table on purpose. business_credentials feeds the public /api/public/credentials endpoint and the
 * website, and its is_public column defaults to true, so no bid-kit column is added there. There is no link to
 * business_credentials at all: a live join would let a signed-off fact change when someone edits a credential, with the
 * sign-off still standing. The FDACS license number is a fact the owner types and signs off like any other.
 *
 * bid_kit_items
 *   kind                          document | fact | reference (checked by the database)
 *   item_key                      the catalog key (shared/bid-kit-catalog.cjs) or 'custom'; the catalog lives in code,
 *                                 so there are NO seed rows: a row is created when the owner fills an item
 *   label, value                  what the item is called and its text value (a fact's value, a policy number)
 *   file_s3_key, file_name,
 *   file_content_type, file_size  the private S3 object (never returned by any route, only a short signed link)
 *   limits                        insurance limits in whole dollars, plus workersComp 'statutory' | 'exempt'
 *   details                       a reference's entity, contact role, phone, email, period, scope, value
 *   source_document               where the value or file came from (the filed letter, the agency page)
 *   checked_on, expires_on        the date somebody looked, and the date the paper stops being valid
 *   permission_on                 the date a reference agreed to be named
 *   attested_by, attested_at      the owner's sign-off; cleared in the same update as any change it covered
 *   archived_at                   soft archive; the row stays
 *
 * Never stores a FEIN, EIN or SSN: the W-9 file is the only place one lives.
 *
 * down() drops the table. It holds only entries an admin made through the Bid kit page, and nothing else reads it,
 * so no other table changes (the way 20261022090000_bid_desk.js documents its down()).
 */
const TABLE = 'bid_kit_items';
const KINDS = ['document', 'fact', 'reference'];

const list = (values) => values.map((value) => `'${value}'`).join(', ');

exports.KINDS = KINDS;

exports.up = async function up(knex) {
  if (await knex.schema.hasTable(TABLE)) return;
  await knex.schema.createTable(TABLE, (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.string('kind', 12).notNullable();
    t.string('item_key', 48).notNullable();
    t.text('label').notNullable();
    t.text('value');
    t.text('file_s3_key');
    t.text('file_name');
    t.text('file_content_type');
    t.integer('file_size');
    t.jsonb('limits');
    t.jsonb('details');
    t.text('source_document');
    t.date('checked_on');
    t.date('expires_on');
    t.date('permission_on');
    t.uuid('attested_by');
    t.timestamp('attested_at', { useTz: true });
    t.text('notes');
    t.timestamp('archived_at', { useTz: true });
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
  await knex.raw(`ALTER TABLE ${TABLE} ADD CONSTRAINT bid_kit_items_kind_check CHECK (kind IN (${list(KINDS)}))`);
  await knex.raw(`CREATE INDEX bid_kit_items_kind_key ON ${TABLE} (kind, item_key) WHERE archived_at IS NULL`);
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists(TABLE);
};
