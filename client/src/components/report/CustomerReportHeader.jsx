import './reportTemplate.css';

// WDO inspections and pre-treatment certificates keep their own paper documents.
const PAPER_DOCUMENT_TYPES = new Set(['wdo_inspection', 'pre_treatment_termite_certificate']);

// GATE_REPORT_SHARED_TEMPLATE: the server adds reportTemplate:true to a live report payload while the
// gate is on. Absent key = the page as it was before.
export function sharedReportTemplateActive(data) {
  if (!data || data.reportTemplate !== true) return false;
  return !PAPER_DOCUMENT_TYPES.has(data.projectType || data.typedReport?.type);
}

// Each of name / email / phone / address prints on its own line, mixed-case ("Chris Whitney", not
// "CHRIS WHITNEY" — owner 2026-07-09 and 2026-07-16). Records stored ALL-CAPS (common on older
// customer rows) are title-cased for display only; an email lowercases.
function displayContactLine(raw) {
  const value = String(raw || '').trim();
  if (!value || value !== value.toUpperCase()) return value;
  if (value.includes('@')) return value.toLowerCase();
  return value.toLowerCase()
    .replace(/\b([a-z])(\w*)/g, (match, first, rest) => first.toUpperCase() + rest)
    .replace(/\b([A-Za-z]{2}) (\d{5}(?:-\d{4})?)$/, (match, state, zip) => `${state.toUpperCase()} ${zip}`);
}

// Mirrors the estimate hero's phone display: 10-digit US numbers get the (xxx) xxx-xxxx treatment,
// anything else renders as stored.
function displayPhone(phone) {
  const raw = String(phone || '').replace(/\D/g, '');
  const digits = raw.length === 11 && raw.startsWith('1') ? raw.slice(1) : raw;
  return digits.length === 10
    ? `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`
    : String(phone || '').trim();
}

// The service report's customer header (eyebrow, title, contact lines), shared by every regular customer
// report. Callers pass only fields their payload already exposes. hideContact leaves out the email and
// phone (GATE_LAWN_REPORT_STAGE1_FIXES: a lawn report link can be shared).
export default function CustomerReportHeader({
  eyebrow,
  title,
  customerName,
  customerEmail,
  customerPhone,
  address,
  hideContact = false,
  className = '',
}) {
  const contactLines = [
    customerName,
    hideContact ? null : customerEmail,
    hideContact ? null : displayPhone(customerPhone),
    address,
  ].map(displayContactLine).filter(Boolean);

  return (
    <div className={`report-header ${className}`.trim()}>
      {eyebrow ? <div className="section-eyebrow report-header-eyebrow">{eyebrow}</div> : null}
      <h1 className="sr-title report-header-title">{title}</h1>
      {contactLines.length ? (
        <div className="service-meta-contact report-header-contact">
          {contactLines.map((line, index) => (
            <div key={`${index}-${line}`} className="service-meta-address">{line}</div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
