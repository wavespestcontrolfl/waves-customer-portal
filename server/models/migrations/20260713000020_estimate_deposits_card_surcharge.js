// Deposit surcharge revert (owner ruling 2026-07-13): estimate deposits go
// back through the card surcharge path (credit-funding-only, quoted at
// confirm — same machinery as invoice payments). `amount` stays the FACE
// value of the deposit (the invoice-credit authority) exactly as before;
// this column records the surcharge collected ON TOP of it, mirrored from
// the PaymentIntent's card_surcharge metadata at received-time, so revenue
// and reconciliation reports see the fee (deposits have no payments row).
// 0 for wallet payments (Phase-1: Express Checkout is surcharge-free),
// debit/prepaid/unknown funding, and every pre-revert deposit.
exports.up = async function up(knex) {
  const exists = await knex.schema.hasTable('estimate_deposits');
  if (!exists) return;
  const hasCol = await knex.schema.hasColumn('estimate_deposits', 'card_surcharge');
  if (hasCol) return;
  await knex.schema.alterTable('estimate_deposits', (t) => {
    t.decimal('card_surcharge', 10, 2).notNullable().defaultTo(0);
  });
};

exports.down = async function down(knex) {
  const exists = await knex.schema.hasTable('estimate_deposits');
  if (!exists) return;
  const hasCol = await knex.schema.hasColumn('estimate_deposits', 'card_surcharge');
  if (!hasCol) return;
  await knex.schema.alterTable('estimate_deposits', (t) => {
    t.dropColumn('card_surcharge');
  });
};
