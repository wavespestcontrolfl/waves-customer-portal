// The dispute and PI-canceled webhook handlers write payments.status
// 'disputed' / 'canceled', but the original enum check constraint only
// allows upcoming/processing/paid/failed/refunded — both updates have
// been violating the constraint and getting swallowed by .catch(),
// so chargebacks left the ledger showing 'paid'. Extend the allowed set.
const ORIGINAL = ['upcoming', 'processing', 'paid', 'failed', 'refunded'];
const EXTENDED = [...ORIGINAL, 'disputed', 'canceled'];

const checkSql = (values) =>
  `ALTER TABLE payments ADD CONSTRAINT payments_status_check CHECK (status = ANY (ARRAY[${values.map((v) => `'${v}'`).join(', ')}]::text[]))`;

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('payments'))) return;
  await knex.raw('ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_status_check');
  await knex.raw(checkSql(EXTENDED));
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('payments'))) return;
  // Rows holding the new values would violate the restored constraint.
  await knex('payments').whereIn('status', ['disputed', 'canceled']).update({ status: 'failed' });
  await knex.raw('ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_status_check');
  await knex.raw(checkSql(ORIGINAL));
};
