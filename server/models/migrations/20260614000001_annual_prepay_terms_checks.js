const STATUS_CONSTRAINT = 'annual_prepay_terms_status_check';
const RENEWAL_DECISION_CONSTRAINT = 'annual_prepay_terms_renewal_decision_check';

const TERM_STATUSES = [
  'payment_pending',
  'active',
  'renewal_pending',
  'cancelled',
  'canceled',
  'refunded',
  'renewed',
  'switch_plan',
];

const RENEWAL_DECISIONS = [
  'renew',
  'cancel',
  'switch_plan',
];

function quotedList(values) {
  return values.map((value) => `'${String(value).replace(/'/g, "''")}'`).join(', ');
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('annual_prepay_terms'))) return;

  const statusValues = quotedList(TERM_STATUSES);
  const decisionValues = quotedList(RENEWAL_DECISIONS);

  await knex.raw(`ALTER TABLE annual_prepay_terms DROP CONSTRAINT IF EXISTS ${STATUS_CONSTRAINT}`);
  await knex.raw(`ALTER TABLE annual_prepay_terms DROP CONSTRAINT IF EXISTS ${RENEWAL_DECISION_CONSTRAINT}`);

  await knex.raw(`
    UPDATE annual_prepay_terms
    SET status = 'payment_pending', updated_at = COALESCE(updated_at, NOW())
    WHERE status IS NULL OR status NOT IN (${statusValues})
  `);

  await knex.raw(`
    UPDATE annual_prepay_terms
    SET renewal_decision = NULL, updated_at = COALESCE(updated_at, NOW())
    WHERE renewal_decision IS NOT NULL AND renewal_decision NOT IN (${decisionValues})
  `);

  await knex.raw(`
    ALTER TABLE annual_prepay_terms
    ADD CONSTRAINT ${STATUS_CONSTRAINT}
    CHECK (status IN (${statusValues}))
  `);

  await knex.raw(`
    ALTER TABLE annual_prepay_terms
    ADD CONSTRAINT ${RENEWAL_DECISION_CONSTRAINT}
    CHECK (renewal_decision IS NULL OR renewal_decision IN (${decisionValues}))
  `);
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('annual_prepay_terms'))) return;
  await knex.raw(`ALTER TABLE annual_prepay_terms DROP CONSTRAINT IF EXISTS ${RENEWAL_DECISION_CONSTRAINT}`);
  await knex.raw(`ALTER TABLE annual_prepay_terms DROP CONSTRAINT IF EXISTS ${STATUS_CONSTRAINT}`);
};
