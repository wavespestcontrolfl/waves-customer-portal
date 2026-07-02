/**
 * Estimate follow-up emails go through EmailTemplateLibrary.sendTemplate.
 *
 * Migration C3: prior to this, sendDualChannel called EmailService.send
 * (raw SMTP) and the send was invisible to email_messages / email_suppressions.
 * These tests pin the template_key + payload shape + idempotency contract
 * per stage so the cron writes audit rows and respects suppressions.
 */

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/email-template-library', () => ({
  sendTemplate: jest.fn(),
}));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(async () => ({ sent: true })),
}));
jest.mock('../services/short-url', () => ({
  shortenOrPassthrough: jest.fn(async (url) => url),
}));
jest.mock('../routes/admin-sms-templates', () => ({
  getTemplate: jest.fn(async () => 'SMS body'),
}));

const EmailTemplates = require('../services/email-template-library');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { _private } = require('../services/estimate-follow-up');
const smsTemplates = require('../routes/admin-sms-templates');

const baseEst = {
  id: 'est-1',
  customer_id: 'cust-1',
  customer_email: 'lead@example.com',
  customer_phone: '+19415550100',
  customer_name: 'Taylor Doe',
  token: 'tok-xyz',
  created_at: new Date('2026-05-15T12:00:00Z'),
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe('estimate follow-up emails via template library', () => {
  test('SMS renderer forwards workflow/entity context to template issues', async () => {
    await _private.renderTemplate(
      'estimate_followup_questions',
      { first_name: 'Taylor', estimate_url: 'https://portal/x' },
      { workflow: 'estimate_follow_up', entity_type: 'estimate', entity_id: 'est-1' },
    );

    expect(smsTemplates.getTemplate).toHaveBeenCalledWith(
      'estimate_followup_questions',
      { first_name: 'Taylor', estimate_url: 'https://portal/x' },
      { workflow: 'estimate_follow_up', entity_type: 'estimate', entity_id: 'est-1' },
    );
  });

  test('questions stage uses estimate.unviewed_followup with stage-scoped idempotency', async () => {
    EmailTemplates.sendTemplate.mockResolvedValueOnce({ sent: true });

    const attempted = await _private.sendDualChannel(baseEst, {
      sms: 'SMS body',
      email: {
        templateKey: 'estimate.unviewed_followup',
        stage: 'questions',
        payload: { first_name: 'Taylor', estimate_url: 'https://portal/x' },
      },
    });

    expect(attempted).toBe(true);
    expect(EmailTemplates.sendTemplate).toHaveBeenCalledTimes(1);
    const args = EmailTemplates.sendTemplate.mock.calls[0][0];
    expect(args.templateKey).toBe('estimate.unviewed_followup');
    expect(args.to).toBe('lead@example.com');
    expect(args.idempotencyKey).toBe('estimate_followup_questions:est-1');
    expect(args.triggerEventId).toBe('estimate_followup_questions:est-1');
    expect(args.payload).toEqual({ first_name: 'Taylor', estimate_url: 'https://portal/x' });
    expect(args.recipientType).toBe('customer');
    expect(args.recipientId).toBe('cust-1');
    expect(args.categories).toContain('estimate_followup');
    expect(args.categories).toContain('estimate_followup_questions');
  });

  test('expiring stage passes expires_at variable through payload', async () => {
    EmailTemplates.sendTemplate.mockResolvedValueOnce({ sent: true });

    await _private.sendDualChannel(baseEst, {
      sms: 'SMS body',
      email: {
        templateKey: 'estimate.expiring_notice',
        stage: 'expiring',
        payload: { first_name: 'Taylor', estimate_url: 'https://portal/x', expires_at: 'June 12' },
      },
    });

    const args = EmailTemplates.sendTemplate.mock.calls[0][0];
    expect(args.templateKey).toBe('estimate.expiring_notice');
    expect(args.payload.expires_at).toBe('June 12');
    expect(args.idempotencyKey).toBe('estimate_followup_expiring:est-1');
  });

  test('lead audience: recipientType=lead when customer_id missing', async () => {
    EmailTemplates.sendTemplate.mockResolvedValueOnce({ sent: true });

    await _private.sendDualChannel(
      { ...baseEst, customer_id: null },
      {
        sms: 'SMS body',
        email: {
          templateKey: 'estimate.unviewed_followup',
          stage: 'questions',
          payload: { first_name: 'Taylor', estimate_url: 'https://portal/x' },
        },
      },
    );

    const args = EmailTemplates.sendTemplate.mock.calls[0][0];
    expect(args.recipientType).toBe('lead');
    expect(args.recipientId).toBeNull();
  });

  test('deduped result still counts as attempted (cron should not retry)', async () => {
    EmailTemplates.sendTemplate.mockResolvedValueOnce({
      sent: true,
      deduped: true,
      message: { status: 'sent' },
    });

    const attempted = await _private.sendDualChannel(baseEst, {
      sms: null, // no SMS body so only email counts
      email: {
        templateKey: 'estimate.unviewed_followup',
        stage: 'questions',
        payload: { first_name: 'Taylor', estimate_url: 'https://portal/x' },
      },
    });

    expect(attempted).toBe(true);
  });

  test('blocked (suppressed) result does NOT count as attempted', async () => {
    EmailTemplates.sendTemplate.mockResolvedValueOnce({
      sent: false,
      blocked: true,
      reason: 'Suppressed: unsubscribe (service_operational)',
      message: { status: 'blocked' },
    });
    sendCustomerMessage.mockResolvedValueOnce({ sent: false, blocked: true, code: 'opted_out' });

    const attempted = await _private.sendDualChannel(baseEst, {
      sms: 'SMS body',
      email: {
        templateKey: 'estimate.unviewed_followup',
        stage: 'questions',
        payload: { first_name: 'Taylor', estimate_url: 'https://portal/x' },
      },
    });

    expect(attempted).toBe(false);
  });

  test('thrown send error is caught and logged (returns attempted=false from email side)', async () => {
    EmailTemplates.sendTemplate.mockRejectedValueOnce(new Error('SendGrid 500: down'));
    sendCustomerMessage.mockResolvedValueOnce({ sent: false, blocked: true });

    const attempted = await _private.sendDualChannel(baseEst, {
      sms: 'SMS body',
      email: {
        templateKey: 'estimate.unviewed_followup',
        stage: 'questions',
        payload: { first_name: 'Taylor', estimate_url: 'https://portal/x' },
      },
    });

    expect(attempted).toBe(false);
  });

  test('skips email when customer_email is null but still attempts SMS', async () => {
    sendCustomerMessage.mockResolvedValueOnce({ sent: true });

    const attempted = await _private.sendDualChannel(
      { ...baseEst, customer_email: null },
      {
        sms: 'SMS body',
        email: {
          templateKey: 'estimate.unviewed_followup',
          stage: 'questions',
          payload: { first_name: 'Taylor', estimate_url: 'https://portal/x' },
        },
      },
    );

    expect(attempted).toBe(true);
    expect(EmailTemplates.sendTemplate).not.toHaveBeenCalled();
  });
});
