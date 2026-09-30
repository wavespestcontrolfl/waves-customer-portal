/**
 * Automation executor -> email division ledger dispatch, on real PostgreSQL.
 *
 * The executor routes the email division's own template keys (nurture.* ->
 * ledger stream 'nurture', lc.* -> 'lifecycle') through sendWithLedger and
 * lifts the library's ledger_required fence for that path only. Nothing in
 * this suite needs a seeded automation row: synthetic
 * probe templates carry the two prefixes, a custom trigger key fires them, and
 * the payload is whatever the trigger carries.
 *
 * Only the provider edge is mocked (sendTemplate, run the way the library runs
 * the ledger's locked handoff; the shadow preflight's library call). The
 * ledger, eligibility reads and the executor's run rows are real.
 *
 * Self-skips without DATABASE_URL (run after `knex migrate:latest`).
 */
const { randomUUID } = require('node:crypto');

jest.mock('../services/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock('../services/email-template-library', () => ({
  ...jest.requireActual('../services/email-template-library'),
  sendTemplate: jest.fn(),
  preflightTemplateSend: jest.fn(async () => ({ ok: true })),
}));

const SKIP = !process.env.DATABASE_URL;
if (!SKIP) {
  // Writes synthetic rows: only ever against a local QA database or CI's.
  const url = new URL(process.env.DATABASE_URL);
  if (!['localhost', '127.0.0.1'].includes(url.hostname) || !/^\/(waves_test|(waves_)?qa_[a-z0-9_]+)$/.test(url.pathname)) {
    throw new Error('Email division dispatch tests need a local QA database (qa_* / waves_qa_*) or waves_test.');
  }
}
const describeOrSkip = SKIP ? describe.skip : describe;

// The library's locked handoff, as the stand-in sendTemplate runs it: the
// boundary check is awaited inside `dispatch`; its veto is a definite non-send.
// `beforeHandoff` lets a test change the world between the reservation and the
// provider boundary.
function libraryLike({ beforeHandoff = null } = {}) {
  return async (args) => {
    if (beforeHandoff) await beforeHandoff(args);
    let dispatched = false;
    let vetoed = false;
    const verdict = await args.withProviderHandoff(async (database, boundaryCheck) => {
      try {
        await boundaryCheck({ database });
      } catch (err) {
        if (!err.providerBoundaryBlocked) throw err;
        vetoed = true;
        return;
      }
      dispatched = true;
    });
    if (verdict?.ok !== true || vetoed) return { sent: false, aborted: true, reason: 'aborted_by_caller_before_dispatch' };
    if (!dispatched) throw new Error('handoff returned without dispatching');
    if (args.onQueued) args.onQueued();
    // A real delivery-authority row (the run and ledger rows FK to it).
    const db = require('../models/db');
    const [message] = await db('email_messages').insert({
      recipient_email_snapshot: args.to, template_key: args.templateKey, idempotency_key: args.idempotencyKey,
      status: 'sent', sent_at: new Date(), provider_message_id: 'sg-synthetic', automation_run_id: args.automationRunId || null,
    }).returning('*');
    return { sent: true, providerAccepted: true, message };
  };
}

