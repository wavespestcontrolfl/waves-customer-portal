/**
 * reserveHumanReply / settleHumanReply — the composer's park-before-send
 * lifecycle as one pair for operator surfaces with no suggestion card in
 * hand (the tech portal's own-line text).
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => false), gateEnvTimestamp: jest.fn(() => null) }));
jest.mock('../services/sms-auto-send', () => ({ hasActiveAutoSendClaim: jest.fn(async () => false) }));

const db = require('../models/db');
const { isEnabled } = require('../config/feature-gates');
const { hasActiveAutoSendClaim } = require('../services/sms-auto-send');
const suggest = require('../services/sms-suggest-mode');

function trxWith({ pending = [], parked = [], activeManualReservation = null } = {}) {
  const inserted = [];
  const chains = {};
  const reservationFirst = jest.fn(async () => activeManualReservation);
  const trx = jest.fn((table) => {
    const chain = {};
    for (const m of ['leftJoin', 'where', 'whereRaw', 'whereNot', 'whereIn']) chain[m] = jest.fn(() => chain);
    chain.select = jest.fn(async () => pending);
    chain.first = table === 'sms_log' ? reservationFirst : jest.fn(async () => null);
    chain.update = jest.fn(() => ({ returning: jest.fn(async () => parked) }));
    chain.insert = jest.fn((row) => { inserted.push({ table, row }); return { returning: jest.fn(async () => [{ id: 'resv-1' }]) }; });
    (chains[table] = chains[table] || []).push(chain);
    return chain;
  });
  trx.raw = jest.fn(async () => undefined);
  db.transaction = jest.fn(async (cb) => cb(trx));
  return { trx, inserted, reservationFirst, chains };
}

beforeEach(() => { jest.clearAllMocks(); isEnabled.mockReturnValue(false); });

test('parks the thread and links its decisions even while auto-send is dark', async () => {
  const { trx, inserted } = trxWith({ pending: [{ id: 'd1' }, { id: 'd2' }], parked: [{ id: 'd1' }, { id: 'd2' }] });
  const out = await suggest.reserveHumanReply({ to: '+19415550100', customerId: 'c1', fromNumber: '+19413529161', body: 'hi', adminUserId: 'tech-1' });
  expect(out).toEqual({ parkedDecisionIds: ['d1', 'd2'], heldDecisionIds: ['d1', 'd2'], reservationId: 'resv-1', autoSendInFlight: false, phoneLast10: '9415550100', startedAt: expect.any(Date) });
  expect(trx.raw).toHaveBeenCalled(); // lockSuggestThread
  expect(JSON.parse(inserted[0].row.metadata)).toEqual({
    manual_send_reservation: true,
    provider_outcome_uncertain: true,
    parked_decision_ids: ['d1', 'd2'],
  });
  expect(hasActiveAutoSendClaim).not.toHaveBeenCalled();
});

test('with auto-send on: backs off an active claim, else leaves the sending marker the auto-send guard sees', async () => {
  isEnabled.mockReturnValue(true);
  hasActiveAutoSendClaim.mockResolvedValueOnce(true);
  trxWith();
  expect(await suggest.reserveHumanReply({ to: '+19415550100', customerId: 'c1', fromNumber: '+19413529161', body: 'hi' }))
    .toEqual(expect.objectContaining({ parkedDecisionIds: [], heldDecisionIds: [], reservationId: null, autoSendInFlight: true }));

  const { inserted } = trxWith();
  const out = await suggest.reserveHumanReply({ to: '+19415550100', customerId: 'c1', fromNumber: '+19413529161', body: 'hi', adminUserId: 'tech-1' });
  expect(out.reservationId).toBe('resv-1');
  expect(inserted[0]).toMatchObject({ table: 'sms_log', row: { direction: 'outbound', status: 'sending', message_type: 'manual', to_phone: '+19415550100', from_phone: '+19413529161', admin_user_id: 'tech-1' } });
});

test('the gratitude-only gate observes the same active auto-send claim', async () => {
  isEnabled.mockImplementation((name) => name === 'smsGratitudeReplies');
  hasActiveAutoSendClaim.mockResolvedValueOnce(true);
  trxWith();

  const out = await suggest.reserveHumanReply({
    to: '+19415550100', customerId: 'c1', fromNumber: '+19413529161', body: 'hi',
  });

  expect(out).toEqual(expect.objectContaining({ reservationId: null, autoSendInFlight: true }));
  expect(hasActiveAutoSendClaim).toHaveBeenCalledWith(expect.any(Function), {
    threadLast10: '9415550100', customerId: 'c1',
  });
});

test('wrapper opt-in blocks a recent unresolved manual reservation under the thread lock', async () => {
  isEnabled.mockImplementation((name) => name === 'smsGratitudeReplies');
  const { trx, inserted, reservationFirst, chains } = trxWith({ activeManualReservation: { id: 'prior-reservation' } });

  const out = await suggest.reserveHumanReply({
    to: '+19415550100', customerId: 'c1', fromNumber: '+19413529161', body: 'retry',
    blockOnActiveManualReservation: true,
  });

  expect(out).toEqual(expect.objectContaining({
    reservationId: null, autoSendInFlight: false, manualReplyInFlight: true,
  }));
  expect(reservationFirst).toHaveBeenCalledWith('id');
  expect(trx.raw.mock.invocationCallOrder[0]).toBeLessThan(reservationFirst.mock.invocationCallOrder[0]);
  expect(chains.sms_log[0].where).toHaveBeenCalledWith('created_at', '>=', expect.any(Date));
  expect(chains.sms_log[0].whereRaw).toHaveBeenCalledWith(
    "metadata->>'manual_send_reservation' = 'true'",
  );
  expect(chains.sms_log[0].whereRaw).toHaveBeenCalledWith(
    "metadata->>'manual_wrapper_reservation' = 'true'",
  );
  expect(chains.sms_log[0].whereRaw).toHaveBeenCalledWith(
    expect.stringContaining("ELSE '+' ||"),
    ['9415550100'],
  );
  expect(inserted).toEqual([]);
});

test('a gratitude claim outlives its disabled gate while the activation stamp is set', async () => {
  const { gateEnvTimestamp } = require('../config/feature-gates');
  gateEnvTimestamp.mockReturnValueOnce(new Date('2026-09-24T12:00:00Z'));
  hasActiveAutoSendClaim.mockResolvedValueOnce(true);
  const { inserted, chains } = trxWith({ pending: [{ id: 'd1' }], parked: [{ id: 'd1' }] });
  const out = await suggest.reserveHumanReply({ to: '+19415550100', customerId: 'c1', fromNumber: '+19413529161', body: 'hi' });
  expect(out).toMatchObject({ autoSendInFlight: true, reservationId: null, parkedDecisionIds: [] });
  expect(gateEnvTimestamp).toHaveBeenCalledWith('SMS_GRATITUDE_ACTIVATED_AT');
  expect(hasActiveAutoSendClaim).toHaveBeenCalledWith(expect.any(Function), { threadLast10: '9415550100', customerId: 'c1' });
  expect(inserted).toEqual([]);
  expect(chains.agent_decisions).toBeUndefined();
});

test('after activation, a gate-off reply with no card still publishes its reservation for a racing claim', async () => {
  // Rolling disable: an older gate-on instance may claim after this check, so
  // the reservation it observes must be published, not skipped with the gate.
  const { gateEnvTimestamp } = require('../config/feature-gates');
  gateEnvTimestamp.mockReturnValue(new Date('2026-09-24T12:00:00Z'));
  try {
    const { inserted } = trxWith();
    const out = await suggest.reserveHumanReply({ to: '+19415550100', customerId: 'c1', fromNumber: '+19413529161', body: 'hi' });
    expect(hasActiveAutoSendClaim).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({ autoSendInFlight: false, reservationId: 'resv-1', parkedDecisionIds: [] });
    expect(inserted).toHaveLength(1);
  } finally {
    gateEnvTimestamp.mockReturnValue(null);
  }
});

test('wrapper opt-in reserves an empty thread while both autonomous gates are off', async () => {
  const { inserted, reservationFirst } = trxWith();

  const out = await suggest.reserveHumanReply({
    to: '+19415550100', customerId: 'c1', fromNumber: '+19413529161', body: 'new reply',
    blockOnActiveManualReservation: true,
  });

  expect(out.reservationId).toBe('resv-1');
  expect(isEnabled).toHaveBeenCalledWith('smsAutoSend');
  expect(isEnabled).toHaveBeenCalledWith('smsGratitudeReplies');
  expect(hasActiveAutoSendClaim).not.toHaveBeenCalled();
  expect(reservationFirst).toHaveBeenCalledWith('id');
  expect(JSON.parse(inserted[0].row.metadata)).toMatchObject({
    manual_send_reservation: true,
    manual_wrapper_reservation: true,
    provider_outcome_uncertain: true,
  });
});

test('wrapper retry lookup keeps the full international phone identity', async () => {
  isEnabled.mockImplementation((name) => name === 'smsGratitudeReplies');
  const { chains } = trxWith();

  await suggest.reserveHumanReply({
    to: '+442079460958', customerId: 'c1', fromNumber: '+19413529161', body: 'international',
    blockOnActiveManualReservation: true,
  });

  expect(chains.sms_log[0].whereRaw).toHaveBeenCalledWith(
    expect.stringContaining("ELSE '+' ||"),
    ['+442079460958'],
  );
});

test('existing reserve callers do not check or block on a manual reservation without opt-in', async () => {
  const { inserted, reservationFirst } = trxWith({ activeManualReservation: { id: 'prior-reservation' } });

  const out = await suggest.reserveHumanReply({
    to: '+19415550100', customerId: 'c1', fromNumber: '+19413529161', body: 'ordinary caller',
  });

  expect(out.manualReplyInFlight).toBeUndefined();
  expect(reservationFirst).not.toHaveBeenCalled();
  expect(inserted).toEqual([]);
});

function settleDb({ stale = [], acceptedUpdate = 1 } = {}) {
  const del = jest.fn(async () => 1);
  const updateResult = {
    returning: jest.fn(async () => [{ id: 'd1', entity_id: 'draft-1' }]),
    valueOf: () => 1,
  };
  const update = jest.fn((values) => (
    values.status === 'sent' && Object.hasOwn(values, 'twilio_sid')
      ? Promise.resolve(acceptedUpdate)
      : updateResult
  ));
  const chain = { del, update };
  for (const m of ['where', 'whereIn', 'whereNot', 'whereRaw', 'leftJoin']) chain[m] = jest.fn(() => chain);
  chain.select = jest.fn(async () => stale);
  db.mockImplementation(() => chain);
  db.raw = jest.fn(async () => undefined);
  db.transaction = jest.fn(async (cb) => cb(db));
  return { del, update, chain };
}

test('settle: deletes the marker; sent → parked ignored, not sent → reopened', async () => {
  const { del, update } = settleDb();
  const acceptedResult = { sent: true, providerMessageId: `SM${'a'.repeat(32)}` };
  await suggest.settleHumanReply({ phoneLast10: '9415550100', startedAt: new Date(), parkedDecisionIds: ['d1'], reservationId: 'resv-1', sent: true, acceptedResult, reviewedBy: 'tech-1' });
  expect(del).toHaveBeenCalled();
  expect(update).toHaveBeenCalledWith(expect.objectContaining({
    status: 'sent', twilio_sid: acceptedResult.providerMessageId,
  }));
  expect(update).toHaveBeenCalledWith(expect.objectContaining({ status: 'ignored', reviewed_by: 'tech-1' }));

  jest.clearAllMocks();
  await suggest.settleHumanReply({ phoneLast10: '9415550100', startedAt: new Date(), parkedDecisionIds: ['d1'], reservationId: null, sent: false });
  expect(del).not.toHaveBeenCalled();
  expect(update).toHaveBeenCalledWith(expect.objectContaining({ status: 'pending_review' }));
  expect(db.raw).not.toHaveBeenCalled(); // no sweep on an unsent reply
});

test('settle: provider uncertainty retains the linked marker and leaves decisions held', async () => {
  const { del, update } = settleDb();
  await suggest.settleHumanReply({
    phoneLast10: '9415550100', startedAt: new Date(),
    parkedDecisionIds: [], heldDecisionIds: ['d1'], reservationId: 'resv-1', sent: false,
  });
  expect(del).not.toHaveBeenCalled();
  expect(update).toHaveBeenCalledWith(expect.objectContaining({ updated_at: expect.any(Date) }));
});

test('settle: failed accepted promotion leaves decisions held and skips cleanup', async () => {
  const { del, update, chain } = settleDb({ acceptedUpdate: 0 });
  await suggest.settleHumanReply({
    phoneLast10: '9415550100', startedAt: new Date(),
    parkedDecisionIds: ['d1'], reservationId: 'resv-1', sent: true, reviewedBy: 'tech-1',
  });

  expect(update).toHaveBeenCalledTimes(1);
  expect(update).not.toHaveBeenCalledWith(expect.objectContaining({ status: 'ignored' }));
  expect(chain.select).not.toHaveBeenCalled();
  expect(del).not.toHaveBeenCalled();
});

// codex #4338 P1: a reservation created solely to fence an in-flight
// auto-send (no suggestion published yet) has heldDecisionIds: [] too, same
// as a genuinely empty reservation — the decision-id arrays can't tell an
// ambiguous provider outcome apart from a definite miss in that case. The
// caller's explicit `ambiguous: true` is the real signal, and must retain
// the reservation exactly like the non-empty-heldDecisionIds case above.
test('settle: provider uncertainty on a no-card reservation (nothing held) still retains the marker when the caller marks it ambiguous', async () => {
  const { del, update } = settleDb();
  await suggest.settleHumanReply({
    phoneLast10: '9415550100', startedAt: new Date(),
    parkedDecisionIds: [], heldDecisionIds: [], reservationId: 'resv-1', sent: false, ambiguous: true,
  });
  expect(del).not.toHaveBeenCalled();
  expect(update).toHaveBeenCalledWith(expect.objectContaining({ updated_at: expect.any(Date) }));
});

test('settle: a definite (non-ambiguous) miss on a no-card reservation still deletes it — nothing to protect', async () => {
  const { del, update } = settleDb();
  await suggest.settleHumanReply({
    phoneLast10: '9415550100', startedAt: new Date(),
    parkedDecisionIds: [], heldDecisionIds: [], reservationId: 'resv-1', sent: false,
  });
  expect(del).toHaveBeenCalled();
  expect(update).not.toHaveBeenCalled();
});

test('settle (sent): sweeps a card published between the park commit and the accept, under the thread lock, cutoff at send start', async () => {
  const startedAt = new Date('2026-09-07T12:00:00Z');
  const { update, chain } = settleDb({ stale: [{ id: 'd9', entity_id: 'draft-9' }] });
  await suggest.settleHumanReply({ phoneLast10: '9415550100', startedAt, parkedDecisionIds: [], reservationId: null, sent: true, reviewedBy: 'tech-1' });
  expect(db.raw).toHaveBeenCalled(); // lockSuggestThread
  expect(chain.where).toHaveBeenCalledWith('s.created_at', '<', startedAt);
  expect(chain.whereIn).toHaveBeenCalledWith('id', ['d9']);
  expect(update).toHaveBeenCalledWith(expect.objectContaining({ status: 'ignored', correction_note: 'A staff reply to this thread was sent.', reviewed_by: 'tech-1' }));
});

test('settle (sent) with no thread key or start time skips the sweep', async () => {
  const { update } = settleDb({ stale: [{ id: 'd9', entity_id: 'draft-9' }] });
  await suggest.settleHumanReply({ phoneLast10: null, startedAt: null, parkedDecisionIds: [], reservationId: null, sent: true });
  expect(update).not.toHaveBeenCalled();
});
