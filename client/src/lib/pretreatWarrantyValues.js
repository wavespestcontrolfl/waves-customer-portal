// Merge values for the New Construction Termite Warranty
// (service_agreement.termite_new_construction_warranty, Rule 5E-14.105(3))
// built from a pre-treat certificate. The office adds what the certificate
// does not hold (prices, the contract basis, the issuer) before issuing.
import { etDateString } from './timezone';

export const NEW_CONSTRUCTION_WARRANTY_TEMPLATE_KEY = 'service_agreement.termite_new_construction_warranty';

// Plan length in years per certificate warranty choice. "Builder 1-year" is
// the pre-#6490 label of the same plan.
const PLAN_YEARS = {
  'Builder 1-year, renewable yearly to year 5': 1,
  'Builder 1-year': 1,
  'Renewable 5-year retreatment bond': 5,
  'Renewable 10-year retreatment bond': 10,
};

export const WARRANTY_DEFAULT_STRUCTURES = 'The new home and its attached garage on this lot.';
export const WARRANTY_DEFAULT_NOTICE_LOCATION = 'near the water heater or the electric panel';
export const FINAL_EXTERIOR_NOT_DONE = 'Final exterior treatment: not yet performed. We perform it after final grade and record the date on your certificate. It does not change the warranty dates above.';

function text(value) {
  return typeof value === 'string' ? value.trim() : (value == null ? '' : String(value).trim());
}

function parseDateOnly(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(text(value));
  return match ? { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) } : null;
}

function formatUs({ y, m, d }) {
  return `${String(m).padStart(2, '0')}/${String(d).padStart(2, '0')}/${y}`;
}

// Same month and day `years` later; Feb 29 falls back to Feb 28.
function addYears(date, years) {
  const y = date.y + years;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const d = date.m === 2 && date.d === 29 && !leap ? 28 : date.d;
  return { y, m: date.m, d };
}

export function warrantyPlanYears(warrantyType) {
  return PLAN_YEARS[text(warrantyType)] || null;
}

function additionalApplications(value) {
  let rows = value;
  if (typeof rows === 'string') {
    try { rows = JSON.parse(rows); } catch { rows = []; }
  }
  return (Array.isArray(rows) ? rows : [])
    .filter((row) => row && typeof row === 'object' && Object.values(row).some((v) => text(v)));
}

// The warranty text describes one preventive soil treatment. A borate wood
// treatment, a bait system (its own program agreement) or a combined job
// needs other wording, so only a single soil-barrier application qualifies.
export function warrantyEligible(findings = {}) {
  return Boolean(warrantyPlanYears(findings.warranty_type))
    && text(findings.treatment_method) === 'Soil barrier (chemical)'
    && additionalApplications(findings.additional_applications).length === 0;
}

// The certificate's own values; '' where the certificate has nothing, so the
// issue route reports the field as unfilled instead of printing a guess.
export function pretreatWarrantyValues({ project = {}, findings = {}, today = etDateString() } = {}) {
  const initial = parseDateOnly(findings.treatment_date) || parseDateOnly(project.project_date);
  const years = warrantyPlanYears(findings.warranty_type);
  const termEnd = initial && years ? formatUs(addYears(initial, years)) : '';
  const finalDate = parseDateOnly(findings.final_exterior_date);
  const lot = [text(findings.lot_block), text(findings.subdivision)].filter(Boolean).join(', ');
  const todayParts = parseDateOnly(today);
  return {
    project: {
      builder: text(findings.builder_contractor),
      address: text(findings.treatment_address) || text(project.address),
      lot: lot || 'N/A',
      permit: text(findings.permit_number) || 'N/A',
    },
    treatment: {
      product: text(findings.product_name),
      active_ingredient: text(findings.active_ingredient),
      concentration: text(findings.concentration_pct),
      gallons: text(findings.gallons_applied),
      sq_ft: text(findings.square_footage),
      linear_ft: text(findings.linear_feet) || 'N/A',
      initial_date: initial ? formatUs(initial) : '',
      final_exterior_line: finalDate
        ? `Final exterior treatment date: ${formatUs(finalDate)}.`
        : FINAL_EXTERIOR_NOT_DONE,
      applicator: text(findings.applicator_name),
      applicator_id: text(findings.applicator_fdacs_id),
    },
    warranty: {
      number: project.id ? `NCW-${String(project.id).replace(/-/g, '').slice(0, 8).toUpperCase()}` : '',
      structures: WARRANTY_DEFAULT_STRUCTURES,
      plan: text(findings.warranty_type),
      term_end: termEnd,
      renewal_due: termEnd,
      payer: text(findings.builder_contractor),
      notice_location: WARRANTY_DEFAULT_NOTICE_LOCATION,
      issue_date: todayParts ? formatUs(todayParts) : '',
      treatment_price: '',
      plan_price: years === 1 ? 'Included in the treatment price' : '',
      renewal_fee: '',
      contract_basis: '',
      consumer_notice_date: '',
    },
    issuer: { name: '', title: '' },
  };
}

// The two lawful bases for issuing after treatment (Rule 5E-14.105(2), (3)(c)).
export function warrantyContractBasis({ kind, builder = '', date = '' }) {
  if (kind === 'master') {
    return `Issued under the master agreement with ${text(builder) || 'the builder'} dated ${text(date)}.`;
  }
  return `Signed by the owner or authorized agent before treatment, on ${text(date)}.`;
}
