'use strict';

// Termite bond agreements match how bonds are sold (owner 2026-11-23). The estimator (pricing-engine
// constants TERMITE.bond, GATE_TERMITE_BOND_OPTION) and the website sell a bond in 1-, 5- or 10-year renewable
// terms, billed per quarterly station check, renewable at the end of the term. The two signable bond agreements
// seeded in 20260623000003 said instead "This bond must be renewed each year, at the annual renewal amount
// shown". This migration rewrites that renewal paragraph in both (retreatment-only and repair + retreatment):
// coverage runs for the bond term shown, billed with each quarterly station check; an unpaid quarterly charge
// lapses the bond; at the end of the term the customer may renew.
//
// Merge variables. Nothing in the code fills bond.* (buildCustomerDocumentContext passes the staff-typed values
// through; an unfilled variable blocks the send as "unresolved merge fields"), so the office types them when it
// issues the bond. bond.term, bond.start_date, treatment.type, bond.price and bond.renewal_price stay.
// bond.quarterly_price is NEW: the header line "Annual renewal: {{bond.renewal_price}}" becomes two lines,
// "Quarterly station check charge: {{bond.quarterly_price}}" and "Renewal amount (next term):
// {{bond.renewal_price}}". Rule 5E-14.105(2)(i) wants an exact price and renewal fee in the contract, so the
// renewal amount stays printed. The exclusion list item "failure to maintain the annual renewal" becomes "failure
// to pay the quarterly charges or to renew the bond at the end of its term". The repair coverage limit language
// ("up to the coverage terms confirmed in writing with this bond") is NOT touched: the owner has not decided a cap.
//
// Same pattern as 20261101233000_residential_pest_agreement_recap_clips_line: read the CURRENTLY ACTIVE version
// (an admin edit made since the seed is kept), insert the result as a NEW version at the next number (FOR UPDATE
// on the template row) and repoint active_version_id. Open and signed sends froze their text at issue time and
// keep their wording. Skips a template when it has no active version, already carries the new paragraph, or no
// longer carries the old renewal paragraph word for word (an admin rewrote it: edit it in the document library).
// The template's own variables list gains bond.quarterly_price; its description is rewritten only while it still
// equals the seeded text.
//
// down(): documented no-op (owner rule 2026-08-09): version rows are history, the active pointer is an
// admin-editable value. Roll the WORDING back by publishing the earlier version from the document library.

const NEW_VARIABLE = 'bond.quarterly_price';
const OLD_HEADER = 'Annual renewal: {{bond.renewal_price}}';
const NEW_HEADER = [
  'Quarterly station check charge: {{bond.quarterly_price}}',
  'Renewal amount (next term): {{bond.renewal_price}}',
].join('\n');
const OLD_EXCLUSION_TAIL = 'failure to maintain the annual renewal.';
const NEW_EXCLUSION_TAIL = 'failure to pay the quarterly charges or to renew the bond at the end of its term.';

const renewalParagraph = (coverage) => [
  'Bond term and renewal: Coverage runs for the bond term shown ({{bond.term}}). The bond is billed with each quarterly station check, at the quarterly amount shown.',
  `If a quarterly charge is not paid by its due date, the bond lapses and ${coverage} ends.`,
  'At the end of the term, the customer may renew the bond for a new term at the renewal amount shown.',
  'Reinstatement after a lapse requires a new inspection and may require a new treatment at current pricing.',
].join(' ');

const TARGETS = [
  {
    template_key: 'service_agreement.termite_bond_retreatment',
    oldParagraph: 'Annual renewal: This bond must be renewed each year, at the annual renewal amount shown, to keep retreatment coverage active. If a renewal is not paid by its due date, the bond lapses and retreatment coverage ends. Reinstatement after a lapse requires a new inspection and may require a new treatment at current pricing.',
    newParagraph: renewalParagraph('retreatment coverage'),
    oldDescription: 'Signable termite bond covering retreatment only (no repair of termite damage). Annual renewal required; transferable with re-inspection.',
    newDescription: 'Signable termite bond covering retreatment only (no repair of termite damage). 1-, 5- or 10-year term billed with each quarterly station check, renewable at the end of the term; transferable with re-inspection.',
  },
  {
    template_key: 'service_agreement.termite_bond_repair',
    oldParagraph: 'Annual renewal: This bond must be renewed each year, at the annual renewal amount shown, to keep retreatment and repair coverage active. If a renewal is not paid by its due date, the bond lapses and coverage ends. Reinstatement after a lapse requires a new inspection and may require a new treatment at current pricing.',
    newParagraph: renewalParagraph('coverage'),
    oldDescription: 'Signable termite bond covering retreatment plus repair of new covered termite damage. Annual renewal required; transferable with re-inspection.',
    newDescription: 'Signable termite bond covering retreatment plus repair of new covered termite damage. 1-, 5- or 10-year term billed with each quarterly station check, renewable at the end of the term; transferable with re-inspection.',
  },
];

