/**
 * The Quick Links how-to guide emails (20261120200000 / 20261120200001 and
 * services/how-to-guide-sender.js). Guards:
 *  1. Every seeded howto.* template renders through the production renderer
 *     with the payload the sender fills, and the sender, the seed and the
 *     protected-template list agree on the keys.
 *  2. The sender refuses a customer with no email, reports a blocked address
 *     as not sent, and marks a post-dispatch throw as uncertain so the
 *     operator is not told to retry an email that may have gone out.
 *  3. The welcome email gains the notification steps once, after the sign-in
 *     help, and still gains them when staff reworded that paragraph.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/sendgrid-mail', () => ({ isConfigured: jest.fn(() => false), sendOne: jest.fn(), isDefiniteRejection: jest.fn(() => false) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/notification-service', () => ({}));

const db = require('../models/db');
const seed = require('../models/migrations/20261120200000_seed_how_to_guide_email_templates');
const welcome = require('../models/migrations/20261120200001_welcome_email_app_notifications');
const EmailTemplateLibrary = require('../services/email-template-library');
const { sendHowToGuideToCustomer, HOW_TO_GUIDES } = require('../services/how-to-guide-sender');

const { templateRow, PREVIEW_PAYLOAD, APP_PAGE } = seed.__private;

function render(t, payload = PREVIEW_PAYLOAD) {
  return EmailTemplateLibrary.renderTemplate({
    template: templateRow(t),
    version: { subject: t.subject, preview_text: t.preview, blocks: t.blocks },
    payload,
  });
}

describe('how-to guide email seed', () => {
  test('every template renders with its numbered steps and a button, with nothing missing', () => {
    expect(seed.TEMPLATES).toHaveLength(11);
    for (const t of seed.TEMPLATES) {
      const guide = seed.GUIDES.find((g) => `howto.${g.key}` === t.key);
      const out = render(t);
      expect(out.missingPayload).toEqual([]);
      expect(out.subject).toBe(guide.title);
      expect(out.text).toContain(`${guide.steps.length}. `);
      expect(out.html).toContain(guide.cta ? APP_PAGE : 'login?next=');
      expect(out.html).toContain(PREVIEW_PAYLOAD.company_phone);
      expect(EmailTemplateLibrary.validationFor(templateRow(t), { subject: t.subject, preview_text: t.preview, blocks: t.blocks }).ok).toBe(true);
    }
  });

  test('the sender, the seed and the protected-template list agree on the guides', () => {
    expect(Object.keys(HOW_TO_GUIDES).sort()).toEqual(seed.GUIDES.map((g) => g.key).sort());
    const source = require('fs').readFileSync(require.resolve('../routes/admin-email-templates'), 'utf8');
    for (const guide of seed.GUIDES) {
      expect(HOW_TO_GUIDES[guide.key].path).toBe(guide.path);
      expect(source).toContain(`'howto.${guide.key}',`);
    }
  });
});

describe('sendHowToGuideToCustomer', () => {
  const customer = { id: 'c1', first_name: 'Dorothy Ann', email: 'dorothy@example.invalid' };
  let inserts;
  let sendTemplate;

  // `prefs` is the notification_prefs row; an Error makes the read reject.
  function mockDb(row, prefs = undefined) {
    inserts = [];
    db.mockImplementation((table) => ({
      where: () => ({
        whereNull: () => ({ first: async () => (table === 'customers' ? row : null) }),
        first: async () => { if (prefs instanceof Error) throw prefs; return prefs; },
      }),
      insert: async (data) => { inserts.push({ table, data }); },
    }));
  }

  beforeEach(() => {
    sendTemplate = jest.spyOn(EmailTemplateLibrary, 'sendTemplate');
  });
  afterEach(() => jest.restoreAllMocks());

  test('emails the guide with a deep link to its app screen and logs the send', async () => {
    mockDb(customer);
    sendTemplate.mockResolvedValue({ sent: true });
    const result = await sendHowToGuideToCustomer({ customerId: 'c1', guideKey: 'alerts_iphone', actorId: 't1' });
    expect(result).toMatchObject({ ok: true, label: 'Make app alerts show on iPhone', emailAddress: customer.email });
    const sent = sendTemplate.mock.calls[0][0];
    expect(sent).toMatchObject({ templateKey: 'howto.alerts_iphone', to: customer.email, recipientId: 'c1', suppressionGroupKey: 'service_operational' });
    expect(sent.payload.first_name).toBe('Dorothy');
    expect(sent.payload.guide_url).toMatch(/\/login\?next=%2F%3Ftab%3Dvisits$/);
    expect(inserts).toEqual([{ table: 'customer_interactions', data: expect.objectContaining({ customer_id: 'c1', interaction_type: 'email_outbound', admin_user_id: 't1' }) }]);
  });

  test('refuses without sending when there is no email, no customer or no such guide', async () => {
    mockDb({ ...customer, email: ' ' });
    expect(await sendHowToGuideToCustomer({ customerId: 'c1', guideKey: 'refer' })).toMatchObject({ ok: false, reason: 'no_email' });
    mockDb(null);
    expect(await sendHowToGuideToCustomer({ customerId: 'c1', guideKey: 'refer' })).toMatchObject({ ok: false, reason: 'customer_not_found' });
    expect(await sendHowToGuideToCustomer({ customerId: 'c1', guideKey: 'flea' })).toMatchObject({ ok: false, reason: 'unsupported_guide' });
    expect(sendTemplate).not.toHaveBeenCalled();
  });

  test('the portal email switch stops the guide, and an unreadable preference sends nothing', async () => {
    mockDb(customer, { email_enabled: false });
    expect(await sendHowToGuideToCustomer({ customerId: 'c1', guideKey: 'refer' })).toMatchObject({ ok: false, reason: 'email_opted_out' });
    mockDb(customer, new Error('connection lost'));
    expect(await sendHowToGuideToCustomer({ customerId: 'c1', guideKey: 'refer' })).toMatchObject({ ok: false, reason: 'prefs_unavailable' });
    expect(sendTemplate).not.toHaveBeenCalled();
  });

  test('a blocked address is not a send; a throw after dispatch is uncertain, before it is not', async () => {
    mockDb(customer);
    sendTemplate.mockResolvedValueOnce({ sent: false, blocked: true });
    expect(await sendHowToGuideToCustomer({ customerId: 'c1', guideKey: 'refer' })).toMatchObject({ ok: false, reason: 'email_blocked' });

    sendTemplate.mockImplementationOnce(async ({ onQueued }) => { await onQueued(); throw new Error('socket hang up'); });
    expect(await sendHowToGuideToCustomer({ customerId: 'c1', guideKey: 'refer' })).toMatchObject({ ok: false, reason: 'send_failed', emailUncertain: true });

    sendTemplate.mockRejectedValueOnce(new Error('template missing'));
    expect(await sendHowToGuideToCustomer({ customerId: 'c1', guideKey: 'refer' })).toMatchObject({ ok: false, reason: 'send_failed', emailUncertain: false });
    expect(inserts).toEqual([]);
  });
});

describe('welcome email notification steps', () => {
  const { ALLOW_COPY, SETTINGS_COPY } = welcome.__private;
  const seeded = () => [
    { type: 'heading', content: 'Welcome' },
    { type: 'paragraph', content: 'If your sign-in code does not arrive or work, request a fresh one.' },
    { type: 'paragraph', content: 'Lawn note.' },
    { type: 'cta', label: 'Get started with the Waves app', url: 'https://www.wavespestcontrol.com/app/' },
    { type: 'signature', content: '— The Waves Team' },
  ];

  test('adds the two paragraphs right after the sign-in help, once', () => {
    const blocks = welcome.addNotificationSteps(seeded());
    expect(blocks.map((b) => b.content).slice(1, 4)).toEqual([expect.stringMatching(/^If your sign-in code/), ALLOW_COPY, SETTINGS_COPY]);
    expect(welcome.addNotificationSteps(blocks)).toHaveLength(7);
  });

  test('a reworded welcome still gets them, above the first button', () => {
    const edited = seeded().filter((b) => !String(b.content).startsWith('If your sign-in code'));
    const blocks = welcome.addNotificationSteps(edited);
    const cta = blocks.findIndex((b) => b.type === 'cta');
    expect(blocks[cta - 2].content).toBe(ALLOW_COPY);
    expect(blocks[cta - 1].content).toBe(SETTINGS_COPY);
  });

  test('a staff-written plaintext body is appended to, not replaced', () => {
    const version = welcome.buildVersion({ subject: 'S', preview_text: 'P', blocks: seeded(), text_body: 'Custom welcome.' });
    expect(version.text_body).toBe(`Custom welcome.\n\n${ALLOW_COPY}\n\n${SETTINGS_COPY}`);
    expect(welcome.buildVersion({ subject: 'S', preview_text: 'P', blocks: seeded(), text_body: null }).text_body).toBeNull();
  });
});
