'use strict';

// Waves Subterranean Termite Protection — Annual Service Agreement (v3),
// third wording revision to the still-DRAFT body: owner ruling 2026-09-30
// (pay after the first visit, throughout — supersedes the 2026-09-25
// charge-at-signing ruling for termite) with the BILLING wording the owner
// approved 2026-10-03 ("clause ok"). The setup fee and the first annual fee
// are charged to the payment method on file after the station installation
// is completed, not at signing.
//
// 20260925030002 is frozen (the preview database has run it). Same style:
// a separate, idempotent migration that rewrites version 1's body only
// while that version is still UNPUBLISHED and byte-identical to 030002's
// output (an operator-edited draft wins), and down() restores 030002's body
// only when the row still carries this revision.
//
// The phrase "Waves charges them to the payment method on file after the
// station installation is completed" is what the charge code reads off the
// SIGNED text (termite-program-agreement.js
// ANNUAL_AFTER_INSTALL_CHARGE_AUTHORIZATION) — keep it verbatim.
const seed = require('./20260924030002_termite_annual_protection_agreement_v3');
const r3 = require('./20260925030002_termite_annual_v3_countersignature_and_billing_clause');

const AFTER_INSTALL_BILLING_INTRO = [
  'BILLING; COVERAGE PERIOD; RENEWAL; NONRENEWAL',
  'The setup fee and the first annual protection fee are billed together.',
  'Waves charges them to the payment method on file after the station',
  'installation is completed, or, if none is on file or the charge does',
  'not go through, sends a payment link. Coverage runs for 12 months from',
  'the program start date.',
].join('\n');

if (!r3.TEMPLATE_V3_ANNUAL_R3_BODY.includes(r3.REVISED_BILLING_INTRO)) {
  throw new Error('20261003130000: r3 body no longer contains the billing intro this revision replaces');
}

const TEMPLATE_V3_ANNUAL_R4_BODY = r3.TEMPLATE_V3_ANNUAL_R3_BODY
  .replace(r3.REVISED_BILLING_INTRO, AFTER_INSTALL_BILLING_INTRO);

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
  if (!version || version.body !== r3.TEMPLATE_V3_ANNUAL_R3_BODY) return; // published, edited, or absent — leave it
  await knex('document_template_versions').where({ id: version.id }).update({ body: TEMPLATE_V3_ANNUAL_R4_BODY });
};

exports.down = async function down(knex) {
  const version = await draftVersion(knex);
  if (!version || version.body !== TEMPLATE_V3_ANNUAL_R4_BODY) return;
  await knex('document_template_versions').where({ id: version.id }).update({ body: r3.TEMPLATE_V3_ANNUAL_R3_BODY });
};

exports.AFTER_INSTALL_BILLING_INTRO = AFTER_INSTALL_BILLING_INTRO;
exports.TEMPLATE_V3_ANNUAL_R4_BODY = TEMPLATE_V3_ANNUAL_R4_BODY;
