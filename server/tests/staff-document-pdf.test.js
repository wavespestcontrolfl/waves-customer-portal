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

test.each(['2027-01-15T14:00:00Z', '2027-07-15T13:00:00Z'])('evidence timestamps use 9 AM Eastern in winter and summer: %s', async instant => {
  const page = { route: jest.fn(), setContent: jest.fn(), pdf: jest.fn().mockResolvedValue(Buffer.from('pdf')) };
  launchBrowser.mockResolvedValue({ newPage: jest.fn().mockResolvedValue(page), close: jest.fn() });
  const issued = { ...detail, version: { version_number: 1, content_hash: 'issued', effective_at: instant } };
  await renderStaffDocumentPdf(issued, {
    acknowledgment: { signed_name: 'QA Staff', statement: 'QA acknowledgment', acknowledged_at: instant, technician_id: 'tech', id: 'ack' },
    record: { id: 'record', owner_id: 'tech', due_at: instant, completed_at: instant, completed_steps: [], answers: {} },
  });
  const html = page.setContent.mock.calls[0][0];
  expect(html.match(/at 9:00 AM Eastern/g)).toHaveLength(4);
  expect(html).not.toContain(instant);
});
test.each(['form', 'procedure'])('%s PDF renders only the matching record evidence', async kind => {
  const page = { route: jest.fn(), setContent: jest.fn(), pdf: jest.fn().mockResolvedValue(Buffer.from('pdf')) };
  launchBrowser.mockResolvedValue({ newPage: jest.fn().mockResolvedValue(page), close: jest.fn() });
  const recordDetail = { ...detail, rendered: { ...detail.rendered, kind, sections: [{ id: 'scope', number: 1, title: 'Scope', html: '<p>QA</p>' }] } };
  await renderStaffDocumentPdf(recordDetail, { record: { id: 'record', owner_id: 'tech', due_at: '2027-01-15T14:00:00Z', completed_at: '2027-01-15T15:00:00Z', completed_steps: ['scope'], answers: {} } });
  const html = page.setContent.mock.calls[0][0];
  expect(html).toContain('Completed record');
  expect(html.includes('[x] 1. Scope')).toBe(kind === 'procedure');
  expect(html).not.toContain('[ ]');
});
