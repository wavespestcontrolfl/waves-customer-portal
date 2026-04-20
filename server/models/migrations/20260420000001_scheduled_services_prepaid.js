/**
 * scheduled_services prepaid columns — admin/tech can mark a visit as
 * paid-in-advance (cash at the door, phone CC, Zelle, etc.) so the
 * completion handler skips the auto-invoice and doesn't double-bill.
 *
 * prepaid_amount: null when not prepaid, 0+ when it has been taken.
 * prepaid_method: free text — 'cash' | 'zelle' | 'check' | 'card_over_phone' | etc.
 * prepaid_note:   free text (check #, who took it, etc.)
 * prepaid_at:     when the admin/tech recorded the prepayment.
 *
 * All nullable so existing rows remain valid.
 */

exports.up = async function (knex) {
  const hasAmount = await knex.schema.hasColumn('scheduled_services', 'prepaid_amount');
  if (hasAmount) return;

  await knex.schema.alterTable('scheduled_services', (t) => {
    t.decimal('prepaid_amount', 10, 2);
    t.string('prepaid_method', 40);
    t.text('prepaid_note');
    t.timestamp('prepaid_at');
  });
};

exports.down = async function (knex) {
  const hasAmount = await knex.schema.hasColumn('scheduled_services', 'prepaid_amount');
  if (!hasAmount) return;

  await knex.schema.alterTable('scheduled_services', (t) => {
    t.dropColumn('prepaid_amount');
    t.dropColumn('prepaid_method');
    t.dropColumn('prepaid_note');
    t.dropColumn('prepaid_at');
  });
};
