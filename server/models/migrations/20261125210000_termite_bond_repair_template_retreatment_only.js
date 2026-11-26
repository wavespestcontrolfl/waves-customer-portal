'use strict';

// Owner ruling 2026-11-25 ("retreatment only until insurance confirms a cap"): Waves stops selling termite
// damage-repair coverage on new work. The signable bond seeded as service_agreement.termite_bond_repair
// ("Termite Repair & Retreatment Bond Agreement", 20260623000003) promised to repair new termite damage "up to
// the coverage terms confirmed in writing with this bond", a cap nobody has set. Every other termite agreement
// already says retreatment only (annual protection v3, bait v2, new-construction warranty, builder master, the
// retreatment bond), so this is the one signable text that still promised repair.
//
// Same pattern as 20261124030200_termite_bond_agreements_term_billing: read the CURRENTLY ACTIVE version (an
// admin edit made since the seed is kept), insert the result as a NEW version at the next number (FOR UPDATE on
// the template row) and repoint active_version_id. Open and signed sends froze their text at issue time and keep
// the version they were signed on. The coverage paragraph is the one required anchor: when an admin rewrote it,
// the repair promise cannot be proven gone, and the same holds when any other sentence still promises repair
// after the swaps, so the template is PAUSED (its text kept as edited) until the office
// fixes it in the document library; the retreatment bond stays available. The title, the customer-responsibilities clause
// and the e-signature sentence are rewritten when they still carry the seeded wording.
//
// The new coverage paragraph is the retreatment bond's own (20260623000003), which matches the Florida Rule
// 5E-14.105 disclosure that a contract must say whether it is retreatment only or retreatment and repair:
// "retreatment only, no repair of damage". Repair coverage returns only with an insurance-confirmed dollar cap,
// as a new version of this template.
//
// down(): documented no-op (owner rule 2026-08-09): version rows are history, the active pointer is an
// admin-editable value. Roll the WORDING back by publishing the earlier version from the document library.

const TEMPLATE_KEY = 'service_agreement.termite_bond_repair';

const OLD_TITLE = 'Termite Repair & Retreatment Bond Agreement';
const NEW_TITLE = 'Termite Retreatment Bond Agreement';

const OLD_COVERAGE = 'Coverage — retreatment and repair: Waves Pest Control, LLC warrants the covered termite treatment at the property above for the bond term shown. If covered subterranean termite activity is found at the property during the active bond period, Waves will (1) re-treat the affected area(s) at no additional charge, and (2) repair new termite damage caused by covered termite activity that occurs during the active bond period, up to the coverage terms confirmed in writing with this bond. This bond does NOT cover repair of damage that existed before the bond effective date, or damage from termites or pests not covered by this bond.';
const NEW_COVERAGE = 'Coverage — retreatment only: Waves Pest Control, LLC warrants the covered termite treatment at the property above for the bond term shown. If covered subterranean termite activity is found at the property during the active bond period, Waves will re-treat the affected area(s) at no additional charge. This bond covers RE-TREATMENT ONLY. It does NOT include repair of any termite damage — existing, new, or otherwise — or replacement of any wood, structural, or other materials.';

const SWAPS = [
  ['Provide safe access for inspections, retreatment, and repair work;', 'Provide safe access for inspections and retreatment;'],
  [
    'understand the retreatment and repair coverage and its limits, and intend to sign it electronically.',
    'understand that this bond covers retreatment only and does NOT include repair of termite damage, and intend to sign it electronically.',
  ],
];

const OLD_NAME = 'Termite Repair & Retreatment Bond Agreement';
const NEW_NAME = 'Termite Retreatment Bond Agreement (former repair bond)';
const OLD_DESCRIPTION_START = 'Signable termite bond covering retreatment plus repair of new covered termite damage.';
const NEW_DESCRIPTION_START = 'Signable termite bond covering retreatment only (no repair of termite damage; repair coverage stopped 2026-11-25 until insurance confirms a cap).';

// A sentence that mentions repair must deny it ("does NOT include repair", "no repair"). Anything else is a promise.
function promisesRepair(body) {
  return String(body || '')
    .split(/(?<=[.;])\s+|\n/)
    .some((sentence) => /repair/i.test(sentence) && !/\b(not|no|nor|without)\b/i.test(sentence));
}

