/**
 * Secure-card SMS shortening pass (owner directive 2026-08-12).
 *
 * The rendered base invite ran 3 GSM-7 segments — mostly the 64-hex bearer
 * link, plus copy — and long messages both cost more and deliver less
 * reliably. This PR shortens both halves:
 *
 *   - CODE (appointment-card-request.js, same PR): new tokens are 22-char
 *     base64url (128-bit) instead of 64-hex, cutting the schemeless link
 *     from ~99 to ~57 GSM chars. Legacy 64-hex links keep resolving.
 *   - COPY (this migration): two trims to the base template —
 *       "your {service_type} visit{date_line}" → "your {service_type}{date_line}"
 *       "only after the service is done"       → "only after service"
 *     Every disclosure survives verbatim: "Nothing is charged today", the
 *     {cancel_fee_line} clause, and "We never take card numbers by phone."
 *
 * Together a typical base render (real first name + long service label +
 * date + fee line) lands at ~295 GSM chars = 2 segments, with headroom.
 * The plan-choice variant body is deliberately UNTOUCHED: its owner-approved
 * copy cannot reach 2 segments even with the short link, so it simply gains
 * ~42 chars of headroom under its existing 3-segment cap (Codex #3077).
 *
 * Deploy skew is harmless in both directions: old code (64-hex token) with
 * the new body still fits the 3-segment cap, and new code (short token)
 * with the old body is 3 segments at worst.
 *
 * ADMIN-EDIT SAFETY (same contract as 20260810000060 / 20260811000010):
 * the swap applies only to a body that exactly matches the audited prod
 * body — a drifted admin body keeps its wording (no mechanical pass this
 * time: nothing about the shorter token requires a template change).
 * Experiment variants render INSTEAD of the base body, so
 * sms_template_variants gets the same exact-match treatment.
 */

// [template_key, audited prod body (set by 20260811000010), new body]
const SWAPS = [
  ['secure_appointment_card',
    'Hi {first_name}! To finish booking your {service_type} visit{date_line}, add a card on file: {secure_link}\n\nNothing is charged today, only after the service is done.\n\n{cancel_fee_line}We never take card numbers by phone.',
    'Hi {first_name}! To finish booking your {service_type}{date_line}, add a card on file: {secure_link}\n\nNothing is charged today, only after service.\n\n{cancel_fee_line}We never take card numbers by phone.'],
];

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;

  for (const [key, expect, set] of SWAPS) {
    const row = await knex('sms_templates').where({ template_key: key }).first('id', 'body');
    if (!row || row.body !== expect) continue;
    // Compare-and-swap on the body we read: an admin save landing between
    // the read and this update wins instead of being overwritten.
    await knex('sms_templates').where({ id: row.id, body: row.body }).update({ body: set, updated_at: new Date() });
  }

  if (await knex.schema.hasTable('sms_template_variants')) {
    for (const [key, expect, set] of SWAPS) {
      const variants = await knex('sms_template_variants')
        .where({ template_key: key })
        .select('id', 'body');
      for (const v of variants) {
        if (v.body !== expect) continue;
        await knex('sms_template_variants').where({ id: v.id, body: expect }).update({ body: set, updated_at: new Date() });
      }
    }
  }
};

exports.down = async function down(knex) {
  // Copy-only migration: restore the audited body where the current body
  // matches what up() set — base rows AND exact-match variants. Note the
  // restored body renders 3 segments again with either token shape; a code
  // rollback (64-hex minting) rides the same revert.
  if (!(await knex.schema.hasTable('sms_templates'))) return;
  for (const [key, expect, set] of SWAPS) {
    const row = await knex('sms_templates').where({ template_key: key }).first('id', 'body');
    if (!row || row.body !== set) continue;
    await knex('sms_templates').where({ id: row.id, body: set }).update({ body: expect, updated_at: new Date() });
  }
  if (await knex.schema.hasTable('sms_template_variants')) {
    for (const [key, expect, set] of SWAPS) {
      const variants = await knex('sms_template_variants')
        .where({ template_key: key })
        .select('id', 'body');
      for (const v of variants) {
        if (v.body !== set) continue;
        await knex('sms_template_variants').where({ id: v.id, body: set }).update({ body: expect, updated_at: new Date() });
      }
    }
  }
};

exports._SWAPS = SWAPS;
