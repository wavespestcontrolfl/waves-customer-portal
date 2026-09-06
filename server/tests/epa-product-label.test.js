const { PDFDocument } = require('pdf-lib');
const { findEpaLabel, selectEpaSource, downloadEpaLabel, currentEpaSourceStatus } = require('../services/epa-product-label');
const row = () => ({ eparegno: '123-456', productname: 'Synthetic product', product_status: 'Active', cancel_flag: 'No', pdffiles: [
  { epa_reg_num: '123-456', pdffile: '000123-00456-20250101.pdf' },
  { epa_reg_num: '123-456', pdffile: '000123-00456-20260101.pdf' },
  { epa_reg_num: '987-654', pdffile: '000987-00654-20270101.pdf' },
] });
afterEach(() => jest.restoreAllMocks());
test('selects latest exact-registration PDF and never persists company contacts', () => {
  const entry = row(); entry.companyinfo = [{ contact_person: 'Synthetic contact' }];
  const source = selectEpaSource({ items: [entry] }, '123-456');
  expect(source.filename).toBe('000123-00456-20260101.pdf');
  expect(JSON.stringify(source)).not.toContain('contact_person');
});
test.each(['../123-456', 'https://example.invalid', '123-456-789', 'N/A', '00123-456'])('rejects unsupported registration %s before fetch', async registration => {
  const fetchMock = jest.spyOn(global, 'fetch');
  await expect(findEpaLabel(registration)).rejects.toMatchObject({ statusCode: 422 });
  expect(fetchMock).not.toHaveBeenCalled();
});
test('rejects cancelled, duplicate, and mismatched registrations', () => {
  expect(() => selectEpaSource({ items: [{ ...row(), cancel_flag: 'Yes' }] }, '123-456')).toThrow();
  expect(() => selectEpaSource({ items: [row(), row()] }, '123-456')).toThrow();
  expect(() => selectEpaSource({ items: [row()] }, '123-457')).toThrow();
});
test('cannot follow a response-provided arbitrary PDF URL', async () => {
  const fetchMock = jest.spyOn(global, 'fetch');
  await expect(downloadEpaLabel({ filename: '000123-00456-20260101.pdf', url: 'https://example.invalid/private' })).rejects.toThrow('Invalid EPA document');
  expect(fetchMock).not.toHaveBeenCalled();
});
test('downloads a bounded actual PDF, checks pages and hashes bytes', async () => {
  const pdf = await PDFDocument.create(); pdf.addPage(); const bytes = Buffer.from(await pdf.save());
  const source = selectEpaSource({ items: [row()] }, '123-456');
  const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(new Response(bytes));
  const result = await downloadEpaLabel(source);
  expect(result.pageCount).toBe(1); expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(fetchMock.mock.calls[0][1].redirect).toBe('error');
});
test('rejects HTML and oversized PDFs', async () => {
  const source = selectEpaSource({ items: [row()] }, '123-456');
  const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(new Response('<html>not a label</html>'));
  await expect(downloadEpaLabel(source)).rejects.toThrow('did not return a PDF');
  fetchMock.mockResolvedValue(new Response('%PDF-test', { headers: { 'content-length': String(9 * 1024 * 1024) } }));
  await expect(downloadEpaLabel(source)).rejects.toThrow('exceeds the supported size');
});

test.each([new TypeError('network unavailable'), new DOMException('request timed out', 'TimeoutError')])('EPA request failure stays operational and retryable (%s)', async failure => {
  jest.spyOn(global, 'fetch').mockRejectedValue(failure);
  await expect(findEpaLabel('123-456')).rejects.toMatchObject({ statusCode: 502, isOperational: true, message: 'EPA source is unavailable. Try again later.' });
});

test('EPA body-stream failure stays operational and retryable', async () => {
  const stream = new ReadableStream({ start(controller) { controller.error(new TypeError('stream disconnected')); } });
  jest.spyOn(global, 'fetch').mockResolvedValue(new Response(stream));
  await expect(findEpaLabel('123-456')).rejects.toMatchObject({ statusCode: 502, isOperational: true });
});

