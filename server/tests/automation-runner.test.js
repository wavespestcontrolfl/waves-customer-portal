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
// The per-customer prep-send lock a customer-linked step runs under:
// pass-through by default; a test flips it to "lease held elsewhere".
jest.mock('../utils/cron-lock', () => ({
  runExclusive: jest.fn(async (_name, fn) => fn()),
  wasLockSkipped: jest.requireActual('../utils/cron-lock').wasLockSkipped,
}));
// The new_lead consultation-booking block — mocked here so the runner's
// OWN behavior (skip when the placeholder is absent, read metadata.lead_id,
// splice the result into html/text) is under test, not the block's own
// eligibility rules (lead-consultation-email-block.test.js's contract).
jest.mock('../services/lead-consultation-email-block', () => ({
  buildConsultationEmailBlock: jest.fn(),
}));

const {
  renderAutomationStepContent,
  automationSuppressionGroupKey,
  automationSuppressionMatches,
  activeAutomationSuppressionFor,
  sendStep,
  enrollCustomer,
} = require('../services/automation-runner');
const db = require('../models/db');
const sendgrid = require('../services/sendgrid-mail');
const { buildConsultationEmailBlock } = require('../services/lead-consultation-email-block');

function chain({ result = [], first, returning, updateResult = 1 } = {}) {
  const q = {};
  [
    'where',
    'whereRaw',
    'whereIn',
    'whereNot',
    'join',
    'whereNotNull',
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
  // Customer-linked enrollments ride a customer-comms-locked transaction
  // (r21) — pass the queue-backed connection through with a raw stub for
  // the advisory lock.
  db.transaction = jest.fn(async (fn) => {
    const trx = (table) => db(table);
    trx.raw = jest.fn(async () => ({ rows: [] }));
    return fn(trx);
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
    expect(rendered.html).not.toContain('Waves Newsletter');
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
    expect(rendered.html).not.toContain('Waves Newsletter');
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

  test.each([
    { payment_issue_channels: ['sms', 'push'] },
    { payment_issue_channels: ['email', 'sms'], email_enabled: false },
    { payment_issue_channels: ['email'], email_enabled: false },
  ])('a queued payment-failed step honors the current Email choice and opt-out: %j', async (prefs) => {
    const enrollment = {
      id: 'enrollment-1', template_key: 'payment_failed', customer_id: 'cust-1', status: 'active',
      current_step: 0, email: 'customer@example.com', first_name: 'Sam', last_name: 'Customer',
    };
    const prefsRead = chain({ first: prefs });
    const sendUpdate = chain();
    const enrollmentUpdate = chain();
    setDbQueues({
      automation_enrollments: [chain({ first: enrollment }), chain({ first: enrollment }), enrollmentUpdate],
      automation_templates: [chain({ first: { key: 'payment_failed', name: 'Payment Failed', asm_group: 'service' } })],
      automation_steps: [chain({ result: [{ id: 'step-1', step_order: 0, subject: 'Payment issue',
        html_body: '<p>Please update payment.</p>', text_body: 'Please update payment.',
        from_email: 'automations@wavespestcontrol.com', enabled: true }] })],
      automation_step_sends: [chain({ returning: [{ id: 'send-1' }] }), sendUpdate],
      email_suppressions: [chain({ result: [] })],
      notification_prefs: [prefsRead],
    });

    await expect(sendStep('enrollment-1')).resolves.toEqual({
      sent: false, blocked: true, reason: 'Billing delivery preference excludes Email',
    });
    expect(prefsRead.first).toHaveBeenCalledWith();
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
    expect(sendUpdate.update).toHaveBeenCalledWith(expect.objectContaining({
      status: 'blocked', failure_reason: 'Billing delivery preference excludes Email',
    }));
    expect(enrollmentUpdate.update).toHaveBeenCalledWith(expect.objectContaining({
      status: 'cancelled', next_send_at: null,
    }));
  });

  test('a legacy NULL payment-issue choice still sends', async () => {
    const enrollment = {
      id: 'enrollment-1', template_key: 'payment_failed', customer_id: 'cust-1', status: 'active',
      current_step: 0, email: 'customer@example.com', first_name: 'Sam', last_name: 'Customer',
    };
    setDbQueues({
      automation_enrollments: [chain({ first: enrollment }), chain({ first: enrollment }), chain()],
      automation_templates: [chain({ first: { key: 'payment_failed', name: 'Payment Failed', asm_group: 'service' } })],
      automation_steps: [chain({ result: [{ id: 'step-1', step_order: 0, subject: 'Payment issue',
        html_body: '<p>Please update payment.</p>', text_body: 'Please update payment.',
        from_email: 'automations@wavespestcontrol.com', enabled: true }] })],
      automation_step_sends: [chain({ returning: [{ id: 'send-1' }] }), chain()],
      email_suppressions: [chain({ result: [] })],
      notification_prefs: [chain({ first: { payment_issue_channels: null } })],
    });
    sendgrid.sendOne.mockResolvedValue({ messageId: 'sg-legacy' });

    await expect(sendStep('enrollment-1')).resolves.toMatchObject({ sent: true, done: true });
    expect(sendgrid.sendOne).toHaveBeenCalledTimes(1);
  });
});

describe('automation runner prep sequence delivery stamp', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
    db.fn = { now: jest.fn(() => 'NOW()') };
  });

  const ENROLLMENT = (templateKey) => ({
    id: 'enrollment-1',
    status: 'active',
    template_key: templateKey,
    customer_id: 'cust-1',
    current_step: 0,
    email: 'megan@example.com',
    first_name: 'Megan',
    last_name: 'Example',
  });

  function queuesForSend({ templateKey, stampChain, lockedRow }) {
    const queues = {
      automation_enrollments: [
        chain({ first: ENROLLMENT(templateKey) }), // the pre-lock read
        chain({ first: lockedRow === undefined ? ENROLLMENT(templateKey) : lockedRow }), // the re-read under the lock
        chain({}),
      ],
      automation_templates: [
        chain({ first: { key: templateKey, name: templateKey, asm_group: 'service' } }),
      ],
      automation_steps: [
        chain({
          result: [{
            id: 'step-1',
            step_order: 0,
            subject: 'Your prep guide',
            html_body: '<p>Prep steps for {{first_name}}</p>',
            text_body: 'Prep steps',
            from_email: 'automations@wavespestcontrol.com',
            enabled: true,
          }],
        }),
      ],
      automation_step_sends: [
        chain({ returning: [{ id: 'send-1' }] }),
        chain({}),
      ],
      email_suppressions: [chain({ result: [] })],
    };
    if (stampChain) queues.scheduled_services = [stampChain];
    return queues;
  }

  test('a delivered step-0 prep guide stamps the token-bearing visit rows', async () => {
    const stampChain = chain({});
    setDbQueues(queuesForSend({ templateKey: 'flea', stampChain }));
    sendgrid.sendOne.mockResolvedValue({ messageId: 'sg-1' });

    const result = await sendStep('enrollment-1');

    expect(result.sent).toBe(true);
    expect(stampChain.where).toHaveBeenCalledWith({ customer_id: 'cust-1', prep_template_key: 'prep.flea' });
    expect(stampChain.update).toHaveBeenCalledWith({ prep_sent_at: 'NOW()' });
  });

  test('a customer-linked step runs under the customer\'s prep-send lock and re-reads the row inside it; a held lease skips this tick (pre-push Codex P1 on 2256101b7)', async () => {
    const { runExclusive } = require('../utils/cron-lock');
    setDbQueues(queuesForSend({ templateKey: 'flea', stampChain: chain({}) }));
    sendgrid.sendOne.mockResolvedValue({ messageId: 'sg-1' });
    expect((await sendStep('enrollment-1')).sent).toBe(true);
    expect(runExclusive).toHaveBeenCalledWith('prep-send:cust-1', expect.any(Function), { recordHealth: false, waitForSlot: false });
    // Both reads happened: the second is the one the send trusts.
    expect(db).toHaveBeenCalledWith('automation_enrollments');
    expect(db.mock.calls.filter(([t]) => t === 'automation_enrollments').length).toBeGreaterThanOrEqual(2);

    // Lease held (a manual / composer prep delivery is settling this
    // customer): nothing is sent, the row stays due for the next tick.
    runExclusive.mockResolvedValueOnce({ skipped: true, reason: 'lease_held' });
    sendgrid.sendOne.mockClear();
    setDbQueues(queuesForSend({ templateKey: 'flea' }));
    expect(await sendStep('enrollment-1')).toEqual({ sent: false, skipped: true, reason: 'lease_held' });
    expect(sendgrid.sendOne).not.toHaveBeenCalled();

    // The re-read finds the row already settled — advanced onto its
    // follow-up step with next_send_at days out: the follow-up is NOT sent
    // now (the tick picked the row when step 0 was due), and nothing is
    // written.
    sendgrid.sendOne.mockClear();
    const settled = { ...ENROLLMENT('flea'), current_step: 1, next_send_at: new Date(Date.now() + 72 * 3600 * 1000) };
    const q = queuesForSend({ templateKey: 'flea', lockedRow: settled });
    q.automation_steps = [chain({ result: [
      { id: 'step-1', step_order: 0, enabled: true, subject: 'Prep', html_body: '<p>a</p>', text_body: 'a', from_email: 'automations@wavespestcontrol.com' },
      { id: 'step-2', step_order: 1, delay_hours: 72, enabled: true, subject: 'Follow-up', html_body: '<p>b</p>', text_body: 'b', from_email: 'automations@wavespestcontrol.com' },
    ] })];
    const [, , enrollmentWrite] = q.automation_enrollments;
    const [sendInsert] = q.automation_step_sends;
    setDbQueues(q);
    expect(await sendStep('enrollment-1')).toEqual({ sent: false, skipped: true, reason: 'not_due' });
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
    expect(enrollmentWrite.update).not.toHaveBeenCalled();
    expect(sendInsert.insert).not.toHaveBeenCalled();

    // A test send keeps ignoring the schedule.
    setDbQueues(queuesForSend({ templateKey: 'flea', lockedRow: { ...ENROLLMENT('flea'), next_send_at: new Date(Date.now() + 72 * 3600 * 1000) } }));
    sendgrid.sendOne.mockResolvedValue({ messageId: 'sg-t' });
    expect((await sendStep('enrollment-1', { testRecipient: 'qa@wavespestcontrol.com' })).sent).toBe(true);
  });

  test('a failed send marks the enrolment failed only on the step this attempt was for', async () => {
    setDbQueues(queuesForSend({ templateKey: 'cold_lead' }));
    sendgrid.sendOne.mockRejectedValue(new Error('provider down'));
    const out = await sendStep('enrollment-1');
    expect(out.sent).toBe(false);
    const failWrite = db.mock.results.map((r) => r.value).find((v) => v && v.update && v.update.mock.calls.some(([p]) => p && p.status === 'failed' && p.next_send_at === null));
    expect(failWrite.where).toHaveBeenCalledWith({ id: 'enrollment-1', current_step: 0 });
  });

  test('non-prep sequences never touch the visit rows', async () => {
    // No scheduled_services queue: a stamp attempt would throw
    // "Unexpected db table" and fail this test.
    setDbQueues(queuesForSend({ templateKey: 'cold_lead' }));
    sendgrid.sendOne.mockResolvedValue({ messageId: 'sg-1' });

    const result = await sendStep('enrollment-1');

    expect(result.sent).toBe(true);
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
      // Post-lock revalidation re-read (r22): the row carries the same
      // address the caller passed, so the enrollment proceeds.
      customers: [chain({ first: { id: 'cust-1', email: 'new@example.com', deleted_at: null } })],
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

  test('refuses an enrollment whose address NOW belongs to another live customer (stale pre-undo snapshot, r22)', async () => {
    // The caller read the winner carrying the merged-in email, then blocked
    // on the comms lock while an undo cleared it and restored the loser at
    // that address. The post-lock revalidation must refuse — never enroll
    // the winner's sequence into the restored loser's mailbox. Deliberately
    // different-by-design addresses (a requester's, a tenant's) are not
    // customer rows and still enroll.
    const { enrollCustomer } = require('../services/automation-runner');
    setDbQueues({
      automation_templates: [chain({ first: { key: 'flea', name: 'Flea Treatment', enabled: true } })],
      automation_steps: [chain({ result: [{ id: 'step-1', step_order: 0, delay_hours: 0, enabled: true }] })],
      customers: [
        // Post-lock re-read: the undo cleared the winner's inherited email.
        chain({ first: { id: 'cust-1', email: null, deleted_at: null } }),
      ],
      // Joined undone-holder existence query (r31): a live holder who IS
      // the restored loser of an undone merge with this winner.
      'customers as c': [chain({ first: { id: 'cust-loser' } })],
    });
    const result = await enrollCustomer({
      templateKey: 'flea',
      customer: { id: 'cust-1', email: 'inherited@example.com', first_name: 'Megan' },
    });
    expect(result).toEqual({ enrolled: false, reason: 'address was restored to the merged-away customer by an undo (stale pre-undo address)' });
  });

  test('a SUPPORTED shared/different-by-design address still enrolls — another holder with NO undone-merge link is not staleness (r30)', async () => {
    const { enrollCustomer } = require('../services/automation-runner');
    const reactivateUpdate = chain();
    reactivateUpdate.update = jest.fn(() => reactivateUpdate);
    reactivateUpdate.returning = jest.fn(async () => [{ id: 'enr-2' }]);
    setDbQueues({
      automation_templates: [chain({ first: { key: 'flea', name: 'Flea Treatment', enabled: true } })],
      automation_steps: [chain({ result: [{ id: 'step-1', step_order: 0, delay_hours: 0, enabled: true }] })],
      customers: [
        // Row's own email differs (tenant-under-landlord shape)...
        chain({ first: { id: 'cust-1', email: 'landlord@example.com', deleted_at: null } }),
      ],
      // The tenant has their own live record but NO undone-merge link to
      // cust-1 — the joined existence query finds nothing: supported.
      'customers as c': [chain({ first: undefined })],
      automation_enrollments: [
        chain({ first: { id: 'enr-2', status: 'completed', email: 'old@example.com' } }),
        reactivateUpdate,
      ],
    });
    const result = await enrollCustomer({
      templateKey: 'flea',
      customer: { id: 'cust-1', email: 'tenant@example.com', first_name: 'Tessa' },
    });
    expect(result).toEqual({ enrolled: true, enrollmentId: 'enr-2' });
  });
});

// Owner ruling (2026-07-13, renewal-reminder.js): "renewal" language is
// reserved for termite bonds. The Automations-tab service_renewal template
// (Codex #4874 r2 P1) now renders a termite-bond renewal ask, so every
// enrollment path (manual trigger, segment send, executeAutomation) must
// refuse it for a customer with no termite_renewal_date on file.
describe('enrollCustomer — service_renewal is restricted to termite-bond customers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
  });

  test('a termite-bond customer enrolls', async () => {
    // Customer-linked inserts are an ON CONFLICT upsert (see the
    // customer-only new_lead describe block below for the same shape).
    const insertChain = chain();
    insertChain.returning = jest.fn(() => insertChain);
    insertChain.onConflict = jest.fn(() => insertChain);
    insertChain.merge = jest.fn(async () => [{ id: 'enr-bond' }]);
    setDbQueues({
      automation_templates: [chain({ first: { key: 'service_renewal', name: 'Termite Bond Renewal', enabled: true } })],
      automation_steps: [chain({ result: [{ id: 'step-1', step_order: 0, delay_hours: 0, enabled: true }] })],
      // Post-lock re-read carries the column — a bond customer has it set.
      customers: [chain({ first: { id: 'cust-bond', email: 'bond@example.com', first_name: 'Robin', last_name: null, deleted_at: null, termite_renewal_date: '2026-11-01' } })],
      automation_enrollments: [
        chain({ first: undefined }),
        insertChain,
      ],
    });

    const result = await enrollCustomer({
      templateKey: 'service_renewal',
      customer: { id: 'cust-bond', email: 'bond@example.com', first_name: 'Robin' },
    });

    expect(result).toEqual({ enrolled: true, enrollmentId: 'enr-bond' });
  });

  test('a non-bond customer is refused with reason not_termite_bond', async () => {
    setDbQueues({
      automation_templates: [chain({ first: { key: 'service_renewal', name: 'Termite Bond Renewal', enabled: true } })],
      automation_steps: [chain({ result: [{ id: 'step-1', step_order: 0, delay_hours: 0, enabled: true }] })],
      // No termite_renewal_date on the post-lock row — refused before any
      // automation_enrollments query runs.
      customers: [chain({ first: { id: 'cust-nobond', email: 'nobond@example.com', first_name: 'Jamie', last_name: null, deleted_at: null, termite_renewal_date: null } })],
    });

    const result = await enrollCustomer({
      templateKey: 'service_renewal',
      customer: { id: 'cust-nobond', email: 'nobond@example.com', first_name: 'Jamie' },
    });

    expect(result).toEqual({ enrolled: false, reason: 'not_termite_bond' });
  });

  test('a lead-email-only enrollment (no customer row) is refused too', async () => {
    setDbQueues({
      automation_templates: [chain({ first: { key: 'service_renewal', name: 'Termite Bond Renewal', enabled: true } })],
    });

    const result = await enrollCustomer({
      templateKey: 'service_renewal',
      customer: { email: 'lead@example.com', first_name: 'Sam' },
    });

    expect(result).toEqual({ enrolled: false, reason: 'not_termite_bond' });
  });

  test('a different template is unaffected by the restriction', async () => {
    const insertChain = chain();
    insertChain.returning = jest.fn(() => insertChain);
    insertChain.onConflict = jest.fn(() => insertChain);
    insertChain.merge = jest.fn(async () => [{ id: 'enr-other' }]);
    setDbQueues({
      automation_templates: [chain({ first: { key: 'new_lead', name: 'New Lead', enabled: true } })],
      automation_steps: [chain({ result: [{ id: 'step-1', step_order: 0, delay_hours: 0, enabled: true }] })],
      customers: [chain({ first: { id: 'cust-other', email: 'noterm@example.com', first_name: 'Dee', last_name: null, deleted_at: null, termite_renewal_date: null } })],
      automation_enrollments: [
        chain({ first: undefined }),
        insertChain,
      ],
    });

    const result = await enrollCustomer({
      templateKey: 'new_lead',
      customer: { id: 'cust-other', email: 'noterm@example.com', first_name: 'Dee' },
    });

    expect(result).toEqual({ enrolled: true, enrollmentId: 'enr-other' });
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

describe('advanceEnrollment', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  test('loads the enabled steps when the caller has none, schedules the next step from its delay, and fences the write on the step it saw', async () => {
    const { advanceEnrollment } = require('../services/automation-runner');
    const update = chain();
    setDbQueues({
      automation_steps: [chain({ result: [
        { id: 'step-1', step_order: 0, delay_hours: 0, enabled: true },
        { id: 'step-2', step_order: 1, delay_hours: 72, enabled: true },
      ] })],
      automation_enrollments: [update],
    });
    const before = Date.now();
    const out = await advanceEnrollment({ id: 'enr-1', template_key: 'flea', current_step: 0 });
    expect(out).toMatchObject({ sent: true, done: false });
    // A concurrent settler of the same step (the tick vs a manual /
    // composer prep delivery) cannot advance it twice.
    expect(update.where).toHaveBeenCalledWith({ id: 'enr-1', current_step: 0 });
    const patch = update.update.mock.calls[0][0];
    expect(patch.current_step).toBe(1);
    expect(patch.next_send_at.getTime()).toBeGreaterThanOrEqual(before + 72 * 3600 * 1000);
  });

  test('completes the enrolment when no enabled step remains', async () => {
    const { advanceEnrollment } = require('../services/automation-runner');
    const update = chain();
    setDbQueues({ automation_enrollments: [update] });
    const out = await advanceEnrollment({ id: 'enr-1', template_key: 'flea', current_step: 0 }, [{ id: 'step-1', step_order: 0 }]);
    expect(out).toMatchObject({ sent: true, done: true });
    expect(update.where).toHaveBeenCalledWith({ id: 'enr-1', current_step: 0 });
    expect(update.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed', next_send_at: null, current_step: 1 }));
  });
});

describe('renderAutomationStepContent — consultation-booking placeholders', () => {
  test('splices consultationHtml/consultationText into their placeholders', () => {
    const rendered = renderAutomationStepContent({
      template: { asm_group: 'service' },
      htmlBody: '<h2>Hi {{first_name}}</h2>{{consultation_booking}}<h2>What\'s next</h2>',
      textBody: 'Hi {{first_name}}. {{consultation_booking_text}} Reply with your address.',
      customer: { first_name: 'Sam', email: 'sam@example.com' },
      consultationHtml: '<p>3 open slots</p>',
      consultationText: 'Pick a time: https://example.com/x',
    });
    expect(rendered.html).toContain('<p>3 open slots</p>');
    expect(rendered.text).toContain('Pick a time: https://example.com/x');
  });

  test('defaults both placeholders to empty when omitted (existing callers, e.g. testSequence)', () => {
    const rendered = renderAutomationStepContent({
      template: { asm_group: 'service' },
      htmlBody: '<h2>Hi</h2>{{consultation_booking}}<p>after</p>',
      textBody: '{{consultation_booking_text}} after',
      customer: { email: 'sam@example.com' },
    });
    expect(rendered.html).toContain('<h2>Hi</h2><p>after</p>');
    expect(rendered.text.trim()).toBe('after');
  });
});

describe('enrollCustomer — context.leadId persists on automation_enrollments.metadata', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
  });

  test('a fresh enrollment stamps metadata.lead_id as a plain JSON insert', async () => {
    const insertChain = chain({ returning: [{ id: 'enr-new' }] });
    setDbQueues({
      automation_templates: [chain({ first: { key: 'new_lead', name: 'New Lead', enabled: true } })],
      automation_steps: [chain({ result: [{ id: 'step-1', step_order: 0, delay_hours: 0, enabled: true }] })],
      automation_enrollments: [
        chain({ first: undefined }), // no prior enrollment
        insertChain,
      ],
    });

    const result = await enrollCustomer({
      templateKey: 'new_lead',
      customer: { email: 'lead@example.com', first_name: 'Sam' },
      context: { leadId: 'lead-123' },
    });

    expect(result).toEqual({ enrolled: true, enrollmentId: 'enr-new' });
    const inserted = insertChain.insert.mock.calls[0][0];
    expect(inserted.metadata).toBe(JSON.stringify({ lead_id: 'lead-123' }));
  });

  test('reactivating a prior enrollment MERGES lead_id via jsonb_set — never overwrites the whole metadata object', async () => {
    const reactivateUpdate = chain();
    reactivateUpdate.update = jest.fn(() => reactivateUpdate);
    reactivateUpdate.returning = jest.fn(async () => [{ id: 'enr-1' }]);
    setDbQueues({
      automation_templates: [chain({ first: { key: 'new_lead', name: 'New Lead', enabled: true } })],
      automation_steps: [chain({ result: [{ id: 'step-1', step_order: 0, delay_hours: 0, enabled: true }] })],
      automation_enrollments: [
        chain({ first: { id: 'enr-1', status: 'cancelled', email: 'lead@example.com' } }),
        reactivateUpdate,
      ],
    });

    await enrollCustomer({
      templateKey: 'new_lead',
      customer: { email: 'lead@example.com', first_name: 'Sam' },
      context: { leadId: 'lead-456' },
    });

    const patch = reactivateUpdate.update.mock.calls[0][0];
    expect(patch.metadata).toEqual({ sql: expect.stringContaining('jsonb_set'), bindings: [JSON.stringify('lead-456')] });
    // Table-qualified: the same payload is the ON CONFLICT merge, where a
    // bare `metadata` is ambiguous with EXCLUDED (Codex #4813 r4 P1).
    expect(patch.metadata.sql).toContain('automation_enrollments.metadata');
    expect(patch.metadata.sql).not.toMatch(/\(metadata,/);
  });

  test('a context-free reactivation DROPS a prior episode\'s lead_id, keeping unrelated metadata (Codex #4813 r1 P2)', async () => {
    const reactivateUpdate = chain();
    reactivateUpdate.update = jest.fn(() => reactivateUpdate);
    reactivateUpdate.returning = jest.fn(async () => [{ id: 'enr-1' }]);
    setDbQueues({
      automation_templates: [chain({ first: { key: 'new_lead', name: 'New Lead', enabled: true } })],
      automation_steps: [chain({ result: [{ id: 'step-1', step_order: 0, delay_hours: 0, enabled: true }] })],
      automation_enrollments: [
        chain({ first: { id: 'enr-1', status: 'completed', email: 'lead@example.com', metadata: { lead_id: 'lead-A', cancel_reason: 'x' } } }),
        reactivateUpdate,
      ],
    });

    await enrollCustomer({ templateKey: 'new_lead', customer: { email: 'lead@example.com' } });

    const patch = reactivateUpdate.update.mock.calls[0][0];
    expect(patch.metadata).toEqual({ sql: expect.stringContaining("- 'lead_id'"), bindings: undefined });
    expect(patch.metadata.sql).toContain('automation_enrollments.metadata');
    expect(patch.metadata.sql).not.toContain('jsonb_set');
  });

  test('no context.leadId leaves metadata untouched (byte-identical to every pre-existing enroll site)', async () => {
    const insertChain = chain({ returning: [{ id: 'enr-new' }] });
    setDbQueues({
      automation_templates: [chain({ first: { key: 'cold_lead', name: 'Cold Lead', enabled: true } })],
      automation_steps: [chain({ result: [{ id: 'step-1', step_order: 0, delay_hours: 0, enabled: true }] })],
      automation_enrollments: [
        chain({ first: undefined }),
        insertChain,
      ],
    });

    await enrollCustomer({
      templateKey: 'cold_lead',
      customer: { email: 'lead@example.com' },
    });

    const inserted = insertChain.insert.mock.calls[0][0];
    expect(inserted.metadata).toBeUndefined();
  });
});

