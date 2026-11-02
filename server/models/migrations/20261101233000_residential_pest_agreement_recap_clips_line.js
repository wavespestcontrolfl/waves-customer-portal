'use strict';

// Visit-recap clips line for the Residential Pest Service Agreement (owner 2026-11-01, "approved"): the
// camera-glasses recap pilot (GATE_RECAP_GLASSES_CLIPS) records short video clips of the work, with the
// sound removed, for the customer's visit recap. The approved line becomes its own paragraph right after
// the "Customer responsibilities" paragraph, as a NEW active version of the template. Same pattern as
// 20260930213000_residential_agreements_rate_review_sentence:
//   1. Read the CURRENTLY ACTIVE version (read-modify-write, so an admin edit made in the document
//      library since the seed is kept).
//   2. Insert the result as a NEW version row at the next version number (FOR UPDATE on the template
//      row, the lock the admin version editor and the publish endpoint take) and repoint
//      active_version_id to it; published_at = activation time.
//   3. Nothing else. Every send froze its rendered body at issue time (customer_contracts
//      .contract_text_snapshot), so open and signed agreements keep their wording; new sends resolve
//      active_version_id at issue time and pick up the new version.
//
// Skips (nothing written): no template or no active version; a body that already carries the line;
// no "Customer responsibilities" paragraph in the active body (no safe splice point: add the line from
// the document library). Only the pest agreement: visit recaps are pest visits only.
//
// down(): documented no-op (owner rule 2026-08-09, as in 20260930213000): version rows are history and
// the active pointer is an admin-editable value. Rolling back the WORDING is a document-library action:
// publish the earlier version from the admin UI.

const RECAP_CLIPS_LINE = 'Visit recap: your technician may record short video clips of the work for your visit recap.';
const TEMPLATE_KEY = 'service_agreement.residential_pest';
const ANCHOR_PREFIX = 'Customer responsibilities:';

/**
 * Add the line as its own paragraph after the paragraph that starts with ANCHOR_PREFIX.
 * Returns { body, changed, reason }: changed=false with reason 'already_present' when the body
 * already carries the line, or 'anchor_missing' when no paragraph starts with the anchor.
 */
function spliceRecapClipsLine(body) {
  const text = String(body || '');
  if (text.includes(RECAP_CLIPS_LINE)) return { body: text, changed: false, reason: 'already_present' };
  let start = text.indexOf(ANCHOR_PREFIX);
  while (start > 0 && text[start - 1] !== '\n') start = text.indexOf(ANCHOR_PREFIX, start + 1);
  if (start === -1) return { body: text, changed: false, reason: 'anchor_missing' };
  const lineEnd = text.indexOf('\n', start);
  const insertAt = lineEnd === -1 ? text.length : lineEnd;
  return {
    body: `${text.slice(0, insertAt)}\n\n${RECAP_CLIPS_LINE}${text.slice(insertAt)}`,
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

  const spliced = spliceRecapClipsLine(active.body);
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

exports.RECAP_CLIPS_LINE = RECAP_CLIPS_LINE;
exports.TEMPLATE_KEY = TEMPLATE_KEY;
exports.spliceRecapClipsLine = spliceRecapClipsLine;
