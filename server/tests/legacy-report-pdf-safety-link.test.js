// Owner ask 2026-09-28: every report links to the public Products & Safety
// page, the two pdfkit generators outside ServiceReportDocument included —
// the legacy (pre-v1) token PDF in reports-public.js and the Documents-API
// PDF for visits with no report token. Both stream pdfkit output, so these
// pin the footer calls at the source level.
const fs = require('fs');
const path = require('path');

const read = (rel) => fs.readFileSync(path.join(__dirname, rel), 'utf8');

describe('legacy token report PDF footer (reports-public.js)', () => {
  const src = read('../routes/reports-public.js');
  const fn = src.slice(src.indexOf('function generateReportPDF('));

  it('prints the Products & Safety URL from the shared constant', () => {
    expect(fn).toMatch(/Every product we use and our safety protocol: \$\{WAVES_PRODUCTS_SAFETY_URL\}/);
  });

  it('adds a link annotation to the safety protocol anchor', () => {
    expect(fn).toMatch(/link: `\$\{WAVES_PRODUCTS_SAFETY_URL\}#safety-protocol`/);
  });

  it('imports the constant from the business constants module', () => {
    expect(src).toMatch(/WAVES_PRODUCTS_SAFETY_URL,\n\} = require\('\.\.\/constants\/business'\);/);
  });
});

describe('Documents API service report PDF footer (documents.js)', () => {
  const src = read('../routes/documents.js');
  const fn = src.slice(src.indexOf('function generateServiceReportPDF('));

  it('prints the Products & Safety URL with a link annotation in the footer band', () => {
    expect(src.indexOf('function generateServiceReportPDF(')).toBeGreaterThan(-1);
    expect(fn).toMatch(/Every product we use and our safety protocol: \$\{WAVES_PRODUCTS_SAFETY_URL\}/);
    expect(fn).toMatch(/link: `\$\{WAVES_PRODUCTS_SAFETY_URL\}#safety-protocol`/);
  });

  it('imports the constant from the business constants module', () => {
    expect(src).toMatch(/WAVES_PRODUCTS_SAFETY_URL,\n\} = require\('\.\.\/constants\/business'\);/);
  });
});
