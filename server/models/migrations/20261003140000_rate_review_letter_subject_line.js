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
 * one. effective_date stays a variable (the letter body and other readers use it).
 *
 * Only the ACTIVE version's subject is touched, and only while it is still exactly the
 * seeded string: an operator who edited the subject in the Email Template Library keeps
 * their words (no match, no write). subject_line is added to the template's allowed and
 * optional variables. down() restores the seeded subject and drops the variable, by the
 * same exact match.
 */
const KEY = 'billing.rate_review_notice';
const VAR = 'subject_line';
const OLD_SUBJECT = 'Your Waves rate from {{effective_date}}';
const NEW_SUBJECT = '{{subject_line}}';

const asList = (v) => {
  if (Array.isArray(v)) return v;
  try { const p = JSON.parse(v || '[]'); return Array.isArray(p) ? p : []; } catch { return []; }
};
// jsonb columns are always written as JSON text: the pg driver would send a raw JS array as a
// Postgres array literal ({"a","b"}), which is not JSON. (Reading accepts either shape.)
const toJson = (list) => JSON.stringify(list);

async function swap(knex, from, to, addVar) {
  if (!(await knex.schema.hasTable('email_templates'))) return;
  const template = await knex('email_templates').where({ template_key: KEY }).first();
  if (!template || !template.active_version_id) return;
  const version = await knex('email_template_versions').where({ id: template.active_version_id }).first();
  if (!version || String(version.subject) !== from) return; // operator-edited or already swapped
  await knex('email_template_versions').where({ id: version.id }).update({ subject: to, updated_at: new Date() });
  const withVar = (list) => (addVar ? [...new Set([...list, VAR])] : list.filter((x) => x !== VAR));
  await knex('email_templates').where({ id: template.id }).update({
    allowed_variables: toJson(withVar(asList(template.allowed_variables))),
    optional_variables: toJson(withVar(asList(template.optional_variables))),
    updated_at: new Date(),
  });
}

exports.up = (knex) => swap(knex, OLD_SUBJECT, NEW_SUBJECT, true);
exports.down = (knex) => swap(knex, NEW_SUBJECT, OLD_SUBJECT, false);

exports._private = { KEY, VAR, OLD_SUBJECT, NEW_SUBJECT };
