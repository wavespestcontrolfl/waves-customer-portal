/**
 * collections-voice-webhook routes (PR B) — pins:
 *  - EVERY route fails closed to a bare <Hangup/> with the master gate off
 *    (zero db reads) and on any call_log linkage mismatch;
 *  - the vestibule is DTMF-only fixed TwiML: <Gather input="dtmf">, the
 *    deterministic script, and NO ConversationRelay before press-1;
 *  - AMD routing: machine_end_* ⇒ the generic callback voicemail (ledger
 *    30d-capped); 'unknown'/'fax' ⇒ NO voicemail ever; human ⇒ the gather;
 *  - press 1 ⇒ <Connect><ConversationRelay> with session_mode=collections
 *    Parameter + the collections action route;
 *  - press 9 ⇒ durable consent-revoked flag FIRST, confirmation only when
 *    the write proved durable (a failed write never claims success);
 *  - press 0 ⇒ staffed hours = warm transfer <Dial>, else callback card;
 *  - relay-complete honors the transfer handoff and records relay_failed;
 *  - spoken copy never contains "collections"/"debt"/"delinquent" and the
 *    voicemail is never described as a "limited-content message".
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.fn = { now: jest.fn(() => 'NOW()') };
  fn.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
  return fn;
});
jest.mock('../services/collections/outbound-voice/voicemail', () => {
  const actual = jest.requireActual('../services/collections/outbound-voice/voicemail');
  return {
    ...actual,
    voicemailPermitted: jest.fn(async () => true),
    stampVoicemailLeft: jest.fn(async () => true),
  };
});
// Answer-time revalidation (gh prb-r12) — allowed by default; tests flip it.
jest.mock('../services/collections/contact-policy', () => ({
  evaluate: jest.fn(async () => ({ allowed: true, denialReasons: [] })),
  isSupervisedApprover: jest.fn((a) => typeof a === 'string' && a.startsWith('admin:')),
}));
jest.mock('../services/collections/outbound-voice/outcomes', () => ({
  writeCallOutcome: jest.fn(async () => ({ ok: true })),
}));
jest.mock('../services/collections/outbound-voice/flags', () => ({
  revokeAutomatedVoiceConsent: jest.fn(async () => ({ ok: true, created: true })),
}));
jest.mock('../services/collections/outbound-voice/staffed-hours', () => ({
  isStaffedHours: jest.fn(() => true),
}));
jest.mock('../services/notification-service', () => ({
  notifyAdmin: jest.fn(async () => ({ id: 'n1' })),
}));

const db = require('../models/db');
const { voicemailPermitted, stampVoicemailLeft } = require('../services/collections/outbound-voice/voicemail');
const { writeCallOutcome } = require('../services/collections/outbound-voice/outcomes');
const flags = require('../services/collections/outbound-voice/flags');
const { isStaffedHours } = require('../services/collections/outbound-voice/staffed-hours');
const NotificationService = require('../services/notification-service');
const script = require('../services/collections/outbound-voice/script');
const router = require('../routes/collections-voice-webhook');

function handlerFor(path) {
  const layer = router.stack.find((l) => l.route && l.route.path === path);
  if (!layer) throw new Error(`no route ${path}`);
  return layer.route.stack[0].handle;
}

function mockRes() {
  const res = {};
  res.type = jest.fn(() => res);
  res.send = jest.fn((body) => { res.body = body; return res; });
  res.status = jest.fn(() => res);
  return res;
}

const CALL_ROW = {
  id: 'cl-1',
  direction: 'outbound',
  source: 'collections_voice',
  twilio_call_sid: 'CA1',
  customer_id: 'cust-1',
  // Origination stamps supervision on every row it writes (codex #3560);
  // legacy stamp-less rows are pinned explicitly below.
  metadata: JSON.stringify({ collectionCaseId: 'case-1', caseVersion: 3, ledgerId: 'ledger-1', collectionsSupervised: false }),
};
const LEGACY_META = JSON.stringify({ collectionCaseId: 'case-1', caseVersion: 3, ledgerId: 'ledger-1' });
const CUSTOMER = { id: 'cust-1', first_name: 'Pat' };

function chain({ first } = {}) {
  const q = {};
  ['where', 'whereNull', 'whereRaw', 'orderBy', 'select'].forEach((m) => { q[m] = jest.fn(() => q); });
  q.first = jest.fn(async () => first);
  q.update = jest.fn(async () => 1);
  q.catch = () => Promise.resolve();
  return q;
}

const LINKED_CASE = { id: 'case-1', customer_id: 'cust-1' };

function setDb({ callRow = CALL_ROW, customer = CUSTOMER, extraCallRows = [] } = {}) {
  const queues = {
    call_log: [chain({ first: callRow }), ...extraCallRows.map((r) => chain({ first: r })), chain(), chain(), chain()],
    // loadCollectionsCall verifies the linked case exists + matches (prb-r7).
    collection_cases: [chain({ first: LINKED_CASE }), chain({ first: LINKED_CASE }), chain({ first: LINKED_CASE })],
    customers: [chain({ first: customer })],
  };
  db.mockImplementation((table) => {
    const queue = queues[table];
    if (!queue || !queue.length) return chain();
    return queue.shift();
  });
}

function req({ query = {}, body = {} } = {}) {
  return { query: { callLogId: 'cl-1', ...query }, body: { CallSid: 'CA1', ...body } };
}

beforeEach(() => {
  jest.clearAllMocks();
  // The status route wraps its writes in one transaction (prb-r3): serve a
  // trx that dispatches through the same table-queue mock.
  db.transaction = jest.fn(async (fn) => {
    const trx = (t) => db(t);
    trx.fn = db.fn;
    trx.raw = db.raw;
    return fn(trx);
  });
  voicemailPermitted.mockResolvedValue(true);
  stampVoicemailLeft.mockResolvedValue(true);
  require('../services/collections/contact-policy').evaluate
    .mockResolvedValue({ allowed: true, denialReasons: [] });
  writeCallOutcome.mockResolvedValue({ ok: true });
  flags.revokeAutomatedVoiceConsent.mockResolvedValue({ ok: true, created: true });
  isStaffedHours.mockReturnValue(true);
  process.env.GATE_VOICE_LATE_PAYMENT = 'true';
  process.env.VOICE_RELAY_WS_SECRET = 'test-secret';
  process.env.SERVER_DOMAIN = 'portal.example.com';
  setDb();
});

afterAll(() => {
  delete process.env.GATE_VOICE_LATE_PAYMENT;
  delete process.env.VOICE_RELAY_WS_SECRET;
  delete process.env.SERVER_DOMAIN;
});

const PATHS = [
  '/collections-vestibule',
  '/collections-vestibule-key',
  '/collections-vestibule-noinput',
  '/collections-relay-complete',
  '/collections-transfer-complete',
];

test('every route: gate off ⇒ bare hangup, ZERO db touches', async () => {
  process.env.GATE_VOICE_LATE_PAYMENT = 'false';
  for (const path of PATHS) {
    const res = mockRes();
    await handlerFor(path)(req(), res);
    expect(res.body).toContain('<Hangup/>');
    expect(res.body).not.toContain('Gather');
    expect(res.body).not.toContain('ConversationRelay');
  }
  expect(db).not.toHaveBeenCalled();
  expect(writeCallOutcome).not.toHaveBeenCalled();
});

test('linkage mismatch (foreign CallSid) ⇒ hangup', async () => {
  setDb({ callRow: { ...CALL_ROW, twilio_call_sid: 'CA-OTHER' } });
  const res = mockRes();
  await handlerFor('/collections-vestibule')(req(), res);
  expect(res.body).toContain('<Hangup/>');
  expect(res.body).not.toContain('Gather');
});

test('non-collections call_log source ⇒ hangup', async () => {
  setDb({ callRow: { ...CALL_ROW, source: 'admin-click' } });
  const res = mockRes();
  await handlerFor('/collections-vestibule')(req(), res);
  expect(res.body).toContain('<Hangup/>');
});

test('human answer ⇒ DTMF-only gather with the fixed script, no relay, no recording', async () => {
  const res = mockRes();
  await handlerFor('/collections-vestibule')(req({ body: { AnsweredBy: 'human' } }), res);
  expect(res.body).toContain('<Gather');
  expect(res.body).toContain('input="dtmf"');
  expect(res.body).toContain('press 1');
  expect(res.body).toContain('press 9');
  expect(res.body).toContain('press 0');
  expect(res.body).not.toContain('ConversationRelay');
  expect(res.body).not.toContain('<Record');
  // No-input falls to the generic-callback-voicemail route.
  expect(res.body).toContain('collections-vestibule-noinput');
});

test('machine_end_beep ⇒ generic callback voicemail + ledger stamp + outcome', async () => {
  const res = mockRes();
  await handlerFor('/collections-vestibule')(req({ body: { AnsweredBy: 'machine_end_beep' } }), res);
  expect(res.body).toContain(script.genericCallbackVoicemail().slice(0, 40));
  expect(res.body).not.toMatch(/balance|invoice/i); // zero debt mention
  // prb-r9: the stamp carries the customer key — the reservation serializes
  // by customer, and without the key the voicemail module fails closed.
  expect(stampVoicemailLeft).toHaveBeenCalledWith('ledger-1', expect.objectContaining({ customerId: 'cust-1' }));
  expect(writeCallOutcome).toHaveBeenCalledWith('cl-1', expect.objectContaining({ outcome: 'voicemail_left' }));
});

test('machine but 30d cap reached ⇒ silent hangup, no voicemail', async () => {
  voicemailPermitted.mockResolvedValue(false);
  const res = mockRes();
  await handlerFor('/collections-vestibule')(req({ body: { AnsweredBy: 'machine_end_silence' } }), res);
  expect(res.body).not.toContain('<Say>');
  expect(res.body).toContain('<Hangup/>');
  expect(stampVoicemailLeft).not.toHaveBeenCalled();
  expect(writeCallOutcome).toHaveBeenCalledWith('cl-1', expect.objectContaining({ outcome: 'machine_no_voicemail' }));
});

test('uncertain AMD (unknown) ⇒ NO voicemail, quiet hangup', async () => {
  const res = mockRes();
  await handlerFor('/collections-vestibule')(req({ body: { AnsweredBy: 'unknown' } }), res);
  expect(res.body).not.toContain('<Say>');
  expect(res.body).toContain('<Hangup/>');
  expect(voicemailPermitted).not.toHaveBeenCalled();
});

test('press 1 ⇒ ConversationRelay with session_mode=collections + collections action', async () => {
  const res = mockRes();
  await handlerFor('/collections-vestibule-key')(req({ body: { Digits: '1' } }), res);
  expect(res.body).toContain('<ConversationRelay');
  expect(res.body).toContain('<Parameter name="session_mode" value="collections" />');
  expect(res.body).toContain('collections-relay-complete');
  expect(res.body).toContain('wss://portal.example.com/ws/voice-agent');
  expect(res.body).toContain('callSid=CA1');
  expect(res.body).toContain('t=v1.'); // per-call minted token, never the secret
  expect(res.body).not.toContain('test-secret');
  // The relay greeting is the right-party question, no balance words.
  expect(res.body).toContain('am I speaking with Pat');
  expect(res.body).not.toMatch(/balance|invoice/i);
});

test('press 9 ⇒ durable flag first, then the fixed confirmation + outcome', async () => {
  const res = mockRes();
  await handlerFor('/collections-vestibule-key')(req({ body: { Digits: '9' } }), res);
  expect(flags.revokeAutomatedVoiceConsent).toHaveBeenCalledWith('cust-1', expect.anything());
  expect(res.body).toContain('We will stop automated calls');
  expect(writeCallOutcome).toHaveBeenCalledWith('cl-1', expect.objectContaining({
    outcome: 'vestibule_declined',
    captures: expect.objectContaining({ consentRevoked: true }),
  }));
});

test('press 9 with a FAILED flag write never claims it is done', async () => {
  flags.revokeAutomatedVoiceConsent.mockResolvedValue({ ok: false, reason: 'write_failed' });
  const res = mockRes();
  await handlerFor('/collections-vestibule-key')(req({ body: { Digits: '9' } }), res);
  expect(res.body).not.toContain('We will stop automated calls');
  expect(res.body).toContain('team will make sure');
  expect(writeCallOutcome).toHaveBeenCalledWith('cl-1', expect.objectContaining({
    captures: expect.objectContaining({ consentRevoked: false }),
  }));
});

test('press 0 staffed hours ⇒ warm transfer <Dial> to the admin bridge phone', async () => {
  const res = mockRes();
  await handlerFor('/collections-vestibule-key')(req({ body: { Digits: '0' } }), res);
  expect(res.body).toContain('<Dial');
  expect(res.body).toContain('+19415993489');
  expect(res.body).toContain('collections-transfer-complete');
  expect(writeCallOutcome).toHaveBeenCalledWith('cl-1', expect.objectContaining({ outcome: 'vestibule_office' }));
});

// codex #3560 P2: supervision rides the IMMUTABLE call_log stamp, never the
// case's mutable approved_by (cleared at outcome time) — a Twilio retry of
// the same webhook must classify the call exactly as the first attempt.
test('supervision for staffed-hours + revalidation comes from call_log metadata, not the case', async () => {
  const ContactPolicy = require('../services/collections/contact-policy');
  setDb({ callRow: { ...CALL_ROW, metadata: JSON.stringify({ collectionCaseId: 'case-1', caseVersion: 3, ledgerId: 'ledger-1', collectionsSupervised: true }) } });
  const res = mockRes();
  await handlerFor('/collections-vestibule-key')(req({ body: { Digits: '0' } }), res);
  expect(isStaffedHours).toHaveBeenCalledWith(expect.any(Date), { supervised: true });
  expect(ContactPolicy.isSupervisedApprover).not.toHaveBeenCalled();
});

test('a legacy stamp-less call row is UNSUPERVISED even when the case carries an admin approver — no inference from mutable case state', async () => {
  const ContactPolicy = require('../services/collections/contact-policy');
  const dbm = require('../models/db');
  setDb({ callRow: { ...CALL_ROW, metadata: LEGACY_META } });
  const orig = dbm.getMockImplementation();
  const cases = [chain({ first: { ...LINKED_CASE, approved_by: 'admin:adam@wavespestcontrol.com' } })];
  dbm.mockImplementation((table) => (table === 'collection_cases' ? (cases.shift() || chain({ first: LINKED_CASE })) : orig(table)));
  const res = mockRes();
  await handlerFor('/collections-vestibule-key')(req({ body: { Digits: '0' } }), res);
  expect(isStaffedHours).toHaveBeenCalledWith(expect.any(Date), { supervised: false });
  expect(ContactPolicy.isSupervisedApprover).not.toHaveBeenCalled();
});

test('press 0 after hours ⇒ callback card + fixed promise, no dial', async () => {
  isStaffedHours.mockReturnValue(false);
  const res = mockRes();
  await handlerFor('/collections-vestibule-key')(req({ body: { Digits: '0' } }), res);
  expect(res.body).not.toContain('<Dial');
  expect(res.body).toContain('call back');
  expect(NotificationService.notifyAdmin).toHaveBeenCalledWith(
    'billing', expect.stringContaining('Callback'), expect.any(String), expect.anything(),
  );
});

test('no-input route ⇒ generic callback voicemail path with the cap', async () => {
  const res = mockRes();
  await handlerFor('/collections-vestibule-noinput')(req(), res);
  expect(res.body).toContain(script.genericCallbackVoicemail().slice(0, 40));
  expect(writeCallOutcome).toHaveBeenCalledWith('cl-1', expect.objectContaining({ outcome: 'vestibule_no_input' }));
});

test('relay-complete: transfer handoff ⇒ <Dial>; failure ⇒ relay_failed outcome + hangup', async () => {
  let res = mockRes();
  await handlerFor('/collections-relay-complete')(
    req({ body: { HandoffData: JSON.stringify({ next: 'transfer' }) } }), res,
  );
  expect(res.body).toContain('<Dial');

  setDb();
  res = mockRes();
  await handlerFor('/collections-relay-complete')(req({ body: { ErrorCode: '64105' } }), res);
  expect(res.body).toContain('<Hangup/>');
  expect(res.body).not.toContain('<Record'); // never the inbound voicemail flow
  expect(writeCallOutcome).toHaveBeenCalledWith('cl-1', expect.objectContaining({ outcome: 'relay_failed' }));
});

test('transfer-complete: office no-answer ⇒ callback card + fixed promise', async () => {
  const res = mockRes();
  await handlerFor('/collections-transfer-complete')(req({ body: { DialCallStatus: 'no-answer' } }), res);
  expect(NotificationService.notifyAdmin).toHaveBeenCalled();
  expect(res.body).toContain('call back');
});

test('language rules: no fixed copy ever says collections/debt/delinquent; the voicemail is never a "limited-content message"', () => {
  const copy = [
    script.vestibuleScript({ firstName: 'Pat' }),
    script.CONSENT_REVOKED_CONFIRMATION,
    script.callbackPromise(),
    script.TRANSFER_ANNOUNCEMENT,
    script.genericCallbackVoicemail(),
    script.relayGreeting({ firstName: 'Pat' }),
    script.WRONG_PARTY_CLOSE,
    script.verificationFailedClose(),
    script.SECURITY_INTERRUPT,
    script.RELAY_FAILURE_CLOSE,
  ].join(' ');
  expect(copy).not.toMatch(/collections|debt|delinquen/i);
  expect(copy).not.toMatch(/limited.content/i);
  expect(copy).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u); // no emojis
  // The generic callback voicemail carries name + callback number and ZERO
  // balance mention.
  expect(script.genericCallbackVoicemail()).toContain('Waves Pest Control');
  expect(script.genericCallbackVoicemail()).toContain('(941) 297-5749');
  expect(script.genericCallbackVoicemail()).not.toMatch(/balance|invoice|owe|payment/i);
});

// gh prb-r2 pins: unanswered-status reconciliation, stamp-before-speak,
// missed-transfer copy.
describe('prb-r2', () => {
  test('collections-call-status: an unanswered dial resets the case, records missed, stamps the ledger', async () => {
    const caseChain = chain();
    const ledgerChain = chain();
    const callChain = chain({ first: CALL_ROW });
    const callUpdate = chain();
    const queues = {
      call_log: [callChain, callUpdate],
      customers: [chain({ first: CUSTOMER })],
      collection_cases: [chain({ first: LINKED_CASE }), caseChain],
      collections_contact_ledger: [ledgerChain],
    };
    db.mockImplementation((t) => (queues[t] && queues[t].length ? queues[t].shift() : chain()));
    const res = mockRes();
    res.sendStatus = jest.fn(() => res);
    await handlerFor('/collections-call-status')(req({ body: { CallStatus: 'no-answer' } }), res);
    expect(res.sendStatus).toHaveBeenCalledWith(204);
    expect(callUpdate.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'no-answer', call_outcome: 'missed' }));
    // Back to the review queue, approval cleared, guarded on 'dialing'.
    expect(caseChain.where).toHaveBeenCalledWith({ id: 'case-1', current_state: 'dialing', case_version: 3 });
    expect(caseChain.update).toHaveBeenCalledWith(expect.objectContaining({ current_state: 'proposed', hold_reason: 'dial_no-answer' }));
    // Ledger stamped via jsonb MERGE, never a wholesale metadata replace.
    expect(ledgerChain.update).toHaveBeenCalled();
  });

  // prb-r11: a failed reconciliation must be RETRYABLE — 204 would ack the
  // webhook with nothing persisted and strand the case in 'dialing'.
  test('collections-call-status: a failed reconciliation transaction returns 500 so Twilio retries', async () => {
    setDb();
    db.transaction = jest.fn(async () => { throw new Error('pg outage'); });
    const res = mockRes();
    res.sendStatus = jest.fn(() => res);
    await handlerFor('/collections-call-status')(req({ body: { CallStatus: 'no-answer' } }), res);
    expect(res.sendStatus).toHaveBeenCalledWith(500);
  });

  test('collections-call-status: an answered (completed) call is a no-op — the vestibule owns it', async () => {
    setDb();
    const res = mockRes();
    res.sendStatus = jest.fn(() => res);
    await handlerFor('/collections-call-status')(req({ body: { CallStatus: 'completed' } }), res);
    expect(res.sendStatus).toHaveBeenCalledWith(204);
  });

  test('voicemail speaks ONLY after the cap stamp persists — a failed stamp means silence', async () => {
    setDb();
    stampVoicemailLeft.mockResolvedValue(false);
    const res = mockRes();
    await handlerFor('/collections-vestibule-noinput')(req(), res);
    expect(res.body).not.toContain(script.genericCallbackVoicemail());
    expect(writeCallOutcome).toHaveBeenCalledWith('cl-1', expect.objectContaining({ outcome: 'machine_no_voicemail' }));
  });

  test('a missed transfer during STAFFED hours never announces a closure', async () => {
    setDb();
    const res = mockRes();
    await handlerFor('/collections-transfer-complete')(req({ body: { DialCallStatus: 'no-answer' } }), res);
    expect(res.body).toContain('not able to reach our office');
    expect(res.body).not.toContain('closed right now');
  });
});

// prb-r3 pins.
describe('prb-r3', () => {
  test('the status route is master-gated like every sibling: gate off = no reads, no writes', async () => {
    process.env.GATE_VOICE_LATE_PAYMENT = 'false';
    const res = mockRes();
    res.sendStatus = jest.fn(() => res);
    db.mockImplementation(() => { throw new Error('no reads with the gate off'); });
    await handlerFor('/collections-call-status')(req({ body: { CallStatus: 'no-answer' } }), res);
    expect(res.sendStatus).toHaveBeenCalledWith(204);
  });

  test('a failed callback card means the closing copy gives the number WITHOUT the promise', async () => {
    setDb();
    NotificationService.notifyAdmin.mockResolvedValue(null);
    const res = mockRes();
    await handlerFor('/collections-transfer-complete')(req({ body: { DialCallStatus: 'busy' } }), res);
    expect(res.body).toContain('the team will help right away');
    expect(res.body).not.toContain('give you a call back');
  });
});

// prb-r4: answered rows finalize; press-9 failure files the fallback card.
describe('prb-r4', () => {
  test('a completed call finalizes call_log status+duration and touches nothing else', async () => {
    const callUpdate = chain();
    const queues = {
      call_log: [chain({ first: CALL_ROW }), callUpdate],
      collection_cases: [chain({ first: LINKED_CASE })],
      customers: [chain({ first: CUSTOMER })],
    };
    db.mockImplementation((t) => (queues[t] && queues[t].length ? queues[t].shift() : chain()));
    const res = mockRes();
    res.sendStatus = jest.fn(() => res);
    await handlerFor('/collections-call-status')(req({ body: { CallStatus: 'completed', CallDuration: '95' } }), res);
    expect(callUpdate.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed', duration_seconds: 95 }));
    expect(callUpdate.update).toHaveBeenCalledWith(expect.not.objectContaining({ call_outcome: expect.anything() }));
  });

  test('press-9 flag-write failure files the fallback card; card failure drops the promise', async () => {
    setDb();
    flags.revokeAutomatedVoiceConsent.mockResolvedValue({ ok: false });
    NotificationService.notifyAdmin.mockResolvedValue({ id: 'n9' });
    let res = mockRes();
    await handlerFor('/collections-vestibule-key')(req({ body: { Digits: '9' } }), res);
    expect(NotificationService.notifyAdmin).toHaveBeenCalledWith('billing', 'Opt-out needs manual action', expect.anything(), expect.anything());
    expect(res.body).toContain('team will make sure');

    setDb();
    NotificationService.notifyAdmin.mockResolvedValue(null);
    res = mockRes();
    await handlerFor('/collections-vestibule-key')(req({ body: { Digits: '9' } }), res);
    expect(res.body).not.toContain('team will make sure');
    expect(res.body).toContain('the team will help right away');
  });
});

// prb-r7 pins.
describe('prb-r7', () => {
  test('ABSENT AnsweredBy is uncertain: silent hangup, no gather, no voicemail', async () => {
    setDb();
    const res = mockRes();
    await handlerFor('/collections-vestibule')(req({ body: {} }), res);
    expect(res.body).not.toContain('<Gather');
    expect(res.body).not.toContain('<Say');
    expect(writeCallOutcome).toHaveBeenCalledWith('cl-1', expect.objectContaining({ outcome: 'machine_no_voicemail' }));
  });

  test('a dangling or foreign collection case fails the webhook closed', async () => {
    const queues = {
      call_log: [chain({ first: CALL_ROW })],
      collection_cases: [chain({ first: { id: 'case-1', customer_id: 'SOMEONE-ELSE' } })],
      customers: [chain({ first: CUSTOMER })],
    };
    db.mockImplementation((t) => (queues[t] && queues[t].length ? queues[t].shift() : chain()));
    const res = mockRes();
    await handlerFor('/collections-vestibule')(req({ body: { AnsweredBy: 'human' } }), res);
    expect(res.body).toContain('<Hangup/>');
    expect(res.body).not.toContain('<Gather');
  });
});

// prb-r12 pins.
describe('prb-r12', () => {
  const ContactPolicy = require('../services/collections/contact-policy');

  test('answer-time policy denial ⇒ silent hangup, suppressed_at_answer outcome, own case excluded from the read', async () => {
    setDb();
    ContactPolicy.evaluate.mockResolvedValue({ allowed: false, denialReasons: ['suppression_manual_dnc'] });
    const res = mockRes();
    await handlerFor('/collections-vestibule')(req({ body: { AnsweredBy: 'human' } }), res);
    expect(res.body).not.toContain('<Gather');
    expect(res.body).not.toContain('<Say>');
    expect(res.body).toContain('<Hangup/>');
    expect(writeCallOutcome).toHaveBeenCalledWith('cl-1', expect.objectContaining({ outcome: 'suppressed_at_answer' }));
    expect(ContactPolicy.evaluate).toHaveBeenCalledWith('cust-1', expect.objectContaining({
      channel: 'voice', purpose: 'late_payment', excludeCollectionCaseId: 'case-1',
    }));
  });

  test('an answer-time policy READ failure fails closed (hangup, no vestibule)', async () => {
    setDb();
    ContactPolicy.evaluate.mockRejectedValue(new Error('policy db down'));
    const res = mockRes();
    await handlerFor('/collections-vestibule')(req({ body: { AnsweredBy: 'human' } }), res);
    expect(res.body).not.toContain('<Gather');
    expect(res.body).toContain('<Hangup/>');
    expect(writeCallOutcome).toHaveBeenCalledWith('cl-1', expect.objectContaining({ outcome: 'suppressed_at_answer' }));
  });

  test('a replay never re-runs the answer-time policy (mid-call re-gather stays put)', async () => {
    setDb();
    const res = mockRes();
    await handlerFor('/collections-vestibule')(req({ query: { replay: '1' }, body: { AnsweredBy: '' } }), res);
    expect(ContactPolicy.evaluate).not.toHaveBeenCalled();
    expect(res.body).toContain('<Gather');
  });

  test('terminal outcome writes RETRY a resolved {ok:false} and log loudly on a double failure', async () => {
    setDb();
    const logger = require('../services/logger');
    writeCallOutcome.mockResolvedValue({ ok: false });
    const res = mockRes();
    await handlerFor('/collections-vestibule')(req({ body: { AnsweredBy: 'unknown' } }), res);
    // machine_no_voicemail branch: one write + one retry, then the loud log.
    const machineWrites = writeCallOutcome.mock.calls.filter((c) => c[1]?.outcome === 'machine_no_voicemail');
    expect(machineWrites).toHaveLength(2);
    expect(logger.error.mock.calls.flat().join(' ')).toContain('OUTCOME WRITE FAILED TWICE');
  });
});

// prb-r13: a completed call with NO terminal outcome is reconciled by the
// status callback — the last signal Twilio sends — via a FENCED write.
describe('prb-r13', () => {
  test('completed + call_outcome NULL ⇒ fenced completed_no_outcome reconciliation', async () => {
    setDb();
    const res = mockRes();
    res.sendStatus = jest.fn(() => res);
    await handlerFor('/collections-call-status')(req({ body: { CallStatus: 'completed' } }), res);
    expect(res.sendStatus).toHaveBeenCalledWith(204);
    expect(writeCallOutcome).toHaveBeenCalledWith('cl-1', expect.objectContaining({
      outcome: 'completed_no_outcome',
      onlyIfNoOutcome: true,
    }));
  });

  test('completed with a landed outcome is left alone', async () => {
    setDb({ callRow: { ...CALL_ROW, call_outcome: 'conversation_completed' } });
    const res = mockRes();
    res.sendStatus = jest.fn(() => res);
    await handlerFor('/collections-call-status')(req({ body: { CallStatus: 'completed' } }), res);
    expect(writeCallOutcome).not.toHaveBeenCalled();
  });
});

// prb-r14: the completed reconciliation is Twilio's LAST signal — an
// unpersisted write must return retryable, never a swallowing 204.
test('completed reconciliation that fails twice returns 500 so Twilio retries', async () => {
  setDb();
  writeCallOutcome.mockResolvedValue({ ok: false });
  const res = mockRes();
  res.sendStatus = jest.fn(() => res);
  await handlerFor('/collections-call-status')(req({ body: { CallStatus: 'completed' } }), res);
  expect(res.sendStatus).toHaveBeenCalledWith(500);
});

// prb-r15: the completed status/duration stamp is not best-effort — a
// failed write returns 500 so Twilio retries the acknowledged-only-once
// callback.
test('a failed completed status stamp returns 500 (retryable), never a swallowing 204', async () => {
  const failing = chain();
  failing.update = jest.fn(() => { throw new Error('pg blip'); });
  const queues = {
    call_log: [chain({ first: CALL_ROW }), failing],
    collection_cases: [chain({ first: LINKED_CASE })],
    customers: [chain({ first: CUSTOMER })],
  };
  db.mockImplementation((t) => (queues[t] && queues[t].length ? queues[t].shift() : chain()));
  const res = mockRes();
  res.sendStatus = jest.fn(() => res);
  await handlerFor('/collections-call-status')(req({ body: { CallStatus: 'completed' } }), res);
  expect(res.sendStatus).toHaveBeenCalledWith(500);
});

// prb-r16: a suppression landing while the vestibule played must stop the
// relay AT press-1 — the last gate before any account session exists.
test('press-1 with a newly active suppression hangs up before any ConversationRelay', async () => {
  setDb();
  require('../services/collections/contact-policy').evaluate
    .mockResolvedValue({ allowed: false, denialReasons: ['suppression_manual_dnc'] });
  const res = mockRes();
  await handlerFor('/collections-vestibule-key')(req({ body: { Digits: '1' } }), res);
  expect(res.body).not.toContain('ConversationRelay');
  expect(res.body).toContain('<Hangup/>');
  expect(writeCallOutcome).toHaveBeenCalledWith('cl-1', expect.objectContaining({ outcome: 'suppressed_at_answer' }));
});

// prb-r17: unanswered dials finalize their ledger row NON-LIVE — an
// outcome-less voice row reads as an in-flight live conversation to the
// sms/email policy and would silence texts for a week.
test('an unanswered dial finalizes the ledger row with a non-live outcome', async () => {
  const ledgerChain = chain();
  const queues = {
    call_log: [chain({ first: CALL_ROW }), chain()],
    collection_cases: [chain({ first: LINKED_CASE }), chain()],
    customers: [chain({ first: CUSTOMER })],
    collections_contact_ledger: [ledgerChain],
  };
  db.mockImplementation((t) => (queues[t] && queues[t].length ? queues[t].shift() : chain()));
  const res = mockRes();
  res.sendStatus = jest.fn(() => res);
  await handlerFor('/collections-call-status')(req({ body: { CallStatus: 'no-answer' } }), res);
  const payload = JSON.parse(ledgerChain.update.mock.calls[0][0].metadata.bindings[0]);
  expect(payload).toMatchObject({ send_failed: true, outcome: 'missed', live_conversation: false });
});

// prb-r18: a Twilio replay of the machine callback (row already stamped)
// must never overwrite the real voicemail_left outcome.
test('a replayed machine callback with the cap already stamped writes the fallback FENCED', async () => {
  setDb();
  stampVoicemailLeft.mockResolvedValue(false); // this row already carries the stamp
  const res = mockRes();
  await handlerFor('/collections-vestibule')(req({ body: { AnsweredBy: 'machine_end_beep' } }), res);
  expect(writeCallOutcome).toHaveBeenCalledWith('cl-1', expect.objectContaining({
    outcome: 'machine_no_voicemail',
    onlyIfNoOutcome: true,
  }));
});

// prb-r19: one missed-transfer card per call — a Twilio replay keeps the
// promise on the already-filed card instead of filing a duplicate.
test('a replayed transfer-complete files NO duplicate card but keeps the promise', async () => {
  const replayRow = {
    ...CALL_ROW,
    metadata: JSON.stringify({ collectionCaseId: 'case-1', caseVersion: 3, ledgerId: 'ledger-1', collectionsSupervised: false, transfer_miss_card_at: '2026-08-15T18:00:00Z' }),
  };
  const claimChain = chain();
  claimChain.update = jest.fn(async () => 0); // claim already taken
  const queues = {
    call_log: [chain({ first: replayRow }), claimChain],
    collection_cases: [chain({ first: LINKED_CASE })],
    customers: [chain({ first: CUSTOMER })],
  };
  db.mockImplementation((t) => (queues[t] && queues[t].length ? queues[t].shift() : chain()));
  const res = mockRes();
  await handlerFor('/collections-transfer-complete')(req({ body: { DialCallStatus: 'no-answer' } }), res);
  expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  expect(res.body).toContain('not able to reach our office'); // promise preserved
});

// prb-r19: notifyAdmin's suppressed sentinel {id:null} never earns the promise.
test('a bell-suppressed press-0 card yields the number-only copy', async () => {
  setDb();
  isStaffedHours.mockReturnValue(false);
  NotificationService.notifyAdmin.mockResolvedValue({ id: null, suppressed: true });
  const res = mockRes();
  await handlerFor('/collections-vestibule-key')(req({ body: { Digits: '0' } }), res);
  expect(res.body).toContain('the team will help right away');
  expect(res.body).not.toContain('give you a call back');
});
