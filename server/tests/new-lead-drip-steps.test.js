/**
 * GATE_NEW_LEAD_DRIP_STEPS (owner 2026-11-24): the new_lead sequence's steps 1 (price, 48 h after step 0) and 2 (one question,
 * 72 h after step 1). Gate off = the runner never loads them, so an enrollment completes after step 0 as before. Gate on = each is
 * read at delivery against four stops (estimate, booked visit, customer, reply); a failed read defers and never sends.
 * Synthetic names only.
 */

jest.mock('../services/collections/collection-hold', () => ({
  ...jest.requireActual('../services/collections/collection-hold'),
  messagingHeldByCollectionHold: jest.fn(async () => ({ held: false })),
}));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/sendgrid-mail', () => ({ isConfigured: jest.fn(() => true), sendOne: jest.fn() }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../utils/cron-lock', () => ({
  runExclusive: jest.fn(async (_name, fn) => fn()),
  wasLockSkipped: jest.requireActual('../utils/cron-lock').wasLockSkipped,
}));
jest.mock('../services/contact-notification-prefs', () => ({
  ...jest.requireActual('../services/contact-notification-prefs'),
  rerouteForContactEmailOptOut: jest.fn(async (_customerId, email) => ({ email, rerouted: false })),
}));
jest.mock('../services/estimate-follow-up', () => ({ hasRepliedSince: jest.fn(async () => false) }));

const fs = require('fs');
const path = require('path');
const db = require('../models/db');
const sendgrid = require('../services/sendgrid-mail');
const followUp = require('../services/estimate-follow-up');
const { sendStep } = require('../services/automation-runner');
const { NEW_LEAD_DRIP_STEP_IDS } = require('../services/new-lead-drip-stops');

const ENROLLED_AT = new Date('2026-11-20T17:00:00Z');
const HOUR = 3600 * 1000;

let savedGate;
beforeEach(() => {
  savedGate = process.env.GATE_NEW_LEAD_DRIP_STEPS;
  process.env.GATE_NEW_LEAD_DRIP_STEPS = 'true';
  jest.clearAllMocks();
  db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
  followUp.hasRepliedSince.mockResolvedValue(false);
});
afterEach(() => {
  if (savedGate === undefined) delete process.env.GATE_NEW_LEAD_DRIP_STEPS;
  else process.env.GATE_NEW_LEAD_DRIP_STEPS = savedGate;
});

function chain({ result = [], first, returning, firstError } = {}) {
  const q = {};
  ['where', 'whereRaw', 'whereIn', 'whereNot', 'whereNotIn', 'join', 'whereNotNull', 'whereNull', 'orWhereNotNull', 'orWhere', 'orWhereRaw', 'orderBy', 'orderByRaw', 'limit']
    .forEach((m) => { q[m] = jest.fn(() => q); });
  q.select = jest.fn(() => q);
  q.insert = jest.fn(() => q);
  q.update = jest.fn(() => Promise.resolve(1));
  q.del = jest.fn(() => Promise.resolve(1));
  q.first = jest.fn(async () => { if (firstError) throw firstError; return first; });
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
  db.transaction = jest.fn(async (fn) => {
    const trx = (table) => db(table);
    trx.raw = jest.fn(async () => ({ rows: [] }));
    return fn(trx);
  });
}

const STEP = (order, extra = {}) => ({
  id: `step-${order}`, step_order: order, subject: `Subject ${order}, {{first_name}}`, html_body: `<p>Body ${order}</p>`,
  text_body: `Text ${order}`, from_email: 'automations@wavespestcontrol.com', enabled: true, ...extra,
});
const STEP_0 = STEP(0, { delay_hours: 0 });
const STEP_1 = STEP(1, { id: NEW_LEAD_DRIP_STEP_IDS[0], delay_hours: 48 });
const STEP_2 = STEP(2, { id: NEW_LEAD_DRIP_STEP_IDS[1], delay_hours: 72 });
const STEPS = [STEP_0, STEP_1, STEP_2];

// A read's answer: the row it returns (undefined = none), or an Error it throws.
const answer = (value) => (value instanceof Error ? chain({ firstError: value }) : chain({ first: value }));
const cursorAfter = (passed) => (passed.length
  ? { passed_step_order: passed.at(-1).step_order, passed_step_id: passed.at(-1).id, passed_step_ids: passed.map((s) => s.id) }
  : {});

