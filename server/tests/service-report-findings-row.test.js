// The service report email's "Findings" row appears only when a finding was
// logged. Nothing logged = the row is hidden entirely (owner ruling
// 2026-09-29), in the template-library email and the legacy fallback alike.
jest.mock('../models/db', () => {
  const mock = jest.fn();
  mock.raw = (sql) => ({ toString: () => sql });
  return mock;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { renderTemplate } = require('../services/email-template-library');
const {
  serviceReportTemplatePayload,
  buildServiceReportV1Email,
} = require('../services/service-report/email-delivery');

// The seeded service.report_ready details block (the row under test).
const TEMPLATE = {
  template_key: 'service.report_ready',
  name: 'Service report ready',
  mode: 'service',
  required_variables: ['first_name', 'report_url', 'service_label'],
  allowed_variables: [
    'first_name', 'report_url', 'service_label', 'service_date', 'technician_name',
    'property_address', 'finding_summary', 'application_summary', 'reentry_summary',
    'pressure_summary', 'pdf_note',
  ],
  optional_variables: [],
};
const VERSION = {
  subject: 'Your Waves {{service_label}} report is ready',
  preview_text: 'Your report is ready.',
  text_body: null,
  blocks: [
    { type: 'paragraph', content: 'Hi {{first_name}}, your {{service_label}} report is ready.' },
    {
      type: 'details',
      rows: [
        { label: 'Service', value: '{{service_label}}' },
        { label: 'Property', value: '{{property_address}}' },
        { label: 'Findings', value: '{{finding_summary}}' },
        { label: 'Applications', value: '{{application_summary}}' },
      ],
    },
    { type: 'cta', label: 'View full report', url_variable: 'report_url' },
  ],
};

function payloadFor(findings) {
  return serviceReportTemplatePayload({
    recipient: { name: 'Sam Example' },
    data: { customerName: 'Sam Example', findings, applications: [], advisory: {}, metrics: [] },
    reportUrl: 'https://portal.wavespestcontrol.com/report/token-1',
    serviceLabel: 'Residential Pest Control',
    pdf: null,
  });
}

function render(findings) {
  return renderTemplate({ template: TEMPLATE, version: VERSION, payload: payloadFor(findings) });
}

describe('service report email Findings row', () => {
  test('nothing logged: payload value is blank and the row is hidden', () => {
    expect(payloadFor([]).finding_summary).toBe('');
    const out = render([]);
    expect(out.html).not.toContain('Findings');
    expect(out.text).not.toContain('Findings');
    expect(out.text).not.toMatch(/No action-required/);
    // The neighbouring rows still render.
    expect(out.text).toContain('Applications: 0 applications');
  });

  test('a no_activity-only finding counts as nothing logged', () => {
    const findings = [{ category: 'no_activity', severity: 'info', title: 'No activity observed' }];
    expect(payloadFor(findings).finding_summary).toBe('');
    expect(render(findings).text).not.toContain('Findings');
  });

  test('a logged finding still shows the row', () => {
    const findings = [{ category: 'activity', severity: 'medium', title: 'Ant trail at the lanai' }];
    expect(payloadFor(findings).finding_summary).toBe('1 finding documented for review');
    const out = render(findings);
    expect(out.text).toContain('Findings: 1 finding documented for review');
    expect(out.html).toContain('Findings');
  });

  test('legacy fallback email hides the row when nothing was logged, shows it otherwise', () => {
    const base = { customerName: 'Sam Example', serviceType: 'Residential Pest Control', applications: [], advisory: {}, metrics: [] };
    const none = buildServiceReportV1Email({ reportUrl: 'https://example.test/r', data: { ...base, findings: [] } });
    expect(none.text).not.toMatch(/^Findings:/m);
    expect(none.html).not.toContain('>Findings<');
    const some = buildServiceReportV1Email({
      reportUrl: 'https://example.test/r',
      data: { ...base, findings: [{ category: 'activity', severity: 'medium', title: 'Ant trail' }] },
    });
    expect(some.text).toContain('Findings: 1 finding');
    expect(some.html).toContain('>Findings<');
  });
});
