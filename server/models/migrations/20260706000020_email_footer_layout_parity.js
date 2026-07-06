'use strict';

/**
 * Footer layout parity (owner directive 2026-07-06): the 24h appointment
 * reminder is THE reference for how every customer email should end —
 *
 *   …content → signature → CTA button(s) → questions/small-note LAST
 *
 * (established for the 24h template by 20260705010020's owner-layout pass).
 * Most seeded templates still carry the older arrangement
 * […content → small_note → cta → signature], which reads as "signed off,
 * then a button, then fine print above nothing".
 *
 * This migration restructures the ACTIVE version blocks of every email
 * template EXCEPT appointment.reminder_24h (the untouchable reference):
 *
 *   1. a signature block positioned after the last cta moves to just
 *      before the first cta;
 *   2. a small_note positioned immediately before the first cta moves to
 *      after the last cta (the questions note belongs under the button).
 *
 * Content is never rewritten — blocks only move — so admin-edited copy is
 * preserved. Templates already matching the reference (or with no explicit
 * cta block) are left untouched. Ships as its own migration because the
 * seed files are recorded in knex_migrations in deployed environments and
 * in-place edits there would be silent no-ops.
 */

const REFERENCE_KEY = 'appointment.reminder_24h';

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
  }
  return [];
}

// Returns the reordered blocks, or null when no change is needed.
function reorderToReference(rawBlocks) {
  const blocks = asArray(rawBlocks);
  const firstCta = blocks.findIndex((b) => b && b.type === 'cta');
  if (firstCta === -1) return null; // default-CTA templates keep their layout

  let arr = blocks.slice();
  let changed = false;

  // 1. small_note immediately before the first cta → after the last cta
  //    (must run before the signature move, which would otherwise slot the
  //    signature between the note and the cta and hide the adjacency).
  const ctaIdx = arr.findIndex((b) => b && b.type === 'cta');
  const before = ctaIdx - 1;
  if (before >= 0 && arr[before] && arr[before].type === 'small_note') {
    const [note] = arr.splice(before, 1);
    const lastCta = arr.map((b) => b && b.type).lastIndexOf('cta');
    arr.splice(lastCta + 1, 0, note);
    changed = true;
  }

  // 2. Signature after the last cta → immediately before the first cta.
  const lastCta = arr.map((b) => b && b.type).lastIndexOf('cta');
  const sigIdx = arr.findIndex((b, i) => b && b.type === 'signature' && i > lastCta);
  if (sigIdx !== -1) {
    const [sig] = arr.splice(sigIdx, 1);
    const insertAt = arr.findIndex((b) => b && b.type === 'cta');
    arr.splice(insertAt, 0, sig);
    changed = true;
  }

  return changed ? arr : null;
}

exports.up = async function up(knex) {
  const hasTables = await knex.schema.hasTable('email_templates')
    && await knex.schema.hasTable('email_template_versions');
  if (!hasTables) return;

  const templates = await knex('email_templates')
    .whereNot({ template_key: REFERENCE_KEY })
    .whereNotNull('active_version_id')
    .select('id', 'template_key', 'active_version_id');

  for (const t of templates) {
    const version = await knex('email_template_versions')
      .where({ id: t.active_version_id })
      .first('id', 'blocks');
    if (!version) continue;
    const reordered = reorderToReference(version.blocks);
    if (!reordered) continue;
    await knex('email_template_versions')
      .where({ id: version.id })
      .update({ blocks: JSON.stringify(reordered), updated_at: new Date() });
  }
};

// Structural change with no copy edits; reversing block order buys nothing
// and risks fighting later admin edits — down is a deliberate no-op.
exports.down = async function down() {};

// exported for tests
exports._internals = { reorderToReference };
