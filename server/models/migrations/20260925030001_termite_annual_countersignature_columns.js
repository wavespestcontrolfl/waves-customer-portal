/**
 * Termite annual protection agreement — certified-operator countersignature
 * (owner ruling 2026-09-25, A-14): the annual agreement gets a countersignature
 * from the certified operator (Adam) as a RECORD step after the customer
 * signs. It is evidence only — it must never gate activation, charging, or
 * visit creation (those stay on the customer's own e-signature; the separate
 * sign-before-pay activation slice is #4819 and is not touched here).
 *
 * Five additive, nullable columns on customer_contracts, shaped to mirror the
 * existing customer e-sign evidence columns (signed_at / signed_name /
 * signer_ip / signer_user_agent — 20260511000002_contract_signing_workflow):
 *
 *   countersigned_at        — timestamptz, set once, the countersign moment.
 *   countersigned_by        — uuid FK -> technicians.id, ON DELETE SET NULL
 *                              (mirrors customer_contracts.created_by): the
 *                              admin user who countersigned. A deleted staff
 *                              row must never take the countersignature
 *                              evidence down with it.
 *   countersigner_name      — varchar(180), same width as signed_name: the
 *                              certified operator's name as it should read
 *                              on the document ("Certified Operator: <name>,
 *                              <date>").
 *   countersigner_ip        — varchar(45), same width as signer_ip.
 *   countersigner_user_agent — text, same shape as signer_user_agent.
 *
 * Guarded with hasTable/hasColumn throughout so this is safe to run more than
 * once and safe on a database predating customer_contracts.
 */

exports.up = async function up(knex) {
  const hasContracts = await knex.schema.hasTable('customer_contracts');
  if (!hasContracts) return;

  if (!(await knex.schema.hasColumn('customer_contracts', 'countersigned_at'))) {
    await knex.schema.alterTable('customer_contracts', (t) => {
      t.timestamp('countersigned_at', { useTz: true });
    });
  }

  if (!(await knex.schema.hasColumn('customer_contracts', 'countersigned_by'))) {
    await knex.schema.alterTable('customer_contracts', (t) => {
      t.uuid('countersigned_by').nullable().references('id').inTable('technicians').onDelete('SET NULL');
    });
  }

  if (!(await knex.schema.hasColumn('customer_contracts', 'countersigner_name'))) {
    await knex.schema.alterTable('customer_contracts', (t) => {
      t.string('countersigner_name', 180);
    });
  }

  if (!(await knex.schema.hasColumn('customer_contracts', 'countersigner_ip'))) {
    await knex.schema.alterTable('customer_contracts', (t) => {
      t.string('countersigner_ip', 45);
    });
  }

  if (!(await knex.schema.hasColumn('customer_contracts', 'countersigner_user_agent'))) {
    await knex.schema.alterTable('customer_contracts', (t) => {
      t.text('countersigner_user_agent');
    });
  }
};

exports.down = async function down(knex) {
  const hasContracts = await knex.schema.hasTable('customer_contracts');
  if (!hasContracts) return;

  if (await knex.schema.hasColumn('customer_contracts', 'countersigner_user_agent')) {
    await knex.schema.alterTable('customer_contracts', (t) => {
      t.dropColumn('countersigner_user_agent');
    });
  }
  if (await knex.schema.hasColumn('customer_contracts', 'countersigner_ip')) {
    await knex.schema.alterTable('customer_contracts', (t) => {
      t.dropColumn('countersigner_ip');
    });
  }
  if (await knex.schema.hasColumn('customer_contracts', 'countersigner_name')) {
    await knex.schema.alterTable('customer_contracts', (t) => {
      t.dropColumn('countersigner_name');
    });
  }
  if (await knex.schema.hasColumn('customer_contracts', 'countersigned_by')) {
    await knex.schema.alterTable('customer_contracts', (t) => {
      t.dropColumn('countersigned_by');
    });
  }
  if (await knex.schema.hasColumn('customer_contracts', 'countersigned_at')) {
    await knex.schema.alterTable('customer_contracts', (t) => {
      t.dropColumn('countersigned_at');
    });
  }
};
