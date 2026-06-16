jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../services/email-template-library', () => ({
  sendTemplate: jest.fn(async () => ({
    sent: true,
    message: { provider_message_id: 'sg-123', status: 'sent', sent_at: '2026-05-20T12:00:00.000Z' },
  })),
}));

const db = require('../models/db');
const EmailTemplates = require('../services/email-template-library');
const AccountMembershipEmail = require('../services/account-membership-email');

function chain({ result = [], first, returning } = {}) {
  const q = {};
  [
    'where',
    'whereIn',
    'whereNotNull',
    'whereNotIn',
    'whereNull',
    'select',
    'orderBy',
  ].forEach((method) => {
    q[method] = jest.fn(() => q);
  });
  q.insert = jest.fn(() => q);
  q.update = jest.fn(() => q);
  q.first = jest.fn(async () => first);
  q.returning = jest.fn(async () => returning || []);
  q.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject);
  q.catch = (reject) => Promise.resolve(result).catch(reject);
  return q;
}

function setDbQueues(queues) {
  const tableQueues = new Map(Object.entries(queues));
  db.mockImplementation((table) => {
    const queue = tableQueues.get(table);
    if (!queue || !queue.length) throw new Error(`Unexpected db table ${table}`);
    return queue.shift();
  });
  return tableQueues;
}

function customer(overrides = {}) {
  return {
    id: 'cust-1',
    first_name: 'Taylor',
    last_name: 'Morgan',
    company_name: null,
    email: 'taylor@example.com',
    phone: '+19415550101',
    profile_label: 'Primary',
    address_line1: '123 Main St',
    city: 'Bradenton',
    state: 'FL',
    zip: '34211',
    waveguard_tier: 'Gold',
    monthly_rate: '159.00',
    member_since: '2026-05-20',
    active: true,
    ...overrides,
  };
}

