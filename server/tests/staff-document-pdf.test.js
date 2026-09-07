process.env.ESTIMATE_DOC_PDF_MAX_CONCURRENT = '2';
process.env.JWT_SECRET = 'qa-staff-pdf-only';
jest.mock('../services/service-report/pdf-puppeteer', () => ({ launchBrowser: jest.fn(), serviceReportPublicBase: () => 'https://example.invalid' }));
const { launchBrowser } = require('../services/service-report/pdf-puppeteer');
const { renderEstimateDocumentPdf } = require('../services/pdf/estimate-doc-pdf');
const { renderStaffDocumentPdf } = require('../services/pdf/staff-document-pdf');
const detail = { version: { version_number: 1 }, rendered: { title: 'QA', sections: [], metadata: { citations: [], fields: [] } } };

afterEach(() => jest.resetAllMocks());
test('staff and estimate PDF launches share one bounded capacity and release failed launches', async () => {
  const rejectLaunches = [];
  launchBrowser.mockImplementation(() => new Promise((resolve, reject) => rejectLaunches.push(reject)));
  const pending = [renderEstimateDocumentPdf({ token: 'a'.repeat(64) }), renderStaffDocumentPdf(detail)].map(p => p.catch(e => e));
  await expect(renderStaffDocumentPdf(detail)).rejects.toMatchObject({ status: 503, code: 'estimate_doc_render_busy' });
  await expect(renderEstimateDocumentPdf({ token: 'a'.repeat(64) })).rejects.toMatchObject({ code: 'estimate_doc_render_busy' });
  expect(launchBrowser).toHaveBeenCalledTimes(2);
  rejectLaunches.forEach(reject => reject(new Error('QA launch failed')));
  await Promise.all(pending);
  launchBrowser.mockRejectedValue(new Error('QA next launch reached'));
  await expect(renderStaffDocumentPdf(detail)).rejects.toThrow('QA next launch reached');
});
test('a page failure closes its browser and releases capacity for the next export', async () => {
  const close = jest.fn().mockResolvedValue();
  launchBrowser.mockResolvedValue({ newPage: jest.fn().mockRejectedValue(new Error('QA page failure')), close });
  for (let i = 0; i < 3; i++) await expect(renderStaffDocumentPdf(detail)).rejects.toThrow('QA page failure');
  expect(close).toHaveBeenCalledTimes(3);
});