/**
 * Rewrite the renewal paragraph (required), the header line and the exclusion tail (both optional) of one
 * bond body. Returns { body, changed, reason }: changed=false with reason 'already_present' when the new
 * paragraph is already there, or 'anchor_missing' when the old paragraph is not word for word in the body.
 */
function spliceBondTerms(body, target) {
  const text = String(body || '');
  if (text.includes(target.newParagraph)) return { body: text, changed: false, reason: 'already_present' };
  if (!text.includes(target.oldParagraph)) return { body: text, changed: false, reason: 'anchor_missing' };
  let next = text.replace(target.oldParagraph, () => target.newParagraph);
  next = next.replace(OLD_HEADER, () => NEW_HEADER);
  next = next.replace(OLD_EXCLUSION_TAIL, () => NEW_EXCLUSION_TAIL);
  return { body: next, changed: true, reason: null };
}

function parseJsonValue(value) {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
}

function withNewVariable(variables) {
  const list = Array.isArray(parseJsonValue(variables)) ? [...parseJsonValue(variables)] : [];
  if (!list.includes(NEW_VARIABLE)) list.push(NEW_VARIABLE);
  return list;
}

function sameJson(a, b) {
  return JSON.stringify(parseJsonValue(a) ?? null) === JSON.stringify(parseJsonValue(b) ?? null);
}

// A version is reused only when it is the spliced ACTIVE version in full: body AND signature metadata.
function isCanonicalSplice(version, active, splicedBody, variables) {
  return version.body === splicedBody
    && version.title === active.title
    && (version.signer_disclosure || null) === (active.signer_disclosure || null)
    && sameJson(version.variables, variables)
    && sameJson(version.required_fields, active.required_fields);
}

exports.up = async function up(knex) {
  const hasTemplates = await knex.schema.hasTable('document_templates');
  const hasVersions = await knex.schema.hasTable('document_template_versions');
  if (!hasTemplates || !hasVersions) return;

  for (const target of TARGETS) {
    const template = await knex('document_templates').where({ template_key: target.template_key }).forUpdate().first();
    if (!template || !template.active_version_id) continue;

    const active = await knex('document_template_versions').where({ id: template.active_version_id }).first();
    if (!active) continue;

    const spliced = spliceBondTerms(active.body, target);
    if (!spliced.changed) continue;

    const variables = withNewVariable(active.variables);
    const versions = await knex('document_template_versions')
      .where({ template_id: template.id })
      .orderBy('version_number', 'asc');
    let next = versions.find((v) => isCanonicalSplice(v, active, spliced.body, variables)) || null;
    if (!next) {
      const nextNumber = Math.max(0, ...versions.map((v) => Number(v.version_number) || 0)) + 1;
      [next] = await knex('document_template_versions').insert({
        template_id: template.id,
        version_number: nextNumber,
        title: active.title,
        body: spliced.body,
        signer_disclosure: active.signer_disclosure,
        variables: JSON.stringify(variables),
        required_fields: typeof active.required_fields === 'string'
          ? active.required_fields
          : JSON.stringify(active.required_fields ?? ['initials', 'signedName']),
        created_by: null,
        published_at: knex.fn.now(),
      }).returning('*');
    } else {
      // Reused matching version: activation is the rollout moment.
      await knex('document_template_versions').where({ id: next.id }).update({ published_at: knex.fn.now() });
    }

    const update = {
      active_version_id: next.id,
      variables: JSON.stringify(withNewVariable(template.variables)),
      updated_at: knex.fn.now(),
    };
    if (template.description === target.oldDescription) update.description = target.newDescription;
    await knex('document_templates').where({ id: template.id }).update(update);
  }
};

exports.down = async function down() {
  // Documented no-op: see the header.
};

exports.NEW_VARIABLE = NEW_VARIABLE;
exports.TARGETS = TARGETS;
exports.spliceBondTerms = spliceBondTerms;
