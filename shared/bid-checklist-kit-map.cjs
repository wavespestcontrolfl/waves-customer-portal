'use strict';

/**
 * Which Bid kit papers a Bid Desk checklist line needs (GATE_BID_KIT + GATE_BID_CHECKLIST, admin only). Data only, no I/O
 * and no requires, so the admin page can load it through the `@bid-checklist-kit-map` alias. The page reads the kit
 * (GET /api/admin/bid-kit) and shows the kit's own status beside each mapped line. It never ticks a line.
 *
 * Keyed by the line's own key: a bid's `template_key` is `<section>.<key>` (for example `itb.business_license`), so the
 * part after the first dot is the key used here (see shared/bid-checklist-templates.cjs). Values are kit item keys
 * (shared/bid-kit-catalog.cjs). A line with no entry here (signer, criteria_pages, narrative, post_opening, a line the
 * operator typed...) shows nothing.
 */

const CHECKLIST_KIT_MAP = {
  // The ten-line bid check.
  licenses: ['business_license_copy', 'cpco_certificate', 'sunbiz_status', 'business_tax_receipt'],
  forms: ['everify', 'drug_free_policy'],
  // Stop checks.
  gc_insurance: ['insurance_certificate'],
  reference_rules: ['reference'],
  // Quote lines.
  references: ['reference'],
  insurance_certificate: ['insurance_certificate'],
  // The ITB lines (the five papers bid 24-0118 rejected come first).
  business_license: ['business_license_copy'],
  operator_certificate: ['cpco_certificate'],
  operator_statement: ['cpco_fulltime_statement'],
  employee_ids: ['employee_id_cards'],
  product_list: ['product_list'],
  references_form: ['reference'],
  local_preference: ['business_tax_receipt'],
  responsibility: ['service_center_proof'],
  // The RFP lines.
  reference_surveys: ['reference'],
  // General-contractor lines.
  insurance_exhibit: ['insurance_certificate'],
  // Federal lines.
  reps_certs: ['sam_uei', 'cage_code'],
  past_performance: ['reference'],
};

/** Agencies ask for three to five references; the line shows how many of three are ready. */
const REFERENCE_TARGET = 3;

/** The part of a bid's template_key after its section (`itb.business_license` -> `business_license`); null for a typed line. */
function lineKey(templateKey) {
  if (typeof templateKey !== 'string' || !templateKey) return null;
  const at = templateKey.indexOf('.');
  return at === -1 ? templateKey : templateKey.slice(at + 1);
}

/** The kit item keys a checklist line needs, or [] when it has none. */
function kitKeysForLine(templateKey) {
  const key = lineKey(templateKey);
  return key && Object.prototype.hasOwnProperty.call(CHECKLIST_KIT_MAP, key) ? CHECKLIST_KIT_MAP[key] : [];
}

module.exports = { CHECKLIST_KIT_MAP, REFERENCE_TARGET, lineKey, kitKeysForLine };
