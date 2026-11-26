'use strict';

// Owner ruling 2026-11-25 ("retreatment only until insurance confirms a cap"): Waves stops selling termite
// damage-repair coverage on new work. The signable bond seeded as service_agreement.termite_bond_repair
// ("Termite Repair & Retreatment Bond Agreement", 20260623000003) promised to repair new termite damage "up to
// the coverage terms confirmed in writing with this bond", a cap nobody has set. Every other termite agreement
// already says retreatment only (annual protection v3, bait v2, new-construction warranty, builder master, the
// retreatment bond), so this is the one signable text that still promised repair.
//
// Rule: convert ONLY a template whose active version is exactly the known text. The known text is the 20260623000003
// seed as 20261124030200 left it (SEEDED_BODY; whitespace-normalised compare); the converted text (CONVERTED_BODY) is
// the same body with the three known paragraphs swapped (title, coverage, customer responsibilities, e-signature
// line) for the retreatment bond's own wording. ANY other body, title or signer disclosure is an unrecognised
// edit: the template is PAUSED (status 'paused', text kept) for the office to review in the document library, and
// nothing is published. The retreatment bond stays available. No word list: an admin clause that promises
// repair in other words ("replace termite-damaged wood") is caught because it is not the known text.
//
// Same pattern as 20261124030200_termite_bond_agreements_term_billing: insert a NEW version at the next number
// (FOR UPDATE on the template row) from the active version's own signing settings and repoint active_version_id.
// Open and signed sends froze their text at issue time and keep the version they were signed on. Title and body are
// decided independently: a body that is already converted but still carries the repair title gets a new version
// with the corrected title and the same body. Template name, description and tags follow while still seeded.
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
const SEED_DISCLOSURE = 'I agree to receive and sign this document electronically.';

// Paragraphs that stay as seeded (after 20261124030200).
const HEADER = "Customer: {{customer.name}}\nProperty address: {{customer.address}}\nBond term: {{bond.term}}\nEffective date: {{bond.start_date}}\nTreatment type: {{treatment.type}}\nInitial bond price: {{bond.price}}\nQuarterly station check charge: {{bond.quarterly_price}}\nRenewal amount (next term): {{bond.renewal_price}}";
const RENEWAL = "Bond term and renewal: Coverage runs for the bond term shown ({{bond.term}}). The bond is billed with each quarterly station check, at the quarterly amount shown. If a quarterly charge is not paid by its due date, the bond lapses and coverage ends. At the end of the term, the customer may renew the bond for a new term at the renewal amount shown. Reinstatement after a lapse requires a new inspection and may require a new treatment at current pricing.";
const TRANSFER = "Transfer on sale: This bond may be transferred to a new owner if the property is sold, subject to a transfer re-inspection by Waves and any applicable transfer or inspection fee. Coverage for the new owner begins only after the re-inspection is completed.";
const NOT_COVERED = "What is not covered / what voids this bond: This bond does not cover, and may be voided by, any of the following: (a) damage existing as of the bond effective date or noted on the initial inspection; (b) drywood termites or pests other than the covered termite species, unless separately listed; (c) moisture or water intrusion that is not corrected; (d) structural alterations, additions, or new construction at the property after the original treatment; (e) conducive conditions (wood-to-ground contact, debris, mulch against the structure, leaks) that are not corrected; (f) changes to soil grade, landscaping, or the treated zone that disturb the treatment; (g) any treatment or chemical application to the structure by anyone other than Waves; (h) failure to pay the quarterly charges or to renew the bond at the end of its term.";

const OLD_COVERAGE = 'Coverage — retreatment and repair: Waves Pest Control, LLC warrants the covered termite treatment at the property above for the bond term shown. If covered subterranean termite activity is found at the property during the active bond period, Waves will (1) re-treat the affected area(s) at no additional charge, and (2) repair new termite damage caused by covered termite activity that occurs during the active bond period, up to the coverage terms confirmed in writing with this bond. This bond does NOT cover repair of damage that existed before the bond effective date, or damage from termites or pests not covered by this bond.';
const NEW_COVERAGE = 'Coverage — retreatment only: Waves Pest Control, LLC warrants the covered termite treatment at the property above for the bond term shown. If covered subterranean termite activity is found at the property during the active bond period, Waves will re-treat the affected area(s) at no additional charge. This bond covers RE-TREATMENT ONLY. It does NOT include repair of any termite damage — existing, new, or otherwise — or replacement of any wood, structural, or other materials.';
const OLD_RESPONSIBILITIES = "Customer responsibilities: Provide safe access for inspections, retreatment, and repair work; correct conducive conditions and moisture issues when notified; and notify Waves promptly of suspected termite activity. Allow Waves to perform periodic inspections during the bond term.";
const NEW_RESPONSIBILITIES = OLD_RESPONSIBILITIES.replace('Provide safe access for inspections, retreatment, and repair work;', 'Provide safe access for inspections and retreatment;');
const OLD_SIGNATURE = "Electronic signature: By signing, the customer confirms they reviewed this agreement, understand the retreatment and repair coverage and its limits, and intend to sign it electronically.";
const NEW_SIGNATURE = OLD_SIGNATURE.replace(
  'understand the retreatment and repair coverage and its limits, and intend to sign it electronically.',
  'understand that this bond covers retreatment only and does NOT include repair of termite damage, and intend to sign it electronically.',
);

