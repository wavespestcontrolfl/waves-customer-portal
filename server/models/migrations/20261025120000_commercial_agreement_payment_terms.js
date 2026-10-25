// Commercial Pest Service Agreement, version 2: the payment paragraph becomes a merge field (owner 2026-10-24,
// "autopay default"). The issuer (services/commercial-proposal-agreement.js) fills {{agreement.payment_terms}} with the
// Auto Pay paragraph or the Net 30 paragraph from shared/commercial-agreement-terms.cjs, so a Net 30 agreement prints
// exactly what version 1 printed. Version 2 is the ACTIVE body with that one paragraph replaced, so an admin's edits
// elsewhere survive; an active body without version 1's exact paragraph is left alone (the issuer then refuses an Auto
// Pay agreement on it, since it has no slot). Under a template row lock it reuses the version whose body is exactly
// this text, else takes MAX(version_number) + 1. Earlier versions stay (an issued agreement keeps its own snapshot).
// The publish writes one audit_log row. `down` is a documented no-op: a revert would erase admin edits made after this
// published, and version 2 needs none (a Net 30 agreement prints as version 1 did; Auto Pay issues only while
// GATE_COMMERCIAL_AUTOPAY is on, so that gate is the rollback). Staff can re-activate version 1 in the document library.
const MIGRATION = '20261025120000';
const TEMPLATE_KEY = 'service_agreement.commercial_pest';
const SLOT = 'agreement.payment_terms';
const V1_PAYMENT = 'Billing and payment: Services are invoiced on Net 30 terms — payment is due within thirty (30) days of the invoice date. Past-due balances may be subject to a late fee and/or suspension of service until the account is brought current. Pricing may be adjusted at renewal or with at least thirty (30) days’ written notice.';
const V2_PAYMENT = `Billing and payment: {{${SLOT}}} Pricing may be adjusted at renewal or with at least thirty (30) days’ written notice.`;

const parseList = (value) => {
  if (Array.isArray(value)) return value;
  try { return JSON.parse(value || '[]') || []; } catch { return []; }
};

async function lockedTemplate(knex) {
  return knex('document_templates').where({ template_key: TEMPLATE_KEY }).forUpdate().first();
}

const skip = (reason) => console.log(`[migration:${MIGRATION}] ${TEMPLATE_KEY} left as is: ${reason}`);

exports.up = async function up(knex) {
  const template = await lockedTemplate(knex);
  if (!template?.active_version_id) return skip('no active version');
  const active = await knex('document_template_versions').where({ id: template.active_version_id }).first();
  if (!active) return skip('active version missing');
  if (String(active.body || '').includes(V2_PAYMENT)) return skip('already carries the payment slot');
  if (String(active.body || '').split(V1_PAYMENT).length !== 2) return skip('active body has no exact version 1 payment paragraph (edited)');
  const body = active.body.replace(V1_PAYMENT, V2_PAYMENT);
  let version = await knex('document_template_versions').where({ template_id: template.id, body }).first();
  const created = !version;
  if (!version) {
    const latest = await knex('document_template_versions').where({ template_id: template.id }).max('version_number as n').first();
    [version] = await knex('document_template_versions').insert({
      template_id: template.id,
      version_number: (Number(latest?.n) || 0) + 1,
      title: active.title,
      body,
      signer_disclosure: active.signer_disclosure,
      variables: JSON.stringify([...new Set([...parseList(active.variables), SLOT])]),
      required_fields: JSON.stringify(parseList(active.required_fields)),
      published_at: knex.fn.now(),
    }).returning('*');
  }
  await knex('document_templates').where({ id: template.id }).update({
    active_version_id: version.id,
    updated_at: knex.fn.now(),
  });
  if (await knex.schema.hasTable('audit_log')) {
    const { recordAuditEvent } = require('../../services/audit-log');
    await recordAuditEvent({
      actor_type: 'system',
      action: `migration:${MIGRATION}:publish`,
      resource_type: 'document_template',
      resource_id: template.id,
      metadata: {
        templateKey: TEMPLATE_KEY,
        fromVersionId: active.id,
        toVersionId: version.id,
        versionNumber: version.version_number,
        created,
      },
      critical: true,
      trx: knex,
    });
  }
};

exports.down = async function down() {
  // Documented no-op (see the header): a revert would erase admin edits made after this published.
};

exports.V1_PAYMENT = V1_PAYMENT;
exports.V2_PAYMENT = V2_PAYMENT;
