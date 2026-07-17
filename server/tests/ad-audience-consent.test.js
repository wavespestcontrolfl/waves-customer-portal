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

// ── r2 (Codex): reason-aware phone suppression + canonical email matching ──

test('non_mobile rows are delivery signals, NOT opt-outs — member kept in full', async () => {
  mockPhoneRows = [{ phone: '9415551234', reason: 'non_mobile' }];
  const kept = await filterMarketingSuppressed([
    { key: 'lead:1', phone: '9415551234', email: 'landline@example.com' },
  ]);
  expect(kept).toHaveLength(1);
  expect(kept[0].phone).toBe('9415551234'); // phone untouched — landline ≠ consent withdrawal
});

test('wrong_number strips the (stranger\'s) phone but keeps the member via email', async () => {
  mockPhoneRows = [{ phone: '9415551234', reason: 'wrong_number' }];
  const kept = await filterMarketingSuppressed([
    { key: 'lead:1', phone: '9415551234', email: 'real.person@example.com' },
  ]);
  expect(kept).toHaveLength(1);
  expect(kept[0].phone).toBeNull();
  expect(kept[0].email).toBe('real.person@example.com');
});

test('wrong_number with no email leaves no usable identifier — member dropped', async () => {
  mockPhoneRows = [{ phone: '9415551234', reason: 'wrong_number' }];
  const kept = await filterMarketingSuppressed([
    { key: 'lead:1', phone: '9415551234', email: null },
  ]);
  expect(kept).toHaveLength(0);
});

test('explicit opt-out reasons still drop the whole person', async () => {
  mockPhoneRows = [
    { phone: '9415551111', reason: 'opt_out_keyword' },
    { phone: '9415552222', reason: 'manual_dnc' },
  ];
  const kept = await filterMarketingSuppressed([
    { key: 'a', phone: '9415551111', email: 'still.has.email@example.com' },
    { key: 'b', phone: '9415552222', email: null },
    { key: 'c', phone: '9415553333', email: null },
  ]);
  expect(kept.map((m) => m.key)).toEqual(['c']);
});

test('gmail suppressions match dot/+tag variants (Google canonical form)', async () => {
  mockEmailRows = [{ email: 'opted.out@gmail.com' }];
  const kept = await filterMarketingSuppressed([
    { key: 'lead:1', email: 'optedout+promo@gmail.com', phone: null }, // same canonical person
    { key: 'lead:2', email: 'o.p.t.e.d.out@gmail.com', phone: null },  // same canonical person
    { key: 'lead:3', email: 'different@gmail.com', phone: null },
  ]);
  expect(kept.map((m) => m.key)).toEqual(['lead:3']);
});

test('identifiers-only mode keeps opted-out PEOPLE (exclusion audiences) but still strips wrong_number phones', async () => {
  mockPhoneRows = [
    { phone: '9415551111', reason: 'opt_out_keyword' },
    { phone: '9415552222', reason: 'wrong_number' },
  ];
  const kept = await filterMarketingSuppressed([
    { key: 'customer:1', phone: '9415551111', email: 'opted.out@example.com' }, // opted out — KEPT (exclusion list)
    { key: 'customer:2', phone: '9415552222', email: 'x@example.com' },         // stranger's phone — stripped
  ], { audienceKey: 'customers', mode: 'identifiers-only' });
  expect(kept.map((m) => m.key)).toEqual(['customer:1', 'customer:2']);
  expect(kept[0].phone).toBe('9415551111');
  expect(kept[1].phone).toBeNull();
});

test('loadMarketingSuppression exposes raw identifiers for platform-side removal', async () => {
  mockPhoneRows = [
    { phone: '+1 (941) 555-1234', reason: 'opt_out_keyword' },
    { phone: '9415559999', reason: 'non_mobile' }, // NOT exported — not an opt-out
  ];
  mockEmailRows = [{ email: 'Opted.Out@Example.com' }];
  const sup = await loadMarketingSuppression();
  expect(sup.rawOptOutPhones).toEqual(['+1 (941) 555-1234']);
  expect(sup.rawOptOutEmails).toEqual(['Opted.Out@Example.com']);
});

// ── r3 (Codex): preference-group scope ───────────────────────────────

test('a stream-scoped unsubscribe (service_operational) is NOT an ads opt-out', async () => {
  mockEmailRows = [{ email: 'a@x.com', suppression_type: 'unsubscribe', group_key: 'service_operational' }];
  const kept = await filterMarketingSuppressed([{ key: 'lead:1', email: 'a@x.com', phone: null }]);
  expect(kept).toHaveLength(1);
});

test('a marketing-stream unsubscribe IS an ads opt-out', async () => {
  mockEmailRows = [{ email: 'a@x.com', suppression_type: 'unsubscribe', group_key: 'marketing_newsletter' }];
  const kept = await filterMarketingSuppressed([{ key: 'lead:1', email: 'a@x.com', phone: null }]);
  expect(kept).toHaveLength(0);
});

test('spam_complaint / do_not_email suppress regardless of group scope', async () => {
  mockEmailRows = [
    { email: 'a@x.com', suppression_type: 'spam_complaint', group_key: 'service_operational' },
    { email: 'b@x.com', suppression_type: 'do_not_email', group_key: 'service_operational' },
  ];
  const kept = await filterMarketingSuppressed([
    { key: 'lead:1', email: 'a@x.com', phone: null },
    { key: 'lead:2', email: 'b@x.com', phone: null },
  ]);
  expect(kept).toHaveLength(0);
});

test('partitionMarketingSuppressed returns the dropped members for removal hashing', async () => {
  const { partitionMarketingSuppressed } = require('../services/ads/ad-audience-consent');
  mockEmailRows = [{ email: 'opted@x.com' }];
  const { kept, dropped } = await partitionMarketingSuppressed([
    { key: 'lead:1', email: 'opted@x.com', phone: '9415551111' },
    { key: 'lead:2', email: 'fine@x.com', phone: null },
  ]);
  expect(kept.map((m) => m.key)).toEqual(['lead:2']);
  expect(dropped.map((m) => m.key)).toEqual(['lead:1']);
});
