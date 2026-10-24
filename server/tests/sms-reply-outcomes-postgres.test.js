// Real PostgreSQL transactions (rolled back): the reply outcome sweep and the summary.
// All names, phones and message text are synthetic.
const postgres = process.env.DATABASE_URL ? describe : describe.skip;
let mockConnection;
let mockGateOn = true;
jest.mock('../models/db', () => new Proxy((...args) => mockConnection(...args), {
  get(_target, key) {
    const value = mockConnection?.[key];
    return typeof value === 'function' ? value.bind(mockConnection) : value;
  },
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => {
  const actual = jest.requireActual('../config/feature-gates');
  return { ...actual, isEnabled: (key) => (key === 'smsReplyOutcomes' ? mockGateOn : actual.isEnabled(key)) };
});

const { randomUUID } = require('node:crypto');
const logger = require('../services/logger');
const numbers = require('../config/twilio-numbers');
const migration = require('../models/migrations/20261024130000_sms_reply_outcomes');
const outcomes = require('../services/sms-reply-outcomes');

jest.setTimeout(30000);
postgres('reply outcome signals', () => {
  let database;
  let trx;
  const OUR_NUMBER = numbers.locations.parrish.number;
  const NOW = new Date();
  const HOUR = 3600_000;
  // A reply 80 hours old: every window has closed.
  const REPLY_AT = new Date(NOW.getTime() - 80 * HOUR);
  const after = (minutes) => new Date(REPLY_AT.getTime() + minutes * 60_000);
  let phoneSeq = 0;
  let phone;
  let ten;
  const sweep = (extra = {}) => outcomes.sweepReplyOutcomes({ now: NOW, limit: 5000, lookbackDays: 10, ...extra });
  const rowFor = (replyId) => trx('sms_reply_outcomes').where({ reply_sms_log_id: replyId }).first();

  const text = async (body, { at, direction = 'inbound', type, status, metadata = null, from = phone, customerId = null } = {}) => {
    const id = randomUUID();
    await trx('sms_log').insert({
      id, customer_id: customerId, direction,
      from_phone: direction === 'inbound' ? from : OUR_NUMBER,
      to_phone: direction === 'inbound' ? OUR_NUMBER : from,
      message_body: body, created_at: at,
      status: status || (direction === 'inbound' ? 'received' : 'sent'),
      message_type: type || (direction === 'inbound' ? 'inbound' : 'manual'),
      twilio_sid: `SM${id.replace(/-/g, '').slice(0, 32)}`,
      ...(metadata ? { metadata: JSON.stringify(metadata) } : {}),
    });
    return id;
  };
  // The customer asks, Waves replies (REPLY_AT); returns the reply row id.
  const askAndReply = async ({ type = 'manual', metadata = null, ask = 'How much is quarterly pest control?' } = {}) => {
    await text(ask, { at: after(-10) });
    return text('We can do that for a fair price, happy to explain.', { at: REPLY_AT, direction: 'outbound', type, metadata });
  };
  const call = async ({ minutes, direction = 'inbound', from = phone, source = null }) => trx('call_log').insert({
    direction, from_phone: from, to_phone: OUR_NUMBER, created_at: after(minutes), status: 'completed', source,
  });
  // The send wrapper's audit row (messaging/audit.js persistAudit): provider_message_id is the sms_log twilio_sid.
  const audit = (sid, metadata) => trx('messaging_audit_log').insert({
    to_hash: 'h'.repeat(64), to_last4: '0123', audience: 'customer', purpose: 'conversational', channel: 'sms',
    body_hash: 'b'.repeat(64), provider: 'twilio', provider_message_id: sid, metadata: JSON.stringify(metadata),
  });

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
    mockGateOn = true;
    trx = await database.transaction();
    mockConnection = trx;
    await migration.up(trx);
    phoneSeq += 1;
    ten = `941555${String(1000 + phoneSeq)}`;
    phone = `+1${ten}`;
  });
  afterEach(async () => {
    await trx.rollback();
  });
  afterAll(async () => {
    await database.destroy();
  });

  test('gate off: nothing is read or written', async () => {
    const replyId = await askAndReply();
    mockGateOn = false;
    expect(await sweep()).toEqual({ skipped: 'gate_off' });
    expect(await rowFor(replyId)).toBeUndefined();
  });

  test('silence: no text, no call, no opt-out', async () => {
    const replyId = await askAndReply({ type: 'ai_autosent' });
    const result = await sweep();
    expect(result).toMatchObject({ failed: 0 });
    expect(await rowFor(replyId)).toMatchObject({
      status: 'computed', silent: true, confused: false, opted_out: false, called_back: false, positive_close: false,
      reply_source: 'ai_autosent', phone_last10: ten, first_inbound_at: null,
    });
  });

  test('confusion: a "huh?" and a repeated question within 30 minutes, not an unrelated one or a late one', async () => {
    const huh = await askAndReply();
    await text('huh?', { at: after(6) });
    await sweep();
    expect(await rowFor(huh)).toMatchObject({ confused: true, confusion_reason: 'confusion_phrase', first_inbound_seconds: 360, silent: false });

    phone = `+1${ten.slice(0, 6)}${Number(ten.slice(6)) + 500}`;
    const repeat = await askAndReply({ ask: 'How much is quarterly pest control for a three bedroom house?' });
    await text('how much is quarterly pest control for a three bedroom house', { at: after(12) });
    await sweep();
    expect(await rowFor(repeat)).toMatchObject({ confused: true, confusion_reason: 'repeat' });

    phone = `+1${ten.slice(0, 6)}${Number(ten.slice(6)) + 501}`;
    const fresh = await askAndReply({ ask: 'How much is quarterly pest control for a three bedroom house?' });
    await text('Can you come Thursday afternoon instead of Friday morning?', { at: after(10) });
    await sweep();
    expect(await rowFor(fresh)).toMatchObject({ confused: false, silent: false });

    phone = `+1${ten.slice(0, 6)}${Number(ten.slice(6)) + 502}`;
    const late = await askAndReply();
    await text('huh?', { at: after(45) });
    await sweep();
    expect(await rowFor(late)).toMatchObject({ confused: false, silent: false });
  });

  test('opt-out: STOP within 72 hours counts, STOP after 72 hours does not', async () => {
    const inWindow = await askAndReply();
    await text('STOP', { at: after(50 * 60), type: 'opt_out' });
    await sweep();
    expect(await rowFor(inWindow)).toMatchObject({ opted_out: true, silent: false });

    phone = `+1${ten.slice(0, 6)}${Number(ten.slice(6)) + 500}`;
    const late = await askAndReply();
    await text('STOP', { at: after(73 * 60), type: 'opt_out' });
    await sweep();
    expect(await rowFor(late)).toMatchObject({ opted_out: false, silent: true });
  });

  test('opt-out: a STOP behind more than 100 earlier texts in the window is still found', async () => {
    const replyId = await askAndReply();
    await trx('sms_log').insert(Array.from({ length: 230 }, (_, i) => ({
      direction: 'inbound', from_phone: phone, to_phone: OUR_NUMBER, message_body: `Update number ${i}`, status: 'received',
      message_type: 'inbound', created_at: after(60 + i), twilio_sid: `SM${randomUUID().replace(/-/g, '').slice(0, 32)}`,
    })));
    await text('STOP', { at: after(60 * 60), type: 'opt_out' });
    await sweep();
    expect(await rowFor(replyId)).toMatchObject({ opted_out: true, silent: false });
  });

  test('a customer who answers the next morning is not silent, and the late answer is not confusion or a close', async () => {
    const replyId = await askAndReply();
    await text('Thanks!', { at: after(60 * 18) });
    await sweep();
    expect(await rowFor(replyId)).toMatchObject({ silent: false, positive_close: false, confused: false, first_inbound_seconds: 60 * 18 * 60 });
    expect(await rowFor(replyId)).toHaveProperty('first_inbound_at');
    expect((await rowFor(replyId)).first_inbound_at).not.toBeNull();
  });

  test('call back: an inbound call within an hour counts; later, outbound and foreign-number calls do not', async () => {
    const replyId = await askAndReply();
    await call({ minutes: 30 });
    await call({ minutes: 20, direction: 'outbound' });
    await call({ minutes: 10, from: `+44${ten}` });
    await sweep();
    expect(await rowFor(replyId)).toMatchObject({ called_back: true, silent: false });

    phone = `+1${ten.slice(0, 6)}${Number(ten.slice(6)) + 500}`;
    const noCall = await askAndReply();
    await call({ minutes: 90 });
    await call({ minutes: 10, direction: 'outbound' });
    await call({ minutes: 10, from: `+44${phone.slice(2)}` });
    await sweep();
    expect(await rowFor(noCall)).toMatchObject({ called_back: false, silent: true });
  });

  test('call back: a voice-agent sandbox call is a test call and never counts', async () => {
    const { VOICE_RELAY_SANDBOX_SOURCE } = require('../services/voice-agent/relay-protocol');
    const replyId = await askAndReply();
    await call({ minutes: 10, source: VOICE_RELAY_SANDBOX_SOURCE });
    await sweep();
    expect(await rowFor(replyId)).toMatchObject({ called_back: false, silent: true });
  });

  test('texts a handler consumed (retyped reschedule_reply / lead_intake) still count as the question and the follow-up', async () => {
    const asked = await text('Can we move my visit to Friday?', { at: after(-10), type: 'reschedule_reply' });
    const replyId = await text('Sure, Friday works.', { at: REPLY_AT, direction: 'outbound' });
    await text('huh?', { at: after(5), type: 'lead_intake' });
    await sweep();
    expect(await rowFor(replyId)).toMatchObject({ status: 'computed', replied_to_sms_log_id: asked, confused: true, silent: false });

    phone = `+1${ten.slice(0, 6)}${Number(ten.slice(6)) + 500}`;
    const second = await askAndReply();
    await text('Thanks!', { at: after(4), type: 'reschedule_reply' });
    await sweep();
    expect(await rowFor(second)).toMatchObject({ positive_close: true });
  });

  test('a scheduled reply is measured once: the provider row is, the queue row it dispatched from is not', async () => {
    await text('Can you text me the details tomorrow morning?', { at: after(-10) });
    const queueId = await text('Here are the details you asked for.', { at: new Date(REPLY_AT.getTime() + 20_000), direction: 'outbound' });
    const providerId = await text('Here are the details you asked for.', { at: REPLY_AT, direction: 'outbound', metadata: { pre_handoff_stamp: true, scheduled_sms_log_id: queueId } });
    await text('Thanks!', { at: after(5) });
    const result = await sweep();
    expect(result).toMatchObject({ failed: 0 });
    expect(await rowFor(providerId)).toMatchObject({ status: 'computed', positive_close: true });
    expect(await rowFor(queueId)).toMatchObject({ status: 'not_a_reply', positive_close: false, silent: false, replied_to_sms_log_id: null });
    expect(await trx('sms_reply_outcomes').where({ status: 'computed', phone_last10: ten })).toHaveLength(1);
  });

  test('a queue row whose provider row is not a reply type or not sent is still measured', async () => {
    await text('Please text me later', { at: after(-10) });
    const queueId = await text('Later text', { at: new Date(REPLY_AT.getTime() + 20_000), direction: 'outbound' });
    await text('Later text', { at: REPLY_AT, direction: 'outbound', status: 'failed', metadata: { scheduled_sms_log_id: queueId } });
    await sweep();
    expect(await rowFor(queueId)).toMatchObject({ status: 'computed' });
  });

  test('positive close: thanks, a thumbs-up or a like as the first text', async () => {
    const thanks = await askAndReply();
    await text('Thanks so much!', { at: after(20) });
    const thumbs = await (async () => {
      phone = `+1${ten.slice(0, 6)}${Number(ten.slice(6)) + 500}`;
      const id = await askAndReply();
      await text('👍', { at: after(3) });
      return id;
    })();
    const liked = await (async () => {
      phone = `+1${ten.slice(0, 6)}${Number(ten.slice(6)) + 501}`;
      const id = await askAndReply();
      await text('Liked “We can do that for a fair price”', { at: after(3), type: 'sms_reaction' });
      return id;
    })();
    const likedQuestion = await (async () => {
      phone = `+1${ten.slice(0, 6)}${Number(ten.slice(6)) + 503}`;
      const id = await askAndReply();
      await text('Liked “Does Tuesday work for you?”', { at: after(3), type: 'inbound' });
      return id;
    })();
    const notFirst = await (async () => {
      phone = `+1${ten.slice(0, 6)}${Number(ten.slice(6)) + 502}`;
      const id = await askAndReply();
      await text('Can you do Friday instead?', { at: after(3) });
      await text('Thanks', { at: after(6) });
      return id;
    })();
    await sweep();
    expect(await rowFor(thanks)).toMatchObject({ positive_close: true, confused: false, silent: false });
    expect(await rowFor(thumbs)).toMatchObject({ positive_close: true });
    expect(await rowFor(liked)).toMatchObject({ positive_close: true, silent: false });
    expect(await rowFor(likedQuestion)).toMatchObject({ positive_close: true, silent: false });
    expect(await rowFor(notFirst)).toMatchObject({ positive_close: false });
  });

  test('settle window, status, failed sends and non-US numbers', async () => {
    const young = await text('Reply sent recently', { at: new Date(NOW.getTime() - 10 * HOUR), direction: 'outbound' });
    await text('Earlier question', { at: new Date(NOW.getTime() - 11 * HOUR) });
    const failed = await text('Reply that failed', { at: REPLY_AT, direction: 'outbound', status: 'failed' });
    const foreignAsk = await text('Question from abroad', { at: after(-10), from: `+44${ten}` });
    const foreign = await text('Reply abroad', { at: REPLY_AT, direction: 'outbound', from: `+44${ten}` });
    const reminder = await text('Appointment reminder', { at: REPLY_AT, direction: 'outbound', type: 'appointment_reminder' });
    await sweep();
    for (const id of [young, failed, foreign, reminder]) expect(await rowFor(id)).toBeUndefined();
    expect(foreignAsk).toBeTruthy();
  });

  test('an outbound with no customer text before it is recorded once as not_a_reply', async () => {
    const outreach = await text('Hello from Waves', { at: REPLY_AT, direction: 'outbound', type: 'manual' });
    await text('An old question', { at: new Date(REPLY_AT.getTime() - 30 * HOUR) });
    await sweep();
    expect(await rowFor(outreach)).toMatchObject({ status: 'not_a_reply', replied_to_sms_log_id: null, confused: false, silent: false });
    const second = await sweep();
    expect(second.considered).toBe(0);
  });

  test('idempotent: a second sweep adds nothing, and a pre-existing row is left alone', async () => {
    const replyId = await askAndReply();
    const first = await sweep();
    expect(first.computed).toBeGreaterThanOrEqual(1);
    const before = await rowFor(replyId);
    await text('huh?', { at: after(5) });
    const again = await sweep();
    expect(again.considered).toBe(0);
    expect(await trx('sms_reply_outcomes').where({ reply_sms_log_id: replyId })).toHaveLength(1);
    expect(await rowFor(replyId)).toMatchObject({ confused: false, id: before.id });
  });

  test('draft mapping: approved draft by draft_id, auto-send by agent decision; customer id kept', async () => {
    const customerId = randomUUID();
    await trx('customers').insert({ id: customerId, first_name: 'Sample', last_name: 'Customer', phone, email: `sample-${ten}@example.test` });
    const hasCustomer = true;
    const inboundId = await text('Do you treat for ants?', { at: after(-10), customerId: hasCustomer ? customerId : null });
    const draftA = randomUUID();
    await trx('message_drafts').insert({ id: draftA, sms_log_id: inboundId, drafter: 'house_voice', status: 'shadow', prompt_version: 'house_voice_v99' });
    // Production shape: the provider writes sms_log.metadata WITHOUT draft_id (twilio.js buildSmsLogRow);
    // the draft id lives only in the send audit row that holds the same provider SID.
    const approved = await text('Yes we do.', { at: REPLY_AT, direction: 'outbound', type: 'ai_approved', metadata: { pre_handoff_stamp: true }, customerId: hasCustomer ? customerId : null });
    const approvedSid = (await trx('sms_log').where({ id: approved }).first('twilio_sid')).twilio_sid;
    await audit(approvedSid, { original_message_type: 'ai_approved', draft_id: draftA, adminUserId: randomUUID() });

    phone = `+1${ten.slice(0, 6)}${Number(ten.slice(6)) + 500}`;
    const inboundB = await text('Do you treat for roaches?', { at: after(-10) });
    const draftB = randomUUID();
    await trx('message_drafts').insert({ id: draftB, sms_log_id: inboundB, drafter: 'house_voice', status: 'shadow', prompt_version: 'house_voice_v98' });
    const decisionId = randomUUID();
    await trx('agent_decisions').insert({
      id: decisionId, workflow: 'sms', agent_name: 'test', decision_version: 'v1', entity_type: 'message_draft', entity_id: draftB,
    });
    const auto = await text('Yes we do too.', { at: REPLY_AT, direction: 'outbound', type: 'ai_autosent', metadata: { agent_decision_id: decisionId } });

    phone = `+1${ten.slice(0, 6)}${Number(ten.slice(6)) + 501}`;
    const manual = await askAndReply();
    await sweep();
    expect(await rowFor(approved)).toMatchObject({ draft_id: draftA, prompt_version: 'house_voice_v99', reply_source: 'ai_approved', replied_to_sms_log_id: inboundId, ...(hasCustomer ? { customer_id: customerId } : {}) });
    expect(await rowFor(auto)).toMatchObject({ draft_id: draftB, prompt_version: 'house_voice_v98', reply_source: 'ai_autosent' });
    expect(await rowFor(manual)).toMatchObject({ draft_id: null, prompt_version: null, reply_source: 'manual' });
  });

  test('logs carry counts only, never message text or phone numbers', async () => {
    await askAndReply({ ask: 'Secret question about my roof rats' });
    await text('huh? roof rats', { at: after(5) });
    await sweep();
    const logged = JSON.stringify([...logger.info.mock.calls, ...logger.warn.mock.calls, ...logger.error.mock.calls]);
    expect(logged).not.toMatch(/roof rats|huh|9415551/);
  });

  test('summary: counts and rates per prompt version and per reply source, small groups flagged', async () => {
    const insert = (n, fields) => trx('sms_reply_outcomes').insert(Array.from({ length: n }, () => ({
      reply_sms_log_id: randomUUID(), phone_last10: '9415550000', reply_at: new Date(NOW.getTime() - 5 * HOUR),
      status: 'computed', ...fields,
    })));
    await insert(20, { reply_source: 'ai_autosent', prompt_version: 'v_a', silent: true });
    await insert(5, { reply_source: 'ai_autosent', prompt_version: 'v_a', confused: true, confusion_reason: 'confusion_phrase' });
    await insert(5, { reply_source: 'ai_autosent', prompt_version: 'v_a', positive_close: true });
    await insert(2, { reply_source: 'ai_autosent', prompt_version: 'v_a', opted_out: true });
    await insert(3, { reply_source: 'ai_autosent', prompt_version: 'v_a', called_back: true });
    await insert(4, { reply_source: 'manual', prompt_version: null, positive_close: true });
    await insert(1, { reply_source: 'manual', prompt_version: null, status: 'not_a_reply' });
    await insert(1, { reply_source: 'manual', prompt_version: 'v_old', reply_at: new Date(NOW.getTime() - 100 * 24 * HOUR), silent: true });
    const summary = await outcomes.summarizeReplyOutcomes({ now: NOW, days: 30 });
    const version = (v) => summary.by_prompt_version.find((g) => g.prompt_version === v);
    expect(version('v_a')).toMatchObject({ count: 35, confusion_rate: 0.1429, opt_out_rate: 0.0571, call_back_rate: 0.0857, positive_close_rate: 0.1429, silent_rate: 0.5714, inconclusive: false });
    expect(version('(none)')).toMatchObject({ count: 4, positive_close_rate: 1, inconclusive: true });
    expect(version('v_old')).toBeUndefined();
    const source = (s) => summary.by_reply_source.find((g) => g.reply_source === s);
    expect(source('ai_autosent').count).toBe(35);
    expect(source('manual').count).toBe(4);
    expect(summary.overall.count).toBe(39);
    expect(summary.by_prompt_version_and_source).toHaveLength(2);
  });

  test('empty window: rates are null, not zero', async () => {
    const summary = await outcomes.summarizeReplyOutcomes({ now: NOW, since: new Date(NOW.getTime() - HOUR), until: NOW });
    expect(summary.overall).toMatchObject({ count: 0, confusion_rate: null, inconclusive: true });
  });
});
