'use strict';

// Annual rate-review disclosure for the RESIDENTIAL signable agreements in
// the document template library (tables from 20260601000009): the Lawn &
// Ornamental Service Agreement (20260623000006, active) and the Residential
// Pest Service Agreement scaffold (20260601000009). Both carry their own
// terms block, so the sentence the estimate acceptance drawer now shows
// (server/services/acceptance-terms-text.js, PR #5434) has to be in the
// signed document too — a customer who signs the agreement must see the
// same disclosure they accepted the estimate under.
//
// The sentence is spliced into the pricing sentence of each template's
// scope paragraph — the one place the body already says pricing is
// confirmed before service begins. The wording is byte-identical to the
// acceptance drawer's: if that line changes, this sentence changes with it
// (as a NEW migration — this file is frozen once it has run anywhere).
//
// What this migration does, per template:
//   1. Reads the CURRENTLY ACTIVE version (read-modify-write, so an admin
//      edit made in the document library since the seed is preserved —
//      the sentence is added to the live body, not to the seed text).
//   2. Inserts the result as a NEW version row at the next version number
//      (FOR UPDATE on the template row, same lock the admin version editor
//      and the publish endpoint take before allocating MAX+1) and repoints
//      active_version_id to it. published_at = activation time (the
//      rollout moment, as the publish endpoint records it).
//   3. Nothing else. Every send is a customer_contracts row that froze the
//      rendered body in contract_text_snapshot at issue time and stamped
//      the version it rendered (document_template_version_id); the public
//      signing route reads that snapshot, never the live template. Open
//      (unsigned) sends therefore keep their original wording and version
//      — unlike 20260730000001_termite_program_agreements_v2, this
//      migration does NOT cancel, re-prep, resend, or raise a bell for
//      them. New sends (admin issue + bulk send) resolve active_version_id
//      at issue time and so pick up the new version.
//
// Skips (left to the operator, nothing written): template never seeded
// here; template with no active version; active body that already carries
// the sentence (idempotent re-run, or an admin added it by hand); active
// body whose pricing sentence was edited away (no safe splice point — add
// the sentence from the document library). A version whose body already
// equals the spliced text is reused rather than duplicated.
//
// Termite and commercial templates are deliberately NOT touched: termite
// renewal fees are fixed in the contract (Rule 5E-14.105, F.A.C.) and the
// commercial agreement already carries its own pricing-adjustment clause.
//
// down(): documented no-op (owner rule 2026-08-09: a seed migration of an
// admin-editable value never deletes or repoints on rollback — the
// superseded wording must not become the active one again by accident, and
// the version rows are the document history). Rolling back the WORDING is a
// document-library action: publish the earlier version from the admin UI.

const RATE_REVIEW_SENTENCE = 'Rates are reviewed once a year after your first 12 months, with at least 30 days’ written notice before any change.';

// Each anchor is the pricing sentence of the template's scope paragraph as
// seeded; the disclosure is appended right after it, in the same paragraph.
const TARGETS = [
  {
    template_key: 'service_agreement.lawn_ornamental',
    anchor: 'Service frequency, treated areas, and pricing are confirmed before service begins.',
  },
  {
    template_key: 'service_agreement.residential_pest',
    anchor: 'Service frequency, target pests, access notes, and pricing should be confirmed before work begins.',
  },
];

/**
 * Splice the disclosure after the first occurrence of `anchor` in `body`.
 * Returns { body, changed, reason }: changed=false with reason
 * 'already_present' when the body already carries the sentence, or
 * 'anchor_missing' when there is no safe splice point.
 */
function spliceRateReviewSentence(body, anchor) {
  const text = String(body || '');
  if (text.includes(RATE_REVIEW_SENTENCE)) return { body: text, changed: false, reason: 'already_present' };
  const at = text.indexOf(anchor);
  if (at === -1) return { body: text, changed: false, reason: 'anchor_missing' };
  const insertAt = at + anchor.length;
  return {
    body: `${text.slice(0, insertAt)} ${RATE_REVIEW_SENTENCE}${text.slice(insertAt)}`,
    changed: true,
    reason: null,
  };
}

// jsonb columns come back from pg as parsed values; re-insert them as JSON
// text (a bare JS array would be sent as a Postgres array literal).
function jsonColumn(value, fallback) {
  if (value == null) return JSON.stringify(fallback);
  return typeof value === 'string' ? value : JSON.stringify(value);
}

exports.up = async function up(knex) {
  const hasTemplates = await knex.schema.hasTable('document_templates');
  const hasVersions = await knex.schema.hasTable('document_template_versions');
  if (!hasTemplates || !hasVersions) return;

  for (const target of TARGETS) {
    const template = await knex('document_templates')
      .where({ template_key: target.template_key })
      .forUpdate()
      .first();
    if (!template || !template.active_version_id) continue;

    const active = await knex('document_template_versions')
      .where({ id: template.active_version_id })
      .first();
    if (!active) continue;

    const spliced = spliceRateReviewSentence(active.body, target.anchor);
    if (!spliced.changed) continue;

    const versions = await knex('document_template_versions')
      .where({ template_id: template.id })
      .orderBy('version_number', 'asc');
    let next = versions.find((v) => v.body === spliced.body) || null;
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
  }
};

exports.down = async function down() {
  // Documented no-op — see the header. Version rows are history; the
  // active pointer is an admin-editable value and is not moved on rollback.
};

exports.RATE_REVIEW_SENTENCE = RATE_REVIEW_SENTENCE;
exports.TARGETS = TARGETS;
exports.spliceRateReviewSentence = spliceRateReviewSentence;
