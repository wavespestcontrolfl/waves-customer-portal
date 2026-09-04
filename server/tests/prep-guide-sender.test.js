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
  renderSmsTemplate.mockResolvedValue('Prep text...');
  sendCustomerMessage.mockResolvedValue({ sent: true });
});

describe('sendPrepToCustomer', () => {
  const VISIT = { id: 'svc-9', scheduled_date: '2026-08-01' };

  test('default channel (both), no upcoming visit → emails the guide AND texts the inline-steps standalone', async () => {
    const result = await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'flea' });

    expect(result).toMatchObject({ ok: true, channel: 'both', emailSent: true, smsSent: true });
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
    // No visit → no guide page to link; the inline-steps text goes instead.
    expect(renderSmsTemplate).toHaveBeenCalledWith(
      'auto_flea_no_email', { first_name: 'Megan' }, expect.any(Object),
    );
    expect(sendCustomerMessage.mock.calls[0][0].metadata).toMatchObject({ prep_variant: 'standalone' });
  });

  test('both with an upcoming visit → the text carries the tokened guide page link', async () => {
    upcomingVisitRow = VISIT;

    const result = await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'flea', channel: 'both' });

    expect(result).toMatchObject({ ok: true, emailSent: true, smsSent: true });
    const [key, vars] = renderSmsTemplate.mock.calls[0];
    expect(key).toBe('auto_prep_guide_link');
    expect(vars.first_name).toBe('Megan');
    expect(vars.prep_label).toBe('Flea Treatment');
    expect(vars.prep_url).toMatch(/\/prep\/[0-9a-f]{32}$/);
    // Same token in the email and the text.
    expect(EmailTemplateLibrary.sendTemplate.mock.calls[0][0].payload.prep_url).toBe(vars.prep_url);
    expect(sendCustomerMessage.mock.calls[0][0].metadata).toMatchObject({ prep_variant: 'guide_link' });
  });

  test('email only → no text, even with a phone on file', async () => {
    const result = await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'flea', channel: 'email' });

    expect(result).toMatchObject({ ok: true, channel: 'email', emailSent: true, smsSent: false });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(interactionsInsert).toHaveBeenCalledWith(
      expect.objectContaining({ interaction_type: 'email_outbound', subject: 'Flea Treatment prep sent (manual)' }),
    );
  });

  test('text only → no email, even with an email on file', async () => {
    const result = await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'flea', channel: 'sms' });

    expect(result).toMatchObject({ ok: true, channel: 'sms', emailSent: false, smsSent: true });
    expect(EmailTemplateLibrary.sendTemplate).not.toHaveBeenCalled();
    expect(renderSmsTemplate).toHaveBeenCalledWith(
      'auto_flea_no_email', { first_name: 'Megan' }, expect.any(Object),
    );
  });

  test('text only for a guide with no inline-steps text needs an upcoming visit', async () => {
    const refused = await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'termite', channel: 'sms' });
    expect(refused).toMatchObject({ ok: false, reason: 'no_upcoming_visit' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();

    upcomingVisitRow = VISIT;
    const sent = await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'termite', channel: 'sms' });
    expect(sent).toMatchObject({ ok: true, smsSent: true, emailSent: false });
    const [key, vars] = renderSmsTemplate.mock.calls[0];
    expect(key).toBe('auto_prep_guide_link');
    expect(vars.prep_label).toBe('Termite Service');
    // The texted link IS the guide delivery: prep_sent_at is stamped for it.
    expect(serviceUpdates).toContainEqual(expect.objectContaining({
      prep_sent_at: 'NOW()',
      prep_template_key: 'prep.termite',
    }));
  });

  test('every prep guide is sendable by email', async () => {
    const { PREP_CONFIG } = require('../services/prep-guide-sender');
    const keys = Object.keys(PREP_CONFIG);
    expect(keys.sort()).toEqual([
      'bed_bug', 'cockroach', 'flea', 'interior_pest', 'lawn', 'mosquito', 'rodent', 'termite', 'wildlife',
    ]);
    for (const pestType of keys) {
      jest.clearAllMocks();
      EmailTemplateLibrary.sendTemplate.mockResolvedValue({ sent: true });
      const result = await sendPrepToCustomer({ customerId: 'cust-1', pestType, channel: 'email' });
      expect(result.ok).toBe(true);
      expect(EmailTemplateLibrary.sendTemplate.mock.calls[0][0].templateKey).toBe(PREP_CONFIG[pestType].emailTemplateKey);
    }
  });

  test('service-contact account: email greets the contact, SMS greets the phone owner', async () => {
    customerRow = {
      ...customerRow,
      first_name: 'Megan',
      service_contact_name: 'Jamie Onsite',
      service_contact_email: 'jamie@example.com',
    };

    await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'flea', channel: 'both' });

    // Email is addressed to the service contact (recipient), by their name.
    expect(EmailTemplateLibrary.sendTemplate.mock.calls[0][0].to).toBe('jamie@example.com');
    expect(EmailTemplateLibrary.sendTemplate.mock.calls[0][0].payload.first_name).toBe('Jamie');
    // The SMS goes to the primary's phone, so it greets the primary — not Jamie.
    expect(renderSmsTemplate).toHaveBeenCalledWith(
      'auto_flea_no_email', { first_name: 'Megan' }, expect.any(Object),
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

  test('a chosen channel with nothing on file is refused, not silently skipped', async () => {
    customerRow = { ...customerRow, email: '' };
    expect(await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'flea', channel: 'email' }))
      .toMatchObject({ ok: false, reason: 'no_email' });
    expect(await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'flea', channel: 'both' }))
      .toMatchObject({ ok: false, reason: 'no_email' });

    customerRow = { ...customerRow, email: 'megan@example.com', phone: '' };
    expect(await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'flea', channel: 'sms' }))
      .toMatchObject({ ok: false, reason: 'no_phone' });

    expect(EmailTemplateLibrary.sendTemplate).not.toHaveBeenCalled();
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('unknown customer → customer_not_found', async () => {
    customerRow = undefined;

    const result = await sendPrepToCustomer({ customerId: 'missing', pestType: 'flea' });

    expect(result).toMatchObject({ ok: false, reason: 'customer_not_found' });
  });

  test('unsupported pest type or channel → rejected', async () => {
    expect(await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'gator' }))
      .toMatchObject({ ok: false, reason: 'unsupported_pest_type' });
    expect(await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'flea', channel: 'fax' }))
      .toMatchObject({ ok: false, reason: 'unsupported_channel' });
    expect(EmailTemplateLibrary.sendTemplate).not.toHaveBeenCalled();
  });

  test('both: a rejected email still lets the text go out', async () => {
    EmailTemplateLibrary.sendTemplate.mockResolvedValueOnce({ sent: false, reason: 'blocked' });

    const result = await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'flea', channel: 'both' });

    expect(result).toMatchObject({ ok: true, emailSent: false, smsSent: true });
  });

  test('upcoming visit → prep_url is the tokened public prep page and a sent email stamps prep_sent_at', async () => {
    upcomingVisitRow = VISIT;

    const result = await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'flea', channel: 'email' });

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

  test('nothing delivered never stamps prep_sent_at', async () => {
    upcomingVisitRow = VISIT;
    EmailTemplateLibrary.sendTemplate.mockResolvedValueOnce({ sent: false, reason: 'blocked' });
    sendCustomerMessage.mockResolvedValueOnce({ sent: false, code: 'suppressed' });

    const result = await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'flea', channel: 'both' });

    expect(result).toMatchObject({ ok: false, reason: 'send_failed' });
    expect(serviceUpdates.some((p) => p && p.prep_sent_at)).toBe(false);
  });

  test('no upcoming visit → the email prep_url stays the portal visits tab', async () => {
    const result = await sendPrepToCustomer({ customerId: 'cust-1', pestType: 'flea', channel: 'email' });

    expect(result.ok).toBe(true);
    const payload = EmailTemplateLibrary.sendTemplate.mock.calls[0][0].payload;
    expect(payload.prep_url).toContain('?tab=visits');
    expect(payload.service_date).toBe('To be confirmed');
  });
});
