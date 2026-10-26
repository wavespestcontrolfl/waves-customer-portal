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
  const fields = kind === 'form' ? [{ id: 'notes', label: 'Evidence notes', type: 'textarea', required: true }] : [];
  const recordDetail = { ...detail, rendered: { ...detail.rendered, kind, sections: [{ id: 'scope', number: 1, title: 'Scope', html: '<p>QA</p>' }], metadata: { ...detail.rendered.metadata, fields } } };
  await renderStaffDocumentPdf(recordDetail, { record: { id: 'record', owner_id: 'tech', content_hash: 'r'.repeat(64), due_at: '2027-01-15T14:00:00Z', completed_at: '2027-01-15T15:00:00Z', completed_steps: ['scope'], answers: { notes: 'Line one\nLine two' } } });
  const html = page.setContent.mock.calls[0][0];
  expect(html).toContain('Completed record');
  expect(html.includes('[x] 1. Scope')).toBe(kind === 'procedure');
  expect(html).not.toContain('[ ]');
  expect(html).toContain('r'.repeat(64));
  expect(html.includes('Line one\nLine two')).toBe(kind === 'form');
});

test('long controlled wording keeps complete clauses, citations, signature evidence, and repeated page chrome', async () => {
  const abort = jest.fn();
  const page = { route: jest.fn(), setContent: jest.fn(), pdf: jest.fn().mockResolvedValue(Buffer.from('pdf')) };
  launchBrowser.mockResolvedValue({ newPage: jest.fn().mockResolvedValue(page), close: jest.fn() });
  const longCopy = `<p>FIRST-LONG-PARAGRAPH ${'word '.repeat(1400)} LAST-LONG-PARAGRAPH</p>`;
  const contentHash = 'a'.repeat(64);
  const acknowledgmentHash = 'b'.repeat(64);
  const policy = {
    document: { staff_kind: 'policy', template_key: 'staff.qa-policy' },
    version: { version_number: 12, content_hash: contentHash, effective_at: '2027-01-15T14:00:00Z' },
    rendered: {
      title: 'QA controlled policy', kind: 'policy',
      sections: [{ id: 'scope', number: 1, title: 'Scope & authority', html: longCopy }],
      metadata: {
        owner_role: 'Operations Lead', review_on: '2027-06-30', fields: [],
        citations: [{ anchor: 'scope', label: 'Florida reference', url: 'https://example.com/rules?q=staff', verified_on: '2027-01-02', review_on: '2027-03-31' }],
      },
    },
  };
  await renderStaffDocumentPdf(policy, { acknowledgment: {
    id: 'ack-id', technician_id: 'staff-id', content_hash: acknowledgmentHash,
    statement: 'I acknowledge this exact policy.', signed_name: 'QA Staff', acknowledged_at: '2027-01-15T15:00:00Z',
  } });

  expect(page.route).toHaveBeenCalledWith('**/*', expect.any(Function));
  page.route.mock.calls[0][1]({ abort });
  expect(abort).toHaveBeenCalledTimes(1);
  const html = page.setContent.mock.calls[0][0];
  expect(html).toContain('FIRST-LONG-PARAGRAPH');
  expect(html).toContain('LAST-LONG-PARAGRAPH');
  expect(html).toContain('https://example.com/rules?q=staff');
  expect(html).toContain('verified 2027-01-02 · review 2027-03-31');
  expect(html).toContain('I acknowledge this exact policy.');
  expect(html).toContain('QA Staff');
  expect(html).toContain('staff-id');
  expect(html).toContain('ack-id');
  expect(html).toContain(acknowledgmentHash);
  expect(html).toContain(contentHash);
  const options = page.pdf.mock.calls[0][0];
  expect(options).toMatchObject({ format: 'Letter', printBackground: true, displayHeaderFooter: true });
  expect(options.headerTemplate).toContain('Controlled staff document · QA controlled policy');
  expect(options.headerTemplate).not.toContain('continued');
  expect(options.footerTemplate).toContain(`SHA-256: ${contentHash}`);
  expect(options.footerTemplate).toContain('class="pageNumber"');
  expect(options.footerTemplate).toContain('class="totalPages"');
});
