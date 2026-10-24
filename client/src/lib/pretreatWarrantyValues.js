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
// A blank date on this certificate does not prove the later visit has not
// happened (that visit keeps its own record), so the wording stays neutral.
export const FINAL_EXTERIOR_NOT_DONE = 'Final exterior treatment: not recorded on this certificate when this warranty was issued. It does not change the warranty dates above.';

// One line, no "**": a certificate field can never become its own clause or
// a bold line in the warranty (the issue route does the same server-side).
function text(value) {
  const raw = typeof value === 'string' ? value : (value == null ? '' : String(value));
  return raw.replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
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
function treatmentMethod(findings) {
  const method = text(findings.treatment_method);
  return method === 'Other' ? text(findings.treatment_method_other) : method;
}

// The warranty covers subterranean termites only (the server checks the same).
const SUBTERRANEAN_TARGETS = ['Subterranean termites', 'Formosan subterranean termites'];
function targetsSubterranean(value) {
  let targets = value;
  if (typeof targets === 'string') {
    try { targets = JSON.parse(targets); } catch { targets = targets.split(','); }
  }
  return (Array.isArray(targets) ? targets : [targets]).some((target) => SUBTERRANEAN_TARGETS.includes(text(target)));
}

export function warrantyEligible(findings = {}) {
  return Boolean(warrantyPlanYears(findings.warranty_type))
    && treatmentMethod(findings) === 'Soil barrier (chemical)'
    && targetsSubterranean(findings.wdo_target)
    && additionalApplications(findings.additional_applications).length === 0;
}

// The certificate's own values; '' where the certificate has nothing, so the
// issue route reports the field as unfilled instead of printing a guess.
// Street address on the certificate; else the lot (a lot-only certificate is
// valid before the street exists; a subdivision alone is not); else blank. The customer's address may be
// a builder's office, so it never stands in for the site (the server refuses).
function propertyAddress(findings, lot) {
  const street = text(findings.treatment_address);
  if (street) return street;
  if (text(findings.lot_block)) return [lot, text(findings.permit_number) && `permit ${text(findings.permit_number)}`].filter(Boolean).join(', ');
  return '';
}

export function pretreatWarrantyValues({ project = {}, findings = {}, today = etDateString(), basisKind = 'signed' } = {}) {
  // project_date is the treatment date (the server refuses a legacy findings date that disagrees).
  const initial = parseDateOnly(project.project_date);
  const years = warrantyPlanYears(findings.warranty_type);
  const finalDate = parseDateOnly(findings.final_exterior_date);
  // A builder lot under the master agreement runs from its final treatment
  // date; an owner contract from the initial one (the server's rule).
  const start = basisKind === 'master' ? finalDate : initial;
  const termEnd = start && years ? formatUs(addYears(start, years)) : '';
  const lot = [text(findings.lot_block), text(findings.subdivision)].filter(Boolean).join(', ');
  // A legacy "Other" pick keeps the real product in product_name_other, as
  // the certificate page and the send gate read it.
  const product = text(findings.product_name) === 'Other' ? text(findings.product_name_other) : text(findings.product_name);
  const todayParts = parseDateOnly(today);
  return {
    project: {
      builder: text(findings.builder_contractor),
      address: propertyAddress(findings, lot),
      lot: lot || 'N/A',
      permit: text(findings.permit_number) || 'N/A',
    },
    treatment: {
      product,
      active_ingredient: text(findings.active_ingredient),
      concentration: text(findings.concentration_pct),
      gallons: text(findings.gallons_applied),
      sq_ft: text(findings.square_footage) || 'N/A',
      linear_ft: text(findings.linear_feet) || 'N/A',
      initial_date: initial ? formatUs(initial) : '',
      final_exterior_line: finalDate
        ? `Final exterior treatment date: ${formatUs(finalDate)}.`
        : FINAL_EXTERIOR_NOT_DONE,
      applicator: text(findings.applicator_name),
      applicator_id: text(findings.applicator_fdacs_id),
    },
    warranty: {
      number: project.id ? `NCW-${String(project.id).toUpperCase()}` : '',
      structures: WARRANTY_DEFAULT_STRUCTURES,
      plan: text(findings.warranty_type),
      start_basis: basisKind === 'master' ? 'final' : 'initial',
      start_date: start ? formatUs(start) : '',
      term_end: termEnd,
      renewal_due: termEnd,
      payer: '',
      notice_location: '',
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

function parsedObject(value) {
  let parsed = value;
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed); } catch { parsed = null; }
  }
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
}

// The certificate as it went out (projects.pretreat_sent_snapshot). The
// server builds the warranty from this copy, so the button and the dialog
// read it too, never live edits made after the send. Null = never sent.
export function sentCertificate(project = {}) {
  const copy = parsedObject(project?.pretreat_sent_snapshot);
  const findings = parsedObject(copy?.findings);
  if (!findings) return null;
  return { project: { ...project, project_date: copy.project_date }, findings };
}

// MM/DD/YYYY → { y, m, d }, or null when not a real calendar date.
export function parseUsDate(value) {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text(value));
  if (!match) return null;
  const date = { y: Number(match[3]), m: Number(match[1]), d: Number(match[2]) };
  const check = new Date(Date.UTC(date.y, date.m - 1, date.d));
  return check.getUTCMonth() === date.m - 1 && check.getUTCDate() === date.d ? date : null;
}

