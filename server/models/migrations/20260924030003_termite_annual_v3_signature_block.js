'use strict';

// Waves Subterranean Termite Protection — Annual Service Agreement (v3):
// revise the DRAFT body's signature block so the document promises only what
// the e-sign flow captures. 20260924030002 seeded a block with blank
// "Customer / Waves certified operator in charge / License / Date" ink lines;
// the platform's e-sign flow (contracts-public.js) records the CUSTOMER's
// electronic signature only — exactly as the live v2 quarterly agreements
// do — so a signed v3 would have circulated with an unfilled operator
// signature line (Codex #4811 r4). This mirrors v2: one electronic
// signature clause, Waves named as the issuing licensee.
//
// Whether to add a real operator countersignature step is an OWNER decision
// (A-14, plan doc §6) for the A-11 wording review; if the owner wants it,
// that is a new mechanism slice plus another body revision, not this file.
//
// 20260924030002 is frozen (the preview database has run it), so this is a
// separate, idempotent migration: it rewrites version 1's body only while
// that version is still UNPUBLISHED and byte-identical to the seed (an
// operator-edited draft wins), and down() restores the seed body only when
// the row still carries this revision.
const seed = require('./20260924030002_termite_annual_protection_agreement_v3');

const ORIGINAL_SIGNATURE_BLOCK = [
  'SIGNATURES (Rule 5E-14.105(2), F.A.C.)',
  'Customer: ______________________  Date: ________',
  'Waves Pest Control, LLC — certified operator in charge:',
  '______________________  License: ________  Date: ________',
].join('\n');

const REVISED_SIGNATURE_BLOCK = [
  'SIGNATURE (Rule 5E-14.105(2), F.A.C.)',
  'Issued by Waves Pest Control, LLC (FL business license JB351547) through',
  'its certified operator in charge. Customer: {{customer.name}}.',
].join('\n');

if (!seed.TEMPLATE_V3_ANNUAL.body.includes(ORIGINAL_SIGNATURE_BLOCK)) {
  throw new Error('20260924030003: seed body no longer contains the signature block this revision replaces');
}
const TEMPLATE_V3_ANNUAL_R2_BODY = seed.TEMPLATE_V3_ANNUAL.body.replace(ORIGINAL_SIGNATURE_BLOCK, REVISED_SIGNATURE_BLOCK);

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
  if (!version || version.body !== seed.TEMPLATE_V3_ANNUAL.body) return; // published, edited, or absent — leave it
  await knex('document_template_versions').where({ id: version.id }).update({ body: TEMPLATE_V3_ANNUAL_R2_BODY });
};

exports.down = async function down(knex) {
  const version = await draftVersion(knex);
  if (!version || version.body !== TEMPLATE_V3_ANNUAL_R2_BODY) return;
  await knex('document_template_versions').where({ id: version.id }).update({ body: seed.TEMPLATE_V3_ANNUAL.body });
};

exports.ORIGINAL_SIGNATURE_BLOCK = ORIGINAL_SIGNATURE_BLOCK;
exports.REVISED_SIGNATURE_BLOCK = REVISED_SIGNATURE_BLOCK;
exports.TEMPLATE_V3_ANNUAL_R2_BODY = TEMPLATE_V3_ANNUAL_R2_BODY;
