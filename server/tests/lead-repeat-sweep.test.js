/**
 * Lead repeat sweep — the pure "same person's earlier open lead" rules and the
 * gate. The SQL, the row lock and the whole nightly run are covered against
 * PostgreSQL in lead-repeat-sweep-postgres.test.js.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ leadRepeatSweepLive: jest.fn(() => false) }));
jest.mock('../services/lead-funnel-bridge', () => ({ bridgeLeadFunnelStage: jest.fn() }));

const { leadRepeatSweepLive } = require('../config/feature-gates');
const { bridgeLeadFunnelStage } = require('../services/lead-funnel-bridge');
const { runLeadRepeatSweep, isSamePersonRoot, _test } = require('../services/lead-repeat-sweep');

const { namesAgree, differentPremise, mergeableExtractedData, phoneLast10 } = _test;

const ROOT = {
  id: 'root-1',
  phone: '+19415550100',
  first_name: 'Pat',
  last_name: 'Sample',
  customer_id: 'cust-1',
  address: '12 Sample Ct, Parrish, FL 34219',
  city: 'Parrish',
  zip: '34219',
  first_contact_at: new Date('2026-10-27T14:22:00Z'),
  status: 'new',
};
const LEAD = {
  ...ROOT,
  id: 'lead-2',
  phone: '(941) 555-0100',
  first_contact_at: new Date('2026-10-30T14:25:00Z'),
};

describe('isSamePersonRoot', () => {
  it('matches the same person: same phone in any format, earlier root, names, customer and street', () => {
    expect(isSamePersonRoot(LEAD, ROOT)).toBe(true);
    expect(phoneLast10('+1 (941) 555-0100')).toBe('9415550100');
    expect(phoneLast10('555-0100')).toBe(null);
  });

  it('needs the root to be the earlier touch and to share the phone', () => {
    expect(isSamePersonRoot(LEAD, { ...ROOT, first_contact_at: new Date('2026-10-31T00:00:00Z') })).toBe(false);
    expect(isSamePersonRoot(LEAD, { ...ROOT, phone: '+19415550199' })).toBe(false);
    expect(isSamePersonRoot({ ...LEAD, phone: null }, ROOT)).toBe(false);
  });

  it('refuses two customer rows, and allows one side unlinked', () => {
    expect(isSamePersonRoot({ ...LEAD, customer_id: 'cust-2' }, ROOT)).toBe(false);
    expect(isSamePersonRoot({ ...LEAD, customer_id: null }, ROOT)).toBe(true);
    expect(isSamePersonRoot(LEAD, { ...ROOT, customer_id: null })).toBe(true);
  });

  it('refuses two properties: another street, another unit, another ZIP', () => {
    expect(isSamePersonRoot({ ...LEAD, address: '40 Other Rd, Parrish, FL 34219' }, ROOT)).toBe(false);
    expect(isSamePersonRoot({ ...LEAD, address: '12 Sample Ct Apt 2, Parrish, FL 34219' },
      { ...ROOT, address: '12 Sample Ct Apt 3, Parrish, FL 34219' })).toBe(false);
    expect(isSamePersonRoot({ ...LEAD, zip: '34221', address: '12 Sample Ct' }, { ...ROOT, address: '12 Sample Ct' })).toBe(false);
  });

  it('a missing or unparsable address is no evidence either way', () => {
    expect(isSamePersonRoot({ ...LEAD, address: null }, ROOT)).toBe(true);
    expect(isSamePersonRoot({ ...LEAD, address: '12912' }, ROOT)).toBe(true);
    expect(differentPremise({ address: null }, { address: null })).toBe(false);
    // The same street spelled out matches its short form.
    expect(differentPremise({ address: '12 Sample Court, Parrish, FL 34219' }, ROOT)).toBe(false);
  });
});

describe('namesAgree', () => {
  it('needs a first or last name present on both rows and no conflicting part', () => {
    expect(namesAgree({ first_name: 'Pat', last_name: 'Sample' }, { first_name: 'pat', last_name: 'sample' })).toBe(true);
    expect(namesAgree({ first_name: 'Pat', last_name: '' }, { first_name: 'Pat', last_name: 'Sample' })).toBe(true);
    expect(namesAgree({ first_name: '', last_name: 'Sample' }, { first_name: 'Pat', last_name: 'Sample' })).toBe(true);
  });

  it('refuses a conflicting part (a household member) and two unnamed rows', () => {
    expect(namesAgree({ first_name: 'Sam', last_name: 'Sample' }, { first_name: 'Alex', last_name: 'Sample' })).toBe(false);
    expect(namesAgree({ first_name: 'Sam', last_name: '' }, { first_name: 'Alex', last_name: '' })).toBe(false);
    expect(namesAgree({ first_name: '', last_name: '' }, { first_name: '', last_name: '' })).toBe(false);
    expect(namesAgree({ first_name: 'Unknown', last_name: null }, { first_name: 'unknown', last_name: null })).toBe(false);
    expect(namesAgree({ first_name: 'Pat', last_name: null }, { first_name: '', last_name: 'Sample' })).toBe(false);
  });
});

describe('mergeableExtractedData', () => {
  it('merges into an object or nothing, never over another JSON shape', () => {
    expect(mergeableExtractedData(null)).toBe(true);
    expect(mergeableExtractedData(undefined)).toBe(true);
    expect(mergeableExtractedData({})).toBe(true);
    expect(mergeableExtractedData({ source: 'form' })).toBe(true);
    expect(mergeableExtractedData('{"a":1}')).toBe(false);
    expect(mergeableExtractedData([1])).toBe(false);
  });
});

describe('runLeadRepeatSweep gate', () => {
  it('gate off: reads and writes nothing', async () => {
    leadRepeatSweepLive.mockReturnValue(false);
    const dbi = jest.fn();
    expect(await runLeadRepeatSweep({ dbi })).toEqual({ skipped: 'gate_off' });
    expect(dbi).not.toHaveBeenCalled();
    expect(bridgeLeadFunnelStage).not.toHaveBeenCalled();
  });
});
