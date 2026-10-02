/**
 * Scheduling drafts out of silent shadow (GATE_SMS_SCHEDULING_SUGGEST, dark):
 * a scheduling-intent draft whose offered times came from a booking picker
 * becomes a staff suggestion card — never an auto-send — and every other
 * scheduling draft stays shadow.
 */
let mockModeRow = { mode: 'auto_send' };
jest.mock('../models/db', () => {
  const builder = { where: () => builder, first: async () => mockModeRow };
  return jest.fn(() => builder);
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const suggest = require('../services/sms-suggest-mode');

const GATE = 'GATE_SMS_SCHEDULING_SUGGEST';
const VISIT = '11111111-1111-4111-8111-111111111111';
const WINDOWS = [{ date: 'Tuesday, October 6', window: '10:00 AM - 12:00 PM' }];
const picker = (lookup) => ({ lookup: { city: 'Testville', customerId: 'c1', estimateId: null, ...lookup }, quotedWindows: WINDOWS });
const BASE = {
  reply: 'We can do Tuesday, October 6 10:00 AM - 12:00 PM. Does that work?',
  customerId: 'c1',
  smsLogId: 's1',
  intent: 'general_customer_sms_needs_review',
  schedulingIntent: true,
};

afterEach(() => { delete process.env[GATE]; mockModeRow = { mode: 'auto_send' }; });

describe('isPickerOfferSnapshot', () => {
  test('each picker source with the id its recheck uses counts', () => {
    expect(suggest.isPickerOfferSnapshot(picker({ source: 'scheduler', scheduledServiceId: VISIT }))).toBe(true);
    expect(suggest.isPickerOfferSnapshot(picker({ source: 'estimate', estimateId: 'e1' }))).toBe(true);
    expect(suggest.isPickerOfferSnapshot(picker({ source: 'book', serviceKey: 'pest_control' }))).toBe(true);
  });

  test('a legacy zone-finder snapshot, a missing id, or no quoted window does not', () => {
    expect(suggest.isPickerOfferSnapshot(picker({}))).toBe(false);
    expect(suggest.isPickerOfferSnapshot(picker({ source: 'scheduler' }))).toBe(false);
    expect(suggest.isPickerOfferSnapshot(picker({ source: 'book' }))).toBe(false);
    expect(suggest.isPickerOfferSnapshot({ ...picker({ source: 'scheduler', scheduledServiceId: VISIT }), quotedWindows: [] })).toBe(false);
    expect(suggest.isPickerOfferSnapshot(null)).toBe(false);
  });
});

describe('suggestionEligible for scheduling drafts', () => {
  const snapshot = picker({ source: 'scheduler', scheduledServiceId: VISIT });

  test('gate off: a scheduling draft stays ineligible even with a picker snapshot', () => {
    expect(suggest.suggestionEligible({ ...BASE, openTimesSnapshot: snapshot })).toBe(false);
  });

  test('gate on: eligible only with a picker snapshot', () => {
    process.env[GATE] = 'true';
    expect(suggest.suggestionEligible({ ...BASE, openTimesSnapshot: snapshot })).toBe(true);
    expect(suggest.suggestionEligible({ ...BASE, openTimesSnapshot: picker({}) })).toBe(false);
    expect(suggest.suggestionEligible(BASE)).toBe(false);
  });

  test('gate on: the other hard rules still hold (escalation, no inbound link)', () => {
    process.env[GATE] = 'true';
    expect(suggest.suggestionEligible({ ...BASE, openTimesSnapshot: snapshot, intent: 'customer_issue_needs_review' })).toBe(false);
    expect(suggest.suggestionEligible({ ...BASE, openTimesSnapshot: snapshot, smsLogId: null })).toBe(false);
  });
});

describe('resolveDeliveryMode for scheduling drafts', () => {
  const snapshot = picker({ source: 'book', serviceKey: 'pest_control' });

  test('gate on + picker snapshot: a suggestion, even when the intent sits on the auto-send rung', async () => {
    process.env[GATE] = 'true';
    mockModeRow = { mode: 'auto_send' };
    await expect(suggest.resolveDeliveryMode({ ...BASE, openTimesSnapshot: snapshot })).resolves.toBe('suggest');
    mockModeRow = { mode: 'shadow' };
    await expect(suggest.resolveDeliveryMode({ ...BASE, openTimesSnapshot: snapshot })).resolves.toBe('suggest');
  });

  test('gate off, or no picker snapshot: shadow, as before', async () => {
    await expect(suggest.resolveDeliveryMode({ ...BASE, openTimesSnapshot: snapshot })).resolves.toBe('shadow');
    process.env[GATE] = 'true';
    await expect(suggest.resolveDeliveryMode(BASE)).resolves.toBe('shadow');
  });

  test('a non-scheduling draft is unchanged by the gate (its intent rung decides)', async () => {
    process.env[GATE] = 'true';
    mockModeRow = { mode: 'shadow' };
    await expect(suggest.resolveDeliveryMode({ ...BASE, schedulingIntent: false, openTimesSnapshot: snapshot })).resolves.toBe('shadow');
  });
});

describe('excludeGatedSchedulingSuggestions (rollback fails closed)', () => {
  const fakeQuery = () => { const q = { whereRaw: jest.fn(() => q) }; return q; };

  test('gate on: the query is untouched', () => {
    process.env[GATE] = 'true';
    const q = fakeQuery();
    expect(suggest.excludeGatedSchedulingSuggestions(q, 'ad')).toBe(q);
    expect(q.whereRaw).not.toHaveBeenCalled();
  });

  test('gate off: published scheduling cards (suggest workflow + scheduling draft) are excluded', () => {
    const q = fakeQuery();
    suggest.excludeGatedSchedulingSuggestions(q, 'ad');
    const [sql, bindings] = q.whereRaw.mock.calls[0];
    expect(sql).toMatch(/NOT \(ad\.workflow = \? AND EXISTS/);
    expect(sql).toMatch(/gated_md\.id = ad\.entity_id AND gated_md\.scheduling_intent = true/);
    expect(bindings).toEqual([suggest.SUGGEST_WORKFLOW]);
  });

  test('an alias that is not a plain identifier is refused', () => {
    expect(() => suggest.excludeGatedSchedulingSuggestions(fakeQuery(), 'ad; drop')).toThrow(/bad alias/);
  });
});

describe('decisionIsGatedSchedulingSuggestion (a queued scheduling card does not fire after rollback)', () => {
  const dbReturning = (row, { fail = false } = {}) => {
    const builder = { join: () => builder, where: () => builder, first: async () => { if (fail) throw new Error('boom'); return row; } };
    return jest.fn(() => builder);
  };

  test('gate on: nothing is read and the send proceeds', async () => {
    process.env[GATE] = 'true';
    const dbh = dbReturning({ scheduling_intent: true });
    await expect(suggest.decisionIsGatedSchedulingSuggestion({ decisionId: 'd1', dbh })).resolves.toBe(false);
    expect(dbh).not.toHaveBeenCalled();
  });

  test('gate off: a scheduling suggestion is blocked; any other decision is not', async () => {
    await expect(suggest.decisionIsGatedSchedulingSuggestion({ decisionId: 'd1', dbh: dbReturning({ scheduling_intent: true }) })).resolves.toBe(true);
    await expect(suggest.decisionIsGatedSchedulingSuggestion({ decisionId: 'd1', dbh: dbReturning({ scheduling_intent: false }) })).resolves.toBe(false);
    await expect(suggest.decisionIsGatedSchedulingSuggestion({ decisionId: 'd1', dbh: dbReturning(undefined) })).resolves.toBe(false);
  });

  test('gate off: an unreadable row fails closed', async () => {
    await expect(suggest.decisionIsGatedSchedulingSuggestion({ decisionId: 'd1', dbh: dbReturning(null, { fail: true }) })).resolves.toBe(true);
  });
});
