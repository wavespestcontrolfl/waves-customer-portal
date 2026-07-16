/**
 * ad-audience-consent — marketing-opt-out suppression for ad-audience uploads.
 * Drops contacts on the SMS STOP/DNC list (messaging_suppression) or the email
 * unsubscribe/complaint list (email_suppressions), matched by normalized
 * phone/email, and fails CLOSED if the lists can't be loaded.
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

let mockPhoneRows = [];
let mockEmailRows = [];
let mockPhoneThrows = false;
jest.mock('../models/db', () => jest.fn((table) => {
  if (table === 'messaging_suppression') {
    return { where: () => ({ select: () => (mockPhoneThrows ? Promise.reject(new Error('db down')) : Promise.resolve(mockPhoneRows)) }) };
  }
  if (table === 'email_suppressions') {
    return { where: () => ({ whereIn: () => ({ select: () => Promise.resolve(mockEmailRows) }) }) };
  }
  throw new Error(`unexpected table ${table}`);
}));

const { filterMarketingSuppressed, loadMarketingSuppression } = require('../services/ads/ad-audience-consent');

beforeEach(() => {
  mockPhoneRows = [];
  mockEmailRows = [];
  mockPhoneThrows = false;
});

test('drops phone opt-outs regardless of formatting', async () => {
  mockPhoneRows = [{ phone: '+1 (941) 555-1234' }];
  const kept = await filterMarketingSuppressed([
    { key: 'customer:1', phone: '9415551234', email: null },
    { key: 'customer:2', phone: '9415559999', email: null },
  ]);
  expect(kept.map((m) => m.key)).toEqual(['customer:2']);
});

test('drops email opt-outs case-insensitively', async () => {
  mockEmailRows = [{ email: 'opted.out@example.com' }];
  const kept = await filterMarketingSuppressed([
    { key: 'lead:1', email: 'Opted.Out@Example.com', phone: null },
    { key: 'lead:2', email: 'fine@example.com', phone: null },
  ]);
  expect(kept.map((m) => m.key)).toEqual(['lead:2']);
});

test('suppresses when EITHER the phone OR the email matches', async () => {
  mockPhoneRows = [{ phone: '9415551234' }];
  mockEmailRows = [{ email: 'x@y.com' }];
  const kept = await filterMarketingSuppressed([
    { key: 'a', phone: '9415551234', email: 'clean@y.com' },   // phone match
    { key: 'b', phone: '9990001111', email: 'x@y.com' },       // email match
    { key: 'c', phone: '9990002222', email: 'clean2@y.com' },  // clean
  ]);
  expect(kept.map((m) => m.key)).toEqual(['c']);
});

test('empty input returns empty without hitting the db', async () => {
  const kept = await filterMarketingSuppressed([]);
  expect(kept).toEqual([]);
});

test('fails CLOSED — propagates a suppression-load error instead of uploading everyone', async () => {
  mockPhoneThrows = true;
  await expect(filterMarketingSuppressed([{ key: 'a', phone: '9415551234' }])).rejects.toThrow();
});

test('loadMarketingSuppression exposes isSuppressed for reuse', async () => {
  mockPhoneRows = [{ phone: '9415551234' }];
  const sup = await loadMarketingSuppression();
  expect(sup.isSuppressed({ phone: '(941) 555-1234' })).toBe(true);
  expect(sup.isSuppressed({ phone: '9990001111' })).toBe(false);
});
