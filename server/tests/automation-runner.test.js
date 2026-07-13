jest.mock('../models/db', () => jest.fn());
jest.mock('../services/sendgrid-mail', () => ({
  isConfigured: jest.fn(() => true),
  sendOne: jest.fn(),
}));
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const {
  renderAutomationStepContent,
  automationSuppressionGroupKey,
  automationSuppressionMatches,
  activeAutomationSuppressionFor,
  sendStep,
} = require('../services/automation-runner');
const db = require('../models/db');
const sendgrid = require('../services/sendgrid-mail');

function chain({ result = [], first, returning, updateResult = 1 } = {}) {
  const q = {};
  [
    'where',
    'whereRaw',
    'whereNull',
    'whereNotNull',
    'orWhereNotNull',
    'orWhereRaw',
    'orderBy',
    'orderByRaw',
    'limit',
  ].forEach((method) => {
    q[method] = jest.fn(() => q);
  });
  q.insert = jest.fn(() => q);
  q.update = jest.fn(() => Promise.resolve(updateResult));
  q.first = jest.fn(async () => first);
  q.returning = jest.fn(() => Promise.resolve(returning || []));
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

describe('automation runner rendering', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
  });

  test('renders service automation content without newsletter chrome or legal unsubscribe text', () => {
    const rendered = renderAutomationStepContent({
      template: { asm_group: 'service' },
      htmlBody: '<p>Hi {{first_name}}, your estimate is ready.</p>',
      textBody: 'Hi {{first_name}}, your estimate is ready.',
      customer: { first_name: 'Taylor', email: 'taylor@example.com' },
      asmGroupId: 202,
    });

    expect(rendered.html).toContain('Waves');
    expect(rendered.html).toContain('Hi Taylor');
    expect(rendered.html).not.toContain('The Waves Newsletter');
    expect(rendered.html).not.toContain('<%asm_group_unsubscribe_raw_url%>');
    expect(rendered.text).toBe('Hi Taylor, your estimate is ready.');
  });

  test('renders marketing automation content with service chrome but keeps the unsubscribe footer', () => {
    const rendered = renderAutomationStepContent({
      template: { asm_group: 'newsletter' },
      htmlBody: '<p>Hi {{first_name}}, thanks for your interest in Waves.</p>',
      textBody: 'Hi {{first_name}}, thanks for your interest in Waves.',
      customer: { first_name: 'Taylor', email: 'taylor@example.com' },
      asmGroupId: 101,
    });

    // Newsletter chrome is reserved for actual newsletter sends — marketing
    // drips (new_lead/cold_lead/referral_nudge) wear the service shell.
    expect(rendered.html).not.toContain('The Waves Newsletter');
    expect(rendered.html).toContain('Hi Taylor');
    // Still a commercial email on the marketing ASM group: the visible
    // unsubscribe link must survive the wrapper swap.
    expect(rendered.html).toContain('<%asm_group_unsubscribe_raw_url%>');
    expect(rendered.text).toContain('Hi Taylor, thanks for your interest in Waves.');
    expect(rendered.text).toContain('Unsubscribe: <%asm_group_unsubscribe_raw_url%>');
  });
});

