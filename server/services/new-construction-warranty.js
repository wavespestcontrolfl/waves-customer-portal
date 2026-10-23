// New Construction Termite Warranty (Rule 5E-14.105(3)): one live warranty
// per pre-treat job. The warranty number (NCW-…, from the project id) names
// the job in every issued snapshot.
const db = require('../models/db');
const { customerCopyViolations } = require('./service-report/technician-report-copy');
const { etDateString } = require('../utils/datetime-et');

const NEW_CONSTRUCTION_WARRANTY_KEY = 'service_agreement.termite_new_construction_warranty';
const OPEN_STATUSES = ['draft', 'sent', 'viewed'];

function snapshotWarrantyNumber(snapshot) {
  let parsed = snapshot;
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed); } catch { parsed = null; }
  }
  return String(parsed?.warranty?.number || '').trim();
}

// Runs inside the issue transaction after the customer row lock. A signed
// warranty for the same job refuses the new one (409); an open one is
// cancelled as superseded, so the customer never holds two signing links.
async function supersedeOpenNewConstructionWarranty(trx, { templateKey, customerId, context, actorId }) {
  if (templateKey !== NEW_CONSTRUCTION_WARRANTY_KEY) return;
  const number = String(context?.warranty?.number || '').trim();
  if (!number) return;
  const prior = await trx('customer_contracts')
    .where({ customer_id: customerId, contract_type: 'document_template', document_template_key: templateKey })
    .whereIn('status', [...OPEN_STATUSES, 'signed'])
    .forUpdate()
    .select('id', 'status', 'document_variables_snapshot');
  const sameJob = prior.filter((row) => snapshotWarrantyNumber(row.document_variables_snapshot) === number);
  if (sameJob.some((row) => row.status === 'signed')) {
    throw Object.assign(new Error(`Warranty ${number} is already signed for this job.`), { status: 409 });
  }
  for (const row of sameJob) {
    const cancelled = await trx('customer_contracts')
      .where({ id: row.id })
      .whereIn('status', OPEN_STATUSES)
      .update({
        status: 'cancelled',
        cancelled_at: new Date(),
        cancelled_reason: 'Superseded by a newer issue of the same new construction warranty',
        updated_at: new Date(),
      });
    if (!cancelled) continue;
    await trx('customer_contract_events').insert({
      contract_id: row.id,
      customer_id: customerId,
      event_type: 'cancelled',
      actor_type: 'admin',
      actor_id: actorId || null,
      metadata: JSON.stringify({ reason: 'superseded_by_warranty_reissue' }),
    });
  }
}

// Job values come from certificate fields a technician can type into. In this
// warranty a value may never become its own line or a bold clause, so every
// string is flattened to one line and loses "**" before rendering.
function flattenWarrantyValue(value) {
  if (typeof value === 'string') return value.replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
  if (Array.isArray(value)) return value.map(flattenWarrantyValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, flattenWarrantyValue(v)]));
  }
  return value;
}


// ── Server-built warranty values (Codex #6515 r4) ──────────────────────────
// The warranty is built here from the saved pre-treat certificate, never from
// values a browser assembled: the issue route needs the project, the job
// fields come from its findings, the issue date is the server's ET date, and
// only the office's own fields are taken from the request.

const PLAN_YEARS = {
  'Builder 1-year, renewable yearly to year 5': 1,
  'Builder 1-year': 1,
  'Renewable 5-year retreatment bond': 5,
  'Renewable 10-year retreatment bond': 10,
};
// payer comes from the office: the certificate's builder is not always the
// party who paid for the treatment.
const OFFICE_FIELDS = ['structures', 'notice_location', 'payer', 'treatment_price', 'plan_price', 'renewal_fee', 'consumer_notice_date'];
const FINAL_EXTERIOR_NOT_RECORDED = 'Final exterior treatment: not recorded on this certificate when this warranty was issued. It does not change the warranty dates above.';

function bad(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function oneLine(value) {
  return flattenWarrantyValue(value == null ? '' : String(value));
}

// An exact, real YYYY-MM-DD (a date-only or midnight timestamp from the
// database row also passes); anything else is not a date.
function parseIso(value) {
  const raw = value instanceof Date ? value.toISOString().slice(0, 10) : oneLine(value);
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T00:00:00(?:\.000)?Z)?$/.exec(raw);
  if (!m) return null;
  const date = { y: +m[1], m: +m[2], d: +m[3] };
  const check = new Date(Date.UTC(date.y, date.m - 1, date.d));
  return check.getUTCMonth() === date.m - 1 && check.getUTCDate() === date.d ? date : null;
}

