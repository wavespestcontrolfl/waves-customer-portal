// Owner 2026-11-24 email wording change 1 (migration 20261124180000): the
// service report email reads {{visit_done_line}}, which part 1 (#8478) added to
// the payload. The fixture is the live active version read from production on
// 2026-11-23 (template blocks only, no customer data).
jest.mock('../models/db', () => {
  const mock = jest.fn();
  mock.raw = (sql) => ({ toString: () => sql });
  return mock;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const LIVE = require('./fixtures/email-wording-three-changes-live.json')['service.report_ready'];
const { _private: M } = require('../models/migrations/20261124180000_email_wording_report_email');
const { renderTemplate } = require('../services/email-template-library');
const { serviceReportTemplatePayload } = require('../services/service-report/email-delivery');

const v = M.planVersion(LIVE);

test('publishes the new subject, preview, opening and button', () => {
  expect(v.outcome).toBe('changed');
  expect(v.subject).toBe('Your {{service_label}} report: what we did and what we found');
  expect(v.preview_text).toBe('{{visit_done_line}} What we did, what we found, and any re-entry time.');
  expect(v.blocks[0].content).toBe('Hi {{first_name}}, {{visit_done_line}}');
  expect(JSON.stringify(v.blocks)).not.toMatch(/secure report includes/);
  expect(v.blocks.find((b) => b.url_variable === 'report_url').label).toBe('See my full report');
});

test('the reply line sits right after the guide link; every other block is kept in order', () => {
  const guide = v.blocks.findIndex((b) => b.url_variable === 'first_report_guide_url');
  expect(v.blocks[guide + 1]).toEqual({ type: 'paragraph', content: 'See something between visits? Reply here and tell us what you saw.' });
  const rest = (list) => list.filter((b) => !/report is ready|visit_done_line|secure report includes|Reply here/.test(b.content || '') && b.url_variable !== 'report_url');
  expect(rest(v.blocks)).toEqual(rest(LIVE.blocks));
});

test('renders whole with the real payload builder', () => {
  const payload = serviceReportTemplatePayload({
    recipient: { name: 'Maria Sample' },
    data: { serviceType: 'Pest', applications: [], advisory: {}, metrics: [], findings: [], technicianName: 'Jose', serviceDate: '2026-12-02' },
    reportUrl: 'https://example.test/r',
    serviceLabel: 'Quarterly Pest Control Service',
  });
  const out = renderTemplate({
    template: { template_key: 'service.report_ready', allowed_variables: [], purpose: 'transactional' },
    version: v,
    payload,
  });
  expect(out.subject).toBe('Your Quarterly Pest Control Service report: what we did and what we found');
  expect(out.previewText).toMatch(/^Jose finished your Quarterly Pest Control Service on .+\. What we did, what we found/);
  expect(out.html).toMatch(/Hi Maria, Jose finished your Quarterly Pest Control Service on /);
});

test.each([
  ['subject', { subject: 'Edited subject' }],
  ['preview', { preview_text: 'Edited preview' }],
  ['button', { blocks: LIVE.blocks.map((b) => (b.url_variable === 'report_url' ? { ...b, label: 'Open report' } : b)) }],
  ['opening', { blocks: LIVE.blocks.map((b, i) => (i === 0 ? { ...b, content: 'Hello {{first_name}}!' } : b)) }],
])('an edited %s leaves the template whole', (_, edit) => {
  expect(M.planVersion({ ...LIVE, ...edit }).outcome).toBe('skipped');
});

test('a second run is a no-op', () => {
  expect(M.planVersion({ ...LIVE, ...v }).outcome).toBe('already');
});

test('each preview fixture gets a line from its own visit details', () => {
  expect(M.fixtureLine({ technician_name: 'Jose', service_label: 'Lawn Care', service_date: 'Monday, March 2' }))
    .toBe('Jose finished your Lawn Care on Monday, March 2.');
  expect(M.fixtureLine({ service_label: 'Quarterly Pest Control Service' })).toBe('We finished your Quarterly Pest Control Service.');
});
