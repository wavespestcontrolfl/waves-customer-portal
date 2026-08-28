/**
 * collections/outbound-voice/origination.js — pins:
 *  - dark by default: GATE_VOICE_LATE_PAYMENT off ⇒ NO db read, NO Twilio
 *    touch, NO ledger row (zero sends with gates off);
 *  - the twilioVoice feature gate is consulted (existing mechanism);
 *  - full pre-dial revalidation: any policy denial ⇒ case CANCELLED, never
 *    dialed; balance/invoice-set drift vs the approved snapshot ⇒ same;
 *  - approval expiry (24h window) ⇒ case 'expired', no dial;
 *  - RECORD-THEN-DIAL ordering: ledger row → call_log insert → calls.create,
 *    asserted by invocation order; a ledger insert failure aborts the dial;
 *  - idempotency: a prior call_log row under the case's idempotency key
 *    refuses to dial again;
 *  - calls.create failure stamps send_failed and returns the case to the
 *    review queue ('proposed', approval cleared).
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
// The relay leg must be live before anything dials (prb-r5) — attached in
// these tests; the refusal has its own pin.
jest.mock('../services/voice-agent/relay-server', () => ({
  isRelayAttached: jest.fn(() => true),
}));
jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.fn = { now: jest.fn(() => 'NOW()') };
  fn.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
  // withCaseLock (gh-r10): the dial claim runs inside db.transaction — the
  // trx dispatches to the same table queues; the advisory-lock raw is a no-op.
  fn.transaction = jest.fn(async (cb) => {
    const trx = (table) => fn(table);
    trx.raw = jest.fn(async () => ({ rows: [] }));
    trx.fn = fn.fn;
    return cb(trx);
  });
  return fn;
});
jest.mock('../services/collections/contact-policy', () => ({
  evaluate: jest.fn(),
  isWithinCallWindow: jest.fn(() => true),
  isSupervisedApprover: jest.fn((a) => typeof a === 'string' && a.startsWith('admin:')),
}));
jest.mock('../services/collections/contact-ledger', () => ({
  recordContact: jest.fn(),
  markSendFailed: jest.fn(async () => true),
}));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => true) }));
const mockCallsCreate = jest.fn();
jest.mock('twilio', () => jest.fn(() => ({ calls: { create: mockCallsCreate } })));
jest.mock('../config', () => ({ twilio: { accountSid: 'ACtest', authToken: 'tok' } }));

const db = require('../models/db');
const ContactPolicy = require('../services/collections/contact-policy');
const ContactLedger = require('../services/collections/contact-ledger');
const { isEnabled } = require('../config/feature-gates');
const { originateCollectionCall } = require('../services/collections/outbound-voice/origination');

const NOW = new Date('2026-08-12T15:00:00Z'); // Wed, 11:00 ET
const CASE = {
  id: 'case-1',
  customer_id: 'cust-1',
  case_version: 3,
  current_state: 'approved',
  approved_at: new Date('2026-08-12T13:00:00Z'),
  approval_expires_at: new Date('2026-08-13T13:00:00Z'),
  eligible_invoice_ids: JSON.stringify(['inv-1']),
  eligible_balance_snapshot: 25800,
  idempotency_key: 'collections:cust-1:3:14',
};
const CUSTOMER = { id: 'cust-1', phone: '9415551234', deleted_at: null };
const ALLOWED_VERDICT = {
  allowed: true,
  denialReasons: [],
  eligibleInvoiceIds: ['inv-1'],
  eligibleBalanceCents: 25800,
};

const calls = [];
function chain(table, { first, returningRows, result } = {}) {
  const q = {};
  ['where', 'whereIn', 'whereNull', 'whereRaw', 'orderBy', 'select'].forEach((m) => {
    q[m] = jest.fn(() => q);
  });
  q.first = jest.fn(async (...args) => {
    calls.push(`${table}.first`);
    return typeof first === 'function' ? first(...args) : first;
  });
  q.insert = jest.fn((row) => { calls.push(`${table}.insert`); q._inserted = row; return q; });
  q.update = jest.fn((patch) => { calls.push(`${table}.update`); q._updated = patch; return q; });
  q.returning = jest.fn(async () => returningRows || [{ id: 'row-1' }]);
  q.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject);
  q.catch = () => Promise.resolve();
  return q;
}

function setDb(queues) {
  const map = new Map(Object.entries(queues));
  db.mockImplementation((table) => {
    const queue = map.get(table);
    if (!queue || !queue.length) throw new Error(`unexpected db table ${table}`);
    return queue.shift();
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  calls.length = 0;
  process.env.GATE_VOICE_LATE_PAYMENT = 'true';
  isEnabled.mockReturnValue(true);
  ContactPolicy.evaluate.mockResolvedValue({ ...ALLOWED_VERDICT });
  ContactLedger.recordContact.mockImplementation(async () => {
    calls.push('ledger.record');
    return { id: 'ledger-1', metadata: {} };
  });
  mockCallsCreate.mockImplementation(async () => {
    calls.push('twilio.create');
    return { sid: 'CA123' };
  });
});

afterAll(() => { delete process.env.GATE_VOICE_LATE_PAYMENT; });

test('gate off ⇒ refused with zero db/Twilio/ledger touches', async () => {
  process.env.GATE_VOICE_LATE_PAYMENT = 'false';
  const res = await originateCollectionCall('case-1', { now: NOW });
  expect(res).toEqual({ dialed: false, reason: 'gated_off' });
  expect(db).not.toHaveBeenCalled();
  expect(mockCallsCreate).not.toHaveBeenCalled();
  expect(ContactLedger.recordContact).not.toHaveBeenCalled();
});

test('twilioVoice feature gate off ⇒ refused before any db read', async () => {
  isEnabled.mockReturnValue(false);
  const res = await originateCollectionCall('case-1', { now: NOW });
  expect(res.reason).toBe('twilio_voice_gate_off');
  expect(db).not.toHaveBeenCalled();
});

test('non-approved case ⇒ refused, no dial', async () => {
  setDb({ collection_cases: [chain('collection_cases', { first: { ...CASE, current_state: 'proposed' } })] });
  const res = await originateCollectionCall('case-1', { now: NOW });
  expect(res.dialed).toBe(false);
  expect(res.reason).toMatch(/case_not_approved/);
  expect(mockCallsCreate).not.toHaveBeenCalled();
});

test('expired approval ⇒ case flipped to expired, no dial', async () => {
  const stateChain = chain('collection_cases', { returningRows: [{ id: 'case-1' }] });
  setDb({
    collection_cases: [
      chain('collection_cases', { first: { ...CASE, approval_expires_at: new Date('2026-08-12T14:00:00Z') } }),
      stateChain,
    ],
  });
  const res = await originateCollectionCall('case-1', { now: NOW });
  expect(res.reason).toBe('approval_expired');
  expect(stateChain._updated.current_state).toBe('expired');
  expect(mockCallsCreate).not.toHaveBeenCalled();
  expect(ContactLedger.recordContact).not.toHaveBeenCalled();
});

test('policy denial at dial time ⇒ case CANCELLED, never dialed', async () => {
  ContactPolicy.evaluate.mockResolvedValue({
    allowed: false,
    denialReasons: ['flag_do_not_call'],
    eligibleInvoiceIds: [],
    eligibleBalanceCents: 0,
  });
  const stateChain = chain('collection_cases', { returningRows: [{ id: 'case-1' }] });
  setDb({
    collection_cases: [chain('collection_cases', { first: { ...CASE } }), stateChain],
    customers: [chain('customers', { first: CUSTOMER })],
  });
  const res = await originateCollectionCall('case-1', { now: NOW });
  expect(res.reason).toBe('policy_denied');
  expect(stateChain._updated.current_state).toBe('cancelled');
  expect(stateChain._updated.hold_reason).toContain('flag_do_not_call');
  expect(mockCallsCreate).not.toHaveBeenCalled();
});

test('balance drift vs approved snapshot ⇒ cancelled, never dialed', async () => {
  ContactPolicy.evaluate.mockResolvedValue({ ...ALLOWED_VERDICT, eligibleBalanceCents: 19900 });
  const stateChain = chain('collection_cases', { returningRows: [{ id: 'case-1' }] });
  setDb({
    collection_cases: [chain('collection_cases', { first: { ...CASE } }), stateChain],
    customers: [chain('customers', { first: CUSTOMER })],
  });
  const res = await originateCollectionCall('case-1', { now: NOW });
  expect(res.reason).toBe('snapshot_changed');
  expect(stateChain._updated.current_state).toBe('cancelled');
  expect(mockCallsCreate).not.toHaveBeenCalled();
});

test('happy path: ledger → call_log insert → calls.create, in that order', async () => {
  const insertChain = chain('call_log', { returningRows: [{ id: 'cl-1' }] });
  const stateChain = chain('collection_cases', { returningRows: [{ id: 'case-1' }] });
  setDb({
    collection_cases: [chain('collection_cases', { first: { ...CASE } }), chain('collection_cases', { result: 1 }), stateChain],
    customers: [chain('customers', { first: CUSTOMER }), chain('customers', { first: CUSTOMER })],
    call_log: [
      chain('call_log', { first: undefined }), // idempotency probe: no prior
      insertChain,
      chain('call_log'), // sid backfill update
    ],
  });
  const res = await originateCollectionCall('case-1', { now: NOW });
  expect(res.dialed).toBe(true);
  expect(res.callSid).toBe('CA123');
  const ledgerIdx = calls.indexOf('ledger.record');
  const insertIdx = calls.indexOf('call_log.insert');
  const dialIdx = calls.indexOf('twilio.create');
  expect(ledgerIdx).toBeGreaterThanOrEqual(0);
  expect(ledgerIdx).toBeLessThan(insertIdx);
  expect(insertIdx).toBeLessThan(dialIdx);
  // The dial points at the vestibule with AMD enabled.
  const args = mockCallsCreate.mock.calls[0][0];
  expect(args.machineDetection).toBe('DetectMessageEnd');
  expect(args.url).toContain('/api/webhooks/twilio/collections-vestibule?');
  expect(args.to).toBe('+19415551234');
  // The atomic claim moved the case to dialing pre-create; no later state
  // write repeats it.
  expect(stateChain._updated).toBeUndefined();
  // call_log row carries the case linkage + idempotency key.
  const meta = JSON.parse(insertChain._inserted.metadata);
  expect(meta.collectionsIdempotencyKey).toBe(CASE.idempotency_key);
  expect(insertChain._inserted.source).toBe('collections_voice');
});

test('idempotency: prior dial under the same key refuses', async () => {
  setDb({
    collection_cases: [chain('collection_cases', { first: { ...CASE } })],
    customers: [chain('customers', { first: CUSTOMER }), chain('customers', { first: CUSTOMER })],
    call_log: [chain('call_log', { first: { id: 'cl-existing' } })],
  });
  const res = await originateCollectionCall('case-1', { now: NOW });
  expect(res.reason).toBe('already_dialed');
  expect(ContactLedger.recordContact).not.toHaveBeenCalled();
  expect(mockCallsCreate).not.toHaveBeenCalled();
});

test('ledger insert failure ⇒ NO dial at all', async () => {
  ContactLedger.recordContact.mockRejectedValue(new Error('insert failed'));
  setDb({
    collection_cases: [chain('collection_cases', { first: { ...CASE } }), chain('collection_cases', { result: 1 }), chain('collection_cases', { result: 1 })],
    customers: [chain('customers', { first: CUSTOMER }), chain('customers', { first: CUSTOMER })],
    call_log: [chain('call_log', { first: undefined })],
  });
  await expect(originateCollectionCall('case-1', { now: NOW })).rejects.toThrow('insert failed');
  expect(mockCallsCreate).not.toHaveBeenCalled();
});

test('calls.create failure ⇒ send_failed stamp + case back to review queue; AMBIGUOUS failure keeps the frequency windows', async () => {
  mockCallsCreate.mockRejectedValue(new Error('twilio down')); // no HTTP status = ambiguous
  const stateChain = chain('collection_cases', { returningRows: [{ id: 'case-1' }] });
  setDb({
    collection_cases: [chain('collection_cases', { first: { ...CASE } }), chain('collection_cases', { result: 1 }), stateChain],
    customers: [chain('customers', { first: CUSTOMER }), chain('customers', { first: CUSTOMER })],
    call_log: [
      chain('call_log', { first: undefined }),
      chain('call_log', { returningRows: [{ id: 'cl-1' }] }),
      chain('call_log'), // status: failed update
    ],
  });
  const res = await originateCollectionCall('case-1', { now: NOW });
  expect(res).toEqual({ dialed: false, reason: 'dial_failed' });
  // prb-r9: a timeout/connection loss can land AFTER Twilio created the
  // call — never stamp never_contacted on it; the row keeps consuming the
  // voice-spacing windows so a re-approval cannot originate a second live
  // call while the first may still be ringing.
  expect(ContactLedger.markSendFailed).toHaveBeenCalledWith(
    expect.objectContaining({ id: 'ledger-1' }),
    expect.objectContaining({ stage: 'calls_create', ambiguous_provider_failure: true }),
  );
  expect(ContactLedger.markSendFailed.mock.calls[0][1]).not.toHaveProperty('never_contacted');
  expect(stateChain._updated.current_state).toBe('proposed');
  expect(stateChain._updated.approval_expires_at).toBeNull();
  // prb-r10: a Twilio rejection message can embed the full destination
  // number — the dial-failure log carries only case id + status/code.
  const logger = require('../services/logger');
  const dialErrLog = logger.error.mock.calls.flat().find((l) => String(l).includes('dial failed'));
  expect(dialErrLog).toContain('status=');
  expect(dialErrLog).not.toContain('twilio down'); // raw err.message never logged
});

// prb-r11: a LOCAL preflight failure (Twilio unconfigured) provably never
// touched the provider — never_contacted, so restoring credentials and
// re-approving can dial without a phantom frequency window.
test('missing Twilio config stamps never_contacted (no provider request ever started)', async () => {
  const config = require('../config');
  const savedSid = config.twilio.accountSid;
  config.twilio.accountSid = null;
  try {
    const stateChain = chain('collection_cases', { returningRows: [{ id: 'case-1' }] });
    setDb({
      collection_cases: [chain('collection_cases', { first: { ...CASE } }), chain('collection_cases', { result: 1 }), stateChain],
      customers: [chain('customers', { first: CUSTOMER }), chain('customers', { first: CUSTOMER })],
      call_log: [
        chain('call_log', { first: undefined }),
        chain('call_log', { returningRows: [{ id: 'cl-1' }] }),
        chain('call_log'),
      ],
    });
    const res = await originateCollectionCall('case-1', { now: NOW });
    expect(res).toEqual({ dialed: false, reason: 'dial_failed' });
    expect(mockCallsCreate).not.toHaveBeenCalled();
    expect(ContactLedger.markSendFailed).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'ledger-1' }),
      expect.objectContaining({ stage: 'calls_create', never_contacted: true }),
    );
  } finally {
    config.twilio.accountSid = savedSid;
  }
});

// prb-r9: never_contacted is reserved for DEFINITIVE pre-send rejections —
// a 4xx proves Twilio refused the request before any call existed.
test('a definitive 4xx rejection from calls.create stamps never_contacted', async () => {
  mockCallsCreate.mockRejectedValue(Object.assign(new Error('invalid to number'), { status: 400 }));
  const stateChain = chain('collection_cases', { returningRows: [{ id: 'case-1' }] });
  setDb({
    collection_cases: [chain('collection_cases', { first: { ...CASE } }), chain('collection_cases', { result: 1 }), stateChain],
    customers: [chain('customers', { first: CUSTOMER }), chain('customers', { first: CUSTOMER })],
    call_log: [
      chain('call_log', { first: undefined }),
      chain('call_log', { returningRows: [{ id: 'cl-1' }] }),
      chain('call_log'),
    ],
  });
  const res = await originateCollectionCall('case-1', { now: NOW });
  expect(res).toEqual({ dialed: false, reason: 'dial_failed' });
  expect(ContactLedger.markSendFailed).toHaveBeenCalledWith(
    expect.objectContaining({ id: 'ledger-1' }),
    expect.objectContaining({ stage: 'calls_create', never_contacted: true }),
  );
});

// prb-r1: the dial boundary is the ATOMIC approved→dialing claim — a
// worker that loses it stands down before any Twilio touch.
test('a lost dial claim stands down: no ledger row, no call_log insert, no calls.create', async () => {
  const claimChain = chain('collection_cases', { result: 0 }); // another worker won
  setDb({
    collection_cases: [chain('collection_cases', { first: { ...CASE } }), claimChain],
    customers: [chain('customers', { first: CUSTOMER }), chain('customers', { first: CUSTOMER })],
    call_log: [chain('call_log', { first: undefined })],
  });
  const res = await originateCollectionCall('case-1', { now: NOW });
  expect(res).toEqual({ dialed: false, reason: 'dial_claim_lost' });
  expect(ContactLedger.recordContact).not.toHaveBeenCalled();
  expect(mockCallsCreate).not.toHaveBeenCalled();
  expect(claimChain._updated).toEqual(expect.objectContaining({ current_state: 'dialing' }));
});

// gh prb-r2: a FAILED dial's row never blocks the human's re-approval.
test('the idempotency probe excludes failed rows (query pin) and a fresh dial proceeds after a failure', async () => {
  const probeChain = chain('call_log', { first: undefined });
  const stateChain = chain('collection_cases', { returningRows: [{ id: 'case-1' }] });
  setDb({
    collection_cases: [chain('collection_cases', { first: { ...CASE } }), chain('collection_cases', { result: 1 }), stateChain],
    customers: [chain('customers', { first: CUSTOMER }), chain('customers', { first: CUSTOMER })],
    call_log: [probeChain, chain('call_log', { returningRows: [{ id: 'cl-2' }] }), chain('call_log')],
  });
  const res = await originateCollectionCall('case-1', { now: NOW });
  expect(res.dialed).toBe(true);
  expect(probeChain.whereRaw).toHaveBeenCalledWith("COALESCE(status, '') NOT IN ('failed', 'busy', 'no-answer', 'canceled')");
});

// prb-r4: a pre-dial persistence failure RELEASES the claim — no Twilio
// call exists, so no callback will ever reconcile it.
test('ledger failure after the claim releases dialing back to approved', async () => {
  ContactLedger.recordContact.mockRejectedValue(new Error('insert failed'));
  const releaseChain = chain('collection_cases', { result: 1 });
  setDb({
    collection_cases: [chain('collection_cases', { first: { ...CASE } }), chain('collection_cases', { result: 1 }), releaseChain],
    customers: [chain('customers', { first: CUSTOMER }), chain('customers', { first: CUSTOMER })],
    call_log: [chain('call_log', { first: undefined })],
  });
  await expect(originateCollectionCall('case-1', { now: NOW })).rejects.toThrow('insert failed');
  expect(releaseChain.where).toHaveBeenCalledWith({ id: 'case-1', current_state: 'dialing', case_version: 3 });
  expect(releaseChain._updated).toEqual(expect.objectContaining({ current_state: 'approved' }));
});


// prb-r5: with the relay unattached, nothing dials — the customer would
// press 1 into a dead socket.
test('relay unavailable refuses before any claim, ledger, or Twilio touch', async () => {
  const { isRelayAttached } = require('../services/voice-agent/relay-server');
  isRelayAttached.mockReturnValueOnce(false);
  setDb({ collection_cases: [chain('collection_cases', { first: { ...CASE } })] });
  const res = await originateCollectionCall('case-1', { now: NOW });
  expect(res).toEqual({ dialed: false, reason: 'relay_unavailable' });
  expect(ContactLedger.recordContact).not.toHaveBeenCalled();
  expect(mockCallsCreate).not.toHaveBeenCalled();
});

// prb-r7: a stated payment date's suppression horizon binds the dial.
test('next_eligible_at in the future refuses the dial', async () => {
  setDb({ collection_cases: [chain('collection_cases', { first: { ...CASE, next_eligible_at: new Date(NOW.getTime() + 3 * 86400000).toISOString() } })] });
  const res = await originateCollectionCall('case-1', { now: NOW });
  expect(res).toEqual({ dialed: false, reason: 'suppressed_until_next_eligible' });
  expect(mockCallsCreate).not.toHaveBeenCalled();
});

// prb-r15 pins.
describe('prb-r15', () => {
  test('a phone edited during the policy evaluation aborts the dial (verdict binds to the number)', async () => {
    const stateChain = chain('collection_cases', { returningRows: [{ id: 'case-1' }] });
    setDb({
      collection_cases: [chain('collection_cases', { first: { ...CASE } }), stateChain],
      customers: [
        chain('customers', { first: CUSTOMER }), // pre-eval snapshot
        chain('customers', { first: { ...CUSTOMER, phone: '9415559999' } }), // changed mid-eval
      ],
    });
    const res = await originateCollectionCall('case-1', { now: NOW });
    expect(res).toEqual({ dialed: false, reason: 'phone_changed' });
    expect(stateChain._updated.hold_reason).toBe('phone_changed_during_evaluation');
    expect(mockCallsCreate).not.toHaveBeenCalled();
    expect(ContactLedger.recordContact).not.toHaveBeenCalled();
  });

  test('the atomic dial claim itself enforces approval expiry', async () => {
    const claimChain = chain('collection_cases', { result: 1 });
    setDb({
      collection_cases: [chain('collection_cases', { first: { ...CASE } }), claimChain, chain('collection_cases', { returningRows: [{ id: 'case-1' }] })],
      customers: [chain('customers', { first: CUSTOMER }), chain('customers', { first: CUSTOMER })],
      call_log: [chain('call_log', { first: undefined }), chain('call_log', { returningRows: [{ id: 'cl-1' }] }), chain('call_log')],
    });
    // gh-r14: the boundary compares against the FRESH claim clock, not the
    // entry snapshot.
    const FRESH = new Date('2026-08-12T15:10:00Z');
    await originateCollectionCall('case-1', { now: NOW, clock: () => FRESH });
    expect(claimChain.where).toHaveBeenCalledWith('approval_expires_at', '>', FRESH);
  });
});

// prb-r18: an unmarkable never_contacted row must not silently strand the
// case behind a phantom frequency window — it stays visibly in 'dialing'.
test('a doubly-failed never_contacted stamp on a definitive rejection keeps the case in dialing', async () => {
  mockCallsCreate.mockRejectedValue(Object.assign(new Error('invalid to'), { status: 400 }));
  ContactLedger.markSendFailed.mockResolvedValue(false);
  const stateChain = chain('collection_cases', { returningRows: [{ id: 'case-1' }] });
  setDb({
    collection_cases: [chain('collection_cases', { first: { ...CASE } }), chain('collection_cases', { result: 1 }), stateChain],
    customers: [chain('customers', { first: CUSTOMER }), chain('customers', { first: CUSTOMER })],
    call_log: [
      chain('call_log', { first: undefined }),
      chain('call_log', { returningRows: [{ id: 'cl-1' }] }),
      chain('call_log'),
    ],
  });
  const res = await originateCollectionCall('case-1', { now: NOW });
  expect(res).toEqual({ dialed: false, reason: 'dial_failed' });
  expect(ContactLedger.markSendFailed).toHaveBeenCalledTimes(2); // one retry
  expect(stateChain.update).not.toHaveBeenCalled(); // never reset to proposed
});

// codex gh-r10: the approved→dialing claim runs under the customer case
// lock — the same advisory lock the merge path takes — so a merge cannot
// repoint the customer while a claim is mid-flight.
test('the dial claim runs inside the customer case lock (db.transaction)', async () => {
  setDb({
    collection_cases: [chain('collection_cases', { first: { ...CASE } }), chain('collection_cases', { result: 1 })],
    customers: [chain('customers', { first: CUSTOMER }), chain('customers', { first: CUSTOMER })],
    call_log: [
      chain('call_log', { first: undefined }), // idempotency probe: no prior
      chain('call_log', { returningRows: [{ id: 'cl-1' }] }),
      chain('call_log'), // sid backfill update
    ],
  });
  const res = await originateCollectionCall('case-1', { now: NOW });
  expect(res.dialed).toBe(true);
  expect(db.transaction).toHaveBeenCalledTimes(1);
});

// codex gh-r11: the in-lock claim fences customer_id — a merge committing
// between the snapshot reads and the lock acquisition repoints the case,
// and the claim must stand down rather than dial with the retired
// customer's policy verdict and phone.
test('the dial claim fences customer_id: a mid-merge repointed case stands down (dial_claim_lost)', async () => {
  const claimChain = chain('collection_cases', { result: 0 }); // fence claims 0 rows
  setDb({
    collection_cases: [chain('collection_cases', { first: { ...CASE } }), claimChain],
    customers: [chain('customers', { first: CUSTOMER }), chain('customers', { first: CUSTOMER })],
    call_log: [chain('call_log', { first: undefined })],
  });
  const res = await originateCollectionCall('case-1', { now: NOW });
  expect(res).toEqual({ dialed: false, reason: 'dial_claim_lost' });
  expect(claimChain.where).toHaveBeenCalledWith(expect.objectContaining({ customer_id: 'cust-1' }));
  expect(mockCallsCreate).not.toHaveBeenCalled();
  expect(ContactLedger.recordContact).not.toHaveBeenCalled();
});

// codex gh-r13 pins.
test('pre-claim state transitions fence customer_id — a mid-merge repointed case is never cancelled from stale snapshots', async () => {
  const stateChain = chain('collection_cases', { returningRows: [] });
  setDb({
    collection_cases: [
      chain('collection_cases', { first: { ...CASE, approval_expires_at: new Date('2026-08-12T14:00:00Z') } }),
      stateChain,
    ],
  });
  const res = await originateCollectionCall('case-1', { now: NOW });
  expect(res.reason).toBe('approval_expired');
  expect(stateChain.where).toHaveBeenCalledWith(expect.objectContaining({ customer_id: 'cust-1' }));
});

test('master gate flipped off during the pre-claim reads ⇒ gated_off, claim never attempted', async () => {
  const caseChain = chain('collection_cases', { first: { ...CASE } });
  const customerChain = chain('customers', {
    first: () => { process.env.GATE_VOICE_LATE_PAYMENT = 'false'; return CUSTOMER; },
  });
  setDb({
    collection_cases: [caseChain], // NO claim chain — a claim would throw 'unexpected'
    customers: [customerChain, chain('customers', { first: CUSTOMER })],
    call_log: [chain('call_log', { first: undefined })],
  });
  const res = await originateCollectionCall('case-1', { now: NOW });
  expect(res).toEqual({ dialed: false, reason: 'gated_off' });
  expect(mockCallsCreate).not.toHaveBeenCalled();
  expect(ContactLedger.recordContact).not.toHaveBeenCalled();
});

test('master gate flipped off after the claim ⇒ never_contacted stamp, call_log canceled, claim released, NO provider touch', async () => {
  const claimChain = chain('collection_cases', { result: 1 });
  const releaseChain = chain('collection_cases', { result: 1 });
  const insertChain = chain('call_log', { returningRows: [{ id: 'cl-1' }] });
  const cancelChain = chain('call_log', { result: 1 });
  // mockResolvedValue(false) from the stamp-retry test survives
  // clearAllMocks — restore the default explicitly (documented trap).
  ContactLedger.markSendFailed.mockResolvedValue(true);
  // The claim succeeds, then the flip lands during the ledger write.
  ContactLedger.recordContact.mockImplementation(async () => {
    process.env.GATE_VOICE_LATE_PAYMENT = 'false';
    calls.push('ledger.record');
    return { id: 'ledger-1', metadata: {} };
  });
  setDb({
    collection_cases: [chain('collection_cases', { first: { ...CASE } }), claimChain, releaseChain],
    customers: [chain('customers', { first: CUSTOMER }), chain('customers', { first: CUSTOMER })],
    call_log: [chain('call_log', { first: undefined }), insertChain, cancelChain],
  });
  const res = await originateCollectionCall('case-1', { now: NOW });
  expect(res).toEqual({ dialed: false, reason: 'gated_off' });
  expect(mockCallsCreate).not.toHaveBeenCalled();
  // The pre-provider row must not consume the frequency windows.
  expect(ContactLedger.markSendFailed).toHaveBeenCalledWith(
    expect.objectContaining({ id: 'ledger-1' }),
    expect.objectContaining({ stage: 'gate_recheck', never_contacted: true }),
  );
  expect(cancelChain._updated.status).toBe('canceled');
  expect(releaseChain._updated.current_state).toBe('approved');
});

// codex gh-r14: time-based authorization re-checked at the claim with a
// FRESH clock — the entry `now` can go stale across the policy evaluation.
test('claim boundary re-checks the call window with a fresh clock — after-hours claim stands down pre-claim', async () => {
  ContactPolicy.isWithinCallWindow.mockReturnValue(false);
  const LATE = new Date('2026-08-12T22:30:00Z'); // 18:30 ET
  setDb({
    collection_cases: [chain('collection_cases', { first: { ...CASE } })], // NO claim chain
    customers: [chain('customers', { first: CUSTOMER }), chain('customers', { first: CUSTOMER })],
    call_log: [chain('call_log', { first: undefined })],
  });
  const res = await originateCollectionCall('case-1', { now: NOW, clock: () => LATE });
  expect(res).toEqual({ dialed: false, reason: 'outside_call_window' });
  expect(ContactPolicy.isWithinCallWindow).toHaveBeenCalledWith(LATE, { supervised: false });
  expect(mockCallsCreate).not.toHaveBeenCalled();
  expect(ContactLedger.recordContact).not.toHaveBeenCalled();
});

// codex P1 on #3555: the owner call-window override reaches only SUPERVISED
// (admin-approved) cases. Supervision is derived from approved_by and threaded
// into BOTH window readers — the policy revalidation and the claim recheck.
describe('supervised vs autodial cases and the call-window override', () => {
  test.each([
    ['admin:adam@wavespestcontrol.com', true],
    ['system:autodial', false],
    [null, false],
  ])('approved_by=%s ⇒ supervisedDial/supervised=%s at both window readers', async (approvedBy, supervised) => {
    ContactPolicy.isWithinCallWindow.mockReturnValue(false); // stop at the claim recheck
    setDb({
      collection_cases: [chain('collection_cases', { first: { ...CASE, approved_by: approvedBy } })],
      customers: [chain('customers', { first: CUSTOMER }), chain('customers', { first: CUSTOMER })],
      call_log: [chain('call_log', { first: undefined })],
    });
    const res = await originateCollectionCall('case-1', { now: NOW, clock: () => NOW });
    expect(res).toEqual({ dialed: false, reason: 'outside_call_window' });
    expect(ContactPolicy.evaluate).toHaveBeenCalledWith('cust-1', expect.objectContaining({ channel: 'voice', supervisedDial: supervised }));
    expect(ContactPolicy.isWithinCallWindow).toHaveBeenCalledWith(NOW, { supervised });
    expect(mockCallsCreate).not.toHaveBeenCalled();
  });
});

test('the claim WHERE compares approval expiry against the fresh clock, not the entry snapshot', async () => {
  ContactPolicy.isWithinCallWindow.mockReturnValue(true);
  const FRESH = new Date('2026-08-12T15:20:00Z');
  const claimChain = chain('collection_cases', { result: 0 });
  setDb({
    collection_cases: [chain('collection_cases', { first: { ...CASE } }), claimChain],
    customers: [chain('customers', { first: CUSTOMER }), chain('customers', { first: CUSTOMER })],
    call_log: [chain('call_log', { first: undefined })],
  });
  const res = await originateCollectionCall('case-1', { now: NOW, clock: () => FRESH });
  expect(res.reason).toBe('dial_claim_lost');
  expect(claimChain.where).toHaveBeenCalledWith('approval_expires_at', '>', FRESH);
});
