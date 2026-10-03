'use strict';

/**
 * Annual rate review letter — a subject that fits a multi-date letter (follow-up to
 * 20261001200000, which is pushed and frozen).
 *
 * The seeded subject, "Your Waves rate from {{effective_date}}", names the EARLIEST
 * line's date; on a combined letter whose lines start on different dates that tells the
 * customer their whole rate starts then. The subject becomes {{subject_line}}, a variable
 * rate-review-comms.js letterPayload() always supplies: the dated wording for a
 * single-date letter, neutral wording ("see the dates in your notice") for a multi-date
 * one. The subject was the template's only reference to effective_date, so the variable
 * lists follow it: subject_line becomes REQUIRED (the template now references it, and the
 * sender always supplies it) and effective_date becomes optional (still supplied; a
 * required variable no template text references would block publishing any later edit).
 *
 * Only the ACTIVE version's subject is touched, and only while it is still exactly the
 * seeded string: an operator who edited the subject in the Email Template Library keeps
 * their words (no match, no write). down() restores the seeded subject and the original
 * variable lists, by the same exact match.
 */
const KEY = 'billing.rate_review_notice';
const VAR = 'subject_line';
const DATE_VAR = 'effective_date';
const OLD_SUBJECT = 'Your Waves rate from {{effective_date}}';
const NEW_SUBJECT = '{{subject_line}}';

const asList = (v) => {
  if (Array.isArray(v)) return v;
  try { const p = JSON.parse(v || '[]'); return Array.isArray(p) ? p : []; } catch { return []; }
};
const sameShape = (original, list) => (Array.isArray(original) ? list : JSON.stringify(list));

// Pure: the three variable lists after the swap (up) or its reversal (down).
function shiftVariables({ allowed, required, optional }, up) {
  const uniq = (a) => [...new Set(a)];
  if (up) {
    return {
      allowed: uniq([...allowed, VAR, DATE_VAR]),
      required: uniq([...required.filter((v) => v !== DATE_VAR), VAR]),
      optional: uniq([...optional.filter((v) => v !== VAR), DATE_VAR]),
    };
  }
  return {
    allowed: allowed.filter((v) => v !== VAR),
    required: uniq([...required.filter((v) => v !== VAR), DATE_VAR]),
    optional: optional.filter((v) => v !== VAR && v !== DATE_VAR),
  };
}

async function swap(knex, from, to, up) {
  if (!(await knex.schema.hasTable('email_templates'))) return;
  const template = await knex('email_templates').where({ template_key: KEY }).first();
  if (!template || !template.active_version_id) return;
  const version = await knex('email_template_versions').where({ id: template.active_version_id }).first();
  if (!version || String(version.subject) !== from) return; // operator-edited or already swapped
  await knex('email_template_versions').where({ id: version.id }).update({ subject: to, updated_at: new Date() });
  const next = shiftVariables({ allowed: asList(template.allowed_variables), required: asList(template.required_variables), optional: asList(template.optional_variables) }, up);
  await knex('email_templates').where({ id: template.id }).update({
    allowed_variables: sameShape(template.allowed_variables, next.allowed),
    required_variables: sameShape(template.required_variables, next.required),
    optional_variables: sameShape(template.optional_variables, next.optional),
    updated_at: new Date(),
  });
}

exports.up = (knex) => swap(knex, OLD_SUBJECT, NEW_SUBJECT, true);
exports.down = (knex) => swap(knex, NEW_SUBJECT, OLD_SUBJECT, false);

exports._private = { KEY, VAR, DATE_VAR, OLD_SUBJECT, NEW_SUBJECT, shiftVariables };
