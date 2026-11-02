/**
 * GATE_EMAIL_DRAFT_FACTS (owner 2026-11-02): the facts block the Gmail auto-draft
 * reply gets from our own records, so the draft stops leaving blanks such as
 * [STATUS UPDATE] and [PHONE NUMBER]. Synthetic data only.
 */

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/twilio', () => ({
  deriveOutboundNumber: jest.fn(async () => '+19412972817'),
}));
jest.mock('../services/reservation-arrival', () => ({
  arrivalStartForService: jest.fn(async (conn, row) => row.window_start),
}));

const logger = require('../services/logger');
const twilio = require('../services/twilio');
const { arrivalStartForService } = require('../services/reservation-arrival');
const { buildEmailDraftFacts } = require('../services/email/email-draft-facts');

const CUSTOMER = { id: 'cust-1', first_name: 'Jane', phone: '+15555550100' };
// 4:07 PM ET on Sun Nov 1 2026: daylight time ended at 2 AM that day, so ET is UTC-5
const RECEIVED_AT = new Date('2026-11-01T21:07:00Z');

function makeConn({ visits = [], texts = [], visitsError = null } = {}) {
  const calls = { scheduled: [], sms: [] };
  const conn = jest.fn((table) => {
    const rows = table.startsWith('scheduled_services') ? visits : texts;
    const log = table.startsWith('scheduled_services') ? calls.scheduled : calls.sms;
    const builder = {};
    for (const m of ['leftJoin', 'where', 'whereIn', 'whereBetween', 'whereRaw', 'orderBy', 'limit', 'select']) {
      builder[m] = jest.fn((...args) => { log.push({ m, args }); return builder; });
    }
    builder.then = (resolve, reject) => (visitsError && table.startsWith('scheduled_services')
      ? Promise.reject(visitsError)
      : Promise.resolve(rows)).then(resolve, reject);
    return builder;
  });
  return { conn, calls };
}

const VISIT = {
  id: 'v-1',
  service_type: 'Quarterly Pest Control Service',
  scheduled_date: '2026-11-03',
  window_start: '16:00:00',
  reservation_service_mix: null,
  status: 'confirmed',
  en_route_at: null,
  arrived_at: null,
  completed_at: null,
  tech_name: 'Alex Rivera',
};

afterEach(() => {
  jest.clearAllMocks();
  twilio.deriveOutboundNumber.mockImplementation(async () => '+19412972817');
  arrivalStartForService.mockImplementation(async (conn, row) => row.window_start);
});

