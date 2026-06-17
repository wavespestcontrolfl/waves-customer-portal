jest.mock('../models/db', () => jest.fn());
jest.mock('../services/email-template-library', () => ({
  sendTemplate: jest.fn(),
}));
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const db = require('../models/db');
const EmailTemplates = require('../services/email-template-library');
const AutomationExecutor = require('../services/email-template-automation-executor');

function chain({ result = [], first, returning } = {}) {
  const q = {};
  [
    'where',
    'whereIn',
    'leftJoin',
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
}

function automation(overrides = {}) {
  return {
    id: 'automation-1',
    automation_key: 'estimate.extension_notice',
    trigger_event_key: 'estimate.auto_renewed',
    template_key: 'estimate.extension_notice',
    delay_minutes: 0,
    audience: 'lead',
    status: 'active',
    active_version_id: 'version-1',
    idempotency_key_template: 'estimate.extension_notice:{estimate_id}:{new_expires_at}',
    conditions: JSON.stringify({ renewal_count_gt: 0 }),
    exit_conditions: JSON.stringify({ stop_if: ['estimate.accepted', 'estimate.archived'] }),
    retry_policy: JSON.stringify({ max_attempts: 2, backoff_minutes: [15, 60] }),
    ...overrides,
  };
}

function run(overrides = {}) {
  return {
    id: 'run-1',
    automation_id: 'automation-1',
    automation_key: 'estimate.extension_notice',
    trigger_event_key: 'estimate.auto_renewed',
    trigger_event_id: 'estimate_auto_renew:est-1',
    entity_type: 'estimate',
    entity_id: 'est-1',
    template_key: 'estimate.extension_notice',
    template_version_id: 'version-1',
    recipient_type: 'lead',
    recipient_id: 'cust-1',
    recipient_email: 'sam@example.com',
    idempotency_key: 'estimate.extension_notice:est-1:2026-06-01',
    status: 'queued',
    attempts: 0,
    max_attempts: 2,
    payload: JSON.stringify({
      estimate_id: 'est-1',
      customer_id: 'cust-1',
      customer_email: 'sam@example.com',
      first_name: 'Sam',
      estimate_url: 'https://example.com/estimate/est-1',
      new_expires_at: '2026-06-01',
      renewal_count: 1,
      status: 'sent',
    }),
    ...overrides,
  };
}

describe('email template automation executor', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('maps a trigger to an immediate send with a durable idempotency key', async () => {
    const queuedRun = run();
    const sentRun = { ...queuedRun, status: 'sent', email_message_id: 'message-1' };
    const existingRunQuery = chain({ first: null });
    const insertRunQuery = chain({ returning: [queuedRun] });
    const runningRunQuery = chain({ returning: [{ ...queuedRun, status: 'running', attempts: 1 }] });
    const sentRunQuery = chain({ returning: [sentRun] });
    const queuedLogQuery = chain({ returning: [{ id: 'event-1' }] });
    const attemptLogQuery = chain({ returning: [{ id: 'event-2' }] });
    const sentLogQuery = chain({ returning: [{ id: 'event-3' }] });

    setDbQueues({
      'email_template_automations as a': [chain({ result: [automation({ suppression_group_key: 'service_operational' })] })],
      email_template_automation_runs: [
        existingRunQuery,
        insertRunQuery,
        runningRunQuery,
        sentRunQuery,
      ],
      email_template_automation_run_events: [
        queuedLogQuery,
        attemptLogQuery,
        sentLogQuery,
      ],
      estimates: [chain({ first: null })],
    });
    EmailTemplates.sendTemplate.mockResolvedValue({
      sent: true,
      message: { id: 'message-1', provider_message_id: 'sg-message-1' },
    });

    const result = await AutomationExecutor.processTrigger({
      triggerEventKey: 'estimate.auto_renewed',
      triggerEventId: 'estimate_auto_renew:est-1',
      payload: {
        estimate_id: 'est-1',
        customer_id: 'cust-1',
        customer_email: 'Sam@Example.com',
        first_name: 'Sam',
        estimate_url: 'https://example.com/estimate/est-1',
        new_expires_at: '2026-06-01',
        renewal_count: 1,
        status: 'sent',
      },
      now: new Date('2026-05-18T12:00:00.000Z'),
    });

    expect(result.automation_count).toBe(1);
    expect(result.results[0].run.status).toBe('sent');
    expect(insertRunQuery.insert).toHaveBeenCalledWith(expect.objectContaining({
      automation_key: 'estimate.extension_notice',
      entity_type: 'estimate',
      entity_id: 'est-1',
      recipient_email: 'sam@example.com',
      idempotency_key: 'estimate.extension_notice:est-1:2026-06-01',
    }));
    expect(EmailTemplates.sendTemplate).toHaveBeenCalledWith(expect.objectContaining({
      templateKey: 'estimate.extension_notice',
      versionId: 'version-1',
      to: 'sam@example.com',
      recipientType: 'lead',
      recipientId: 'cust-1',
      automationRunId: 'run-1',
      triggerEventId: 'estimate_auto_renew:est-1',
      idempotencyKey: 'estimate.extension_notice:est-1:2026-06-01',
      suppressionGroupKey: 'service_operational',
    }));
    expect(sentRunQuery.update).toHaveBeenCalledWith(expect.objectContaining({
      status: 'sent',
      email_message_id: 'message-1',
    }));
  });

  test('dedupes trigger replays before sending', async () => {
    const existing = run({ status: 'sent' });
    const dedupeLogQuery = chain({ returning: [{ id: 'event-1' }] });
    setDbQueues({
      'email_template_automations as a': [chain({ result: [automation()] })],
      email_template_automation_runs: [chain({ first: existing })],
      email_template_automation_run_events: [dedupeLogQuery],
    });

    const result = await AutomationExecutor.processTrigger({
      triggerEventKey: 'estimate.auto_renewed',
      payload: {
        estimate_id: 'est-1',
        customer_email: 'sam@example.com',
        new_expires_at: '2026-06-01',
        renewal_count: 1,
        status: 'sent',
      },
    });

    expect(result.results[0].deduped).toBe(true);
    expect(result.results[0].run.id).toBe('run-1');
    expect(EmailTemplates.sendTemplate).not.toHaveBeenCalled();
    expect(dedupeLogQuery.insert).toHaveBeenCalledWith(expect.objectContaining({
      event_type: 'deduped',
    }));
  });

  test('records skipped runs when exit conditions are already met', async () => {
    const skippedRun = run({ status: 'skipped', exit_reason: 'estimate already accepted' });
    const insertRunQuery = chain({ returning: [skippedRun] });
    setDbQueues({
      'email_template_automations as a': [chain({
        result: [automation({
          conditions: '{}',
          exit_conditions: JSON.stringify({ stop_if: ['estimate.accepted'] }),
        })],
      })],
      email_template_automation_runs: [
        chain({ first: null }),
        insertRunQuery,
      ],
      email_template_automation_run_events: [chain({ returning: [{ id: 'event-1' }] })],
    });

    const result = await AutomationExecutor.processTrigger({
      triggerEventKey: 'estimate.auto_renewed',
      payload: {
        estimate_id: 'est-1',
        customer_email: 'sam@example.com',
        new_expires_at: '2026-06-01',
        status: 'accepted',
      },
    });

    expect(result.results[0].run.status).toBe('skipped');
    expect(insertRunQuery.insert).toHaveBeenCalledWith(expect.objectContaining({
      status: 'skipped',
      exit_reason: 'estimate already accepted',
    }));
    expect(EmailTemplates.sendTemplate).not.toHaveBeenCalled();
  });

  test('treats omitted estimate viewed state as unviewed', () => {
    expect(AutomationExecutor.conditionFailureFor(
      { estimate_viewed: false, estimate_status: ['sent', 'viewed'] },
      { status: 'sent', estimate_id: 'est-1' },
    )).toBeNull();
  });

  test('treats viewed estimate status as viewed without viewed_at', () => {
    expect(AutomationExecutor.conditionFailureFor(
      { estimate_viewed: false, estimate_status: ['sent', 'viewed'] },
      { estimate_status: 'viewed', estimate_id: 'est-1' },
    )).toBe('estimate_viewed must be false');
    expect(AutomationExecutor.exitReasonFor(
      { stop_if: ['estimate.viewed'] },
      { status: 'viewed', estimate_id: 'est-1' },
    )).toBe('estimate already viewed');
  });

  test('allows viewed estimate status during delayed follow-up rechecks', async () => {
    const queuedRun = run({
      automation_key: 'estimate.viewed_followup',
      trigger_event_key: 'estimate.viewed',
      template_key: 'estimate.viewed_followup',
      idempotency_key: 'estimate.viewed_followup:est-1',
      payload: JSON.stringify({
        estimate_id: 'est-1',
        customer_id: 'cust-1',
        customer_email: 'sam@example.com',
        first_name: 'Sam',
        estimate_url: 'https://example.com/estimate/est-1',
        status: 'sent',
        estimate_viewed: true,
      }),
    });
    const sentRun = { ...queuedRun, status: 'sent', email_message_id: 'message-1' };
    const sentRunQuery = chain({ returning: [sentRun] });
    setDbQueues({
      email_template_automation_runs: [
        chain({ returning: [{ ...queuedRun, status: 'running', attempts: 1 }] }),
        sentRunQuery,
      ],
      email_template_automation_run_events: [
        chain({ returning: [{ id: 'event-1' }] }),
        chain({ returning: [{ id: 'event-2' }] }),
      ],
      estimates: [chain({
        first: {
          id: 'est-1',
          status: 'viewed',
          viewed_at: new Date('2026-05-18T12:05:00.000Z'),
        },
      })],
    });
    EmailTemplates.sendTemplate.mockResolvedValue({
      sent: true,
      message: { id: 'message-1', provider_message_id: 'sg-message-1' },
    });

    const result = await AutomationExecutor.executeRun(queuedRun, {
      automation: automation({
        automation_key: 'estimate.viewed_followup',
        trigger_event_key: 'estimate.viewed',
        template_key: 'estimate.viewed_followup',
        idempotency_key_template: 'estimate.viewed_followup:{estimate_id}',
        conditions: JSON.stringify({ estimate_viewed: true, estimate_status: ['sent', 'viewed'] }),
        exit_conditions: JSON.stringify({ stop_if: ['estimate.accepted', 'estimate.expired'] }),
      }),
      now: new Date('2026-05-18T12:00:00.000Z'),
    });

    expect(result.status).toBe('sent');
    expect(EmailTemplates.sendTemplate).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({
        estimate_status: 'viewed',
        estimate_viewed: true,
      }),
    }));
    expect(sentRunQuery.update).toHaveBeenCalledWith(expect.objectContaining({
      status: 'sent',
    }));
  });

  test('schedules retries using the automation retry policy', async () => {
    const queuedRun = run({ attempts: 0 });
    const retryRun = {
      ...queuedRun,
      status: 'retry_scheduled',
      attempts: 1,
      run_after: new Date('2026-05-18T12:15:00.000Z'),
    };
    const retryUpdateQuery = chain({ returning: [retryRun] });
    setDbQueues({
      email_template_automation_runs: [
        chain({ returning: [{ ...queuedRun, status: 'running', attempts: 1 }] }),
        retryUpdateQuery,
      ],
      email_template_automation_run_events: [
        chain({ returning: [{ id: 'event-1' }] }),
        chain({ returning: [{ id: 'event-2' }] }),
      ],
      estimates: [chain({ first: null })],
    });
    EmailTemplates.sendTemplate.mockRejectedValue(new Error('provider timeout'));

    const result = await AutomationExecutor.executeRun(queuedRun, {
      automation: automation(),
      now: new Date('2026-05-18T12:00:00.000Z'),
    });

    expect(result.status).toBe('retry_scheduled');
    expect(retryUpdateQuery.update).toHaveBeenCalledWith(expect.objectContaining({
      status: 'retry_scheduled',
      next_retry_at: new Date('2026-05-18T12:15:00.000Z'),
      run_after: new Date('2026-05-18T12:15:00.000Z'),
      last_error: 'provider timeout',
    }));
  });

  test('keeps queued guard values when a live row omits optional columns', async () => {
    const queuedRun = run({ attempts: 0 });
    const sentRun = { ...queuedRun, status: 'sent', email_message_id: 'message-1' };
    const sentRunQuery = chain({ returning: [sentRun] });
    setDbQueues({
      email_template_automation_runs: [
        chain({ returning: [{ ...queuedRun, status: 'running', attempts: 1 }] }),
        sentRunQuery,
      ],
      email_template_automation_run_events: [
        chain({ returning: [{ id: 'event-1' }] }),
        chain({ returning: [{ id: 'event-2' }] }),
      ],
      estimates: [chain({ first: { id: 'est-1', status: 'sent' } })],
    });
    EmailTemplates.sendTemplate.mockResolvedValue({
      sent: true,
      message: { id: 'message-1', provider_message_id: 'sg-message-1' },
    });

    const result = await AutomationExecutor.executeRun(queuedRun, {
      automation: automation(),
      now: new Date('2026-05-18T12:00:00.000Z'),
    });

    expect(result.status).toBe('sent');
    expect(EmailTemplates.sendTemplate).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({
        renewal_count: 1,
        status: 'sent',
      }),
    }));
    expect(EmailTemplates.sendTemplate.mock.calls[0][0].suppressionGroupKey).toBeUndefined();
    expect(sentRunQuery.update).toHaveBeenCalledWith(expect.objectContaining({
      status: 'sent',
    }));
  });

  test('skips queued runs when the automation has been paused', async () => {
    const queuedRun = run({ attempts: 0 });
    const skipUpdateQuery = chain({ returning: [{ ...queuedRun, status: 'skipped', exit_reason: 'automation status is paused' }] });
    setDbQueues({
      email_template_automation_runs: [skipUpdateQuery],
      email_template_automation_run_events: [chain({ returning: [{ id: 'event-1' }] })],
    });

    const result = await AutomationExecutor.executeRun(queuedRun, {
      automation: automation({ status: 'paused' }),
      now: new Date('2026-05-18T12:00:00.000Z'),
    });

    expect(result.status).toBe('skipped');
    expect(skipUpdateQuery.update).toHaveBeenCalledWith(expect.objectContaining({
      status: 'skipped',
      exit_reason: 'automation status is paused',
    }));
    expect(EmailTemplates.sendTemplate).not.toHaveBeenCalled();
  });

  test('does not send a due run if another worker already claimed it', async () => {
    const queuedRun = run({ attempts: 0 });
    const runningRun = run({ status: 'running', attempts: 1 });
    setDbQueues({
      email_template_automation_runs: [
        chain({ returning: [] }),
        chain({ first: runningRun }),
      ],
    });

    const result = await AutomationExecutor.executeRun(queuedRun, {
      automation: automation(),
      now: new Date('2026-05-18T12:00:00.000Z'),
    });

    expect(result.status).toBe('running');
    expect(EmailTemplates.sendTemplate).not.toHaveBeenCalled();
  });

  test('rejects idempotency templates with missing variables', () => {
    expect(() => AutomationExecutor.renderIdempotencyKey(
      'estimate.delivery:{estimate_id}:{trigger_event_id}',
      { estimate_id: 'est-1' },
    )).toThrow(/trigger_event_id/);
  });

  test('idempotency key is stable across template republishes', async () => {
    const automationV1 = automation({ active_version_id: 'version-1' });
    const automationV2 = automation({ active_version_id: 'version-2' });
    const insertRunV1 = chain({ returning: [run({ template_version_id: 'version-1' })] });
    const insertRunV2 = chain({ returning: [run({ template_version_id: 'version-2' })] });
    setDbQueues({
      'email_template_automations as a': [
        chain({ result: [automationV1] }),
        chain({ result: [automationV2] }),
      ],
      email_template_automation_runs: [
        chain({ first: null }), insertRunV1, chain({ returning: [run()] }), chain({ returning: [run()] }),
        chain({ first: null }), insertRunV2, chain({ returning: [run()] }), chain({ returning: [run()] }),
      ],
      email_template_automation_run_events: Array.from({ length: 6 }, () => chain({ returning: [{ id: 'evt' }] })),
      estimates: [chain({ first: null }), chain({ first: null })],
    });
    EmailTemplates.sendTemplate.mockResolvedValue({ sent: true, message: { id: 'm', provider_message_id: 'sg' } });

    const payload = {
      estimate_id: 'est-1', customer_id: 'cust-1', customer_email: 'sam@example.com',
      first_name: 'Sam', estimate_url: 'https://example.com/e/est-1',
      new_expires_at: '2026-06-01', renewal_count: 1, status: 'sent',
    };
    await AutomationExecutor.processTrigger({ triggerEventKey: 'estimate.auto_renewed', payload });
    await AutomationExecutor.processTrigger({ triggerEventKey: 'estimate.auto_renewed', payload });

    const keyV1 = insertRunV1.insert.mock.calls[0][0].idempotency_key;
    const keyV2 = insertRunV2.insert.mock.calls[0][0].idempotency_key;
    expect(keyV1).toBe(keyV2);
    expect(keyV1).not.toMatch(/version-/);
  });
});
