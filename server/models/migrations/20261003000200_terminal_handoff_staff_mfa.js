/**
 * terminal_handoff_tokens.staff_mfa — whether the staff session that minted
 * the Tap to Pay handoff had passed the two-step code (GATE_ADMIN_MFA). The
 * row, not the JWT claim, is the authority at /validate-handoff (the same
 * claim-vs-row check the invoice, amount and technician bindings get), so a
 * re-signed claim cannot add the proof.
 */

exports.up = async function up(knex) {
  if (await knex.schema.hasTable('terminal_handoff_tokens')
    && !(await knex.schema.hasColumn('terminal_handoff_tokens', 'staff_mfa'))) {
    await knex.schema.alterTable('terminal_handoff_tokens', (t) => {
      t.boolean('staff_mfa').notNullable().defaultTo(false);
    });
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasTable('terminal_handoff_tokens')
    && await knex.schema.hasColumn('terminal_handoff_tokens', 'staff_mfa')) {
    await knex.schema.alterTable('terminal_handoff_tokens', (t) => {
      t.dropColumn('staff_mfa');
    });
  }
};
