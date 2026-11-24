'use strict';

/**
 * Tech Rewards Plan D5-5, part 1: pay runs can carry a season bonus, a stay bonus and a December gift as pay lines
 * (owner rulings 2026-11-20). Additive. Nothing writes one of these lines yet.
 *
 *   payroll_pay_lines.kind              the CHECK now also allows 'season_bonus', 'stay_bonus' and 'december_gift'
 *                                       (every earlier value stays). The admin "add a line" form still offers the four
 *                                       manual kinds only.
 *   payroll_checks.tech_rewards_cents   the three kinds' sum on a check. Nullable, null on every existing check and on
 *                                       any check with no such line, so a check with none keeps exactly today's columns.
 *                                       It is in gross pay (taxable wages) like a review bonus.
 *
 * protect_payroll_checks compares whole rows with to_jsonb, so a finalized check cannot change the new column either;
 * that trigger is not touched. A pushed migration is frozen: a fix is another file.
 */
const OLD_KINDS = ['review_bonus', 'commission', 'health_allowance', 'hsa_employer'];
const NEW_KINDS = ['season_bonus', 'stay_bonus', 'december_gift'];
const list = (kinds) => kinds.map((kind) => `'${kind}'`).join(', ');

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('payroll_pay_lines'))) return;
  await knex.raw('ALTER TABLE payroll_pay_lines DROP CONSTRAINT IF EXISTS payroll_pay_lines_kind_check');
  await knex.raw(`ALTER TABLE payroll_pay_lines
    ADD CONSTRAINT payroll_pay_lines_kind_check CHECK (kind IN (${list([...OLD_KINDS, ...NEW_KINDS])}))`);
  if (!(await knex.schema.hasColumn('payroll_checks', 'tech_rewards_cents'))) {
    await knex.raw('ALTER TABLE payroll_checks ADD COLUMN tech_rewards_cents bigint NULL');
  }
  await knex.raw('ALTER TABLE payroll_checks DROP CONSTRAINT IF EXISTS payroll_checks_tech_rewards_check');
  await knex.raw(`ALTER TABLE payroll_checks
    ADD CONSTRAINT payroll_checks_tech_rewards_check CHECK (tech_rewards_cents IS NULL OR tech_rewards_cents >= 0)`);
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('payroll_pay_lines'))) return;
  // Pay lines and checks that already hold these figures are payroll evidence: preserve them and roll forward.
  if (await knex('payroll_pay_lines').whereIn('kind', NEW_KINDS).first('id')) {
    throw new Error('payroll_pay_lines holds season bonus, stay bonus or December gift lines. Preserve the schema and roll forward; do not delete it.');
  }
  if (await knex.schema.hasColumn('payroll_checks', 'tech_rewards_cents')
    && await knex('payroll_checks').whereNotNull('tech_rewards_cents').first('id')) {
    throw new Error('payroll_checks holds tech rewards figures. Preserve the schema and roll forward; do not delete it.');
  }
  await knex.raw('ALTER TABLE payroll_checks DROP CONSTRAINT IF EXISTS payroll_checks_tech_rewards_check');
  await knex.raw('ALTER TABLE payroll_checks DROP COLUMN IF EXISTS tech_rewards_cents');
  await knex.raw('ALTER TABLE payroll_pay_lines DROP CONSTRAINT IF EXISTS payroll_pay_lines_kind_check');
  await knex.raw(`ALTER TABLE payroll_pay_lines
    ADD CONSTRAINT payroll_pay_lines_kind_check CHECK (kind IN (${list(OLD_KINDS)}))`);
};
