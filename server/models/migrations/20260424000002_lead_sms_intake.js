/**
 * SMS lead-intake state machine on customers.
 *
 * When a new lead replies to the auto-reply "What are you interested in —
 * Pest Control, Lawn Care, or a One-Time Service?", the Twilio webhook
 * walks them through a two-step capture (service intent → address) before
 * auto-creating a draft estimate for Virginia/Adam to price.
 *
 *   lead_intake_status:
 *     awaiting_service  — seed state after lead-webhook sends the auto-reply
 *     awaiting_address  — service captured, still need the address
 *     estimate_drafted  — draft estimate created, Adam notified
 *     null              — not in the flow (default for existing customers)
 *
 *   lead_service_interest:
 *     pest | lawn | one_time | null
 */
exports.up = async function (knex) {
  const cols = await knex('customers').columnInfo();
  await knex.schema.alterTable('customers', (t) => {
    if (!cols.lead_service_interest) t.string('lead_service_interest', 32);
    if (!cols.lead_intake_status) t.string('lead_intake_status', 32);
  });
};

exports.down = async function (knex) {
  const cols = await knex('customers').columnInfo();
  await knex.schema.alterTable('customers', (t) => {
    if (cols.lead_service_interest) t.dropColumn('lead_service_interest');
    if (cols.lead_intake_status) t.dropColumn('lead_intake_status');
  });
};
