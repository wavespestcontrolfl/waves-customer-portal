/**
 * Referrals — customer referral tracking and credit system
 */
exports.up = async function (knex) {
  // Add referral_code to customers
  await knex.schema.alterTable('customers', (t) => {
    t.string('referral_code', 12).unique();
  });

  // Generate codes for existing customers
  const customers = await knex('customers').select('id');
  for (const c of customers) {
    const code = 'WAVES-' + generateCode(4);
    await knex('customers').where({ id: c.id }).update({ referral_code: code });
  }

  // Create referrals table
  await knex.schema.createTable('referrals', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.uuid('referrer_customer_id').notNullable().references('id').inTable('customers').onDelete('CASCADE');
    t.string('referee_name', 100).notNullable();
    t.string('referee_phone', 20).notNullable();
    t.string('referee_email', 150);
    t.string('referral_code', 12).notNullable();
    t.enu('status', ['pending', 'contacted', 'signed_up', 'credited']).defaultTo('pending');
    t.decimal('credit_amount', 10, 2).defaultTo(25.00);
    t.boolean('referrer_credited').defaultTo(false);
    t.boolean('referee_credited').defaultTo(false);
    t.timestamp('converted_at');
    t.timestamps(true, true);

    t.index('referrer_customer_id');
    t.index('referral_code');
  });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('referrals');
  await knex.schema.alterTable('customers', (t) => {
    t.dropColumn('referral_code');
  });
};

function generateCode(len) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1 for clarity
  let code = '';
  for (let i = 0; i < len; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}
