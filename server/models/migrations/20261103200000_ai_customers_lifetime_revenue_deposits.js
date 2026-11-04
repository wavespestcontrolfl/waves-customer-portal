/**
 * ai_customers.lifetime_revenue = paid payments net of refunds + estimate deposits.
 *
 * 20261103180000 switched the AI chart builder's ai_customers view from the
 * dead stored column to the net of paid payments. Estimate deposits
 * deliberately have no payments row (estimate-deposits.js), so that figure
 * still missed every deposit a customer paid. The view now uses the same
 * definition as services/customer-lifetime-revenue.js: payments net + each
 * received deposit's collected cash as invoice.js counts it (face minus face
 * refunds, plus the surcharge minus refunded_surcharge, or prorated by the
 * unrefunded face when that stamp is NULL), with a deposit that has no
 * customer_id credited to its estimate's customer.
 *
 * Same rebuild as 20261103180000: the column list is read from the live view,
 * so names, order and types stay identical and CREATE OR REPLACE VIEW keeps
 * the aichart_readonly grant; the test-account exclusion is rebuilt as
 * 20260626000011 builds it. Down restores the payments-only net.
 */

const { INTERNAL_TEST_CUSTOMERS } = require('../../services/internal-test-customers');

const VIEW = 'ai_customers';
const NAME_FIRSTLAST = "lower(coalesce(t.first_name,'') || ' ' || coalesce(t.last_name,''))";
const LIVE_CUSTOMER = "(t.active AND t.deleted_at IS NULL AND t.pipeline_stage IN ('active_customer','won','at_risk')) AS is_live_customer";
const NET_PAID = "(SELECT COALESCE(SUM(p.amount - COALESCE(p.refund_amount, 0)), 0) FROM payments p WHERE p.customer_id = t.id AND p.status = 'paid')";
const NET_DEPOSITS = '(SELECT COALESCE(SUM(GREATEST(d.amount - COALESCE(d.refunded_amount, 0), 0)'
  + ' + COALESCE(CASE WHEN d.refunded_surcharge IS NOT NULL'
  + ' THEN GREATEST(COALESCE(d.card_surcharge, 0) - d.refunded_surcharge, 0)'
  + ' ELSE COALESCE(d.card_surcharge, 0) * GREATEST(d.amount - COALESCE(d.refunded_amount, 0), 0) / NULLIF(d.amount, 0) END, 0)), 0)'
  + ' FROM estimate_deposits d LEFT JOIN estimates e ON e.id = d.estimate_id'
  + ' WHERE COALESCE(d.customer_id, e.customer_id) = t.id AND d.received_at IS NOT NULL)';

const qIdent = (s) => `"${String(s).replace(/"/g, '""')}"`;

function testNamesArrayLiteral() {
  const list = (INTERNAL_TEST_CUSTOMERS || []).map((n) => `'${String(n).replace(/'/g, "''")}'`);
  return list.length ? `ARRAY[${list.join(', ')}]` : null;
}

async function viewColumns(knex) {
  const found = await knex.raw('SELECT to_regclass(?) AS oid', [`public.${VIEW}`]);
  if (!found.rows[0]?.oid) return null;
  const { rows } = await knex.raw(
    `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type
       FROM pg_attribute a
      WHERE a.attrelid = ?::regclass AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY a.attnum`,
    [`public.${VIEW}`],
  );
  return rows;
}

async function rebuild(knex, revenueSql) {
  const cols = await viewColumns(knex);
  if (!cols || !cols.some((c) => c.name === 'lifetime_revenue')) return false;
  const select = cols.map(({ name, type }) => {
    if (name === 'lifetime_revenue') return `${revenueSql}::${type} AS lifetime_revenue`;
    if (name === 'is_live_customer') return LIVE_CUSTOMER;
    return `t.${qIdent(name)}`;
  });
  const testArr = testNamesArrayLiteral();
  const where = testArr ? ` WHERE ${NAME_FIRSTLAST} <> ALL(${testArr})` : '';
  await knex.raw(`CREATE OR REPLACE VIEW ${qIdent(VIEW)} AS SELECT ${select.join(', ')} FROM ${qIdent('customers')} t${where}`);
  return true;
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('payments')) || !(await knex.schema.hasTable('estimate_deposits'))) return;
  if (await rebuild(knex, `(${NET_PAID} + ${NET_DEPOSITS})`)) console.log(`[migration 20261103200000] ${VIEW}.lifetime_revenue = payments net + deposits`);
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('payments'))) return;
  await rebuild(knex, NET_PAID);
};
