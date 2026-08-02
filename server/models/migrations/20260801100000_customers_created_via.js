// Provenance stamp for machine-minted customer rows.
//
// The Twilio webhook's domain/van tracking branch inserts a placeholder
// customers row the moment an unknown number texts or calls a tracking
// number (routes/twilio-webhook.js). Downstream logic — the estimator's SMS
// context build — has to tell that placeholder apart from a GENUINE fresh
// lead so an on-file service contact's request is not red-laned as an
// ambiguous shared phone. Inferring it from row shape (blank street, blank
// ZIP, new_lead stage, recent) is not sound: other lead-creation paths
// produce the same shape — routes/lead-webhook.js writes an active
// new_lead with a blank address_line1 and zip when a form is submitted
// without an address — and misreading a real lead as a placeholder attaches
// the wrong customer id, parcel, and membership pricing to a quote.
//
// Nullable and forward-only ON PURPOSE: every consumer also requires the row
// to be minutes old, so no backfill is needed — rows created before this
// ships are already outside the recency window and simply stay ambiguous
// (the conservative outcome).
exports.up = async (knex) => {
  if (!(await knex.schema.hasTable('customers'))) return;
  if (await knex.schema.hasColumn('customers', 'created_via')) return;
  await knex.schema.alterTable('customers', (table) => {
    table.string('created_via', 40).nullable();
  });
};

exports.down = async (knex) => {
  if (!(await knex.schema.hasTable('customers'))) return;
  if (!(await knex.schema.hasColumn('customers', 'created_via'))) return;
  await knex.schema.alterTable('customers', (table) => {
    table.dropColumn('created_via');
  });
};
