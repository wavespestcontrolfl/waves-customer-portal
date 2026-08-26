/**
 * Owner ruling (Adam, 2026-07-30): no emojis in admin notification titles or
 * bodies — the icon column carries the pictogram. Enforced centrally in
 * NotificationService.create (bell rows) and notification-triggers'
 * sanitizeBuiltNotification (Web Push payloads).
 */

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const db = require('../models/db');
const { stripEmoji } = require('../utils/strip-emoji');
const NotificationService = require('../services/notification-service');

describe('stripEmoji', () => {
  test('removes emoji, variation selectors, and joiners; keeps plain typography', () => {
    expect(stripEmoji('🔔 New lead!')).toBe('New lead!');
    expect(stripEmoji('📞 941-555-1234 📍 123 Main St')).toBe('941-555-1234 123 Main St');
    expect(stripEmoji('2026-08-14 → Wednesday — Parrish')).toBe('2026-08-14 → Wednesday — Parrish');
    expect(stripEmoji('⚠️ 3 quarantine failures')).toBe('3 quarantine failures');
    expect(stripEmoji(null)).toBeNull();
  });
});

describe('NotificationService.create emoji policy', () => {
  function mockInsert() {
    const insert = jest.fn(() => ({ returning: jest.fn(async () => [{ id: 'n1' }]) }));
    db.mockImplementation(() => ({ insert }));
    return insert;
  }

  test('admin titles and bodies are stripped; emoji-only title falls back to the original', async () => {
    const insert = mockInsert();
    await NotificationService.create({
      recipientType: 'admin', category: 'alert',
      title: '📩 New SMS', body: 'From: 941 "Is this for you? 😁"',
    });
    expect(insert.mock.calls[0][0]).toMatchObject({ title: 'New SMS', body: 'From: 941 "Is this for you? "'.replace(/\s+"$/, ' "') });

    const insert2 = mockInsert();
    await NotificationService.create({ recipientType: 'admin', category: 'alert', title: '🔔' });
    expect(insert2.mock.calls[0][0].title).toBe('🔔');
  });

  test('customer notifications are untouched', async () => {
    const insert = mockInsert();
    await NotificationService.create({
      recipientType: 'customer', recipientId: 'c1', category: 'service',
      title: '✅ Service complete', body: 'Thanks! 🎉',
    });
    expect(insert.mock.calls[0][0]).toMatchObject({ title: '✅ Service complete', body: 'Thanks! 🎉' });
  });
});

describe('NotificationService.notifyAdmin dedupeKey (PR #3496 — replayed emitters ring once)', () => {
  function makeTrx(existingRow) {
    const insert = jest.fn(() => ({ returning: jest.fn(async () => [{ id: 'n-new' }]) }));
    const chain = {
      where: jest.fn(() => chain),
      whereRaw: jest.fn(() => chain),
      first: jest.fn(async () => existingRow),
      insert,
    };
    const trx = jest.fn(() => chain);
    trx.raw = jest.fn(async () => {});
    return { trx, insert };
  }

  test('a second identical bell dedupes against the stored metadata key — no insert', async () => {
    const { trx, insert } = makeTrx({ id: 'n-existing' });
    db.transaction = jest.fn(async (cb) => cb(trx));
    const r = await NotificationService.notifyAdmin('billing', 'Title', 'Body', { dedupeKey: 'orphan_hold_review:h1:s1' });
    expect(r).toMatchObject({ id: 'n-existing', deduped: true });
    expect(insert).not.toHaveBeenCalled();
    expect(trx.raw).toHaveBeenCalledWith(expect.stringContaining('pg_advisory_xact_lock'), ['admin:orphan_hold_review:h1:s1']);
  });

  test('the first bell inserts with the dedupeKey folded into metadata', async () => {
    const { trx, insert } = makeTrx(null);
    db.transaction = jest.fn(async (cb) => cb(trx));
    const r = await NotificationService.notifyAdmin('billing', 'Title', 'Body', { dedupeKey: 'k:1', metadata: { holdId: 'h1' } });
    expect(r).toMatchObject({ deduped: false });
    expect(insert).toHaveBeenCalledTimes(1);
    expect(JSON.parse(insert.mock.calls[0][0].metadata)).toMatchObject({ holdId: 'h1', dedupeKey: 'k:1' });
  });

  test('a failed insert inside the dedupe path returns null, never {deduped:false} success', async () => {
    const { trx } = makeTrx(null);
    // create() swallows insert errors and returns null — make the insert throw.
    trx().insert.mockImplementation(() => { throw new Error('insert boom'); });
    db.transaction = jest.fn(async (cb) => cb(trx));
    const r = await NotificationService.notifyAdmin('billing', 'Title', 'Body', { dedupeKey: 'k:1' });
    expect(r).toBeNull();
  });

  test('a dedupe-machinery failure fails CLOSED (no bell) rather than risking a duplicate', async () => {
    db.transaction = jest.fn(async () => { throw new Error('lock failed'); });
    const r = await NotificationService.notifyAdmin('billing', 'Title', 'Body', { dedupeKey: 'k:1' });
    expect(r).toBeNull();
  });

  test('no dedupeKey = unchanged direct create path', async () => {
    const insert = jest.fn(() => ({ returning: jest.fn(async () => [{ id: 'n1' }]) }));
    db.mockImplementation(() => ({ insert }));
    db.transaction = jest.fn();
    await NotificationService.notifyAdmin('billing', 'Title', 'Body', {});
    expect(insert).toHaveBeenCalledTimes(1);
    expect(db.transaction).not.toHaveBeenCalled();
  });
});
