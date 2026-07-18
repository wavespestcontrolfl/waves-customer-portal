jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ warn: jest.fn(), error: jest.fn(), info: jest.fn() }));
jest.mock('../services/email-template-library', () => ({ sendTemplate: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../services/sms-template-renderer', () => ({ renderSmsTemplate: jest.fn() }));
jest.mock('../services/project-email', () => ({
  // Mirrors the real resolver: a configured service contact wins the email
  // recipient (address + name); otherwise the primary customer.
  resolveProjectEmailRecipient: (customer) => ({
    email: customer.service_contact_email || customer.email || '',
    name: customer.service_contact_name || customer.first_name || '',
    role: customer.service_contact_email ? 'service_contact' : 'primary',
  }),
  // Real implementations (against the mocked db) so the tokened prep_url
  // and confirmed-delivery stamp paths are exercised end-to-end.
  ensureServicePrepToken: jest.requireActual('../services/project-email').ensureServicePrepToken,
  markServicePrepSent: jest.requireActual('../services/project-email').markServicePrepSent,
}));

const db = require('../models/db');
const EmailTemplateLibrary = require('../services/email-template-library');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { renderSmsTemplate } = require('../services/sms-template-renderer');
const { sendPrepToCustomer } = require('../services/prep-guide-sender');

let customerRow;

function customersQuery() {
  const q = { where: jest.fn(() => q), whereNull: jest.fn(() => q), first: jest.fn(async () => customerRow) };
  return q;
}
// nextUpcomingVisit lookup — no upcoming visit by default. When a test sets
// upcomingVisitRow, the same table also serves ensureServicePrepToken's
// chains (.select()…first() token read + .update().returning() mint).
let upcomingVisitRow = null;
let servicePrepRow = null;
let serviceUpdates = [];
function scheduledQuery() {
  let tokenMode = false;
  const q = {
    select: jest.fn(() => { tokenMode = true; return q; }),
    where: jest.fn(() => q), whereRaw: jest.fn(() => q), whereNotIn: jest.fn(() => q),
    whereNull: jest.fn(() => q), update: jest.fn((patch) => { serviceUpdates.push(patch); return q; }),
    returning: jest.fn(async () => [{}]),
    catch: jest.fn(async () => undefined),
    orderBy: jest.fn(() => q),
    first: jest.fn(async () => (tokenMode ? servicePrepRow : upcomingVisitRow)),
  };
  return q;
}
const interactionsInsert = jest.fn(async () => [1]);

beforeEach(() => {
  jest.clearAllMocks();
  customerRow = {
    id: 'cust-1', first_name: 'Megan', last_name: 'Example',
    email: 'megan@example.com', phone: '+19415550101',
    address_line1: '5022 Sunnyside Ln', city: 'Bradenton', state: 'FL', zip: '34211',
    deleted_at: null,
  };
  db.mockImplementation((table) => {
    if (table === 'customers') return customersQuery();
    if (table === 'scheduled_services') return scheduledQuery();
    if (table === 'customer_interactions') return { insert: interactionsInsert };
    return customersQuery();
  });
  db.fn = { now: jest.fn(() => 'NOW()') };
  upcomingVisitRow = null;
  servicePrepRow = { prep_token: null, prep_template_key: null };
  serviceUpdates = [];
  EmailTemplateLibrary.sendTemplate.mockResolvedValue({ sent: true });
  renderSmsTemplate.mockResolvedValue('Flea prep steps...');
  sendCustomerMessage.mockResolvedValue({ sent: true });
});

describe('sendPrepToCustomer', () => {
  test('email on file → emails the prep guide AND the companion text', async () => {
    const result = await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'flea' });

    expect(result.ok).toBe(true);
    expect(result.emailSent).toBe(true);
    expect(result.smsSent).toBe(true);
    expect(EmailTemplateLibrary.sendTemplate).toHaveBeenCalledTimes(1);
    expect(EmailTemplateLibrary.sendTemplate.mock.calls[0][0]).toMatchObject({
      templateKey: 'prep.flea',
      to: 'megan@example.com',
      recipientId: 'cust-1',
      // Provider errors can echo the recipient address — keep them out of logs.
      suppressProviderErrorLog: true,
    });
    // service_date is a required prep-template var — never empty, even with no
    // upcoming visit (falls back to a non-empty placeholder).
    expect(EmailTemplateLibrary.sendTemplate.mock.calls[0][0].payload.service_date)
      .toBe('To be confirmed');
    // Companion SMS (references the emailed guide), not the standalone variant.
    expect(renderSmsTemplate).toHaveBeenCalledWith(
      'auto_flea', { first_name: 'Megan' }, expect.any(Object),
    );
  });

  test('service-contact account: email greets the contact, SMS greets the phone owner', async () => {
    customerRow = {
      ...customerRow,
      first_name: 'Megan',
      service_contact_name: 'Jamie Onsite',
      service_contact_email: 'jamie@example.com',
    };

    await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'flea' });

    // Email is addressed to the service contact (recipient), by their name.
    expect(EmailTemplateLibrary.sendTemplate.mock.calls[0][0].to).toBe('jamie@example.com');
    expect(EmailTemplateLibrary.sendTemplate.mock.calls[0][0].payload.first_name).toBe('Jamie');
    // The SMS goes to the primary's phone, so it greets the primary — not Jamie.
    expect(renderSmsTemplate).toHaveBeenCalledWith(
      'auto_flea', { first_name: 'Megan' }, expect.any(Object),
    );
  });

  test('manual send is attributed to the operator', async () => {
    await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'flea', actorId: 'tech-9' });

    // adminUserId (not actor_id) is the key the Twilio path reads for sms_log.
    expect(sendCustomerMessage.mock.calls[0][0].metadata).toMatchObject({
      adminUserId: 'tech-9',
      manual: true,
    });
    expect(interactionsInsert).toHaveBeenCalledWith(
      expect.objectContaining({ admin_user_id: 'tech-9' }),
    );
  });

  test('an SMS send writes the tagger-compatible prep marker (replay dedupe)', async () => {
    await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'flea' });

    // Must match appointment-tagger's hasSentPrepSms lookup exactly
    // (sms_outbound + "<pestType> prep info sent") so a later automated
    // replay doesn't re-text prep this manual click already delivered.
    expect(interactionsInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        interaction_type: 'sms_outbound',
        subject: 'flea prep info sent',
      }),
    );
  });

  test('an email-only send keeps the descriptive manual subject', async () => {
    customerRow = { ...customerRow, phone: '' };

    const result = await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'flea' });

    expect(result.emailSent).toBe(true);
    expect(result.smsSent).toBe(false);
    expect(interactionsInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        interaction_type: 'email_outbound',
        subject: 'Flea Treatment prep sent (manual)',
      }),
    );
  });

  test('no email → sends the self-contained standalone text, no email', async () => {
    customerRow = { ...customerRow, email: '' };

    const result = await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'flea' });

    expect(result.ok).toBe(true);
    expect(result.emailSent).toBe(false);
    expect(result.smsSent).toBe(true);
    expect(EmailTemplateLibrary.sendTemplate).not.toHaveBeenCalled();
    expect(renderSmsTemplate).toHaveBeenCalledWith(
      'auto_flea_no_email', { first_name: 'Megan' }, expect.any(Object),
    );
  });

  test('no email and no phone → nothing to send', async () => {
    customerRow = { ...customerRow, email: '', phone: '' };

    const result = await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'flea' });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('no_email_or_phone');
    expect(EmailTemplateLibrary.sendTemplate).not.toHaveBeenCalled();
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('unknown customer → customer_not_found', async () => {
    customerRow = undefined;

    const result = await sendPrepToCustomer({ customerId: 'missing', pestType: 'flea' });

    expect(result).toMatchObject({ ok: false, reason: 'customer_not_found' });
  });

  test('unsupported pest type → rejected', async () => {
    const result = await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'termite' });

    expect(result).toMatchObject({ ok: false, reason: 'unsupported_pest_type' });
    expect(EmailTemplateLibrary.sendTemplate).not.toHaveBeenCalled();
  });

  test('email present but send fails → SMS falls back to the standalone text', async () => {
    EmailTemplateLibrary.sendTemplate.mockResolvedValueOnce({ sent: false, reason: 'blocked' });

    const result = await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'flea' });

    expect(result.ok).toBe(true);
    expect(result.emailSent).toBe(false);
    expect(result.smsSent).toBe(true);
    // The companion text claims "we emailed your guide" — since the email did
    // not send, the self-contained variant goes out instead.
    expect(renderSmsTemplate).toHaveBeenCalledWith(
      'auto_flea_no_email', { first_name: 'Megan' }, expect.any(Object),
    );
  });

  test('upcoming visit → prep_url is the tokened public prep page', async () => {
    upcomingVisitRow = { id: 'svc-9', scheduled_date: '2026-08-01' };

    const result = await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'flea' });

    expect(result.ok).toBe(true);
    const payload = EmailTemplateLibrary.sendTemplate.mock.calls[0][0].payload;
    expect(payload.prep_url).toMatch(/\/prep\/[0-9a-f]{32}$/);
    expect(payload.customer_portal_url).toContain('?tab=visits');
    expect(payload.service_date).not.toBe('To be confirmed');
    // Confirmed send → the track page's "prep actually went out" marker,
    // aligned to the guide THIS email delivered.
    expect(serviceUpdates).toContainEqual(expect.objectContaining({
      prep_sent_at: 'NOW()',
      prep_template_key: 'prep.flea',
    }));
  });

  test('a rejected email never stamps prep_sent_at', async () => {
    upcomingVisitRow = { id: 'svc-9', scheduled_date: '2026-08-01' };
    EmailTemplateLibrary.sendTemplate.mockResolvedValueOnce({ sent: false, reason: 'blocked' });

    await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'flea' });

    expect(serviceUpdates.some((p) => p && p.prep_sent_at)).toBe(false);
  });

  test('no upcoming visit → prep_url stays the portal visits tab', async () => {
    const result = await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'flea' });

    expect(result.ok).toBe(true);
    const payload = EmailTemplateLibrary.sendTemplate.mock.calls[0][0].payload;
    expect(payload.prep_url).toContain('?tab=visits');
    expect(payload.service_date).toBe('To be confirmed');
  });
});
