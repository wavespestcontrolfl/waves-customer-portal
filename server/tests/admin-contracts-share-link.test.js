/**
 * The share-link writer's two halves (GH Codex #3844 r3 P1):
 *   createShareLink(id, req, { prepare: true }) — the composer insert: only
 *   the token hash lands (no status / shared_at / window), a still-live
 *   delivered link refuses UNDER THE ROW LOCK, an abandoned prepared or an
 *   expired link is replaced.
 *   activatePreparedShareLinks / restorePreparedShareLinks /
 *   recordPreparedShareLinkSends — the /sms send's half: activate before
 *   the provider call (conditional on the hash), hand back on a no-send
 *   exit, record after a real send.
 * The Contracts page's own mint (no prepare flag) is pinned unchanged.
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
  createShareLink, activatePreparedShareLinks, restorePreparedShareLinks, recordPreparedShareLinkSends,
} = require('../routes/admin-contracts');

const req = { technicianId: 'admin-1', ip: '127.0.0.1', get: () => 'jest' };
const DAY = 86400e3;
const base = { id: 'k1', customer_id: 'c1', title: 'Auto Pay Authorization', status: 'draft', contract_type: 'autopay_authorization', share_token_hash: null, share_token_expires_at: null, shared_at: null };
const tokenOf = (url) => decodeURIComponent(url.split('/contract/')[1]);
const updates = (table) => mockWrites.filter((w) => w.table === table && w.op === 'update');

beforeEach(() => { mockWrites.length = 0; mockRows = {}; });

describe('createShareLink — prepare mode (the composer insert)', () => {
  test('mockWrites ONLY the hash: no status, no shared_at, no window; event says prepared', async () => {
    mockRows = { customer_contracts: base };
    const r = await createShareLink('k1', req, { prepare: true });
    expect(r.error).toBeUndefined();
    expect(r.expiresAt).toBeNull();
    const [w] = updates('customer_contracts');
    expect(Object.keys(w.payload).sort()).toEqual(['share_token_expires_at', 'share_token_hash', 'updated_at']);
    expect(w.payload.share_token_expires_at).toBeNull();
    expect(w.payload.share_token_hash).toBe(hashContractToken(tokenOf(r.signingUrl)));
    expect(w.filters).toContainEqual({ id: 'k1' });
    const event = mockWrites.find((x) => x.table === 'customer_contract_events');
    expect(event.payload.event_type).toBe('share_link_created');
    expect(JSON.parse(event.payload.metadata)).toEqual({ prepared: true, source: 'composer' });
  });

  test('a delivered link whose window is still open REFUSES (pre-push Codex P0) — judged on the LOCKED row', async () => {
    mockRows = { customer_contracts: { ...base, status: 'sent', share_token_hash: 'x'.repeat(64), share_token_expires_at: new Date(Date.now() + DAY), shared_at: new Date() } };
    const r = await createShareLink('k1', req, { prepare: true });
    expect(r.error).toEqual({ status: 409, message: expect.stringMatching(/Auto Pay Authorization was already sent and is still live/) });
    expect(updates('customer_contracts')).toHaveLength(0);
    const locked = require('../models/db').mock.results.find((x) => x.value.table === 'customer_contracts').value;
    expect(locked.forUpdate).toHaveBeenCalled();
  });

  test.each([
    ['an expired delivered link', { status: 'sent', share_token_hash: 'x'.repeat(64), share_token_expires_at: new Date(Date.now() - DAY), shared_at: new Date(Date.now() - 20 * DAY) }],
    ['an abandoned PREPARED link (hash, no window)', { status: 'draft', share_token_hash: 'y'.repeat(64), share_token_expires_at: null }],
  ])('%s is simply replaced — no customer holds it', async (_label, link) => {
    mockRows = { customer_contracts: { ...base, ...link } };
    const r = await createShareLink('k1', req, { prepare: true });
    expect(r.error).toBeUndefined();
    expect(updates('customer_contracts')[0].payload.share_token_expires_at).toBeNull();
  });

  test('terminal contracts refuse before any write', async () => {
    mockRows = { customer_contracts: { ...base, status: 'signed' } };
    expect((await createShareLink('k1', req, { prepare: true })).error.status).toBe(400);
    expect(mockWrites).toHaveLength(0);
  });
});

describe('createShareLink — the Contracts page mint (unchanged)', () => {
  test('stamps sent + shared_at + a 14-day window and rotates whatever was there', async () => {
    mockRows = { customer_contracts: { ...base, status: 'sent', share_token_hash: 'x'.repeat(64), share_token_expires_at: new Date(Date.now() + DAY), shared_at: new Date() } };
    const r = await createShareLink('k1', req);
    expect(r.error).toBeUndefined();
    const [w] = updates('customer_contracts');
    expect(w.payload.status).toBe('sent');
    expect(w.payload.shared_at).toBeInstanceOf(Date);
    expect(w.payload.share_token_expires_at.getTime() - Date.now()).toBeGreaterThan(13 * DAY);
    expect(r.expiresAt).toBe(w.payload.share_token_expires_at);
  });
});

describe('activatePreparedShareLinks (the /sms send, before the provider call)', () => {
  const HASH = hashContractToken('tok-1');

  test('a prepared row whose hash still matches becomes the delivered one, windowed from the send; previous state rides back', async () => {
    mockRows = { customer_contracts: { ...base, share_token_hash: HASH } };
    const r = await activatePreparedShareLinks([{ id: 'k1', tokenHash: HASH }], req);
    expect(r.ok).toBe(true);
    const [w] = updates('customer_contracts');
    expect(w.filters).toContainEqual({ id: 'k1', share_token_hash: HASH });
    expect(w.payload.status).toBe('sent');
    expect(w.payload.shared_at).toBeInstanceOf(Date);
    expect(w.payload.share_token_expires_at.getTime() - Date.now()).toBeGreaterThan(13 * DAY);
    expect(r.activations).toEqual([{ id: 'k1', customerId: 'c1', tokenHash: HASH, expiresAt: w.payload.share_token_expires_at, previous: { status: 'draft', shared_at: null } }]);
  });

  test('a hash mismatch (rotated meanwhile) refuses — nothing written', async () => {
    mockRows = { customer_contracts: { ...base, share_token_hash: hashContractToken('someone-elses') } };
    const r = await activatePreparedShareLinks([{ id: 'k1', tokenHash: HASH }], req);
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/no longer live/) });
    expect(mockWrites).toHaveLength(0);
  });

  test('an already-delivered live link (pasted from the Contracts page) needs no activation', async () => {
    const expiresAt = new Date(Date.now() + DAY);
    mockRows = { customer_contracts: { ...base, status: 'viewed', share_token_hash: HASH, share_token_expires_at: expiresAt, shared_at: new Date() } };
    const r = await activatePreparedShareLinks([{ id: 'k1', tokenHash: HASH }], req);
    expect(r).toEqual({ ok: true, activations: [{ id: 'k1', customerId: 'c1', tokenHash: HASH, expiresAt, previous: null }] });
    expect(mockWrites).toHaveLength(0);
  });

  test.each([
    ['expired', { share_token_hash: HASH, share_token_expires_at: new Date(Date.now() - 1000) }, /expired/],
    ['terminal', { share_token_hash: HASH, status: 'cancelled' }, /no longer awaiting/],
  ])('a %s row refuses', async (_label, row, msg) => {
    mockRows = { customer_contracts: { ...base, ...row } };
    expect(await activatePreparedShareLinks([{ id: 'k1', tokenHash: HASH }], req)).toEqual({ ok: false, error: expect.stringMatching(msg) });
  });

  test('a later link refusing undoes the earlier activation (all or nothing)', async () => {
    const H2 = hashContractToken('tok-2');
    mockRows = { customer_contracts: (b) => (b.filters.some((f) => f?.id === 'k2') ? { ...base, id: 'k2', share_token_hash: 'rotated' } : { ...base, share_token_hash: HASH }) };
    const r = await activatePreparedShareLinks([{ id: 'k1', tokenHash: HASH }, { id: 'k2', tokenHash: H2 }], req);
    expect(r.ok).toBe(false);
    const [activate, restore] = updates('customer_contracts');
    expect(activate.payload.status).toBe('sent');
    expect(restore.payload).toEqual({ status: 'draft', share_token_expires_at: null, shared_at: null, updated_at: expect.any(Date) });
    expect(restore.filters).toContainEqual({ id: 'k1', share_token_hash: HASH });
  });
});

describe('restorePreparedShareLinks / recordPreparedShareLinkSends', () => {
  const HASH = hashContractToken('tok-1');
  test('restore hands a prepared link back, conditional on the hash; an already-delivered link is left alone', async () => {
    await restorePreparedShareLinks([
      { id: 'k1', tokenHash: HASH, previous: { status: 'draft', shared_at: null } },
      { id: 'k2', tokenHash: HASH, previous: null },
    ]);
    const ws = updates('customer_contracts');
    expect(ws).toHaveLength(1);
    expect(ws[0].filters).toContainEqual({ id: 'k1', share_token_hash: HASH });
    expect(ws[0].payload).toEqual({ status: 'draft', share_token_expires_at: null, shared_at: null, updated_at: expect.any(Date) });
  });

  test('record mockWrites the document delivery\'s own sms_sent event with the provider id', async () => {
    const expiresAt = new Date(Date.now() + DAY);
    await recordPreparedShareLinkSends([{ id: 'k1', customerId: 'c1', tokenHash: HASH, expiresAt, previous: null }], req, { provider: 'twilio', providerMessageId: 'SM1' });
    const ev = mockWrites.find((w) => w.table === 'customer_contract_events');
    expect(ev.payload).toEqual(expect.objectContaining({ contract_id: 'k1', customer_id: 'c1', event_type: 'sms_sent', actor_type: 'admin', actor_id: 'admin-1' }));
    expect(JSON.parse(ev.payload.metadata)).toEqual({ channel: 'sms', action: 'composer', provider: 'twilio', providerMessageId: 'SM1', expiresAt: expiresAt.toISOString() });
  });
});
