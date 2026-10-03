// Service reports greet by the customer's own first name. The call booker
// (GATE_CALL_FIRST_NAME_ADVISORY) creates customers with a blank first_name
// and a populated last_name, so the composed customerName is just the
// surname and its first token read "Hi <Surname>". report-data now carries
// customerFirstName (null when blank); every greeting site prefers it.
// Follow-up to #5559 / #5612 (estimates).
const fs = require('fs');
const path = require('path');

jest.mock('../models/db', () => {
  const mock = jest.fn();
  mock.raw = (sql) => ({ toString: () => sql });
  return mock;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { reportGreetingFirstToken } = require('../utils/greeting-first-name');
const {
  buildServiceReportV1Email,
  serviceReportTemplatePayload,
  legacyRecipientData,
} = require('../services/service-report/email-delivery');

const read = (rel) => fs.readFileSync(path.join(__dirname, rel), 'utf8');
const BASE = { serviceType: 'Residential Pest Control', applications: [], advisory: {}, metrics: [], findings: [] };

describe('reportGreetingFirstToken', () => {
  test('customerFirstName present: it wins over the composed name', () => {
    expect(reportGreetingFirstToken({ customerName: 'Sample Example', customerFirstName: 'Sample' })).toBe('Sample');
  });

  test('customerFirstName null (blank first name): empty, never the surname', () => {
    expect(reportGreetingFirstToken({ customerName: 'Example', customerFirstName: null })).toBe('');
    expect(reportGreetingFirstToken({ customerName: 'Example', customerFirstName: '  ' })).toBe('');
  });

  test('legacy payload without the key: first token of customerName', () => {
    expect(reportGreetingFirstToken({ customerName: 'Sample Example' })).toBe('Sample');
    expect(reportGreetingFirstToken({})).toBe('');
    expect(reportGreetingFirstToken(null)).toBe('');
  });

  test('legacy payload with a customer row in hand: blank first_name is not the surname', () => {
    expect(reportGreetingFirstToken(
      { customerName: 'Example' },
      { first_name: '', last_name: 'Example' },
    )).toBe('');
    expect(reportGreetingFirstToken(
      { customerName: 'Sample Example' },
      { first_name: 'Sample', last_name: 'Example' },
    )).toBe('Sample');
    // A row without first_name selected is not evidence of a blank name.
    expect(reportGreetingFirstToken({ customerName: 'Sample Example' }, { last_name: 'Example' })).toBe('Sample');
  });
});

describe('buildServiceReportV1Email greeting', () => {
  const build = (data) => buildServiceReportV1Email({ reportUrl: 'https://example.test/r', data: { ...BASE, ...data } });

  test('blank-first-name customer greets "there", not the surname', () => {
    const out = build({ customerName: 'Example', customerFirstName: null });
    expect(out.html).toContain('Hi there,');
    expect(out.text).toContain('Hi there,');
    expect(out.html).not.toContain('Hi Example');
    expect(out.text).not.toContain('Hi Example');
  });

  test('customer with a first name greets by it', () => {
    const out = build({ customerName: 'Sample Example', customerFirstName: 'Sample' });
    expect(out.html).toContain('Hi Sample,');
    expect(out.text).toContain('Hi Sample,');
  });

  test('legacy payload without customerFirstName keeps the first token', () => {
    const out = build({ customerName: 'Sample Example' });
    expect(out.html).toContain('Hi Sample,');
  });

  test('no name at all greets "there"', () => {
    expect(build({}).text).toContain('Hi there,');
  });
});

describe('recipient override keeps the recipient\'s own first token', () => {
  const customerData = { ...BASE, customerName: 'Example', customerFirstName: null };

  test('a named recipient (service/billing contact) is greeted by its first token', () => {
    const data = legacyRecipientData(customerData, { name: 'Sample Contact' }, 'https://example.test/p.pdf');
    expect(data.customerName).toBe('Sample Contact');
    expect('customerFirstName' in data).toBe(false);
    expect(buildServiceReportV1Email({ reportUrl: 'https://example.test/r', data }).text).toContain('Hi Sample,');
  });

  test('an unnamed recipient keeps the customer\'s blank-first-name greeting', () => {
    const data = legacyRecipientData(customerData, { name: '' }, 'https://example.test/p.pdf');
    expect(data.pdfUrl).toBe('https://example.test/p.pdf');
    expect(buildServiceReportV1Email({ reportUrl: 'https://example.test/r', data }).text).toContain('Hi there,');
  });

  test('the template payload applies the same rules', () => {
    const payload = (recipient, data) => serviceReportTemplatePayload({
      recipient, data, reportUrl: 'https://example.test/r', serviceLabel: 'Pest Control',
    });
    expect(payload({ name: '' }, customerData).first_name).toBe('there');
    expect(payload({ name: 'Sample Contact' }, customerData).first_name).toBe('Sample');
    expect(payload({ name: '' }, { ...BASE, customerName: 'Sample Example', customerFirstName: 'Sample' }).first_name).toBe('Sample');
    expect(payload({ name: '' }, { ...BASE, customerName: 'Sample Example' }).first_name).toBe('Sample');
  });
});

describe('source pins', () => {
  test('report-data carries customerFirstName beside the unchanged customerName', () => {
    const src = read('../services/service-report/report-data.js');
    expect(src).toContain("customerName: `${service.first_name || ''} ${service.last_name || ''}`.trim(),");
    expect(src).toContain("customerFirstName: String(service.first_name || '').trim() || null,");
  });

  test('recap payload greets through the shared helper', () => {
    const src = read('../services/service-report/recap-payload.js');
    expect(src).toContain('reportGreetingFirstToken(data, service)');
    expect(src).not.toMatch(/customerName[^;\n]*\.split\([^)]*\)\[0\]/);
  });

  test('email delivery no longer splits the composed customer name', () => {
    const src = read('../services/service-report/email-delivery.js');
    expect(src).not.toMatch(/customerName[^;\n]*\.split\([^)]*\)\[0\]/);
    expect(src).not.toContain('recipient.name || data?.customerName');
  });

  test('public report payloads (project + legacy) carry customerFirstName', () => {
    const src = read('../routes/reports-public.js');
    expect(src).toContain("customerFirstName: String(project.first_name || '').trim() || null,");
    expect(src).toContain("customerFirstName: String(service.first_name || '').trim() || null,");
  });
});
