// Commercial Pest Service Agreement, version 2: the payment paragraph becomes a merge field (owner 2026-10-24,
// "autopay default"). The issuer (services/commercial-proposal-agreement.js) fills {{agreement.payment_terms}} with the
// Auto Pay paragraph or the Net 30 paragraph from shared/commercial-agreement-terms.cjs, so a Net 30 agreement prints
// exactly what version 1 printed. Version 2 is the ACTIVE body with that one paragraph replaced, so an admin's edits
// elsewhere survive; an active body without version 1's exact paragraph is left alone (the issuer then refuses an Auto
// Pay agreement on it, since it has no slot). Under a template row lock it reuses the version whose body is exactly
// this text, else takes MAX(version_number) + 1. Earlier versions stay (an issued agreement keeps its own snapshot).
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

exports.up = async function up(knex) {
  const template = await lockedTemplate(knex);
  if (!template?.active_version_id) return;
  const active = await knex('document_template_versions').where({ id: template.active_version_id }).first();
  if (!active || String(active.body || '').includes(V2_PAYMENT)) return;
  if (String(active.body || '').split(V1_PAYMENT).length !== 2) return;
  const body = active.body.replace(V1_PAYMENT, V2_PAYMENT);
  let version = await knex('document_template_versions').where({ template_id: template.id, body }).first();
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
};

exports.down = async function down(knex) {
  const template = await lockedTemplate(knex);
  if (!template?.active_version_id) return;
  const mine = await knex('document_template_versions').where({ id: template.active_version_id }).first();
  // Only while this version is still active: a version published after it stays.
  if (!mine || String(mine.body || '').split(V2_PAYMENT).length !== 2) return;
  const previous = await knex('document_template_versions')
    .where({ template_id: template.id, body: mine.body.replace(V2_PAYMENT, V1_PAYMENT) })
    .first();
  if (!previous) return;
  await knex('document_templates').where({ id: template.id, active_version_id: mine.id }).update({
    active_version_id: previous.id,
    updated_at: knex.fn.now(),
  });
  const issued = await knex('customer_contracts').where({ document_template_version_id: mine.id }).first();
  if (!issued) await knex('document_template_versions').where({ id: mine.id }).del();
};

exports.V1_PAYMENT = V1_PAYMENT;
exports.V2_PAYMENT = V2_PAYMENT;
