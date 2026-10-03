'use strict';

/**
 * Annual rate review letter — variable lists that follow the new subject (follow-up to
 * 20261003140000, which is pushed and frozen).
 *
 * 20261003140000 moved the subject to {{subject_line}}. The subject was the template's
 * only reference to effective_date, so effective_date (still supplied by the sender)
 * becomes OPTIONAL and subject_line becomes REQUIRED (the template references it and the
 * sender always supplies it). Left as they were, a required variable no template text
 * references would block publishing any later edit of the template.
 *
 * Applied only while the active subject is still exactly {{subject_line}} (an operator who
 * rewrote the subject keeps their own variable choices) and the lists are still the
 * 20261003140000 shape. down() restores that shape by the same match.
 */
const KEY = 'billing.rate_review_notice';
const VAR = 'subject_line';
const DATE_VAR = 'effective_date';
const SUBJECT = '{{subject_line}}';

const asList = (v) => {
  if (Array.isArray(v)) return v;
  try { const p = JSON.parse(v || '[]'); return Array.isArray(p) ? p : []; } catch { return []; }
};
// jsonb columns are always written as JSON text: the pg driver would send a raw JS array as a
// Postgres array literal ({"a","b"}), which is not JSON. (Reading accepts either shape.)
const toJson = (list) => JSON.stringify(list);
const uniq = (a) => [...new Set(a)];

// Pure: the lists after this migration (up) or before it (down).
function shiftVariables({ allowed, required, optional }, up) {
  if (up) {
    return {
      allowed: uniq([...allowed, VAR, DATE_VAR]),
      required: uniq([...required.filter((v) => v !== DATE_VAR), VAR]),
      optional: uniq([...optional.filter((v) => v !== VAR), DATE_VAR]),
    };
  }
  return {
    allowed,
    required: uniq([...required.filter((v) => v !== VAR), DATE_VAR]),
    optional: uniq([...optional.filter((v) => v !== DATE_VAR), VAR]),
  };
}

async function shift(knex, up) {
  if (!(await knex.schema.hasTable('email_templates'))) return;
  const template = await knex('email_templates').where({ template_key: KEY }).first();
  if (!template || !template.active_version_id) return;
  const version = await knex('email_template_versions').where({ id: template.active_version_id }).first();
  if (!version || String(version.subject) !== SUBJECT) return; // operator-edited or 20261003140000 not applied
  const current = { allowed: asList(template.allowed_variables), required: asList(template.required_variables), optional: asList(template.optional_variables) };
  // idempotent: only when the lists are still in the shape this step starts from
  if (up ? !current.required.includes(DATE_VAR) : !current.required.includes(VAR)) return;
  const next = shiftVariables(current, up);
  await knex('email_templates').where({ id: template.id }).update({
    allowed_variables: toJson(next.allowed),
    required_variables: toJson(next.required),
    optional_variables: toJson(next.optional),
    updated_at: new Date(),
  });
}

exports.up = (knex) => shift(knex, true);
exports.down = (knex) => shift(knex, false);

exports._private = { KEY, VAR, DATE_VAR, SUBJECT, shiftVariables };