describe('automation runner suppression guardrails', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
  });

  test('maps automation ASM groups to local email preference groups', () => {
    expect(automationSuppressionGroupKey({ asm_group: 'newsletter' })).toBe('marketing_newsletter');
    expect(automationSuppressionGroupKey({ asm_group: 'service' })).toBe('service_operational');
    expect(automationSuppressionGroupKey({})).toBe('service_operational');
  });

  test('matches group-scoped and global suppressions for automations', () => {
    const newsletterTemplate = { asm_group: 'newsletter' };
    const serviceTemplate = { asm_group: 'service' };

    expect(automationSuppressionMatches(newsletterTemplate, {
      suppression_type: 'manual',
      group_key: 'marketing_newsletter',
    })).toBe(true);
    expect(automationSuppressionMatches(newsletterTemplate, {
      suppression_type: 'manual',
      group_key: 'service_operational',
    })).toBe(false);
    expect(automationSuppressionMatches(serviceTemplate, {
      suppression_type: 'manual',
      group_key: 'service_operational',
    })).toBe(true);
    expect(automationSuppressionMatches(serviceTemplate, {
      suppression_type: 'bounce',
      group_key: 'marketing_newsletter',
    })).toBe(true);
    expect(automationSuppressionMatches(newsletterTemplate, {
      suppression_type: 'unsubscribe',
      group_key: null,
    })).toBe(true);
  });

  test('loads the first active suppression that applies to the automation stream', async () => {
    const serviceSuppression = {
      id: 'suppression-2',
      email: 'customer@example.com',
      suppression_type: 'manual',
      group_key: 'service_operational',
      status: 'active',
    };
    setDbQueues({
      email_suppressions: [
        chain({
          result: [
            {
              id: 'suppression-1',
              email: 'customer@example.com',
              suppression_type: 'manual',
              group_key: 'marketing_newsletter',
              status: 'active',
            },
            serviceSuppression,
          ],
        }),
      ],
    });

    await expect(activeAutomationSuppressionFor(
      { asm_group: 'service' },
      'Customer@Example.com',
    )).resolves.toEqual(serviceSuppression);
  });

  test('blocks real automation sends for locally suppressed recipients', async () => {
    const sendUpdate = chain();
    const enrollmentUpdate = chain();
    setDbQueues({
      automation_enrollments: [
        chain({
          first: {
            id: 'enrollment-1',
            template_key: 'cold_lead',
            status: 'active',
            current_step: 0,
            email: 'customer@example.com',
            first_name: 'Sam',
            last_name: 'Customer',
          },
        }),
        enrollmentUpdate,
      ],
      automation_templates: [
        chain({ first: { key: 'cold_lead', name: 'Cold Lead', asm_group: 'newsletter' } }),
      ],
      automation_steps: [
        chain({
          result: [{
            id: 'step-1',
            step_order: 1,
            subject: 'Hi {{first_name}}',
            html_body: '<p>Hello {{first_name}}</p>',
            text_body: 'Hello {{first_name}}',
            from_email: 'automations@wavespestcontrol.com',
            enabled: true,
          }],
        }),
      ],
      automation_step_sends: [
        chain({ returning: [{ id: 'send-1' }] }),
        sendUpdate,
      ],
      email_suppressions: [
        chain({
          result: [{
            id: 'suppression-1',
            email: 'customer@example.com',
            suppression_type: 'unsubscribe',
            group_key: 'marketing_newsletter',
            status: 'active',
          }],
        }),
      ],
    });

    await expect(sendStep('enrollment-1')).resolves.toEqual({
      sent: false,
      blocked: true,
      reason: 'Suppressed: unsubscribe (marketing_newsletter)',
    });
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
    expect(sendUpdate.update).toHaveBeenCalledWith(expect.objectContaining({
      status: 'blocked',
      failure_reason: 'Suppressed: unsubscribe (marketing_newsletter)',
    }));
    expect(enrollmentUpdate.update).toHaveBeenCalledWith(expect.objectContaining({
      status: 'cancelled',
      next_send_at: null,
    }));
  });
});

describe('automation runner enrollment reactivation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
  });

  test('reactivating a prior enrollment refreshes the denormalized contact fields', async () => {
    const { enrollCustomer } = require('../services/automation-runner');
    const reactivateUpdate = chain({
      returning: [{ id: 'enr-1', status: 'active' }],
    });
    reactivateUpdate.update = jest.fn(() => reactivateUpdate);
    setDbQueues({
      automation_templates: [chain({ first: { key: 'flea', name: 'Flea Treatment', enabled: true } })],
      automation_steps: [chain({ result: [{ id: 'step-1', step_order: 0, delay_hours: 0, enabled: true }] })],
      automation_enrollments: [
        // Prior COMPLETED enrollment carrying the customer's OLD email.
        chain({ first: { id: 'enr-1', status: 'completed', email: 'old@example.com' } }),
        reactivateUpdate,
      ],
    });

    const result = await enrollCustomer({
      templateKey: 'flea',
      customer: { id: 'cust-1', email: 'NEW@Example.com', first_name: 'Megan', last_name: 'Example' },
    });

    expect(result).toEqual({ enrolled: true, enrollmentId: 'enr-1' });
    // The scheduler sends to the ROW's email — the manual re-send must go to
    // the customer's current address, not the stale denormalized one.
    expect(reactivateUpdate.update).toHaveBeenCalledWith(expect.objectContaining({
      status: 'active',
      current_step: 0,
      email: 'new@example.com',
      first_name: 'Megan',
      last_name: 'Example',
    }));
  });
});

describe('automation runner scheduler tick', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
  });

  test('processDueSteps only picks enrollments on ENABLED templates (tab toggle = in-flight hold)', async () => {
    const { processDueSteps } = require('../services/automation-runner');
    sendgrid.isConfigured.mockReturnValue(true);
    const dueChain = chain({ result: [] });
    dueChain.join = jest.fn(() => dueChain);
    dueChain.select = jest.fn(() => Promise.resolve([]));
    setDbQueues({ 'automation_enrollments as e': [dueChain] });

    const result = await processDueSteps();

    expect(result).toEqual({ processed: 0 });
    // Disabled templates are excluded at pick time, so toggling an automation
    // off in the Automations tab immediately holds its in-flight enrollments.
    expect(dueChain.join).toHaveBeenCalledWith('automation_templates as t', 't.key', 'e.template_key');
    expect(dueChain.where).toHaveBeenCalledWith('t.enabled', true);
  });
});
