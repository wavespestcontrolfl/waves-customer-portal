/**
 * Lead-side and phone-evidence conversion checks (services/estimate-conversion-since.js),
 * the helpers the estimate engagement engine runs for estimates with no customer_id.
 */

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/estimate-conversion-guard', () => ({
  customerConvertedSince: jest.fn(async () => ({ converted: false })),
  NON_LIVE_APPOINTMENT_STATUSES: ['cancelled', 'rescheduled', 'skipped', 'no_show'],
}));

const db = require('../models/db');
const { customerConvertedSince } = require('../services/estimate-conversion-guard');
const { leadConvertedSince, phoneConvertedSince } = require('../services/estimate-conversion-since');

let queues;
function enqueue(table, value) { (queues[table] = queues[table] || []).push(value); }
function makeBuilder(table, cfg) {
  const b = {};
  for (const m of ['join', 'where', 'whereRaw', 'whereNotIn']) b[m] = jest.fn(() => b);
  b.first = jest.fn(async () => {
    if (cfg && cfg.error) throw cfg.error;
    return cfg ? cfg.row : undefined;
  });
  return b;
}

const EST = { id: 'est-1', created_at: new Date('2026-10-01T12:00:00Z') };
const SINCE = new Date('2026-10-02T12:00:00Z');

beforeEach(() => {
  jest.clearAllMocks();
  queues = {};
  db.mockImplementation((table) => makeBuilder(table, (queues[table] || []).shift()));
  customerConvertedSince.mockResolvedValue({ converted: false });
});

describe('leadConvertedSince', () => {
  test('no lead id is not converted', async () => {
    expect(await leadConvertedSince(null, EST)).toEqual({ converted: false });
    expect(db).not.toHaveBeenCalled();
  });

  test('a won lead is converted', async () => {
    enqueue('leads', { row: { id: 'lead-1', status: 'won', customer_id: null, converted_at: null } });
    expect(await leadConvertedSince('lead-1', EST)).toEqual({ converted: true, reason: 'lead-won' });
  });

  test('a lead with a conversion stamp is converted', async () => {
    enqueue('leads', { row: { id: 'lead-1', status: 'new', customer_id: null, converted_at: new Date() } });
    expect(await leadConvertedSince('lead-1', EST)).toEqual({ converted: true, reason: 'lead-converted' });
  });

  test('a linked customer runs through the conversion guard', async () => {
    enqueue('leads', { row: { id: 'lead-1', status: 'new', customer_id: 'cust-9', converted_at: null } });
    customerConvertedSince.mockResolvedValue({ converted: true, reason: 'paid-invoice' });
    const out = await leadConvertedSince('lead-1', EST);
    expect(out).toEqual({ converted: true, reason: 'paid-invoice' });
    expect(customerConvertedSince).toHaveBeenCalledWith({ id: 'est-1', customer_id: 'cust-9', created_at: EST.created_at });
  });

  test('an open lead with no customer is not converted', async () => {
    enqueue('leads', { row: { id: 'lead-1', status: 'new', customer_id: null, converted_at: null } });
    expect(await leadConvertedSince('lead-1', EST)).toEqual({ converted: false });
  });

  test('a lookup error fails closed', async () => {
    enqueue('leads', { error: new Error('db down') });
    expect(await leadConvertedSince('lead-1', EST)).toEqual({ converted: true, reason: 'guard-error' });
  });
});

describe('phoneConvertedSince', () => {
  test('no usable phone or anchor is not converted', async () => {
    expect(await phoneConvertedSince('', SINCE)).toEqual({ converted: false });
    expect(await phoneConvertedSince('+19415550101', null)).toEqual({ converted: false });
    expect(await phoneConvertedSince('+19415550101', 'not-a-date')).toEqual({ converted: false });
    expect(db).not.toHaveBeenCalled();
  });

  test('a customer row created after the anchor is converted', async () => {
    enqueue('customers', { row: { id: 'new-cust' } });
    expect(await phoneConvertedSince('+19415550101', SINCE)).toEqual({ converted: true, reason: 'phone-customer-created' });
  });

  test('a live booking for a customer with that phone is converted', async () => {
    enqueue('customers', { row: null });
    enqueue('scheduled_services as ss', { row: { id: 'ss-9' } });
    expect(await phoneConvertedSince('+19415550101', SINCE)).toEqual({ converted: true, reason: 'phone-booking' });
  });

  test('no evidence is not converted', async () => {
    enqueue('customers', { row: null });
    enqueue('scheduled_services as ss', { row: null });
    expect(await phoneConvertedSince('+19415550101', SINCE)).toEqual({ converted: false });
  });

  test('a lookup error fails closed', async () => {
    enqueue('customers', { error: new Error('db down') });
    expect(await phoneConvertedSince('+19415550101', SINCE)).toEqual({ converted: true, reason: 'guard-error' });
  });
});
