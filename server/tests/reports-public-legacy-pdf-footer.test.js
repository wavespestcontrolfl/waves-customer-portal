// Owner ask 2026-09-28: legacy (pre-v1) report PDFs link to the public
// Products & Safety page like every other report. generateReportPDF streams
// pdfkit output straight to the response, so this pins the footer call at
// the source level.
const fs = require('fs');
const path = require('path');

describe('legacy report PDF footer', () => {
  const src = fs.readFileSync(path.join(__dirname, '../routes/reports-public.js'), 'utf8');
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
