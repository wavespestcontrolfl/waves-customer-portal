/**
 * collections flags writer — the ONE mechanism every flag write/release goes
 * through (relay webhooks, conversation, and ops/agents/collections-flag.js).
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => { const fn = jest.fn(); fn.fn = { now: jest.fn(() => 'NOW()') }; return fn; });

const db = require('../models/db');
jest.mock('../services/messaging/validators/suppression', () => ({ recordSuppression: jest.fn(async () => ({ ok: true })) }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({ id: 'card-1' })) }));

const { recordSuppression } = require('../services/messaging/validators/suppression');
const NotificationService = require('../services/notification-service');
const logger = require('../services/logger');
const { writeFlag, releaseFlag, activeFlags, flagWrongNumber } = require('../services/collections/outbound-voice/flags');

function chain({ updateResult = 1, rows = [], insertThrows = null } = {}) {
  const q = {};
  ['where', 'whereNull', 'orderBy'].forEach((m) => { q[m] = jest.fn(() => q); });
  q.select = jest.fn(async () => rows);
  q.update = jest.fn(async () => updateResult);
  q.insert = jest.fn(async () => { if (insertThrows) throw insertThrows; return [1]; });
  return q;
}
beforeEach(() => jest.clearAllMocks());

test('writeFlag inserts once; a unique-violation (already active) is success-by-intent', async () => {
  db.mockImplementation(() => chain());
  expect(await writeFlag({ customerId: 'c-1', flag: 'pays_by_check', reason: 'r', createdBy: 'owner:ops-script' })).toEqual({ ok: true, created: true });
  db.mockImplementation(() => chain({ insertThrows: Object.assign(new Error('dup'), { code: '23505' }) }));
  expect(await writeFlag({ customerId: 'c-1', flag: 'pays_by_check' })).toEqual({ ok: true, created: false });
  expect(await writeFlag({ customerId: null, flag: 'pays_by_check' })).toEqual({ ok: false, reason: 'missing_args' });
});

test('releaseFlag stamps released_at on the active row only — never deletes; idempotent', async () => {
  const q = chain({ updateResult: 1 }); db.mockImplementation(() => q);
  expect(await releaseFlag({ customerId: 'c-1', flag: 'pays_by_check' })).toEqual({ ok: true, released: 1 });
  expect(q.where).toHaveBeenCalledWith({ customer_id: 'c-1', flag: 'pays_by_check' });
  expect(q.whereNull).toHaveBeenCalledWith('released_at');
  expect(q.update).toHaveBeenCalledWith({ released_at: 'NOW()' });
  db.mockImplementation(() => chain({ updateResult: 0 }));
  expect(await releaseFlag({ customerId: 'c-1', flag: 'pays_by_check' })).toEqual({ ok: true, released: 0 });
  expect(await releaseFlag({ customerId: 'c-1' })).toEqual({ ok: false, reason: 'missing_args' });
});

test('activeFlags lists unreleased rows oldest first', async () => {
  const q = chain({ rows: [{ flag: 'pays_by_check' }] }); db.mockImplementation(() => q);
  expect(await activeFlags('c-1')).toEqual([{ flag: 'pays_by_check' }]);
  expect(q.whereNull).toHaveBeenCalledWith('released_at');
  expect(q.orderBy).toHaveBeenCalledWith('created_at', 'asc');
  expect(await activeFlags(null)).toEqual([]);
});

describe('flagWrongNumber writes the canonical messaging_suppression row (B14)', () => {
  const args = { detail: 'd', phone: '(941) 555-0142', callLogId: 'cl-9', capturedBody: 'wrong number, never heard of them' };

  beforeEach(() => {
    db.mockImplementation(() => chain());
    recordSuppression.mockResolvedValue({ ok: true });
    NotificationService.notifyAdmin.mockResolvedValue({ id: 'card-1' });
  });

  test('records reason wrong_number for the dialed phone (E.164) with a collections-voice source, and the card says so', async () => {
    const res = await flagWrongNumber('c-1', args);
    expect(recordSuppression).toHaveBeenCalledWith({
      phone: '+19415550142',
      reason: 'wrong_number',
      source: 'collections_voice_call:cl-9',
      capturedBody: 'wrong number, never heard of them',
    });
    expect(res).toEqual(expect.objectContaining({ ok: true, suppression: { ok: true, phone: '+19415550142' } }));
    const detail = NotificationService.notifyAdmin.mock.calls[0][2];
    expect(detail).toContain('ending 0142');
    expect(detail).toContain('do-not-text list');
    expect(detail).not.toContain('could NOT be written');
  });

  test('a failed canonical write is surfaced: logged loudly, returned, and the card does not claim it is suppressed', async () => {
    recordSuppression.mockResolvedValue({ ok: false, error: 'db down' });
    const res = await flagWrongNumber('c-1', args);
    expect(res.ok).toBe(true); // the collections flag itself is durable
    expect(res.suppression).toEqual({ ok: false, reason: 'suppression_write_failed' });
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('WRONG-NUMBER SUPPRESSION NOT WRITTEN'));
    const detail = NotificationService.notifyAdmin.mock.calls[0][2];
    expect(detail).toContain('could NOT be written');
    expect(detail).not.toContain('is now on the do-not-text list');
  });

  test('a throwing recordSuppression is contained the same way', async () => {
    recordSuppression.mockRejectedValue(new Error('boom'));
    const res = await flagWrongNumber('c-1', args);
    expect(res.suppression.ok).toBe(false);
    expect(NotificationService.notifyAdmin.mock.calls[0][2]).toContain('could NOT be written');
  });

  test('no usable phone: no suppression attempt, surfaced as not written', async () => {
    const res = await flagWrongNumber('c-1', { ...args, phone: null });
    expect(recordSuppression).not.toHaveBeenCalled();
    expect(res.suppression).toEqual({ ok: false, reason: 'no_valid_phone' });
    expect(NotificationService.notifyAdmin.mock.calls[0][2]).toContain('could NOT be written');
  });

  test('a failed collections flag write still attempts the canonical suppression and reports ok:false', async () => {
    db.mockImplementation(() => chain({ insertThrows: new Error('pg down') }));
    const res = await flagWrongNumber('c-1', args);
    expect(res.ok).toBe(false);
    expect(recordSuppression).toHaveBeenCalledWith(expect.objectContaining({ reason: 'wrong_number' }));
    expect(res.suppression.ok).toBe(true);
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  });
});