describe('account and membership email sender', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('sends account.updated for a portal setting change with stable idempotency', async () => {
    setDbQueues({
      customers: [chain({ first: customer() })],
      customer_interactions: [chain()],
    });

    await AccountMembershipEmail.sendAccountUpdated({
      customerId: 'cust-1',
      changedItems: [{
        key: 'serviceReminder72h',
        label: '72-Hour Appointment Reminder',
        oldValue: 'On',
        newValue: 'Off',
      }],
      changeSummary: 'Your 72-Hour Appointment Reminder was set to Off.',
      accountSection: 'Notification preferences',
    });

    expect(EmailTemplates.sendTemplate).toHaveBeenCalledWith(expect.objectContaining({
      templateKey: 'account.updated',
      to: 'taylor@example.com',
      suppressionGroupKey: 'transactional_required',
      idempotencyKey: expect.stringMatching(/^account\.updated:cust-1:/),
      payload: expect.objectContaining({
        first_name: 'Taylor',
        account_section: 'Notification preferences',
        changed_items_summary: '72-Hour Appointment Reminder: On to Off',
        customer_portal_url: 'https://portal.wavespestcontrol.com/?tab=property',
        manage_preferences_url: 'https://portal.wavespestcontrol.com/?tab=visits',
      }),
    }));
  });

  test('skips account.updated when the recipient made the change themselves', async () => {
    // No db queues are set: a self-initiated edit must short-circuit before
    // any DB work or template send.
    const result = await AccountMembershipEmail.sendAccountUpdated({
      customerId: 'cust-1',
      actorCustomerId: 'cust-1',
      changedItems: [{
        key: 'serviceReminder72h',
        label: '72-Hour Appointment Reminder',
        oldValue: 'On',
        newValue: 'Off',
      }],
      changeSummary: 'Your 72-Hour Appointment Reminder was set to Off.',
      accountSection: 'Notification preferences',
    });

    expect(result).toMatchObject({ skipped: true, reason: 'self_initiated' });
    expect(EmailTemplates.sendTemplate).not.toHaveBeenCalled();
  });

  test('still sends account.updated when a different actor made the change', async () => {
    setDbQueues({
      customers: [chain({ first: customer() })],
      customer_interactions: [chain()],
    });

    const result = await AccountMembershipEmail.sendAccountUpdated({
      customerId: 'cust-1',
      recipientCustomerId: 'cust-1',
      actorCustomerId: 'staff-9',
      changedItems: [{
        key: 'serviceReminder72h',
        label: '72-Hour Appointment Reminder',
        oldValue: 'On',
        newValue: 'Off',
      }],
      changeSummary: 'Your 72-Hour Appointment Reminder was set to Off.',
      accountSection: 'Notification preferences',
    });

    expect(result).not.toMatchObject({ skipped: true });
    expect(EmailTemplates.sendTemplate).toHaveBeenCalledWith(expect.objectContaining({
      templateKey: 'account.updated',
      to: 'taylor@example.com',
    }));
  });

  test('sends portal request received confirmation with request id idempotency', async () => {
    setDbQueues({
      customers: [chain({ first: customer() })],
      customer_interactions: [chain()],
    });

    await AccountMembershipEmail.sendRequestReceived({
      customerId: 'cust-1',
      request: {
        id: 'req-1',
        category: 'schedule_change',
        subject: 'Move my visit',
        description: 'Friday morning works better.',
        status: 'new',
        urgency: 'routine',
        created_at: '2026-05-20',
      },
      responseTime: '24 hours',
    });

    expect(EmailTemplates.sendTemplate).toHaveBeenCalledWith(expect.objectContaining({
      templateKey: 'account.request_received',
      idempotencyKey: 'account.request_received:req-1',
      payload: expect.objectContaining({
        request_type: 'Schedule Change',
        request_subject: 'Move my visit',
        response_time: '24 hours',
        portal_requests_url: 'https://portal.wavespestcontrol.com/?tab=request',
      }),
    }));
  });

  test('sends membership update with before and after values', async () => {
    setDbQueues({
      customers: [
        chain({ first: customer({ waveguard_tier: 'Gold', monthly_rate: '159.00' }) }),
        chain({ first: customer({ waveguard_tier: 'Gold', monthly_rate: '159.00' }) }),
      ],
      customer_interactions: [chain()],
    });

    await AccountMembershipEmail.sendMembershipUpdated({
      customerId: 'cust-1',
      before: { waveguard_tier: 'Silver', monthly_rate: '129.00' },
      after: { waveguard_tier: 'Gold', monthly_rate: '159.00', active: true },
      effectiveDate: '2026-05-20',
    });

    expect(EmailTemplates.sendTemplate).toHaveBeenCalledWith(expect.objectContaining({
      templateKey: 'membership.updated',
      idempotencyKey: expect.stringMatching(/^membership\.updated:cust-1:2026-05-20:/),
      payload: expect.objectContaining({
        membership_change_summary: 'Tier: Silver to Gold; Monthly rate: $129.00 to $159.00',
        old_membership_tier: 'Silver',
        new_membership_tier: 'Gold',
        customer_portal_url: 'https://portal.wavespestcontrol.com/?tab=plan',
      }),
    }));
  });

  test('renders membership cancellation with explicit previous membership values', async () => {
    setDbQueues({
      customers: [
        chain({ first: customer({ waveguard_tier: 'none', monthly_rate: '0.00' }) }),
        chain({ first: customer({ waveguard_tier: 'none', monthly_rate: '0.00' }) }),
      ],
      customer_interactions: [chain()],
    });

    await AccountMembershipEmail.sendMembershipCanceled({
      customerId: 'cust-1',
      effectiveDate: '2026-05-20',
      reason: 'Membership removed',
      membershipTier: 'Gold',
      monthlyRate: '159.00',
    });

    expect(EmailTemplates.sendTemplate).toHaveBeenCalledWith(expect.objectContaining({
      templateKey: 'membership.canceled',
      payload: expect.objectContaining({
        membership_tier: 'Gold',
        monthly_rate: '$159.00',
        cancellation_effective_date: 'May 20, 2026',
      }),
    }));
  });

  test('skips sends and logs when the customer has no valid email', async () => {
    const interaction = chain();
    setDbQueues({
      customers: [chain({ first: customer({ email: '' }) })],
      customer_interactions: [interaction],
    });

    const result = await AccountMembershipEmail.sendRequestReceived({
      customerId: 'cust-1',
      request: { id: 'req-1', subject: 'Help', category: 'billing' },
    });

    expect(result).toMatchObject({ skipped: true, reason: 'missing_email' });
    expect(EmailTemplates.sendTemplate).not.toHaveBeenCalled();
    expect(interaction.insert).toHaveBeenCalledWith(expect.objectContaining({
      customer_id: 'cust-1',
      interaction_type: 'email_outbound',
      subject: 'account.request_received email skipped',
    }));
  });
});