// A filled certificate date must be a real date; blank stays blank.
function certificateDate(findings, field, label) {
  if (!oneLine(findings[field])) return null;
  const date = parseIso(findings[field]);
  if (!date) throw bad(`${label} on the certificate is not a real date (YYYY-MM-DD).`, 409);
  return date;
}

function parseUs(value) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(oneLine(value));
  if (!m) return null;
  const date = { y: +m[3], m: +m[1], d: +m[2] };
  const check = new Date(Date.UTC(date.y, date.m - 1, date.d));
  return check.getUTCMonth() === date.m - 1 && check.getUTCDate() === date.d ? date : null;
}

const us = ({ y, m, d }) => `${String(m).padStart(2, '0')}/${String(d).padStart(2, '0')}/${y}`;
const key = ({ y, m, d }) => y * 10000 + m * 100 + d;

function addYears(date, years) {
  const y = date.y + years;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  return { y, m: date.m, d: date.m === 2 && date.d === 29 && !leap ? 28 : date.d };
}

function parseFindings(raw) {
  if (raw && typeof raw === 'object') return raw;
  try { return JSON.parse(raw || '{}') || {}; } catch { return {}; }
}

function extraApplications(value) {
  const rows = Array.isArray(value) ? value : parseFindings(value);
  return (Array.isArray(rows) ? rows : []).filter((row) => row && typeof row === 'object' && Object.values(row).some((v) => oneLine(v)));
}

// A legacy "Other" pick keeps the real method in treatment_method_other, as
// the certificate send gate reads it.
function treatmentMethod(findings) {
  const method = oneLine(findings.treatment_method);
  return method === 'Other' ? oneLine(findings.treatment_method_other) : method;
}

// Same rule as the admin button: one soil-barrier application with a plan.
function warrantyEligible(findings) {
  return Boolean(PLAN_YEARS[oneLine(findings.warranty_type)])
    && treatmentMethod(findings) === 'Soil barrier (chemical)'
    && extraApplications(findings.additional_applications).length === 0;
}

// The treated site from the certificate only: the customer's own address may
// be a builder's office, so it never stands in for the property.
function propertyAddress(findings, lot) {
  const street = oneLine(findings.treatment_address);
  if (street) return street;
  if (!lot) throw bad('The certificate has no treatment address or lot.', 409);
  const permit = oneLine(findings.permit_number);
  return [lot, permit && `permit ${permit}`].filter(Boolean).join(', ');
}

function contractBasis(basis, builder, initial) {
  const date = parseUs(basis?.date);
  if (!date) throw bad('Enter the contract basis date as MM/DD/YYYY.');
  if (key(date) > key(initial)) throw bad('The contract basis date must be on or before the treatment date.');
  return basis?.kind === 'signed'
    ? `Signed by the owner or authorized agent before treatment, on ${us(date)}.`
    : `Issued under the master agreement with ${builder || 'the builder'} dated ${us(date)}.`;
}

function officeFields(body, initial) {
  const warranty = body?.values?.warranty || {};
  const out = Object.fromEntries(OFFICE_FIELDS.map((field) => [field, oneLine(warranty[field])]));
  const notice = parseUs(out.consumer_notice_date);
  if (!notice || key(notice) > key(initial)) throw bad('The FDACS-13692 date must be a real date on or before the treatment date.');
  out.consumer_notice_date = us(notice);
  return out;
}

