/**
 * The contract share-link writers (GH Codex #3844 r3 P1 + pre-push P0):
 *   createShareLink — the Contracts page's deliberate mint, unchanged.
 *   activatePreparedShareLinks — the composer's send-time half: the Insert
 *   Link sheet mints its token in memory and writes NOTHING; the /sms send
 *   writes the hash here, under the row lock, before the provider call — a
 *   delivered link whose window is still open refuses (never rotated).
 *   restorePreparedShareLinks — a send that never left puts the row back
 *   exactly as it was, conditional on the hash.
 *   recordPreparedShareLinkSends — a real send records the delivery event.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

const mockWrites = [];
let mockRows = {};
function mockBuilder(table) {
  const b = { table, filters: [] };
  const chain = () => b;
  for (const m of ['leftJoin', 'select', 'whereIn', 'forUpdate', 'orderBy']) b[m] = jest.fn(chain);
  b.where = jest.fn((arg) => { b.filters.push(arg); return b; });
  b.first = jest.fn(async () => (typeof mockRows[table] === 'function' ? mockRows[table](b) : mockRows[table]) ?? null);
  b.update = jest.fn(async (payload) => { mockWrites.push({ table, op: 'update', payload, filters: b.filters.slice() }); return mockRows.__updateResult ?? 1; });
  b.insert = jest.fn(async (payload) => { mockWrites.push({ table, op: 'insert', payload }); return [1]; });
  return b;
}
jest.mock('../models/db', () => {
  const fn = jest.fn((table) => mockBuilder(table));
  fn.transaction = jest.fn(async (cb) => cb(fn));
  fn.raw = jest.fn((s) => s);
  return fn;
});
jest.mock('../utils/customer-comms-lock', () => ({ lockCustomerComms: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({ adminAuthenticate: (_q, _s, n) => n(), requireAdmin: (_q, _s, n) => n() }));
jest.mock('../services/autopay-log', () => ({ logAutopay: jest.fn() }));
jest.mock('../services/document-contract-delivery', () => ({}));

const { hashContractToken } = require('../services/contracts');
const {
  createShareLink, deliveredLiveShareLink, activatePreparedShareLinks, restorePreparedShareLinks, recordPreparedShareLinkSends,
} = require('../routes/admin-contracts');

const req = { technicianId: 'admin-1', ip: '127.0.0.1', get: () => 'jest' };
const DAY = 86400e3;
const base = { id: 'k1', customer_id: 'c1', title: 'Auto Pay Authorization', status: 'draft', contract_type: 'autopay_authorization', share_token_hash: null, share_token_expires_at: null, shared_at: null };
const HASH = hashContractToken('tok-1');
const updates = (table) => mockWrites.filter((w) => w.table === table && w.op === 'update');
const events = () => mockWrites.filter((w) => w.table === 'customer_contract_events').map((w) => ({ type: w.payload.event_type, meta: JSON.parse(w.payload.metadata) }));

beforeEach(() => { mockWrites.length = 0; mockRows = {}; });

test('deliveredLiveShareLink: hashed, windowed, window open — anything less is nobody\'s link', () => {
  expect(deliveredLiveShareLink({ share_token_hash: 'h', share_token_expires_at: new Date(Date.now() + DAY) })).toBe(true);
  expect(deliveredLiveShareLink({ share_token_hash: 'h', share_token_expires_at: new Date(Date.now() - 1) })).toBe(false);
  expect(deliveredLiveShareLink({ share_token_hash: 'h', share_token_expires_at: null })).toBe(false);
  expect(deliveredLiveShareLink({ share_token_hash: null, share_token_expires_at: new Date(Date.now() + DAY) })).toBe(false);
});

describe('createShareLink — the Contracts page mint (unchanged)', () => {
  test('stamps sent + shared_at + a 14-day window and rotates whatever was there', async () => {
    mockRows = { customer_contracts: { ...base, status: 'sent', share_token_hash: 'x'.repeat(64), share_token_expires_at: new Date(Date.now() + DAY), shared_at: new Date() } };
    const r = await createShareLink('k1', req);
    expect(r.error).toBeUndefined();
    const [w] = updates('customer_contracts');
    expect(w.payload.status).toBe('sent');
    expect(w.payload.shared_at).toBeInstanceOf(Date);
    expect(w.payload.share_token_hash).toBe(hashContractToken(decodeURIComponent(r.signingUrl.split('/contract/')[1])));
    expect(w.payload.share_token_expires_at.getTime() - Date.now()).toBeGreaterThan(13 * DAY);
    expect(r.expiresAt).toBe(w.payload.share_token_expires_at);
    expect(events()).toEqual([{ type: 'share_link_created', meta: { expiresAt: w.payload.share_token_expires_at.toISOString() } }]);
  });

  test('terminal contracts refuse before any write', async () => {
    mockRows = { customer_contracts: { ...base, status: 'signed' } };
    expect((await createShareLink('k1', req)).error.status).toBe(400);
    expect(mockWrites).toHaveLength(0);
  });
});

describe('activatePreparedShareLinks (the /sms send, before the provider call)', () => {
  test('an unwritten composer link lands under the lock: hash + sent + shared_at + window from the send; the prior state rides back', async () => {
    mockRows = { customer_contracts: base };
    const r = await activatePreparedShareLinks([{ id: 'k1', tokenHash: HASH, delivered: false }], req);
    expect(r.ok).toBe(true);
    const db = require('../models/db');
    expect(db.mock.results.find((x) => x.value.table === 'customer_contracts').value.forUpdate).toHaveBeenCalled();
    const [w] = updates('customer_contracts');
    expect(w.filters).toContainEqual({ id: 'k1' });
    expect(w.payload).toEqual({ status: 'sent', share_token_hash: HASH, share_token_expires_at: expect.any(Date), shared_at: expect.any(Date), updated_at: expect.any(Date) });
    expect(w.payload.share_token_expires_at.getTime() - Date.now()).toBeGreaterThan(13 * DAY);
    expect(r.activations).toEqual([{
      id: 'k1', customerId: 'c1', tokenHash: HASH, expiresAt: w.payload.share_token_expires_at,
      previous: { status: 'draft', share_token_hash: null, share_token_expires_at: null, shared_at: null },
    }]);
    expect(events()).toEqual([{ type: 'share_link_created', meta: { expiresAt: w.payload.share_token_expires_at.toISOString(), source: 'composer' } }]);
  });

  test('an expired earlier link is replaced — the prior hash/window/shared_at ride back for the restore', async () => {
    const old = { status: 'viewed', share_token_hash: 'x'.repeat(64), share_token_expires_at: new Date(Date.now() - DAY), shared_at: new Date(Date.now() - 20 * DAY) };
    mockRows = { customer_contracts: { ...base, ...old } };
    const r = await activatePreparedShareLinks([{ id: 'k1', tokenHash: HASH, delivered: false }], req);
    expect(r.ok).toBe(true);
    expect(r.activations[0].previous).toEqual(old);
  });

  test('a delivered link whose window is still open REFUSES — the composer never rotates it (pre-push Codex P0); two composers on one contract: the first send wins', async () => {
    mockRows = { customer_contracts: { ...base, status: 'sent', share_token_hash: 'x'.repeat(64), share_token_expires_at: new Date(Date.now() + DAY), shared_at: new Date() } };
    const r = await activatePreparedShareLinks([{ id: 'k1', tokenHash: HASH, delivered: false }], req);
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/Auto Pay Authorization was already sent and is still live/) });
    expect(mockWrites).toHaveLength(0);
  });

  test('a link the customer already holds (pasted from the Contracts page) is re-verified and needs no write', async () => {
    const expiresAt = new Date(Date.now() + DAY);
    mockRows = { customer_contracts: { ...base, status: 'viewed', share_token_hash: HASH, share_token_expires_at: expiresAt, shared_at: new Date() } };
    const r = await activatePreparedShareLinks([{ id: 'k1', tokenHash: HASH, delivered: true }], req);
    expect(r).toEqual({ ok: true, activations: [{ id: 'k1', customerId: 'c1', tokenHash: HASH, expiresAt, previous: null }] });
    expect(mockWrites).toHaveLength(0);
  });

  test.each([
    ['delivered link rotated meanwhile', { share_token_hash: 'other', share_token_expires_at: new Date(Date.now() + DAY) }, true, /no longer live/],
    ['delivered link expired meanwhile', { share_token_hash: HASH, share_token_expires_at: new Date(Date.now() - 1000) }, true, /no longer live/],
    ['terminal contract', { status: 'cancelled' }, false, /no longer awaiting/],
    ['status a fresh link may not be written over', { status: 'expired' }, false, /status changed/],
  ])('%s → refuses, nothing written', async (_label, row, delivered, msg) => {
    mockRows = { customer_contracts: { ...base, ...row } };
    expect(await activatePreparedShareLinks([{ id: 'k1', tokenHash: HASH, delivered }], req)).toEqual({ ok: false, error: expect.stringMatching(msg) });
    expect(updates('customer_contracts')).toHaveLength(0);
  });

  test('a later link refusing undoes the earlier activation (all or nothing)', async () => {
    const H2 = hashContractToken('tok-2');
    mockRows = { customer_contracts: (b) => (b.filters.some((f) => f?.id === 'k2') ? { ...base, id: 'k2', status: 'signed' } : base) };
    const r = await activatePreparedShareLinks([{ id: 'k1', tokenHash: HASH, delivered: false }, { id: 'k2', tokenHash: H2, delivered: false }], req);
    expect(r.ok).toBe(false);
    const [activate, restore] = updates('customer_contracts');
    expect(activate.payload.share_token_hash).toBe(HASH);
    expect(restore.filters).toContainEqual({ id: 'k1', share_token_hash: HASH });
    expect(restore.payload).toEqual({ status: 'draft', share_token_hash: null, share_token_expires_at: null, shared_at: null, updated_at: expect.any(Date) });
  });
});

describe('restorePreparedShareLinks / recordPreparedShareLinkSends', () => {
  test('restore puts the row back exactly as it was, conditional on the hash, and records delivery_failed; a link the customer already held is left alone', async () => {
    const previous = { status: 'viewed', share_token_hash: 'x'.repeat(64), share_token_expires_at: new Date(Date.now() - DAY), shared_at: new Date(Date.now() - 20 * DAY) };
    await restorePreparedShareLinks([
      { id: 'k1', customerId: 'c1', tokenHash: HASH, previous },
      { id: 'k2', customerId: 'c1', tokenHash: HASH, previous: null },
    ], req, { reason: 'blocked' });
    const ws = updates('customer_contracts');
    expect(ws).toHaveLength(1);
    expect(ws[0].filters).toContainEqual({ id: 'k1', share_token_hash: HASH });
    expect(ws[0].payload).toEqual({ ...previous, updated_at: expect.any(Date) });
    expect(events()).toEqual([{ type: 'delivery_failed', meta: { channel: 'sms', action: 'composer', reason: 'blocked' } }]);
  });

  test('a restore that matches nothing (rotated meanwhile) records nothing', async () => {
    mockRows = { __updateResult: 0 };
    await restorePreparedShareLinks([{ id: 'k1', customerId: 'c1', tokenHash: HASH, previous: { status: 'draft', share_token_hash: null, share_token_expires_at: null, shared_at: null } }], req);
    expect(events()).toEqual([]);
  });

  test('record writes the document delivery\'s own sms_sent event with the provider id', async () => {
    const expiresAt = new Date(Date.now() + DAY);
    await recordPreparedShareLinkSends([{ id: 'k1', customerId: 'c1', tokenHash: HASH, expiresAt, previous: null }], req, { provider: 'twilio', providerMessageId: 'SM1' });
    const ev = mockWrites.find((w) => w.table === 'customer_contract_events');
    expect(ev.payload).toEqual(expect.objectContaining({ contract_id: 'k1', customer_id: 'c1', event_type: 'sms_sent', actor_type: 'admin', actor_id: 'admin-1' }));
    expect(JSON.parse(ev.payload.metadata)).toEqual({ channel: 'sms', action: 'composer', provider: 'twilio', providerMessageId: 'SM1', expiresAt: expiresAt.toISOString() });
  });
});
