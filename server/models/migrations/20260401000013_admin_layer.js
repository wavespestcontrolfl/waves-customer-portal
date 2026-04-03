/**
 * Admin layer — role-based auth, admin notes, estimates table
 */
const bcrypt = require('bcryptjs');

exports.up = async function (knex) {
  // Enhance technicians table for auth
  await knex.schema.alterTable('technicians', (t) => {
    t.string('password_hash', 255);
    t.enu('role', ['technician', 'admin']).defaultTo('technician');
    t.timestamp('last_login_at');
    t.string('avatar_url', 500);
  });

  // Admin sessions
  await knex.schema.createTable('admin_sessions', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.uuid('technician_id').notNullable().references('id').inTable('technicians').onDelete('CASCADE');
    t.string('token', 500).notNullable().unique();
    t.string('refresh_token', 500).unique();
    t.timestamp('expires_at').notNullable();
    t.timestamps(true, true);
  });

  // Admin notes on customers
  await knex.schema.createTable('admin_notes', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.uuid('customer_id').notNullable().references('id').inTable('customers').onDelete('CASCADE');
    t.uuid('technician_id').references('id').inTable('technicians');
    t.text('note_text').notNullable();
    t.timestamps(true, true);
    t.index('customer_id');
  });

  // Estimates
  await knex.schema.createTable('estimates', (t) => {
    t.uuid('id').primary().defaultTo(knex.fn.uuid());
    t.uuid('customer_id').references('id').inTable('customers');
    t.uuid('created_by_technician_id').references('id').inTable('technicians');
    t.enu('status', ['draft', 'sent', 'viewed', 'accepted', 'declined', 'expired']).defaultTo('draft');
    t.jsonb('estimate_data');
    t.string('address', 300);
    t.string('customer_name', 100);
    t.string('customer_phone', 20);
    t.string('customer_email', 150);
    t.decimal('monthly_total', 10, 2);
    t.decimal('annual_total', 10, 2);
    t.decimal('onetime_total', 10, 2);
    t.string('waveguard_tier', 20);
    t.string('token', 64).unique();
    t.timestamp('sent_at');
    t.timestamp('viewed_at');
    t.timestamp('accepted_at');
    t.timestamp('declined_at');
    t.timestamp('expires_at');
    t.text('notes');
    t.string('satellite_url', 500);
    t.timestamps(true, true);

    t.index('status');
    t.index('customer_id');
  });

  // Seed admin accounts
  const hash = await bcrypt.hash('waves2026', 10);

  // Get existing tech IDs
  const techs = await knex('technicians').select('id', 'name', 'email');
  const waves = techs.find(t => t.name === 'Waves');
  const adam = techs.find(t => t.name === 'Adam B.');
  const carlos = techs.find(t => t.name === 'Carlos R.');

  if (waves) await knex('technicians').where({ id: waves.id }).update({ password_hash: hash, role: 'admin', email: 'admin@wavespestcontrol.com' });
  if (adam) await knex('technicians').where({ id: adam.id }).update({ password_hash: hash, role: 'admin', email: 'contact@wavespestcontrol.com' });
  if (carlos) await knex('technicians').where({ id: carlos.id }).update({ password_hash: hash, role: 'technician' });
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('estimates');
  await knex.schema.dropTableIfExists('admin_notes');
  await knex.schema.dropTableIfExists('admin_sessions');
  await knex.schema.alterTable('technicians', (t) => {
    t.dropColumn('password_hash');
    t.dropColumn('role');
    t.dropColumn('last_login_at');
    t.dropColumn('avatar_url');
  });
};
