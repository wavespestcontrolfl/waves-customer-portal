/**
 * Email division wiring on real PostgreSQL (the wiring PR): the executor's
 * ledger-routed dispatch, the payload builders' skip rules, and the
 * automation seed's insert-once behaviour.
 *
 * Only the provider edge is mocked: sendTemplate (a stand-in that runs the
 * ledger's locked handoff the way the library does), the shadow preflight's
 * library call, the estimate short-link mint, and the external radar / slot
 * probes (injected as builder deps). Everything else — the ledger, the
 * eligibility reads, the executor's run rows, the builders' queries — is real.
 *
 * Self-skips without DATABASE_URL (run after `knex migrate:latest`).
 */
const { randomUUID } = require('node:crypto');

// The series-template overlay (recurring_template_overrides) is gate-controlled and the gates
// map is read at load: turn it on before anything requires the gates.
process.env.GATE_EDIT_APPT_PRICE_SERVICE_SCOPE = 'true';

jest.mock('../services/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock('../services/email-template-library', () => ({
  ...jest.requireActual('../services/email-template-library'),
  sendTemplate: jest.fn(),
  preflightTemplateSend: jest.fn(async () => ({ ok: true })),
}));
// The >= 20 cohort reader, defaulted to a cohort that clears the floor for the
// executor-level tests (builder-level tests inject their own through deps).
const mockCohort = { value: { byVisit: { pest: { 1: 3.1, 2: 1.2 } }, counts: {} } };
jest.mock('../services/email-division/visit-products', () => ({
  ...jest.requireActual('../services/email-division/visit-products'),
  getActivityRatingAverages: jest.fn(async () => mockCohort.value),
}));
jest.mock('../services/estimate-follow-up', () => ({
  _private: { mintStageLinks: jest.fn(async () => ({ emailUrl: 'https://example.test/l/minted' })) },
}));

const SKIP = !process.env.DATABASE_URL;
if (!SKIP) {
  // Writes synthetic rows and edits (then restores) a seeded automation row:
  // only ever against a local QA database or CI's.
  const url = new URL(process.env.DATABASE_URL);
  if (!['localhost', '127.0.0.1'].includes(url.hostname) || !/^\/(waves_test|(waves_)?qa_[a-z0-9_]+)$/.test(url.pathname)) {
    throw new Error('Email division wiring tests need a local QA database (qa_* / waves_qa_*) or waves_test.');
  }
}
const describeOrSkip = SKIP ? describe.skip : describe;

// The library's locked handoff, as the stand-in sendTemplate runs it: the
// boundary check is awaited inside `dispatch`; its veto is a definite non-send.
function libraryLike({ result, beforeHandoff = null, duringHandoff = null } = {}) {
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
      // Still inside the provider handoff: the boundary transaction (and its share locks) is open.
      if (duringHandoff) await duringHandoff(args);
    });
    if (verdict?.ok !== true || vetoed) return { sent: false, aborted: true, reason: 'aborted_by_caller_before_dispatch' };
    if (!dispatched) throw new Error('handoff returned without dispatching');
    if (args.onQueued) args.onQueued();
    if (result) return result;
    // A real delivery-authority row (the run and ledger rows FK to it).
    const db = require('../models/db');
    const [message] = await db('email_messages').insert({
      recipient_email_snapshot: args.to, template_key: args.templateKey, idempotency_key: args.idempotencyKey,
      status: 'sent', sent_at: new Date(), provider_message_id: 'sg-synthetic',
    }).returning('*');
    return { sent: true, providerAccepted: true, message };
  };
}

