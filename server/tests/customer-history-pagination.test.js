const {
  HistoryValidationError,
  _private: { encodeCursor, parseCommsRequest, parseTimelineRequest, compareEvents },
} = require('../services/customer-history');

const customerId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const sourceKeys = new Set(['sms', 'invoice_created']);

test('communication request validation accepts defaults and rejects unsafe values', () => {
  expect(parseCommsRequest({}, customerId)).toMatchObject({ limit: 100, channel: 'all', cursor: null });
  for (const query of [
    { limit: '0' }, { limit: '101' }, { limit: '1.5' }, { limit: '10;drop table messages' },
    { channel: 'email' }, { channel: ['sms', 'voice'] }, { cursor: '***' },
  ]) {
    expect(() => parseCommsRequest(query, customerId)).toThrow(HistoryValidationError);
  }
});

test('communication cursor binds the snapshot, customer, and channel', () => {
  const cursor = encodeCursor({
    v: 1, kind: 'comms', customerId, filter: 'sms', readBefore: '2026-09-21T12:00:00.000Z',
    last: { at: '2026-09-20T12:00:00.000Z', id: '11111111-2222-4333-8444-555555555555' },
  });
  expect(parseCommsRequest({ channel: 'sms', cursor }, customerId).cursor.readBefore).toBe('2026-09-21T12:00:00.000Z');
  expect(() => parseCommsRequest({ channel: 'voice', cursor }, customerId)).toThrow('Cursor does not match this request');
  expect(() => parseCommsRequest({ channel: 'sms', cursor }, 'different-customer')).toThrow('Cursor does not match this request');
});

test('timeline validation binds normalized search and filter to the cursor', () => {
  const filter = JSON.stringify({ type: 'sms', search: 'term two' });
  const cursor = encodeCursor({
    v: 1, kind: 'timeline', customerId, filter, readBefore: '2026-09-21T12:00:00.000Z',
    positions: { sms: { at: '2026-09-20T12:00:00.000Z', key: 'sms:one' } }, missing: [],
  });
  expect(parseTimelineRequest({ type: 'sms', search: ' term   two ', cursor }, customerId, sourceKeys)).toMatchObject({
    type: 'sms', search: 'term two', cursor: { readBefore: '2026-09-21T12:00:00.000Z' },
  });
  expect(() => parseTimelineRequest({ type: 'call', search: 'term two', cursor }, customerId, sourceKeys)).toThrow('Cursor does not match this request');
});

test('timeline validation rejects unknown filters, oversized search, and forged positions', () => {
  expect(() => parseTimelineRequest({ type: 'notes' }, customerId, sourceKeys)).toThrow('Invalid type');
  expect(() => parseTimelineRequest({ search: 'x'.repeat(201) }, customerId, sourceKeys)).toThrow('search must be at most 200 characters');
  const cursor = encodeCursor({
    v: 1, kind: 'timeline', customerId, filter: JSON.stringify({ type: 'all', search: '' }),
    readBefore: '2026-09-21T12:00:00.000Z', positions: { unknown: { at: null, key: 'unknown:one' } }, missing: [],
  });
  expect(() => parseTimelineRequest({ cursor }, customerId, sourceKeys)).toThrow('Invalid cursor');
});

test('timeline cursor only carries validated optional-source omissions', () => {
  const filter = JSON.stringify({ type: 'all', search: '' });
  const valid = encodeCursor({
    v: 1, kind: 'timeline', customerId, filter, readBefore: '2026-09-21T12:00:00.000Z',
    positions: {}, missing: ['review'],
  });
  expect(parseTimelineRequest({ cursor: valid }, customerId, new Set(['sms', 'review']), new Set(['review'])).cursor.missing).toEqual(['review']);
  expect(() => parseTimelineRequest({ cursor: valid }, customerId, new Set(['sms', 'review']), new Set())).toThrow('Invalid cursor');
});

test('timeline ordering is stable for equal and null dates', () => {
  const rows = [
    { event_sort_us: null, event_key: 'activity:z' },
    { event_sort_us: '1789905600000000', event_key: 'sms:a' },
    { event_sort_us: '1789905600000000', event_key: 'sms:b' },
    { event_sort_us: null, event_key: 'activity:a' },
  ].sort(compareEvents);
  expect(rows.map(row => row.event_key)).toEqual(['sms:b', 'sms:a', 'activity:z', 'activity:a']);
});

test('timeline ordering retains PostgreSQL microseconds inside one JavaScript millisecond', () => {
  const rows = [
    { event_sort_us: '1789905600123001', event_key: 'sms:z' },
    { event_sort_us: '1789905600123999', event_key: 'sms:a' },
  ].sort(compareEvents);
  expect(rows.map(row => row.event_key)).toEqual(['sms:a', 'sms:z']);
});
