// Copy contract for the pre-service invoice SMS variant.
//
// The whole point of `invoice_sent_upfront` is that an invoice billed BEFORE its
// service has happened (the setup + first-application invoice auto-sent at
// estimate acceptance) must NOT use the generic "...completed on {service_date}"
// copy — which asserts a finished visit and prints a future date. These tests
// lock that guarantee against the seeded source-of-truth body so a future copy
// edit can't quietly reintroduce a completion claim or a date placeholder.
const {
  TEMPLATE,
} = require('../models/migrations/20260626000003_seed_invoice_sent_upfront_sms');

const mockUpfrontRow = {
  template_key: TEMPLATE.template_key,
  body: TEMPLATE.body,
  is_active: true,
};

jest.mock('../models/db', () => {
  const db = jest.fn(() => ({
    where: jest.fn(() => ({
      first: jest.fn(async () => mockUpfrontRow),
    })),
  }));
  db.schema = { hasTable: jest.fn(async () => true) };
  return db;
});
jest.mock('../services/audit-log', () => ({
  auditNotificationTemplateIssue: jest.fn(async () => null),
}));

const smsTemplates = require('../routes/admin-sms-templates');

const placeholdersIn = (body) =>
  Array.from(body.matchAll(/\{(\w+)\}/g), (m) => m[1]);

describe('invoice_sent_upfront copy contract', () => {
  beforeEach(() => jest.clearAllMocks());

  test('body makes no completion claim and carries no date placeholder', () => {
    expect(TEMPLATE.body).not.toMatch(/completed on/i);
    expect(TEMPLATE.body).not.toMatch(/\{service_date\}/);
    expect(TEMPLATE.body).not.toMatch(/\bcompleted\b/i);
  });

  test('declared variables exactly match the body placeholders', () => {
    const declared = JSON.parse(TEMPLATE.variables).sort();
    const used = Array.from(new Set(placeholdersIn(TEMPLATE.body))).sort();
    expect(used).toEqual(declared);
    // service_date is intentionally absent — that absence is the fix.
    expect(declared).not.toContain('service_date');
  });

  test('renders cleanly with the three supplied variables', async () => {
    const body = await smsTemplates.getTemplate('invoice_sent_upfront', {
      first_name: 'Sam',
      service_type: 'WaveGuard Membership Setup + First Application',
      pay_url: 'https://portal.wavespestcontrol.com/l/abc23',
    });

    expect(body).toContain('Sam');
    expect(body).toContain('https://portal.wavespestcontrol.com/l/abc23');
    expect(body).not.toMatch(/completed on/i);
    expect(body).not.toMatch(/\{\w+\}/); // no unresolved placeholders
  });

  test('returns null rather than leaking a placeholder when a var is missing', async () => {
    const body = await smsTemplates.getTemplate('invoice_sent_upfront', {
      first_name: 'Sam',
      pay_url: 'https://portal.wavespestcontrol.com/l/abc23',
    });
    expect(body).toBeNull();
  });
});