function dateKey({ y, m, d }) {
  return y * 10000 + m * 100 + d;
}

// The contract basis must be a real date on or before the treatment date
// (Rule 5E-14.105(2): the contract comes before any work).
export function basisDateProblem(basisDate, initialDate) {
  const basis = parseUsDate(basisDate);
  if (!basis) return 'Enter the date as MM/DD/YYYY.';
  const initial = parseUsDate(initialDate);
  if (initial && dateKey(basis) > dateKey(initial)) return 'This date must be on or before the treatment date.';
  return '';
}

// Days from treatment to issue; Rule 5E-14.105(3)(a) wants 30 or fewer.
export function daysSinceTreatment(initialDate, issueDate) {
  const a = parseUsDate(initialDate);
  const b = parseUsDate(issueDate);
  if (!a || !b) return null;
  return Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / 86400000);
}

// The latest usable FDACS-13692 notice signed on or before the treatment date
// and the contract basis date (Rule 5E-14.105(1)); the server picks the same
// one. `notices` is the consumer-notices list (signedOn MM/DD/YYYY, newest
// first). Without a real basis date yet, only the treatment date limits it.
export function consumerNoticeOnFile(notices, initialDate, basisDate) {
  const limits = [parseUsDate(initialDate), parseUsDate(basisDate)].filter(Boolean).map(dateKey);
  if (!limits.length) return null;
  const limit = Math.min(...limits);
  return (notices || []).find((notice) => {
    const day = notice.usable && parseUsDate(notice.signedOn);
    return day && dateKey(day) <= limit;
  }) || null;
}

// What blocks Create in the issue dialog: every office field filled, both
// dates real and on or before treatment, and a plan with a treatment date.
// With a notice on file the typed FDACS-13692 date is not asked for.
export function warrantyIssueReadiness(base, office, { noticeOnFile = false } = {}) {
  const initial = base.treatment.initial_date;
  const basisProblem = text(office.basisDate) ? basisDateProblem(office.basisDate, initial) : '';
  const noticeProblem = !noticeOnFile && text(office.noticeDate) ? basisDateProblem(office.noticeDate, initial) : '';
  const required = noticeOnFile ? Object.fromEntries(Object.entries(office).filter(([field]) => field !== 'noticeDate')) : office;
  const filled = Object.values(required).every((v) => text(v));
  return {
    basisProblem,
    noticeProblem,
    ready: Boolean(filled && !basisProblem && !noticeProblem && base.warranty.term_end && initial),
  };
}

