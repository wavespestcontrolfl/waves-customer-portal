/**
 * collections/consent-provenance.js — evidence derivation from EXISTING
 * tables (sms_log inbound, call_log inbound, leads), strongest-first, with
 * phone-variant matching and fail-closed (throwing) error policy.
 *
 * The portal-session arm is deliberately absent: the customer portal keeps
 * no customer-keyed session/last-login trace to read.
 */

jest.mock('../services/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(),
}));
jest.mock('../models/db', () => jest.fn());

const db = require('../models/db');
const ConsentProvenance = require('../services/collections/consent-provenance');

function chain({ first } = {}) {
  const q = { _calls: [] };
  ['where', 'whereIn', 'orderBy'].forEach((m) => {
    q[m] = jest.fn((...args) => { q._calls.push([m, args]); return q; });
  });
  q.first = jest.fn(async () => first);
  return q;
}

function setDbTables(tables) {
  db.mockImplementation((table) => {
    const supply = tables[table];
    if (!supply) throw new Error(`Unexpected db table ${table}`);
    return supply;
  });
}

beforeEach(() => jest.clearAllMocks());

describe('phone normalization', () => {
  test('phoneVariants covers E.164, bare-10, and 1-prefixed forms', () => {
    expect(ConsentProvenance.phoneVariants('(941) 555-0100')).toEqual(
      expect.arrayContaining(['+19415550100', '9415550100', '19415550100']),
    );
    expect(ConsentProvenance.phoneVariants('+19415550100')).toEqual(
      expect.arrayContaining(['+19415550100', '9415550100', '19415550100']),
    );
  });

  test('empty / missing phones produce no variants', () => {
    expect(ConsentProvenance.phoneVariants('')).toEqual([]);
    expect(ConsentProvenance.phoneVariants(null)).toEqual([]);
  });
});

describe('resolve — strongest evidence first', () => {
  test('inbound SMS from the number wins', async () => {
    setDbTables({
      sms_log: chain({ first: { id: 'sms-1', created_at: '2026-08-01T12:00:00Z' } }),
    });
    const evidence = await ConsentProvenance.resolve('cust-1', '+19415550100');
    expect(evidence).toEqual({
      source: 'inbound_sms', evidenceRef: 'sms-1', evidenceAt: '2026-08-01T12:00:00Z',
    });
  });

  test('the sms arm queries inbound rows for THIS customer across the phone variants', async () => {
    const smsChain = chain({ first: { id: 'sms-1', created_at: '2026-08-01T12:00:00Z' } });
    setDbTables({ sms_log: smsChain });
    await ConsentProvenance.resolve('cust-1', '9415550100');
    expect(smsChain.where).toHaveBeenCalledWith({ customer_id: 'cust-1', direction: 'inbound' });
    expect(smsChain.whereIn).toHaveBeenCalledWith(
      'from_phone',
      expect.arrayContaining(['+19415550100', '9415550100', '19415550100']),
    );
  });

  test('no inbound SMS → inbound call is next', async () => {
    setDbTables({
      sms_log: chain({ first: undefined }),
      call_log: chain({ first: { id: 'call-1', created_at: '2026-07-15T12:00:00Z' } }),
    });
    const evidence = await ConsentProvenance.resolve('cust-1', '+19415550100');
    expect(evidence).toEqual({
      source: 'inbound_call', evidenceRef: 'call-1', evidenceAt: '2026-07-15T12:00:00Z',
    });
  });

  test('no inbound traffic → lead intake carrying the phone (first_contact_at preferred)', async () => {
    setDbTables({
      sms_log: chain({ first: undefined }),
      call_log: chain({ first: undefined }),
      leads: chain({ first: { id: 'lead-1', created_at: '2026-06-02T12:00:00Z', first_contact_at: '2026-06-01T12:00:00Z' } }),
    });
    const evidence = await ConsentProvenance.resolve('cust-1', '+19415550100');
    expect(evidence).toEqual({
      source: 'lead_form', evidenceRef: 'lead-1', evidenceAt: '2026-06-01T12:00:00Z',
    });
  });

  test('no evidence anywhere → null', async () => {
    setDbTables({
      sms_log: chain({ first: undefined }),
      call_log: chain({ first: undefined }),
      leads: chain({ first: undefined }),
    });
    expect(await ConsentProvenance.resolve('cust-1', '+19415550100')).toBeNull();
  });

  test('no customer id / no usable phone → null without querying', async () => {
    setDbTables({});
    expect(await ConsentProvenance.resolve(null, '+19415550100')).toBeNull();
    expect(await ConsentProvenance.resolve('cust-1', '')).toBeNull();
    expect(db).not.toHaveBeenCalled();
  });

  test('FAIL CLOSED: a read error THROWS (never degrades to a weaker arm)', async () => {
    setDbTables({});
    db.mockImplementation(() => { throw new Error('sms_log unreadable'); });
    await expect(ConsentProvenance.resolve('cust-1', '+19415550100')).rejects.toThrow('sms_log unreadable');
  });
});

describe('freshness — most recent customer-initiated contact', () => {
  test('returns the max timestamp across all arms', async () => {
    setDbTables({
      sms_log: chain({ first: { id: 's', created_at: '2026-08-01T12:00:00Z' } }),
      call_log: chain({ first: { id: 'c', created_at: '2026-08-05T12:00:00Z' } }),
      leads: chain({ first: { id: 'l', created_at: '2026-05-01T12:00:00Z', first_contact_at: null } }),
    });
    const at = await ConsentProvenance.freshness('cust-1', '+19415550100');
    expect(at).toEqual(new Date('2026-08-05T12:00:00Z'));
  });

  test('no contact anywhere → null', async () => {
    setDbTables({
      sms_log: chain({ first: undefined }),
      call_log: chain({ first: undefined }),
      leads: chain({ first: undefined }),
    });
    expect(await ConsentProvenance.freshness('cust-1', '+19415550100')).toBeNull();
  });
});
