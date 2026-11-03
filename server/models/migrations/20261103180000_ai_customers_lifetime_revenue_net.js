/**
 * ai_customers.lifetime_revenue = net of paid payments, not the stored column.
 *
 * customers.lifetime_revenue has no production writer, so it reads $0 for
 * nearly every real customer, and the AI chart builder's ai_customers view
 * (20260626000011) passed that dead number through. Every admin screen already
 * computes lifetime revenue as the net of paid payments (amount minus
 * refunds); the view now does the same, so a chart of revenue by customer,
 * lead source or tier matches those screens.
 *
 * The column list is read from the live view, so names, order and types stay
 * identical: CREATE OR REPLACE VIEW keeps the aichart_readonly grant. The
 * test-account exclusion is rebuilt exactly as 20260626000011 builds it. The
 * view is owner-defined, so the payments subquery runs with the owner's rights
 * and the role still has no base-table access. Down restores the stored column.
 */

const { INTERNAL_TEST_CUSTOMERS } = require('../../services/internal-test-customers');

const VIEW = 'ai_customers';
const NAME_FIRSTLAST = "lower(coalesce(t.first_name,'') || ' ' || coalesce(t.last_name,''))";
const LIVE_CUSTOMER = "(t.active AND t.deleted_at IS NULL AND t.pipeline_stage IN ('active_customer','won','at_risk')) AS is_live_customer";
const NET_PAID = "(SELECT COALESCE(SUM(p.amount - COALESCE(p.refund_amount, 0)), 0) FROM payments p WHERE p.customer_id = t.id AND p.status = 'paid')";

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
    if (name === 'lifetime_revenue') return `${revenueSql(type)} AS lifetime_revenue`;
    if (name === 'is_live_customer') return LIVE_CUSTOMER;
    return `t.${qIdent(name)}`;
  });
  const testArr = testNamesArrayLiteral();
  const where = testArr ? ` WHERE ${NAME_FIRSTLAST} <> ALL(${testArr})` : '';
  await knex.raw(`CREATE OR REPLACE VIEW ${qIdent(VIEW)} AS SELECT ${select.join(', ')} FROM ${qIdent('customers')} t${where}`);
  return true;
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('payments'))) return;
  if (await rebuild(knex, (type) => `${NET_PAID}::${type}`)) console.log(`[migration 20261103180000] ${VIEW}.lifetime_revenue = net paid payments`);
};

exports.down = async function down(knex) {
  await rebuild(knex, () => `t.${qIdent('lifetime_revenue')}`);
};
