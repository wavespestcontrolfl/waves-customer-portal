/**
 * CollectionsConversation (PR B relay-leg session mode) — pins:
 *  - fail-closed init: gate off, or a CallSid that is not a
 *    collections-originated call, ⇒ fixed close + zero account content;
 *  - THE STATE FENCE: tools invalid in the current state are refused IN
 *    CODE (get_balance_details before verification never returns a figure);
 *  - right-party before any debt mention; wrong party ⇒ fixed generic close;
 *  - verification is customer-SUPPLIED (expected values never leak into
 *    tool results), two failures ⇒ fixed close;
 *  - security interrupt: a spoken card number gets fixed copy, the model is
 *    NOT consulted on that turn, and the raw PAN never lands in the turns;
 *  - human escape: staffed hours ⇒ transfer handoff; the model output
 *    forbidden-language screen replaces "collections" wording;
 *  - pay-link: sub-gate + rail-guard + record-then-send ordering, and a
 *    gate-off sub-gate means zero sends;
 *  - outcomes persist through writeCallOutcome on end.
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.fn = { now: jest.fn(() => 'NOW()') };
  fn.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
  return fn;
});

const mockStreamCalls = [];
const mockScriptedMessages = [];
jest.mock('@anthropic-ai/sdk', () => jest.fn(() => ({
  messages: {
    stream: jest.fn((params) => {
      mockStreamCalls.push(params);
      return { finalMessage: async () => mockScriptedMessages.shift() };
    }),
  },
})));

// Disclosure reads the SAME eligible-invoice authority the policy used at
// dial time (prb-r1) — mocked as one $258 eligible invoice.
jest.mock('../services/collections/contact-policy', () => ({
  loadEligibleInvoices: jest.fn(async () => ([
    { id: 'inv-1', invoice_number: 'WPC-0001', due_date: '2026-07-20', total: '258.00', credit_applied: 0 },
  ])),
  // staffed-hours delegates to the policy's ONE window predicate — real
  // 9–18 ET Mon–Fri math here (no override in this suite).
  isWithinCallWindow: jest.fn((now) => {
    const { etParts } = jest.requireActual('../utils/datetime-et');
    const et = etParts(now);
    return et.dayOfWeek >= 1 && et.dayOfWeek <= 5 && et.hour >= 9 && et.hour < 18;
  }),
  isSupervisedApprover: jest.fn((a) => typeof a === 'string' && a.startsWith('admin:')),
}));
jest.mock('../services/collections/outbound-voice/flags', () => ({
  revokeAutomatedVoiceConsent: jest.fn(async () => ({ ok: true, created: true })),
  placeDisputeHold: jest.fn(async () => ({ ok: true, created: true })),
  flagWrongNumber: jest.fn(async () => ({ ok: true, created: true })),
  writeFlag: jest.fn(async () => ({ ok: true, created: true })),
  fileFlagCard: jest.fn(async () => true),
}));
jest.mock('../services/collections/outbound-voice/outcomes', () => {
  const actual = jest.requireActual('../services/collections/outbound-voice/outcomes');
  return {
    ...actual,
    writeCallOutcome: jest.fn(async () => ({ ok: true })),
  };
});
jest.mock('../services/collections/rail-guard', () => ({
  collectionsChannelPermitted: jest.fn(async () => true),
}));
jest.mock('../services/collections/contact-ledger', () => ({
  recordContact: jest.fn(async () => ({ id: 'ledger-sms-1', metadata: {} })),
  markSendFailed: jest.fn(async () => true),
}));
jest.mock('../services/invoice', () => ({
  sendViaSMS: jest.fn(async () => ({ sent: true, ok: true })),
}));
jest.mock('../services/notification-service', () => ({
  notifyAdmin: jest.fn(async () => ({ id: 'n1' })),
}));

const db = require('../models/db');
const flags = require('../services/collections/outbound-voice/flags');
const { writeCallOutcome } = require('../services/collections/outbound-voice/outcomes');
const { collectionsChannelPermitted } = require('../services/collections/rail-guard');
const ContactLedger = require('../services/collections/contact-ledger');
const InvoiceService = require('../services/invoice');
const script = require('../services/collections/outbound-voice/script');
const {
  CollectionsConversation, STATE_TOOLS,
} = require('../services/collections/outbound-voice/collections-conversation');

const STAFFED_NOW = new Date('2026-08-12T15:00:00Z'); // Wed 11:00 ET
const AFTER_HOURS_NOW = new Date('2026-08-12T23:30:00Z'); // Wed 19:30 ET

const CALL_ROW = {
  id: 'cl-1',
  direction: 'outbound',
  source: 'collections_voice',
  twilio_call_sid: 'CA1',
  customer_id: 'cust-1',
  to_phone: '+19415551234',
  metadata: JSON.stringify({ collectionCaseId: 'case-1', caseVersion: 3, ledgerId: 'ledger-1' }),
};
const CASE_ROW = {
  id: 'case-1',
  customer_id: 'cust-1',
  case_version: 3,
  eligible_invoice_ids: JSON.stringify(['inv-1']),
};
const CUSTOMER = {
  id: 'cust-1', first_name: 'Pat', last_name: 'Sample',
  phone: '+19415551234', address_line1: '4128 Shellcracker Dr', zip: '34208',
};

function chain({ first } = {}) {
  const q = {};
  ['where', 'whereIn', 'whereNull', 'whereRaw', 'orderBy', 'select'].forEach((m) => { q[m] = jest.fn(() => q); });
  q.first = jest.fn(async () => first);
  q.update = jest.fn(async () => 1);
  return q;
}

function setDb({ callRow = CALL_ROW, caseRow = CASE_ROW, customer = CUSTOMER } = {}) {
  const queues = {
    call_log: [chain({ first: callRow }), chain(), chain(), chain()],
    collection_cases: [chain({ first: caseRow })],
  };
  db.mockImplementation((table) => {
    // customers is read at init AND at the pay-link phone re-check (prb-r16)
    // — always serve the same row rather than a finite queue.
    if (table === 'customers') return chain({ first: customer });
    const queue = queues[table];
    if (!queue || !queue.length) return chain();
    return queue.shift();
  });
}

function makeConvo({ now = STAFFED_NOW } = {}) {
  const spoken = [];
  const handoffs = [];
  const convo = new CollectionsConversation({
    callSid: 'CA1',
    from: '+19412975749',
    to: '+19415551234',
    send: (text) => spoken.push(text),
    endSession: (h) => handoffs.push(h),
    now: () => now,
  });
  return { convo, spoken, handoffs };
}

async function turn(convo, text) {
  convo.handlePrompt(text);
  await convo._chain;
}

const toolUse = (name, input = {}) => ({
  stop_reason: 'tool_use',
  content: [{ type: 'tool_use', id: `t-${name}-${Math.random()}`, name, input }],
});
const endTurn = (text) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text }] });

beforeEach(() => {
  jest.clearAllMocks();
  // clearAllMocks does NOT reset implementations set with mockResolvedValue —
  // restore the defaults so per-test overrides never leak forward.
  collectionsChannelPermitted.mockResolvedValue(true);
  flags.revokeAutomatedVoiceConsent.mockResolvedValue({ ok: true, created: true });
  flags.placeDisputeHold.mockResolvedValue({ ok: true, created: true });
  flags.flagWrongNumber.mockResolvedValue({ ok: true, created: true });
  flags.writeFlag.mockResolvedValue({ ok: true, created: true });
  flags.fileFlagCard.mockResolvedValue(true);
  ContactLedger.recordContact.mockResolvedValue({ id: 'ledger-sms-1', metadata: {} });
  ContactLedger.markSendFailed.mockResolvedValue(true);
  require('../services/notification-service').notifyAdmin.mockResolvedValue({ id: 'n1' });
  InvoiceService.sendViaSMS.mockResolvedValue({ sent: true, ok: true });
  mockStreamCalls.length = 0;
  mockScriptedMessages.length = 0;
  process.env.GATE_VOICE_LATE_PAYMENT = 'true';
  delete process.env.GATE_VOICE_LATE_PAYMENT_PAYLINK;
  delete process.env.GATE_COLLECTIONS_POLICY;
  process.env.ANTHROPIC_API_KEY = 'test-key';
  setDb();
});

afterAll(() => {
  delete process.env.GATE_VOICE_LATE_PAYMENT;
  delete process.env.GATE_VOICE_LATE_PAYMENT_PAYLINK;
  delete process.env.GATE_COLLECTIONS_POLICY;
});

test('gate off ⇒ fixed failure close, model never consulted, no outcome case write beyond guard', async () => {
  process.env.GATE_VOICE_LATE_PAYMENT = 'false';
  const { convo, spoken, handoffs } = makeConvo();
  await turn(convo, 'Hello?');
  expect(spoken).toEqual([script.RELAY_FAILURE_CLOSE]);
  expect(mockStreamCalls).toHaveLength(0);
  expect(handoffs).toHaveLength(1);
});

test('a non-collections call_log row ⇒ refused with the fixed close', async () => {
  setDb({ callRow: { ...CALL_ROW, source: 'admin-click' } });
  const { convo, spoken } = makeConvo();
  await turn(convo, 'Hello?');
  expect(spoken).toEqual([script.RELAY_FAILURE_CLOSE]);
  expect(mockStreamCalls).toHaveLength(0);
});

test('STATE FENCE: get_balance_details refused in RIGHT_PARTY — no figure anywhere', async () => {
  const { convo, spoken } = makeConvo();
  mockScriptedMessages.push(
    toolUse('get_balance_details'),
    endTurn('Let me first check who I am speaking with.'),
  );
  await turn(convo, 'What is this about?');
  // The tool result fed back to the model is a refusal:
  const toolResultMsg = convo.messages.find((m) => Array.isArray(m.content) && m.content[0]?.type === 'tool_result');
  expect(toolResultMsg.content[0].content).toMatch(/Refused/);
  expect(toolResultMsg.content[0].content).not.toContain('258');
  expect(spoken.join(' ')).not.toContain('258');
  expect(convo.state).toBe('RIGHT_PARTY');
});

test('model only ever sees the current state\'s tools', async () => {
  const { convo } = makeConvo();
  mockScriptedMessages.push(endTurn('Am I speaking with Pat?'));
  await turn(convo, 'Hello?');
  const offered = mockStreamCalls[0].tools.map((t) => t.name).sort();
  expect(offered).toEqual([...STATE_TOOLS.RIGHT_PARTY].sort());
  expect(offered).not.toContain('get_balance_details');
  expect(offered).not.toContain('send_pay_link');
});

test('wrong party ⇒ fixed generic close, outcome wrong_party, zero balance words spoken', async () => {
  const { convo, spoken } = makeConvo();
  mockScriptedMessages.push(toolUse('confirm_right_party', { result: 'wrong_party' }));
  await turn(convo, 'No, Pat is not here. Who is this?');
  expect(spoken).toContain(script.WRONG_PARTY_CLOSE);
  expect(spoken.join(' ')).not.toMatch(/balance|invoice|258/i);
  expect(writeCallOutcome).toHaveBeenCalledWith('cl-1', expect.objectContaining({ outcome: 'wrong_party' }));
  expect(convo.ended).toBe(true);
});

test('number_unknown wrong party writes the wrong_number flag', async () => {
  const { convo } = makeConvo();
  mockScriptedMessages.push(toolUse('confirm_right_party', { result: 'wrong_party', number_unknown: true }));
  await turn(convo, 'There is no Pat at this number.');
  expect(flags.flagWrongNumber).toHaveBeenCalledWith('cust-1', expect.anything());
});

test('verification: match on customer-supplied ZIP unlocks DISCLOSE; expected values never leak', async () => {
  const { convo } = makeConvo();
  mockScriptedMessages.push(
    toolUse('confirm_right_party', { result: 'confirmed' }),
    endTurn('Great — could you tell me your street number or billing ZIP?'),
  );
  await turn(convo, 'Yes, this is Pat.');
  expect(convo.state).toBe('VERIFY');

  mockScriptedMessages.push(
    toolUse('verify_identity', { billing_zip: '34208' }),
    endTurn('Thanks, you are verified.'),
  );
  await turn(convo, 'It is 34208.');
  expect(convo.verified).toBe(true);
  expect(convo.state).toBe('DISCLOSE');
  const results = convo.messages
    .filter((m) => Array.isArray(m.content) && m.content[0]?.type === 'tool_result')
    .map((m) => m.content[0].content)
    .join(' ');
  expect(results).not.toContain('4128'); // street number never leaks
});

test('two failed verification attempts ⇒ fixed close, no account details', async () => {
  const { convo, spoken } = makeConvo();
  mockScriptedMessages.push(
    toolUse('confirm_right_party', { result: 'confirmed' }),
    endTurn('Could you tell me your street number or billing ZIP?'),
  );
  await turn(convo, 'Speaking.');
  mockScriptedMessages.push(
    toolUse('verify_identity', { billing_zip: '99999' }),
    endTurn('That did not match — could you try your street number?'),
  );
  await turn(convo, '99999');
  expect(convo.verified).toBe(false);
  mockScriptedMessages.push(toolUse('verify_identity', { street_number: '1' }));
  await turn(convo, '1');
  expect(spoken).toContain(script.verificationFailedClose());
  expect(writeCallOutcome).toHaveBeenCalledWith('cl-1', expect.objectContaining({ outcome: 'conversation_verification_failed' }));
  expect(spoken.join(' ')).not.toMatch(/4128|34208|258/);
});

test('security interrupt: spoken card number ⇒ fixed copy, model NOT consulted, raw PAN never stored', async () => {
  const { convo, spoken } = makeConvo();
  await turn(convo, 'Can I just pay now? My card is 4111 1111 1111 1111.');
  expect(spoken).toEqual([script.SECURITY_INTERRUPT]);
  expect(mockStreamCalls).toHaveLength(0);
  const allTurns = JSON.stringify(convo._turns) + JSON.stringify(convo.messages);
  expect(allTurns).not.toContain('4111 1111 1111 1111');
});

test('human escape phrase during staffed hours ⇒ transfer handoff to the action route', async () => {
  const { convo, handoffs, spoken } = makeConvo({ now: STAFFED_NOW });
  await turn(convo, 'I want to talk to a real person.');
  expect(spoken).toContain(script.TRANSFER_ANNOUNCEMENT);
  expect(handoffs[0]).toEqual({ next: 'transfer' });
  expect(writeCallOutcome).toHaveBeenCalledWith('cl-1', expect.objectContaining({ outcome: 'conversation_transferred' }));
  expect(mockStreamCalls).toHaveLength(0); // code-level escape, not model-mediated
});

// codex #3560 P2: the relay leg reads supervision from the immutable
// call_log stamp and passes it to the staffed-hours predicate.
test('human escape passes the call row supervision stamp to the staffed-hours predicate', async () => {
  const ContactPolicy = require('../services/collections/contact-policy');
  setDb({ callRow: { ...CALL_ROW, metadata: JSON.stringify({ collectionCaseId: 'case-1', caseVersion: 3, ledgerId: 'ledger-1', collectionsSupervised: true }) } });
  const { convo } = makeConvo({ now: AFTER_HOURS_NOW });
  await turn(convo, 'human please');
  expect(ContactPolicy.isWithinCallWindow).toHaveBeenCalledWith(AFTER_HOURS_NOW, { supervised: true });
  expect(ContactPolicy.isSupervisedApprover).not.toHaveBeenCalled();
});

test('human escape after hours ⇒ callback card + fixed promise', async () => {
  const NotificationService = require('../services/notification-service');
  const { convo, handoffs, spoken } = makeConvo({ now: AFTER_HOURS_NOW });
  await turn(convo, 'human please');
  expect(NotificationService.notifyAdmin).toHaveBeenCalledWith(
    'billing', expect.stringContaining('Callback'), expect.any(String), expect.anything(),
  );
  expect(spoken).toContain(script.callbackPromise());
  expect(handoffs[0]).toEqual({ next: 'callback' });
});

test('press 0 (DTMF) is the same escape hatch', async () => {
  const { convo, handoffs } = makeConvo({ now: STAFFED_NOW });
  convo.handleDtmf('0');
  await convo._chain;
  expect(handoffs[0]).toEqual({ next: 'transfer' });
});

test('forbidden-language screen: model text with "collections" is replaced before emission', async () => {
  const { convo, spoken } = makeConvo();
  mockScriptedMessages.push(endTurn('This is the collections department calling about your debt.'));
  await turn(convo, 'Who is this?');
  expect(spoken.join(' ')).not.toMatch(/collections|debt/i);
});

async function verifyAndDisclose(convo) {
  mockScriptedMessages.push(
    toolUse('confirm_right_party', { result: 'confirmed' }),
    endTurn('Could you tell me your billing ZIP?'),
  );
  await turn(convo, 'Speaking.');
  mockScriptedMessages.push(
    toolUse('verify_identity', { billing_zip: '34208' }),
    toolUse('get_balance_details'),
    endTurn('Your open balance is $258.00.'),
  );
  await turn(convo, '34208');
}

test('after verification, the balance flows and RESOLUTION tools unlock', async () => {
  const { convo, spoken } = makeConvo();
  await verifyAndDisclose(convo);
  expect(convo.state).toBe('RESOLUTION');
  expect(spoken.join(' ')).toContain('$258.00');
});

test('send_pay_link with sub-gate OFF ⇒ refused, zero sends', async () => {
  const { convo } = makeConvo();
  await verifyAndDisclose(convo);
  mockScriptedMessages.push(
    toolUse('send_pay_link', { customer_agreement_verbatim: 'yes, text it to me' }),
    endTurn('I am not able to text a link right now — our office can help.'),
  );
  await turn(convo, 'Text me the link.');
  expect(InvoiceService.sendViaSMS).not.toHaveBeenCalled();
  expect(ContactLedger.recordContact).not.toHaveBeenCalled();
});

test('send_pay_link: rail-guard consulted first, RECORD-THEN-SEND ordering, once per call', async () => {
  process.env.GATE_VOICE_LATE_PAYMENT_PAYLINK = 'true';
  process.env.GATE_COLLECTIONS_POLICY = 'true'; // prb-r3: pay-link hard-requires the policy gate
  const order = [];
  collectionsChannelPermitted.mockImplementation(async () => { order.push('guard'); return true; });
  ContactLedger.recordContact.mockImplementation(async () => { order.push('ledger'); return { id: 'ledger-sms-1', metadata: {} }; });
  InvoiceService.sendViaSMS.mockImplementation(async () => { order.push('send'); return { sent: true, ok: true }; });

  const { convo } = makeConvo();
  await verifyAndDisclose(convo);
  mockScriptedMessages.push(toolUse('send_pay_link', { customer_agreement_verbatim: 'yes, text it to me' }), endTurn('Sent — check your texts.'));
  await turn(convo, 'Yes please text it.');
  expect(order).toEqual(['guard', 'ledger', 'send']);
  expect(InvoiceService.sendViaSMS).toHaveBeenCalledWith('inv-1', { operatorInitiated: true });
  expect(collectionsChannelPermitted).toHaveBeenCalledWith(expect.objectContaining({ channel: 'sms', invoiceId: 'inv-1' }));

  // Second attempt on the same call is refused without another send.
  mockScriptedMessages.push(toolUse('send_pay_link', { customer_agreement_verbatim: 'yes, text it to me' }), endTurn('It is already on its way.'));
  await turn(convo, 'Send it again?');
  expect(InvoiceService.sendViaSMS).toHaveBeenCalledTimes(1);
});

test('send_pay_link: rail-guard denial ⇒ no ledger row, no send', async () => {
  process.env.GATE_VOICE_LATE_PAYMENT_PAYLINK = 'true';
  process.env.GATE_COLLECTIONS_POLICY = 'true'; // prb-r3: pay-link hard-requires the policy gate
  collectionsChannelPermitted.mockResolvedValue(false);
  const { convo } = makeConvo();
  await verifyAndDisclose(convo);
  mockScriptedMessages.push(toolUse('send_pay_link', { customer_agreement_verbatim: 'yes, text it to me' }), endTurn('I cannot text this number — our office can help.'));
  await turn(convo, 'Text me.');
  expect(ContactLedger.recordContact).not.toHaveBeenCalled();
  expect(InvoiceService.sendViaSMS).not.toHaveBeenCalled();
});

test('a REPORTED send failure ⇒ send_failed stamp, retry allowed', async () => {
  process.env.GATE_VOICE_LATE_PAYMENT_PAYLINK = 'true';
  process.env.GATE_COLLECTIONS_POLICY = 'true'; // prb-r3: pay-link hard-requires the policy gate
  InvoiceService.sendViaSMS.mockResolvedValue({ sent: false, code: 'undeliverable' });
  const { convo } = makeConvo();
  await verifyAndDisclose(convo);
  mockScriptedMessages.push(toolUse('send_pay_link', { customer_agreement_verbatim: 'yes, text it to me' }), endTurn('That did not go through.'));
  await turn(convo, 'Text me.');
  expect(ContactLedger.markSendFailed).toHaveBeenCalledWith(
    expect.objectContaining({ id: 'ledger-sms-1' }), expect.anything(),
  );
  expect(convo.payLinkSent).toBe(false);
});

// prb-r16: a THROW is ambiguous — sendViaSMS can fail in post-send
// bookkeeping after Twilio accepted the SMS. Never assert failure, never
// permit an in-call retry, stamp delivery-unknown (not send_failed).
test('a send EXCEPTION ⇒ delivery-unknown stamp, no in-call retry, no failure claim', async () => {
  process.env.GATE_VOICE_LATE_PAYMENT_PAYLINK = 'true';
  process.env.GATE_COLLECTIONS_POLICY = 'true';
  InvoiceService.sendViaSMS.mockRejectedValue(new Error('post-send bookkeeping failed'));
  const { convo } = makeConvo();
  await verifyAndDisclose(convo);
  mockScriptedMessages.push(toolUse('send_pay_link', { customer_agreement_verbatim: 'yes, text it to me' }), endTurn('Please check your messages.'));
  await turn(convo, 'Text me.');
  expect(ContactLedger.markSendFailed).not.toHaveBeenCalled();
  expect(convo.payLinkSent).toBe(true); // the in-call retry door is closed
  const toolResults = convo.messages
    .filter((m) => Array.isArray(m.content) && m.content[0]?.type === 'tool_result')
    .map((m) => m.content[0].content).join(' ');
  expect(toolResults).toContain('may or may not have gone through');
});

test('record_do_not_call writes the flag and the outcome captures it', async () => {
  const { convo } = makeConvo();
  mockScriptedMessages.push(
    toolUse('record_do_not_call', { scope: 'automated_calls', verbatim_request: 'stop these robot calls' }),
    endTurn('Done — automated calls are stopped. Goodbye.'),
  );
  await turn(convo, 'Stop these robot calls.');
  expect(flags.revokeAutomatedVoiceConsent).toHaveBeenCalledWith('cust-1', expect.anything());
  await convo.end('ws_close');
  expect(writeCallOutcome).toHaveBeenCalledWith('cl-1', expect.objectContaining({
    outcome: 'conversation_consent_revoked',
    captures: expect.objectContaining({ consentRevoked: true }),
  }));
});

test('dispute ⇒ collection_hold via flags + dispute outcome', async () => {
  const { convo } = makeConvo();
  await verifyAndDisclose(convo);
  mockScriptedMessages.push(
    toolUse('record_dispute', { summary: 'says the July visit never happened' }),
    endTurn('Understood — the office will review it before any further notices.'),
  );
  await turn(convo, 'I am not paying, nobody ever came out.');
  expect(flags.placeDisputeHold).toHaveBeenCalledWith('cust-1', expect.anything());
  await convo.end('ws_close');
  expect(writeCallOutcome).toHaveBeenCalledWith('cl-1', expect.objectContaining({ outcome: 'conversation_dispute' }));
});

test('hangup with no confirmation ⇒ conversation_abandoned outcome + transcript persisted', async () => {
  const { convo } = makeConvo();
  mockScriptedMessages.push(endTurn('Am I speaking with Pat?'));
  await turn(convo, 'Hello?');
  await convo.end('ws_close');
  expect(writeCallOutcome).toHaveBeenCalledWith('cl-1', expect.objectContaining({ outcome: 'conversation_abandoned' }));
});

// prb-r3 pins.
describe('prb-r3', () => {
  test('an EMPTY verify_identity call never consumes an attempt', async () => {
    const { convo } = makeConvo();
    await turn(convo, 'hello');
    const before = convo.verifyAttempts;
    const out = await convo._toolVerifyIdentity({});
    expect(out).toContain('did not count');
    expect(convo.verifyAttempts).toBe(before);
  });

  test('a sensitive utterance is withheld WHOLE — no trailing digits survive', async () => {
    const { convo } = makeConvo();
    await turn(convo, 'my routing number is 123456789 and my social is 123-45-6789');
    const stored = convo._turns.map((t) => t.text).join(' ');
    expect(stored).not.toContain('123456789');
    expect(stored).not.toContain('123-45-6789');
    expect(stored).toContain('[utterance withheld');
  });
});

// prb-r4 pins.
describe('prb-r4', () => {
  test('pre-verification, model text naming a balance is deflected wholesale', async () => {
    const { convo, spoken } = makeConvo();
    mockScriptedMessages.push(endTurn('You have an open balance of $258 on your invoice.'));
    await turn(convo, 'what is this about?');
    expect(spoken.join(' ')).not.toContain('open balance');
    expect(spoken.join(' ')).not.toContain('$258');
    expect(spoken.join(' ')).toContain('confirmed I am speaking with the right person');
  });

  test('send_pay_link without the customer\'s verbatim agreement is refused before any gate/consult', async () => {
    const { convo } = makeConvo();
    await turn(convo, 'hi');
    convo.verified = true;
    convo.disclosed = true;
    const out = await convo._toolSendPayLink({});
    expect(out).toContain('agreeing words verbatim');
  });
});

// prb-r7: the combined "stop calling me and get me a person" records the
// opt-out in CODE before the escape ends the session.
test('opt-out + human combo revokes consent before transferring', async () => {
  const { convo } = makeConvo({ now: STAFFED_NOW });
  await turn(convo, 'stop calling me and let me talk to a real person');
  expect(flags.revokeAutomatedVoiceConsent).toHaveBeenCalled();
  expect(convo._captures.consentRevoked).toBe(true);
});

// prb-r8 pins.
describe('prb-r8', () => {
  test('a second session on the same call refuses (one-session-ever claim)', async () => {
    setDb();
    // The claim UPDATE lands 0 rows — another socket already holds it.
    const queues = {
      call_log: [
        chain({ first: CALL_ROW }),
        (() => { const q = chain(); q.update = jest.fn(async () => 0); return q; })(),
      ],
      collection_cases: [chain({ first: CASE_ROW })],
      customers: [chain({ first: CUSTOMER })],
    };
    db.mockImplementation((t) => (queues[t] && queues[t].length ? queues[t].shift() : chain()));
    const { convo } = makeConvo();
    const ok = await convo._contextReady;
    expect(ok).toBe(false);
    expect(convo._refused).toBe('session_already_claimed');
  });

  test('a case belonging to another customer refuses the session', async () => {
    setDb({ caseRow: { ...CASE_ROW, customer_id: 'SOMEONE-ELSE' } });
    const { convo } = makeConvo();
    const ok = await convo._contextReady;
    expect(ok).toBe(false);
    expect(convo._refused).toBe('case_customer_mismatch');
  });
});

// prb-r9 pins.
describe('prb-r9', () => {
  test('a sensitive human-escape utterance is withheld WHOLE from the capture and the callback card', async () => {
    const NotificationService = require('../services/notification-service');
    const { convo } = makeConvo({ now: AFTER_HOURS_NOW });
    await turn(convo, 'my social is 123-45-6789, get me a real person');
    expect(convo._captures.humanEscapeUtterance).toBe('[utterance withheld — sensitive detail]');
    const cardBody = NotificationService.notifyAdmin.mock.calls.map((c) => c[2]).join(' ');
    expect(cardBody).not.toContain('123-45-6789');
  });

  test('model text alongside get_balance_details is NOT spoken — speech waits for the fresh figure', async () => {
    const { convo, spoken } = makeConvo();
    await turn(convo, 'hello');
    convo.verified = true;
    convo.state = 'DISCLOSE';
    mockScriptedMessages.push(
      {
        stop_reason: 'tool_use',
        content: [
          { type: 'text', text: 'Your open balance is $999.00.' }, // pre-lookup invention
          { type: 'tool_use', id: 't-bal', name: 'get_balance_details', input: {} },
        ],
      },
      endTurn('Your open balance is $258.00.'),
    );
    await turn(convo, 'so how much do I owe?');
    expect(spoken.join(' ')).not.toContain('$999');
    expect(spoken.join(' ')).toContain('$258.00');
  });

  test('wrong-number fallback hold failure ({ ok:false }, not a rejection) falls to a durable admin card', async () => {
    const NotificationService = require('../services/notification-service');
    flags.flagWrongNumber.mockResolvedValue({ ok: false });
    flags.writeFlag.mockResolvedValue({ ok: false });
    const { convo } = makeConvo();
    mockScriptedMessages.push(toolUse('confirm_right_party', { result: 'wrong_party', number_unknown: true }));
    await turn(convo, 'There is no Pat at this number.');
    expect(flags.writeFlag).toHaveBeenCalledWith(expect.objectContaining({ flag: 'collection_hold' }));
    expect(NotificationService.notifyAdmin).toHaveBeenCalledWith(
      'billing', 'Wrong-number report needs manual action', expect.any(String), expect.anything(),
    );
  });

  test('post-claim init failure reconciles the case via a fenced relay_failed outcome', async () => {
    const { loadEligibleInvoices } = require('../services/collections/contact-policy');
    loadEligibleInvoices.mockRejectedValueOnce(new Error('invoice read down'));
    const { convo } = makeConvo();
    const ok = await convo._contextReady;
    expect(ok).toBe(false);
    expect(convo._refused).toBe('init_failed_post_claim');
    expect(writeCallOutcome).toHaveBeenCalledWith(
      'cl-1', expect.objectContaining({ outcome: 'relay_failed', onlyIfNoOutcome: true }),
    );
  });

  test('all-calls scope survives a failed automated-voice write: do_not_call still attempted, honest copy', async () => {
    flags.revokeAutomatedVoiceConsent.mockResolvedValue({ ok: false });
    flags.writeFlag.mockResolvedValue({ ok: true, created: true });
    const { convo } = makeConvo();
    await turn(convo, 'hi');
    const out = await convo._toolRecordDoNotCall({ scope: 'all_calls', verbatim_request: 'never call me again' });
    expect(flags.writeFlag).toHaveBeenCalledWith(expect.objectContaining({ flag: 'do_not_call' }));
    // do_not_call blocks every call channel — the full request IS honored.
    expect(out).toContain('no calls of any kind');
    expect(convo._captures.consentRevoked).toBe(true);
  });

  test('all-calls with BOTH writes failed files ONE card carrying the FULL scope', async () => {
    const NotificationService = require('../services/notification-service');
    flags.revokeAutomatedVoiceConsent.mockResolvedValue({ ok: false });
    flags.writeFlag.mockResolvedValue({ ok: false });
    const { convo } = makeConvo();
    await turn(convo, 'hi');
    const out = await convo._toolRecordDoNotCall({ scope: 'all_calls', verbatim_request: 'stop calling entirely' });
    expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
    const [, , body] = NotificationService.notifyAdmin.mock.calls[0];
    expect(body).toContain('do_not_call by hand'); // never only the automated half
    expect(out).toContain('a person will make sure it is honored');
    expect(convo._captures.consentRevoked).toBeUndefined();
  });

  test('wrong-party review card AND fallback hold both failing logs the UNPERSISTED state loudly', async () => {
    const logger = require('../services/logger');
    flags.fileFlagCard.mockResolvedValue(false);
    flags.writeFlag.mockResolvedValue({ ok: false });
    const { convo } = makeConvo();
    mockScriptedMessages.push(toolUse('confirm_right_party', { result: 'wrong_party' }));
    await turn(convo, 'No, wrong number... I mean, Pat is not here.');
    expect(flags.writeFlag).toHaveBeenCalledWith(expect.objectContaining({ flag: 'collection_hold' }));
    expect(logger.error.mock.calls.flat().join(' ')).toContain('WRONG-PARTY REVIEW UNPERSISTED');
  });

  test('a write that outlives the close drain re-persists the outcome when it finally settles', async () => {
    jest.useFakeTimers();
    try {
      const { convo } = makeConvo();
      await turn(convo, 'hello');
      let settle;
      const op = new Promise((resolve) => { settle = resolve; });
      convo._pendingWrites = new Set([op]);
      const endP = convo.end('ws_close');
      await jest.advanceTimersByTimeAsync(5000); // drain window expires, write still pending
      await endP;
      const persistsAtClose = writeCallOutcome.mock.calls.length;
      expect(persistsAtClose).toBeGreaterThan(0);
      settle('late success');
      await jest.advanceTimersByTimeAsync(0); // flush the reconciliation microtasks
      expect(writeCallOutcome.mock.calls.length).toBeGreaterThan(persistsAtClose);
    } finally {
      jest.useRealTimers();
    }
  });
});

// prb-r11 pins.
describe('prb-r11', () => {
  test('a close racing an IN-FLIGHT persist awaits it and retries the {ok:false} result', async () => {
    const { convo } = makeConvo();
    await turn(convo, 'hello');
    let settleFirst;
    writeCallOutcome.mockImplementationOnce(() => new Promise((r) => { settleFirst = r; }));
    const finishP = convo._toolEndCall(); // persist hangs on the first outcome write
    await new Promise((r) => { setImmediate(r); });
    const endP = convo.end('ws_close'); // must await the in-flight attempt, not trust the latch
    settleFirst({ ok: false });
    await finishP;
    await endP;
    // The close retried after seeing the settled failure.
    expect(writeCallOutcome.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(convo._persisted).toBe(true);
  });

  test('a broad combo opt-out ("never call me again" + human) writes do_not_call too', async () => {
    const { convo } = makeConvo({ now: STAFFED_NOW });
    await turn(convo, 'never call me again, get me a representative');
    expect(flags.revokeAutomatedVoiceConsent).toHaveBeenCalled();
    expect(flags.writeFlag).toHaveBeenCalledWith(expect.objectContaining({ flag: 'do_not_call' }));
    expect(convo._captures.consentRevoked).toBe(true);
  });

  test('an opt-out on the turn-capped utterance is still recorded before the goodbye', async () => {
    const { convo } = makeConvo();
    await turn(convo, 'hello');
    convo._turnCount = 30; // MAX_CALL_TURNS — the next turn is over the cap
    await turn(convo, 'stop calling me');
    expect(flags.revokeAutomatedVoiceConsent).toHaveBeenCalled();
    expect(convo._captures.consentRevoked).toBe(true);
    expect(convo.ended).toBe(true);
  });

  test('a DTMF escape set during a tool block stops the REMAINING tools', async () => {
    const { convo } = makeConvo();
    await turn(convo, 'hello');
    convo.verified = true;
    convo.disclosed = true;
    convo.state = 'RESOLUTION';
    const convoRef = convo;
    flags.revokeAutomatedVoiceConsent.mockImplementation(async () => {
      convoRef._escapeRequested = true; // 0 pressed while this write ran
      return { ok: true };
    });
    mockScriptedMessages.push({
      stop_reason: 'tool_use',
      content: [
        { type: 'tool_use', id: 't-dnc', name: 'record_do_not_call', input: { scope: 'automated_calls' } },
        { type: 'tool_use', id: 't-pay', name: 'send_pay_link', input: { customer_agreement_verbatim: 'yes send it' } },
      ],
    });
    await turn(convo, 'stop the calls');
    // The second tool's machinery never ran.
    expect(collectionsChannelPermitted).not.toHaveBeenCalled();
    expect(ContactLedger.recordContact).not.toHaveBeenCalled();
  });

  test('an empty ELIGIBLE set with a surviving raw open row is indeterminate, never "settled"', async () => {
    const { loadEligibleInvoices } = require('../services/collections/contact-policy');
    const { convo } = makeConvo();
    await turn(convo, 'hello');
    convo.verified = true;
    convo.state = 'DISCLOSE';
    loadEligibleInvoices.mockResolvedValueOnce([]); // resolution failures dropped everything
    db.mockImplementation((t) => (t === 'invoices' ? chain({ first: { id: 'inv-raw-1' } }) : chain()));
    const out = await convo._toolGetBalance();
    expect(out).toContain('could not be verified');
    expect(out).not.toContain('NO open balance');
    expect(convo.disclosed).toBe(false);
  });

  test('an empty eligible set with a provably empty raw read earns the settled copy', async () => {
    const { loadEligibleInvoices } = require('../services/collections/contact-policy');
    const { convo } = makeConvo();
    await turn(convo, 'hello');
    convo.verified = true;
    convo.state = 'DISCLOSE';
    loadEligibleInvoices.mockResolvedValueOnce([]);
    db.mockImplementation(() => chain({ first: undefined }));
    const out = await convo._toolGetBalance();
    expect(out).toContain('NO open balance');
  });

  test('the system prompt carries the current ET date for relative-date conversion', async () => {
    const { convo } = makeConvo({ now: STAFFED_NOW }); // Wed 2026-08-12 ET
    mockScriptedMessages.push(endTurn('Hello!'));
    await turn(convo, 'hello');
    const system = mockStreamCalls[0].system.map((b) => b.text).join(' ');
    expect(system).toContain("Today's date is Wednesday, 2026-08-12");
  });
});

// prb-r12 pins.
describe('prb-r12', () => {
  test('an opt-out riding a sensitive utterance is still recorded (and nothing sensitive persists)', async () => {
    const { convo, spoken } = makeConvo();
    await turn(convo, 'stop calling me, my social is 123-45-6789');
    expect(flags.revokeAutomatedVoiceConsent).toHaveBeenCalled();
    expect(convo._captures.consentRevoked).toBe(true);
    expect(spoken).toContain(script.SECURITY_INTERRUPT);
    const everything = JSON.stringify(convo._turns) + JSON.stringify(convo.messages)
      + JSON.stringify(flags.revokeAutomatedVoiceConsent.mock.calls);
    expect(everything).not.toContain('123-45-6789');
  });

  test('an explicit automated-only qualifier narrows the spoken opt-out scope', async () => {
    const { convo } = makeConvo({ now: STAFFED_NOW });
    await turn(convo, 'remove me from the automated call list and get me a representative');
    expect(flags.revokeAutomatedVoiceConsent).toHaveBeenCalled();
    expect(flags.writeFlag).not.toHaveBeenCalledWith(expect.objectContaining({ flag: 'do_not_call' }));
  });

  test('a fabricated affirmative in the pay-link tool input is refused when the caller declined', async () => {
    process.env.GATE_VOICE_LATE_PAYMENT_PAYLINK = 'true';
    process.env.GATE_COLLECTIONS_POLICY = 'true';
    const { convo } = makeConvo();
    await verifyAndDisclose(convo);
    mockScriptedMessages.push(
      toolUse('send_pay_link', { customer_agreement_verbatim: 'yes, text it to me' }), // model fabrication
      endTurn('Understood.'),
    );
    await turn(convo, 'No, I do not want any texts.');
    expect(InvoiceService.sendViaSMS).not.toHaveBeenCalled();
    expect(ContactLedger.recordContact).not.toHaveBeenCalled();
  });

  test('the persisted pay-link consent evidence is the CALLER\'s words, not the model\'s paraphrase', async () => {
    process.env.GATE_VOICE_LATE_PAYMENT_PAYLINK = 'true';
    process.env.GATE_COLLECTIONS_POLICY = 'true';
    const { convo } = makeConvo();
    await verifyAndDisclose(convo);
    mockScriptedMessages.push(
      toolUse('send_pay_link', { customer_agreement_verbatim: 'yes send the text' }),
      endTurn('Sent.'),
    );
    await turn(convo, 'Sure, go ahead and text it over.');
    expect(convo._captures.payLinkAgreementVerbatim).toBe('Sure, go ahead and text it over.');
  });

  test('a verification factor the caller never said does not authenticate (and costs no attempt)', async () => {
    const { convo } = makeConvo();
    mockScriptedMessages.push(
      toolUse('confirm_right_party', { result: 'confirmed' }),
      endTurn('Could you tell me your street number or billing ZIP?'),
    );
    await turn(convo, 'Speaking.');
    // Model passes the CORRECT street number, but the caller never said it.
    mockScriptedMessages.push(
      toolUse('verify_identity', { street_number: '4128' }),
      endTurn('Could you say just the digits?'),
    );
    await turn(convo, 'my address is on shellcracker drive');
    expect(convo.verified).toBe(false);
    expect(convo.verifyAttempts).toBe(0); // grounding failure ≠ attempt
    // Grounded digits verify normally.
    mockScriptedMessages.push(
      toolUse('verify_identity', { billing_zip: '34208' }),
      endTurn('Verified, thank you.'),
    );
    await turn(convo, '3 4 2 0 8');
    expect(convo.verified).toBe(true);
  });
});

// prb-r13 pins.
describe('prb-r13', () => {
  test('grounding is exact-token: a factor embedded in some OTHER spoken number does not authenticate', async () => {
    setDb({ customer: { ...CUSTOMER, address_line1: '12 Palm Ct', zip: '34210' } });
    const { convo } = makeConvo();
    mockScriptedMessages.push(
      toolUse('confirm_right_party', { result: 'confirmed' }),
      endTurn('Could you tell me your street number or billing ZIP?'),
    );
    await turn(convo, 'Speaking.');
    // Caller mis-says a ZIP; "12" is a substring of it AND the real street.
    mockScriptedMessages.push(
      toolUse('verify_identity', { street_number: '12' }),
      endTurn('Could you say just the digits?'),
    );
    await turn(convo, 'my zip is 34212');
    expect(convo.verified).toBe(false);
    expect(convo.verifyAttempts).toBe(0);
  });

  test('an ordinary spoken opt-out is recorded in CODE before the model turn', async () => {
    const { convo } = makeConvo();
    mockScriptedMessages.push(endTurn('Understood — the calls are stopped. Goodbye.'));
    await turn(convo, 'please stop calling me');
    expect(flags.revokeAutomatedVoiceConsent).toHaveBeenCalled();
    expect(convo._captures.consentRevoked).toBe(true);
    // The model was told it is already done.
    const lastUser = convo.messages.find((m) => typeof m.content === 'string' && m.content.includes('stop calling'));
    expect(lastUser.content).toContain('already been recorded in code');
  });

  test('tool-round exhaustion files a follow-up card before promising one (and drops the promise without it)', async () => {
    const NotificationService = require('../services/notification-service');
    const { convo, spoken } = makeConvo();
    await turn(convo, 'hello');
    convo.verified = true;
    convo.state = 'DISCLOSE';
    for (let i = 0; i < 4; i++) mockScriptedMessages.push(toolUse('get_balance_details'));
    await turn(convo, 'how much?');
    expect(NotificationService.notifyAdmin).toHaveBeenCalledWith(
      'billing', 'Follow-up needed after automated billing call', expect.any(String), expect.anything(),
    );
    expect(spoken.join(' ')).toContain('Our office will follow up');

    NotificationService.notifyAdmin.mockResolvedValue(null);
    setDb(); // fresh table queues — the first convo consumed them
    const second = makeConvo();
    await turn(second.convo, 'hello');
    second.convo.verified = true;
    second.convo.state = 'DISCLOSE';
    for (let i = 0; i < 4; i++) mockScriptedMessages.push(toolUse('get_balance_details'));
    await turn(second.convo, 'how much?');
    expect(second.spoken.join(' ')).toContain('number on our website');
    expect(second.spoken.join(' ')).not.toContain('Our office will follow up');
  });
});

// prb-r14 pins.
describe('prb-r14', () => {
  test('ordinary routing/checking-account phrasing triggers the security interrupt', async () => {
    const { convo, spoken } = makeConvo();
    await turn(convo, 'my routing is 021000021');
    expect(spoken).toContain(script.SECURITY_INTERRUPT);
    expect(JSON.stringify(convo._turns) + JSON.stringify(convo.messages)).not.toContain('021000021');

    mockScriptedMessages.length = 0;
    await turn(convo, 'my checking account is 123456789');
    expect(JSON.stringify(convo._turns) + JSON.stringify(convo.messages)).not.toContain('123456789');
  });

  test('"stop these automated calls" / "stop the calls" hit the deterministic opt-out path', async () => {
    for (const phrase of ['stop these automated calls', 'stop the robot calls', 'stop the calls please']) {
      jest.clearAllMocks();
      flags.revokeAutomatedVoiceConsent.mockResolvedValue({ ok: true, created: true });
      flags.writeFlag.mockResolvedValue({ ok: true, created: true });
      setDb();
      const { convo } = makeConvo();
      mockScriptedMessages.push(endTurn('Understood, the calls are stopped.'));
      await turn(convo, phrase);
      expect(flags.revokeAutomatedVoiceConsent).toHaveBeenCalled();
    }
  });

  test('digit-joining only applies to pure spaced-digit answers — mixed sentences never synthesize a factor', async () => {
    setDb();
    const { convo } = makeConvo();
    mockScriptedMessages.push(
      toolUse('confirm_right_party', { result: 'confirmed' }),
      endTurn('Street number or billing ZIP?'),
    );
    await turn(convo, 'Speaking.');
    mockScriptedMessages.push(
      toolUse('verify_identity', { street_number: '4128' }),
      endTurn('Could you say just the digits?'),
    );
    await turn(convo, 'the street might be 41, and the unit is 28');
    expect(convo.verified).toBe(false);
    expect(convo.verifyAttempts).toBe(0);
  });

  test('a generic affirmative about something ELSE is not SMS consent; agreement after a tracked offer is', async () => {
    process.env.GATE_VOICE_LATE_PAYMENT_PAYLINK = 'true';
    process.env.GATE_COLLECTIONS_POLICY = 'true';
    const { convo } = makeConvo();
    await verifyAndDisclose(convo);
    // "yes, that amount is correct" — affirmative, but not about a text,
    // and the preceding agent line was the balance, not an offer.
    mockScriptedMessages.push(
      toolUse('send_pay_link', { customer_agreement_verbatim: 'yes, text it' }),
      endTurn('Understood.'),
    );
    await turn(convo, 'yes, that amount is correct');
    expect(InvoiceService.sendViaSMS).not.toHaveBeenCalled();

    // Now the agent makes the offer and a bare "yes please" suffices.
    mockScriptedMessages.push(endTurn('Would you like me to text you a secure payment link?'));
    await turn(convo, 'how can I pay?');
    mockScriptedMessages.push(
      toolUse('send_pay_link', { customer_agreement_verbatim: 'yes please' }),
      endTurn('Sent!'),
    );
    await turn(convo, 'yes please');
    expect(InvoiceService.sendViaSMS).toHaveBeenCalledTimes(1);
  });

  test('an intended payment date with no temporal signal in the caller turn is refused', async () => {
    const { convo } = makeConvo();
    await turn(convo, 'hello');
    convo.state = 'RESOLUTION';
    convo._turns.push({ role: 'caller', text: "I don't know when I can pay", at: Date.now() });
    const out = await convo._toolRecordPaymentIntent({ intended_payment_date: '2026-08-20' });
    expect(out).toContain('has not stated a date');
    expect(convo._captures.customerIntendedPaymentDate).toBeUndefined();

    convo._turns.push({ role: 'caller', text: 'I can pay on Friday', at: Date.now() });
    const ok = await convo._toolRecordPaymentIntent({ intended_payment_date: '2026-08-14' });
    expect(ok).toContain('Recorded');
  });

  test('the relay-failure close promises nothing and names no billing vocabulary', () => {
    expect(script.RELAY_FAILURE_CLOSE).not.toMatch(/follow up/i);
    expect(script.RELAY_FAILURE_CLOSE).not.toMatch(/invoice|balance/i);
  });
});

// prb-r15 pins.
describe('prb-r15', () => {
  test('"yes, that phone number is correct" is NOT SMS consent without a tracked offer', async () => {
    process.env.GATE_VOICE_LATE_PAYMENT_PAYLINK = 'true';
    process.env.GATE_COLLECTIONS_POLICY = 'true';
    const { convo } = makeConvo();
    await verifyAndDisclose(convo);
    mockScriptedMessages.push(
      toolUse('send_pay_link', { customer_agreement_verbatim: 'yes, text it' }),
      endTurn('Understood.'),
    );
    await turn(convo, 'yes, that phone number is correct');
    expect(InvoiceService.sendViaSMS).not.toHaveBeenCalled();
  });

  test('"41 28" (multi-digit groups) never joins into a synthetic 4128; "4 1 2 8" (single digits) does', async () => {
    setDb();
    const { convo } = makeConvo();
    mockScriptedMessages.push(
      toolUse('confirm_right_party', { result: 'confirmed' }),
      endTurn('Street number or ZIP?'),
    );
    await turn(convo, 'Speaking.');
    mockScriptedMessages.push(
      toolUse('verify_identity', { street_number: '4128' }),
      endTurn('Just the digits please?'),
    );
    await turn(convo, '41 28');
    expect(convo.verified).toBe(false);
    expect(convo.verifyAttempts).toBe(0);
    mockScriptedMessages.push(
      toolUse('verify_identity', { street_number: '4128' }),
      endTurn('Verified.'),
    );
    await turn(convo, '4 1 2 8');
    expect(convo.verified).toBe(true);
  });

  test('a recorded date must agree with the month/day the caller said', async () => {
    const { convo } = makeConvo();
    await turn(convo, 'hello');
    convo.state = 'RESOLUTION';
    convo._turns.push({ role: 'caller', text: 'I can pay on August 20', at: Date.now() });
    const bad = await convo._toolRecordPaymentIntent({ intended_payment_date: '2026-08-28' });
    expect(bad).toContain('does not match');
    expect(convo._captures.customerIntendedPaymentDate).toBeUndefined();
    const good = await convo._toolRecordPaymentIntent({ intended_payment_date: '2026-08-20' });
    expect(good).toContain('Recorded');
  });

  test('verified-but-undisclosed model text naming a balance is still deflected', async () => {
    const { convo, spoken } = makeConvo();
    await turn(convo, 'hello');
    convo.verified = true;
    convo.state = 'DISCLOSE';
    mockScriptedMessages.push(endTurn('Your balance is $100.'));
    await turn(convo, 'how much do I owe?');
    expect(spoken.join(' ')).not.toContain('$100');
    expect(spoken.join(' ')).toContain('pull up the exact details');
  });

  test('"don\'t contact me" is a deterministic BROAD opt-out', async () => {
    const { convo } = makeConvo();
    mockScriptedMessages.push(endTurn('Understood.'));
    await turn(convo, "don't contact me");
    expect(flags.revokeAutomatedVoiceConsent).toHaveBeenCalled();
    expect(flags.writeFlag).toHaveBeenCalledWith(expect.objectContaining({ flag: 'do_not_call' }));
  });

  test('the spoken-language screen catches the bare word "debt"', async () => {
    const { convo, spoken } = makeConvo();
    await turn(convo, 'hello');
    convo.verified = true;
    convo.disclosed = true;
    mockScriptedMessages.push(endTurn('This call is about your debt.'));
    await turn(convo, 'why are you calling?');
    expect(spoken.join(' ')).not.toMatch(/debt/i);
  });

  test('a timed-out write tool files a follow-up card before the model may promise one', async () => {
    jest.useFakeTimers();
    try {
      const NotificationService = require('../services/notification-service');
      const { convo } = makeConvo();
      await turn(convo, 'hello');
      flags.revokeAutomatedVoiceConsent.mockImplementation(() => new Promise(() => {})); // hangs
      const resP = convo._executeToolBounded('record_do_not_call', { scope: 'automated_calls' });
      await jest.advanceTimersByTimeAsync(8000);
      const out = await resP;
      expect(NotificationService.notifyAdmin).toHaveBeenCalledWith(
        'billing', 'Follow-up needed after automated billing call', expect.stringContaining('timed out'), expect.anything(),
      );
      expect(out).toContain('office will follow up');
    } finally {
      jest.useRealTimers();
    }
  });
});

// prb-r16 pins.
describe('prb-r16', () => {
  test('"my PIN is 1234" / "the code is 123456" are withheld; "my zip code is 34208" is NOT', async () => {
    const { convo, spoken } = makeConvo();
    await turn(convo, 'my PIN is 1234');
    expect(spoken).toContain(script.SECURITY_INTERRUPT);
    expect(JSON.stringify(convo._turns)).not.toContain('1234');

    setDb();
    const second = makeConvo();
    mockScriptedMessages.push(
      toolUse('confirm_right_party', { result: 'confirmed' }),
      endTurn('Street number or ZIP?'),
    );
    await turn(second.convo, 'Speaking.');
    mockScriptedMessages.push(
      toolUse('verify_identity', { billing_zip: '34208' }),
      endTurn('Verified.'),
    );
    await turn(second.convo, 'my zip code is 34208');
    expect(second.convo.verified).toBe(true); // ZIP phrasing never withheld
  });

  test('a negated/uncertain payment statement records nothing even with a temporal token', async () => {
    const { convo } = makeConvo();
    await turn(convo, 'hello');
    convo.state = 'RESOLUTION';
    convo._turns.push({ role: 'caller', text: "October 30 won't work; I don't know when I can pay", at: Date.now() });
    const out = await convo._toolRecordPaymentIntent({ intended_payment_date: '2026-10-30' });
    expect(out).toContain('uncertain');
    expect(convo._captures.customerIntendedPaymentDate).toBeUndefined();
  });

  test('a failing (rejecting) tool files the follow-up card before the model may promise one', async () => {
    const NotificationService = require('../services/notification-service');
    const { convo } = makeConvo();
    await turn(convo, 'hello');
    flags.revokeAutomatedVoiceConsent.mockRejectedValue(new Error('db down'));
    const out = await convo._executeToolBounded('record_do_not_call', { scope: 'automated_calls' });
    expect(NotificationService.notifyAdmin).toHaveBeenCalledWith(
      'billing', 'Follow-up needed after automated billing call', expect.any(String), expect.anything(),
    );
    expect(out).toContain('office will follow up');
  });

  test('a broad opt-out with a failed do_not_call half is NOT confirmed as fully done', async () => {
    flags.writeFlag.mockResolvedValue({ ok: false });
    const { convo } = makeConvo();
    mockScriptedMessages.push(endTurn('A person will make sure that is honored.'));
    await turn(convo, 'never call me again');
    expect(convo._captures.consentRevoked).toBe(true); // the automated half landed
    expect(convo._optOutFullyRecorded).toBe(false);
    const userMsg = convo.messages.find((m) => typeof m.content === 'string' && m.content.includes('never call me again'));
    expect(userMsg.content).toContain('do not say it is fully done');
  });

  test('a mid-call phone change refuses the pay-link send', async () => {
    process.env.GATE_VOICE_LATE_PAYMENT_PAYLINK = 'true';
    process.env.GATE_COLLECTIONS_POLICY = 'true';
    const { convo } = makeConvo();
    await verifyAndDisclose(convo);
    // The live customer row now carries a DIFFERENT number.
    db.mockImplementation((table) => (table === 'customers'
      ? chain({ first: { ...CUSTOMER, phone: '+19415559999' } })
      : chain()));
    mockScriptedMessages.push(
      toolUse('send_pay_link', { customer_agreement_verbatim: 'yes, text it to me' }),
      endTurn('I cannot text that number.'),
    );
    await turn(convo, 'yes text it to me');
    expect(InvoiceService.sendViaSMS).not.toHaveBeenCalled();
    expect(ContactLedger.recordContact).not.toHaveBeenCalled();
  });
});

// prb-r17 pins.
describe('prb-r17', () => {
  test('"yes, send that link by email" is honored as email — no SMS goes out', async () => {
    process.env.GATE_VOICE_LATE_PAYMENT_PAYLINK = 'true';
    process.env.GATE_COLLECTIONS_POLICY = 'true';
    const { convo } = makeConvo();
    await verifyAndDisclose(convo);
    mockScriptedMessages.push(
      toolUse('send_pay_link', { customer_agreement_verbatim: 'yes, send it' }),
      endTurn('I can only text it — our office can email you.'),
    );
    await turn(convo, 'yes, send that link by email');
    expect(InvoiceService.sendViaSMS).not.toHaveBeenCalled();
  });

  test('numeric ("8/20"), ordinal ("the 20th"), and relative ("tomorrow") dates all ground', async () => {
    const { convo } = makeConvo(); // now = Wed 2026-08-12 ET
    await turn(convo, 'hello');
    convo.state = 'RESOLUTION';

    convo._turns.push({ role: 'caller', text: "I'll pay on 8/20", at: Date.now() });
    expect(await convo._toolRecordPaymentIntent({ intended_payment_date: '2026-08-28' })).toContain('does not match');
    expect(await convo._toolRecordPaymentIntent({ intended_payment_date: '2026-08-20' })).toContain('Recorded');

    convo._turns.push({ role: 'caller', text: 'the 20th works', at: Date.now() });
    expect(await convo._toolRecordPaymentIntent({ intended_payment_date: '2026-08-21' })).toContain('does not match');

    convo._turns.push({ role: 'caller', text: 'tomorrow works', at: Date.now() });
    expect(await convo._toolRecordPaymentIntent({ intended_payment_date: '2026-08-20' })).toContain('does not match today/tomorrow');
    expect(await convo._toolRecordPaymentIntent({ intended_payment_date: '2026-08-13' })).toContain('Recorded');
  });
});

// prb-r18 pins.
describe('prb-r18', () => {
  test('a PAN read across turns is caught, and the prior fragments are sanitized out of the model history', async () => {
    const { convo, spoken } = makeConvo();
    mockScriptedMessages.push(endTurn('Go on.'));
    await turn(convo, 'the card is 4242 4242'); // 8 digits — no single-turn hit
    mockScriptedMessages.length = 0;
    await turn(convo, '4242 4242');
    expect(spoken).toContain(script.SECURITY_INTERRUPT);
    const everything = JSON.stringify(convo.messages) + JSON.stringify(convo._turns);
    expect(everything).not.toContain('4242');
  });

  test('the pre-send pay-link ledger row carries the consent verbatim', async () => {
    process.env.GATE_VOICE_LATE_PAYMENT_PAYLINK = 'true';
    process.env.GATE_COLLECTIONS_POLICY = 'true';
    const { convo } = makeConvo();
    await verifyAndDisclose(convo);
    mockScriptedMessages.push(
      toolUse('send_pay_link', { customer_agreement_verbatim: 'yes text it' }),
      endTurn('Sent.'),
    );
    await turn(convo, 'yes please text it over');
    expect(ContactLedger.recordContact).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ pay_link_agreement_verbatim: 'yes please text it over' }),
    }));
  });

  test('the pay-link latch closes BEFORE the provider await — a concurrent attempt cannot double-send', async () => {
    process.env.GATE_VOICE_LATE_PAYMENT_PAYLINK = 'true';
    process.env.GATE_COLLECTIONS_POLICY = 'true';
    const { convo } = makeConvo();
    await verifyAndDisclose(convo);
    convo._turns.push({ role: 'caller', text: 'yes please text it', at: Date.now() });
    let resolveSend;
    InvoiceService.sendViaSMS.mockImplementation(() => new Promise((r) => { resolveSend = r; }));
    const first = convo._toolSendPayLink({ customer_agreement_verbatim: 'yes text it' });
    await new Promise((r) => { setImmediate(r); });
    const second = await convo._toolSendPayLink({ customer_agreement_verbatim: 'yes text it' });
    expect(second).toContain('Already sent');
    resolveSend({ sent: true, ok: true });
    await first;
    expect(InvoiceService.sendViaSMS).toHaveBeenCalledTimes(1);
  });

  test('an ungrounded number_unknown degrades to the wrong-party review path, never the all-channel flag', async () => {
    const { convo } = makeConvo();
    mockScriptedMessages.push(toolUse('confirm_right_party', { result: 'wrong_party', number_unknown: true }));
    await turn(convo, 'Pat is not available right now.');
    expect(flags.flagWrongNumber).not.toHaveBeenCalled();
    expect(flags.fileFlagCard).toHaveBeenCalledWith(expect.objectContaining({ flag: 'wrong_party_review' }));
  });

  test('a week-relative phrase bounds the recordable window', async () => {
    const { convo } = makeConvo(); // Wed 2026-08-12 ET
    await turn(convo, 'hello');
    convo.state = 'RESOLUTION';
    convo._turns.push({ role: 'caller', text: 'sometime next week', at: Date.now() });
    expect(await convo._toolRecordPaymentIntent({ intended_payment_date: '2026-10-01' })).toContain('does not fit the timeframe');
    expect(await convo._toolRecordPaymentIntent({ intended_payment_date: '2026-08-18' })).toContain('Recorded');
  });
});

// prb-r19 pins.
describe('prb-r19', () => {
  test('a PAN read in FOUR chunks is caught by the widened window', async () => {
    const { convo, spoken } = makeConvo();
    for (const chunk of ['4242', '4242', '4242']) {
      mockScriptedMessages.push(endTurn('Go on.'));
      await turn(convo, chunk);
    }
    await turn(convo, '4242');
    expect(spoken).toContain(script.SECURITY_INTERRUPT);
    expect(JSON.stringify(convo.messages)).not.toContain('4242');
  });

  test('"tomorrow" across the spring-forward night resolves by ET calendar day, not +24h', async () => {
    // Sat 2026-03-07 23:30 ET — the next ET calendar day is Mar 8 (DST).
    const { convo } = makeConvo({ now: new Date('2026-03-08T04:30:00Z') });
    await turn(convo, 'hello');
    convo.state = 'RESOLUTION';
    convo._turns.push({ role: 'caller', text: 'tomorrow works', at: Date.now() });
    expect(await convo._toolRecordPaymentIntent({ intended_payment_date: '2026-03-09' })).toContain('does not match today/tomorrow');
    expect(await convo._toolRecordPaymentIntent({ intended_payment_date: '2026-03-08' })).toContain('Recorded');
  });

  test('word ordinals and "next month" ground', async () => {
    const { convo } = makeConvo(); // Wed 2026-08-12 ET
    await turn(convo, 'hello');
    convo.state = 'RESOLUTION';
    convo._turns.push({ role: 'caller', text: 'I can pay on the fifteenth', at: Date.now() });
    expect(await convo._toolRecordPaymentIntent({ intended_payment_date: '2026-08-20' })).toContain('does not match');
    expect(await convo._toolRecordPaymentIntent({ intended_payment_date: '2026-08-15' })).toContain('Recorded');
    convo._turns.push({ role: 'caller', text: 'sometime next month', at: Date.now() });
    expect(await convo._toolRecordPaymentIntent({ intended_payment_date: '2026-10-05' })).toContain('not in next month');
    expect(await convo._toolRecordPaymentIntent({ intended_payment_date: '2026-09-05' })).toContain('Recorded');
  });

  test('a misread "confirmed" without an affirmative caller turn never leaves RIGHT_PARTY', async () => {
    const { convo } = makeConvo();
    mockScriptedMessages.push(
      toolUse('confirm_right_party', { result: 'confirmed' }),
      endTurn('Could I just confirm — am I speaking with Pat?'),
    );
    await turn(convo, "No, Pat isn't available right now.");
    expect(convo.state).toBe('RIGHT_PARTY');
    mockScriptedMessages.push(
      toolUse('confirm_right_party', { result: 'confirmed' }),
      endTurn('Thanks!'),
    );
    await turn(convo, 'Yes, this is Pat.');
    expect(convo.state).toBe('VERIFY');
  });

  test('a negated stop-calling phrase records NO opt-out', async () => {
    const { convo } = makeConvo();
    mockScriptedMessages.push(endTurn('Understood, we will keep you posted.'));
    await turn(convo, "please don't stop calling me, I want the reminders");
    expect(flags.revokeAutomatedVoiceConsent).not.toHaveBeenCalled();
    expect(convo._captures.consentRevoked).toBeUndefined();
  });

  test('a bell-suppressed notifyAdmin sentinel never earns the callback promise', async () => {
    const NotificationService = require('../services/notification-service');
    NotificationService.notifyAdmin.mockResolvedValue({ id: null, suppressed: true });
    const { convo, spoken } = makeConvo({ now: AFTER_HOURS_NOW });
    await turn(convo, 'human please');
    expect(spoken).toContain(script.callbackNumberOnly());
    expect(spoken).not.toContain(script.callbackPromise());
  });
});
