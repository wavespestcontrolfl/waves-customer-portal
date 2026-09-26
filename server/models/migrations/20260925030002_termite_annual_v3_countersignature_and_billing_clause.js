'use strict';

// Waves Subterranean Termite Protection — Annual Service Agreement (v3),
// second wording revision to the still-DRAFT body: owner ruling 2026-09-25
// (A-14) adds a certified-operator countersignature as a RECORD step after
// the customer signs (it never gates activation, billing, or scheduling —
// see 20260925030001_termite_annual_countersignature_columns), and clarifies
// how the first-year fee is charged at signing (no such wording existed on
// the BILLING paragraph before this revision).
//
// 20260924030002 (seed) and 20260924030003 (signature-block rewrite) are
// both frozen — the preview database has run them. This is a further,
// separate, idempotent migration in the same style as 030003: it rewrites
// version 1's body only while that version is still UNPUBLISHED and
// byte-identical to 030003's output (an operator-edited draft wins), and
// down() restores 030003's body only when the row still carries this
// revision.
const seed = require('./20260924030002_termite_annual_protection_agreement_v3');
const r2 = require('./20260924030003_termite_annual_v3_signature_block');

// The v3 body ends with the ELECTRONIC SIGNATURE paragraph (030003's
// SIGNATURE block above it is unchanged here). The countersignature clause is appended
// after it as its own block with one blank line before, so the signed PDF
// reads: clause, customer's e-signature stamp, then "Certified Operator:
// <name>, <date>" once countersigned (contract-pdf.js signatureBlock).
const BODY_END_ANCHOR = 'retreatment only and no repair — and intend to sign it electronically.';

const COUNTERSIGNATURE_BLOCK = [
  'CERTIFIED OPERATOR COUNTERSIGNATURE',
  'Waves’ certified operator in charge countersigns this agreement as a',
  'record after the customer signs; the agreement takes effect on the',
  'customer’s electronic signature and countersignature does not delay',
  'coverage, billing, or scheduling.',
].join('\n');

const ORIGINAL_BILLING_INTRO = [
  'BILLING; COVERAGE PERIOD; RENEWAL; NONRENEWAL',
  'The setup fee and the first annual protection fee are billed together',
  'and are due before installation. Coverage runs for 12 months from the',
  'program start date.',
].join('\n');

const REVISED_BILLING_INTRO = [
  'BILLING; COVERAGE PERIOD; RENEWAL; NONRENEWAL',
  'The setup fee and the first annual protection fee are billed together',
  'and are due before installation: Waves charges them to the payment',
  'method on file at signing, or, if none is on file, sends a payment link',
  'to complete before installation. Coverage runs for 12 months from the',
  'program start date.',
].join('\n');

if (!r2.TEMPLATE_V3_ANNUAL_R2_BODY.endsWith(BODY_END_ANCHOR)) {
  throw new Error('20260925030002: r2 body no longer ends with the e-signature paragraph this revision appends after');
}
if (!r2.TEMPLATE_V3_ANNUAL_R2_BODY.includes(ORIGINAL_BILLING_INTRO)) {
  throw new Error('20260925030002: r2 body no longer contains the billing intro this revision replaces');
}

const TEMPLATE_V3_ANNUAL_R3_BODY = `${r2.TEMPLATE_V3_ANNUAL_R2_BODY
  .replace(ORIGINAL_BILLING_INTRO, REVISED_BILLING_INTRO)}\n\n${COUNTERSIGNATURE_BLOCK}`;

async function draftVersion(knex) {
  const hasTemplates = await knex.schema.hasTable('document_templates');
  const hasVersions = await knex.schema.hasTable('document_template_versions');
  if (!hasTemplates || !hasVersions) return null;
  const template = await knex('document_templates').where({ template_key: seed.TEMPLATE_KEY }).first('id');
  if (!template) return null;
  return knex('document_template_versions')
    .where({ template_id: template.id, version_number: 1 })
    .whereNull('published_at')
    .first('id', 'body');
}

exports.up = async function up(knex) {
  const version = await draftVersion(knex);
  if (!version || version.body !== r2.TEMPLATE_V3_ANNUAL_R2_BODY) return; // published, edited, or absent — leave it
  await knex('document_template_versions').where({ id: version.id }).update({ body: TEMPLATE_V3_ANNUAL_R3_BODY });
};

exports.down = async function down(knex) {
  const version = await draftVersion(knex);
  if (!version || version.body !== TEMPLATE_V3_ANNUAL_R3_BODY) return;
  await knex('document_template_versions').where({ id: version.id }).update({ body: r2.TEMPLATE_V3_ANNUAL_R2_BODY });
};

exports.COUNTERSIGNATURE_BLOCK = COUNTERSIGNATURE_BLOCK;
exports.ORIGINAL_BILLING_INTRO = ORIGINAL_BILLING_INTRO;
exports.REVISED_BILLING_INTRO = REVISED_BILLING_INTRO;
exports.TEMPLATE_V3_ANNUAL_R3_BODY = TEMPLATE_V3_ANNUAL_R3_BODY;