// The stop reads, in the order the module makes them: estimates, scheduled_services, invoices, customers (stage), leads
// (only with a lead id), customers (phone). `reads` overrides an answer by name.
function queues({ steps, reads = {}, enrollment: overrides = {}, passed = [], leadId = null }) {
  const enrollment = {
    id: 'enrollment-n', template_key: 'new_lead', customer_id: 'cust-n', status: 'active', current_step: passed.length,
    email: 'Pat@Example.com', first_name: 'Pat', last_name: 'Synthetic', enrolled_at: ENROLLED_AT,
    next_send_at: new Date(Date.now() - 1000),
    metadata: { ...cursorAfter(passed), ...(leadId ? { lead_id: leadId } : {}) },
    ...overrides,
  };
  const enrollmentUpdate = chain();
  const sendUpdate = chain();
  const stepsChain = chain({ result: steps });
  const noCustomer = !enrollment.customer_id;
  setDbQueues({
    // A lead with no customer record has no prep-send lock to take, so the row is read once.
    automation_enrollments: noCustomer
      ? [chain({ first: enrollment }), enrollmentUpdate]
      : [chain({ first: enrollment }), chain({ first: enrollment }), enrollmentUpdate],
    automation_templates: [chain({ first: { key: enrollment.template_key, name: 'New Lead', asm_group: 'newsletter' } })],
    automation_steps: [stepsChain],
    automation_step_sends: [chain({ returning: [{ id: 'send-n' }] }), sendUpdate],
    email_suppressions: [chain({ result: [] })],
    estimates: leadId ? [answer(reads.estimate), answer(reads.mirroredEstimate)] : [answer(reads.estimate)],
    scheduled_services: noCustomer ? [] : [answer(reads.visit)],
    invoices: noCustomer ? [] : [answer(reads.invoice)],
    customers: noCustomer ? [] : [answer(reads.customerStage ?? { pipeline_stage: 'new_lead' }), answer({ phone: '+19415550100' })],
    leads: leadId ? [answer(reads.lead ?? { phone: null, converted_at: null, estimate_id: null })] : [],
  });
  return { enrollmentUpdate, sendUpdate, stepsChain };
}

const tableReads = (table) => db.mock.calls.filter(([t]) => t === table).length;
const cancelledWith = (enrollmentUpdate, reason) => expect(enrollmentUpdate.update).toHaveBeenCalledWith(expect.objectContaining({
  status: 'cancelled', next_send_at: null,
  metadata: { sql: expect.stringContaining('{cancel_reason}'), bindings: [JSON.stringify(reason)] },
}));
const notCancelled = (enrollmentUpdate) => expect(enrollmentUpdate.update)
  .not.toHaveBeenCalledWith(expect.objectContaining({ status: 'cancelled' }));
const sendOk = async () => {
  sendgrid.sendOne.mockResolvedValue({ messageId: 'sg-x' });
  await expect(sendStep('enrollment-n')).resolves.toMatchObject({ sent: true });
  return sendgrid.sendOne.mock.calls.at(-1)[0];
};
const stopped = async (reason) => {
  await expect(sendStep('enrollment-n')).resolves.toEqual({ sent: false, blocked: true, reason });
  expect(sendgrid.sendOne).not.toHaveBeenCalled();
};
const dueIn = (patch, hours) => {
  const ms = patch.next_send_at.getTime() - Date.now();
  expect(ms).toBeGreaterThan(hours * HOUR - 5000);
  expect(ms).toBeLessThanOrEqual(hours * HOUR);
};

