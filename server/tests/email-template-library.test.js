jest.mock('../models/db', () => jest.fn());
jest.mock('../services/sendgrid-mail', () => ({
  newsletterGroupId: jest.fn(() => 101),
  serviceGroupId: jest.fn(() => 202),
  sendOne: jest.fn(),
}));

const db = require('../models/db');
const sendgrid = require('../services/sendgrid-mail');
const EmailTemplates = require('../services/email-template-library');

function chain({ result = [], first, returning } = {}) {
  const q = {};
  [
    'where',
    'whereRaw',
    'select',
    'orderBy',
    'limit',
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
  // sendTemplate guards the post-send status with a CASE expression.
  db.raw = jest.fn((sql, bindings) => ({ __raw: sql, bindings }));
}

function serviceTemplate(overrides = {}) {
  return {
    id: 'tmpl-1',
    template_key: 'estimate.expiring_notice',
    name: 'Estimate Expiring Notice',
    mode: 'service',
    send_stream: 'service_operational',
    allowed_variables: ['first_name', 'estimate_url', 'expires_at', 'company_name'],
    required_variables: ['first_name', 'estimate_url', 'expires_at'],
    ...overrides,
  };
}

function marketingTemplate(overrides = {}) {
  return serviceTemplate({
    id: 'tmpl-marketing',
    template_key: 'newsletter.monthly',
    name: 'Monthly Newsletter',
    mode: 'marketing',
    send_stream: 'marketing_newsletter',
    allowed_variables: ['first_name'],
    required_variables: ['first_name'],
    ...overrides,
  });
}

function version(overrides = {}) {
  return {
    id: 'ver-1',
    subject: 'Your estimate expires {{expires_at}}',
    preview_text: 'Available until {{expires_at}}.',
    text_body: '',
    blocks: [
      { type: 'paragraph', content: 'Hi {{first_name}}, your estimate is available until {{expires_at}}.' },
      { type: 'details', rows: [{ label: 'Company', value: '{{company_name}}' }] },
      { type: 'cta', label: 'View estimate', url_variable: 'estimate_url' },
    ],
    ...overrides,
  };
}

describe('email template library rendering', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('renders service templates through the professional service wrapper', () => {
    const rendered = EmailTemplates.renderTemplate({
      template: serviceTemplate(),
      version: version(),
      payload: {
        first_name: 'Taylor',
        expires_at: 'June 12',
        estimate_url: 'https://portal.wavespestcontrol.com/estimate/sample',
        company_name: 'Waves & Co.',
      },
    });

    expect(rendered.subject).toBe('Your estimate expires June 12');
    expect(rendered.missingPayload).toEqual([]);
    expect(rendered.validation.ok).toBe(true);
    expect(rendered.html).toContain('Waves Pest Control');
    expect(rendered.html).toContain('Hi Taylor');
    expect(rendered.html).toContain('https://portal.wavespestcontrol.com/estimate/sample');
    expect(rendered.html).not.toContain('Unsubscribe');
    expect(rendered.text).toContain('Company: Waves & Co.');
  });

  test('renders default CTA settings when a version has no CTA block', () => {
    const rendered = EmailTemplates.renderTemplate({
      template: serviceTemplate({
        allowed_variables: ['first_name', 'account_url'],
        required_variables: ['first_name', 'account_url'],
        default_cta_label: 'Open portal',
        default_cta_url_variable: 'account_url',
      }),
      version: version({
        subject: 'Welcome {{first_name}}',
        preview_text: '',
        blocks: [{ type: 'paragraph', content: 'Hi {{first_name}}, your account is ready.' }],
      }),
      payload: {
        first_name: 'Taylor',
        account_url: 'https://portal.wavespestcontrol.com',
      },
    });

    expect(rendered.html).toContain('Open portal');
    expect(rendered.html).toContain('https://portal.wavespestcontrol.com');
    expect(rendered.text).toContain('Open portal: https://portal.wavespestcontrol.com');
    expect(rendered.validation.ok).toBe(true);
    expect(rendered.validation.referenced_variables).toContain('account_url');
  });

  test('appends default CTA settings to custom text bodies', () => {
    const rendered = EmailTemplates.renderTemplate({
      template: serviceTemplate({
        allowed_variables: ['first_name', 'account_url'],
        required_variables: ['first_name', 'account_url'],
        default_cta_label: 'Open portal',
        default_cta_url_variable: 'account_url',
      }),
      version: version({
        subject: 'Welcome {{first_name}}',
        preview_text: '',
        text_body: 'Hi {{first_name}}, your account is ready.',
        blocks: [{ type: 'paragraph', content: 'Hi {{first_name}}, your account is ready.' }],
      }),
      payload: {
        first_name: 'Taylor',
        account_url: 'https://portal.wavespestcontrol.com',
      },
    });

    expect(rendered.html).toContain('Open portal');
    expect(rendered.text).toContain('Hi Taylor, your account is ready.');
    expect(rendered.text).toContain('Open portal: https://portal.wavespestcontrol.com');
  });

  test('reports missing payload values separately from template validation', () => {
    const rendered = EmailTemplates.renderTemplate({
      template: serviceTemplate(),
      version: version(),
      payload: {
        first_name: 'Taylor',
        estimate_url: 'https://portal.wavespestcontrol.com/estimate/sample',
      },
    });

    expect(rendered.validation.ok).toBe(true);
    expect(rendered.missingPayload).toEqual(['expires_at']);
  });

  test('detects obvious placeholder payload values before production sends', () => {
    expect(EmailTemplates.productionPlaceholderPayloadValues({
      first_name: 'Taylor',
      service_label: 'Sample project type',
      amount_due: '.00',
      email: 'customer@example.com',
      portal_url: 'https://portal.wavespestcontrol.com/sample',
      estimate_url: 'https://portal.wavespestcontrol.com/estimate/sample',
      demo_url: 'https://portal.wavespestcontrol.com/review-demo',
      nested_demo_url: 'https://portal.wavespestcontrol.com/pay/demo-invoice',
      request_type: 'Review request type',
      request_subject: 'Review invoice 1042',
      company_phone: '(941) 555-0134',
    })).toEqual([
      'amount_due',
      'company_phone',
      'demo_url',
      'email',
      'estimate_url',
      'nested_demo_url',
      'portal_url',
      'request_type',
      'service_label',
    ]);
  });

  test('detects placeholder values after rendering production emails', () => {
    expect(EmailTemplates.productionPlaceholderRenderedValues({
      subject: 'We received your request',
      previewText: '',
      text: 'Type: Review request type\nPay invoice: https://portal.wavespestcontrol.com/pay/demo-invoice',
      html: '',
    })).toEqual(['rendered_placeholder_copy', 'rendered_url']);
  });

  test('allows legitimate rendered content that starts with review words', () => {
    expect(EmailTemplates.productionPlaceholderRenderedValues({
      subject: 'We received your request',
      previewText: '',
      text: 'Summary: Review monthly rate for next year',
      html: '',
    })).toEqual([]);
  });

  test('renders variables inside custom text bodies', () => {
    const rendered = EmailTemplates.renderTemplate({
      template: serviceTemplate(),
      version: version({
        text_body: 'Hi {{first_name}}, view {{estimate_url}} before {{expires_at}}.',
      }),
      payload: {
        first_name: 'Taylor',
        expires_at: 'June 12',
        estimate_url: 'https://portal.wavespestcontrol.com/estimate/sample',
      },
    });

    expect(rendered.text).toBe('Hi Taylor, view https://portal.wavespestcontrol.com/estimate/sample before June 12.');
  });

  test('adds the SendGrid ASM unsubscribe placeholder to marketing sends', async () => {
    const queuedMessage = {
      id: 'msg-1',
      status: 'queued',
      subject_snapshot: 'Monthly update',
    };
    const sentMessage = { ...queuedMessage, status: 'sent', provider_message_id: 'sg-1' };
    const queueInsert = chain({ returning: [queuedMessage] });
    const sentUpdate = chain({ returning: [sentMessage] });

    setDbQueues({
      email_templates: [chain({ first: marketingTemplate({ active_version_id: 'ver-marketing' }) })],
      email_template_versions: [chain({
        first: version({
          id: 'ver-marketing',
          subject: 'Monthly update',
          preview_text: 'A quick Waves update.',
          text_body: '',
          blocks: [{ type: 'paragraph', content: 'Hi {{first_name}}, here is the monthly update.' }],
        }),
      })],
      email_suppressions: [chain({ result: [] })],
      email_messages: [
        queueInsert,
        sentUpdate,
      ],
    });
    sendgrid.sendOne.mockResolvedValue({ messageId: 'sg-1' });

    await EmailTemplates.sendTemplate({
      templateKey: 'newsletter.monthly',
      to: 'sam@example.com',
      payload: { first_name: 'Sam' },
      recipientType: 'subscriber',
    });

    expect(queueInsert.insert).toHaveBeenCalledWith(expect.objectContaining({
      html_snapshot: expect.stringContaining('<%asm_group_unsubscribe_raw_url%>'),
      text_snapshot: expect.stringContaining('Unsubscribe: <%asm_group_unsubscribe_raw_url%>'),
    }));
    expect(sendgrid.sendOne).toHaveBeenCalledWith(expect.objectContaining({
      asmGroupId: 101,
      html: expect.stringContaining('<%asm_group_unsubscribe_raw_url%>'),
      text: expect.stringContaining('Unsubscribe: <%asm_group_unsubscribe_raw_url%>'),
    }));
  });

  test('deduplicates SendGrid categories before queueing and sending', async () => {
    const queuedMessage = {
      id: 'msg-1',
      status: 'queued',
      subject_snapshot: 'Your estimate expires June 12',
    };
    const sentMessage = { ...queuedMessage, status: 'sent', provider_message_id: 'sg-1' };
    const queueInsert = chain({ returning: [queuedMessage] });
    const sentUpdate = chain({ returning: [sentMessage] });

    setDbQueues({
      email_templates: [chain({ first: serviceTemplate({ active_version_id: 'ver-1' }) })],
      email_template_versions: [chain({ first: version({ id: 'ver-1' }) })],
      email_suppressions: [chain({ result: [] })],
      email_messages: [
        queueInsert,
        sentUpdate,
      ],
    });
    sendgrid.sendOne.mockResolvedValue({ messageId: 'sg-1' });

    await EmailTemplates.sendTemplate({
      templateKey: 'estimate.expiring_notice',
      to: 'sam@example.com',
      payload: {
        first_name: 'Sam',
        estimate_url: 'https://example.com/estimate/est-1',
        expires_at: 'June 12',
      },
      categories: [
        'template_estimate_expiring_notice',
        'estimate_expiring_notice',
        'estimate_expiring_notice',
        'stream_service_operational',
        'custom',
        'custom',
      ],
    });

    const expectedCategories = [
      'email_template',
      'template_estimate_expiring_notice',
      'stream_service_operational',
      'estimate_expiring_notice',
      'custom',
    ];

    expect(JSON.parse(queueInsert.insert.mock.calls[0][0].categories)).toEqual(expectedCategories);
    expect(sendgrid.sendOne).toHaveBeenCalledWith(expect.objectContaining({
      categories: expectedCategories,
    }));
    // Tracked sends carry the row id + a per-attempt token so the bounce-recovery
    // webhook fallback can resolve the row and reject stale prior-attempt events.
    expect(sendgrid.sendOne).toHaveBeenCalledWith(expect.objectContaining({
      customArgs: expect.objectContaining({ email_message_id: 'msg-1', send_attempt_token: expect.any(String) }),
    }));
  });

  test('returns a superseded result when a newer attempt reclaimed the row (codex round 14)', async () => {
    const queuedMessage = { id: 'msg-x', status: 'queued', subject_snapshot: 'S' };
    const liveRow = { id: 'msg-x', status: 'queued', provider_message_id: 'sg-live' };
    const queueInsert = chain({ returning: [queuedMessage] });
    // Token-scoped completion update affects 0 rows → this attempt was superseded.
    const supersededUpdate = chain({ returning: [] });
    const reread = chain({ first: liveRow });
    setDbQueues({
      email_templates: [chain({ first: serviceTemplate({ active_version_id: 'ver-1' }) })],
      email_template_versions: [chain({ first: version({ id: 'ver-1' }) })],
      email_suppressions: [chain({ result: [] })],
      email_messages: [queueInsert, supersededUpdate, reread],
    });
    sendgrid.sendOne.mockResolvedValue({ messageId: 'sg-new' });

    const result = await EmailTemplates.sendTemplate({
      templateKey: 'estimate.expiring_notice',
      to: 'sam@example.com',
      payload: { first_name: 'Sam', estimate_url: 'https://example.com/e', expires_at: 'June 12' },
    });

    expect(result).toEqual(expect.objectContaining({ sent: true, deduped: true, superseded: true }));
  });

  test('deduplicates membership.started categories before provider send', async () => {
    const queuedMessage = {
      id: 'msg-membership-started',
      status: 'queued',
      subject_snapshot: 'Your membership is active',
    };
    const sentMessage = { ...queuedMessage, status: 'sent', provider_message_id: 'sg-membership-started' };

    setDbQueues({
      email_templates: [chain({
        first: serviceTemplate({
          id: 'tmpl-membership-started',
          template_key: 'membership.started',
          send_stream: 'transactional_required',
          suppression_group_key: 'transactional_required',
          active_version_id: 'ver-membership-started',
          allowed_variables: ['first_name'],
          required_variables: ['first_name'],
        }),
      })],
      email_template_versions: [chain({
        first: version({
          id: 'ver-membership-started',
          subject: 'Your membership is active',
          preview_text: '',
          blocks: [{ type: 'paragraph', content: 'Hi {{first_name}}, your membership is active.' }],
        }),
      })],
      email_suppressions: [chain({ result: [] })],
      email_messages: [
        chain({ returning: [queuedMessage] }),
        chain({ returning: [sentMessage] }),
      ],
    });
    sendgrid.sendOne.mockResolvedValue({ messageId: 'sg-membership-started' });

    await EmailTemplates.sendTemplate({
      templateKey: 'membership.started',
      to: 'sam@example.com',
      payload: { first_name: 'Sam' },
      categories: ['membership', 'membership_started', 'membership_started'],
      suppressionGroupKey: 'transactional_required',
    });

    const categories = sendgrid.sendOne.mock.calls[0][0].categories;
    expect(categories).toEqual([
      'email_template',
      'template_membership_started',
      'stream_transactional_required',
      'membership',
      'membership_started',
    ]);
    expect(new Set(categories).size).toBe(categories.length);
  });

  test('keeps manual suppressions scoped to their selected preference group', async () => {
    const marketingSuppression = {
      id: 'suppression-1',
      email: 'sam@example.com',
      suppression_type: 'manual',
      group_key: 'marketing_newsletter',
      status: 'active',
    };
    const serviceSuppression = {
      ...marketingSuppression,
      id: 'suppression-2',
      group_key: 'service_operational',
    };
    setDbQueues({
      email_suppressions: [
        chain({ result: [marketingSuppression] }),
        chain({ result: [serviceSuppression] }),
      ],
    });

    await expect(EmailTemplates.activeSuppressionFor(
      serviceTemplate({ send_stream: 'service_operational', suppression_group_key: 'service_operational' }),
      'sam@example.com',
    )).resolves.toBeNull();
    await expect(EmailTemplates.activeSuppressionFor(
      serviceTemplate({ send_stream: 'service_operational', suppression_group_key: 'service_operational' }),
      'sam@example.com',
    )).resolves.toEqual(serviceSuppression);
  });

  test('honors an automation suppression group override', async () => {
    const marketingSuppression = {
      id: 'suppression-1',
      email: 'sam@example.com',
      suppression_type: 'manual',
      group_key: 'marketing_nurture',
      status: 'active',
    };
    setDbQueues({
      email_suppressions: [chain({ result: [marketingSuppression] })],
    });

    await expect(EmailTemplates.activeSuppressionFor(
      serviceTemplate({ send_stream: 'service_operational', suppression_group_key: 'service_operational' }),
      'sam@example.com',
      'marketing_nurture',
    )).resolves.toEqual(marketingSuppression);
  });

  test('uses suppression overrides for transactional bypass checks', async () => {
    const serviceSuppression = {
      id: 'suppression-1',
      email: 'sam@example.com',
      suppression_type: 'manual',
      group_key: 'service_operational',
      status: 'active',
    };
    setDbQueues({
      email_suppressions: [chain({ result: [serviceSuppression] })],
    });

    await expect(EmailTemplates.activeSuppressionFor(
      serviceTemplate({ send_stream: 'transactional_required', suppression_group_key: 'transactional_required' }),
      'sam@example.com',
      'service_operational',
    )).resolves.toEqual(serviceSuppression);
  });

  test('lets truly transactional templates bypass preference suppressions', async () => {
    const unsubscribeSuppression = {
      id: 'suppression-1',
      email: 'sam@example.com',
      suppression_type: 'unsubscribe',
      group_key: 'transactional_required',
      status: 'active',
    };
    setDbQueues({
      email_suppressions: [chain({ result: [unsubscribeSuppression] })],
    });

    await expect(EmailTemplates.activeSuppressionFor(
      serviceTemplate({ send_stream: 'transactional_required', suppression_group_key: 'transactional_required' }),
      'sam@example.com',
    )).resolves.toBeNull();
  });

  test('transactional required emails still honor global bounce and do-not-email suppressions', async () => {
    const unsubscribeSuppression = {
      id: 'suppression-1',
      email: 'sam@example.com',
      suppression_type: 'unsubscribe',
      group_key: 'transactional_required',
      status: 'active',
    };
    const bounceSuppression = {
      id: 'suppression-2',
      email: 'sam@example.com',
      suppression_type: 'bounce',
      group_key: null,
      status: 'active',
    };
    setDbQueues({
      email_suppressions: [
        chain({ result: [unsubscribeSuppression] }),
        chain({ result: [bounceSuppression] }),
      ],
    });

    await expect(EmailTemplates.activeSuppressionFor(
      serviceTemplate({ send_stream: 'transactional_required', suppression_group_key: 'transactional_required' }),
      'sam@example.com',
    )).resolves.toBeNull();
    await expect(EmailTemplates.activeSuppressionFor(
      serviceTemplate({ send_stream: 'transactional_required', suppression_group_key: 'transactional_required' }),
      'sam@example.com',
    )).resolves.toEqual(bounceSuppression);
  });

  test('ignores transactional suppression overrides on non-transactional templates', async () => {
    const serviceSuppression = {
      id: 'suppression-1',
      email: 'sam@example.com',
      suppression_type: 'manual',
      group_key: 'service_operational',
      status: 'active',
    };
    setDbQueues({
      email_suppressions: [chain({ result: [serviceSuppression] })],
    });

    await expect(EmailTemplates.activeSuppressionFor(
      serviceTemplate({ send_stream: 'service_operational', suppression_group_key: 'service_operational' }),
      'sam@example.com',
      'transactional_required',
    )).resolves.toEqual(serviceSuppression);
  });

  test('falls back to the template suppression group when override is null', async () => {
    const serviceSuppression = {
      id: 'suppression-1',
      email: 'sam@example.com',
      suppression_type: 'manual',
      group_key: 'service_operational',
      status: 'active',
    };
    setDbQueues({
      email_suppressions: [chain({ result: [serviceSuppression] })],
    });

    await expect(EmailTemplates.activeSuppressionFor(
      serviceTemplate({ send_stream: 'service_operational', suppression_group_key: 'service_operational' }),
      'sam@example.com',
      null,
    )).resolves.toEqual(serviceSuppression);
  });

  test('flags disallowed and missing required variables before publish', () => {
    const validation = EmailTemplates.validationFor(
      serviceTemplate({ allowed_variables: ['first_name'], required_variables: ['first_name', 'estimate_url'] }),
      version({
        subject: 'Hi {{first_name}}',
        preview_text: '',
        blocks: [{ type: 'paragraph', content: 'Click {{unsafe_url}}.' }],
      }),
    );

    expect(validation.ok).toBe(false);
    expect(validation.disallowed_variables).toEqual(['unsafe_url']);
    expect(validation.missing_required_in_template).toEqual(['estimate_url']);
  });

  test('redacts common sensitive payload keys in send snapshots', () => {
    expect(EmailTemplates.redactedPayloadSnapshot({
      first_name: 'Taylor',
      nested: {
        auth_token: 'tok_secret',
        invoice_number: 'W-1042',
      },
      cards: [{ card_number: '4242424242424242', amount_due: '$129.00' }],
    })).toEqual({
      first_name: 'Taylor',
      nested: {
        auth_token: '[redacted]',
        invoice_number: 'W-1042',
      },
      cards: '[redacted]',
    });
  });

  test('dedupe preserves terminal messages and retries unfinished messages', () => {
    expect(EmailTemplates.shouldRetryExistingMessage({ status: 'failed' })).toBe(true);
    expect(EmailTemplates.shouldRetryExistingMessage({ status: 'queued' })).toBe(true);
    expect(EmailTemplates.shouldRetryExistingMessage({ status: 'sending' })).toBe(true);
    expect(EmailTemplates.shouldRetryExistingMessage({ status: 'sent' })).toBe(false);
    expect(EmailTemplates.shouldRetryExistingMessage({ status: 'blocked' })).toBe(false);
    expect(EmailTemplates.shouldRetryExistingMessage({ status: 'dropped' })).toBe(false);
    expect(EmailTemplates.shouldRetryExistingMessage({ status: 'bounced' })).toBe(false);
    expect(EmailTemplates.shouldRetryExistingMessage({ status: 'spam_report' })).toBe(false);

    expect(EmailTemplates.dedupedResultForExistingMessage({
      id: 'msg-blocked',
      status: 'blocked',
      error_message: 'Suppressed: unsubscribe',
    })).toEqual({
      sent: false,
      blocked: true,
      deduped: true,
      reason: 'Suppressed: unsubscribe',
      message: {
        id: 'msg-blocked',
        status: 'blocked',
        error_message: 'Suppressed: unsubscribe',
      },
    });
  });

  test('sendTemplate retries a queued idempotent message instead of deduping it', async () => {
    const staleQueuedMessage = {
      id: 'msg-queued',
      status: 'queued',
      idempotency_key: 'estimate.extension_notice:est-queued',
      error_message: null,
      subject_snapshot: 'Stale queued subject',
      // Queued well outside the in-flight window: an abandoned/crashed attempt,
      // safe to reclaim and resend.
      queued_at: new Date(Date.now() - 60 * 60 * 1000),
    };
    const queuedMessage = {
      ...staleQueuedMessage,
      subject_snapshot: 'Your estimate expires June 12',
    };
    const sentMessage = { ...queuedMessage, status: 'sent', provider_message_id: 'sg-queued' };
    const queueUpdate = chain({ returning: [queuedMessage] });
    const sentUpdate = chain({ returning: [sentMessage] });

    setDbQueues({
      email_templates: [chain({ first: serviceTemplate({ active_version_id: 'ver-1' }) })],
      email_template_versions: [chain({ first: version({ id: 'ver-1' }) })],
      email_messages: [
        chain({ first: staleQueuedMessage }),
        queueUpdate,
        sentUpdate,
      ],
      email_suppressions: [chain({ result: [] })],
    });
    sendgrid.sendOne.mockResolvedValue({ messageId: 'sg-queued' });

    const result = await EmailTemplates.sendTemplate({
      templateKey: 'estimate.expiring_notice',
      to: 'sam@example.com',
      payload: {
        first_name: 'Sam',
        estimate_url: 'https://example.com/estimate/est-queued',
        expires_at: 'June 12',
      },
      idempotencyKey: 'estimate.extension_notice:est-queued',
    });

    expect(queueUpdate.update).toHaveBeenCalledWith(expect.objectContaining({
      status: 'queued',
      idempotency_key: 'estimate.extension_notice:est-queued',
    }));
    expect(sendgrid.sendOne).toHaveBeenCalledWith(expect.objectContaining({
      to: 'sam@example.com',
      subject: 'Your estimate expires June 12',
    }));
    expect(result).toEqual(expect.objectContaining({
      sent: true,
      message: sentMessage,
    }));
  });

  test('sendTemplate dedupes a concurrent idempotency-key insert collision instead of throwing', async () => {
    // Two overlapping callers both pass the pre-insert dedupe check (the row
    // does not exist yet), then race on the unique index. The loser hits a
    // 23505 on insert; it must re-read and return a clean dedupe rather than
    // surfacing a raw driver error — and must NOT double-send.
    const winnerMessage = {
      id: 'msg-winner',
      status: 'sent',
      provider_message_id: 'sg-winner',
      idempotency_key: 'estimate.extension_notice:est-race',
      subject_snapshot: 'Your estimate expires June 12',
    };
    const uniqueViolationInsert = chain({});
    uniqueViolationInsert.returning = jest.fn(async () => {
      const err = new Error('duplicate key value violates unique constraint "email_messages_idempotency_key_unique"');
      err.code = '23505';
      throw err;
    });

    setDbQueues({
      email_templates: [chain({ first: serviceTemplate({ active_version_id: 'ver-1' }) })],
      email_template_versions: [chain({ first: version({ id: 'ver-1' }) })],
      email_messages: [
        chain({ first: undefined }),       // pre-insert dedupe check: nothing yet
        uniqueViolationInsert,             // queued insert loses the race -> 23505
        chain({ first: winnerMessage }),   // re-read after collision -> the winner's row
      ],
      email_suppressions: [chain({ result: [] })],
    });

    const result = await EmailTemplates.sendTemplate({
      templateKey: 'estimate.expiring_notice',
      to: 'race@example.com',
      payload: {
        first_name: 'Ray',
        estimate_url: 'https://example.com/estimate/est-race',
        expires_at: 'June 12',
      },
      idempotencyKey: 'estimate.extension_notice:est-race',
    });

    expect(sendgrid.sendOne).not.toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({
      deduped: true,
      sent: true,
      message: winnerMessage,
    }));
  });

  test('sendTemplate surfaces a retryable collision when the winner is still in-flight', async () => {
    // Collision where the winner's row is still `queued` (its insert precedes
    // the SendGrid call). Reporting a clean dedupe here would be a false
    // non-send — callers treat sent===false as blocked. Raise a retryable
    // collision instead; the caller retries once the winner reaches a terminal
    // status.
    const inFlightWinner = {
      id: 'msg-inflight',
      status: 'queued',
      idempotency_key: 'estimate.extension_notice:est-inflight',
      subject_snapshot: 'Your estimate expires June 12',
    };
    const uniqueViolationInsert = chain({});
    uniqueViolationInsert.returning = jest.fn(async () => {
      const err = new Error('duplicate key value violates unique constraint "email_messages_idempotency_key_unique"');
      err.code = '23505';
      throw err;
    });

    setDbQueues({
      email_templates: [chain({ first: serviceTemplate({ active_version_id: 'ver-1' }) })],
      email_template_versions: [chain({ first: version({ id: 'ver-1' }) })],
      email_messages: [
        chain({ first: undefined }),         // pre-insert dedupe check: nothing yet
        uniqueViolationInsert,               // queued insert loses the race -> 23505
        chain({ first: inFlightWinner }),    // re-read: winner still in flight
      ],
      email_suppressions: [chain({ result: [] })],
    });

    await expect(EmailTemplates.sendTemplate({
      templateKey: 'estimate.expiring_notice',
      to: 'inflight@example.com',
      payload: {
        first_name: 'Ina',
        estimate_url: 'https://example.com/estimate/est-inflight',
        expires_at: 'June 12',
      },
      idempotencyKey: 'estimate.extension_notice:est-inflight',
    })).rejects.toMatchObject({ code: 'EMAIL_SEND_IN_PROGRESS', retryable: true });

    expect(sendgrid.sendOne).not.toHaveBeenCalled();
  });

  test('sendTemplate does not resend when a concurrent queued row is still in-flight', async () => {
    // The wider race: a concurrent caller already committed a `queued` row that
    // is mid-flight. The pre-insert lookup finds it; reclaiming it as a retry
    // would re-send and duplicate. A recently-queued row must raise a retryable
    // collision instead of being resent.
    const recentlyQueued = {
      id: 'msg-recent',
      status: 'queued',
      idempotency_key: 'estimate.extension_notice:est-recent',
      error_message: null,
      subject_snapshot: 'Your estimate expires June 12',
      queued_at: new Date(), // just queued -> in-flight
    };

    setDbQueues({
      email_templates: [chain({ first: serviceTemplate({ active_version_id: 'ver-1' }) })],
      email_template_versions: [chain({ first: version({ id: 'ver-1' }) })],
      email_messages: [chain({ first: recentlyQueued })], // pre-insert lookup only; we bail before insert
    });

    await expect(EmailTemplates.sendTemplate({
      templateKey: 'estimate.expiring_notice',
      to: 'recent@example.com',
      payload: {
        first_name: 'Ren',
        estimate_url: 'https://example.com/estimate/est-recent',
        expires_at: 'June 12',
      },
      idempotencyKey: 'estimate.extension_notice:est-recent',
    })).rejects.toMatchObject({ code: 'EMAIL_SEND_IN_PROGRESS', retryable: true });

    expect(sendgrid.sendOne).not.toHaveBeenCalled();
  });

  test('sendTemplate refuses paused templates before queueing', async () => {
    setDbQueues({
      email_templates: [chain({ first: serviceTemplate({ status: 'paused', active_version_id: 'ver-1' }) })],
      email_template_versions: [chain({ first: version({ id: 'ver-1' }) })],
    });

    try {
      await EmailTemplates.sendTemplate({
        templateKey: 'estimate.expiring_notice',
        to: 'sam@example.com',
        payload: {
          first_name: 'Sam',
          estimate_url: 'https://example.com/estimate/est-1',
          expires_at: 'June 12',
        },
      });
      throw new Error('expected paused template to be rejected');
    } catch (err) {
      expect(err.message).toBe('email template estimate.expiring_notice is paused');
      expect(err.status).toBe(409);
      expect(err.code).toBe('EMAIL_TEMPLATE_DISABLED');
    }
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
  });

  test('sendTemplate snapshots and applies suppression group overrides', async () => {
    const suppression = {
      id: 'suppression-1',
      email: 'sam@example.com',
      suppression_type: 'manual',
      group_key: 'marketing_nurture',
      status: 'active',
    };
    const blockedMessage = {
      id: 'msg-blocked',
      status: 'blocked',
      error_message: 'Suppressed: manual (marketing_nurture)',
    };
    const blockedInsert = chain({ returning: [blockedMessage] });

    setDbQueues({
      email_templates: [chain({ first: serviceTemplate({ active_version_id: 'ver-1' }) })],
      email_template_versions: [chain({ first: version({ id: 'ver-1' }) })],
      email_suppressions: [chain({ result: [suppression] })],
      email_messages: [blockedInsert],
    });

    const result = await EmailTemplates.sendTemplate({
      templateKey: 'estimate.expiring_notice',
      to: 'sam@example.com',
      payload: {
        first_name: 'Sam',
        estimate_url: 'https://example.com/estimate/est-1',
        expires_at: 'June 12',
      },
      suppressionGroupKey: 'marketing_nurture',
    });

    expect(result.blocked).toBe(true);
    expect(blockedInsert.insert).toHaveBeenCalledWith(expect.objectContaining({
      status: 'blocked',
      suppression_group_key_snapshot: 'marketing_nurture',
      error_message: 'Suppressed: manual (marketing_nurture)',
    }));
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
  });

  test('does not let transactional overrides bypass non-transactional template suppressions', async () => {
    const suppression = {
      id: 'suppression-1',
      email: 'sam@example.com',
      suppression_type: 'manual',
      group_key: 'service_operational',
      status: 'active',
    };
    const blockedMessage = {
      id: 'msg-blocked',
      status: 'blocked',
      error_message: 'Suppressed: manual (service_operational)',
    };
    const blockedInsert = chain({ returning: [blockedMessage] });

    setDbQueues({
      email_templates: [chain({ first: serviceTemplate({ active_version_id: 'ver-1' }) })],
      email_template_versions: [chain({ first: version({ id: 'ver-1' }) })],
      email_suppressions: [chain({ result: [suppression] })],
      email_messages: [blockedInsert],
    });

    const result = await EmailTemplates.sendTemplate({
      templateKey: 'estimate.expiring_notice',
      to: 'sam@example.com',
      payload: {
        first_name: 'Sam',
        estimate_url: 'https://example.com/estimate/est-1',
        expires_at: 'June 12',
      },
      suppressionGroupKey: 'transactional_required',
    });

    expect(result.blocked).toBe(true);
    expect(blockedInsert.insert).toHaveBeenCalledWith(expect.objectContaining({
      status: 'blocked',
      suppression_group_key_snapshot: 'service_operational',
      error_message: 'Suppressed: manual (service_operational)',
    }));
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
  });

  test('uses the suppression group override for SendGrid ASM grouping', async () => {
    const queuedMessage = {
      id: 'msg-1',
      status: 'queued',
      subject_snapshot: 'Your estimate expires June 12',
    };
    const sentMessage = { ...queuedMessage, status: 'sent', provider_message_id: 'sg-1' };
    const queueInsert = chain({ returning: [queuedMessage] });
    const sentUpdate = chain({ returning: [sentMessage] });

    setDbQueues({
      email_templates: [chain({ first: serviceTemplate({ active_version_id: 'ver-1' }) })],
      email_template_versions: [chain({ first: version({ id: 'ver-1' }) })],
      email_suppressions: [chain({ result: [] })],
      email_messages: [
        queueInsert,
        sentUpdate,
      ],
    });
    sendgrid.sendOne.mockResolvedValue({ messageId: 'sg-1' });

    await EmailTemplates.sendTemplate({
      templateKey: 'estimate.expiring_notice',
      to: 'sam@example.com',
      payload: {
        first_name: 'Sam',
        estimate_url: 'https://example.com/estimate/est-1',
        expires_at: 'June 12',
      },
      suppressionGroupKey: 'marketing_nurture',
    });

    expect(queueInsert.insert).toHaveBeenCalledWith(expect.objectContaining({
      suppression_group_key_snapshot: 'marketing_nurture',
      html_snapshot: expect.stringContaining('<%asm_group_unsubscribe_raw_url%>'),
      text_snapshot: expect.stringContaining('Unsubscribe: <%asm_group_unsubscribe_raw_url%>'),
    }));
    expect(sendgrid.sendOne).toHaveBeenCalledWith(expect.objectContaining({
      asmGroupId: 101,
      html: expect.stringContaining('<%asm_group_unsubscribe_raw_url%>'),
      text: expect.stringContaining('Unsubscribe: <%asm_group_unsubscribe_raw_url%>'),
    }));
  });

  test('sendTemplate retries a failed idempotent message instead of deduping it', async () => {
    const failedMessage = {
      id: 'msg-1',
      status: 'failed',
      idempotency_key: 'estimate.extension_notice:est-1',
      error_message: 'provider timeout',
    };
    const queuedMessage = {
      ...failedMessage,
      status: 'queued',
      error_message: null,
      subject_snapshot: 'Your estimate expires June 12',
    };
    const sentMessage = { ...queuedMessage, status: 'sent', provider_message_id: 'sg-1' };
    const queueUpdate = chain({ returning: [queuedMessage] });
    const sentUpdate = chain({ returning: [sentMessage] });

    setDbQueues({
      email_templates: [chain({ first: serviceTemplate({ active_version_id: 'ver-1' }) })],
      email_template_versions: [chain({ first: version({ id: 'ver-1' }) })],
      email_messages: [
        chain({ first: failedMessage }),
        queueUpdate,
        sentUpdate,
      ],
      email_suppressions: [chain({ result: [] })],
    });
    sendgrid.sendOne.mockResolvedValue({ messageId: 'sg-1' });

    const result = await EmailTemplates.sendTemplate({
      templateKey: 'estimate.expiring_notice',
      to: 'sam@example.com',
      payload: {
        first_name: 'Sam',
        estimate_url: 'https://example.com/estimate/est-1',
        expires_at: 'June 12',
      },
      idempotencyKey: 'estimate.extension_notice:est-1',
    });

    expect(queueUpdate.update).toHaveBeenCalledWith(expect.objectContaining({
      status: 'queued',
      error_message: null,
      idempotency_key: 'estimate.extension_notice:est-1',
    }));
    expect(sendgrid.sendOne).toHaveBeenCalledWith(expect.objectContaining({
      to: 'sam@example.com',
      subject: 'Your estimate expires June 12',
    }));
    expect(sentUpdate.update).toHaveBeenCalledWith(expect.objectContaining({
      provider_message_id: 'sg-1',
      // status is advanced via a guarded CASE (only from 'queued') so a fast
      // delivery/bounce webhook can't be regressed to 'sent'.
      status: expect.objectContaining({ __raw: expect.stringContaining("CASE WHEN status = 'queued'") }),
    }));
    expect(result).toEqual(expect.objectContaining({
      sent: true,
      message: sentMessage,
    }));
  });
});