describe('buildEmailDraftFacts', () => {
  test('returns an empty string with no customer', async () => {
    const { conn } = makeConn();
    expect(await buildEmailDraftFacts({ customer: null, receivedAt: RECEIVED_AT, conn })).toBe('');
    expect(conn).not.toHaveBeenCalled();
  });

  test('one visit line: exact service name, ET weekday and date, arrival phrase from the helper, status, tech first name', async () => {
    const { conn, calls } = makeConn({ visits: [VISIT] });
    const facts = await buildEmailDraftFacts({ customer: CUSTOMER, receivedAt: RECEIVED_AT, conn });
    expect(facts).toContain('- Quarterly Pest Control Service | Tuesday, November 3 | between 4:00 PM and 6:00 PM | scheduled | technician Alex');
    expect(facts).not.toContain('Rivera');
    expect(arrivalStartForService).toHaveBeenCalledWith(conn, expect.objectContaining({ id: 'v-1', window_start: '16:00:00' }));
    // window: ET date of the email minus 2 days to plus 21 days, six rows at most
    expect(calls.scheduled.find((c) => c.m === 'whereBetween').args).toEqual(['ss.scheduled_date', ['2026-10-30', '2026-11-22']]);
    expect(calls.scheduled.find((c) => c.m === 'limit').args).toEqual([6]);
  });

  test('the date window follows the ET calendar day, not the UTC day (8:30 PM ET Nov 1 is already Nov 2 in UTC)', async () => {
    const { conn, calls } = makeConn({ visits: [VISIT] });
    await buildEmailDraftFacts({ customer: CUSTOMER, receivedAt: new Date('2026-11-02T01:30:00Z'), conn });
    expect(calls.scheduled.find((c) => c.m === 'whereBetween').args[1]).toEqual(['2026-10-30', '2026-11-22']);
  });

  test.each([
    [{ status: 'pending' }, '| scheduled |'],
    [{ status: 'en_route', en_route_at: '2026-11-03T21:15:00Z' }, '| technician on the way since 4:15 PM |'],
    [{ status: 'en_route' }, '| technician on the way |'],
    [{ status: 'on_site', arrived_at: '2026-11-03T21:30:00Z' }, '| technician on site since 4:30 PM |'],
    [{ status: 'completed', completed_at: '2026-11-03T22:45:00Z' }, '| completed at 5:45 PM |'],
    [{ status: 'cancelled', cancelled_at: new Date(Date.now() - 86400000).toISOString() }, '| cancelled |'],
    [{ status: 'held' }, '| held |'],
  ])('status words for %j', async (patch, expected) => {
    const { conn } = makeConn({ visits: [{ ...VISIT, ...patch }] });
    const facts = await buildEmailDraftFacts({ customer: CUSTOMER, receivedAt: RECEIVED_AT, conn });
    expect(facts).toContain(expected);
  });

  test('a visit with no technician omits the technician; a failed arrival lookup omits the arrival phrase', async () => {
    arrivalStartForService.mockRejectedValueOnce(new Error('db down'));
    const { conn } = makeConn({ visits: [{ ...VISIT, tech_name: null }] });
    const facts = await buildEmailDraftFacts({ customer: CUSTOMER, receivedAt: RECEIVED_AT, conn });
    expect(facts).toContain('- Quarterly Pest Control Service | Tuesday, November 3 | scheduled\n');
    expect(facts).not.toMatch(/\| technician /);
  });

  test('the Waves line shows in the listed format, and the tracking-link note needs a phone on file', async () => {
    const { conn } = makeConn();
    const withPhone = await buildEmailDraftFacts({ customer: CUSTOMER, receivedAt: RECEIVED_AT, conn });
    expect(twilio.deriveOutboundNumber).toHaveBeenCalledWith({ customerId: 'cust-1' });
    expect(withPhone).toContain('Phone for this customer to call or text Waves: (941) 297-2817');
    expect(withPhone).toContain('When the technician heads out, Waves sends a text with a live tracking link.');
    const noPhone = await buildEmailDraftFacts({ customer: { ...CUSTOMER, phone: null }, receivedAt: RECEIVED_AT, conn });
    expect(noPhone).toContain('Phone for this customer to call or text Waves');
    expect(noPhone).not.toContain('live tracking link');
  });

  test('texts already sent: URLs removed, whitespace collapsed, capped at 240 characters, oldest first, reservations excluded', async () => {
    const { conn, calls } = makeConn({
      texts: [
        { created_at: new Date('2026-11-01T21:09:00Z'), message_body: 'Hi Jane, we moved your visit to Tue Nov 3.\n\nDetails: https://example.test/r/abc123  see you then' },
        { created_at: new Date('2026-11-01T19:00:00Z'), message_body: `${'x'.repeat(300)}` },
        { created_at: new Date('2026-11-01T18:00:00Z'), message_body: 'https://example.test/only-a-link' },
      ],
    });
    const facts = await buildEmailDraftFacts({ customer: CUSTOMER, receivedAt: RECEIVED_AT, conn });
    const lines = facts.split('\n').filter((l) => /^- (Sat|Sun|Mon|Tue|Wed|Thu|Fri), /.test(l));
    // the query returns newest first; the block lists oldest first, so the 4:09 PM text is last
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe('- Sun, Nov 1, 4:09 PM: Hi Jane, we moved your visit to Tue Nov 3. Details: see you then');
    expect(lines[0].length).toBeLessThanOrEqual('- Sun, Nov 1, 2:00 PM: '.length + 240);
    expect(lines[0].endsWith('…')).toBe(true);
    expect(facts).not.toContain('http');
    // outbound, sent or delivered only, limit 5, reservation guard applied
    expect(calls.sms.find((c) => c.m === 'where' && c.args[0]?.direction)?.args[0]).toEqual({ customer_id: 'cust-1', direction: 'outbound' });
    expect(calls.sms.find((c) => c.m === 'whereIn').args).toEqual(['status', ['sent', 'delivered']]);
    expect(calls.sms.find((c) => c.m === 'limit').args).toEqual([5]);
    expect(calls.sms.some((c) => c.m === 'whereRaw' && /review_ask|sending/.test(String(c.args[0])))).toBe(true);
  });

  test('a query error returns an empty string and warns', async () => {
    const { conn } = makeConn({ visitsError: new Error('relation does not exist') });
    expect(await buildEmailDraftFacts({ customer: CUSTOMER, receivedAt: RECEIVED_AT, conn })).toBe('');
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('relation does not exist'));
  });

  test('a failed Waves line lookup drops only the phone line; the visits stay', async () => {
    twilio.deriveOutboundNumber.mockRejectedValueOnce(new Error('no line'));
    const { conn } = makeConn({ visits: [VISIT] });
    const facts = await buildEmailDraftFacts({ customer: CUSTOMER, receivedAt: RECEIVED_AT, conn });
    expect(facts).toContain('- Quarterly Pest Control Service | Tuesday, November 3');
    expect(facts).not.toContain('Phone for this customer');
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('no line'));
  });

  test('an old cancellation (or one with no cancel time) is housekeeping and is left out; a recent one stays', async () => {
    const recent = { ...VISIT, id: 'v-2', scheduled_date: '2026-11-04', status: 'cancelled', cancelled_at: new Date(Date.now() - 2 * 86400000).toISOString() };
    const old = { ...VISIT, id: 'v-3', scheduled_date: '2026-11-02', status: 'cancelled', cancelled_at: '2026-08-06T21:01:00Z' };
    const noStamp = { ...VISIT, id: 'v-4', scheduled_date: '2026-11-05', status: 'cancelled', cancelled_at: null };
    const { conn } = makeConn({ visits: [old, VISIT, recent, noStamp] });
    const facts = await buildEmailDraftFacts({ customer: CUSTOMER, receivedAt: RECEIVED_AT, conn });
    const visitLines = facts.split('\n').filter((l) => l.startsWith('- Quarterly'));
    expect(visitLines).toHaveLength(2);
    expect(visitLines[0]).toContain('Tuesday, November 3 | between 4:00 PM and 6:00 PM | scheduled');
    expect(visitLines[1]).toContain('Wednesday, November 4');
    expect(visitLines[1]).toContain('| cancelled |');
    expect(facts).not.toContain('November 2');
    expect(facts).not.toContain('November 5');
  });

  test('a sent text that carries a gate or lockbox code never reaches the facts', async () => {
    const { conn } = makeConn({
      texts: [
        { created_at: new Date('2026-11-01T21:09:00Z'), message_body: 'Gate code is 4821, see you Tuesday' },
        { created_at: new Date('2026-11-01T20:00:00Z'), message_body: 'Hi Jane, we moved your visit to Tue Nov 3.' },
      ],
    });
    const facts = await buildEmailDraftFacts({ customer: CUSTOMER, receivedAt: RECEIVED_AT, conn });
    expect(facts).toContain('Hi Jane, we moved your visit to Tue Nov 3.');
    expect(facts).not.toContain('4821');
    expect(facts).not.toMatch(/gate code/i);
  });

  test('the tracking-link note is left out for a known landline', async () => {
    const { conn } = makeConn();
    const facts = await buildEmailDraftFacts({ customer: { ...CUSTOMER, line_type: 'landline' }, receivedAt: RECEIVED_AT, conn });
    expect(facts).toContain('Phone for this customer to call or text Waves');
    expect(facts).not.toContain('live tracking link');
  });
});