describe('enrollCustomer — customer-only new_lead enrolls resolve the lead id', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
  });

  const CUSTOMER = { id: 'cust-1', email: 'Lead@Example.com', first_name: 'Sam' };

  function customerLinkedQueues({ templateKey = 'new_lead', leads } = {}) {
    // Customer-linked inserts are an ON CONFLICT upsert.
    const insertChain = chain();
    insertChain.returning = jest.fn(() => insertChain);
    insertChain.onConflict = jest.fn(() => insertChain);
    insertChain.merge = jest.fn(async () => [{ id: 'enr-new' }]);
    const queues = {
      automation_templates: [chain({ first: { key: templateKey, name: 'T', enabled: true } })],
      automation_steps: [chain({ result: [{ id: 'step-1', step_order: 0, delay_hours: 0, enabled: true }] })],
      customers: [chain({ first: { id: 'cust-1', email: 'lead@example.com', first_name: 'Sam', last_name: null, deleted_at: null } })],
      automation_enrollments: [chain({ first: undefined }), insertChain],
    };
    if (leads) queues.leads = leads;
    setDbQueues(queues);
    return insertChain;
  }

  test('an admin/dispatcher enroll (no leadId key) stamps the customer\'s newest open lead for the recipient', async () => {
    const leadsChain = chain({ first: { id: 'lead-open' } });
    const insertChain = customerLinkedQueues({ leads: [leadsChain] });

    const result = await enrollCustomer({ templateKey: 'new_lead', customer: CUSTOMER });

    expect(result).toEqual({ enrolled: true, enrollmentId: 'enr-new' });
    expect(leadsChain.where).toHaveBeenCalledWith({ customer_id: 'cust-1' });
    expect(leadsChain.whereNull).toHaveBeenCalledWith('deleted_at');
    expect(leadsChain.whereRaw).toHaveBeenCalledWith('lower(email) = ?', ['lead@example.com']);
    expect(leadsChain.whereIn).toHaveBeenCalledWith('status', expect.arrayContaining(['new', 'contacted']));
    expect(leadsChain.whereNull).toHaveBeenCalledWith('converted_at');
    expect(leadsChain.orderBy).toHaveBeenCalledWith('created_at', 'desc');
    expect(insertChain.insert.mock.calls[0][0].metadata).toBe(JSON.stringify({ lead_id: 'lead-open' }));
  });

  test('no open lead for the recipient enrolls without a lead id', async () => {
    const insertChain = customerLinkedQueues({ leads: [chain({ first: undefined })] });

    await enrollCustomer({ templateKey: 'new_lead', customer: CUSTOMER });

    expect(insertChain.insert.mock.calls[0][0].metadata).toBeUndefined();
  });

  test('a failed lead lookup fails soft — the enrollment still lands, without a lead id', async () => {
    const broken = chain();
    broken.first = jest.fn(async () => { throw new Error('boom'); });
    const insertChain = customerLinkedQueues({ leads: [broken] });

    const result = await enrollCustomer({ templateKey: 'new_lead', customer: CUSTOMER });

    expect(result).toEqual({ enrolled: true, enrollmentId: 'enr-new' });
    expect(insertChain.insert.mock.calls[0][0].metadata).toBeUndefined();
  });

  test('a lead-aware caller passing leadId: null keeps its decision — no lookup', async () => {
    // No `leads` queue: any lookup would throw "Unexpected db table leads".
    const insertChain = customerLinkedQueues();

    await enrollCustomer({ templateKey: 'new_lead', customer: CUSTOMER, context: { leadId: null } });

    expect(insertChain.insert.mock.calls[0][0].metadata).toBeUndefined();
  });

  test('other templates never look a lead up', async () => {
    const insertChain = customerLinkedQueues({ templateKey: 'cold_lead' });

    await enrollCustomer({ templateKey: 'cold_lead', customer: CUSTOMER });

    expect(insertChain.insert.mock.calls[0][0].metadata).toBeUndefined();
  });
});