function certificateValues(project, findings) {
  // project_date is the certificate's treatment date; a legacy
  // findings.treatment_date must agree with it, never override it.
  const initial = parseIso(project.project_date);
  if (!initial) throw bad('The certificate has no treatment date.');
  const legacyDate = certificateDate(findings, 'treatment_date', 'The treatment date');
  if (legacyDate && key(legacyDate) !== key(initial)) throw bad('The certificate has two different treatment dates. Fix the certificate first.', 409);
  const termEnd = us(addYears(initial, PLAN_YEARS[oneLine(findings.warranty_type)]));
  const lot = [oneLine(findings.lot_block), oneLine(findings.subdivision)].filter(Boolean).join(', ');
  const finalDate = certificateDate(findings, 'final_exterior_date', 'The final exterior date');
  const recordedRenewal = certificateDate(findings, 'renewal_due', 'Renewal due by');
  // Renewal is due when the guaranteed term ends; a recorded date that
  // differs would end coverage early, so it stops the issue.
  if (recordedRenewal && us(recordedRenewal) !== termEnd) {
    throw bad(`Renewal due by on the certificate must be the term end, ${termEnd}.`, 409);
  }
  // The send gate takes square or linear feet; one of them must be there.
  if (!oneLine(findings.square_footage) && !oneLine(findings.linear_feet)) throw bad('The certificate has no square or linear feet.', 409);
  const product = oneLine(findings.product_name) === 'Other' ? oneLine(findings.product_name_other) : oneLine(findings.product_name);
  return {
    initial,
    values: {
      project: { builder: oneLine(findings.builder_contractor), address: propertyAddress(findings, lot), lot: lot || 'N/A', permit: oneLine(findings.permit_number) || 'N/A' },
      treatment: {
        product,
        active_ingredient: oneLine(findings.active_ingredient),
        concentration: oneLine(findings.concentration_pct),
        gallons: oneLine(findings.gallons_applied),
        sq_ft: oneLine(findings.square_footage) || 'N/A',
        linear_ft: oneLine(findings.linear_feet) || 'N/A',
        initial_date: us(initial),
        final_exterior_line: finalDate ? `Final exterior treatment date: ${us(finalDate)}.` : FINAL_EXTERIOR_NOT_RECORDED,
        applicator: oneLine(findings.applicator_name),
        applicator_id: oneLine(findings.applicator_fdacs_id),
      },
      warranty: {
        number: `NCW-${String(project.id).replace(/-/g, '').slice(0, 8).toUpperCase()}`,
        plan: oneLine(findings.warranty_type),
        term_end: termEnd,
        renewal_due: termEnd,
      },
    },
  };
}

// Every value prints on the customer's signable contract, so each one runs
// the full customer copy screen (AGENTS.md): no access codes, no "safe" or
// other banned claims. The refusal names the fields to fix.
function screenValues(values) {
  const failing = Object.entries(values).flatMap(([group, fields]) => Object.entries(fields)
    .filter(([, value]) => customerCopyViolations(value).length > 0)
    .map(([field]) => `${group}.${field}`));
  if (failing.length) {
    throw bad(`Remove the access code or banned wording from: ${failing.join(', ')}.`);
  }
  return values;
}

// Values for one issue of the warranty, built server-side from the project
// named in the request. The issue route calls it again inside its
// transaction with `trx`, which locks the certificate row, so the snapshot is
// the certificate as it stands at insert time. Any other template passes its
// values through.
async function templateIssueValues(templateKey, body, customer, conn = db) {
  if (templateKey !== NEW_CONSTRUCTION_WARRANTY_KEY) return body?.values || {};
  if (body?.allowUnresolved === true) throw bad('The new construction warranty cannot be issued with blank fields.');
  const projectId = body?.projectId;
  if (!projectId) throw bad('Issue the new construction warranty from its pre-treat certificate.');
  const project = await conn('projects').where({ id: projectId }).forUpdate().first();
  if (!project || project.project_type !== 'pre_treatment_termite_certificate' || project.customer_id !== customer.id) {
    throw bad('Pre-treat certificate not found for this customer.', 404);
  }
  const findings = parseFindings(project.findings);
  if (!warrantyEligible(findings)) throw bad('This certificate does not qualify for the new construction warranty.', 409);
  const { initial, values } = certificateValues(project, findings);
  const issuer = body?.values?.issuer || {};
  return screenValues({
    ...values,
    warranty: {
      ...values.warranty,
      ...officeFields(body, initial),
      contract_basis: contractBasis(body?.values?.basis, values.project.builder, initial),
      issue_date: us(parseIso(etDateString())),
    },
    issuer: { name: oneLine(issuer.name), title: oneLine(issuer.title) },
  });
}

module.exports = {
  NEW_CONSTRUCTION_WARRANTY_KEY,
  supersedeOpenNewConstructionWarranty,
  snapshotWarrantyNumber,
  templateIssueValues,
};