const joinBody = (parts) => parts.join('\n\n');
const SEEDED_BODY = joinBody([OLD_TITLE, HEADER, OLD_COVERAGE, RENEWAL, TRANSFER, NOT_COVERED, OLD_RESPONSIBILITIES, OLD_SIGNATURE]);
const CONVERTED_BODY = joinBody([NEW_TITLE, HEADER, NEW_COVERAGE, RENEWAL, TRANSFER, NOT_COVERED, NEW_RESPONSIBILITIES, NEW_SIGNATURE]);

const OLD_NAME = 'Termite Repair & Retreatment Bond Agreement';
const NEW_NAME = 'Termite Retreatment Bond Agreement (former repair bond)';
const OLD_DESCRIPTION_START = 'Signable termite bond covering retreatment plus repair of new covered termite damage.';
const NEW_DESCRIPTION_START = 'Signable termite bond covering retreatment only (no repair of termite damage; repair coverage stopped 2026-11-25 until insurance confirms a cap).';

const normalise = (text) => String(text || '').replace(/\s+/g, ' ').trim();

/** 'seeded' (convert), 'converted' (body already done) or 'unrecognised' (pause). */
function classifyBody(body) {
  const text = normalise(body);
  if (text === normalise(SEEDED_BODY)) return 'seeded';
  if (text === normalise(CONVERTED_BODY)) return 'converted';
  return 'unrecognised';
}

/** True when the title and signer disclosure are the seeded (or already corrected) values. */
function fieldsRecognised(version) {
  return (version.title === OLD_TITLE || version.title === NEW_TITLE)
    && (version.signer_disclosure == null || version.signer_disclosure === SEED_DISCLOSURE);
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

  const kind = classifyBody(active.body);
  if (kind === 'unrecognised' || !fieldsRecognised(active)) {
    if (template.status === 'active') {
      await knex('document_templates').where({ id: template.id }).update({ status: 'paused', updated_at: knex.fn.now() });
    }
    return;
  }

  const update = {};
  if (kind === 'seeded' || active.title !== NEW_TITLE) {
    const versions = await knex('document_template_versions')
      .where({ template_id: template.id })
      .orderBy('version_number', 'asc');
    const nextNumber = Math.max(0, ...versions.map((v) => Number(v.version_number) || 0)) + 1;
    const [next] = await knex('document_template_versions').insert({
      template_id: template.id,
      version_number: nextNumber,
      title: NEW_TITLE,
      body: kind === 'seeded' ? CONVERTED_BODY : active.body,
      signer_disclosure: active.signer_disclosure,
      variables: typeof active.variables === 'string' ? active.variables : JSON.stringify(active.variables ?? []),
      required_fields: typeof active.required_fields === 'string'
        ? active.required_fields
        : JSON.stringify(active.required_fields ?? ['initials', 'signedName']),
      created_by: null,
      published_at: knex.fn.now(),
    }).returning('*');
    update.active_version_id = next.id;
  }
  if (template.name === OLD_NAME) update.name = NEW_NAME;
  if (typeof template.description === 'string' && template.description.startsWith(OLD_DESCRIPTION_START)) {
    update.description = NEW_DESCRIPTION_START + template.description.slice(OLD_DESCRIPTION_START.length);
  }
  const tags = parseJsonValue(template.tags);
  if (Array.isArray(tags) && tags.includes('repair')) {
    update.tags = JSON.stringify(tags.filter((t) => t !== 'repair'));
  }
  if (Object.keys(update).length) {
    await knex('document_templates').where({ id: template.id }).update({ ...update, updated_at: knex.fn.now() });
  }
};

exports.down = async function down() {
  // Documented no-op: see the header.
};

exports.TEMPLATE_KEY = TEMPLATE_KEY;
exports.NEW_COVERAGE = NEW_COVERAGE;
exports.SEEDED_BODY = SEEDED_BODY;
exports.CONVERTED_BODY = CONVERTED_BODY;
exports.classifyBody = classifyBody;
exports.fieldsRecognised = fieldsRecognised;
