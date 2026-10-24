// Real PostgreSQL transactions (rolled back): the text-thread lead reader's
// sweep with a stubbed model read. All names, addresses, phones and emails
// are synthetic.
process.env.GATE_SMS_LEAD_EXTRACTION = 'true';
const postgres = process.env.DATABASE_URL ? describe : describe.skip;
let mockConnection;
jest.mock('../models/db', () => new Proxy((...args) => mockConnection(...args), {
  get(_target, key) {
    const value = mockConnection?.[key];
    return typeof value === 'function' ? value.bind(mockConnection) : value;
  },
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: jest.fn() }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({ id: 'n1' })) }));

const { randomUUID } = require('node:crypto');
const { dispatchWithFallback } = require('../services/llm/call');
const NotificationService = require('../services/notification-service');
const numbers = require('../config/twilio-numbers');
const migration = require('../models/migrations/20261023280000_sms_lead_extractions');
const reader = require('../services/sms-lead-extraction');

jest.setTimeout(30000);
postgres('text-thread lead reader', () => {
  let database;
  let trx;
  const OUR_NUMBER = numbers.locations.parrish.number;
  const TEXTER = '+19415550177';
  const TEXTER10 = '9415550177';
  const NOW = new Date();
  const ago = (minutes) => new Date(NOW.getTime() - minutes * 60_000);

  const text = async (body, { minutesAgo = 10, direction = 'inbound', from = TEXTER, type, metadata = null } = {}) => {
    const id = randomUUID();
    await trx('sms_log').insert({
      id, customer_id: null, direction,
      from_phone: direction === 'inbound' ? from : OUR_NUMBER,
      to_phone: direction === 'inbound' ? OUR_NUMBER : from,
      message_body: body, created_at: ago(minutesAgo),
      status: direction === 'inbound' ? 'received' : 'sent',
      message_type: type || (direction === 'inbound' ? 'inbound' : 'manual'),
      twilio_sid: `SM${id.replace(/-/g, '').slice(0, 32)}`,
      ...(metadata ? { metadata: JSON.stringify(metadata) } : {}),
    });
    return id;
  };
  const answer = (extra = {}) => ({
    kind: 'new_service_request', service_offered: true, first_name: null, last_name: null, email: null,
    address_line: null, city: null, zip: null, requested_service: 'rodent inspection',
    problem_summary: 'Hears scratching in the attic at night.', wants_quote: true, confidence: 0.95, ...extra,
  });
  const modelSays = (...answers) => {
    for (const a of answers) dispatchWithFallback.mockResolvedValueOnce(a === null ? { ok: false } : { ok: true, json: a });
  };
  const sweep = (minutesLater = 0) => reader.sweepSmsLeadCandidates({ now: new Date(NOW.getTime() + minutesLater * 60_000) });
  const runs = () => trx('sms_lead_extractions').where({ phone_last10: TEXTER10 }).orderBy('created_at');
  const leads = () => trx('leads').whereRaw("RIGHT(regexp_replace(phone, '[^0-9]', '', 'g'), 10) = ?", [TEXTER10]);

  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL);
    const privateQa = process.env.WAVES_DATABASE_ENVIRONMENT === 'test'
      && /^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname);
    if (!['localhost', '127.0.0.1'].includes(url.hostname) && !privateQa) {
      throw new Error('Use an isolated local/CI database or labeled private QA database');
    }
    database = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 2 } });
  });
  beforeEach(async () => {
    jest.clearAllMocks();
    dispatchWithFallback.mockReset();
    trx = await database.transaction();
    mockConnection = trx;
    await migration.up(trx);
    // Rows other suites or earlier runs left in the window must not become candidates here.
    await trx('sms_log').where('created_at', '>=', ago(48 * 60)).where({ direction: 'inbound' }).del();
  });
  afterEach(async () => {
    await trx.rollback();
  });
  afterAll(async () => {
    await database.destroy();
  });

  test('a quiet thread from an unknown number becomes one inbound_sms lead and one Leads bell', async () => {
    await text('We hear scratching in the attic at night. Can someone inspect?', { minutesAgo: 20 });
    await text('Hello, do you have an address we can come by?', { minutesAgo: 15, direction: 'outbound' });
    await text('Sam Example, 100 Sample Ct, Example City 34000', { minutesAgo: 10 });
    modelSays(answer({ first_name: 'Sam', last_name: 'Example', address_line: '100 Sample Ct', city: 'Example City', zip: '34000' }));

    const out = await sweep();

    expect(out.counts).toEqual({ lead_created: 1 });
    expect(dispatchWithFallback).toHaveBeenCalledTimes(1);
    const prompt = dispatchWithFallback.mock.calls[0][1].text;
    expect(prompt).toContain('[TEXTER');
    expect(prompt).toContain('[WAVES');
    const [lead] = await leads();
    expect(lead).toMatchObject({
      first_name: 'Sam', last_name: 'Example', address: '100 Sample Ct', zip: '34000',
      lead_type: 'inbound_sms', first_contact_channel: 'sms', service_interest: 'rodent inspection',
    });
    expect(lead.twilio_message_sid).toMatch(/^SM/);
    const [run] = await runs();
    expect(run).toMatchObject({ status: 'lead_created', lead_id: lead.id, kind: 'new_service_request' });
    expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
    const [category, headline, why, opts] = NotificationService.notifyAdmin.mock.calls[0];
    expect(category).toBe('lead');
    expect(headline).toBe('Leads — reply to Sam Example about a texted request');
    expect(why).toContain('not given yet: email');
    expect(opts).toMatchObject({ link: `/admin/leads?lead=${lead.id}`, dedupeKey: `sms-lead:${lead.id}`, refreshOnDedupe: true });
  });

  test('a thread still being typed is not read until it has been quiet for 5 minutes', async () => {
    await text('Need a quote for roaches', { minutesAgo: 2 });
    expect((await sweep()).candidates).toBe(0);
    expect(dispatchWithFallback).not.toHaveBeenCalled();
  });

  test('a later text from the same number fills the same lead and refreshes the same bell', async () => {
    await text('Request a quote please, rats in the attic', { minutesAgo: 30 });
    modelSays(answer());
    await sweep();
    const [first] = await leads();
    expect(first.email).toBeNull();

    // The same thread state is never read twice.
    await sweep();
    expect(dispatchWithFallback).toHaveBeenCalledTimes(1);

    await text('sam.example@example.invalid', { minutesAgo: 6 });
    modelSays(answer({ first_name: 'Sam', email: 'Sam.Example@example.invalid' }));
    const out = await sweep();

    expect(out.counts).toEqual({ lead_updated: 1 });
    const all = await leads();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ id: first.id, email: 'sam.example@example.invalid', first_name: 'Sam' });
    expect((await runs()).map((r) => r.status)).toEqual(['lead_created', 'lead_updated']);
    expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(2);
    expect(NotificationService.notifyAdmin.mock.calls[1][3].dedupeKey).toBe(`sms-lead:${first.id}`);
  });

  test('a known customer, or a lead someone else made, is skipped without a model call', async () => {
    await trx('customers').insert({ id: randomUUID(), first_name: 'Known', last_name: 'Customer', phone: TEXTER, email: `${randomUUID()}@example.invalid` });
    await text('Are you coming today?', { minutesAgo: 10 });
    expect((await sweep()).counts).toEqual({ known_customer: 1 });

    const other = '+19415550188';
    await trx('leads').insert({ id: randomUUID(), phone: other, first_name: 'Web', last_name: 'Form', first_contact_channel: 'form', status: 'new' });
    await text('Following up on my web quote', { minutesAgo: 10, from: other });
    expect((await sweep()).counts).toEqual({ existing_lead: 1 });
    expect(dispatchWithFallback).not.toHaveBeenCalled();
  });

  test('a customer known by a secondary number is skipped', async () => {
    await trx('customers').insert({ id: randomUUID(), first_name: 'Known', last_name: 'Spouse', phone: '+19415550111', secondary_phone: TEXTER, email: `${randomUUID()}@example.invalid` });
    await text('Is the tech still coming?', { minutesAgo: 10 });
    expect((await sweep()).counts).toEqual({ known_customer: 1 });
    expect(dispatchWithFallback).not.toHaveBeenCalled();
  });

  test('a lead this reader inserted before a crash is recognised and filled on the retry', async () => {
    // What a process exit right after the insert leaves: the marked lead, a stale running read.
    const leadId = randomUUID();
    await trx('leads').insert({ id: leadId, phone: TEXTER, first_name: null, last_name: '', lead_type: 'inbound_sms', first_contact_channel: 'sms', status: 'new', extracted_data: JSON.stringify({ source: 'sms_agent' }) });
    const smsId = await text('Rats in the attic, quote please. Sam Example', { minutesAgo: 30 });
    await trx('sms_lead_extractions').insert({ phone_last10: TEXTER10, through_sms_log_id: smsId, through_at: ago(30), status: 'running', attempts: 1, updated_at: ago(20) });
    modelSays(answer({ first_name: 'Sam', last_name: 'Example' }));

    expect((await sweep()).counts).toEqual({ lead_updated: 1 });
    const all = await leads();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ id: leadId, first_name: 'Sam', last_name: 'Example' });
    expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
  });

  test('a lead or customer made while the model was reading is left alone', async () => {
    await text('Quote for rats please', { minutesAgo: 10 });
    const webLeadId = randomUUID();
    dispatchWithFallback.mockImplementationOnce(async () => {
      await trx('leads').insert({ id: webLeadId, phone: TEXTER, first_name: 'Web', last_name: 'Form', first_contact_channel: 'form', status: 'new' });
      return { ok: true, json: answer({ first_name: 'Sam', email: 'sam@example.invalid' }) };
    });
    expect((await sweep()).counts).toEqual({ existing_lead: 1 });
    const [lead] = await leads();
    expect(lead).toMatchObject({ id: webLeadId, first_name: 'Web', email: null });
    expect(lead.extracted_data).toBeNull();

    // A customer who took the number as a SECONDARY phone, under another name.
    const other = '+19415550199';
    await text('Need spider spray', { minutesAgo: 10, from: other });
    dispatchWithFallback.mockImplementationOnce(async () => {
      await trx('customers').insert({ id: randomUUID(), first_name: 'Other', last_name: 'Name', phone: '+19415550122', secondary_phone: other, email: `${randomUUID()}@example.invalid` });
      return { ok: true, json: answer() };
    });
    expect((await sweep()).counts).toEqual({ known_customer: 1 });
    expect(await trx('leads').where({ phone: other })).toHaveLength(0);
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  });

  test('a bell that fails is owed and retried by the next sweep, up to 3 tries', async () => {
    await text('Quote for ants please', { minutesAgo: 10 });
    modelSays(answer());
    // notifyAdmin answers null, not a throw, when its insert fails.
    NotificationService.notifyAdmin.mockResolvedValueOnce(null);
    expect((await sweep()).counts).toEqual({ created_unrung: 1 });
    expect((await runs())[0]).toMatchObject({ status: 'created_unrung', attempts: 1 });

    await sweep();
    expect((await runs())[0]).toMatchObject({ status: 'lead_created', error: null });
    expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(2);
    expect(dispatchWithFallback).toHaveBeenCalledTimes(1);

    const other = '+19415550166';
    await text('Quote for fleas please', { minutesAgo: 10, from: other });
    modelSays(answer());
    NotificationService.notifyAdmin.mockRejectedValue(new Error('down'));
    for (let i = 0; i < 4; i += 1) await sweep();
    const [run] = await trx('sms_lead_extractions').where({ phone_last10: '9415550166' });
    expect(run).toMatchObject({ status: 'bell_failed', attempts: 3 });
    expect(await trx('leads').where({ phone: other })).toHaveLength(1);
    NotificationService.notifyAdmin.mockReset();
  });

  test('a pitch, an out-of-scope service and a low-confidence read make no lead', async () => {
    const senders = ['+19415550191', '+19415550192', '+19415550193'];
    for (const from of senders) await text('Hello there', { minutesAgo: 10, from });
    modelSays(
      answer({ kind: 'spam_or_solicitation', service_offered: false }),
      answer({ requested_service: 'power washing', service_offered: false }),
      answer({ confidence: 0.6 }),
    );
    const out = await sweep();
    expect(out.counts).toEqual({ not_lead: 3 });
    expect(await trx('leads').whereIn('phone', senders)).toHaveLength(0);
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  });

  test('a thread the spam screen silenced is not read', async () => {
    await text('Exclusive leads, no upfront cost', { minutesAgo: 10, metadata: { spam_verdict: { is_spam: true, enforced: true } } });
    expect((await sweep()).counts).toEqual({ spam_screen: 1 });
    expect(dispatchWithFallback).not.toHaveBeenCalled();
  });

  test('a failed read retries up to 3 times, then stops', async () => {
    await text('Need someone for rats in the attic', { minutesAgo: 10 });
    modelSays(null, null, null);
    for (let i = 0; i < 4; i += 1) await sweep();
    expect(dispatchWithFallback).toHaveBeenCalledTimes(3);
    const [run] = await runs();
    expect(run).toMatchObject({ status: 'failed', attempts: 3, error: 'model_unavailable' });
    expect(await leads()).toHaveLength(0);
  });

  test('texts to the tech line are not candidates', async () => {
    await text('Running late to the next stop', { minutesAgo: 10, metadata: { source: 'tech_line' } });
    expect((await sweep()).candidates).toBe(0);
  });
});