describeOrSkip('email division wiring (Postgres)', () => {
  jest.setTimeout(60000);
  let db;
  let Executor;
  let Builders;
  let sendTemplate;
  let preflightTemplateSend;
  const created = {
    customers: [], estimates: [], automations: [], technicians: [], visits: [],
  };
  let customerEmails = [];

  beforeAll(() => {
    db = require('../models/db');
    Executor = require('../services/email-template-automation-executor');
    Builders = require('../services/email-division/payload-builders');
    ({ sendTemplate, preflightTemplateSend } = require('../services/email-template-library'));
  });

  afterEach(async () => {
    delete process.env.GATE_EMAIL_TEMPLATE_AUTOMATIONS;
    sendTemplate.mockReset();
    preflightTemplateSend.mockReset();
    require('../services/estimate-follow-up')._private.mintStageLinks.mockClear();
    preflightTemplateSend.mockImplementation(async () => ({ ok: true }));
    const { customers, estimates, automations, technicians, visits } = created;
    if (automations.length) {
      const runs = await db('email_template_automation_runs').whereIn('automation_key', automations).select('id');
      await db('email_template_automation_run_events').whereIn('run_id', runs.map((r) => r.id)).del();
      await db('email_template_automation_runs').whereIn('automation_key', automations).del();
      await db('email_template_automations').whereIn('automation_key', automations).del();
    }
    if (customers.length) await db('marketing_email_ledger').whereIn('customer_id', customers).del();
    await db('email_messages').whereIn('recipient_email_snapshot', customerEmails).del();
    if (visits.length) {
      await db('service_products').whereIn('service_record_id', visits).del();
      await db('service_records').whereIn('id', visits).del();
    }
    if (customers.length) await db('leads').whereIn('customer_id', customers).del();
    if (customers.length) await db('scheduled_services').whereIn('customer_id', customers).del();
    if (estimates.length) await db('estimates').whereIn('id', estimates).del();
    if (customers.length) await db('customer_properties').whereIn('customer_id', customers).del();
    if (customers.length) {
      await db('notification_prefs').whereIn('customer_id', customers).del();
      await db('customers').whereIn('id', customers).del();
    }
    if (technicians.length) await db('technicians').whereIn('id', technicians).del();
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
      email, active: true, pipeline_stage: 'active_customer', city: 'Parrish', ...overrides,
    });
    await db('notification_prefs').insert({ customer_id: id, email_enabled: true, marketing_offers: true });
    created.customers.push(id);
    customerEmails.push(email);
    return { id, email };
  }

  async function makeTech() {
    const id = randomUUID();
    await db('technicians').insert({ id, name: 'Marco Example' });
    created.technicians.push(id);
    return id;
  }

  const PRODUCTS = {
    taurus: { product_name: 'Taurus SC', active_ingredient: 'fipronil', product_category: 'Insecticide' },
    talak: { product_name: 'Talak 7.9% F', active_ingredient: 'bifenthrin', product_category: 'Insecticide' },
    alpine: { product_name: 'Alpine WSG', active_ingredient: 'dinotefuran', product_category: 'Insecticide' },
  };

  async function makeVisit({
    customerId, technicianId = null, visitNumber = 1, serviceLine = 'pest', date = '2026-09-20', products = ['taurus'],
    rating = null, ratingSource = null, defaulted = null, createdAt = new Date('2026-09-20T15:00:00Z'),
    notes = 'Treated ghost ants along the foundation.', scheduledServiceId = null, serviceType = 'Quarterly Pest Control Service', targets = [],
  }) {
    const id = randomUUID();
    await db('service_records').insert({
      id, customer_id: customerId, technician_id: technicianId, service_date: date, service_type: serviceType,
      service_line: serviceLine, visit_number: visitNumber, status: 'completed', technician_notes: notes,
      areas_serviced: JSON.stringify(['the foundation perimeter', 'garage entry']),
      client_pest_rating: rating, client_pest_rating_source: ratingSource, client_pest_rating_defaulted: defaulted,
      scheduled_service_id: scheduledServiceId, created_at: createdAt,
    });
    for (const key of products) await db('service_products').insert({ service_record_id: id, ...PRODUCTS[key], targets });
    created.visits.push(id);
    return id;
  }

  async function makeNextVisit(customerId, pattern = 'quarterly', date = '2099-12-24', extra = {}) {
    const [row] = await db('scheduled_services').insert({
      customer_id: customerId, scheduled_date: date, service_type: 'Quarterly Pest Control Service',
      status: 'confirmed', recurring_pattern: pattern, service_address_line1: '123 Example St', service_address_city: 'Parrish', service_address_zip: '34219',
      // A live recurring series root (the canonical active-series source reads these flags).
      is_recurring: Boolean(pattern) && pattern !== 'one_time', recurring_ongoing: Boolean(pattern) && pattern !== 'one_time',
      ...extra,
    }).returning('id');
    return row.id;
  }

  // A COMPLETED appointment that belongs to a recurring pest plan (a series root).
  async function makeDoneRecurring(customerId, extra = {}) {
    const [row] = await db('scheduled_services').insert({
      customer_id: customerId, scheduled_date: '2026-09-20', service_type: 'Quarterly Pest Control Service',
      status: 'completed', recurring_pattern: 'quarterly', service_address_line1: '123 Example St', service_address_city: 'Parrish', service_address_zip: '34219',
      is_recurring: true, recurring_ongoing: true, ...extra,
    }).returning('id');
    return row.id;
  }

  async function makeEstimate(customerId, email, overrides = {}) {
    const id = randomUUID();
    await db('estimates').insert({
      id, customer_id: customerId, status: 'expired', token: `qa-${randomUUID()}`, address: '123 Example St, Parrish, FL 34219',
      customer_name: 'Jordan Sample', customer_email: email, expires_at: new Date('2026-09-21T16:00:00Z'),
      service_interest: 'Quarterly pest control', estimate_data: JSON.stringify({}), ...overrides,
    });
    created.estimates.push(id);
    return id;
  }

  async function makeAutomation(overrides) {
    const key = `qa_wiring_${randomUUID().slice(0, 8)}`;
    const [row] = await db('email_template_automations').insert({
      automation_key: key, name: key, delay_minutes: 0, audience: 'customer', status: 'active',
      retry_policy: JSON.stringify({ max_attempts: 2, backoff_minutes: [15, 60] }),
      conditions: JSON.stringify({}), exit_conditions: JSON.stringify({}),
      ...overrides,
    }).returning('*');
    created.automations.push(row.automation_key);
    return row;
  }

  const nurtureAutomation = () => makeAutomation({
    trigger_event_key: 'estimate.expired', template_key: 'nurture.expired_1', suppression_group_key: 'marketing_nurture',
    audience: 'lead', legal_classification: 'commercial_marketing',
    idempotency_key_template: `qa-wiring-${randomUUID().slice(0, 6)}:{estimate_id}:{expires_on}`,
  });

  const fire = (automation, {
    estimateId, customerId, email, expiresOn = '2026-09-21', immediately = true,
  }) => Executor.processTrigger({
    triggerEventKey: 'estimate.expired',
    triggerEventId: `estimate_expired:${estimateId}`,
    automationKey: automation.automation_key,
    entityType: 'estimate',
    entityId: estimateId,
    recipient: { type: 'customer', id: customerId, email },
    payload: {
      estimate_id: estimateId, customer_id: customerId, customer_email: email, expires_on: expiresOn,
    },
    executeImmediately: immediately,
  });

  const waitFor = async (read) => {
    for (let i = 0; i < 100; i += 1) {
      const value = await read();
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('waitFor timed out');
  };

  const events = async (runId) => db('email_template_automation_run_events').where({ run_id: runId }).orderBy('created_at', 'asc');

  // ---- executor: the ledger path -----------------------------------------

  describe('executor dispatch for a marketing-stream email-division template', () => {
    test('live: sends ONLY through the ledger — fence lifted for this path, reservation key = run key, ledger row settled sent', async () => {
      process.env.GATE_EMAIL_TEMPLATE_AUTOMATIONS = 'true';
      const customer = await makeCustomer();
      const estimateId = await makeEstimate(customer.id, customer.email);
      const automation = await nurtureAutomation();
      sendTemplate.mockImplementation(libraryLike());

      const out = await fire(automation, { estimateId, customerId: customer.id, email: customer.email });
      const run = out.results[0].run;

      expect({ status: run.status, err: run.last_error }).toEqual(expect.objectContaining({ status: 'sent' }));
      expect(sendTemplate).toHaveBeenCalledTimes(1);
      const args = sendTemplate.mock.calls[0][0];
      // The ledger path lifts the library fence and carries the ledger's own identity.
      expect(args.marketingRequiresLedger).toBeUndefined();
      expect(args.templateKey).toBe('nurture.expired_1');
      expect(args.idempotencyKey).toBe(run.idempotency_key);
      expect(args.suppressionGroupKey).toBe('marketing_nurture');
      expect(args.to).toBe(customer.email);
      expect(args.automationRunId).toBe(run.id);
      // The builder's payload reached the library (estimate link minted, no price, blank consultation url).
      expect(args.payload).toEqual(expect.objectContaining({
        first_name: 'Jordan', address_short: '123 Example St', expired_date_short: 'Sep 21',
        estimate_link: 'https://example.test/l/minted', consultation_url: '',
      }));
      const ledger = await db('marketing_email_ledger').where({ customer_id: customer.id });
      expect(ledger).toHaveLength(1);
      expect(ledger[0]).toEqual(expect.objectContaining({
        status: 'sent', stream: 'nurture', marketing_class: 'marketing', email_key: 'nurture.expired_1', idempotency_key: run.idempotency_key,
      }));
    });

    test('a builder skip settles the run skipped with guard payload_builder — terminal, nothing reserved', async () => {
      process.env.GATE_EMAIL_TEMPLATE_AUTOMATIONS = 'true';
      const customer = await makeCustomer();
      const estimateId = await makeEstimate(customer.id, customer.email, { address: '' });
      const automation = await nurtureAutomation();

      const out = await fire(automation, { estimateId, customerId: customer.id, email: customer.email });
      const run = out.results[0].run;

      expect(run.status).toBe('skipped');
      expect(run.exit_reason).toContain('address_short');
      const skipped = (await events(run.id)).find((e) => e.event_type === 'skipped');
      expect(skipped.metadata).toEqual(expect.objectContaining({ guard: 'payload_builder', code: 'missing_required' }));
      expect(sendTemplate).not.toHaveBeenCalled();
      expect(await db('marketing_email_ledger').where({ customer_id: customer.id })).toHaveLength(0);
    });

    test('nurture.expired_1 is skipped, never sent to the old recipient, when the estimate\'s email — then its customer — changes during the delay', async () => {
      process.env.GATE_EMAIL_TEMPLATE_AUTOMATIONS = 'true';
      const customer = await makeCustomer();
      const estimateId = await makeEstimate(customer.id, customer.email);
      const automation = await nurtureAutomation();
      sendTemplate.mockImplementation(libraryLike());

      // The run is created at expiry and waits out the delay (queued here).
      const emailRun = (await fire(automation, {
        estimateId, customerId: customer.id, email: customer.email, immediately: false,
      })).results[0].run;
      expect(emailRun.status).toBe('queued');
      await db('estimates').where({ id: estimateId }).update({ customer_email: 'new.email@example.invalid' });
      const afterEmail = await Executor.executeRun(emailRun.id);
      expect(afterEmail.status).toBe('skipped');
      expect(afterEmail.exit_reason).toContain('changed since this run was created');
      const skipped = (await events(emailRun.id)).find((e) => e.event_type === 'skipped');
      expect(skipped.metadata).toEqual(expect.objectContaining({ guard: 'payload_builder', code: 'estimate_recipient_changed' }));

      // A case-only difference is the SAME inbox (the ledger's own normalization).
      const sameInbox = await makeEstimate(customer.id, customer.email.toUpperCase());
      const sameRun = (await fire(automation, {
        estimateId: sameInbox, customerId: customer.id, email: customer.email, immediately: false,
      })).results[0].run;
      expect((await Executor.executeRun(sameRun.id)).status).toBe('sent');
      sendTemplate.mockClear();

      // The estimate moves to another customer during the delay.
      const other = await makeCustomer();
      const ownerEstimate = await makeEstimate(customer.id, customer.email);
      const ownerRun = (await fire(automation, {
        estimateId: ownerEstimate, customerId: customer.id, email: customer.email, immediately: false,
      })).results[0].run;
      await db('estimates').where({ id: ownerEstimate }).update({ customer_id: other.id });
      const afterOwner = await Executor.executeRun(ownerRun.id);
      expect(afterOwner.status).toBe('skipped');
      expect(afterOwner.exit_reason).toContain('changed since this run was created');
      expect(sendTemplate).not.toHaveBeenCalled();
    });

    test('shadow NEVER dispatches: no provider call, no ledger reservation, run settles shadow', async () => {
      process.env.GATE_EMAIL_TEMPLATE_AUTOMATIONS = 'shadow';
      const customer = await makeCustomer();
      const estimateId = await makeEstimate(customer.id, customer.email);
      const automation = await nurtureAutomation();

      const out = await fire(automation, { estimateId, customerId: customer.id, email: customer.email });
      const run = out.results[0].run;

      expect(run.status).toBe('shadow');
      expect(sendTemplate).not.toHaveBeenCalled();
      expect(await db('marketing_email_ledger').where({ customer_id: customer.id })).toHaveLength(0);
      // The preflight ran WITHOUT the fence (the ledger path is live-capable) and under the ledger's group.
      expect(preflightTemplateSend).toHaveBeenCalledWith(expect.objectContaining({
        templateKey: 'nurture.expired_1', suppressionGroupKey: 'marketing_nurture',
      }));
      expect(preflightTemplateSend.mock.calls[0][0].marketingRequiresLedger).toBeUndefined();
      // Shadow's payload never minted a link (no write): the long estimate URL.
      expect(preflightTemplateSend.mock.calls[0][0].payload.estimate_link).toMatch(/^https:\/\/portal\.wavespestcontrol\.com\/estimate\/qa-/);
      expect(require('../services/estimate-follow-up')._private.mintStageLinks).not.toHaveBeenCalled();
    });

    test('a shadow builder skip is would_block evidence (guard payload_builder); once the data is fixed the live replay promotes the SAME run and sends through the ledger', async () => {
      const customer = await makeCustomer();
      const estimateId = await makeEstimate(customer.id, customer.email, { address: '' });
      const automation = await nurtureAutomation();

      process.env.GATE_EMAIL_TEMPLATE_AUTOMATIONS = 'shadow';
      const shadow = await fire(automation, { estimateId, customerId: customer.id, email: customer.email });
      const shadowRun = shadow.results[0].run;
      expect(shadowRun.status).toBe('skipped');
      const wouldBlock = (await events(shadowRun.id)).find((e) => e.event_type === 'would_block');
      expect(wouldBlock.metadata).toEqual(expect.objectContaining({ guard: 'payload_builder' }));

      await db('estimates').where({ id: estimateId }).update({ address: '123 Example St, Parrish, FL 34219' });
      process.env.GATE_EMAIL_TEMPLATE_AUTOMATIONS = 'true';
      sendTemplate.mockImplementation(libraryLike());
      const live = await fire(automation, { estimateId, customerId: customer.id, email: customer.email });

      expect(live.results[0].run.id).toBe(shadowRun.id);
      expect(live.results[0].run.status).toBe('sent');
      expect(sendTemplate).toHaveBeenCalledTimes(1);
    });

    test('nurture.expired_1 is once per EXPIRY, once per estimate at send time: a run skipped because the estimate was extended never swallows the next expiry, and a second expiry after a send is skipped as already delivered', async () => {
      process.env.GATE_EMAIL_TEMPLATE_AUTOMATIONS = 'true';
      const customer = await makeCustomer();
      const estimateId = await makeEstimate(customer.id, customer.email, { status: 'sent' }); // extended: not expired
      const automation = await nurtureAutomation();
      sendTemplate.mockImplementation(libraryLike());

      const first = (await fire(automation, { estimateId, customerId: customer.id, email: customer.email, expiresOn: '2026-09-20' })).results[0].run;
      expect(first.status).toBe('skipped');
      expect(first.exit_reason).toContain('no longer expired');

      // Extended, then expired again: the estimate's CURRENT expiry is now Oct 20.
      await db('estimates').where({ id: estimateId }).update({ status: 'expired', expires_at: new Date('2026-10-20T16:00:00Z') });
      const second = (await fire(automation, { estimateId, customerId: customer.id, email: customer.email, expiresOn: '2026-10-20' })).results[0].run;
      expect(second.id).not.toBe(first.id);
      expect(second.idempotency_key).not.toBe(first.idempotency_key);
      expect(second.status).toBe('sent');

      // Same expiry again: the key dedupes. A LATER expiry of the same estimate: skipped at send time.
      await db('estimates').where({ id: estimateId }).update({ expires_at: new Date('2026-11-20T16:00:00Z') });
      const third = (await fire(automation, { estimateId, customerId: customer.id, email: customer.email, expiresOn: '2026-11-20' })).results[0].run;
      expect(third.status).toBe('skipped');
      expect(third.exit_reason).toContain('already has a sent');
      expect(sendTemplate).toHaveBeenCalledTimes(1);
    });

    test('lc.why_91_days is per report, once per customer at send time: the first visit\'s report is skipped and does NOT consume the key, the second visit\'s report sends, a third report is skipped as already delivered', async () => {
      process.env.GATE_EMAIL_TEMPLATE_AUTOMATIONS = 'true';
      const customer = await makeCustomer();
      const techId = await makeTech();
      const [propA] = await db('customer_properties').insert({ customer_id: customer.id, city: 'Parrish' }).returning('id');
      const [propB] = await db('customer_properties').insert({ customer_id: customer.id, city: 'Venice' }).returning('id');
      const scheduledId = await makeNextVisit(customer.id, 'quarterly', '2099-12-24', { property_id: propA.id });
      const scheduledB = await makeNextVisit(customer.id, 'quarterly', '2099-12-24', { property_id: propB.id });
      // Two properties, each its own recurring series: two ELIGIBLE second visits for one customer.
      const visit1 = await makeVisit({ customerId: customer.id, technicianId: techId, visitNumber: 1, date: '2026-06-20', products: ['taurus'], scheduledServiceId: scheduledId, createdAt: new Date('2026-06-20T15:00:00Z') });
      const visit2 = await makeVisit({ customerId: customer.id, technicianId: techId, visitNumber: 2, date: '2026-09-20', products: ['taurus', 'talak'], scheduledServiceId: scheduledId });
      await makeVisit({ customerId: customer.id, technicianId: techId, visitNumber: 3, date: '2026-06-21', products: ['taurus'], scheduledServiceId: scheduledB, createdAt: new Date('2026-06-21T15:00:00Z') });
      const visit2b = await makeVisit({ customerId: customer.id, technicianId: techId, visitNumber: 4, date: '2026-09-21', products: ['taurus', 'talak'], scheduledServiceId: scheduledB, createdAt: new Date('2026-09-21T15:00:00Z') });
      const automation = await makeAutomation({
        trigger_event_key: 'service_report.ready', template_key: 'lc.why_91_days', suppression_group_key: 'service_operational',
        idempotency_key_template: `qa-wiring-${randomUUID().slice(0, 6)}:{service_record_id}`,
      });
      sendTemplate.mockImplementation(libraryLike());
      const report = (recordId) => Executor.processTrigger({
        triggerEventKey: 'service_report.ready',
        triggerEventId: `service_report_ready:${recordId}:customer`,
        automationKey: automation.automation_key,
        entityType: 'service_record',
        entityId: recordId,
        recipient: { type: 'customer', id: customer.id, email: customer.email },
        payload: { service_record_id: recordId, customer_id: customer.id },
        executeImmediately: true,
      }).then((out) => out.results[0].run);

      const first = await report(visit1);
      expect(first.status).toBe('skipped');
      expect(first.exit_reason).toContain('second performed pest visit');
      const second = await report(visit2);
      expect(second.status).toBe('sent');
      expect(second.idempotency_key).not.toBe(first.idempotency_key);
      const third = await report(visit2b);
      expect(third.status).toBe('skipped');
      expect(third.exit_reason).toContain('already has a sent');
      expect(sendTemplate).toHaveBeenCalledTimes(1);
      expect(sendTemplate.mock.calls[0][0].payload).toEqual(expect.objectContaining({
        plan_interval_days: '91', activity_avg_first_visit: '3.1', activity_avg_second_visit: '1.2',
      }));
    });

    // The estimate's ownership is re-judged INSIDE the provider-boundary transaction
    // (share-locked to its end) and at the reservation: a change after the build
    // can never deliver the estimate's bearer link to the old recipient.
    test('the estimate\'s email changes AFTER the build, before the provider handoff: refused at the boundary, nothing sent, terminal skip', async () => {
      process.env.GATE_EMAIL_TEMPLATE_AUTOMATIONS = 'true';
      const customer = await makeCustomer();
      const estimateId = await makeEstimate(customer.id, customer.email);
      const automation = await nurtureAutomation();
      sendTemplate.mockImplementation(libraryLike({
        beforeHandoff: () => db('estimates').where({ id: estimateId }).update({ customer_email: 'someone.new@example.invalid' }),
      }));

      const run = (await fire(automation, { estimateId, customerId: customer.id, email: customer.email })).results[0].run;

      expect(run.status).toBe('skipped');
      expect(run.exit_reason).toContain('changed since this run was created');
      const skipped = (await events(run.id)).find((e) => e.event_type === 'skipped');
      expect(skipped.metadata).toEqual(expect.objectContaining({ guard: 'estimate_recipient_changed' }));
      expect(await db('email_messages').where({ idempotency_key: run.idempotency_key })).toHaveLength(0);
      const ledger = await db('marketing_email_ledger').where({ customer_id: customer.id });
      expect(ledger[0]).toEqual(expect.objectContaining({ status: 'skipped', reason: 'ESTIMATE_RECIPIENT_CHANGED' }));
    });

    test('the estimate moves to another customer, or is extended (no longer expired), after the build: both refused at the boundary', async () => {
      process.env.GATE_EMAIL_TEMPLATE_AUTOMATIONS = 'true';
      const customer = await makeCustomer();
      const other = await makeCustomer();
      const owned = await makeEstimate(customer.id, customer.email);
      const extended = await makeEstimate(customer.id, customer.email);
      const automation = await nurtureAutomation();

      sendTemplate.mockImplementation(libraryLike({ beforeHandoff: () => db('estimates').where({ id: owned }).update({ customer_id: other.id }) }));
      const movedRun = (await fire(automation, { estimateId: owned, customerId: customer.id, email: customer.email })).results[0].run;
      expect(movedRun.status).toBe('skipped');
      expect(movedRun.exit_reason).toContain('changed since this run was created');

      sendTemplate.mockImplementation(libraryLike({ beforeHandoff: () => db('estimates').where({ id: extended }).update({ status: 'sent' }) }));
      const extendedRun = (await fire(automation, { estimateId: extended, customerId: customer.id, email: customer.email })).results[0].run;
      expect(extendedRun.status).toBe('skipped');
      expect(extendedRun.exit_reason).toContain('no longer expired');
      expect(await db('email_messages').whereIn('idempotency_key', [movedRun.idempotency_key, extendedRun.idempotency_key])).toHaveLength(0);
    });

    test('at the RESERVATION too: a change between the build and reserveWithCap is refused by the ledger guard before any row exists', async () => {
      const customer = await makeCustomer();
      const estimateId = await makeEstimate(customer.id, customer.email);
      const run = {
        id: randomUUID(), template_key: 'nurture.expired_1', entity_id: estimateId, recipient_id: customer.id,
        recipient_email: customer.email, idempotency_key: `res-${randomUUID()}`,
      };
      const { guard } = Builders.ledgerGuardsFor(run);
      await db('estimates').where({ id: estimateId }).update({ customer_email: 'moved@example.invalid' });
      const denied = await require('../services/email-division/ledger').reserveWithCap({
        customerId: customer.id, stream: 'nurture', emailKey: 'nurture.expired_1', idempotencyKey: run.idempotency_key, guard,
      });
      expect(denied).toEqual(expect.objectContaining({ ok: false, reason: 'ESTIMATE_RECIPIENT_CHANGED', row: null }));
      expect(await db('marketing_email_ledger').where({ idempotency_key: run.idempotency_key })).toHaveLength(0);
    });

    // Recovery before ANY mutable check: a crash after an ACCEPTED delivery, then the
    // world changes (email, archive, paused automation): the reclaimed run is
    // finalized sent from the ledger / delivery authority — never skipped.
    test('crash after an accepted delivery, then the estimate\'s email changes, it is archived and the automation is paused: the reclaimed run is finalized SENT, not skipped (real seeded nurture.expired_1)', async () => {
      process.env.GATE_EMAIL_TEMPLATE_AUTOMATIONS = 'true';
      const customer = await makeCustomer();
      const estimateId = await makeEstimate(customer.id, customer.email);
      const automation = await nurtureAutomation();
      sendTemplate.mockImplementation(libraryLike());
      const first = (await fire(automation, { estimateId, customerId: customer.id, email: customer.email })).results[0].run;
      expect(first.status).toBe('sent');
      const message = await db('email_messages').where({ idempotency_key: first.idempotency_key }).first();
      // The crash: the ledger never settled; the accepted message is the delivery authority.
      await db('marketing_email_ledger').where({ idempotency_key: first.idempotency_key }).update({ status: 'reserved', sent_at: null, email_message_id: null, reason: null });
      await db('email_template_automation_runs').where({ id: first.id }).update({
        status: 'queued', attempts: 0, run_after: new Date(Date.now() - 1000), completed_at: null, email_message_id: null, last_error: null,
      });
      // ...and everything a build would have refused since.
      await db('estimates').where({ id: estimateId }).update({ customer_email: 'new.email@example.invalid', archived_at: new Date() });
      await db('email_template_automations').where({ automation_key: automation.automation_key }).update({ status: 'paused' });

      const recovered = await Executor.executeRun(first.id);

      expect(recovered.status).toBe('sent');
      expect(recovered.email_message_id).toBe(message.id);
      expect(sendTemplate).toHaveBeenCalledTimes(1);
    });

    // The boundary re-runs the builder's OWN eligibility (one predicate), so an
    // archive or a zero-comms stamp landing after the build is not sent.
    test.each([
      ['archived', { archived_at: new Date() }],
      ['stamped noEngagementAutomation', { estimate_data: JSON.stringify({ noEngagementAutomation: true }) }],
    ])('the estimate is %s AFTER the build, before the provider handoff: refused at the boundary, nothing sent', async (_label, change) => {
      process.env.GATE_EMAIL_TEMPLATE_AUTOMATIONS = 'true';
      const customer = await makeCustomer();
      const estimateId = await makeEstimate(customer.id, customer.email);
      const automation = await nurtureAutomation();
      sendTemplate.mockImplementation(libraryLike({ beforeHandoff: () => db('estimates').where({ id: estimateId }).update(change) }));

      const run = (await fire(automation, { estimateId, customerId: customer.id, email: customer.email })).results[0].run;

      expect(run.status).toBe('skipped');
      expect(run.exit_reason).toContain('archived or opted out');
      expect(await db('email_messages').where({ idempotency_key: run.idempotency_key })).toHaveLength(0);
      const ledger = await db('marketing_email_ledger').where({ customer_id: customer.id });
      expect(ledger[0]).toEqual(expect.objectContaining({ status: 'skipped', reason: 'ESTIMATE_FOLLOWUP_BLOCKED' }));
    });

    test('B1: the service record is suppressed from the customer report AFTER the build: refused at the boundary (the builder\'s own visit gate), nothing sent', async () => {
      process.env.GATE_EMAIL_TEMPLATE_AUTOMATIONS = 'true';
      const customer = await makeCustomer();
      const techId = await makeTech();
      await makeNextVisit(customer.id);
      const recordId = await makeVisit({ customerId: customer.id, technicianId: techId, products: ['taurus'] });
      const automation = await makeAutomation({
        trigger_event_key: 'visit.completed_first', template_key: 'lc.first_visit_pest', suppression_group_key: 'service_operational',
        idempotency_key_template: `qa-wiring-${randomUUID().slice(0, 6)}:{service_record_id}`,
      });
      sendTemplate.mockImplementation(libraryLike({
        beforeHandoff: () => db('service_records').where({ id: recordId }).update({ structured_notes: JSON.stringify({ typedReportDelivery: 'manual' }) }),
      }));

      const run = (await Executor.processTrigger({
        triggerEventKey: 'visit.completed_first',
        triggerEventId: `visit_completed_first:${recordId}`,
        automationKey: automation.automation_key,
        entityType: 'service_record',
        entityId: recordId,
        recipient: { type: 'customer', id: customer.id, email: customer.email },
        payload: { service_record_id: recordId, customer_id: customer.id },
        executeImmediately: true,
      })).results[0].run;

      expect(run.status).toBe('skipped');
      expect(run.exit_reason).toContain('no longer eligible');
      expect(await db('email_messages').where({ idempotency_key: run.idempotency_key })).toHaveLength(0);
    });

    // The boundary guard can WAIT (a share lock on the service record); consent and
    // address are read only after the last wait, so a change committed during it counts.
    test.each([
      ['changes email', (customer) => db('customers').where({ id: customer.id }).update({ email: 'moved.while.waiting@example.invalid' })],
      ['turns email off', (customer) => db('notification_prefs').where({ customer_id: customer.id }).update({ email_enabled: false })],
    ])('the customer %s WHILE the boundary guard waits on the service_records lock: refused, nothing sent', async (_label, change) => {
      process.env.GATE_EMAIL_TEMPLATE_AUTOMATIONS = 'true';
      const customer = await makeCustomer();
      const techId = await makeTech();
      await makeNextVisit(customer.id);
      const recordId = await makeVisit({ customerId: customer.id, technicianId: techId, products: ['taurus'] });
      const automation = await makeAutomation({
        trigger_event_key: 'visit.completed_first', template_key: 'lc.first_visit_pest', suppression_group_key: 'service_operational',
        idempotency_key_template: `qa-wiring-${randomUUID().slice(0, 6)}:{service_record_id}`,
      });
      sendTemplate.mockImplementation(libraryLike());

      // Another writer holds the service record: the boundary guard's FOR SHARE must wait for it.
      let releaseHolder;
      let holderLocked;
      const locked = new Promise((resolve) => { holderLocked = resolve; });
      const holder = db.transaction(async (trx) => {
        await trx('service_records').where({ id: recordId }).forUpdate().first('id');
        holderLocked();
        await new Promise((resolve) => { releaseHolder = resolve; });
      });
      await locked;

      const runPromise = Executor.processTrigger({
        triggerEventKey: 'visit.completed_first',
        triggerEventId: `visit_completed_first:${recordId}`,
        automationKey: automation.automation_key,
        entityType: 'service_record',
        entityId: recordId,
        recipient: { type: 'customer', id: customer.id, email: customer.email },
        payload: { service_record_id: recordId, customer_id: customer.id },
        executeImmediately: true,
      });
      // The reservation exists and the guard is now blocked on the lock...
      await waitFor(() => db('marketing_email_ledger').where({ customer_id: customer.id, status: 'reserved' }).first());
      await new Promise((resolve) => setTimeout(resolve, 300));
      // ...the customer's consent / address changes while it waits, then the lock is released.
      await change(customer);
      releaseHolder();
      await holder;

      const run = (await runPromise).results[0].run;
      expect(run.status).toBe('skipped');
      expect(await db('email_messages').where({ idempotency_key: run.idempotency_key })).toHaveLength(0);
      const ledger = await db('marketing_email_ledger').where({ customer_id: customer.id });
      expect(ledger[0].status).toBe('skipped');
    });

    test('B1: the appointment is reclassified COMMERCIAL after the build: refused at the boundary (the builder\'s own gate), nothing sent', async () => {
      process.env.GATE_EMAIL_TEMPLATE_AUTOMATIONS = 'true';
      const customer = await makeCustomer();
      const techId = await makeTech();
      const series = await makeDoneRecurring(customer.id);
      await makeNextVisit(customer.id);
      const recordId = await makeVisit({ customerId: customer.id, technicianId: techId, products: ['taurus'], scheduledServiceId: series });
      const automation = await makeAutomation({
        trigger_event_key: 'visit.completed_first', template_key: 'lc.first_visit_pest', suppression_group_key: 'service_operational',
        idempotency_key_template: `qa-wiring-${randomUUID().slice(0, 6)}:{service_record_id}`,
      });
      sendTemplate.mockImplementation(libraryLike({
        beforeHandoff: () => db('scheduled_services').where({ id: series }).update({ service_type: 'Commercial Quarterly Pest Control' }),
      }));
      const run = (await Executor.processTrigger({
        triggerEventKey: 'visit.completed_first',
        triggerEventId: `visit_completed_first:${recordId}`,
        automationKey: automation.automation_key,
        entityType: 'service_record',
        entityId: recordId,
        recipient: { type: 'customer', id: customer.id, email: customer.email },
        payload: { service_record_id: recordId, customer_id: customer.id },
        executeImmediately: true,
      })).results[0].run;
      expect(run.status).toBe('skipped');
      expect(await db('email_messages').where({ idempotency_key: run.idempotency_key })).toHaveLength(0);
    });

    // The gate is read AGAIN after the builder (it awaits database work, radar and
    // consultation calls): a flip to shadow or off during it stops the send.
    test.each([
      ['shadow', 'shadow', 'would_send'],
      ['off', 'skipped', null],
    ])('the gate flips to %s DURING the payload builder: no send', async (mode, expectedStatus) => {
      process.env.GATE_EMAIL_TEMPLATE_AUTOMATIONS = 'true';
      const customer = await makeCustomer();
      const estimateId = await makeEstimate(customer.id, customer.email);
      const automation = await nurtureAutomation();
      sendTemplate.mockImplementation(libraryLike());
      require('../services/estimate-follow-up')._private.mintStageLinks.mockImplementationOnce(async () => {
        process.env.GATE_EMAIL_TEMPLATE_AUTOMATIONS = mode;
        return { emailUrl: 'https://example.test/l/minted' };
      });

      const run = (await fire(automation, { estimateId, customerId: customer.id, email: customer.email })).results[0].run;

      expect(run.status).toBe(expectedStatus);
      if (mode === 'off') expect(run.exit_reason).toContain('gate is off');
      expect(sendTemplate).not.toHaveBeenCalled();
      expect(await db('marketing_email_ledger').where({ customer_id: customer.id })).toHaveLength(0);
    });

    test('B1: two first-visit records created at the same instant give exactly ONE send (tie-break + the once-per-customer-and-property ledger guard)', async () => {
      process.env.GATE_EMAIL_TEMPLATE_AUTOMATIONS = 'true';
      const customer = await makeCustomer();
      const techId = await makeTech();
      const series = await makeDoneRecurring(customer.id);
      await makeNextVisit(customer.id);
      const at = new Date('2026-09-20T15:00:00Z');
      const a = await makeVisit({ customerId: customer.id, technicianId: techId, scheduledServiceId: series, createdAt: at, products: ['taurus'] });
      const b = await makeVisit({ customerId: customer.id, technicianId: techId, scheduledServiceId: series, createdAt: at, products: ['taurus'] });
      const automation = await makeAutomation({
        trigger_event_key: 'visit.completed_first', template_key: 'lc.first_visit_pest', suppression_group_key: 'service_operational',
        idempotency_key_template: `qa-wiring-${randomUUID().slice(0, 6)}:{service_record_id}`,
      });
      sendTemplate.mockImplementation(libraryLike());
      const fireFor = (recordId) => Executor.processTrigger({
        triggerEventKey: 'visit.completed_first',
        triggerEventId: `visit_completed_first:${recordId}`,
        automationKey: automation.automation_key,
        entityType: 'service_record',
        entityId: recordId,
        recipient: { type: 'customer', id: customer.id, email: customer.email },
        payload: { service_record_id: recordId, customer_id: customer.id },
        executeImmediately: true,
      }).then((out) => out.results[0].run);
      const runs = await Promise.all([fireFor(a), fireFor(b)]);
      expect(runs.map((r) => r.status).sort()).toEqual(['sent', 'skipped']);
      expect(await db('email_messages').whereIn('idempotency_key', runs.map((r) => r.idempotency_key))).toHaveLength(1);
    });

    test('the B1 once-guard is per customer AND PROPERTY: a sent first-visit email at property A blocks a sibling at A but not one at property B', async () => {
      const customer = await makeCustomer();
      const techId = await makeTech();
      const [propA] = await db('customer_properties').insert({ customer_id: customer.id, city: 'Parrish' }).returning('id');
      const [propB] = await db('customer_properties').insert({ customer_id: customer.id, city: 'Venice' }).returning('id');
      const rootA = await makeDoneRecurring(customer.id, { property_id: propA.id });
      const rootB = await makeDoneRecurring(customer.id, { property_id: propB.id });
      const sentA = await makeVisit({ customerId: customer.id, technicianId: techId, scheduledServiceId: rootA });
      const siblingA = await makeVisit({ customerId: customer.id, technicianId: techId, scheduledServiceId: rootA, createdAt: new Date('2026-09-21T15:00:00Z') });
      const atB = await makeVisit({ customerId: customer.id, technicianId: techId, scheduledServiceId: rootB, createdAt: new Date('2026-09-22T15:00:00Z') });
      const automation = await makeAutomation({
        trigger_event_key: 'visit.completed_first', template_key: 'lc.first_visit_pest', suppression_group_key: 'service_operational',
        idempotency_key_template: 'unused:{service_record_id}',
      });
      // A SENT run for the record at property A (the delivery authority the guard reads).
      await db('email_template_automation_runs').insert({
        automation_id: automation.id, automation_key: automation.automation_key, trigger_event_key: 'visit.completed_first', entity_type: 'service_record',
        entity_id: sentA, template_key: 'lc.first_visit_pest', recipient_type: 'customer', recipient_id: customer.id,
        recipient_email: customer.email, idempotency_key: `sent-${randomUUID()}`, status: 'sent',
      });
      const runFor2 = (entityId) => ({
        id: randomUUID(), template_key: 'lc.first_visit_pest', entity_id: entityId, recipient_id: customer.id, recipient_email: customer.email, idempotency_key: `probe-${randomUUID()}`,
      });
      const guard = (entityId) => Builders.ledgerGuardsFor(runFor2(entityId)).guard(db);
      expect(await guard(siblingA)).toEqual({ reason: 'ONCE_ALREADY_DELIVERED' });
      expect(await guard(atB)).toBeNull();
    });

    test.each([
      ['rescheduled', (id) => db('scheduled_services').where({ id }).update({ status: 'rescheduled' })],
      ['cancelled', (id) => db('scheduled_services').where({ id }).update({ status: 'cancelled' })],
      ['re-dated', (id) => db('scheduled_services').where({ id }).update({ scheduled_date: '2099-11-02' })],
    ])('B1: the next appointment the email names is %s AFTER the build, before the provider handoff: refused at the boundary, nothing sent', async (_label, change) => {
      process.env.GATE_EMAIL_TEMPLATE_AUTOMATIONS = 'true';
      const customer = await makeCustomer();
      const techId = await makeTech();
      const series = await makeDoneRecurring(customer.id);
      const nextId = await makeNextVisit(customer.id);
      const recordId = await makeVisit({ customerId: customer.id, technicianId: techId, products: ['taurus'], scheduledServiceId: series });
      const automation = await makeAutomation({
        trigger_event_key: 'visit.completed_first', template_key: 'lc.first_visit_pest', suppression_group_key: 'service_operational',
        idempotency_key_template: `qa-wiring-${randomUUID().slice(0, 6)}:{service_record_id}`,
      });
      sendTemplate.mockImplementation(libraryLike({ beforeHandoff: () => change(nextId) }));
      const run = (await Executor.processTrigger({
        triggerEventKey: 'visit.completed_first',
        triggerEventId: `visit_completed_first:${recordId}`,
        automationKey: automation.automation_key,
        entityType: 'service_record',
        entityId: recordId,
        recipient: { type: 'customer', id: customer.id, email: customer.email },
        payload: { service_record_id: recordId, customer_id: customer.id },
        executeImmediately: true,
      })).results[0].run;
      expect(run.status).toBe('skipped');
      expect(run.exit_reason).toContain('next appointment');
      const skipped = (await events(run.id)).find((e) => e.event_type === 'skipped');
      expect(skipped.metadata).toEqual(expect.objectContaining({ guard: 'next_visit_changed' }));
      expect(await db('email_messages').where({ idempotency_key: run.idempotency_key })).toHaveLength(0);
    });

    test.each([
      ['changed to a lawn appointment', (id) => db('scheduled_services').where({ id }).update({ service_type: 'Lawn Care Service' })],
      ['moved to another property', (id) => db('scheduled_services').where({ id }).update({ service_address_line1: '999 Other Rd', service_address_city: 'Venice', service_address_zip: '34285' })],
      ['reassigned to another customer', async (id) => {
        const other = await makeCustomer();
        await db('scheduled_services').where({ id }).update({ customer_id: other.id });
      }],
    ])('B1: the named next appointment is %s AFTER the build (same id, same date): refused at the boundary, nothing sent', async (_label, change) => {
      process.env.GATE_EMAIL_TEMPLATE_AUTOMATIONS = 'true';
      const customer = await makeCustomer();
      const techId = await makeTech();
      const series = await makeDoneRecurring(customer.id);
      const nextId = await makeNextVisit(customer.id);
      const recordId = await makeVisit({ customerId: customer.id, technicianId: techId, products: ['taurus'], scheduledServiceId: series });
      const automation = await makeAutomation({
        trigger_event_key: 'visit.completed_first', template_key: 'lc.first_visit_pest', suppression_group_key: 'service_operational',
        idempotency_key_template: `qa-wiring-${randomUUID().slice(0, 6)}:{service_record_id}`,
      });
      sendTemplate.mockImplementation(libraryLike({ beforeHandoff: () => change(nextId) }));
      const run = (await Executor.processTrigger({
        triggerEventKey: 'visit.completed_first',
        triggerEventId: `visit_completed_first:${recordId}`,
        automationKey: automation.automation_key,
        entityType: 'service_record',
        entityId: recordId,
        recipient: { type: 'customer', id: customer.id, email: customer.email },
        payload: { service_record_id: recordId, customer_id: customer.id },
        executeImmediately: true,
      })).results[0].run;
      expect(run.status).toBe('skipped');
      const skipped = (await events(run.id)).find((e) => e.event_type === 'skipped');
      expect(skipped.metadata).toEqual(expect.objectContaining({ guard: 'next_visit_changed' }));
      expect(await db('email_messages').where({ idempotency_key: run.idempotency_key })).toHaveLength(0);
    });

    // The plan predicates read scheduled_services and customers: their rows are share-locked on
    // the boundary transaction, so a change committed by another writer WAITS for the handoff.
    test.each([
      ['the series is cancelled', (ids) => db('scheduled_services').where({ id: ids.series }).update({ status: 'cancelled', recurring_ongoing: false })],
      ['the account is reclassified commercial', (ids) => db('customers').where({ id: ids.customerId }).update({ property_type: 'commercial' })],
    ])('B1: %s in another transaction DURING the provider handoff: the write waits for the handoff (the locks the gate took), the send was judged on the state it locked', async (_label, change) => {
      process.env.GATE_EMAIL_TEMPLATE_AUTOMATIONS = 'true';
      const customer = await makeCustomer();
      const techId = await makeTech();
      const series = await makeDoneRecurring(customer.id);
      await makeNextVisit(customer.id);
      const recordId = await makeVisit({ customerId: customer.id, technicianId: techId, products: ['taurus'], scheduledServiceId: series });
      const automation = await makeAutomation({
        trigger_event_key: 'visit.completed_first', template_key: 'lc.first_visit_pest', suppression_group_key: 'service_operational',
        idempotency_key_template: `qa-wiring-${randomUUID().slice(0, 6)}:{service_record_id}`,
      });
      let writer = null;
      let writerDone = false;
      let waitedForHandoff = false;
      sendTemplate.mockImplementation(libraryLike({
        duringHandoff: async () => {
          writer = Promise.resolve(change({ series, customerId: customer.id })).then(() => { writerDone = true; });
          await new Promise((resolve) => setTimeout(resolve, 500));
          waitedForHandoff = !writerDone;
        },
      }));
      const run = (await Executor.processTrigger({
        triggerEventKey: 'visit.completed_first',
        triggerEventId: `visit_completed_first:${recordId}`,
        automationKey: automation.automation_key,
        entityType: 'service_record',
        entityId: recordId,
        recipient: { type: 'customer', id: customer.id, email: customer.email },
        payload: { service_record_id: recordId, customer_id: customer.id },
        executeImmediately: true,
      })).results[0].run;
      await writer;
      expect(waitedForHandoff).toBe(true);
      expect(run.status).toBe('sent');
    });

    test.each([
      ['a commercial service', 'Commercial Quarterly Pest Control'],
      ['a pest + termite bundle', 'Quarterly Pest + Termite Bait Station'],
    ])('B1: the series root is OVERRIDDEN to %s AFTER the build (recurring_template_overrides): refused at the boundary, nothing sent', async (_label, overriddenTo) => {
      process.env.GATE_EMAIL_TEMPLATE_AUTOMATIONS = 'true';
      const customer = await makeCustomer();
      const techId = await makeTech();
      const series = await makeDoneRecurring(customer.id);
      await makeNextVisit(customer.id);
      const recordId = await makeVisit({ customerId: customer.id, technicianId: techId, products: ['taurus'], scheduledServiceId: series });
      const automation = await makeAutomation({
        trigger_event_key: 'visit.completed_first', template_key: 'lc.first_visit_pest', suppression_group_key: 'service_operational',
        idempotency_key_template: `qa-wiring-${randomUUID().slice(0, 6)}:{service_record_id}`,
      });
      sendTemplate.mockImplementation(libraryLike({
        beforeHandoff: () => db('scheduled_services').where({ id: series }).update({ recurring_template_overrides: JSON.stringify({ service_type: overriddenTo }) }),
      }));
      const run = (await Executor.processTrigger({
        triggerEventKey: 'visit.completed_first',
        triggerEventId: `visit_completed_first:${recordId}`,
        automationKey: automation.automation_key,
        entityType: 'service_record',
        entityId: recordId,
        recipient: { type: 'customer', id: customer.id, email: customer.email },
        payload: { service_record_id: recordId, customer_id: customer.id },
        executeImmediately: true,
      })).results[0].run;
      expect(run.status).toBe('skipped');
      const skipped = (await events(run.id)).find((e) => e.event_type === 'skipped');
      expect(skipped.metadata).toEqual(expect.objectContaining({ guard: 'visit_not_eligible' }));
      expect(await db('email_messages').where({ idempotency_key: run.idempotency_key })).toHaveLength(0);
    });

    test('a lifecycle key (lc.first_visit_pest) rides the ledger lifecycle stream as relationship mail', async () => {
      process.env.GATE_EMAIL_TEMPLATE_AUTOMATIONS = 'true';
      const customer = await makeCustomer();
      const techId = await makeTech();
      await makeNextVisit(customer.id);
      const recordId = await makeVisit({ customerId: customer.id, technicianId: techId, products: ['taurus'] });
      const automation = await makeAutomation({
        trigger_event_key: 'visit.completed_first', template_key: 'lc.first_visit_pest', suppression_group_key: 'service_operational',
        idempotency_key_template: `qa-wiring-${randomUUID().slice(0, 6)}:{service_record_id}`,
      });
      sendTemplate.mockImplementation(libraryLike());

      const out = await Executor.processTrigger({
        triggerEventKey: 'visit.completed_first',
        triggerEventId: `visit_completed_first:${recordId}`,
        automationKey: automation.automation_key,
        entityType: 'service_record',
        entityId: recordId,
        recipient: { type: 'customer', id: customer.id, email: customer.email },
        payload: { service_record_id: recordId, customer_id: customer.id },
        executeImmediately: true,
      });
      const run = out.results[0].run;

      expect(run.status).toBe('sent');
      const args = sendTemplate.mock.calls[0][0];
      expect(args.marketingRequiresLedger).toBeUndefined();
      expect(args.suppressionGroupKey).toBe('service_operational');
      expect(args.payload.primary_product_name).toBe('Taurus SC');
      expect(args.payload.nonrepellent_band_note).toContain('non-repellent insecticide');
      const ledger = await db('marketing_email_ledger').where({ customer_id: customer.id });
      expect(ledger[0]).toEqual(expect.objectContaining({ stream: 'lifecycle', marketing_class: 'relationship', status: 'sent' }));
    });
  });

  // ---- once per customer / estimate: the atomic send-time rule ------------

  describe('once-per-customer (B5) and once-per-estimate (C1) are decided atomically at the ledger reservation', () => {
    const reclaim = (run) => db('email_template_automation_runs').where({ id: run.id }).update({
      status: 'queued', attempts: 0, run_after: new Date(Date.now() - 1000), completed_at: null, email_message_id: null, last_error: null,
    });
    const latch = () => {
      let release;
      const gate = new Promise((resolve) => { release = resolve; });
      return { gate, release };
    };

    // Customer with visit 1, two visit-2 records (two eligible reports) on a quarterly pest plan.
    async function whyScenario() {
      process.env.GATE_EMAIL_TEMPLATE_AUTOMATIONS = 'true';
      const customer = await makeCustomer();
      const techId = await makeTech();
      const [propA] = await db('customer_properties').insert({ customer_id: customer.id, city: 'Parrish' }).returning('id');
      const [propB] = await db('customer_properties').insert({ customer_id: customer.id, city: 'Venice' }).returning('id');
      const scheduledId = await makeNextVisit(customer.id, 'quarterly', '2099-12-24', { property_id: propA.id });
      const scheduledB = await makeNextVisit(customer.id, 'quarterly', '2099-12-24', { property_id: propB.id });
      const visit1 = await makeVisit({ customerId: customer.id, technicianId: techId, visitNumber: 1, date: '2026-06-20', products: ['taurus'], scheduledServiceId: scheduledId, createdAt: new Date('2026-06-20T15:00:00Z') });
      const visit2 = await makeVisit({ customerId: customer.id, technicianId: techId, visitNumber: 2, date: '2026-09-20', products: ['taurus', 'talak'], scheduledServiceId: scheduledId });
      await makeVisit({ customerId: customer.id, technicianId: techId, visitNumber: 3, date: '2026-06-21', products: ['taurus'], scheduledServiceId: scheduledB, createdAt: new Date('2026-06-21T15:00:00Z') });
      const visit2b = await makeVisit({ customerId: customer.id, technicianId: techId, visitNumber: 4, date: '2026-09-21', products: ['taurus', 'talak'], scheduledServiceId: scheduledB, createdAt: new Date('2026-09-21T15:00:00Z') });
      const automation = await makeAutomation({
        trigger_event_key: 'service_report.ready', template_key: 'lc.why_91_days', suppression_group_key: 'service_operational',
        idempotency_key_template: `qa-wiring-${randomUUID().slice(0, 6)}:{service_record_id}`,
      });
      const report = (recordId, { immediately = true } = {}) => Executor.processTrigger({
        triggerEventKey: 'service_report.ready',
        triggerEventId: `service_report_ready:${recordId}:customer`,
        automationKey: automation.automation_key,
        entityType: 'service_record',
        entityId: recordId,
        recipient: { type: 'customer', id: customer.id, email: customer.email },
        payload: { service_record_id: recordId, customer_id: customer.id },
        executeImmediately: immediately,
      }).then((out) => out.results[0].run);
      return {
        customer, visit1, visit2, visit2b, report,
      };
    }

    test('B5: a pest recap swaps Taurus for another non-repellent on the plan\'s visit AFTER the build, before the provider handoff: the product predicate is re-run at the boundary, nothing sent', async () => {
      const { visit2, report } = await whyScenario();
      sendTemplate.mockImplementation(libraryLike({
        beforeHandoff: async () => {
          await db('service_products').where({ service_record_id: visit2 }).del();
          for (const key of ['alpine', 'talak']) await db('service_products').insert({ service_record_id: visit2, ...PRODUCTS[key], targets: [] });
        },
      }));
      const run = await report(visit2);
      expect(run.status).toBe('skipped');
      const skipped = (await events(run.id)).find((e) => e.event_type === 'skipped');
      expect(skipped.metadata).toEqual(expect.objectContaining({ guard: 'visit_not_eligible' }));
      expect(await db('email_messages').where({ idempotency_key: run.idempotency_key })).toHaveLength(0);
    });

    test('a reclaimed crashed run (REAL lc.why_91_days builder) is not skipped by its own reservation: an accepted delivery is recovered as sent, an abandoned reservation is settled and sent', async () => {
      const { customer, visit2, report } = await whyScenario();
      sendTemplate.mockImplementation(libraryLike());
      const first = await report(visit2);
      expect(first.status).toBe('sent');
      const key = first.idempotency_key;

      // Crash after provider acceptance, before the ledger settled: row reserved, message accepted.
      await db('marketing_email_ledger').where({ idempotency_key: key }).update({ status: 'reserved', sent_at: null, email_message_id: null, reason: null });
      await reclaim(first);
      const recovered = await Executor.executeRun(first.id);
      expect(recovered.status).toBe('sent'); // not skipped as "already delivered"
      expect(sendTemplate).toHaveBeenCalledTimes(1);

      // Crash before the provider was reached: an expired, abandoned reservation and no message.
      await db('email_messages').where({ idempotency_key: key }).del();
      await db('marketing_email_ledger').where({ idempotency_key: key }).update({
        status: 'reserved', sent_at: null, email_message_id: null, reserved_at: new Date(Date.now() - 31 * 60 * 1000),
      });
      await db('email_template_automation_runs').where({ id: first.id }).update({ email_message_id: null });
      await reclaim(first);
      const resent = await Executor.executeRun(first.id);
      expect(resent.status).toBe('sent');
      expect(sendTemplate).toHaveBeenCalledTimes(2);
      expect(await db('marketing_email_ledger').where({ customer_id: customer.id, status: 'sent' })).toHaveLength(1);
    });

    test('two concurrent ELIGIBLE reports produce exactly one send: the live reservation makes the second IN FLIGHT (deferred through the bounded retry, never a terminal skip); once the first is sent the retry is skipped', async () => {
      const { customer, visit2, visit2b, report } = await whyScenario();
      const hold = latch();
      sendTemplate.mockImplementation(libraryLike({ beforeHandoff: () => hold.gate }));

      const firstPromise = report(visit2);
      await waitFor(() => db('marketing_email_ledger').where({ customer_id: customer.id, email_key: 'lc.why_91_days', status: 'reserved' }).first());
      const second = await report(visit2b);
      expect(second.status).toBe('retry_scheduled');
      expect(second.last_error).toContain('in flight');

      hold.release();
      const first = await firstPromise;
      expect(first.status).toBe('sent');
      await reclaim(second);
      const retried = await Executor.executeRun(second.id);
      expect(retried.status).toBe('skipped');
      expect(retried.exit_reason).toContain('already has a sent');
      expect(sendTemplate).toHaveBeenCalledTimes(1);
      expect(await db('marketing_email_ledger').where({ customer_id: customer.id, email_key: 'lc.why_91_days', status: 'sent' })).toHaveLength(1);
    });

    test('B5: a crash after an accepted delivery, then the record is reclassified as a callback: the reclaimed run is finalized sent (recovery precedes the builder)', async () => {
      const { customer, visit2, report } = await whyScenario();
      sendTemplate.mockImplementation(libraryLike());
      const first = await report(visit2);
      expect(first.status).toBe('sent');
      await db('marketing_email_ledger').where({ idempotency_key: first.idempotency_key }).update({ status: 'reserved', sent_at: null, email_message_id: null, reason: null });
      await db('service_records').where({ id: visit2 }).update({ is_callback: true }); // the builder would now skip it (a callback is not a plan visit)
      await reclaim(first);
      const recovered = await Executor.executeRun(first.id);
      expect(recovered.status).toBe('sent');
      expect(sendTemplate).toHaveBeenCalledTimes(1);
      // The ledger row was settled from the delivery authority (reconciled), not re-sent.
      const ledger = await db('marketing_email_ledger').where({ customer_id: customer.id, status: 'sent' });
      expect(ledger).toHaveLength(1);
      expect(ledger[0].reason).toBe('reconciled_from_email_messages');
    });

    test('B5: the record is reclassified as a callback AFTER the build, before the provider handoff: refused at the boundary, nothing sent', async () => {
      const { visit2, report } = await whyScenario();
      sendTemplate.mockImplementation(libraryLike({ beforeHandoff: () => db('service_records').where({ id: visit2 }).update({ is_callback: true }) }));
      const run = await report(visit2);
      expect(run.status).toBe('skipped');
      expect(run.exit_reason).toContain('no longer eligible');
      expect(await db('email_messages').where({ idempotency_key: run.idempotency_key })).toHaveLength(0);
    });

    test('shadow applies the once-rule too: two concurrent qualifying B5 reports record exactly ONE would_send, the other would_block once_already_counted; a live replay still promotes the winner', async () => {
      const { customer, visit2, visit2b, report } = await whyScenario();
      process.env.GATE_EMAIL_TEMPLATE_AUTOMATIONS = 'shadow';
      const [a, b] = await Promise.all([report(visit2), report(visit2b)]);
      const statuses = [a.status, b.status].sort();
      expect(statuses).toEqual(['shadow', 'skipped']);
      const loser = a.status === 'skipped' ? a : b;
      const winner = a.status === 'shadow' ? a : b;
      const blocked = (await db('email_template_automation_run_events').where({ run_id: loser.id, event_type: 'would_block' }))[0];
      expect(blocked.metadata).toEqual(expect.objectContaining({ guard: 'once_already_counted' }));
      expect(await db('email_template_automation_run_events').where({ run_id: loser.id, event_type: 'would_send' })).toHaveLength(0);
      expect(sendTemplate).not.toHaveBeenCalled();
      expect(await db('marketing_email_ledger').where({ customer_id: customer.id })).toHaveLength(0);

      // Gate goes live: the SAME winner run is promoted in place (#5418) and sends.
      process.env.GATE_EMAIL_TEMPLATE_AUTOMATIONS = 'true';
      sendTemplate.mockImplementation(libraryLike());
      const winnerRecord = winner.entity_id;
      const promoted = await report(winnerRecord);
      expect(promoted.id).toBe(winner.id);
      expect(promoted.status).toBe('sent');
    });

    test('a queued first-visit report that will never qualify does not block the second-visit send', async () => {
      const { visit1, visit2, report } = await whyScenario();
      sendTemplate.mockImplementation(libraryLike());
      const queuedFirst = await report(visit1, { immediately: false });
      expect(queuedFirst.status).toBe('queued');

      const second = await report(visit2);
      expect(second.status).toBe('sent');
      // The queued sibling, when it runs, is skipped on its own merits.
      const later = await Executor.executeRun(queuedFirst.id);
      expect(later.status).toBe('skipped');
      expect(later.exit_reason).toContain('second performed pest visit');
      expect(sendTemplate).toHaveBeenCalledTimes(1);
    });

    test('nurture.expired_1, same rule per estimate: while the first run is in flight, a run for the estimate\'s NEWER expiry defers; the first is then superseded at the boundary (terminal skip), and the newer run sends once', async () => {
      process.env.GATE_EMAIL_TEMPLATE_AUTOMATIONS = 'true';
      const customer = await makeCustomer();
      const estimateId = await makeEstimate(customer.id, customer.email);
      const automation = await nurtureAutomation();
      const hold = latch();
      sendTemplate.mockImplementation(libraryLike({ beforeHandoff: () => hold.gate }));

      const firstPromise = fire(automation, { estimateId, customerId: customer.id, email: customer.email, expiresOn: '2026-09-21' });
      await waitFor(() => db('marketing_email_ledger').where({ customer_id: customer.id, email_key: 'nurture.expired_1', status: 'reserved' }).first());
      // Extended and expired again while the first is held: the estimate's current expiry is Oct 20.
      await db('estimates').where({ id: estimateId }).update({ expires_at: new Date('2026-10-20T16:00:00Z') });
      const second = (await fire(automation, { estimateId, customerId: customer.id, email: customer.email, expiresOn: '2026-10-20' })).results[0].run;
      expect(second.status).toBe('retry_scheduled');
      expect(second.last_error).toContain('in flight');

      hold.release();
      const first = (await firstPromise).results[0].run;
      expect(first.status).toBe('skipped'); // superseded at the provider boundary: never sent, never counted
      expect(first.exit_reason).toContain('extended and expired again');
      await reclaim(second);
      const retried = await Executor.executeRun(second.id);
      expect(retried.status).toBe('sent');
      // The first run was vetoed at the boundary (nothing delivered); only the newer run's message exists.
      expect(await db('email_messages').where({ idempotency_key: first.idempotency_key })).toHaveLength(0);
      expect(await db('email_messages').where({ idempotency_key: second.idempotency_key })).toHaveLength(1);
    });

    test('a delayed nurture run is bound to the expiry that triggered it: extended and expired again during the delay -> the old run is skipped (build time), never sent', async () => {
      process.env.GATE_EMAIL_TEMPLATE_AUTOMATIONS = 'true';
      const customer = await makeCustomer();
      const estimateId = await makeEstimate(customer.id, customer.email); // expires_at Sep 21
      const automation = await nurtureAutomation();
      sendTemplate.mockImplementation(libraryLike());
      const old = (await fire(automation, {
        estimateId, customerId: customer.id, email: customer.email, expiresOn: '2026-09-21', immediately: false,
      })).results[0].run;
      await db('estimates').where({ id: estimateId }).update({ expires_at: new Date('2026-09-22T16:00:00Z') }); // one-day extension, expired again
      const result = await Executor.executeRun(old.id);
      expect(result.status).toBe('skipped');
      expect(result.exit_reason).toContain('extended and expired again');
      expect(sendTemplate).not.toHaveBeenCalled();
    });
  });

  // ---- payload builders ---------------------------------------------------

  describe('payload builders', () => {
    const baseDeps = (overrides = {}) => ({
      getActivityRatingAverages: async () => ({ byVisit: {}, counts: {} }),
      getAreaIntelSentence: async () => null,
      fetchMrmsDailyRain: async () => null,
      ...overrides,
    });
    const runFor = (templateKey, entityId, customer, extra = {}) => ({
      id: randomUUID(), template_key: templateKey, entity_id: entityId, recipient_id: customer.id, recipient_email: customer.email, ...extra,
    });

    describe('lc.first_visit_pest', () => {
      async function scenario(visitOverrides = {}) {
        const customer = await makeCustomer({ latitude: null });
        const techId = await makeTech();
        await makeNextVisit(customer.id);
        const recordId = await makeVisit({ customerId: customer.id, technicianId: techId, ...visitOverrides });
        return { customer, recordId };
      }

      test('Taurus SC primary -> the non-repellent note is the manufacturer wording; every required field is filled', async () => {
        const { customer, recordId } = await scenario({ products: ['taurus', 'talak'] });
        const result = await Builders.buildEmailDivisionPayload({
          run: runFor('lc.first_visit_pest', recordId, customer), mode: 'live', deps: baseDeps(),
        });
        expect(result.ok).toBe(true);
        expect(result.payload).toEqual(expect.objectContaining({
          first_name: 'Jordan', tech_first_name: 'Marco', primary_product_name: 'Taurus SC', primary_active_ingredient: 'fipronil',
          areas_treated_list: 'the foundation perimeter and garage entry', pests_named_list: 'ghost ants',
          visit_date_short: 'Sep 20', visit_date_long: 'September 20, 2026', next_visit_date: 'December 24, 2099',
        }));
        expect(result.payload.nonrepellent_band_note).toBe('Its manufacturer describes Taurus SC as a non-repellent insecticide that target pests cannot detect, so they touch, ingest and spread it.');
        expect(result.payload.secondary_products_sentence).toContain('We also applied Talak 7.9% F');
        // No fixed minute figure anywhere in an advisory sentence.
        expect(result.payload.pet_advisory_sentence).not.toMatch(/\d/);
      });

      test('a non-Taurus primary (Talak, bifenthrin) -> the non-repellent note stays BLANK', async () => {
        const { customer, recordId } = await scenario({ products: ['talak'] });
        const result = await Builders.buildEmailDivisionPayload({
          run: runFor('lc.first_visit_pest', recordId, customer), mode: 'live', deps: baseDeps(),
        });
        expect(result.ok).toBe(true);
        expect(result.payload.primary_product_name).toBe('Talak 7.9% F');
        expect(result.payload.nonrepellent_band_note).toBe('');
      });

      test('the activity-rating sentence: a tech-chosen rating + a >=20 cohort gives both clauses; a defaulted first-visit rating is never shown; no cohort drops the averages clause', async () => {
        const chosen = await scenario({ rating: 3, ratingSource: 'technician', defaulted: false });
        const cohort = { byVisit: { pest: { 1: 3.14, 2: 1.2 } }, counts: {} };
        const both = await Builders.buildEmailDivisionPayload({
          run: runFor('lc.first_visit_pest', chosen.recordId, chosen.customer), mode: 'live',
          deps: baseDeps({ getActivityRatingAverages: async () => cohort }),
        });
        expect(both.payload.activity_rating_sentence).toBe('The pest activity rating recorded at this visit was 3, on a scale from 0 (none) to 5 (high). Across Waves visit records, that rating averages 3.1 at a first visit and 1.2 at the second.');

        const noCohort = await Builders.buildEmailDivisionPayload({
          run: runFor('lc.first_visit_pest', chosen.recordId, chosen.customer), mode: 'live', deps: baseDeps(),
        });
        expect(noCohort.payload.activity_rating_sentence).toBe('The pest activity rating recorded at this visit was 3, on a scale from 0 (none) to 5 (high).');

        const defaulted = await scenario({ rating: 5, ratingSource: 'technician', defaulted: true });
        const hidden = await Builders.buildEmailDivisionPayload({
          run: runFor('lc.first_visit_pest', defaulted.recordId, defaulted.customer), mode: 'live', deps: baseDeps(),
        });
        expect(hidden.payload.activity_rating_sentence).toBe('');
        const hiddenWithCohort = await Builders.buildEmailDivisionPayload({
          run: runFor('lc.first_visit_pest', defaulted.recordId, defaulted.customer), mode: 'live',
          deps: baseDeps({ getActivityRatingAverages: async () => cohort }),
        });
        expect(hiddenWithCohort.payload.activity_rating_sentence).not.toContain('recorded at this visit');
        expect(hiddenWithCohort.payload.activity_rating_sentence).toContain('averages 3.1 at a first visit and 1.2 at the second');
      });

      test('skips (never renders a blank) when a required fact is missing: no upcoming PEST visit, no primary product, not first visit, wrong customer, non-pest line', async () => {
        const noNext = await makeCustomer();
        const noNextRecord = await makeVisit({ customerId: noNext.id, technicianId: await makeTech(), scheduledServiceId: await makeDoneRecurring(noNext.id) });
        const r1 = await Builders.buildEmailDivisionPayload({ run: runFor('lc.first_visit_pest', noNextRecord, noNext), mode: 'live', deps: baseDeps() });
        expect(r1).toEqual(expect.objectContaining({ skip: true, code: 'no_upcoming_pest_visit' }));

        const noProduct = await scenario({ products: [] });
        const r2 = await Builders.buildEmailDivisionPayload({ run: runFor('lc.first_visit_pest', noProduct.recordId, noProduct.customer), mode: 'live', deps: baseDeps() });
        expect(r2).toEqual(expect.objectContaining({ skip: true, code: 'no_primary_product' }));

        const repeat = await scenario({});
        await makeVisit({ customerId: repeat.customer.id, visitNumber: 0, date: '2026-06-01', createdAt: new Date('2026-06-01T15:00:00Z') });
        const r3 = await Builders.buildEmailDivisionPayload({ run: runFor('lc.first_visit_pest', repeat.recordId, repeat.customer), mode: 'live', deps: baseDeps() });
        expect(r3).toEqual(expect.objectContaining({ skip: true, code: 'not_first_visit' }));

        const other = await makeCustomer();
        const r4 = await Builders.buildEmailDivisionPayload({ run: runFor('lc.first_visit_pest', repeat.recordId, other), mode: 'live', deps: baseDeps() });
        expect(r4).toEqual(expect.objectContaining({ skip: true, code: 'recipient_not_visit_customer' }));

        const lawn = await scenario({ serviceLine: 'lawn' });
        const r5 = await Builders.buildEmailDivisionPayload({ run: runFor('lc.first_visit_pest', lawn.recordId, lawn.customer), mode: 'live', deps: baseDeps() });
        expect(r5).toEqual(expect.objectContaining({ skip: true, code: 'not_pest_line' }));
      });

      test('next visit is the next PEST appointment: a lawn visit tomorrow never names itself; no future pest visit -> SKIP', async () => {
        const customer = await makeCustomer();
        const techId = await makeTech();
        const tomorrow = new Date(Date.now() + 24 * 3600 * 1000).toISOString().slice(0, 10);
        await db('scheduled_services').insert({
          customer_id: customer.id, scheduled_date: tomorrow, service_type: 'Lawn Care Service', status: 'confirmed',
        });
        await makeNextVisit(customer.id, 'quarterly', '2099-12-24');
        const recordId = await makeVisit({ customerId: customer.id, technicianId: techId });
        const december = await Builders.buildEmailDivisionPayload({
          run: runFor('lc.first_visit_pest', recordId, customer), mode: 'live', deps: baseDeps(),
        });
        expect(december.payload.next_visit_date).toBe('December 24, 2099');

        const lawnOnly = await makeCustomer();
        await db('scheduled_services').insert({
          customer_id: lawnOnly.id, scheduled_date: tomorrow, service_type: 'Lawn Care Service', status: 'confirmed',
        });
        const lawnRecord = await makeVisit({ customerId: lawnOnly.id, technicianId: techId, scheduledServiceId: await makeDoneRecurring(lawnOnly.id) });
        const skipped = await Builders.buildEmailDivisionPayload({
          run: runFor('lc.first_visit_pest', lawnRecord, lawnOnly), mode: 'live', deps: baseDeps(),
        });
        expect(skipped).toEqual(expect.objectContaining({ skip: true, code: 'no_upcoming_pest_visit' }));
        expect(skipped.reason).toContain('no upcoming pest appointment');
      });

      test('the next visit is the next pest appointment AT THIS visit\'s property; unestablishable property with pest visits at two properties -> SKIP', async () => {
        const customer = await makeCustomer();
        const techId = await makeTech();
        const [propA] = await db('customer_properties').insert({ customer_id: customer.id, city: 'Parrish' }).returning('id');
        const [propB] = await db('customer_properties').insert({ customer_id: customer.id, city: 'Venice' }).returning('id');
        // This first visit happened at property A (its appointment, now completed).
        const [done] = await db('scheduled_services').insert({
          customer_id: customer.id, scheduled_date: '2026-09-20', service_type: 'Pest Control Service', status: 'completed', property_id: propA.id, recurring_pattern: 'quarterly', is_recurring: true, recurring_ongoing: true,
        }).returning('id');
        // Property B's pest visit comes SOONER than property A's next one.
        await makeNextVisit(customer.id, 'quarterly', '2098-01-05', { property_id: propB.id });
        await makeNextVisit(customer.id, 'quarterly', '2099-12-24', { property_id: propA.id });
        const linked = await makeVisit({ customerId: customer.id, technicianId: techId, scheduledServiceId: done.id });
        const a = await Builders.buildEmailDivisionPayload({ run: runFor('lc.first_visit_pest', linked, customer), mode: 'live', deps: baseDeps() });
        expect(a.payload.next_visit_date).toBe('December 24, 2099'); // never property B's January date

        // The visit carries no appointment link: two properties' recurring pest plans cannot be told apart,
        // so it cannot be shown to belong to an active recurring plan at ITS property: skipped.
        const other = await makeCustomer();
        const [propC] = await db('customer_properties').insert({ customer_id: other.id, city: 'Parrish' }).returning('id');
        const [propD] = await db('customer_properties').insert({ customer_id: other.id, city: 'Venice' }).returning('id');
        await makeNextVisit(other.id, 'quarterly', '2098-01-05', { property_id: propC.id });
        await makeNextVisit(other.id, 'quarterly', '2099-12-24', { property_id: propD.id });
        const unlinked = await makeVisit({ customerId: other.id, technicianId: techId });
        const skipped = await Builders.buildEmailDivisionPayload({ run: runFor('lc.first_visit_pest', unlinked, other), mode: 'live', deps: baseDeps() });
        expect(skipped).toEqual(expect.objectContaining({ skip: true, code: 'not_recurring_plan' }));
      });

      test('custom treatment chips never render: only targets in the canonical vocabulary count ("technicians treated no pests - prevention" is not a pest)', async () => {
        const customer = await makeCustomer();
        const techId = await makeTech();
        const series = await makeDoneRecurring(customer.id);
        await makeNextVisit(customer.id);
        const freeText = await makeVisit({
          customerId: customer.id, technicianId: techId, scheduledServiceId: series, targets: ['technicians treated no pests - prevention'], notes: 'Treated spiders along the eaves.',
        });
        const r1 = await Builders.buildEmailDivisionPayload({ run: runFor('lc.first_visit_pest', freeText, customer), mode: 'live', deps: baseDeps() });
        expect(r1.payload.pests_named_list).toBe('spiders'); // the chip is dropped; the notes fallback names the pest
        expect(r1.payload.pests_named_list).not.toContain('prevention');

        const mixed = await makeCustomer();
        const series2 = await makeDoneRecurring(mixed.id);
        await makeNextVisit(mixed.id);
        const both = await makeVisit({
          customerId: mixed.id, technicianId: techId, scheduledServiceId: series2, targets: ['Fire ants', 'my own free text chip'], notes: '',
        });
        const r2 = await Builders.buildEmailDivisionPayload({ run: runFor('lc.first_visit_pest', both, mixed), mode: 'live', deps: baseDeps() });
        expect(r2.payload.pests_named_list).toBe('fire ants');
      });

      test('a ONE-TIME first pest visit, plus a separately booked future one-off pest appointment, is NOT a recurring plan: skipped (no "re-service between visits" promise)', async () => {
        const customer = await makeCustomer();
        const techId = await makeTech();
        const [oneTime] = await db('scheduled_services').insert({
          customer_id: customer.id, scheduled_date: '2026-09-20', service_type: 'Pest Control Service', status: 'completed', recurring_pattern: 'one_time',
        }).returning('id');
        await makeNextVisit(customer.id, 'one_time', '2099-12-24'); // a separately booked one-off pest visit
        const recordId = await makeVisit({ customerId: customer.id, technicianId: techId, scheduledServiceId: oneTime.id });
        const result = await Builders.buildEmailDivisionPayload({ run: runFor('lc.first_visit_pest', recordId, customer), mode: 'live', deps: baseDeps() });
        expect(result).toEqual(expect.objectContaining({ skip: true, code: 'not_recurring_plan' }));
        // The same first visit, with a real recurring series at its property, is fine.
        const recurring = await makeCustomer();
        const doneId = await makeDoneRecurring(recurring.id);
        await makeNextVisit(recurring.id, 'quarterly', '2099-12-24');
        const ok = await Builders.buildEmailDivisionPayload({
          run: runFor('lc.first_visit_pest', await makeVisit({ customerId: recurring.id, technicianId: techId, scheduledServiceId: doneId }), recurring), mode: 'live', deps: baseDeps(),
        });
        expect(ok.ok).toBe(true);
      });

      test('a COMMERCIAL recurring pest plan is skipped (terms-neutral copy; the template promises free re-service) — by the record\'s type, the appointment\'s, the series root\'s, or the property\'s', async () => {
        const techId = await makeTech();
        const cases = {
          'record type': async (customer) => makeVisit({
            customerId: customer.id, technicianId: techId, serviceType: 'Commercial Quarterly Pest Control', scheduledServiceId: await makeDoneRecurring(customer.id),
          }),
          'appointment type': async (customer) => makeVisit({
            customerId: customer.id, technicianId: techId, scheduledServiceId: await makeDoneRecurring(customer.id, { service_type: 'Commercial Quarterly Pest Control' }),
          }),
          'series root': async (customer) => {
            const root = await makeDoneRecurring(customer.id, { service_type: 'Commercial Quarterly Pest Control' });
            const child = await makeDoneRecurring(customer.id, { recurring_parent_id: root, service_type: 'Quarterly Pest Control Service' });
            return makeVisit({ customerId: customer.id, technicianId: techId, scheduledServiceId: child });
          },
          'property type': async (customer) => {
            const [property] = await db('customer_properties').insert({ customer_id: customer.id, property_type: 'commercial' }).returning('id');
            return makeVisit({ customerId: customer.id, technicianId: techId, scheduledServiceId: await makeDoneRecurring(customer.id, { property_id: property.id }) });
          },
        };
        for (const [label, build] of Object.entries(cases)) {
          const customer = await makeCustomer();
          await makeNextVisit(customer.id);
          const recordId = await build(customer);
          const result = await Builders.buildEmailDivisionPayload({ run: runFor('lc.first_visit_pest', recordId, customer), mode: 'live', deps: baseDeps() });
          expect({ label, code: result.code }).toEqual({ label, code: 'not_residential_plan' });
        }
      });

      test('pests_named_list: structured treatment targets are preferred; notes are read negation-aware ("no ghost ants found; treated spiders" names spiders only)', async () => {
        const customer = await makeCustomer();
        const techId = await makeTech();
        const series = await makeDoneRecurring(customer.id);
        await makeNextVisit(customer.id);
        const fromNotes = await makeVisit({ customerId: customer.id, technicianId: techId, scheduledServiceId: series, notes: 'No ghost ants found; treated spiders along the eaves.' });
        const r1 = await Builders.buildEmailDivisionPayload({ run: runFor('lc.first_visit_pest', fromNotes, customer), mode: 'live', deps: baseDeps() });
        expect(r1.payload.pests_named_list).toBe('spiders');

        const other = await makeCustomer();
        const series2 = await makeDoneRecurring(other.id);
        await makeNextVisit(other.id);
        const structured = await makeVisit({
          customerId: other.id, technicianId: techId, scheduledServiceId: series2, targets: ['Fire ants'], notes: 'Customer mentioned termites; treated perimeter.',
        });
        const r2 = await Builders.buildEmailDivisionPayload({ run: runFor('lc.first_visit_pest', structured, other), mode: 'live', deps: baseDeps() });
        expect(r2.payload.pests_named_list).toBe('fire ants'); // the structured target wins; the notes never add termites
      });

      test('the FULL commercial rule: a commercial/business ACCOUNT (customers.property_type, the commercial tier sentinel) or a business property is skipped — for a linked or an UNLINKED record', async () => {
        const techId = await makeTech();
        const cases = {
          'account property_type commercial (unlinked record)': async () => {
            const customer = await makeCustomer({ property_type: 'commercial' });
            await makeNextVisit(customer.id);
            return { customer, recordId: await makeVisit({ customerId: customer.id, technicianId: techId }) };
          },
          'account property_type business': async () => {
            const customer = await makeCustomer({ property_type: 'business' });
            return { customer, recordId: await makeVisit({ customerId: customer.id, technicianId: techId, scheduledServiceId: await makeDoneRecurring(customer.id) }) };
          },
          'commercial tier sentinel': async () => {
            const customer = await makeCustomer({ waveguard_tier: 'Commercial' });
            return { customer, recordId: await makeVisit({ customerId: customer.id, technicianId: techId, scheduledServiceId: await makeDoneRecurring(customer.id) }) };
          },
          'linked property of type business': async () => {
            const customer = await makeCustomer();
            const [property] = await db('customer_properties').insert({ customer_id: customer.id, property_type: 'business' }).returning('id');
            return { customer, recordId: await makeVisit({ customerId: customer.id, technicianId: techId, scheduledServiceId: await makeDoneRecurring(customer.id, { property_id: property.id }) }) };
          },
        };
        for (const [label, build] of Object.entries(cases)) {
          const { customer, recordId } = await build();
          const result = await Builders.buildEmailDivisionPayload({ run: runFor('lc.first_visit_pest', recordId, customer), mode: 'live', deps: baseDeps() });
          expect({ label, code: result.code }).toEqual({ label, code: 'not_residential_plan' });
        }
      });

      test('"same property" is the canonical full-address key: Apt 1 and Apt 2 at one street and ZIP are different properties', async () => {
        const customer = await makeCustomer();
        const techId = await makeTech();
        const address = (unit) => ({ service_address_line1: '100 Beach Rd', service_address_line2: unit, service_address_city: 'Parrish', service_address_zip: '34219' });
        const done = await makeDoneRecurring(customer.id, address('Apt 1'));
        await makeNextVisit(customer.id, 'quarterly', '2098-01-05', address('Apt 2')); // sooner, but another unit
        await makeNextVisit(customer.id, 'quarterly', '2099-12-24', address('Apt 1'));
        const recordId = await makeVisit({ customerId: customer.id, technicianId: techId, scheduledServiceId: done });
        const result = await Builders.buildEmailDivisionPayload({ run: runFor('lc.first_visit_pest', recordId, customer), mode: 'live', deps: baseDeps() });
        expect(result.payload.next_visit_date).toBe('December 24, 2099');
        // The same unit written two ways is ONE property (the canonical key folds the designator).
        const other = await makeCustomer();
        const doneOther = await makeDoneRecurring(other.id, address('Apt 4'));
        await makeNextVisit(other.id, 'quarterly', '2099-12-24', address('Unit 4'));
        const recordOther = await makeVisit({ customerId: other.id, technicianId: techId, scheduledServiceId: doneOther });
        const same = await Builders.buildEmailDivisionPayload({ run: runFor('lc.first_visit_pest', recordOther, other), mode: 'live', deps: baseDeps() });
        expect(same.payload.next_visit_date).toBe('December 24, 2099');
      });

      test('a city (or ZIP) alone is not a property: appointments carrying only the same city never match — ambiguity skips, never a wrong date', async () => {
        const techId = await makeTech();
        const cityOnly = { service_address_line1: null, service_address_zip: null, service_address_city: 'Parrish' };
        // Linked visit with only a city; two upcoming pest appointments, also city-only (could be two properties).
        const customer = await makeCustomer();
        const root = await makeDoneRecurring(customer.id, cityOnly);
        await makeNextVisit(customer.id, 'quarterly', '2098-01-05', cityOnly);
        await makeNextVisit(customer.id, 'quarterly', '2099-12-24', cityOnly);
        const recordId = await makeVisit({ customerId: customer.id, technicianId: techId, scheduledServiceId: root });
        const ambiguous = await Builders.buildEmailDivisionPayload({ run: runFor('lc.first_visit_pest', recordId, customer), mode: 'live', deps: baseDeps() });
        expect(ambiguous).toEqual(expect.objectContaining({ skip: true, code: 'next_visit_property_ambiguous' }));
        // One city-only upcoming appointment is unambiguous (nothing to confuse it with).
        const single = await makeCustomer();
        const singleRoot = await makeDoneRecurring(single.id, cityOnly);
        await makeNextVisit(single.id, 'quarterly', '2099-12-24', cityOnly);
        const singleRecord = await makeVisit({ customerId: single.id, technicianId: techId, scheduledServiceId: singleRoot });
        const ok = await Builders.buildEmailDivisionPayload({ run: runFor('lc.first_visit_pest', singleRecord, single), mode: 'live', deps: baseDeps() });
        expect(ok.payload.next_visit_date).toBe('December 24, 2099');
        // An UNLINKED record cannot join two city-only active series: they may be two properties.
        const unlinked = await makeCustomer();
        await makeNextVisit(unlinked.id, 'quarterly', '2099-01-05', cityOnly);
        await makeNextVisit(unlinked.id, 'quarterly', '2099-12-24', cityOnly);
        const unlinkedRecord = await makeVisit({ customerId: unlinked.id, technicianId: techId });
        const refused = await Builders.buildEmailDivisionPayload({ run: runFor('lc.first_visit_pest', unlinkedRecord, unlinked), mode: 'live', deps: baseDeps() });
        expect(refused).toEqual(expect.objectContaining({ skip: true, code: 'not_recurring_plan' }));
      });

      test('the free-re-service promise is an ALLOW-LIST: a pest + termite bundle, a pest + lawn bundle, an unrecognised label and a commercial plan are all skipped; a plain residential quarterly pest plan sends', async () => {
        const techId = await makeTech();
        const build = async (label) => {
          const customer = await makeCustomer();
          await makeNextVisit(customer.id);
          const root = await makeDoneRecurring(customer.id, { service_type: label });
          return { customer, recordId: await makeVisit({ customerId: customer.id, technicianId: techId, serviceType: label, scheduledServiceId: root }) };
        };
        for (const label of ['Quarterly Pest + Termite Bait Station', 'Quarterly Pest Control & Lawn Care', 'Mystery Plan', 'Commercial Quarterly Pest Control']) {
          const { customer, recordId } = await build(label);
          const result = await Builders.buildEmailDivisionPayload({ run: runFor('lc.first_visit_pest', recordId, customer), mode: 'live', deps: baseDeps() });
          expect({ label, skipped: result.skip === true }).toEqual({ label, skipped: true });
          expect(['not_single_pest_lane', 'not_residential_plan']).toContain(result.code);
        }
        const plain = await build('Quarterly Pest Control Service');
        const ok = await Builders.buildEmailDivisionPayload({ run: runFor('lc.first_visit_pest', plain.recordId, plain.customer), mode: 'live', deps: baseDeps() });
        expect(ok.ok).toBe(true);
      });

      test('an UNLINKED record is judged on the active pest series the fallback accepts: a residential account whose one generic pest series sits at a business property is skipped; the same at a residential property sends', async () => {
        const techId = await makeTech();
        const build = async (propertyType) => {
          const customer = await makeCustomer();
          const [property] = await db('customer_properties').insert({ customer_id: customer.id, city: 'Parrish', property_type: propertyType }).returning('id');
          await makeNextVisit(customer.id, 'quarterly', '2099-12-24', { property_id: property.id });
          const recordId = await makeVisit({ customerId: customer.id, technicianId: techId, products: ['taurus'] });
          return Builders.buildEmailDivisionPayload({ run: runFor('lc.first_visit_pest', recordId, customer), mode: 'live', deps: baseDeps() });
        };
        for (const type of ['business', 'commercial']) {
          expect(await build(type)).toEqual(expect.objectContaining({ skip: true, code: 'not_residential_plan' }));
        }
        expect((await build('residential')).ok).toBe(true);
      });

      test('an UNLINKED record: the inferred series\' own commercial label or bundle label is skipped too', async () => {
        const techId = await makeTech();
        const build = async (label) => {
          const customer = await makeCustomer();
          await makeNextVisit(customer.id, 'quarterly', '2099-12-24', { service_type: label });
          const recordId = await makeVisit({ customerId: customer.id, technicianId: techId, products: ['taurus'] });
          return Builders.buildEmailDivisionPayload({ run: runFor('lc.first_visit_pest', recordId, customer), mode: 'live', deps: baseDeps() });
        };
        expect(await build('Commercial Quarterly Pest Control')).toEqual(expect.objectContaining({ skip: true, code: 'not_residential_plan' }));
        expect(await build('Quarterly Pest + Termite Bait Station')).toEqual(expect.objectContaining({ skip: true, code: 'not_single_pest_lane' }));
      });

      test.each([
        ['a commercial service', 'Commercial Quarterly Pest Control', 'not_residential_plan'],
        ['a pest + termite bundle', 'Quarterly Pest + Termite Bait Station', 'not_single_pest_lane'],
      ])('a residential series root OVERRIDDEN to %s (recurring_template_overrides) is skipped by B1 and B5: the plan is read as the series now is', async (_label, overriddenTo, code) => {
        const overrides = JSON.stringify({ service_type: overriddenTo });
        const cohort = { byVisit: { pest: { 1: 3.14, 2: 1.16 } }, counts: {} };
        const techId = await makeTech();
        // B1: a linked first visit whose root carries the override.
        const c1 = await makeCustomer();
        await makeNextVisit(c1.id);
        const root1 = await makeDoneRecurring(c1.id, { recurring_template_overrides: overrides });
        const r1 = await makeVisit({ customerId: c1.id, technicianId: techId, products: ['taurus'], scheduledServiceId: root1 });
        expect(await Builders.buildEmailDivisionPayload({ run: runFor('lc.first_visit_pest', r1, c1), mode: 'live', deps: baseDeps() }))
          .toEqual(expect.objectContaining({ skip: true, code }));
        // B5: the second visit of the overridden quarterly series.
        const c2 = await makeCustomer();
        const root2 = await makeNextVisit(c2.id, 'quarterly', '2099-12-24', { recurring_template_overrides: overrides });
        await makeVisit({ customerId: c2.id, technicianId: techId, visitNumber: 1, date: '2026-06-20', products: ['taurus'], scheduledServiceId: root2, createdAt: new Date('2026-06-20T15:00:00Z') });
        const r2 = await makeVisit({ customerId: c2.id, technicianId: techId, visitNumber: 2, products: ['taurus', 'talak'], scheduledServiceId: root2 });
        expect(await Builders.buildEmailDivisionPayload({ run: runFor('lc.why_91_days', r2, c2), deps: baseDeps({ getActivityRatingAverages: async () => cohort }) }))
          .toEqual(expect.objectContaining({ skip: true, code }));
      });

      test('the CATALOG KEY is the identity: a generic label with a termite snapshot, and any label/snapshot conflict, are skipped (fail closed); a matching pest key and label sends; no snapshot falls back to the label', async () => {
        const techId = await makeTech();
        const build = async ({ label, key }) => {
          const customer = await makeCustomer();
          await makeNextVisit(customer.id);
          const root = await makeDoneRecurring(customer.id, { service_type: label, service_key_snapshot: key });
          const recordId = await makeVisit({ customerId: customer.id, technicianId: techId, serviceType: label, scheduledServiceId: root });
          return Builders.buildEmailDivisionPayload({ run: runFor('lc.first_visit_pest', recordId, customer), mode: 'live', deps: baseDeps() });
        };
        const skipped = { skip: true, code: 'not_single_pest_lane' };
        // A generic "Pest Control" label whose catalog key is the termite bait plan.
        expect(await build({ label: 'Pest Control', key: 'termite_bait_quarterly' })).toEqual(expect.objectContaining(skipped));
        expect(await build({ label: 'Pest Control', key: 'pest_termite_bait_quarterly' })).toEqual(expect.objectContaining(skipped));
        // A pest label against a non-pest key, and a pest key against a non-pest label: conflicts.
        expect(await build({ label: 'Quarterly Pest Control Service', key: 'lawn_care_quarterly' })).toEqual(expect.objectContaining(skipped));
        expect(await build({ label: 'Lawn Care Service', key: 'pest_general_quarterly' })).toEqual(expect.objectContaining(skipped));
        // The membership umbrella key is not a single pest service.
        expect(await build({ label: 'Quarterly Pest Control Service', key: 'waveguard_membership' })).toEqual(expect.objectContaining(skipped));
        // Agreement sends; no snapshot is the label alone (as before).
        expect((await build({ label: 'Pest Control', key: 'pest_general_quarterly' })).ok).toBe(true);
        expect((await build({ label: 'Quarterly Pest Control Service', key: null })).ok).toBe(true);
      });

      test('a cancelled (or lapsed) series is not an ACTIVE plan: a cancelled recurring root plus a separately booked future pest visit is no B1', async () => {
        const customer = await makeCustomer();
        const techId = await makeTech();
        const cancelledRoot = await makeDoneRecurring(customer.id, { status: 'cancelled', recurring_ongoing: false });
        await makeNextVisit(customer.id, 'one_time', '2099-12-24'); // separately booked one-off
        const recordId = await makeVisit({ customerId: customer.id, technicianId: techId, scheduledServiceId: cancelledRoot });
        const cancelled = await Builders.buildEmailDivisionPayload({ run: runFor('lc.first_visit_pest', recordId, customer), mode: 'live', deps: baseDeps() });
        expect(cancelled).toEqual(expect.objectContaining({ skip: true, code: 'not_recurring_plan' }));
        // A lapsed series (not ongoing, no live future member) is not active either.
        const lapsed = await makeCustomer();
        const lapsedRoot = await makeDoneRecurring(lapsed.id, { recurring_ongoing: false });
        const lapsedRecord = await makeVisit({ customerId: lapsed.id, technicianId: techId, scheduledServiceId: lapsedRoot });
        const r2 = await Builders.buildEmailDivisionPayload({ run: runFor('lc.first_visit_pest', lapsedRecord, lapsed), mode: 'live', deps: baseDeps() });
        expect(r2).toEqual(expect.objectContaining({ skip: true, code: 'not_recurring_plan' }));
      });

      test('first-visit ties: two performed records created at the SAME instant — exactly one qualifies (created_at, then id)', async () => {
        const customer = await makeCustomer();
        const techId = await makeTech();
        const series = await makeDoneRecurring(customer.id);
        await makeNextVisit(customer.id);
        const at = new Date('2026-09-20T15:00:00Z');
        const a = await makeVisit({ customerId: customer.id, technicianId: techId, scheduledServiceId: series, createdAt: at });
        const b = await makeVisit({ customerId: customer.id, technicianId: techId, scheduledServiceId: series, createdAt: at });
        const results = await Promise.all([a, b].map((id) => Builders.buildEmailDivisionPayload({ run: runFor('lc.first_visit_pest', id, customer), mode: 'live', deps: baseDeps() })));
        expect(results.filter((r) => r.ok)).toHaveLength(1);
        expect(results.filter((r) => r.skip).map((r) => r.code)).toEqual(['not_first_visit']);
      });

      test('the rain sentence: coordinates come from the VISITED property, a complete radar read over whole days after the visit; shadow makes no external call', async () => {
        const customer = await makeCustomer({ latitude: 10, longitude: 10 }); // the customer record's coordinates belong to ANOTHER property
        const techId = await makeTech();
        const [property] = await db('customer_properties').insert({ customer_id: customer.id, latitude: 27.5, longitude: -82.4 }).returning('id');
        const [done] = await db('scheduled_services').insert({
          customer_id: customer.id, scheduled_date: '2026-09-20', service_type: 'Pest Control Service', status: 'completed', property_id: property.id, recurring_pattern: 'quarterly', is_recurring: true, recurring_ongoing: true,
        }).returning('id');
        await makeNextVisit(customer.id, 'quarterly', '2099-12-24', { property_id: property.id });
        const recordId = await makeVisit({ customerId: customer.id, technicianId: techId, scheduledServiceId: done.id });
        const rain = jest.fn(async ({ start, end }) => ({ days: [{ date: start, inches: 0.4 }, { date: end, inches: 0.5 }], complete: true }));
        const live = await Builders.buildEmailDivisionPayload({
          run: runFor('lc.first_visit_pest', recordId, customer), mode: 'live', deps: baseDeps({ fetchMrmsDailyRain: rain }),
        });
        expect(live.payload.rain_since_visit_sentence).toBe('NOAA radar shows about 0.9 inches of rain near your address since the visit; local totals may vary.');
        expect(rain).toHaveBeenCalledWith(expect.objectContaining({ latitude: 27.5, longitude: -82.4 }));
        const incomplete = await Builders.buildEmailDivisionPayload({
          run: runFor('lc.first_visit_pest', recordId, customer), mode: 'live',
          deps: baseDeps({ fetchMrmsDailyRain: async () => ({ days: [{ date: 'x', inches: 2 }], complete: false }) }),
        });
        expect(incomplete.payload.rain_since_visit_sentence).toBe('');
        rain.mockClear();
        const shadow = await Builders.buildEmailDivisionPayload({
          run: runFor('lc.first_visit_pest', recordId, customer), mode: 'shadow', deps: baseDeps({ fetchMrmsDailyRain: rain }),
        });
        expect(shadow.payload.rain_since_visit_sentence).toBe('');
        expect(rain).not.toHaveBeenCalled();

        // The property has no coordinates (null is not zero) or the visit has no property: no sentence, no call —
        // the customer record's coordinates are never a fallback.
        await db('customer_properties').where({ id: property.id }).update({ latitude: null, longitude: null });
        const noCoords = await Builders.buildEmailDivisionPayload({
          run: runFor('lc.first_visit_pest', recordId, customer), mode: 'live', deps: baseDeps({ fetchMrmsDailyRain: rain }),
        });
        expect(noCoords.payload.rain_since_visit_sentence).toBe('');
        const unlinked = await makeVisit({ customerId: customer.id, technicianId: techId, createdAt: new Date('2026-09-21T15:00:00Z'), date: '2026-09-21' });
        const noProperty = await Builders.buildEmailDivisionPayload({
          run: runFor('lc.first_visit_pest', unlinked, customer), mode: 'live', deps: baseDeps({ fetchMrmsDailyRain: rain }),
        });
        expect(noProperty.skip || noProperty.payload.rain_since_visit_sentence === '').toBeTruthy();
        expect(rain).not.toHaveBeenCalled();
      });
    });

    describe('lc.why_91_days', () => {
      const cohort = { byVisit: { pest: { 1: 3.14, 2: 1.16 } }, counts: {} };
      async function scenario({ products = ['taurus', 'talak'], pattern = 'quarterly', visitNumber = 2 } = {}) {
        const customer = await makeCustomer();
        const techId = await makeTech();
        const scheduledId = await makeNextVisit(customer.id, pattern);
        await makeVisit({ customerId: customer.id, technicianId: techId, visitNumber: 1, date: '2026-06-20', products: ['taurus'], scheduledServiceId: scheduledId, createdAt: new Date('2026-06-20T15:00:00Z') });
        const recordId = await makeVisit({
          customerId: customer.id, technicianId: techId, visitNumber, products, scheduledServiceId: scheduledId, date: '2026-09-20',
        });
        return { customer, recordId };
      }

      test('Taurus SC plan + a >=20 cohort on the pest line -> the figures come from the reader, interval is the quarterly 91', async () => {
        const { customer, recordId } = await scenario();
        const result = await Builders.buildEmailDivisionPayload({
          run: runFor('lc.why_91_days', recordId, customer), deps: baseDeps({
            getActivityRatingAverages: async () => cohort, getAreaIntelSentence: async () => 'In September our technicians treated ghost ants at 61% of our 90 visits in Parrish.',
          }),
        });
        expect(result.ok).toBe(true);
        expect(result.payload).toEqual(expect.objectContaining({
          plan_interval_days: '91', plan_name: 'Quarterly Pest Control Service', nonrepellent_product: 'Taurus SC', contact_product: 'Talak 7.9% F',
          activity_avg_first_visit: '3.1', activity_avg_second_visit: '1.2',
          area_intel_sentence: 'In September our technicians treated ghost ants at 61% of our 90 visits in Parrish.',
        }));
      });

      test('a non-Taurus non-repellent (Alpine) -> SKIP; no non-repellent at all -> SKIP', async () => {
        const alpine = await scenario({ products: ['alpine', 'talak'] });
        const r1 = await Builders.buildEmailDivisionPayload({
          run: runFor('lc.why_91_days', alpine.recordId, alpine.customer), deps: baseDeps({ getActivityRatingAverages: async () => cohort }),
        });
        expect(r1).toEqual(expect.objectContaining({ skip: true, code: 'nonrepellent_not_taurus' }));
        // Visit 1 of this scenario carries Taurus SC, so a plan mixing both is also refused.
        const none = await makeCustomer();
        const techId = await makeTech();
        const scheduledId = await makeNextVisit(none.id);
        await makeVisit({ customerId: none.id, technicianId: techId, visitNumber: 1, date: '2026-06-20', products: ['talak'], scheduledServiceId: scheduledId, createdAt: new Date('2026-06-20T15:00:00Z') });
        const recordId = await makeVisit({ customerId: none.id, technicianId: techId, visitNumber: 2, products: ['talak'], scheduledServiceId: scheduledId });
        const r2 = await Builders.buildEmailDivisionPayload({
          run: runFor('lc.why_91_days', recordId, none), deps: baseDeps({ getActivityRatingAverages: async () => cohort }),
        });
        expect(r2).toEqual(expect.objectContaining({ skip: true, code: 'nonrepellent_not_taurus' }));
      });

      test('a cohort under 20 (the reader omits it) -> SKIP, never a blank or stale figure', async () => {
        const { customer, recordId } = await scenario();
        const onlyFirst = await Builders.buildEmailDivisionPayload({
          run: runFor('lc.why_91_days', recordId, customer), deps: baseDeps({ getActivityRatingAverages: async () => ({ byVisit: { pest: { 1: 3.1 } }, counts: {} }) }),
        });
        expect(onlyFirst).toEqual(expect.objectContaining({ skip: true, code: 'cohort_below_20' }));
        const other = await Builders.buildEmailDivisionPayload({
          run: runFor('lc.why_91_days', recordId, customer), deps: baseDeps({ getActivityRatingAverages: async () => ({ byVisit: { lawn: { 1: 3, 2: 1 } }, counts: {} }) }),
        });
        expect(other).toEqual(expect.objectContaining({ skip: true, code: 'cohort_below_20' }));
      });

      test('the plan is read off the PEST series only: a visit linked to a lawn appointment says nothing about the pest plan', async () => {
        const customer = await makeCustomer();
        const techId = await makeTech();
        const [lawn] = await db('scheduled_services').insert({
          customer_id: customer.id, scheduled_date: '2099-12-24', service_type: 'Lawn Care Service', status: 'confirmed', recurring_pattern: 'quarterly',
        }).returning('id');
        await makeVisit({ customerId: customer.id, technicianId: techId, visitNumber: 1, date: '2026-06-20', products: ['taurus'], createdAt: new Date('2026-06-20T15:00:00Z') });
        const recordId = await makeVisit({ customerId: customer.id, technicianId: techId, visitNumber: 2, products: ['taurus', 'talak'], scheduledServiceId: lawn.id });
        const result = await Builders.buildEmailDivisionPayload({
          run: runFor('lc.why_91_days', recordId, customer), deps: baseDeps({ getActivityRatingAverages: async () => cohort }),
        });
        expect(result).toEqual(expect.objectContaining({ skip: true, code: 'not_single_pest_lane' }));
      });

      test('area intel uses the VISIT\'s frozen service city, never customers.city: a multi-property customer; a visit with no frozen city drops the sentence', async () => {
        const customer = await makeCustomer({ city: 'Bradenton' }); // the customer record's city is another property
        const techId = await makeTech();
        const scheduledId = await makeNextVisit(customer.id, 'quarterly', '2099-12-24', { service_address_city: 'Parrish' });
        await makeVisit({ customerId: customer.id, technicianId: techId, visitNumber: 1, date: '2026-06-20', products: ['taurus'], scheduledServiceId: scheduledId, createdAt: new Date('2026-06-20T15:00:00Z') });
        const recordId = await makeVisit({ customerId: customer.id, technicianId: techId, visitNumber: 2, products: ['taurus', 'talak'], scheduledServiceId: scheduledId });
        const intel = jest.fn(async ({ city }) => `In September our technicians treated ghost ants at 61% of our 90 visits in ${city}.`);
        const result = await Builders.buildEmailDivisionPayload({
          run: runFor('lc.why_91_days', recordId, customer), deps: baseDeps({ getActivityRatingAverages: async () => cohort, getAreaIntelSentence: intel }),
        });
        expect(intel).toHaveBeenCalledWith(expect.objectContaining({ city: 'Parrish' }));
        expect(result.payload.area_intel_sentence).toContain('in Parrish');

        const legacy = await makeCustomer({ city: 'Bradenton' });
        const legacyScheduled = await makeNextVisit(legacy.id, 'quarterly', '2099-12-24', { service_address_city: null });
        await makeVisit({ customerId: legacy.id, technicianId: techId, visitNumber: 1, date: '2026-06-20', products: ['taurus'], scheduledServiceId: legacyScheduled, createdAt: new Date('2026-06-20T15:00:00Z') });
        const legacyRecord = await makeVisit({ customerId: legacy.id, technicianId: techId, visitNumber: 2, products: ['taurus', 'talak'], scheduledServiceId: legacyScheduled });
        intel.mockClear();
        const dropped = await Builders.buildEmailDivisionPayload({
          run: runFor('lc.why_91_days', legacyRecord, legacy), deps: baseDeps({ getActivityRatingAverages: async () => cohort, getAreaIntelSentence: intel }),
        });
        expect(dropped.ok).toBe(true);
        expect(intel).not.toHaveBeenCalled();
        expect(dropped.payload.area_intel_sentence).toBe('');
      });

      test('the quarterly gate normalizes the cadence with the scheduler\'s own alias table, for the visit and for its parent', async () => {
        const gate = async (pattern, { parentPattern = null } = {}) => {
          const customer = await makeCustomer();
          const techId = await makeTech();
          let extra = {};
          if (parentPattern !== null) {
            const parentId = await makeNextVisit(customer.id, parentPattern);
            extra = { recurring_parent_id: parentId };
          }
          const scheduledId = await makeNextVisit(customer.id, pattern, '2099-12-24', extra);
          await makeVisit({ customerId: customer.id, technicianId: techId, visitNumber: 1, date: '2026-06-20', products: ['taurus'], scheduledServiceId: scheduledId, createdAt: new Date('2026-06-20T15:00:00Z') });
          const recordId = await makeVisit({ customerId: customer.id, technicianId: techId, visitNumber: 2, products: ['taurus', 'talak'], scheduledServiceId: scheduledId });
          return Builders.buildEmailDivisionPayload({
            run: runFor('lc.why_91_days', recordId, customer), deps: baseDeps({ getActivityRatingAverages: async () => cohort }),
          });
        };
        for (const alias of ['every_3_months', 'every three months', '4x', ' Quarterly ', '4x per year']) {
          const result = await gate(alias);
          expect({ alias, ok: result.ok }).toEqual({ alias, ok: true });
        }
        // The parent's alias counts when the visit carries none.
        expect((await gate('', { parentPattern: 'every three months' })).ok).toBe(true);
        // Not quarterly under any spelling.
        for (const alias of ['monthly', 'every 6 months', '6x', 'nonsense']) {
          expect((await gate(alias)).code).toBe('plan_not_quarterly');
        }
      });

      test('plan products are read from THIS appointment\'s recurring pest series and property only: Taurus at property A never qualifies a Talak-only quarterly plan at property B', async () => {
        const customer = await makeCustomer();
        const techId = await makeTech();
        const [propA] = await db('customer_properties').insert({ customer_id: customer.id, city: 'Parrish' }).returning('id');
        const [propB] = await db('customer_properties').insert({ customer_id: customer.id, city: 'Venice' }).returning('id');
        const seriesA = await makeNextVisit(customer.id, 'quarterly', '2099-12-24', { property_id: propA.id });
        const seriesB = await makeNextVisit(customer.id, 'quarterly', '2099-12-24', { property_id: propB.id });
        // Property A: Taurus + contact, visits 1 and 2.
        await makeVisit({ customerId: customer.id, technicianId: techId, visitNumber: 1, date: '2026-05-20', products: ['taurus'], scheduledServiceId: seriesA, createdAt: new Date('2026-05-20T15:00:00Z') });
        const visitA = await makeVisit({ customerId: customer.id, technicianId: techId, visitNumber: 2, date: '2026-08-20', products: ['taurus', 'talak'], scheduledServiceId: seriesA, createdAt: new Date('2026-08-20T15:00:00Z') });
        // Property B: a Talak-only quarterly plan (its own first and second visits).
        await makeVisit({ customerId: customer.id, technicianId: techId, visitNumber: 3, date: '2026-06-20', products: ['talak'], scheduledServiceId: seriesB, createdAt: new Date('2026-06-20T15:00:00Z') });
        const visitB = await makeVisit({ customerId: customer.id, technicianId: techId, visitNumber: 4, date: '2026-09-20', products: ['talak'], scheduledServiceId: seriesB });
        const deps = baseDeps({ getActivityRatingAverages: async () => cohort });

        const b = await Builders.buildEmailDivisionPayload({ run: runFor('lc.why_91_days', visitB, customer), deps });
        expect(b).toEqual(expect.objectContaining({ skip: true, code: 'nonrepellent_not_taurus' }));
        // Property A, on its own evidence, still qualifies.
        const a = await Builders.buildEmailDivisionPayload({ run: runFor('lc.why_91_days', visitA, customer), deps });
        expect(a.ok).toBe(true);
        expect(a.payload.nonrepellent_product).toBe('Taurus SC');
      });

      test('the ordinal is the visit\'s place among the PERFORMED, NON-CALLBACK visits of its own plan: property B\'s first visit is not "visit 2" (visit_number counts across properties), and a callback does not count', async () => {
        const customer = await makeCustomer();
        const techId = await makeTech();
        const [propA] = await db('customer_properties').insert({ customer_id: customer.id, city: 'Parrish' }).returning('id');
        const [propB] = await db('customer_properties').insert({ customer_id: customer.id, city: 'Venice' }).returning('id');
        const seriesA = await makeNextVisit(customer.id, 'quarterly', '2099-12-24', { property_id: propA.id });
        const seriesB = await makeNextVisit(customer.id, 'quarterly', '2099-12-24', { property_id: propB.id });
        await makeVisit({ customerId: customer.id, technicianId: techId, visitNumber: 1, date: '2026-03-20', products: ['taurus'], scheduledServiceId: seriesA, createdAt: new Date('2026-03-20T15:00:00Z') });
        // Property B's FIRST visit: the customer-level visit_number says 2.
        const firstAtB = await makeVisit({ customerId: customer.id, technicianId: techId, visitNumber: 2, date: '2026-06-20', products: ['taurus', 'talak'], scheduledServiceId: seriesB, createdAt: new Date('2026-06-20T15:00:00Z') });
        const deps = baseDeps({ getActivityRatingAverages: async () => cohort });
        const r1 = await Builders.buildEmailDivisionPayload({ run: runFor('lc.why_91_days', firstAtB, customer), deps });
        expect(r1).toEqual(expect.objectContaining({ skip: true, code: 'not_second_visit' }));

        // B's real second visit, with a callback in between (a re-service, not a plan visit).
        await db('service_records').insert({
          id: randomUUID(), customer_id: customer.id, service_date: '2026-07-20', service_type: 'Pest Callback', service_line: 'pest', status: 'completed',
          scheduled_service_id: seriesB, is_callback: true, created_at: new Date('2026-07-20T15:00:00Z'),
        }).then(() => {});
        const secondAtB = await makeVisit({ customerId: customer.id, technicianId: techId, visitNumber: 9, date: '2026-09-20', products: ['taurus', 'talak'], scheduledServiceId: seriesB });
        const r2 = await Builders.buildEmailDivisionPayload({ run: runFor('lc.why_91_days', secondAtB, customer), deps });
        expect(r2.ok).toBe(true);
      });

      test('B5: a commercial ACCOUNT and a cancelled series are skipped too', async () => {
        const techId = await makeTech();
        const commercial = await makeCustomer({ property_type: 'commercial' });
        const scheduledId = await makeNextVisit(commercial.id);
        await makeVisit({ customerId: commercial.id, technicianId: techId, visitNumber: 1, date: '2026-06-20', products: ['taurus'], scheduledServiceId: scheduledId, createdAt: new Date('2026-06-20T15:00:00Z') });
        const commercialRecord = await makeVisit({ customerId: commercial.id, technicianId: techId, visitNumber: 2, products: ['taurus', 'talak'], scheduledServiceId: scheduledId });
        const deps = baseDeps({ getActivityRatingAverages: async () => cohort });
        expect(await Builders.buildEmailDivisionPayload({ run: runFor('lc.why_91_days', commercialRecord, commercial), deps }))
          .toEqual(expect.objectContaining({ skip: true, code: 'not_residential_plan' }));

        const customer = await makeCustomer();
        const cancelled = await makeNextVisit(customer.id, 'quarterly', '2099-12-24', { status: 'cancelled', recurring_ongoing: false });
        await makeVisit({ customerId: customer.id, technicianId: techId, visitNumber: 1, date: '2026-06-20', products: ['taurus'], scheduledServiceId: cancelled, createdAt: new Date('2026-06-20T15:00:00Z') });
        const record = await makeVisit({ customerId: customer.id, technicianId: techId, visitNumber: 2, products: ['taurus', 'talak'], scheduledServiceId: cancelled });
        expect(await Builders.buildEmailDivisionPayload({ run: runFor('lc.why_91_days', record, customer), deps }))
          .toEqual(expect.objectContaining({ skip: true, code: 'not_recurring_plan' }));
      });

      test('B5: the same allow-list - bundles and unrecognised labels are skipped, the plain residential quarterly pest plan sends', async () => {
        const techId = await makeTech();
        const deps = baseDeps({ getActivityRatingAverages: async () => cohort });
        const build = async (label) => {
          const customer = await makeCustomer();
          const scheduledId = await makeNextVisit(customer.id, 'quarterly', '2099-12-24', { service_type: label });
          await makeVisit({ customerId: customer.id, technicianId: techId, visitNumber: 1, date: '2026-06-20', products: ['taurus'], serviceType: label, scheduledServiceId: scheduledId, createdAt: new Date('2026-06-20T15:00:00Z') });
          return { customer, recordId: await makeVisit({ customerId: customer.id, technicianId: techId, visitNumber: 2, products: ['taurus', 'talak'], serviceType: label, scheduledServiceId: scheduledId }) };
        };
        for (const label of ['Quarterly Pest + Termite Bait Station', 'Quarterly Pest Control & Lawn Care', 'Mystery Plan']) {
          const { customer, recordId } = await build(label);
          const result = await Builders.buildEmailDivisionPayload({ run: runFor('lc.why_91_days', recordId, customer), deps });
          expect({ label, code: result.code }).toEqual({ label, code: 'not_single_pest_lane' });
        }
        const plain = await build('Quarterly Pest Control Service');
        expect((await Builders.buildEmailDivisionPayload({ run: runFor('lc.why_91_days', plain.recordId, plain.customer), deps })).ok).toBe(true);
      });

      test('a COMMERCIAL quarterly plan is skipped for B5 too', async () => {
        const customer = await makeCustomer();
        const techId = await makeTech();
        const scheduledId = await makeNextVisit(customer.id, 'quarterly', '2099-12-24', { service_type: 'Commercial Quarterly Pest Control' });
        await makeVisit({ customerId: customer.id, technicianId: techId, visitNumber: 1, date: '2026-06-20', products: ['taurus'], scheduledServiceId: scheduledId, createdAt: new Date('2026-06-20T15:00:00Z') });
        const recordId = await makeVisit({ customerId: customer.id, technicianId: techId, visitNumber: 2, products: ['taurus', 'talak'], scheduledServiceId: scheduledId });
        const result = await Builders.buildEmailDivisionPayload({
          run: runFor('lc.why_91_days', recordId, customer), deps: baseDeps({ getActivityRatingAverages: async () => cohort }),
        });
        expect(result).toEqual(expect.objectContaining({ skip: true, code: 'not_residential_plan' }));
      });

      test('a visit whose recurring pest series cannot be established is skipped (no series, no plan evidence)', async () => {
        const customer = await makeCustomer();
        const techId = await makeTech();
        const lawn = await makeNextVisit(customer.id, 'quarterly', '2099-12-24', { service_type: 'Lawn Care Service' });
        const recordId = await makeVisit({ customerId: customer.id, technicianId: techId, visitNumber: 2, products: ['taurus', 'talak'], scheduledServiceId: lawn });
        const result = await Builders.buildEmailDivisionPayload({
          run: runFor('lc.why_91_days', recordId, customer), deps: baseDeps({ getActivityRatingAverages: async () => cohort }),
        });
        expect(result).toEqual(expect.objectContaining({ skip: true, code: 'not_single_pest_lane' }));
      });

      test('SKIPs when the service record belongs to a different customer than the run\'s recipient', async () => {
        const { recordId } = await scenario();
        const other = await makeCustomer();
        const result = await Builders.buildEmailDivisionPayload({
          run: runFor('lc.why_91_days', recordId, other), deps: baseDeps({ getActivityRatingAverages: async () => cohort }),
        });
        expect(result).toEqual(expect.objectContaining({ skip: true, code: 'recipient_not_visit_customer' }));
      });

      test('SKIPs a non-quarterly plan and any visit that is not the second pest visit', async () => {
        const monthly = await scenario({ pattern: 'monthly' });
        const r1 = await Builders.buildEmailDivisionPayload({
          run: runFor('lc.why_91_days', monthly.recordId, monthly.customer), deps: baseDeps({ getActivityRatingAverages: async () => cohort }),
        });
        expect(r1).toEqual(expect.objectContaining({ skip: true, code: 'plan_not_quarterly' }));
        // The plan's THIRD performed visit: visit 1 and 2 already happened in the same series.
        const customer = await makeCustomer();
        const techId = await makeTech();
        const scheduledId = await makeNextVisit(customer.id);
        await makeVisit({ customerId: customer.id, technicianId: techId, date: '2026-03-20', products: ['taurus'], scheduledServiceId: scheduledId, createdAt: new Date('2026-03-20T15:00:00Z') });
        await makeVisit({ customerId: customer.id, technicianId: techId, date: '2026-06-20', products: ['taurus'], scheduledServiceId: scheduledId, createdAt: new Date('2026-06-20T15:00:00Z') });
        const thirdRecord = await makeVisit({ customerId: customer.id, technicianId: techId, date: '2026-09-20', products: ['taurus', 'talak'], scheduledServiceId: scheduledId });
        const r2 = await Builders.buildEmailDivisionPayload({
          run: runFor('lc.why_91_days', thirdRecord, customer), deps: baseDeps({ getActivityRatingAverages: async () => cohort }),
        });
        expect(r2).toEqual(expect.objectContaining({ skip: true, code: 'not_second_visit' }));
      });
    });

    describe('lc.rain_and_treatment (B6) has no builder and no automation', () => {
      test('there is no rain / weather trigger to wire it to', () => {
        expect(Builders.hasPayloadBuilder('lc.rain_and_treatment')).toBe(false);
        expect(Builders.BUILDER_TEMPLATE_KEYS).not.toContain('lc.rain_and_treatment');
        const { TRIGGER_MAPPINGS } = Executor;
        expect(Object.keys(TRIGGER_MAPPINGS).filter((key) => /rain|weather|storm/i.test(key))).toEqual([]);
      });
    });

    describe('nurture.expired_1', () => {
      const consultDeps = (overrides = {}) => baseDeps({
        probeGoneQuietConsultation: jest.fn(async () => ({ leadId: 'lead-1', estimateId: 'est-1' })),
        mintGoneQuietConsultationUrl: jest.fn(async () => 'https://wavespest.co/l/consult'),
        goneQuietConsultationStillValid: jest.fn(async () => true),
        mintEstimateLink: jest.fn(async () => ({ emailUrl: 'https://wavespest.co/l/est' })),
        ...overrides,
      });

      test('consultation_url appears ONLY through the existing eligibility, for the lead\'s own inbox', async () => {
        const customer = await makeCustomer();
        const estimateId = await makeEstimate(customer.id, customer.email);
        const deps = consultDeps();
        const ok = await Builders.buildEmailDivisionPayload({ run: runFor('nurture.expired_1', estimateId, customer), mode: 'live', deps });
        expect(ok.ok).toBe(true);
        expect(ok.payload.consultation_url).toBe('https://wavespest.co/l/consult');
        expect(ok.payload.estimate_link).toBe('https://wavespest.co/l/est');

        // The eligibility says no (today's reality for an expired estimate) -> blank.
        const refused = consultDeps({ probeGoneQuietConsultation: jest.fn(async () => null) });
        const none = await Builders.buildEmailDivisionPayload({ run: runFor('nurture.expired_1', estimateId, customer), mode: 'live', deps: refused });
        expect(none.payload.consultation_url).toBe('');
        expect(refused.mintGoneQuietConsultationUrl).not.toHaveBeenCalled();

        // The final own-inbox/eligibility re-check fails -> blank even though a link was minted.
        const stale = consultDeps({ goneQuietConsultationStillValid: jest.fn(async () => false) });
        const dropped = await Builders.buildEmailDivisionPayload({ run: runFor('nurture.expired_1', estimateId, customer), mode: 'live', deps: stale });
        expect(dropped.payload.consultation_url).toBe('');
      });

      test('a recipient who is not the estimate\'s own inbox gets no send at all (and nothing is probed or minted)', async () => {
        const customer = await makeCustomer();
        const estimateId = await makeEstimate(customer.id, 'lead.inbox@example.invalid');
        const deps = consultDeps();
        const result = await Builders.buildEmailDivisionPayload({
          run: runFor('nurture.expired_1', estimateId, customer, { recipient_email: customer.email }), mode: 'live', deps,
        });
        // The whole send is skipped (the estimate's own inbox is not this recipient): no link to anyone.
        expect(result).toEqual(expect.objectContaining({ skip: true, code: 'estimate_recipient_changed' }));
        expect(deps.probeGoneQuietConsultation).not.toHaveBeenCalled();
        expect(deps.mintGoneQuietConsultationUrl).not.toHaveBeenCalled();
      });

      test('shadow never probes, mints or links: long estimate URL, blank consultation_url', async () => {
        const customer = await makeCustomer();
        const estimateId = await makeEstimate(customer.id, customer.email);
        const deps = consultDeps();
        const result = await Builders.buildEmailDivisionPayload({ run: runFor('nurture.expired_1', estimateId, customer), mode: 'shadow', deps });
        expect(result.payload.consultation_url).toBe('');
        expect(result.payload.estimate_link).toMatch(/^https:\/\/portal\.wavespestcontrol\.com\/estimate\/qa-/);
        expect(deps.probeGoneQuietConsultation).not.toHaveBeenCalled();
        expect(deps.mintEstimateLink).not.toHaveBeenCalled();
      });

      test('names a pest only from the customer\'s own words; otherwise the quoted line in plain words', async () => {
        const customer = await makeCustomer();
        const named = await makeEstimate(customer.id, customer.email, { service_interest: 'Ghost ants in the kitchen' });
        const r1 = await Builders.buildEmailDivisionPayload({ run: runFor('nurture.expired_1', named, customer), mode: 'shadow', deps: consultDeps() });
        expect(r1.payload.pest_or_problem_named).toBe('ghost ants');
        const plain = await makeEstimate(customer.id, customer.email, { service_interest: 'Quarterly pest control' });
        const r2 = await Builders.buildEmailDivisionPayload({ run: runFor('nurture.expired_1', plain, customer), mode: 'shadow', deps: consultDeps() });
        expect(r2.payload.pest_or_problem_named).toBe('pest problem');
      });

      test('the pest comes from the lead THIS estimate belongs to: a newer unrelated lead on the same customer never changes the email, and a lead summary is never mined', async () => {
        const customer = await makeCustomer();
        const estimateId = await makeEstimate(customer.id, customer.email, { service_interest: 'Quarterly pest control' });
        // The estimate's own lead (leads.estimate_id) — customer-authored interest names no pest.
        await db('leads').insert({ customer_id: customer.id, estimate_id: estimateId, service_interest: 'Quarterly pest control', created_at: new Date('2026-09-01T12:00:00Z') });
        // A NEWER, unrelated lead on the same customer, mentioning rats, with a model summary that names another pest.
        await db('leads').insert({
          customer_id: customer.id, service_interest: 'rats in the attic', lead_synopsis: 'Caller did not mention fire ants.', created_at: new Date('2026-09-20T12:00:00Z'),
        });
        const result = await Builders.buildEmailDivisionPayload({ run: runFor('nurture.expired_1', estimateId, customer), mode: 'shadow', deps: consultDeps() });
        expect(result.ok).toBe(true);
        expect(result.payload.pest_or_problem_named).toBe('pest problem');

        // The linked lead's own words DO count.
        const named = await makeEstimate(customer.id, customer.email, { service_interest: 'Pest control' });
        await db('leads').insert({ customer_id: customer.id, estimate_id: named, service_interest: 'Ghost ants in the kitchen' });
        const r2 = await Builders.buildEmailDivisionPayload({ run: runFor('nurture.expired_1', named, customer), mode: 'shadow', deps: consultDeps() });
        expect(r2.payload.pest_or_problem_named).toBe('ghost ants');

        // Two live leads pointing at one estimate are ambiguous: neither is read.
        const ambiguous = await makeEstimate(customer.id, customer.email, { service_interest: 'Pest control' });
        await db('leads').insert([
          { customer_id: customer.id, estimate_id: ambiguous, service_interest: 'fire ants' },
          { customer_id: customer.id, estimate_id: ambiguous, service_interest: 'termites' },
        ]);
        const r3 = await Builders.buildEmailDivisionPayload({ run: runFor('nurture.expired_1', ambiguous, customer), mode: 'shadow', deps: consultDeps() });
        expect(r3.payload.pest_or_problem_named).toBe('pest problem');
      });

      test('area intel uses the ESTIMATE\'s own property city (its property record, else its own address), never customers.city; no city drops the sentence', async () => {
        const customer = await makeCustomer({ city: 'Bradenton' });
        const intel = jest.fn(async ({ city }) => `In September our technicians treated ghost ants at 61% of our 90 visits in ${city}.`);
        const own = await makeEstimate(customer.id, customer.email, { address: '123 Example St, Parrish, FL 34219' });
        const r1 = await Builders.buildEmailDivisionPayload({ run: runFor('nurture.expired_1', own, customer), mode: 'shadow', deps: consultDeps({ getAreaIntelSentence: intel }) });
        expect(intel).toHaveBeenLastCalledWith(expect.objectContaining({ city: 'Parrish' }));
        expect(r1.payload.area_intel_sentence).toContain('in Parrish');

        const [property] = await db('customer_properties').insert({ customer_id: customer.id, city: 'Venice' }).returning('id');
        const withProperty = await makeEstimate(customer.id, customer.email, { address: '9 Other Rd', property_id: property.id });
        await Builders.buildEmailDivisionPayload({ run: runFor('nurture.expired_1', withProperty, customer), mode: 'shadow', deps: consultDeps({ getAreaIntelSentence: intel }) });
        expect(intel).toHaveBeenLastCalledWith(expect.objectContaining({ city: 'Venice' }));

        intel.mockClear();
        const noCity = await makeEstimate(customer.id, customer.email, { address: '9 Other Rd' });
        const r3 = await Builders.buildEmailDivisionPayload({ run: runFor('nurture.expired_1', noCity, customer), mode: 'shadow', deps: consultDeps({ getAreaIntelSentence: intel }) });
        expect(r3.ok).toBe(true);
        expect(intel).not.toHaveBeenCalled();
        expect(r3.payload.area_intel_sentence).toBe('');
      });

      test('address_short is the STREET half by the canonical parse: a leading unit ("Unit 4, 100 Beach Rd, ...") never becomes the address', async () => {
        const customer = await makeCustomer();
        for (const [address, expected, city] of [
          ['Unit 4, 100 Beach Rd, Parrish, FL 34219', '100 Beach Rd', 'Parrish'],
          ['Apt 2B, 55 Main St, Venice, FL 34285', '55 Main St', 'Venice'],
          ['100 Beach Rd Unit 4, Parrish, FL 34219', '100 Beach Rd', 'Parrish'],
          ['123 Example St, Parrish, FL 34219', '123 Example St', 'Parrish'],
        ]) {
          const estimateId = await makeEstimate(customer.id, customer.email, { address });
          const intel = jest.fn(async () => null);
          const result = await Builders.buildEmailDivisionPayload({
            run: runFor('nurture.expired_1', estimateId, customer), mode: 'shadow', deps: consultDeps({ getAreaIntelSentence: intel }),
          });
          expect({ address, short: result.payload.address_short }).toEqual({ address, short: expected });
          expect(intel).toHaveBeenCalledWith(expect.objectContaining({ city })); // the city comes from the same parse
        }
      });

      test('an estimate aged out with NO expires_at still shows its effective expiry date (never blank, never a skip): the run\'s expires_on, else the flip time', async () => {
        const customer = await makeCustomer();
        const flipped = await makeEstimate(customer.id, customer.email, { expires_at: null, disposition_at: new Date('2026-09-21T02:30:00Z') });
        const fromRun = await Builders.buildEmailDivisionPayload({
          run: runFor('nurture.expired_1', flipped, customer), payload: { expires_on: '2026-09-20' }, mode: 'shadow', deps: consultDeps(),
        });
        expect(fromRun.ok).toBe(true);
        expect(fromRun.payload.expired_date_short).toBe('Sep 20');
        const fromFlip = await Builders.buildEmailDivisionPayload({ run: runFor('nurture.expired_1', flipped, customer), mode: 'shadow', deps: consultDeps() });
        expect(fromFlip.ok).toBe(true);
        expect(fromFlip.payload.expired_date_short).toBe('Sep 20'); // 10:30 PM ET on Sep 20
      });

      test('skips an estimate that is no longer expired, and one with no customer record', async () => {
        const customer = await makeCustomer();
        const revived = await makeEstimate(customer.id, customer.email, { status: 'sent' });
        const r1 = await Builders.buildEmailDivisionPayload({ run: runFor('nurture.expired_1', revived, customer), mode: 'shadow', deps: consultDeps() });
        expect(r1).toEqual(expect.objectContaining({ skip: true, code: 'estimate_not_expired' }));
        const expired = await makeEstimate(customer.id, customer.email);
        // An estimate with no customer record and a run with none either: the ledger needs one.
        const leadOnly = await makeEstimate(null, customer.email);
        const r2 = await Builders.buildEmailDivisionPayload({
          run: runFor('nurture.expired_1', leadOnly, customer, { recipient_id: '' }), mode: 'shadow', deps: consultDeps(),
        });
        expect(r2).toEqual(expect.objectContaining({ skip: true, code: 'no_customer' }));
        // A lead id that is not a customers row never reaches a uuid cast: skipped, not thrown.
        const r3 = await Builders.buildEmailDivisionPayload({
          run: runFor('nurture.expired_1', expired, customer, { recipient_id: 'lead-123' }), mode: 'shadow', deps: consultDeps(),
        });
        expect(r3).toEqual(expect.objectContaining({ skip: true, code: 'estimate_recipient_changed' }));
      });
    });
  });

  // ---- the automation seed -----------------------------------------------

  describe('20260930200000 automation seed', () => {
    const migration = () => require('../models/migrations/20260930200000_seed_email_division_automations');
    const keys = () => migration().AUTOMATIONS.map((a) => a.automation_key);

    test('seeded PAUSED (never runnable), with an idempotency key template each, one audit event per row, and NO rain/weather row', async () => {
      const rows = await db('email_template_automations').whereIn('automation_key', keys());
      expect(rows.map((r) => r.automation_key).sort()).toEqual(['lc.first_visit_pest', 'lc.why_91_days', 'nurture.expired_1']);
      for (const row of rows) {
        expect(row.status).toBe('paused');
        expect(row.idempotency_key_template).toMatch(/\{[a-z_]+\}/);
        expect(row.suppression_group_key).toBeTruthy();
      }
      expect(await db('email_template_automations').where({ template_key: 'lc.rain_and_treatment' })).toHaveLength(0);
      // Per-EVENT run identity (once-per-customer / per-estimate is a send-time rule, not the key).
      const keyTemplates = Object.fromEntries(rows.map((r) => [r.automation_key, r.idempotency_key_template]));
      expect(keyTemplates['lc.why_91_days']).toBe('lc.why_91_days:{service_record_id}');
      expect(keyTemplates['lc.first_visit_pest']).toBe('lc.first_visit_pest:{service_record_id}');
      expect(keyTemplates['nurture.expired_1']).toBe('nurture.expired_1:{estimate_id}:{expires_on}');
      // The templates stay DRAFT — unsendable a second way.
      const templates = await db('email_templates').whereIn('template_key', ['lc.first_visit_pest', 'lc.why_91_days', 'nurture.expired_1']);
      expect(templates.every((t) => t.status === 'draft')).toBe(true);
      const audits = await db('audit_log').where({ action: 'email_template_automation.seeded' }).whereRaw("metadata->>'automationKey' = ANY(?)", [keys()]);
      expect(audits.length).toBeGreaterThanOrEqual(3);
      // A paused automation is invisible to a trigger: nothing on these triggers loads.
      const loaded = await db('email_template_automations').whereIn('automation_key', keys()).where({ status: 'active' });
      expect(loaded).toHaveLength(0);
    });

    test('insert-once: re-running never duplicates, never reverts an operator edit, never re-audits', async () => {
      const auditCount = async () => Number((await db('audit_log').where({ action: 'email_template_automation.seeded' })
        .whereRaw("metadata->>'automationKey' = ANY(?)", [keys()]).count('* as n').first()).n);
      const before = await auditCount();
      await db('email_template_automations').where({ automation_key: 'nurture.expired_1' }).update({ status: 'draft', name: 'Edited by an operator', delay_minutes: 99 });
      try {
        await migration().up(db);
        await migration().up(db);
        const rows = await db('email_template_automations').whereIn('automation_key', keys());
        expect(rows).toHaveLength(3);
        const edited = rows.find((r) => r.automation_key === 'nurture.expired_1');
        expect(edited).toEqual(expect.objectContaining({ status: 'draft', name: 'Edited by an operator', delay_minutes: 99 }));
        expect(await auditCount()).toBe(before);
      } finally {
        await db('email_template_automations').where({ automation_key: 'nurture.expired_1' }).update({
          status: 'paused', name: 'Nurture · Estimate Expired (Touch 1)', delay_minutes: 4320,
        });
      }
    });

    test('a missing template row skips its automation (the FK is RESTRICT) instead of failing', async () => {
      let reseeded;
      await db.transaction(async (trx) => {
        await trx('email_template_automations').where({ automation_key: 'lc.why_91_days' }).del();
        await trx('email_templates').where({ template_key: 'lc.why_91_days' }).update({ template_key: 'lc.why_91_days_renamed' });
        await migration().up(trx);
        reseeded = await trx('email_template_automations').where({ automation_key: 'lc.why_91_days' });
        throw new Error('rollback sandbox');
      }).catch((err) => {
        if (err.message !== 'rollback sandbox') throw err;
      });
      expect(reseeded).toHaveLength(0);
      // The rollback discarded the sandbox: the real row is untouched.
      expect(await db('email_template_automations').where({ automation_key: 'lc.why_91_days' })).toHaveLength(1);
    });
  });
});
