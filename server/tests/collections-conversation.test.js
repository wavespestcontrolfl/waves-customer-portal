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
  // staffed-hours imports the real window constants from this module.
  CALL_WINDOW_START_HOUR: 9,
  CALL_WINDOW_END_HOUR: 18,
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
  ['where', 'whereNull', 'orderBy', 'select'].forEach((m) => { q[m] = jest.fn(() => q); });
  q.first = jest.fn(async () => first);
  q.update = jest.fn(async () => 1);
  return q;
}

function setDb({ callRow = CALL_ROW, caseRow = CASE_ROW, customer = CUSTOMER } = {}) {
  const queues = {
    call_log: [chain({ first: callRow }), chain(), chain(), chain()],
    collection_cases: [chain({ first: caseRow })],
    customers: [chain({ first: customer })],
  };
  db.mockImplementation((table) => {
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
  ContactLedger.recordContact.mockResolvedValue({ id: 'ledger-sms-1', metadata: {} });
  ContactLedger.markSendFailed.mockResolvedValue(true);
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
    toolUse('send_pay_link'),
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
  mockScriptedMessages.push(toolUse('send_pay_link'), endTurn('Sent — check your texts.'));
  await turn(convo, 'Yes please text it.');
  expect(order).toEqual(['guard', 'ledger', 'send']);
  expect(InvoiceService.sendViaSMS).toHaveBeenCalledWith('inv-1', { operatorInitiated: true });
  expect(collectionsChannelPermitted).toHaveBeenCalledWith(expect.objectContaining({ channel: 'sms', invoiceId: 'inv-1' }));

  // Second attempt on the same call is refused without another send.
  mockScriptedMessages.push(toolUse('send_pay_link'), endTurn('It is already on its way.'));
  await turn(convo, 'Send it again?');
  expect(InvoiceService.sendViaSMS).toHaveBeenCalledTimes(1);
});

test('send_pay_link: rail-guard denial ⇒ no ledger row, no send', async () => {
  process.env.GATE_VOICE_LATE_PAYMENT_PAYLINK = 'true';
  process.env.GATE_COLLECTIONS_POLICY = 'true'; // prb-r3: pay-link hard-requires the policy gate
  collectionsChannelPermitted.mockResolvedValue(false);
  const { convo } = makeConvo();
  await verifyAndDisclose(convo);
  mockScriptedMessages.push(toolUse('send_pay_link'), endTurn('I cannot text this number — our office can help.'));
  await turn(convo, 'Text me.');
  expect(ContactLedger.recordContact).not.toHaveBeenCalled();
  expect(InvoiceService.sendViaSMS).not.toHaveBeenCalled();
});

test('send failure ⇒ send_failed stamp on the pre-recorded ledger row', async () => {
  process.env.GATE_VOICE_LATE_PAYMENT_PAYLINK = 'true';
  process.env.GATE_COLLECTIONS_POLICY = 'true'; // prb-r3: pay-link hard-requires the policy gate
  InvoiceService.sendViaSMS.mockRejectedValue(new Error('carrier down'));
  const { convo } = makeConvo();
  await verifyAndDisclose(convo);
  mockScriptedMessages.push(toolUse('send_pay_link'), endTurn('That did not go through.'));
  await turn(convo, 'Text me.');
  expect(ContactLedger.markSendFailed).toHaveBeenCalledWith(
    expect.objectContaining({ id: 'ledger-sms-1' }), expect.anything(),
  );
  expect(convo.payLinkSent).toBe(false);
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
