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
jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.fn = { now: jest.fn(() => 'NOW()') };
  fn.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
  return fn;
});
jest.mock('../services/collections/contact-policy', () => ({
  evaluate: jest.fn(),
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
  setDb({ collection_cases: [chain('collection_cases', { first: { ...CASE } }), stateChain] });
  const res = await originateCollectionCall('case-1', { now: NOW });
  expect(res.reason).toBe('policy_denied');
  expect(stateChain._updated.current_state).toBe('cancelled');
  expect(stateChain._updated.hold_reason).toContain('flag_do_not_call');
  expect(mockCallsCreate).not.toHaveBeenCalled();
});

test('balance drift vs approved snapshot ⇒ cancelled, never dialed', async () => {
  ContactPolicy.evaluate.mockResolvedValue({ ...ALLOWED_VERDICT, eligibleBalanceCents: 19900 });
  const stateChain = chain('collection_cases', { returningRows: [{ id: 'case-1' }] });
  setDb({ collection_cases: [chain('collection_cases', { first: { ...CASE } }), stateChain] });
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
    customers: [chain('customers', { first: CUSTOMER })],
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
    customers: [chain('customers', { first: CUSTOMER })],
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
    collection_cases: [chain('collection_cases', { first: { ...CASE } }), chain('collection_cases', { result: 1 })],
    customers: [chain('customers', { first: CUSTOMER })],
    call_log: [chain('call_log', { first: undefined })],
  });
  await expect(originateCollectionCall('case-1', { now: NOW })).rejects.toThrow('insert failed');
  expect(mockCallsCreate).not.toHaveBeenCalled();
});

test('calls.create failure ⇒ send_failed stamp + case back to review queue', async () => {
  mockCallsCreate.mockRejectedValue(new Error('twilio down'));
  const stateChain = chain('collection_cases', { returningRows: [{ id: 'case-1' }] });
  setDb({
    collection_cases: [chain('collection_cases', { first: { ...CASE } }), chain('collection_cases', { result: 1 }), stateChain],
    customers: [chain('customers', { first: CUSTOMER })],
    call_log: [
      chain('call_log', { first: undefined }),
      chain('call_log', { returningRows: [{ id: 'cl-1' }] }),
      chain('call_log'), // status: failed update
    ],
  });
  const res = await originateCollectionCall('case-1', { now: NOW });
  expect(res).toEqual({ dialed: false, reason: 'dial_failed' });
  expect(ContactLedger.markSendFailed).toHaveBeenCalledWith(
    expect.objectContaining({ id: 'ledger-1' }),
    expect.objectContaining({ stage: 'calls_create' }),
  );
  expect(stateChain._updated.current_state).toBe('proposed');
  expect(stateChain._updated.approval_expires_at).toBeNull();
});

// prb-r1: the dial boundary is the ATOMIC approved→dialing claim — a
// worker that loses it stands down before any Twilio touch.
test('a lost dial claim stands down: no ledger row, no call_log insert, no calls.create', async () => {
  const claimChain = chain('collection_cases', { result: 0 }); // another worker won
  setDb({
    collection_cases: [chain('collection_cases', { first: { ...CASE } }), claimChain],
    customers: [chain('customers', { first: CUSTOMER })],
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
    customers: [chain('customers', { first: CUSTOMER })],
    call_log: [probeChain, chain('call_log', { returningRows: [{ id: 'cl-2' }] }), chain('call_log')],
  });
  const res = await originateCollectionCall('case-1', { now: NOW });
  expect(res.dialed).toBe(true);
  expect(probeChain.whereRaw).toHaveBeenCalledWith("COALESCE(status, '') <> 'failed'");
});
