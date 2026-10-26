// Owner ask 2026-09-28: every report links to the public Products & Safety
// page, the two pdfkit generators outside ServiceReportDocument included —
// the legacy (pre-v1) token PDF in reports-public.js and the Documents-API
// PDF for visits with no report token. Both stream pdfkit output, so these
// pin the footer calls at the source level.
const fs = require('fs');
const path = require('path');

const read = (rel) => fs.readFileSync(path.join(__dirname, rel), 'utf8');

describe('legacy token report PDF footer (reports-public.js)', () => {
  const routeSrc = read('../routes/reports-public.js');
  const rendererSrc = read('../services/pdf/legacy-service-report-pdf.js');
  const fn = routeSrc.slice(routeSrc.indexOf('function generateReportPDF('));

  it('prints the Products & Safety URL from the shared constant', () => {
    expect(rendererSrc).toMatch(/Every product we use and our safety protocol: \$\{WAVES_PRODUCTS_SAFETY_URL\}/);
  });

  it('adds a link annotation to the safety protocol anchor', () => {
    expect(rendererSrc).toMatch(/link: `\$\{WAVES_PRODUCTS_SAFETY_URL\}#safety-protocol`/);
  });

  it('keeps the reviewed-note privacy gate in the route before rendering', () => {
    expect(fn).toMatch(/const reviewedNotes = customerSafeVisitNotes\(service\);/);
    expect(fn).toMatch(/renderLegacyServiceReportPdf\(\{[\s\S]*reviewedNotes,/);
  });

  it('imports the constant in the focused renderer from the business constants module', () => {
    expect(rendererSrc).toMatch(/WAVES_PRODUCTS_SAFETY_URL,[\s\S]*require\('\.\.\/\.\.\/constants\/business'\);/);
  });
});

describe('Documents API service report PDF footer (documents.js)', () => {
  const src = read('../routes/documents.js');
  const fn = src.slice(src.indexOf('function generateServiceReportPDF('));

  it('prints the Products & Safety URL with a link annotation in the footer band', () => {
    expect(src.indexOf('function generateServiceReportPDF(')).toBeGreaterThan(-1);
    expect(fn).toMatch(/Every product we use and our safety protocol: \$\{WAVES_PRODUCTS_SAFETY_URL\}/);
    expect(fn).toMatch(/detailLink: `\$\{WAVES_PRODUCTS_SAFETY_URL\}#safety-protocol`/);
  });

  it('imports the constant from the business constants module', () => {
    expect(src).toMatch(/WAVES_PRODUCTS_SAFETY_URL,\n\} = require\('\.\.\/constants\/business'\);/);
  });
});
