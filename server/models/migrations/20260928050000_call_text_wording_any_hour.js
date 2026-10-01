/**
 * Copy update for the two automated first-touch texts a missed call or a
 * voicemail sets off, in the same PR that drops their after-hours defer
 * (owner ruling 2026-09-28 — see missed-call-text-back.js,
 * voicemail-lead-sms.js, and messaging/validators/send-window.js's
 * CUSTOMER_ACTION_ENTRY_POINTS). Both now go out at any hour, so both gain a
 * line that reads naturally whether it lands at 2 PM or 2 AM: "Someone from
 * the Waves team will follow up as soon as possible."
 *
 *   - missed_call_text_back (seeded 20260926180000, never touched since):
 *     the reassurance leads, ahead of the existing text-us-or-call-back
 *     offer. {callback_clause} stays required
 *     (REQUIRED_TEMPLATE_PLACEHOLDERS in routes/admin-sms-templates.js) and
 *     keeps the exact "call back anytime{callback_clause}" shape that reads
 *     correctly whether the dialed line was one of ours
 *     (" at (941) 297-5749.") or unknown (".").
 *   - voicemail_quote_link (seeded 20260701000004, then rewritten by
 *     20260730000020's audit pass and again by 20260801000001's house-voice
 *     sweep — the later STOP-line-removal passes explicitly kept it on the
 *     "never touch" keep-list, so 20260801000001's body is still the
 *     current one): the existing message and link are untouched — the
 *     reassurance is inserted right after the quote link and before the
 *     "reply" alternative, ahead of the STOP line.
 *
 * ADMIN-EDIT SAFETY (same CAS contract as 20260811000010 /
 * 20260717090000): the wording swap applies only to a body that still
 * exactly matches its last-seeded body verbatim (confirmed against a fresh
 * `db:migrate` run of every prior migration) — an admin edit made since is
 * left untouched. down() reverses the same way, restoring the prior body
 * only where the current body still matches what up() set.
 */

// [template_key, body as every prior migration leaves it, new body]
const SWAPS = [
  ['missed_call_text_back',
    "Hi there, it's Waves. Sorry we missed your call. Text us here with what you need, or call back anytime{callback_clause}.",
    "Hi there, it's Waves. Sorry we missed your call. Someone from the Waves team will follow up as soon as possible. You can also text us here with what you need, or call back anytime{callback_clause}."],
  ['voicemail_quote_link',
    "Hello {first_name}, it's Waves Pest Control. We got your message about {service_label}, and your quote is here: {quote_url}\n\nOr reply and we'll call you back.\n\nReply STOP to opt out.",
    "Hello {first_name}, it's Waves Pest Control. We got your message about {service_label}, and your quote is here: {quote_url}\n\nSomeone from the Waves team will follow up as soon as possible. Or reply and we'll call you back.\n\nReply STOP to opt out."],
];

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;
  for (const [key, expect, set] of SWAPS) {
    const row = await knex('sms_templates').where({ template_key: key }).first('id', 'body');
    if (!row || row.body !== expect) continue; // missing, or an admin edit already changed it — leave it alone
    // Compare-and-swap on the body we read: an admin save landing between
    // the read and this update wins instead of being overwritten.
    await knex('sms_templates').where({ id: row.id, body: row.body }).update({ body: set, updated_at: new Date() });
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;
  for (const [key, expect, set] of SWAPS) {
    const row = await knex('sms_templates').where({ template_key: key }).first('id', 'body');
    if (!row || row.body !== set) continue;
    await knex('sms_templates').where({ id: row.id, body: row.body }).update({ body: expect, updated_at: new Date() });
  }
};

exports._SWAPS = SWAPS;