/**
 * Rewrite one bond body. Returns { body, changed, reason }. changed=false with reason 'already_present' when the
 * body is already retreatment only and clean, 'anchor_missing' when the seeded coverage paragraph is gone, and
 * 'repair_remains' when the result (or an already-converted body) still promises repair somewhere. Both of the
 * last two pause the template.
 */
function toRetreatmentOnly(body) {
  const text = String(body || '');
  if (text.includes(NEW_COVERAGE)) {
    return promisesRepair(text) || text.includes(OLD_COVERAGE)
      ? { body: text, changed: false, reason: 'repair_remains' }
      : { body: text, changed: false, reason: 'already_present' };
  }
  if (!text.includes(OLD_COVERAGE)) return { body: text, changed: false, reason: 'anchor_missing' };
  let next = text.replace(OLD_COVERAGE, () => NEW_COVERAGE);
  if (next.startsWith(OLD_TITLE)) next = NEW_TITLE + next.slice(OLD_TITLE.length);
  for (const [from, to] of SWAPS) next = next.replace(from, () => to);
  if (promisesRepair(next)) return { body: text, changed: false, reason: 'repair_remains' };
  return { body: next, changed: true, reason: null };
}

function parseJsonValue(value) {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
}

exports.up = async function up(knex) {
  const hasTemplates = await knex.schema.hasTable('document_templates');
  const hasVersions = await knex.schema.hasTable('document_template_versions');
  if (!hasTemplates || !hasVersions) return;

  const template = await knex('document_templates').where({ template_key: TEMPLATE_KEY }).forUpdate().first();
  if (!template || !template.active_version_id) return;

  const active = await knex('document_template_versions').where({ id: template.active_version_id }).first();
  if (!active) return;

  const result = toRetreatmentOnly(active.body);
  if (result.reason === 'anchor_missing' || result.reason === 'repair_remains') {
    // The coverage paragraph was edited, or a repair promise sits outside the three phrases swapped here, so the
    // repair promise cannot be proven gone. Pause the template (the body stays as the admin left it) so no new
    // bond goes out with it; the retreatment bond stays available.
    if (template.status === 'active') {
      await knex('document_templates').where({ id: template.id }).update({ status: 'paused', updated_at: knex.fn.now() });
    }
    return;
  }
  if (!result.changed) return;

  const title = active.title === OLD_TITLE ? NEW_TITLE : active.title;
  const versions = await knex('document_template_versions')
    .where({ template_id: template.id })
    .orderBy('version_number', 'asc');
  // Always a fresh version built from the ACTIVE version's own signing settings: a historical version with the
  // same text could carry other signer_disclosure / variables / required_fields. Reruns stop at 'already_present'.
  const nextNumber = Math.max(0, ...versions.map((v) => Number(v.version_number) || 0)) + 1;
  const [next] = await knex('document_template_versions').insert({
    template_id: template.id,
    version_number: nextNumber,
    title,
    body: result.body,
    signer_disclosure: active.signer_disclosure,
    variables: typeof active.variables === 'string' ? active.variables : JSON.stringify(active.variables ?? []),
    required_fields: typeof active.required_fields === 'string'
      ? active.required_fields
      : JSON.stringify(active.required_fields ?? ['initials', 'signedName']),
    created_by: null,
    published_at: knex.fn.now(),
  }).returning('*');

  const update = { active_version_id: next.id, updated_at: knex.fn.now() };
  if (template.name === OLD_NAME) update.name = NEW_NAME;
  if (typeof template.description === 'string' && template.description.startsWith(OLD_DESCRIPTION_START)) {
    update.description = NEW_DESCRIPTION_START + template.description.slice(OLD_DESCRIPTION_START.length);
  }
  const tags = parseJsonValue(template.tags);
  if (Array.isArray(tags) && tags.includes('repair')) {
    update.tags = JSON.stringify(tags.filter((t) => t !== 'repair'));
  }
  await knex('document_templates').where({ id: template.id }).update(update);
};

exports.down = async function down() {
  // Documented no-op: see the header.
};

exports.TEMPLATE_KEY = TEMPLATE_KEY;
exports.NEW_COVERAGE = NEW_COVERAGE;
exports.toRetreatmentOnly = toRetreatmentOnly;
exports.promisesRepair = promisesRepair;