test.each(['<html>upstream error</html>', '{"items":', '{"items":{}}'])('malformed EPA payload is operational (%s)', async payload => {
  jest.spyOn(global, 'fetch').mockResolvedValue(new Response(payload));
  await expect(findEpaLabel('123-456')).rejects.toMatchObject({ statusCode: 502, isOperational: true });
});

test('a malformed PDF is a document-review error', async () => {
  jest.spyOn(global, 'fetch').mockResolvedValue(new Response('%PDF-1.7\ninvalid document'));
  await expect(downloadEpaLabel(selectEpaSource({ items: [row()] }, '123-456'))).rejects.toMatchObject({ statusCode: 422, isOperational: true });
});

test('a successful forced source check replaces cached unavailability immediately', async () => {
  const pdf = await PDFDocument.create(); pdf.setTitle('Synthetic cache refresh fixture'); pdf.addPage(); const bytes = Buffer.from(await pdf.save());
  const source = { ...selectEpaSource({ items: [row()] }, '123-456'), sha256: require('crypto').createHash('sha256').update(bytes).digest('hex') };
  jest.spyOn(Date, 'now').mockReturnValue(4000000);
  const fetched = jest.spyOn(global, 'fetch').mockRejectedValue(new TypeError('network unavailable'));
  expect(await currentEpaSourceStatus(source)).toBe('unavailable');
  fetched.mockImplementation(async url => new Response(url.includes('/ords/') ? JSON.stringify({ items: [row()] }) : bytes));
  expect(await currentEpaSourceStatus(source, { refresh: true })).toBe('current');
  expect(await currentEpaSourceStatus(source)).toBe('current');
  expect(fetched).toHaveBeenCalledTimes(3);
});

test('source checks coalesce, then invalidate a superseded label after at most 60 seconds', async () => {
  const pdf = await PDFDocument.create(); pdf.addPage(); const bytes = Buffer.from(await pdf.save());
  const source = { ...selectEpaSource({ items: [row()] }, '123-456'), sha256: require('crypto').createHash('sha256').update(bytes).digest('hex') };
  let latest = row();
  const clock = jest.spyOn(Date, 'now').mockReturnValue(2000000);
  const fetched = jest.spyOn(global, 'fetch').mockImplementation(async url => new Response(url.includes('/ords/') ? JSON.stringify({ items: [latest] }) : bytes));
  expect(await Promise.all([currentEpaSourceStatus(source), currentEpaSourceStatus(source)])).toEqual(['current', 'current']);
  expect(fetched).toHaveBeenCalledTimes(2);
  latest = { ...row(), pdffiles: [{ epa_reg_num: '123-456', pdffile: '000123-00456-20260202.pdf' }] };
  clock.mockReturnValue(2060001);
  expect(await currentEpaSourceStatus(source)).toBe('superseded');
  expect(fetched).toHaveBeenCalledTimes(3);
});

test('a changed PDF checksum and an unavailable EPA lookup never count as current', async () => {
  const pdf = await PDFDocument.create(); pdf.addPage(); const bytes = Buffer.from(await pdf.save());
  const source = { ...selectEpaSource({ items: [row()] }, '123-456'), sha256: 'older-pdf-bytes' };
  const clock = jest.spyOn(Date, 'now').mockReturnValue(3000000);
  const fetched = jest.spyOn(global, 'fetch').mockImplementation(async url => new Response(url.includes('/ords/') ? JSON.stringify({ items: [row()] }) : bytes));
  expect(await currentEpaSourceStatus(source)).toBe('superseded');
  clock.mockReturnValue(3060001); fetched.mockRejectedValue(new Error('EPA unavailable'));
  expect(await currentEpaSourceStatus(source)).toBe('unavailable');
});
