/**
 * The "Your Multi-Home Discount is on" template (migration 20261105040000): the copy the owner saw, the fixed home
 * slots, the validation, and what the renderer does with a blank cell. No database. Synthetic values only.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/sendgrid-mail', () => ({
  newsletterGroupId: jest.fn(() => 101),
  serviceGroupId: jest.fn(() => 202),
}));

const EmailTemplates = require('../services/email-template-library');
const migration = require('../models/migrations/20261105040000_multi_home_discount_email_template');

const P = migration._private;

function render(payload) {
  const blocks = P.buildBlocks();
  const template = {
    id: 'tmpl-1',
    template_key: P.TEMPLATE_KEY,
    name: 'Multi-Home Discount Is On',
    mode: 'service',
    send_stream: 'transactional_required',
    allowed_variables: P.allVariables(),
    required_variables: P.REQUIRED,
  };
  const version = { id: 'ver-1', subject: P.SUBJECT, preview_text: 'preview', blocks, text_body: '' };
  return EmailTemplates.renderTemplate({ template, version, payload });
}

describe('customer.multi_home_discount_on template', () => {
  test('every variable the blocks use is allowed, and the required ones are really used', () => {
    const validation = EmailTemplates.validationFor(
      { allowed_variables: P.allVariables(), required_variables: P.REQUIRED },
      { subject: P.SUBJECT, preview_text: 'preview', blocks: P.buildBlocks(), text_body: null },
    );
    expect(validation).toMatchObject({ ok: true, disallowed_variables: [], missing_required_in_template: [] });
  });

  test('carries one slot per home, up to the maximum the sender fills', () => {
    const vars = P.allVariables();
    expect(vars).toHaveLength(2 + P.MAX_HOMES * P.HOME_FIELDS.length);
    for (let i = 1; i <= P.MAX_HOMES; i += 1) {
      for (const field of P.HOME_FIELDS) expect(vars).toContain(`home_${i}_${field}`);
    }
  });

  test('renders the owner-approved draft copy around the home blocks', () => {
    const out = render(P.fixturePayload(P.FIXTURE_HOMES));
    expect(out.subject).toBe('Your Multi-Home Discount is on');
    expect(out.missingPayload).toEqual([]);
    expect(out.text).toContain('YOUR MULTI-HOME DISCOUNT IS ON');
    expect(out.text).toContain('Hi Taylor,');
    expect(out.text).toContain('Thanks for trusting Waves with more than one home. From the next visit at each home, every visit is 10% off.');
    expect(out.text).toContain('Your schedule does not change. Each visit is billed after it is done.');
    expect(out.text).toContain('Questions? Reply to this email or call (941) 297-5749. A real person answers.');
    expect(out.text).toContain('We look forward to servicing your homes. — The Waves Team');
    // The exact service name, never "pest control" on its own.
    expect(out.text).toContain('Service: Quarterly Pest Control Service');
    expect(out.text).toContain('Regular: $117.00');
    expect(out.text).toContain('Multi-Home 10%: -$11.70');
    expect(out.text).toContain('Per application: $105.30');
    expect(out.text).toContain('Starts: Sat, Nov 14');
    expect(out.text).toContain('How it is paid: Auto Pay card on file');
    expect(out.text).toContain('How it is paid: Invoice to you by email');
    expect(out.text).toContain('How it is paid: Invoice after each visit');
    expect(out.html).toContain('123 Example Street');
    expect(out.html).toContain('78 Test Lane');
  });

  test('a home with no address, and a cell with no value, render nothing', () => {
    const out = render(P.fixturePayload([{ ...P.FIXTURE_HOMES[0], regular: '', discount: '' }]));
    expect(out.text).toContain('Per application: $105.30');
    expect(out.text).not.toContain('Regular:');
    expect(out.text).not.toContain('Multi-Home 10%:');
    expect(out.text).not.toContain('45 SAMPLE COURT');
    expect((out.text.match(/Per application:/g) || [])).toHaveLength(1);
  });

  test('refuses to render without an address for the first home', () => {
    const out = render({ greeting_name: 'Taylor', company_phone: '(941) 297-5749' });
    expect(out.missingPayload).toContain('home_1_address');
  });

  test('both preview fixtures validate against the template and the default one shows every row', () => {
    const three = P.fixturePayload(P.FIXTURE_HOMES);
    const keys = new Set(P.allVariables());
    for (const key of Object.keys(three)) expect(keys.has(key)).toBe(true);
    for (const home of P.FIXTURE_HOMES) for (const value of Object.values(home)) expect(value).not.toBe('');
  });
});
