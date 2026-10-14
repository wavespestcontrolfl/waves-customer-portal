'use strict';

/**
 * Annual rate review letter — lane-neutral "before the new-rate date"
 * assurance (follow-up to 20261001200000, which is already pushed and frozen).
 *
 * The seeded letter ended its "What stays the same" paragraph with "Any
 * application completed before the new-rate date shown above is billed at
 * your current rate." The same template goes to per-application, monthly-dues
 * and prepaid customers, and for the last two that sentence describes a
 * billing event they do not have. It is replaced by one sentence that is true
 * for all three lanes, so a mixed letter (several plan lines, different lanes)
 * is accurate too.
 *
 * Only the ACTIVE version's blocks are touched, and only when they still
 * contain the seeded sentence exactly: an operator who has edited the paragraph
 * in the Email Template Library keeps their words (no match, no write).
 * down() restores the seeded sentence by the same exact match.
 */
const KEY = 'billing.rate_review_notice';

const OLD_SENTENCE = 'Any application completed before the new-rate date shown above is billed at your current rate.';
const NEW_SENTENCE = 'Until the new-rate date shown above nothing changes: applications completed before it are billed at your current rate, monthly dues stay at your current amount through the month before it, and a prepaid plan stays exactly as it is until it renews.';

// Pure: swap the sentence inside whichever block carries it. Returns
// { blocks, changed } — never mutates the input.
function swapSentence(blocks, from, to) {
  let changed = false;
  const next = (Array.isArray(blocks) ? blocks : []).map((block) => {
    if (block && typeof block.content === 'string' && block.content.includes(from)) {
      changed = true;
      return { ...block, content: block.content.replace(from, to) };
    }
    return block;
  });
  return { blocks: next, changed };
}

async function rewrite(knex, from, to) {
  if (!(await knex.schema.hasTable('email_templates'))) return;
  const template = await knex('email_templates').where({ template_key: KEY }).first();
  if (!template || !template.active_version_id) return;
  const version = await knex('email_template_versions').where({ id: template.active_version_id }).first();
  if (!version) return;
  const raw = typeof version.blocks === 'string' ? JSON.parse(version.blocks) : version.blocks;
  const { blocks, changed } = swapSentence(raw, from, to);
  if (!changed) return; // operator-edited or already rewritten
  await knex('email_template_versions').where({ id: version.id }).update({ blocks: JSON.stringify(blocks), updated_at: new Date() });
}

exports.up = (knex) => rewrite(knex, OLD_SENTENCE, NEW_SENTENCE);
exports.down = (knex) => rewrite(knex, NEW_SENTENCE, OLD_SENTENCE);

exports._private = { KEY, OLD_SENTENCE, NEW_SENTENCE, swapSentence };
