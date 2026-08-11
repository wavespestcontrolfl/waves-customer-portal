/**
 * Secure-card SMS spacing pass (owner directive 2026-08-11).
 *
 * The plan-choice invite rendered as one dense block: the colon jammed
 * against the date ("...on Wed, Aug 12: prepay..."), the bearer link glued
 * to the end of the sentence, and the fee/security lines with no breathing
 * room. Owner-approved restructure:
 *
 *   - Paragraph breaks between the three ideas (choice / link / fine print).
 *   - "…{date_line}, choose how to pay:" replaces the date-colon jam.
 *   - Fee + card-security disclosures share ONE line ("$75 fee only for
 *     last-minute cancels or no-shows. We never take card numbers by
 *     phone.") — owner ruled the two-line tail read as clutter.
 *
 * SHIPS WITH the cancelFeeLine() change in appointment-card-request.js in
 * the same PR: the token drops its leading "\n" and gains a trailing space
 * ("$75 fee only for last-minute cancels or no-shows. "), so the templates
 * here place {cancel_fee_line} directly before "We never…" and a fee-off
 * render still starts that line cleanly. Deploy skew is one-directional and
 * brief: migrations run pre-deploy, so old code may render the new body for
 * seconds (an extra blank line + "no-shows.We" jam at worst); a failed
 * migration blocks the deploy, so new code never renders the old body.
 *
 * Segment cost at typical render lengths is unchanged (3 GSM-7 segments
 * with a real service label + 64-hex bearer link; the blank lines add 2
 * chars, the connector 16). Every disclosure is intact: truth-conditioned
 * "unless you prepay", the cancel-fee clause, the card-security line.
 *
 * ADMIN-EDIT SAFETY (same contract as 20260810000060): the wording
 * restructure applies only to a body that exactly matches the audited prod
 * body. A drifted body keeps its admin wording but gets the MECHANICAL
 * token-spacing pass — mandatory, not cosmetic, because the code half of
 * this PR changes the token's shape: a body left with the old
 * "{secure_link}{cancel_fee_line}" adjacency would render the link jammed
 * straight into "$75 fee…". Experiment variants render INSTEAD of the base
 * body, so sms_template_variants gets the same treatment.
 */

// [template_key, audited prod body (set by 20260810000060), new body]
const SWAPS = [
  ['secure_appointment_card_plans',
    "Hi {first_name}! To finish booking your {service_type}{date_line}: prepay the year and save, or pay per application with a card on file. Nothing is charged today unless you prepay: {secure_link}{cancel_fee_line}\nWe never take card numbers by phone.",
    "Hi {first_name}! To finish booking your {service_type}{date_line}, choose how to pay: prepay the year and save, or pay per application with a card on file.\n\nNothing is charged today unless you prepay: {secure_link}\n\n{cancel_fee_line}We never take card numbers by phone."],
  ['secure_appointment_card',
    'Hi {first_name}! To finish booking your {service_type} visit{date_line}, add a card on file: {secure_link}\n\nNothing is charged today, only after the service is done.{cancel_fee_line}\nWe never take card numbers by phone.',
    'Hi {first_name}! To finish booking your {service_type} visit{date_line}, add a card on file: {secure_link}\n\nNothing is charged today, only after the service is done.\n\n{cancel_fee_line}We never take card numbers by phone.'],
];

// Mechanical pass for drifted/variant bodies: reposition {cancel_fee_line}
// for the new trailing-space token — a blank line before it, and the text
// after it (the card-security sentence) pulled onto the token's own line.
// A body without the token is untouched (the token then never renders).
function repositionFeeToken(body) {
  return String(body).replace(/[ \t]*\n{0,2}[ \t]*\{cancel_fee_line\}\n?/g, '\n\n{cancel_fee_line}');
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;

  for (const [key, expect, set] of SWAPS) {
    const row = await knex('sms_templates').where({ template_key: key }).first('id', 'body');
    if (!row || typeof row.body !== 'string') continue;
    const next = row.body === expect ? set : repositionFeeToken(row.body);
    if (next !== row.body) {
      // Compare-and-swap on the body we read: an admin save landing between
      // the read and this update wins instead of being overwritten.
      await knex('sms_templates').where({ id: row.id, body: row.body }).update({ body: next, updated_at: new Date() });
    }
  }

  if (await knex.schema.hasTable('sms_template_variants')) {
    const swapByKey = new Map(SWAPS.map(([key, expect, set]) => [key, { expect, set }]));
    const variants = await knex('sms_template_variants')
      .whereIn('template_key', SWAPS.map(([key]) => key))
      .select('id', 'template_key', 'body');
    for (const v of variants) {
      if (typeof v.body !== 'string') continue;
      const swap = swapByKey.get(v.template_key);
      const next = swap && v.body === swap.expect ? swap.set : repositionFeeToken(v.body);
      if (next !== v.body) {
        await knex('sms_template_variants').where({ id: v.id, body: v.body }).update({ body: next, updated_at: new Date() });
      }
    }
  }
};

exports.down = async function down(knex) {
  // Copy-only migration: restore the audited bodies where the current body
  // matches what up() set — base rows AND exact-match variants (getTemplate
  // prefers an active variant over the base body). Mechanically-repositioned
  // drifted bodies are not restored (no snapshot of their prior state) —
  // same contract as 20260810000060. Note the restored bodies assume the
  // pre-PR cancelFeeLine() token; a code rollback rides the same revert.
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
exports._repositionFeeToken = repositionFeeToken;
