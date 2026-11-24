'use strict';

// Real cancellation terms for the Residential Pest Service Agreement (owner 2026-11-23: "yes the no contract is
// true"). The seeded scaffold (20260601000009) ended its "Cancellation and changes" paragraph with a placeholder
// for staff: "Any required renewal, cancellation, or notice terms should be reviewed before sending this
// agreement." A signed agreement must not carry a note to staff. The replacement states what the website pages
// (cancel-anytime and waves-guarantee in the astro repo) already promise: month-to-month, no long-term contract,
// no cancellation fee, cancel any time online, by phone or by email; a visit already inside its late-cancellation
// window may still carry the scheduled-visit fee; a free re-treat between scheduled visits when a covered pest
// returns. The rate-review line and the recap clips line stay as they are.
//
// Same pattern as 20261101233000_residential_pest_agreement_recap_clips_line:
//   1. Read the CURRENTLY ACTIVE version (read-modify-write, so an admin edit made in the document library
//      since the seed is kept).
//   2. Insert the result as a NEW version row at the next version number (FOR UPDATE on the template row, the
//      lock the admin version editor and the publish endpoint take) and repoint active_version_id to it;
//      published_at = activation time.
//   3. Nothing else. Every send froze its rendered body at issue time (customer_contracts
//      .contract_text_snapshot), so open and signed agreements keep their wording.
//
// Skips (nothing written): no template or no active version; a body that already carries the new terms; a body
// without the placeholder sentence (an admin already rewrote it: no safe splice point, edit it in the document
// library). A version that equals the spliced result in full is reused rather than duplicated.
//
// down(): documented no-op (owner rule 2026-08-09, as in 20261101233000): version rows are history and the
// active pointer is an admin-editable value. Rolling back the WORDING is a document-library action.

const TEMPLATE_KEY = 'service_agreement.residential_pest';
const PLACEHOLDER = 'Any required renewal, cancellation, or notice terms should be reviewed before sending this agreement.';
const CANCELLATION_TERMS = [
  'This agreement is month-to-month. There is no long-term contract and no cancellation fee.',
  'The customer may cancel at any time online, by phone, or by email.',
  'A visit that is already inside its late-cancellation window when the customer cancels may still carry the scheduled-visit fee.',
  'If pests this plan covers return between scheduled visits, Waves will re-treat at no charge.',
].join(' ');

/**
 * Replace the placeholder sentence with the cancellation terms, in place (same paragraph).
 * Returns { body, changed, reason }: changed=false with reason 'already_present' when the body already
 * carries the terms, or 'anchor_missing' when the placeholder sentence is not in the body.
 */
function spliceCancellationTerms(body) {
  const text = String(body || '');
  if (text.includes(CANCELLATION_TERMS)) return { body: text, changed: false, reason: 'already_present' };
  const at = text.indexOf(PLACEHOLDER);
  if (at === -1) return { body: text, changed: false, reason: 'anchor_missing' };
  return {
    body: `${text.slice(0, at)}${CANCELLATION_TERMS}${text.slice(at + PLACEHOLDER.length)}`,
    changed: true,
    reason: null,
  };
}

// jsonb columns come back from pg as parsed values; re-insert them as JSON text (a bare JS array
// would be sent as a Postgres array literal).
function jsonColumn(value, fallback) {
  if (value == null) return JSON.stringify(fallback);
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function parseJsonValue(value) {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
}

function sameJson(a, b) {
  return JSON.stringify(parseJsonValue(a) ?? null) === JSON.stringify(parseJsonValue(b) ?? null);
}

// A version is reused only when it is the spliced ACTIVE version in full: body AND signature metadata.
function isCanonicalSplice(version, active, splicedBody) {
  return version.body === splicedBody
    && version.title === active.title
    && (version.signer_disclosure || null) === (active.signer_disclosure || null)
    && sameJson(version.variables, active.variables)
    && sameJson(version.required_fields, active.required_fields);
}

exports.up = async function up(knex) {
  const hasTemplates = await knex.schema.hasTable('document_templates');
  const hasVersions = await knex.schema.hasTable('document_template_versions');
  if (!hasTemplates || !hasVersions) return;

  const template = await knex('document_templates').where({ template_key: TEMPLATE_KEY }).forUpdate().first();
  if (!template || !template.active_version_id) return;

  const active = await knex('document_template_versions').where({ id: template.active_version_id }).first();
  if (!active) return;

  const spliced = spliceCancellationTerms(active.body);
  if (!spliced.changed) return;

  const versions = await knex('document_template_versions')
    .where({ template_id: template.id })
    .orderBy('version_number', 'asc');
  let next = versions.find((v) => isCanonicalSplice(v, active, spliced.body)) || null;
  if (!next) {
    const nextNumber = Math.max(0, ...versions.map((v) => Number(v.version_number) || 0)) + 1;
    [next] = await knex('document_template_versions').insert({
      template_id: template.id,
      version_number: nextNumber,
      title: active.title,
      body: spliced.body,
      signer_disclosure: active.signer_disclosure,
      variables: jsonColumn(active.variables, []),
      required_fields: jsonColumn(active.required_fields, ['initials', 'signedName']),
      created_by: null,
      published_at: knex.fn.now(),
    }).returning('*');
  } else {
    // Reused matching version: activation is the rollout moment.
    await knex('document_template_versions').where({ id: next.id }).update({ published_at: knex.fn.now() });
  }

  await knex('document_templates').where({ id: template.id }).update({
    active_version_id: next.id,
    updated_at: knex.fn.now(),
  });
};

exports.down = async function down() {
  // Documented no-op: see the header.
};

exports.TEMPLATE_KEY = TEMPLATE_KEY;
exports.PLACEHOLDER = PLACEHOLDER;
exports.CANCELLATION_TERMS = CANCELLATION_TERMS;
exports.spliceCancellationTerms = spliceCancellationTerms;
