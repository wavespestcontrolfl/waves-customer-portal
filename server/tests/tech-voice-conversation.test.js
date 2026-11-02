/**
 * The "Waves Tech" voice line session (services/voice-agent/tech-voice-conversation.js):
 * it re-proves the call before anything is said, takes the PIN on the keypad only,
 * answers fixed commands from the existing services in a technician's scope, reads a
 * set text back before it sends, and logs a code disclosure without the code.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ techVoiceLineLive: jest.fn(() => true) }));
jest.mock('../services/technician-eligibility', () => ({ applyAssignable: jest.fn((q) => q) }));
jest.mock('../services/tech-voice-pin', () => ({ checkTechVoicePin: jest.fn() }));
jest.mock('../services/tech-instant-answers', () => ({ pickStop: jest.fn(), answer: jest.fn() }));
jest.mock('../services/tech-line', () => ({ techLineContext: jest.fn() }));
jest.mock('../services/tech-set-texts', () => ({ setTextReply: jest.fn() }));
jest.mock('../services/tech-line-texts', () => ({ prepareSetText: jest.fn(), sendSetText: jest.fn(), visitCustomer: jest.fn() }));
jest.mock('../services/access-code-capture', () => ({ listForVisit: jest.fn() }));
jest.mock('../services/audit-log', () => ({ recordAuditEvent: jest.fn(async () => {}) }));

const mockRows = {};
const mockPluck = {};
jest.mock('../models/db', () => jest.fn((table) => {
  const chain = {
    where: jest.fn(() => chain),
    first: jest.fn(async () => mockRows[table]),
    pluck: jest.fn(async () => mockPluck[table] || []),
  };
  return chain;
}));

const { techVoiceLineLive } = require('../config/feature-gates');
const { checkTechVoicePin } = require('../services/tech-voice-pin');
const { pickStop, answer } = require('../services/tech-instant-answers');
const { techLineContext } = require('../services/tech-line');
const { setTextReply } = require('../services/tech-set-texts');
const { prepareSetText, sendSetText, visitCustomer } = require('../services/tech-line-texts');
const { listForVisit } = require('../services/access-code-capture');
const { recordAuditEvent } = require('../services/audit-log');
const { TechVoiceConversation, _test: { SAY } } = require('../services/voice-agent/tech-voice-conversation');

const TECH = { id: 'tech-1', name: 'Pat Sample' };
const STOP = { id: 'visit-1', customer_id: 'cust-1', first_name: 'Sam', address_line1: '12 Palm Way', status: 'on_site' };
const CUSTOMER = { id: 'cust-1', first_name: 'Sam' };

function admitted() {
  mockRows.call_log = { direction: 'inbound', source: 'tech_voice', metadata: { tech_voice: true, technician_id: 'tech-1' } };
  mockRows.tech_voice_usage = { technician_id: 'tech-1', settled_at: null };
  mockRows.technicians = TECH;
}

async function session({ pin = true } = {}) {
  const send = jest.fn();
  const endSession = jest.fn();
  const convo = new TechVoiceConversation({ callSid: 'CA-1', send, endSession });
  await convo._ready;
  await convo._chain;
  if (pin) {
    checkTechVoicePin.mockResolvedValueOnce({ ok: true });
    for (const d of '4512#') convo.handleDtmf(d);
    await convo._chain;
    send.mockClear();
  }
  const say = async (text) => { convo.handlePrompt(text); await convo._chain; return send.mock.calls.map((c) => c[0]).pop(); };
  return { convo, send, endSession, say };
}

beforeEach(() => {
  jest.clearAllMocks();
  admitted();
  techVoiceLineLive.mockReturnValue(true);
  pickStop.mockResolvedValue(STOP);
});
afterEach(() => jest.useRealTimers());

describe('the session re-proves the call before it says anything', () => {
  test.each([
    ['the gate is off', () => techVoiceLineLive.mockReturnValue(false)],
    ['the row is not a tech voice call', () => { mockRows.call_log = { direction: 'inbound', source: null, metadata: {} }; }],
    ['no unsettled reservation', () => { mockRows.tech_voice_usage = { technician_id: 'tech-1', settled_at: new Date() }; }],
    ['the reservation names another technician', () => { mockRows.tech_voice_usage = { technician_id: 'tech-9', settled_at: null }; }],
    ['the technician is no longer assignable', () => { mockRows.technicians = undefined; }],
  ])('%s: a goodbye, then the session ends', async (_label, arrange) => {
    jest.useFakeTimers();
    arrange();
    const { convo, send, endSession } = await session({ pin: false });
    expect(send).toHaveBeenCalledWith(SAY.unavailable);
    convo.handleDtmf('1');
    await convo._chain;
    expect(checkTechVoicePin).not.toHaveBeenCalled();
    jest.advanceTimersByTime(10000);
    expect(endSession).toHaveBeenCalledTimes(1);
  });
});

describe('PIN', () => {
  test('keypad digits then pound check the PIN in the technician\'s name; the right PIN opens the commands', async () => {
    const { convo, send } = await session({ pin: false });
    checkTechVoicePin.mockResolvedValueOnce({ ok: true });
    for (const d of '45*4512#') convo.handleDtmf(d);
    await convo._chain;
    // Star clears what came before it.
    expect(checkTechVoicePin).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ technicianId: 'tech-1', technicianName: 'Pat Sample', pin: '4512' }));
    expect(send).toHaveBeenLastCalledWith(SAY.ready);
  });

  test('speech never counts as a PIN', async () => {
    const { say } = await session({ pin: false });
    expect(await say('four five one two')).toBe(SAY.pin_keypad);
    expect(checkTechVoicePin).not.toHaveBeenCalled();
  });

  test('three wrong PINs end the call; a locked or missing PIN ends it at once', async () => {
    jest.useFakeTimers();
    let s = await session({ pin: false });
    checkTechVoicePin.mockResolvedValue({ ok: false, reason: 'wrong_pin' });
    for (let i = 0; i < 3; i += 1) { s.convo.handleDtmf('1'); s.convo.handleDtmf('#'); }
    await s.convo._chain;
    expect(s.send.mock.calls.map((c) => c[0])).toEqual([SAY.pin_retry, SAY.pin_retry, SAY.pin_wrong_final]);
    jest.advanceTimersByTime(10000);
    expect(s.endSession).toHaveBeenCalledTimes(1);

    for (const [reason, line] of [['locked', SAY.pin_locked], ['locked_now', SAY.pin_locked], ['no_pin', SAY.pin_none]]) {
      s = await session({ pin: false });
      checkTechVoicePin.mockResolvedValueOnce({ ok: false, reason });
      s.convo.handleDtmf('#');
      await s.convo._chain;
      expect(s.send).toHaveBeenLastCalledWith(line);
    }
  });

  test('no PIN in 45 seconds: goodbye', async () => {
    jest.useFakeTimers();
    const { convo, send, endSession } = await session({ pin: false });
    jest.advanceTimersByTime(45 * 1000);
    await convo._chain;
    expect(send).toHaveBeenLastCalledWith(SAY.pin_timeout);
    jest.advanceTimersByTime(10000);
    expect(endSession).toHaveBeenCalledTimes(1);
  });
});

describe('commands', () => {
  test('the three answers come from the instant-answers service for this technician', async () => {
    answer.mockResolvedValue({ title: 'Next stop', lines: ['Sam Sample', 'Address: 12 Palm Way'] });
    const { say } = await session();
    expect(await say('what is my next stop')).toBe('Next stop. Sam Sample Address: 12 Palm Way');
    await say('any access notes');
    await say('what was the last treatment');
    expect(answer.mock.calls.map((c) => [c[1], c[2].technicianId])).toEqual([
      ['next_stop', 'tech-1'], ['access_notes', 'tech-1'], ['last_treatment', 'tech-1'],
    ]);
  });

  test('a gate code is read one digit at a time, in a technician scope; the audit row holds no code', async () => {
    listForVisit.mockResolvedValue({ ok: true, codes: [
      { kind: 'property_gate', code: '4512#' },
      { kind: 'lockbox', code: '0420', instructions: 'Left of the garage.' },
      { kind: 'pass', code: null, instructions: 'Visitor pass: https://passes.example/abc' },
    ] });
    const { say } = await session();
    const line = await say('what is the gate code');
    expect(line).toBe('For Sam at 12 Palm Way. Property gate: 4 5 1 2 pound. Lockbox: 0 4 2 0. Left of the garage. '
      + 'Visitor pass. Visitor pass: the link in the app');
    expect(listForVisit).toHaveBeenCalledWith(expect.anything(), { techRole: 'technician', technicianId: 'tech-1' }, 'visit-1');
    const audit = recordAuditEvent.mock.calls[0][0];
    expect(audit).toMatchObject({ actor_type: 'technician', actor_id: 'tech-1', action: 'tech_voice.access_codes_read', resource_id: 'visit-1' });
    expect(JSON.stringify(audit)).not.toMatch(/4512|0420/);
  });

  test('a set text is read back with the name, the street and the full wording; only "yes" sends it', async () => {
    prepareSetText.mockResolvedValue({ ok: true, target: { customer: CUSTOMER, to: '+19415550123' }, body: 'Hi Sam, your back gate is locked.' });
    sendSetText.mockResolvedValue({ status: 200, json: { success: true } });
    const { say } = await session();
    expect(await say('text them the gate is locked')).toBe(`Text Sam at 12 Palm Way: Hi Sam, your back gate is locked. ${SAY.confirm_again}`);
    expect(sendSetText).not.toHaveBeenCalled();
    expect(await say('what')).toBe(SAY.confirm_again);
    expect(await say('yes send it')).toBe(SAY.sent);
    // The yes is bound to the customer, phone and wording that were read back.
    expect(sendSetText).toHaveBeenCalledWith({
      actor: { techRole: 'technician', technicianId: 'tech-1' }, scheduledServiceId: 'visit-1', kind: 'gate_locked',
      expect: { customerId: 'cust-1', to: '+19415550123', body: 'Hi Sam, your back gate is locked.' },
    });
    // "No" sends nothing.
    await say('dog is outside');
    expect(await say('no')).toBe(SAY.not_sent);
    expect(sendSetText).toHaveBeenCalledTimes(1);
  });

  test('only a plain yes sends: a negated or qualified reply sends nothing, an unclear one asks again', async () => {
    prepareSetText.mockResolvedValue({ ok: true, target: { customer: CUSTOMER }, body: 'Hi Sam, your back gate is locked.' });
    sendSetText.mockResolvedValue({ status: 200, json: { success: true } });
    const { say } = await session();
    for (const reply of ["Okay, don't send it.", 'Yes, but wait.', 'yes do not send', 'send it later, not now', 'no, send it']) {
      await say('gate locked');
      expect(await say(reply)).toBe(SAY.not_sent);
    }
    await say('gate locked');
    expect(await say('yes I guess')).toBe(SAY.confirm_again);
    expect(sendSetText).not.toHaveBeenCalled();
    expect(await say('Yes.')).toBe(SAY.sent);
    expect(sendSetText).toHaveBeenCalledTimes(1);
  });

  test('"gate code" and "garage code" ask for codes, never a set text', async () => {
    listForVisit.mockResolvedValue({ ok: true, codes: [] });
    const { say } = await session();
    expect(await say('garage code please')).toBe(SAY.no_codes);
    expect(prepareSetText).not.toHaveBeenCalled();
  });

  test('a recipient or wording changed after the read-back sends nothing and reads it back again', async () => {
    prepareSetText.mockResolvedValueOnce({ ok: true, target: { customer: CUSTOMER, to: '+19415550123' }, body: 'Hi Sam, your garage.' });
    prepareSetText.mockResolvedValueOnce({ ok: true, target: { customer: { id: 'cust-1', first_name: 'Samuel' }, to: '+19415550999' }, body: 'Hi Samuel, your garage.' });
    sendSetText.mockResolvedValueOnce({ status: 409, json: { code: 'SET_TEXT_CHANGED' } });
    const { say } = await session();
    await say('garage');
    expect(await say('yes')).toBe(`The details changed. Text Samuel at 12 Palm Way: Hi Samuel, your garage. ${SAY.confirm_again}`);
    sendSetText.mockResolvedValueOnce({ status: 200, json: { success: true } });
    expect(await say('yes')).toBe(SAY.sent);
    expect(sendSetText.mock.calls[1][0].expect).toEqual({ customerId: 'cust-1', to: '+19415550999', body: 'Hi Samuel, your garage.' });
  });

  test('a refused send is said plainly', async () => {
    prepareSetText.mockResolvedValue({ ok: false, status: 404, json: { error: 'Not found' } });
    const { say } = await session();
    expect(await say('garage')).toBe('Set texts are not turned on yet.');
    prepareSetText.mockResolvedValue({ ok: true, target: { customer: CUSTOMER }, body: 'Hi Sam.' });
    sendSetText.mockResolvedValue({ status: 409, json: { code: 'DUPLICATE_TEXT' } });
    await say('garage');
    expect(await say('yes')).toBe('That text just went out to this customer.');
  });

  test('any replies: the reply to this stop\'s set text on the technician\'s line', async () => {
    mockRows.scheduled_services = undefined;
    techLineContext.mockResolvedValue({ line: { number: '+19413529161' } });
    visitCustomer.mockResolvedValue({ customer: CUSTOMER, to: '+19415550123' });
    setTextReply.mockResolvedValue({ setText: { kind: 'gate_locked' }, reply: { body: 'Unlocked it', mediaCount: 0 }, ambiguous: false });
    const { say } = await session();
    expect(await say('any replies')).toBe('Sam replied: Unlocked it.');
    expect(setTextReply).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      customerId: 'cust-1', customerPhone: '+19415550123', lineNumber: '+19413529161', visitIds: ['visit-1'],
    }));
  });

  test('any replies on a grouped stop reads every member of the visit, so a text sent for a finished member still counts', async () => {
    mockRows.scheduled_services = { visit_id: 'grp-1' };
    mockPluck.scheduled_services = ['visit-0', 'visit-1'];
    techLineContext.mockResolvedValue({ line: { number: '+19413529161' } });
    visitCustomer.mockResolvedValue({ customer: CUSTOMER, to: '+19415550123' });
    setTextReply.mockResolvedValue({ setText: { kind: 'dog_outside' }, reply: null, ambiguous: false });
    const { say } = await session();
    expect(await say('did they reply')).toBe('No reply from Sam yet.');
    expect(setTextReply.mock.calls[0][1].visitIds).toEqual(['visit-1', 'visit-0']);
    mockRows.scheduled_services = undefined;
    mockPluck.scheduled_services = undefined;
  });

  test('no stop, an unknown phrase, help and goodbye', async () => {
    jest.useFakeTimers();
    const { say, endSession } = await session();
    expect(await say('tell me a joke')).toBe(SAY.unknown);
    expect(await say('help')).toBe(SAY.help);
    pickStop.mockResolvedValue(null);
    expect(await say('gate code')).toBe(SAY.no_stop);
    expect(await say('ok goodbye')).toBe(SAY.goodbye);
    jest.advanceTimersByTime(10000);
    expect(endSession).toHaveBeenCalledTimes(1);
  });
});