describeOrSkip('executor -> email division ledger dispatch (Postgres)', () => {
  jest.setTimeout(60000);
  let db;
  let Executor;
  let Ledger;
  let sendTemplate;
  let preflightTemplateSend;
  let customerEmails = [];
  const created = {
    customers: [], estimates: [], automations: [], templates: [],
  };

  beforeAll(() => {
    db = require('../models/db');
    Executor = require('../services/email-template-automation-executor');
    Ledger = require('../services/email-division/ledger');
    ({ sendTemplate, preflightTemplateSend } = require('../services/email-template-library'));
  });

  afterEach(async () => {
    delete process.env.GATE_EMAIL_TEMPLATE_AUTOMATIONS;
    sendTemplate.mockReset();
    preflightTemplateSend.mockReset();
    preflightTemplateSend.mockImplementation(async () => ({ ok: true }));
    const {
      customers, estimates, automations, templates,
    } = created;
    if (automations.length) {
      const runs = await db('email_template_automation_runs').whereIn('automation_key', automations).select('id');
      await db('email_template_automation_run_events').whereIn('run_id', runs.map((r) => r.id)).del();
      await db('email_template_automation_runs').whereIn('automation_key', automations).del();
      await db('email_template_automations').whereIn('automation_key', automations).del();
    }
    if (customers.length) await db('marketing_email_ledger').whereIn('customer_id', customers).del();
    await db('email_messages').whereIn('recipient_email_snapshot', customerEmails).del();
    if (estimates.length) await db('estimates').whereIn('id', estimates).del();
    if (customers.length) {
      await db('notification_prefs').whereIn('customer_id', customers).del();
      await db('customers').whereIn('id', customers).del();
    }
    if (templates.length) await db('email_templates').whereIn('template_key', templates).del();
    Object.keys(created).forEach((k) => { created[k] = []; });
    customerEmails = [];
  });

  afterAll(async () => {
    await db.destroy();
  });

  // ---- fixtures ----------------------------------------------------------

  async function makeCustomer(overrides = {}) {
    const id = randomUUID();
    const email = `${id}@example.invalid`;
    await db('customers').insert({
      id, first_name: 'Jordan', last_name: 'Sample', phone: `+1941555${String(Math.floor(Math.random() * 9000) + 1000)}`,
      email, active: true, pipeline_stage: 'active_customer', ...overrides,
    });
    await db('notification_prefs').insert({ customer_id: id, email_enabled: true, marketing_offers: true });
    // The nurture stream's audience is a customer with an estimate on file.
    const estimateId = randomUUID();
    await db('estimates').insert({ id: estimateId, customer_id: id, status: 'expired', token: `qa-${randomUUID()}` });
    created.customers.push(id);
    created.estimates.push(estimateId);
    customerEmails.push(email);
    return { id, email };
  }

  // A synthetic template carrying an email-division prefix: no builder knows it.
  async function makeTemplate(prefix, group, mode = 'service') {
    const key = `${prefix}qa_probe_${randomUUID().slice(0, 8)}`;
    await db('email_templates').insert({
      template_key: key, name: key, status: 'draft', send_stream: group, suppression_group_key: group, mode,
    });
    created.templates.push(key);
    return key;
  }

  async function makeAutomation(templateKey, group) {
    const key = `qa_dispatch_${randomUUID().slice(0, 8)}`;
    const event = `qa.dispatch.${key}`;
    const [row] = await db('email_template_automations').insert({
      automation_key: key, name: key, trigger_event_key: event, template_key: templateKey, delay_minutes: 0, audience: 'customer',
      status: 'active', suppression_group_key: group, idempotency_key_template: `${key}:{trigger_event_id}`,
      retry_policy: JSON.stringify({ max_attempts: 2, backoff_minutes: [15, 60] }),
      conditions: JSON.stringify({}), exit_conditions: JSON.stringify({}),
    }).returning('*');
    created.automations.push(key);
    return row;
  }

  const nurture = async () => makeAutomation(await makeTemplate('nurture.', 'marketing_nurture'), 'marketing_nurture');
  const lifecycle = async () => makeAutomation(await makeTemplate('lc.', 'service_operational'), 'service_operational');

  const fire = (automation, customer, extra = {}) => Executor.processTrigger({
    triggerEventKey: automation.trigger_event_key,
    triggerEventId: extra.eventId || `evt-${randomUUID().slice(0, 8)}`,
    automationKey: automation.automation_key,
    recipient: { type: 'customer', id: customer.id, email: extra.email || customer.email },
    payload: { customer_id: customer.id, customer_email: extra.email || customer.email, first_name: 'Jordan' },
    executeImmediately: extra.immediately !== false,
  });

  const events = async (runId) => db('email_template_automation_run_events').where({ run_id: runId }).orderBy('created_at', 'asc');
  // A reclaimed run: same row, fresh claim, retry budget intact.
  const reclaim = (run) => db('email_template_automation_runs').where({ id: run.id }).update({
    status: 'queued', attempts: 0, run_after: new Date(Date.now() - 1000), completed_at: null, email_message_id: null, last_error: null,
  });

  // ---- dispatch ----------------------------------------------------------

  describe('marketing-stream dispatch', () => {
    test('live: sends ONLY through the ledger — fence lifted for this path, reservation key = run key, ledger row settled sent', async () => {
      process.env.GATE_EMAIL_TEMPLATE_AUTOMATIONS = 'true';
      const customer = await makeCustomer();
      const automation = await nurture();
      sendTemplate.mockImplementation(libraryLike());

      const run = (await fire(automation, customer)).results[0].run;

      expect({ status: run.status, err: run.last_error }).toEqual(expect.objectContaining({ status: 'sent' }));
      expect(sendTemplate).toHaveBeenCalledTimes(1);
      const args = sendTemplate.mock.calls[0][0];
      expect(args.marketingRequiresLedger).toBeUndefined();
      expect(args.templateKey).toBe(automation.template_key);
      expect(args.idempotencyKey).toBe(run.idempotency_key);
      expect(args.suppressionGroupKey).toBe('marketing_nurture');
      expect(args.to).toBe(customer.email);
      expect(args.automationRunId).toBe(run.id);
      const ledger = await db('marketing_email_ledger').where({ customer_id: customer.id });
      expect(ledger).toHaveLength(1);
      expect(ledger[0]).toEqual(expect.objectContaining({
        status: 'sent', stream: 'nurture', marketing_class: 'marketing', email_key: automation.template_key, idempotency_key: run.idempotency_key,
      }));
    });

    test('a template with neither prefix keeps the fence and the direct send (nothing about the ledger applies)', async () => {
      process.env.GATE_EMAIL_TEMPLATE_AUTOMATIONS = 'true';
      const customer = await makeCustomer();
      const automation = await makeAutomation(await makeTemplate('other.', 'marketing_nurture'), 'marketing_nurture');
      sendTemplate.mockResolvedValue({ sent: true, message: null });

      await fire(automation, customer);

      expect(sendTemplate).toHaveBeenCalledWith(expect.objectContaining({ marketingRequiresLedger: true }));
      expect(await db('marketing_email_ledger').where({ customer_id: customer.id })).toHaveLength(0);
    });

    test('a ledger refusal (customer switched email off) settles the run skipped with the reason — no provider call, no retry', async () => {
      process.env.GATE_EMAIL_TEMPLATE_AUTOMATIONS = 'true';
      const customer = await makeCustomer();
      await db('notification_prefs').where({ customer_id: customer.id }).update({ email_enabled: false });
      const automation = await nurture();

      const run = (await fire(automation, customer)).results[0].run;

      expect(run.status).toBe('skipped');
      expect(run.exit_reason).toContain('EMAIL_SWITCH_OFF');
      expect(sendTemplate).not.toHaveBeenCalled();
      expect(await db('marketing_email_ledger').where({ customer_id: customer.id })).toHaveLength(0);
      const skipped = (await events(run.id)).find((e) => e.event_type === 'skipped');
      expect(skipped.metadata).toEqual(expect.objectContaining({ guard: 'ledger_refused' }));
      expect((await Executor.executeRun(run.id)).status).toBe('skipped'); // terminal
    });

    test('a frequency cap refusal (a marketing email already sent today) settles skipped CAP_SAME_DAY', async () => {
      process.env.GATE_EMAIL_TEMPLATE_AUTOMATIONS = 'true';
      const customer = await makeCustomer();
      await db('marketing_email_ledger').insert({
        customer_id: customer.id, stream: 'nurture', marketing_class: 'marketing', email_key: 'nurture.other',
        idempotency_key: `cap-${randomUUID()}`, recipient_email: customer.email, status: 'sent', sent_at: new Date(),
      });
      const automation = await nurture();

      const run = (await fire(automation, customer)).results[0].run;

      expect(run.status).toBe('skipped');
      expect(run.exit_reason).toContain('CAP_SAME_DAY');
      expect(sendTemplate).not.toHaveBeenCalled();
    });

    // A provider 5xx AFTER the handoff: the library leaves a message row failed /
    // queued with provider_handoff_phase 'started' and throws. The ledger keeps
    // counting the send toward the caps (an uncertain completion), but the RUN is
    // not delivered: it takes the same retry-then-failed path the direct dispatch
    // takes, never 'sent'.
    const handoffStartedThenFail = () => async (args) => {
      await db('email_messages').insert({
        recipient_email_snapshot: args.to, template_key: args.templateKey, idempotency_key: args.idempotencyKey,
        status: 'queued', provider_handoff_phase: 'started', automation_run_id: args.automationRunId || null,
      });
      throw Object.assign(new Error('provider 503'), { status: 503 });
    };

    test('a provider 5xx after the handoff is NOT a delivery: the run retries then fails (never sent), the ledger keeps the uncertain send counted', async () => {
      process.env.GATE_EMAIL_TEMPLATE_AUTOMATIONS = 'true';
      const customer = await makeCustomer();
      const automation = await nurture();
      sendTemplate.mockImplementation(handoffStartedThenFail());

      const run = (await fire(automation, customer)).results[0].run;

      expect(run.status).toBe('retry_scheduled');
      const ledger = await db('marketing_email_ledger').where({ customer_id: customer.id });
      expect(ledger).toHaveLength(1);
      expect(ledger[0]).toEqual(expect.objectContaining({ status: 'sent', reason: 'provider_handoff_uncertain' }));

      // The retry meets the ledger's uncertain row (a duplicate): still not a delivery.
      await db('email_template_automation_runs').where({ id: run.id }).update({ run_after: new Date(Date.now() - 1000) });
      const retried = await Executor.executeRun(run.id);
      expect(retried.status).toBe('failed');
      expect(retried.last_error).toContain('unconfirmed');
      expect(sendTemplate).toHaveBeenCalledTimes(1);
    });

    test('a failure with no handoff at all (nothing reached the provider) frees the slot: ledger failed, run retry_scheduled', async () => {
      process.env.GATE_EMAIL_TEMPLATE_AUTOMATIONS = 'true';
      const customer = await makeCustomer();
      const automation = await nurture();
      sendTemplate.mockRejectedValue(Object.assign(new Error('provider down'), { status: 503 }));

      const run = (await fire(automation, customer)).results[0].run;

      expect(run.status).toBe('retry_scheduled');
      const ledger = await db('marketing_email_ledger').where({ customer_id: customer.id });
      expect(ledger[0].status).toBe('failed');
    });

    test('a lifecycle key rides the ledger lifecycle stream as relationship mail', async () => {
      process.env.GATE_EMAIL_TEMPLATE_AUTOMATIONS = 'true';
      const customer = await makeCustomer();
      const automation = await lifecycle();
      sendTemplate.mockImplementation(libraryLike());

      const run = (await fire(automation, customer)).results[0].run;

      expect(run.status).toBe('sent');
      const args = sendTemplate.mock.calls[0][0];
      expect(args.marketingRequiresLedger).toBeUndefined();
      expect(args.suppressionGroupKey).toBe('service_operational');
      const ledger = await db('marketing_email_ledger').where({ customer_id: customer.id });
      expect(ledger[0]).toEqual(expect.objectContaining({ stream: 'lifecycle', marketing_class: 'relationship', status: 'sent' }));
    });
  });

  describe('a lifted lc.* key never turns a marketing-stream template into relationship mail', () => {
    test('an lc.* template whose OWN stream is marketing_* is judged as marketing: opt-in, marketing group, marketing class', async () => {
      process.env.GATE_EMAIL_TEMPLATE_AUTOMATIONS = 'true';
      const optedOut = await makeCustomer();
      await db('notification_prefs').where({ customer_id: optedOut.id }).update({ marketing_offers: false });
      const automation = await makeAutomation(await makeTemplate('lc.', 'marketing_nurture'), 'marketing_nurture');

      const refused = (await fire(automation, optedOut)).results[0].run;
      expect(refused.status).toBe('skipped');
      expect(refused.exit_reason).toContain('STREAM_FLAG_OFF'); // marketing_offers is off
      expect(sendTemplate).not.toHaveBeenCalled();

      const customer = await makeCustomer();
      sendTemplate.mockImplementation(libraryLike());
      const run = (await fire(automation, customer)).results[0].run;
      expect(run.status).toBe('sent');
      expect(sendTemplate.mock.calls[0][0].suppressionGroupKey).toBe('marketing_newsletter');
      const ledger = await db('marketing_email_ledger').where({ customer_id: customer.id });
      expect(ledger[0]).toEqual(expect.objectContaining({ stream: 'lifecycle', marketing_class: 'marketing' }));
    });

    test('a template with mode marketing (even on a service stream) is marketing too; a plain service lc.* template stays relationship mail', async () => {
      process.env.GATE_EMAIL_TEMPLATE_AUTOMATIONS = 'true';
      const customer = await makeCustomer();
      sendTemplate.mockImplementation(libraryLike());
      const marketingMode = await makeAutomation(await makeTemplate('lc.', 'service_operational', 'marketing'), 'service_operational');
      await fire(marketingMode, customer);
      const plain = await lifecycle();
      const other = await makeCustomer();
      await fire(plain, other);

      const rows = await db('marketing_email_ledger').whereIn('customer_id', [customer.id, other.id]);
      expect(rows.find((r) => r.customer_id === customer.id).marketing_class).toBe('marketing');
      expect(rows.find((r) => r.customer_id === other.id).marketing_class).toBe('relationship');
    });

    test('the class follows the run\'s PINNED template: swapping the automation to a service template while a marketing run is queued does not make it relationship mail', async () => {
      process.env.GATE_EMAIL_TEMPLATE_AUTOMATIONS = 'true';
      const customer = await makeCustomer();
      await db('notification_prefs').where({ customer_id: customer.id }).update({ marketing_offers: false });
      const marketingKey = await makeTemplate('lc.', 'marketing_nurture');
      const automation = await makeAutomation(marketingKey, 'marketing_nurture');
      const queued = (await fire(automation, customer, { immediately: false })).results[0].run;
      expect(queued.status).toBe('queued');
      expect(queued.template_key).toBe(marketingKey);

      // The admin API permits this while runs are queued.
      const serviceKey = await makeTemplate('lc.', 'service_operational');
      await db('email_template_automations').where({ id: automation.id }).update({ template_key: serviceKey, suppression_group_key: 'service_operational' });

      const run = await Executor.executeRun(queued.id);
      expect(run.status).toBe('skipped');
      expect(run.exit_reason).toContain('STREAM_FLAG_OFF'); // still judged as marketing mail
      expect(sendTemplate).not.toHaveBeenCalled();
    });

    test('shadow judges the same class: an opted-out customer is would_block for a marketing-stream lc.* template', async () => {
      process.env.GATE_EMAIL_TEMPLATE_AUTOMATIONS = 'shadow';
      const customer = await makeCustomer();
      await db('notification_prefs').where({ customer_id: customer.id }).update({ marketing_offers: false });
      const automation = await makeAutomation(await makeTemplate('lc.', 'marketing_nurture'), 'marketing_nurture');

      const run = (await fire(automation, customer)).results[0].run;

      expect(run.status).toBe('skipped');
      const wouldBlock = (await events(run.id)).find((e) => e.event_type === 'would_block');
      expect(wouldBlock.metadata).toEqual(expect.objectContaining({ guard: 'ledger_ineligible' }));
    });
  });

  // ---- shadow ------------------------------------------------------------

  describe('shadow', () => {
    test('NEVER dispatches: no provider call, no ledger reservation, run settles shadow; the preflight runs without the fence under the ledger\'s group', async () => {
      process.env.GATE_EMAIL_TEMPLATE_AUTOMATIONS = 'shadow';
      const customer = await makeCustomer();
      const automation = await nurture();

      const run = (await fire(automation, customer)).results[0].run;

      expect(run.status).toBe('shadow');
      expect(sendTemplate).not.toHaveBeenCalled();
      expect(await db('marketing_email_ledger').where({ customer_id: customer.id })).toHaveLength(0);
      expect(preflightTemplateSend).toHaveBeenCalledWith(expect.objectContaining({
        templateKey: automation.template_key, suppressionGroupKey: 'marketing_nurture',
      }));
      expect(preflightTemplateSend.mock.calls[0][0].marketingRequiresLedger).toBeUndefined();
    });

    test('reports what the ledger would refuse: an ineligible customer is would_block ledger_ineligible, still no dispatch', async () => {
      process.env.GATE_EMAIL_TEMPLATE_AUTOMATIONS = 'shadow';
      const customer = await makeCustomer();
      await db('notification_prefs').where({ customer_id: customer.id }).update({ email_enabled: false });
      const automation = await nurture();

      const run = (await fire(automation, customer)).results[0].run;

      expect(run.status).toBe('skipped');
      const wouldBlock = (await events(run.id)).find((e) => e.event_type === 'would_block');
      expect(wouldBlock.metadata).toEqual(expect.objectContaining({ guard: 'ledger_ineligible' }));
      expect(sendTemplate).not.toHaveBeenCalled();
    });
  });

  // ---- recipient binding -------------------------------------------------

  describe('recipient binding: a run is never retargeted to another address', () => {
    test('a run addressed to an inbox that is not the customer record\'s own email is refused before any reservation', async () => {
      process.env.GATE_EMAIL_TEMPLATE_AUTOMATIONS = 'true';
      const customer = await makeCustomer();
      const automation = await nurture();

      const run = (await fire(automation, customer, { email: 'someone.else@example.invalid' })).results[0].run;

      expect(run.status).toBe('skipped');
      expect(run.exit_reason).toContain('own email address');
      expect(sendTemplate).not.toHaveBeenCalled();
      expect(await db('marketing_email_ledger').where({ customer_id: customer.id })).toHaveLength(0);
    });

    test('the customer\'s email changes between build and send (after the reservation, before the provider boundary): refused, terminal skip, nothing sent', async () => {
      process.env.GATE_EMAIL_TEMPLATE_AUTOMATIONS = 'true';
      const customer = await makeCustomer();
      const automation = await nurture();
      sendTemplate.mockImplementation(libraryLike({
        beforeHandoff: () => db('customers').where({ id: customer.id }).update({ email: 'new.address@example.invalid' }),
      }));

      const run = (await fire(automation, customer)).results[0].run;

      expect(run.status).toBe('skipped');
      expect(run.exit_reason).toContain('previous email address');
      const skipped = (await events(run.id)).find((e) => e.event_type === 'skipped');
      expect(skipped.metadata).toEqual(expect.objectContaining({ guard: 'ledger_recipient_changed' }));
      expect(await db('email_messages').where({ idempotency_key: run.idempotency_key })).toHaveLength(0);
      const ledger = await db('marketing_email_ledger').where({ customer_id: customer.id });
      expect(ledger[0]).toEqual(expect.objectContaining({ status: 'skipped', reason: 'RECIPIENT_CHANGED' }));
      // Terminal: a reclaimed run does not retarget either.
      expect((await Executor.executeRun(run.id)).status).toBe('skipped');
    });

    test('ledger level: the expected address is compared at the RESERVATION (changed address -> RECIPIENT_CHANGED, no row) and at the HANDOFF', async () => {
      const customer = await makeCustomer();
      const base = {
        customerId: customer.id, stream: 'nurture', emailKey: 'nurture.qa_probe_x', now: new Date(),
      };
      // Reservation: the payload was built for the old address.
      await db('customers').where({ id: customer.id }).update({ email: 'moved@example.invalid' });
      const refused = await Ledger.reserveWithCap({
        ...base, idempotencyKey: `rb-${randomUUID()}`, expectedRecipientEmail: customer.email,
      });
      expect(refused).toEqual(expect.objectContaining({ ok: false, reason: 'RECIPIENT_CHANGED', row: null }));
      // The same address (case-insensitive) passes, and no expectation = no check.
      const ok = await Ledger.reserveWithCap({
        ...base, idempotencyKey: `rb-${randomUUID()}`, expectedRecipientEmail: 'MOVED@example.invalid',
      });
      expect(ok.ok).toBe(true);
      await Ledger.markFailed(ok.row.id, 'test');
      const unchecked = await Ledger.reserveWithCap({ ...base, idempotencyKey: `rb-${randomUUID()}` });
      expect(unchecked.ok).toBe(true);

      // Handoff: reserved for the current address, then the address changes again.
      const handoffRow = await Ledger.reserveWithCap({
        ...base, idempotencyKey: `rb-${randomUUID()}`, stream: 'lifecycle', emailKey: 'lc.qa_probe_y', expectedRecipientEmail: 'moved@example.invalid',
      });
      expect(handoffRow.ok).toBe(true);
      await db('customers').where({ id: customer.id }).update({ email: 'moved.again@example.invalid' });
      const verdicts = [];
      let dispatched = false;
      await Ledger.reservationHandoff(handoffRow.row.id, {
        onVerdict: (v) => verdicts.push(v), expectedRecipientEmail: 'moved@example.invalid',
      })(async (database, boundaryCheck) => {
        try { await boundaryCheck({ database }); dispatched = true; } catch (err) { if (!err.providerBoundaryBlocked) throw err; }
      });
      expect(dispatched).toBe(false);
      expect(verdicts[verdicts.length - 1]).toEqual(expect.objectContaining({ ok: false, reason: 'RECIPIENT_CHANGED' }));
    });
  });

  // ---- duplicates --------------------------------------------------------

  describe('a ledger DUPLICATE is judged by the ledger / message state, never a blanket skip', () => {
    async function firstAttempt(mock) {
      process.env.GATE_EMAIL_TEMPLATE_AUTOMATIONS = 'true';
      const customer = await makeCustomer();
      const automation = await nurture();
      sendTemplate.mockImplementation(mock);
      const run = (await fire(automation, customer)).results[0].run;
      return { customer, run };
    }

    test('a confirmed delivery finalizes the run SENT with that message id (no second send)', async () => {
      const { run } = await firstAttempt(libraryLike());
      expect(run.status).toBe('sent');
      const ledger = await db('marketing_email_ledger').where({ idempotency_key: run.idempotency_key }).first();
      await reclaim(run);
      const again = await Executor.executeRun(run.id);
      expect(again.status).toBe('sent');
      expect(again.email_message_id).toBe(ledger.email_message_id);
      expect(sendTemplate).toHaveBeenCalledTimes(1);
    });

    // A crashed worker's run, reclaimed through the REAL stale 'running' path: its
    // attempt was already counted (max - 1), the reclaim counts the next one (= max).
    const crash = async (run, { reservation = 'reserved' } = {}) => {
      await db('marketing_email_ledger').where({ idempotency_key: run.idempotency_key }).update({ status: reservation, reserved_at: new Date(), reason: null, sent_at: null, email_message_id: null });
      await db('email_template_automation_runs').where({ id: run.id }).update({
        status: 'running', attempts: 1, run_after: new Date(Date.now() - 3600 * 1000), completed_at: null, email_message_id: null, last_error: null,
        updated_at: new Date(Date.now() - Executor.RUNNING_STALE_AFTER_MS - 60 * 1000),
      });
    };

    test('an OUTSTANDING reservation on a stale-reclaimed run on its LAST attempt defers without spending the budget (attempts restored, short delay) and the send happens once the reservation settles', async () => {
      const { run } = await firstAttempt(async () => { throw Object.assign(new Error('provider down'), { status: 503 }); });
      await db('email_messages').where({ idempotency_key: run.idempotency_key }).del();
      await crash(run);
      const deferred = await Executor.executeRun(run.id);
      expect(deferred.status).toBe('retry_scheduled');
      expect(deferred.attempts).toBe(1); // restored: the deferral spent nothing
      expect(deferred.last_error).toContain('still outstanding');
      expect(new Date(deferred.run_after).getTime()).toBeGreaterThan(Date.now());
      expect(new Date(deferred.run_after).getTime()).toBeLessThan(Date.now() + 5 * 60 * 1000);
      expect(sendTemplate).toHaveBeenCalledTimes(1);

      // The reservation lease expires (the ledger sweeps it); the run, still on its last attempt, sends.
      await db('marketing_email_ledger').where({ idempotency_key: run.idempotency_key }).update({ reserved_at: new Date(Date.now() - 31 * 60 * 1000) });
      await db('email_template_automation_runs').where({ id: run.id }).update({ run_after: new Date(Date.now() - 1000) });
      sendTemplate.mockImplementation(libraryLike());
      const retried = await Executor.executeRun(run.id);
      expect(retried.status).toBe('sent');
      expect(sendTemplate).toHaveBeenCalledTimes(2);
    });

    test('the deferral is capped so it can never loop forever: past the cap the normal retry / failure path decides', async () => {
      const { run } = await firstAttempt(async () => { throw Object.assign(new Error('provider down'), { status: 503 }); });
      await db('email_messages').where({ idempotency_key: run.idempotency_key }).del();
      await crash(run);
      const cap = Math.ceil(Ledger.RESERVATION_LIFETIME_MS / (2 * 60 * 1000)) + 2;
      await db('email_template_automation_run_events').insert(Array.from({ length: cap }, () => ({
        run_id: run.id, event_type: 'retry_scheduled', message: 'Deferred: email division reservation outstanding', metadata: {},
      })));
      const exhausted = await Executor.executeRun(run.id);
      expect(exhausted.status).toBe('failed'); // last attempt, cap reached: no endless deferral
    });

    test('an uncertain duplicate (handoff started, no acceptance) is not finalized sent', async () => {
      const { run } = await firstAttempt(async (args) => {
        await db('email_messages').insert({
          recipient_email_snapshot: args.to, template_key: args.templateKey, idempotency_key: args.idempotencyKey,
          status: 'queued', provider_handoff_phase: 'started', automation_run_id: args.automationRunId || null,
        });
        throw Object.assign(new Error('provider 503'), { status: 503 });
      });
      await db('marketing_email_ledger').where({ idempotency_key: run.idempotency_key }).update({ status: 'reserved', sent_at: null, reason: null });
      await reclaim(run);
      const again = await Executor.executeRun(run.id);
      expect(again.status).toBe('retry_scheduled'); // thrown unconfirmed, never 'sent'
      expect(again.last_error).toContain('unconfirmed');
    });

    test('a duplicate owned by a different recipient, or by another run\'s message, stays a terminal skip', async () => {
      const { run } = await firstAttempt(libraryLike());
      await db('marketing_email_ledger').where({ idempotency_key: run.idempotency_key }).update({ recipient_email: 'other.inbox@example.invalid' });
      await reclaim(run);
      const otherRecipient = await Executor.executeRun(run.id);
      expect(otherRecipient.status).toBe('skipped');
      expect(otherRecipient.exit_reason).toContain('different recipient');

      const second = await firstAttempt(libraryLike());
      await db('email_messages').where({ idempotency_key: second.run.idempotency_key }).update({ automation_run_id: randomUUID() });
      await reclaim(second.run);
      const otherRun = await Executor.executeRun(second.run.id);
      expect(otherRun.status).toBe('skipped');
      expect(otherRun.exit_reason).toContain('different run');
    });

    test('the executor\'s stale-claim timer outlasts the ledger reservation lease (both read the one constant)', () => {
      expect(Ledger.RESERVATION_LIFETIME_MS).toBe(require('../services/email-division/reservation-lifetime').RESERVATION_LIFETIME_MS);
      expect(Executor.RUNNING_STALE_AFTER_MS).toBeGreaterThan(Ledger.RESERVATION_LIFETIME_MS);
    });
  });
});
