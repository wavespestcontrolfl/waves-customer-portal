// Owner 2026-11-24 email wording, part 1 (migration 20261124170200): changes 2
// and 3 + the assessment link label, and the report payload's visit_done_line
// that change 1 (a later migration) will read. The fixture is the live active version of each
// template as read from production on 2026-11-23 (no customer data: template
// blocks only), so the anchors are proven against what will really run.
jest.mock('../models/db', () => {
  const mock = jest.fn();
  mock.raw = (sql) => ({ toString: () => sql });
  return mock;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const LIVE = require('./fixtures/email-wording-three-changes-live.json');
const { _private: M } = require('../models/migrations/20261124170200_email_wording_followup_lawn_assessment');
const { renderTemplate } = require('../services/email-template-library');
const { visitDoneLine, serviceReportTemplatePayload } = require('../services/service-report/email-delivery');

const plan = (key) => M.PLANS.find((p) => p.key === key);
const next = (key) => M.planVersion(plan(key), LIVE[key]);

function render(key, version, payload) {
  return renderTemplate({
    template: { template_key: key, allowed_variables: [], purpose: 'transactional' },
    version: { ...version, blocks: version.blocks },
    payload,
  });
}

describe('visit_done_line', () => {
  test('tech, service and date', () => {
    expect(visitDoneLine({ technicianName: 'Jose', serviceLabel: 'Quarterly Pest Control Service', serviceDate: 'Tuesday, December 2' }))
      .toBe('Jose finished your Quarterly Pest Control Service on Tuesday, December 2.');
  });
  test('no tech name and no date still read as one sentence', () => {
    expect(visitDoneLine({ technicianName: '', serviceLabel: 'Lawn Care', serviceDate: '' })).toBe('We finished your Lawn Care.');
    expect(visitDoneLine({})).toBe('We finished your visit.');
  });
  test('the report payload carries it', () => {
    const p = serviceReportTemplatePayload({
      recipient: { name: 'Sample Example' },
      data: { serviceType: 'Pest', applications: [], advisory: {}, metrics: [], findings: [], technicianName: 'Jose', serviceDate: '2026-12-02' },
      reportUrl: 'https://example.test/r',
      serviceLabel: 'Quarterly Pest Control Service',
    });
    expect(p.visit_done_line).toMatch(/^Jose finished your Quarterly Pest Control Service on .+\.$/);
  });
});

describe('change 2: estimate.engage_gone_quiet', () => {
  const v = next('estimate.engage_gone_quiet');
  test('renders the new subject and the assessment link', () => {
    const out = render('estimate.engage_gone_quiet', v, {
      first_name: 'Jane', service_label: 'Quarterly Pest Control Service', estimate_url: 'https://example.test/e',
      consultation_url: 'https://example.test/c', category_question: 'Seeing ants inside?',
    });
    expect(out.subject).toBe('One question about your Waves estimate');
    expect(out.html).toContain('Book a Waves Assessment');
    expect(out.html).not.toContain('free consultation');
  });
  test('the button group moves directly after the question', () => {
    expect(v.outcome).toBe('changed');
    expect(v.subject).toBe('One question about your Waves estimate');
    const q = v.blocks.findIndex((b) => b.content === '{{category_question}}');
    expect(v.blocks[q + 1]).toMatchObject({ type: 'cta', url_variable: 'estimate_url', label: 'Take another look' });
    expect(v.blocks[q + 2].content).toBe('{{estimate_pdf_note}}');
    expect(v.blocks[q + 3]).toMatchObject({ url_variable: 'consultation_url', variant: 'link', label: M.NEW_CONSULT });
    expect(v.blocks[q + 4].content).toBe('Went another way? Tell us that too. No hard feelings.');
  });
  test('an edited PDF note under the button leaves the template whole', () => {
    const live = LIVE['estimate.engage_gone_quiet'];
    const blocks = live.blocks.map((x) => (x.content === '{{estimate_pdf_note}}' ? { ...x, content: 'Edited note' } : x));
    expect(M.planVersion(plan('estimate.engage_gone_quiet'), { ...live, blocks }).outcome).toBe('skipped');
  });
  test('nothing else is lost or reordered', () => {
    const before = LIVE['estimate.engage_gone_quiet'].blocks;
    expect(v.blocks).toHaveLength(before.length + 1);
    const kept = (list) => list.filter((b) => !['estimate_url', 'consultation_url'].includes(b.url_variable) && b.content !== '{{estimate_pdf_note}}' && !/No hard feelings/.test(b.content || ''));
    expect(kept(v.blocks)).toEqual(kept(before));
    expect(JSON.stringify(v.blocks)).not.toMatch(/free consultation/);
  });
});

describe.each([
  ['irrigation.weekly_setup_schedule', /^We can tell you each week to water more, less, or the same\.$/, 1],
  ['irrigation.weekly_setup_system', /head type \(spray or rotor\).+weekly inches if you know them\.$/, 0],
])('change 3: %s', (key, askRe, requestBlocks) => {
  const v = next(key);
  test('ask, button and reply line follow the rain sentence; the old button goes', () => {
    expect(v.outcome).toBe('changed');
    expect(v.subject).toBe('Does your lawn need more water this week, {{first_name}}?');
    const rain = v.blocks.findIndex((b) => String(b.content || '').startsWith('{{rain_sentence}}'));
    expect(v.blocks[rain + 1].content).toMatch(askRe);
    if (requestBlocks) expect(v.blocks[rain + 2]).toMatchObject({ type: 'callout', content: '{{schedule_ask}}' });
    expect(v.blocks[rain + 2 + requestBlocks]).toMatchObject({ type: 'cta', url_variable: 'customer_portal_url', label: 'Update my watering details' });
    expect(v.blocks[rain + 3 + requestBlocks].content).toMatch(/\? Reply and tell us|^Easier by email\? Reply/);
    expect(v.blocks.filter((b) => b.url_variable === 'customer_portal_url')).toHaveLength(1);
    expect(JSON.stringify(v.blocks)).not.toContain('ADD MY WATERING SCHEDULE');
  });
});

test.each([
  ['estimate.engage_gone_quiet', (b) => b.url_variable === 'estimate_url', (b) => ({ ...b, label: 'See my estimate' })],
  ['irrigation.weekly_setup_schedule', (b) => String(b.content || '').startsWith('{{rain_sentence}}'), (b) => ({ ...b, content: '{{rain_sentence}} Edited.' })],
  ['irrigation.weekly_setup_system', (b) => b.url_variable === 'customer_portal_url', (b) => ({ ...b, label: 'Add my schedule' })],
])('%s: an edited anchor block leaves the template whole', (key, match, edit) => {
  const live = LIVE[key];
  const blocks = live.blocks.map((x) => (match(x) ? edit(x) : x));
  expect(M.planVersion(plan(key), { ...live, blocks }).outcome).toBe('skipped');
});

test('setup_system drops its fixed callout; setup_schedule keeps {{schedule_ask}} once', () => {
  expect(JSON.stringify(next('irrigation.weekly_setup_system').blocks)).not.toContain("We don't have your watering amount yet");
  const schedule = next('irrigation.weekly_setup_schedule').blocks;
  expect(schedule.filter((b) => b.content === '{{schedule_ask}}')).toHaveLength(1);
});

test('nurture.expired_1 draft: only the consultation label changes', () => {
  const before = LIVE['nurture.expired_1'].blocks;
  const r = M.relabelConsult(before);
  expect(r.changed).toBe(true);
  expect(r.blocks.find((b) => b.url_variable === 'consultation_url').label).toBe(M.NEW_CONSULT);
  expect(r.blocks.filter((b) => b.url_variable !== 'consultation_url')).toEqual(before.filter((b) => b.url_variable !== 'consultation_url'));
  expect(M.relabelConsult(r.blocks).changed).toBe(false);
});
