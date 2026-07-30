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
