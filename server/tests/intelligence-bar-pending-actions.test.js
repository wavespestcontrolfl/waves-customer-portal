jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.fn = { now: jest.fn(() => 'NOW()') };
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const db = require('../models/db');
const {
  paramsHash,
  stableStringify,
  createPendingAction,
  claimForConfirm,
  cancelPendingAction,
} = require('../services/intelligence-bar/pending-actions');

function insertBuilder(returningRow) {
  const q = {
    insert: jest.fn(() => q),
    returning: jest.fn(async () => [returningRow]),
  };
  return q;
}

function claimBuilder({ claimedRow, lookupRow }) {
  // First db('ib_pending_actions') call = the atomic UPDATE claim chain;
  // second = the .first() diagnosis lookup when the claim misses.
  const updateChain = {
    where: jest.fn(() => updateChain),
    update: jest.fn(() => updateChain),
    returning: jest.fn(async () => (claimedRow ? [claimedRow] : [])),
  };
  const lookupChain = {
    where: jest.fn(() => lookupChain),
    first: jest.fn(async () => lookupRow),
    update: jest.fn(async () => 1),
  };
  let call = 0;
  db.mockImplementation(() => (call++ === 0 ? updateChain : lookupChain));
  return { updateChain, lookupChain };
}

describe('pending-actions service', () => {
  beforeEach(() => jest.clearAllMocks());

  test('stableStringify is key-order independent', () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: [3, 4] } }))
      .toBe(stableStringify({ a: { c: [3, 4], d: 2 }, b: 1 }));
  });

  test('paramsHash binds tool name and params', () => {
    const h = paramsHash('create_customer', { first_name: 'Jeff' });
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(paramsHash('update_customer', { first_name: 'Jeff' })).not.toBe(h);
    expect(paramsHash('create_customer', { first_name: 'Jefe' })).not.toBe(h);
  });

  test('createPendingAction stores hash, actor, and a future expiry', async () => {
    const inserted = insertBuilder({ id: 'pa-1', tool_name: 'send_sms' });
    db.mockImplementation(() => inserted);

    const row = await createPendingAction({
      toolName: 'send_sms',
      params: { customer_id: 'c1', message: 'hi' },
      summary: 'send_sms — customer_id: c1',
      requestedBy: 'admin-1',
      context: 'comms',
    });

    expect(row.id).toBe('pa-1');
    const stored = inserted.insert.mock.calls[0][0];
    expect(stored.params_hash).toBe(paramsHash('send_sms', { customer_id: 'c1', message: 'hi' }));
    expect(stored.requested_by).toBe('admin-1');
    expect(stored.status).toBe('pending');
    expect(new Date(stored.expires_at).getTime()).toBeGreaterThan(Date.now());
  });

  test('claim succeeds when the atomic update wins and the hash matches', async () => {
    const params = { customer_id: 'c1', message: 'hi' };
    claimBuilder({
      claimedRow: {
        id: 'pa-1', tool_name: 'send_sms', params,
        params_hash: paramsHash('send_sms', params), requested_by: 'admin-1', status: 'confirmed',
      },
    });

    const claim = await claimForConfirm('pa-1', 'admin-1');
    expect(claim.error).toBeUndefined();
    expect(claim.action.tool_name).toBe('send_sms');
    expect(claim.action.params).toEqual(params);
  });

  test('replay: second claim finds no pending row and reports already_used', async () => {
    claimBuilder({
      claimedRow: null,
      lookupRow: { id: 'pa-1', requested_by: 'admin-1', status: 'confirmed' },
    });
    expect(await claimForConfirm('pa-1', 'admin-1')).toEqual({ error: 'already_used' });
  });

  test('actor mismatch is rejected even for a live pending row', async () => {
    claimBuilder({
      claimedRow: null,
      lookupRow: { id: 'pa-1', requested_by: 'admin-1', status: 'pending' },
    });
    expect(await claimForConfirm('pa-1', 'tech-9')).toEqual({ error: 'actor_mismatch' });
  });

  test('expired pending rows cannot be claimed', async () => {
    claimBuilder({
      claimedRow: null,
      lookupRow: { id: 'pa-1', requested_by: 'admin-1', status: 'pending' },
    });
    expect(await claimForConfirm('pa-1', 'admin-1')).toEqual({ error: 'expired' });
  });

  test('cancelled rows report cancelled; unknown ids report not_found', async () => {
    claimBuilder({
      claimedRow: null,
      lookupRow: { id: 'pa-1', requested_by: 'admin-1', status: 'cancelled' },
    });
    expect(await claimForConfirm('pa-1', 'admin-1')).toEqual({ error: 'cancelled' });

    claimBuilder({ claimedRow: null, lookupRow: undefined });
    expect(await claimForConfirm('pa-x', 'admin-1')).toEqual({ error: 'not_found' });
  });

  test('hash mismatch cancels the row and refuses execution', async () => {
    const { lookupChain } = claimBuilder({
      claimedRow: {
        id: 'pa-1', tool_name: 'send_sms', params: { customer_id: 'c1', message: 'TAMPERED' },
        params_hash: paramsHash('send_sms', { customer_id: 'c1', message: 'hi' }),
        requested_by: 'admin-1', status: 'confirmed',
      },
    });

    expect(await claimForConfirm('pa-1', 'admin-1')).toEqual({ error: 'hash_mismatch' });
    expect(lookupChain.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'cancelled' }));
  });

  test('cancelPendingAction only cancels your own pending rows', async () => {
    const chain = {
      where: jest.fn(() => chain),
      update: jest.fn(async () => 0),
    };
    db.mockImplementation(() => chain);
    expect(await cancelPendingAction('pa-1', 'tech-9')).toEqual({ cancelled: false });
    expect(chain.where).toHaveBeenCalledWith({ id: 'pa-1', status: 'pending', requested_by: 'tech-9' });
  });
});