describe('sendStepLocked (via sendStep) — consultation-booking block wiring', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
    sendgrid.isConfigured = jest.fn(() => true);
  });

  const ENROLLMENT_WITH_LEAD = {
    id: 'enrollment-lead-1',
    status: 'active',
    template_key: 'new_lead',
    customer_id: null,
    current_step: 0,
    email: 'lead@example.com',
    first_name: 'Sam',
    last_name: 'Lead',
    metadata: { lead_id: 'lead-789' },
  };

  function queuesForNewLeadSend(step) {
    return {
      automation_enrollments: [
        chain({ first: ENROLLMENT_WITH_LEAD }), // sendStep's `pre` read (no customer_id -> no lock)
        chain({}), // advanceEnrollment's completion update
      ],
      automation_templates: [chain({ first: { key: 'new_lead', name: 'New Lead', asm_group: 'service' } })],
      automation_steps: [chain({ result: [step] })],
      automation_step_sends: [chain({ returning: [{ id: 'send-1' }] }), chain({})],
      email_suppressions: [chain({ result: [] })],
    };
  }

  test('a step body carrying the placeholder builds the block from metadata.lead_id and splices it in', async () => {
    buildConsultationEmailBlock.mockResolvedValue({ html: '<p>3 slots</p>', text: 'Pick a time: https://x' });
    setDbQueues(queuesForNewLeadSend({
      id: 'step-1', step_order: 0, subject: 'Hi {{first_name}}',
      html_body: '<h2>Hi {{first_name}}</h2>{{consultation_booking}}',
      text_body: 'Hi {{first_name}}. {{consultation_booking_text}}',
      from_email: 'automations@wavespestcontrol.com', enabled: true,
    }));
    sendgrid.sendOne.mockResolvedValue({ messageId: 'sg-1' });

    const result = await sendStep('enrollment-lead-1');

    expect(result.sent).toBe(true);
    expect(buildConsultationEmailBlock).toHaveBeenCalledWith({ leadId: 'lead-789', recipientEmail: 'lead@example.com' });
    const sentArgs = sendgrid.sendOne.mock.calls[0][0];
    expect(sentArgs.html).toContain('<p>3 slots</p>');
    expect(sentArgs.text).toContain('Pick a time: https://x');
  });

  test('a testRecipient send checks the block against the ACTUAL recipient, not the enrollment address', async () => {
    buildConsultationEmailBlock.mockResolvedValue({ html: '', text: '' });
    setDbQueues(queuesForNewLeadSend({
      id: 'step-1', step_order: 0, subject: 'Hi {{first_name}}',
      html_body: '<h2>Hi {{first_name}}</h2>{{consultation_booking}}',
      text_body: 'Hi {{first_name}}. {{consultation_booking_text}}',
      from_email: 'automations@wavespestcontrol.com', enabled: true,
    }));
    sendgrid.sendOne.mockResolvedValue({ messageId: 'sg-t' });

    await sendStep('enrollment-lead-1', { testRecipient: 'operator@wavespestcontrol.com' });

    expect(buildConsultationEmailBlock).toHaveBeenCalledWith({ leadId: 'lead-789', recipientEmail: 'operator@wavespestcontrol.com' });
    expect(sendgrid.sendOne.mock.calls[0][0].to).toBe('operator@wavespestcontrol.com');
  });

  test('the spaced form {{ consultation_booking }} still builds the block (Codex #4813 r4 P2)', async () => {
    buildConsultationEmailBlock.mockResolvedValue({ html: '<p>3 slots</p>', text: 'Pick a time: https://x' });
    setDbQueues(queuesForNewLeadSend({
      id: 'step-1', step_order: 0, subject: 'Hi {{first_name}}',
      html_body: '<h2>Hi {{first_name}}</h2>{{ consultation_booking }}',
      text_body: 'Hi {{first_name}}. {{ consultation_booking_text }}',
      from_email: 'automations@wavespestcontrol.com', enabled: true,
    }));
    sendgrid.sendOne.mockResolvedValue({ messageId: 'sg-sp' });

    await sendStep('enrollment-lead-1');

    expect(buildConsultationEmailBlock).toHaveBeenCalledTimes(1);
    const sentArgs = sendgrid.sendOne.mock.calls[0][0];
    expect(sentArgs.html).toContain('<p>3 slots</p>');
    expect(sentArgs.text).toContain('Pick a time: https://x');
  });

  test('a hidden block leaves the body byte-identical to the pre-placeholder original (separator consumed)', async () => {
    buildConsultationEmailBlock.mockResolvedValue({ html: '', text: '' });
    setDbQueues(queuesForNewLeadSend({
      id: 'step-1', step_order: 0, subject: 'Hi',
      html_body: "<h2>Hi</h2>\n{{consultation_booking}}\n<h2>What's next</h2>",
      text_body: 'Hi. {{consultation_booking_text}}\nReply with your address.',
      from_email: 'automations@wavespestcontrol.com', enabled: true,
    }));
    sendgrid.sendOne.mockResolvedValue({ messageId: 'sg-h' });
    await sendStep('enrollment-lead-1');
    const sentArgs = sendgrid.sendOne.mock.calls[0][0];
    expect(sentArgs.html).toContain("<h2>Hi</h2>\n<h2>What's next</h2>");
    expect(sentArgs.text).toContain('Hi. Reply with your address.');
  });

  test('a shown block keeps exactly one separator before the anchor', async () => {
    buildConsultationEmailBlock.mockResolvedValue({ html: '<p>3 slots</p>', text: 'Pick a time: https://x' });
    setDbQueues(queuesForNewLeadSend({
      id: 'step-1', step_order: 0, subject: 'Hi',
      html_body: "<h2>Hi</h2>\n{{consultation_booking}}\n<h2>What's next</h2>",
      text_body: 'Hi. {{consultation_booking_text}}\nReply with your address.',
      from_email: 'automations@wavespestcontrol.com', enabled: true,
    }));
    sendgrid.sendOne.mockResolvedValue({ messageId: 'sg-s' });
    await sendStep('enrollment-lead-1');
    const sentArgs = sendgrid.sendOne.mock.calls[0][0];
    expect(sentArgs.html).toContain("<p>3 slots</p>\n<h2>What's next</h2>");
    expect(sentArgs.text).toContain('Hi. Pick a time: https://x\nReply with your address.');
  });

  test('a step body with NO placeholder never calls buildConsultationEmailBlock', async () => {
    setDbQueues(queuesForNewLeadSend({
      id: 'step-1', step_order: 0, subject: 'Hi {{first_name}}',
      html_body: '<h2>Hi {{first_name}}</h2><p>no block here</p>',
      text_body: 'Hi {{first_name}}. Plain text.',
      from_email: 'automations@wavespestcontrol.com', enabled: true,
    }));
    sendgrid.sendOne.mockResolvedValue({ messageId: 'sg-2' });

    const result = await sendStep('enrollment-lead-1');

    expect(result.sent).toBe(true);
    expect(buildConsultationEmailBlock).not.toHaveBeenCalled();
  });

  test('a placeholder present but no metadata.lead_id renders empty without calling the block builder', async () => {
    setDbQueues({
      automation_enrollments: [
        chain({ first: { ...ENROLLMENT_WITH_LEAD, metadata: {} } }),
        chain({}),
      ],
      automation_templates: [chain({ first: { key: 'new_lead', name: 'New Lead', asm_group: 'service' } })],
      automation_steps: [chain({ result: [{
        id: 'step-1', step_order: 0, subject: 'Hi',
        html_body: '<h2>Hi</h2>{{consultation_booking}}',
        text_body: 'Hi. {{consultation_booking_text}}',
        from_email: 'automations@wavespestcontrol.com', enabled: true,
      }] })],
      automation_step_sends: [chain({ returning: [{ id: 'send-3' }] }), chain({})],
      email_suppressions: [chain({ result: [] })],
    });
    sendgrid.sendOne.mockResolvedValue({ messageId: 'sg-3' });

    const result = await sendStep('enrollment-lead-1');

    expect(result.sent).toBe(true);
    expect(buildConsultationEmailBlock).not.toHaveBeenCalled();
    const sentArgs = sendgrid.sendOne.mock.calls[0][0];
    expect(sentArgs.html).not.toContain('{{consultation_booking}}');
  });
});
