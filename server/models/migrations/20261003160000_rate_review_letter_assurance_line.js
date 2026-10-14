'use strict';

/**
 * Annual rate review letter — the "before the new-rate date" assurance names only the
 * billing arrangements the customer has (follow-up to 20261003120000, which is pushed and
 * frozen).
 *
 * 20261003120000 installed one sentence covering applications, monthly dues and a prepaid
 * plan, so a per-application-only customer read about dues and a prepaid plan they do not
 * have. The sentence becomes {{assurance_line}}, which the sender builds from the units
 * actually in the letter (rate-review-comms.js letterPayload), and assurance_line joins the
 * template's allowed and required variables.
 *
 * Applied only while the ACTIVE version still carries the 20261003120000 sentence exactly
 * (an operator who edited the paragraph keeps their words: no match, no write, and the
 * variable lists are left alone). down() restores the sentence and the lists by the same
 * match.
 */
const KEY = 'billing.rate_review_notice';
const VAR = 'assurance_line';
const OLD_SENTENCE = 'Until the new-rate date shown above nothing changes: applications completed before it are billed at your current rate, monthly dues stay at your current amount through the month before it, and a prepaid plan stays exactly as it is until it renews.';
const NEW_SENTENCE = `{{${VAR}}}`;

const asList = (v) => {
  if (Array.isArray(v)) return v;
  try { const p = JSON.parse(v || '[]'); return Array.isArray(p) ? p : []; } catch { return []; }
};
// jsonb columns are always written as JSON text: the pg driver would send a raw JS array as a
// Postgres array literal ({"a","b"}), which is not JSON. (Reading accepts either shape.)
const toJson = (value) => JSON.stringify(value);
const uniq = (a) => [...new Set(a)];

// Pure: swap the sentence inside whichever block carries it. Returns { blocks, changed }.
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

// Pure: the variable lists after this migration (up) or before it (down).
function shiftVariables({ allowed, required, optional }, up) {
  if (up) return { allowed: uniq([...allowed, VAR]), required: uniq([...required, VAR]), optional: optional.filter((v) => v !== VAR) };
  return { allowed: allowed.filter((v) => v !== VAR), required: required.filter((v) => v !== VAR), optional: optional.filter((v) => v !== VAR) };
}

async function rewrite(knex, up) {
  if (!(await knex.schema.hasTable('email_templates'))) return;
  const template = await knex('email_templates').where({ template_key: KEY }).first();
  if (!template || !template.active_version_id) return;
  const version = await knex('email_template_versions').where({ id: template.active_version_id }).first();
  if (!version) return;
  const raw = typeof version.blocks === 'string' ? JSON.parse(version.blocks) : version.blocks;
  const { blocks, changed } = up ? swapSentence(raw, OLD_SENTENCE, NEW_SENTENCE) : swapSentence(raw, NEW_SENTENCE, OLD_SENTENCE);
  if (!changed) return; // operator-edited, or already in the target shape
  await knex('email_template_versions').where({ id: version.id }).update({ blocks: toJson(blocks), updated_at: new Date() });
  const next = shiftVariables({ allowed: asList(template.allowed_variables), required: asList(template.required_variables), optional: asList(template.optional_variables) }, up);
  await knex('email_templates').where({ id: template.id }).update({
    allowed_variables: toJson(next.allowed),
    required_variables: toJson(next.required),
    optional_variables: toJson(next.optional),
    updated_at: new Date(),
  });
}

exports.up = (knex) => rewrite(knex, true);
exports.down = (knex) => rewrite(knex, false);

exports._private = { KEY, VAR, OLD_SENTENCE, NEW_SENTENCE, swapSentence, shiftVariables };
