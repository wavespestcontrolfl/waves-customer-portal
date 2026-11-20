/**
 * Referral program Step 2, member side (owner 2026-11-20; ships behind GATE_REFERRAL_STEP2, off): a member gets a
 * $25 account credit after the friend's first paid recurring service, or $50 when the friend's home is within half
 * a mile of the member's, and at most 10 member credits a calendar year.
 *
 * Additive and nullable; nothing reads any of it while the gate is off.
 *
 * referral_program_settings (the one row, id 1): the step2_* numbers.
 * referrals:
 *   referrer_credit_cents   the member's credit as posted (0 when the yearly cap stopped it)
 *   referrer_reward_reason  near, standard or cap_reached
 *
 * down drops the columns.
 */
const SETTINGS = 'referral_program_settings';
const REFERRALS = 'referrals';

const SETTING_COLUMNS = [
  ['step2_referrer_reward_cents', (t) => t.integer('step2_referrer_reward_cents').defaultTo(2500)],
  ['step2_near_referrer_reward_cents', (t) => t.integer('step2_near_referrer_reward_cents').defaultTo(5000)],
  ['step2_near_radius_miles', (t) => t.decimal('step2_near_radius_miles', 6, 2).defaultTo(0.5)],
  ['step2_annual_credit_cap', (t) => t.integer('step2_annual_credit_cap').defaultTo(10)],
];

const REFERRAL_COLUMNS = [
  ['referrer_credit_cents', (t) => t.integer('referrer_credit_cents')],
  ['referrer_reward_reason', (t) => t.string('referrer_reward_reason', 30)],
];

async function addMissing(knex, table, columns) {
  for (const [name, add] of columns) {
    if (!(await knex.schema.hasColumn(table, name))) await knex.schema.alterTable(table, add);
  }
}

async function dropPresent(knex, table, columns) {
  for (const [name] of columns) {
    if (await knex.schema.hasColumn(table, name)) await knex.schema.alterTable(table, (t) => t.dropColumn(name));
  }
}

exports.up = async function up(knex) {
  if (await knex.schema.hasTable(SETTINGS)) await addMissing(knex, SETTINGS, SETTING_COLUMNS);
  if (await knex.schema.hasTable(REFERRALS)) await addMissing(knex, REFERRALS, REFERRAL_COLUMNS);
};

exports.down = async function down(knex) {
  if (await knex.schema.hasTable(REFERRALS)) await dropPresent(knex, REFERRALS, REFERRAL_COLUMNS);
  if (await knex.schema.hasTable(SETTINGS)) await dropPresent(knex, SETTINGS, SETTING_COLUMNS);
};

exports._SETTING_COLUMNS = SETTING_COLUMNS.map(([name]) => name);
exports._REFERRAL_COLUMNS = REFERRAL_COLUMNS.map(([name]) => name);