describe('gate off = today', () => {
  test('the runner asks only for steps before step 1, and step 0 completes the enrollment', async () => {
    delete process.env.GATE_NEW_LEAD_DRIP_STEPS;
    const { enrollmentUpdate, stepsChain } = queues({ steps: [STEP_0] });
    const sent = await sendOk();
    expect(sent.subject).toBe('Subject 0, Pat');
    const filter = stepsChain.where.mock.calls.map(([arg]) => arg).find((arg) => typeof arg === 'function');
    const rest = { whereNotIn: jest.fn() };
    filter(rest);
    expect(rest.whereNotIn).toHaveBeenCalledWith('id', NEW_LEAD_DRIP_STEP_IDS);
    expect(enrollmentUpdate.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed', next_send_at: null }));
    expect(tableReads('estimates')).toBe(0);
    expect(followUp.hasRepliedSince).not.toHaveBeenCalled();
  });

  test('an enrollment waiting on step 1 when the gate goes off completes with nothing sent', async () => {
    delete process.env.GATE_NEW_LEAD_DRIP_STEPS;
    const { enrollmentUpdate } = queues({ steps: [STEP_0], passed: [STEP_0] });
    await expect(sendStep('enrollment-n')).resolves.toEqual({ done: true });
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
    expect(enrollmentUpdate.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed' }));
  });

  test('another template never gets the step filter', async () => {
    delete process.env.GATE_NEW_LEAD_DRIP_STEPS;
    const { stepsChain } = queues({ steps: [STEP_0], enrollment: { template_key: 'cold_lead' } });
    await sendOk();
    expect(stepsChain.where.mock.calls.some(([arg]) => typeof arg === 'function')).toBe(false);
  });
});

describe('gate on: delays and cursor', () => {
  test('step 0 sent: the enrollment moves to step 1, due in 48 hours, with no stop read', async () => {
    const { enrollmentUpdate, stepsChain } = queues({ steps: STEPS });
    await sendOk();
    expect(stepsChain.where.mock.calls.some(([arg]) => typeof arg === 'function')).toBe(false);
    const patch = enrollmentUpdate.update.mock.calls[0][0];
    expect(patch.current_step).toBe(1);
    expect(patch.status).toBeUndefined();
    dueIn(patch, 48);
    expect(tableReads('estimates')).toBe(0);
    expect(followUp.hasRepliedSince).not.toHaveBeenCalled();
  });

  test('step 1 sent with no stop: the enrollment moves to step 2, due 72 hours later', async () => {
    const { enrollmentUpdate } = queues({ steps: STEPS, passed: [STEP_0] });
    const sent = await sendOk();
    expect(sent.subject).toBe('Subject 1, Pat');
    expect(sent.categories).toContain('step_1');
    const patch = enrollmentUpdate.update.mock.calls[0][0];
    expect(patch.current_step).toBe(2);
    dueIn(patch, 72);
  });

  test('step 2 sent: the enrollment completes', async () => {
    const { enrollmentUpdate } = queues({ steps: STEPS, passed: [STEP_0, STEP_1] });
    const sent = await sendOk();
    expect(sent.subject).toBe('Subject 2, Pat');
    expect(enrollmentUpdate.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed', next_send_at: null }));
  });

  test('a completed enrollment is never sent again', async () => {
    queues({ steps: STEPS, enrollment: { status: 'completed' } });
    await expect(sendStep('enrollment-n')).rejects.toThrow('enrollment status is completed');
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
  });
});

describe('gate on: stops at step 1 and step 2', () => {
  const AT_STEP = [['1', [STEP_0]], ['2', [STEP_0, STEP_1]]];

  test.each(AT_STEP)('step %s with no stop sends, after the reply check read the lead by customer, phone and address', async (_n, passed) => {
    const { enrollmentUpdate } = queues({ steps: STEPS, passed });
    await sendOk();
    notCancelled(enrollmentUpdate);
    expect(followUp.hasRepliedSince).toHaveBeenCalledWith(
      { id: 'enrollment-n', customer_id: 'cust-n', customer_phone: '+19415550100', customer_email: 'pat@example.com' },
      ENROLLED_AT,
      { throwOnError: true },
    );
  });

  test.each(AT_STEP)('step %s: an estimate since enrolling cancels as new_lead_estimate', async (_n, passed) => {
    const { enrollmentUpdate } = queues({ steps: STEPS, passed, reads: { estimate: { id: 'est-1' } } });
    await stopped('The lead has an estimate since enrolling');
    cancelledWith(enrollmentUpdate, 'new_lead_estimate');
    expect(tableReads('scheduled_services')).toBe(0);
  });

  test.each(AT_STEP)('step %s: a booked visit cancels as new_lead_booked', async (_n, passed) => {
    const { enrollmentUpdate } = queues({ steps: STEPS, passed, reads: { visit: { id: 'visit-1' } } });
    await stopped('The lead has a booked visit');
    cancelledWith(enrollmentUpdate, 'new_lead_booked');
  });

  test('a paid invoice cancels as new_lead_customer', async () => {
    const { enrollmentUpdate } = queues({ steps: STEPS, passed: [STEP_0], reads: { invoice: { id: 'inv-1' } } });
    await stopped('The lead is a customer');
    cancelledWith(enrollmentUpdate, 'new_lead_customer');
  });

  test.each([['active_customer'], ['won'], ['at_risk']])('customer stage %s cancels as new_lead_customer', async (stage) => {
    const { enrollmentUpdate } = queues({ steps: STEPS, passed: [STEP_0], reads: { customerStage: { pipeline_stage: stage } } });
    await stopped('The lead is a customer');
    cancelledWith(enrollmentUpdate, 'new_lead_customer');
  });

  test('a converted lead row cancels as new_lead_customer', async () => {
    const { enrollmentUpdate } = queues({
      steps: STEPS, passed: [STEP_0], leadId: 'lead-1', reads: { lead: { phone: null, estimate_id: null, converted_at: new Date('2026-11-21T10:00:00Z') } },
    });
    await stopped('The lead is a customer');
    cancelledWith(enrollmentUpdate, 'new_lead_customer');
  });

  test.each(AT_STEP)('step %s: a text or email reply since enrolling cancels as new_lead_replied', async (_n, passed) => {
    followUp.hasRepliedSince.mockResolvedValue(true);
    const { enrollmentUpdate } = queues({ steps: STEPS, passed });
    await stopped('The lead replied since enrolling');
    cancelledWith(enrollmentUpdate, 'new_lead_replied');
  });

  test('an estimate linked to the lead cancels as new_lead_estimate even when it was made before the enrollment (lead estimate_id)', async () => {
    const { enrollmentUpdate } = queues({
      steps: STEPS, passed: [STEP_0], leadId: 'lead-1', reads: { lead: { phone: null, converted_at: null, estimate_id: 'est-9' } },
    });
    await stopped('The lead has an estimate since enrolling');
    cancelledWith(enrollmentUpdate, 'new_lead_estimate');
  });

  test('an estimate mirrored to the lead in estimate_data.lead_id cancels as new_lead_estimate', async () => {
    const { enrollmentUpdate } = queues({ steps: STEPS, passed: [STEP_0], leadId: 'lead-1', reads: { mirroredEstimate: { id: 'est-8' } } });
    await stopped('The lead has an estimate since enrolling');
    cancelledWith(enrollmentUpdate, 'new_lead_estimate');
  });

  test('a lead enrolled with no customer id is checked for a text reply by the lead phone', async () => {
    followUp.hasRepliedSince.mockResolvedValue(true);
    const { enrollmentUpdate } = queues({
      steps: STEPS, passed: [STEP_0], leadId: 'lead-1', enrollment: { customer_id: null },
      reads: { lead: { phone: '+19415550123', converted_at: null, estimate_id: null } },
    });
    await stopped('The lead replied since enrolling');
    cancelledWith(enrollmentUpdate, 'new_lead_replied');
    expect(followUp.hasRepliedSince).toHaveBeenCalledWith(
      { id: 'enrollment-n', customer_id: null, customer_phone: '+19415550123', customer_email: 'pat@example.com' }, ENROLLED_AT, { throwOnError: true });
  });

  test('a step the owner added by hand to new_lead gets no stop checks, gate on', async () => {
    const hand = STEP(1, { id: 'hand-made-step', delay_hours: 24 });
    const { enrollmentUpdate } = queues({ steps: [STEP_0, hand], passed: [STEP_0] });
    await sendOk();
    expect(tableReads('estimates')).toBe(0);
    expect(followUp.hasRepliedSince).not.toHaveBeenCalled();
    notCancelled(enrollmentUpdate);
  });

  test('a lead with no customer record is still checked by address and for a reply', async () => {
    followUp.hasRepliedSince.mockResolvedValue(true);
    const { enrollmentUpdate } = queues({ steps: STEPS, passed: [STEP_0], enrollment: { customer_id: null } });
    await stopped('The lead replied since enrolling');
    cancelledWith(enrollmentUpdate, 'new_lead_replied');
    expect(tableReads('estimates')).toBe(1);
    expect(tableReads('scheduled_services')).toBe(0);
    expect(followUp.hasRepliedSince).toHaveBeenCalledWith(
      { id: 'enrollment-n', customer_id: null, customer_phone: null, customer_email: 'pat@example.com' }, ENROLLED_AT, { throwOnError: true });
  });

  test.each([
    ['an estimate read', { estimate: Object.assign(new Error('x'), { code: '57014' }) }],
    ['a visit read', { visit: Object.assign(new Error('x'), { code: '57014' }) }],
    ['an invoice read', { invoice: Object.assign(new Error('x'), { code: '57014' }) }],
  ])('%s that fails defers: nothing sent, the enrollment stays active and is retried', async (_name, failing) => {
    const { enrollmentUpdate, sendUpdate } = queues({ steps: STEPS, passed: [STEP_0], reads: failing });
    await expect(sendStep('enrollment-n')).resolves.toMatchObject({ sent: false, deferred: true });
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
    notCancelled(enrollmentUpdate);
    expect(enrollmentUpdate.update).toHaveBeenCalledWith(expect.objectContaining({ next_send_at: expect.any(Date) }));
    expect(sendUpdate.update).not.toHaveBeenCalled();
  });

  test('a reply read that fails defers too', async () => {
    followUp.hasRepliedSince.mockRejectedValue(Object.assign(new Error('boom'), { code: 'ECONNRESET' }));
    const { enrollmentUpdate } = queues({ steps: STEPS, passed: [STEP_0] });
    await expect(sendStep('enrollment-n')).resolves.toMatchObject({ sent: false, deferred: true });
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
    notCancelled(enrollmentUpdate);
  });

  test('an unreadable enrollment time defers: with no start there is nothing to compare an estimate or a reply to', async () => {
    const { enrollmentUpdate } = queues({ steps: STEPS, passed: [STEP_0], enrollment: { enrolled_at: null } });
    await expect(sendStep('enrollment-n')).resolves.toMatchObject({ sent: false, deferred: true });
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
    notCancelled(enrollmentUpdate);
  });
});

describe('the migration', () => {
  const migrationPath = '../models/migrations/20261124140000_new_lead_drip_steps';
  const migration = require(migrationPath);

  function makeKnex({ hasTable = true, template = { key: 'new_lead' } } = {}) {
    const inserts = [];
    const deletes = [];
    const knex = jest.fn((table) => {
      const q = {};
      q.where = jest.fn((criteria) => { q.criteria = criteria; return q; });
      if (table === 'automation_templates') {
        q.first = jest.fn(async () => template);
        return q;
      }
      q.insert = jest.fn((row) => { inserts.push(row); return q; });
      q.onConflict = jest.fn(() => q);
      q.ignore = jest.fn(async () => undefined);
      q.del = jest.fn(async () => { deletes.push(q.criteria); return 1; });
      return q;
    });
    knex.schema = { hasTable: jest.fn(async () => hasTable) };
    return { knex, inserts, deletes };
  }

  test('adds step 1 at 48 hours and step 2 at 72 hours, with the written subjects and previews', async () => {
    const { knex, inserts } = makeKnex();
    await migration.up(knex);
    expect(inserts.map((r) => [r.template_key, r.step_order, r.delay_hours, r.subject, r.enabled])).toEqual([
      ['new_lead', 1, 48, 'What pest control costs at a home like yours', true],
      ['new_lead', 2, 72, 'One question, {{first_name}}', true],
    ]);
    expect(inserts[0].preview_text).toBe('Most homes we treat pay about $105 to $120 per application. Here is what that covers.');
    expect(inserts[1].preview_text).toBe('What are you seeing at home? A one-word reply is enough.');
  });

  test('step 1 carries the price, the three points and the reply line, no consultation words; step 2 has no price and no link', async () => {
    const { knex, inserts } = makeKnex();
    await migration.up(knex);
    const [one, two] = inserts;
    for (const body of [one.html_body, one.text_body]) {
      expect(body).toContain('$105 to $120 per application');
      expect(body).toContain('Free return visits if pests come back between visits');
      expect(body).toContain('(941) 297-5749');
      expect(body).toContain('Reply with your address and a good time, and we will book your assessment.');
      expect(body).not.toMatch(/consultation/i);
    }
    for (const row of [one, two]) {
      expect(row.html_body).toContain('Hi {{first_name}},');
      expect(row.html_body + row.text_body).not.toContain('{{consultation_booking');
      expect(row.html_body).not.toMatch(/<a [^>]*href="https?:/);
    }
    expect(two.html_body + two.text_body).not.toMatch(/\$|href=/);
  });

  test('the seeded rows carry the fixed ids the runner hides and stops by', async () => {
    const { knex, inserts } = makeKnex();
    await migration.up(knex);
    expect(inserts.map((r) => r.id)).toEqual([...NEW_LEAD_DRIP_STEP_IDS]);
  });

  test('is a no-op without the table or the template', async () => {
    const a = makeKnex({ hasTable: false });
    await migration.up(a.knex);
    expect(a.inserts).toHaveLength(0);
    const b = makeKnex({ template: null });
    await migration.up(b.knex);
    expect(b.inserts).toHaveLength(0);
  });

  test('down is a no-op: an owner edit that kept the subject is never deleted', async () => {
    const { knex, deletes } = makeKnex();
    await migration.down(knex);
    expect(deletes).toHaveLength(0);
    expect(knex).not.toHaveBeenCalled();
  });

  test('never writes step 0: the first email has its own copy migration', () => {
    const source = fs.readFileSync(path.join(__dirname, `${migrationPath}.js`), 'utf8');
    expect(source).not.toMatch(/step_order:\s*0/);
  });
});
