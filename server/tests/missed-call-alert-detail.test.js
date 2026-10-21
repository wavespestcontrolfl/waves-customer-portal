// GATE_MISSED_CALL_ALERT_DETAIL: the missed-call bell/push body names the
// line, the call length and a customer's next visit. Off = today's sentence,
// byte for byte, in both the payload and the copy. Admin copy only.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => false) }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn() }));
jest.mock('../services/push-notifications', () => ({ sendToAdminUsers: jest.fn() }));

const db = require('../models/db');
const { isEnabled } = require('../config/feature-gates');
const {
  detailPayload, formatMissedCallBody, shortLineLabel, visitDayLabel, nextVisitDate,
} = require('../services/missed-call-alert-detail');
const { TRIGGER_REGISTRY } = require('../services/notification-triggers');

const ORIGINAL = (phone) => `${phone} called and did not leave a voicemail.`;

function visitQuery(result) {
  const chain = {};
  for (const m of ['where', 'whereNotIn', 'orderBy']) chain[m] = jest.fn(() => chain);
  chain.first = jest.fn(async () => { if (result instanceof Error) throw result; return result; });
  db.mockReturnValue(chain);
  return chain;
}

beforeEach(() => {
  jest.clearAllMocks();
  isEnabled.mockImplementation(() => false);
});

describe('copy', () => {
  test('without detail fields the body is the original sentence, byte for byte', () => {
    expect(formatMissedCallBody({ phone: '(941) 555-0100' })).toBe(ORIGINAL('(941) 555-0100'));
    expect(formatMissedCallBody({})).toBe(ORIGINAL('unknown number'));
    const built = TRIGGER_REGISTRY.customer_missed_call.build({ name: 'Pat Synthetic', phone: '(941) 555-0100', callLogId: 'c1' });
    expect(built.body).toBe(ORIGINAL('(941) 555-0100'));
    expect(built.title).toBe('Missed call — Pat Synthetic');
  });

  test('with detail fields the body names the line, the seconds and the next visit', () => {
    const body = formatMissedCallBody({ phone: '(941) 555-0100', line: 'Parrish (Pest)', durationSeconds: 12, nextVisitDate: '2026-10-22' });
    expect(body).toBe('(941) 555-0100 called Parrish (Pest), 12 sec, no voicemail. Next visit Thu Oct 22.');
    expect(body.length).toBeLessThanOrEqual(110);
    const built = TRIGGER_REGISTRY.customer_missed_call.build({ phone: '(941) 555-0100', callLogId: 'c1', line: 'Parrish (Pest)', durationSeconds: 12, nextVisitDate: '2026-10-22' });
    expect(built.body).toBe(body);
  });

  test('a missing piece is left out, not printed as blank', () => {
    expect(formatMissedCallBody({ phone: '(941) 555-0100', durationSeconds: 7 })).toBe('(941) 555-0100 called, 7 sec, no voicemail.');
    expect(formatMissedCallBody({ phone: '(941) 555-0100', line: 'Venice (Pest)' })).toBe('(941) 555-0100 called Venice (Pest), no voicemail.');
    expect(formatMissedCallBody({ phone: '(941) 555-0100', durationSeconds: 0 })).toBe('(941) 555-0100 called, 0 sec, no voicemail.');
  });

  test('the longest line label still keeps the body inside 110 characters', () => {
    const line = shortLineLabel('Lakewood Ranch GBP — Bradenton office (Pest) and a very long extra name');
    const body = formatMissedCallBody({ phone: '(941) 555-0100', line, durationSeconds: 245, nextVisitDate: '2026-12-29' });
    expect(body.length).toBeLessThanOrEqual(110);
  });

  test('line labels shorten; the unknown placeholder is dropped', () => {
    expect(shortLineLabel('Lakewood Ranch GBP — Bradenton office (Pest)')).toBe('Bradenton office (Pest)');
    expect(shortLineLabel('GBP — Parrish')).toBe('Parrish');
    expect(shortLineLabel('Waves Main Line')).toBe('Waves Main Line');
    expect(shortLineLabel('unknown')).toBeNull();
    expect(shortLineLabel('')).toBeNull();
    expect(shortLineLabel(null)).toBeNull();
  });

  test('visit day label reads like a person says it, never ISO', () => {
    expect(visitDayLabel('2026-10-22')).toBe('Thu Oct 22');
    expect(visitDayLabel('not a date')).toBeNull();
    expect(visitDayLabel(null)).toBeNull();
  });
});

describe('payload', () => {
  const row = { id: 'call-1', customer_id: 'cust-1', duration_seconds: 12, metadata: { location: 'Parrish (Pest)' } };

  test('gate off adds nothing and runs no query', async () => {
    expect(await detailPayload(row)).toEqual({});
    expect(db).not.toHaveBeenCalled();
  });

  test('gate on adds line, seconds and the next visit', async () => {
    isEnabled.mockImplementation((g) => g === 'missedCallAlertDetail');
    const chain = visitQuery({ scheduled_date: new Date('2026-10-22T00:00:00Z') });
    expect(await detailPayload(row, new Date('2026-10-20T15:00:00Z'))).toEqual({
      line: 'Parrish (Pest)', durationSeconds: 12, nextVisitDate: '2026-10-22',
    });
    expect(db).toHaveBeenCalledWith('scheduled_services');
    expect(chain.where).toHaveBeenCalledWith({ customer_id: 'cust-1' });
    expect(chain.whereNotIn).toHaveBeenCalledWith('status', ['cancelled', 'completed', 'rescheduled']);
    expect(chain.where).toHaveBeenCalledWith('scheduled_date', '>=', '2026-10-20');
    expect(chain.orderBy).toHaveBeenCalledWith('scheduled_date', 'asc');
  });

  test('an unknown caller has no visit lookup', async () => {
    isEnabled.mockImplementation((g) => g === 'missedCallAlertDetail');
    expect(await detailPayload({ id: 'c', customer_id: null, duration_seconds: 20, metadata: { location: 'unknown' } }))
      .toEqual({ durationSeconds: 20 });
    expect(db).not.toHaveBeenCalled();
  });

  test('a failed or empty visit lookup leaves the visit out and does not throw', async () => {
    isEnabled.mockImplementation((g) => g === 'missedCallAlertDetail');
    visitQuery(new Error('db down'));
    expect(await nextVisitDate('cust-1')).toBeNull();
    visitQuery(undefined);
    expect(await detailPayload(row)).toEqual({ line: 'Parrish (Pest)', durationSeconds: 12 });
  });

  test('metadata may arrive as a JSON string', async () => {
    isEnabled.mockImplementation((g) => g === 'missedCallAlertDetail');
    expect(await detailPayload({ customer_id: null, duration_seconds: null, metadata: '{"location":"GBP — Venice"}' }))
      .toEqual({ line: 'Venice' });
  });
});
