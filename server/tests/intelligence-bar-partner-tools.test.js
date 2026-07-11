// Partner-channel IB tools (2026-07-11). Born from the call audit: WDO/
// real-estate calls come from REPEAT B2B arrangers (realtors, lenders,
// property managers) booking for other people — a channel, not walk-ins.
jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.raw = jest.fn((sql) => ({ toString: () => sql, sql }));
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const db = require('../models/db');
const { COMMS_TOOLS, COMMS_READ_TOOLS, executeCommsTool } = require('../services/intelligence-bar/comms-tools');
const { UI_GATED_WRITE_TOOL_NAMES } = require('../services/intelligence-bar/write-gates');

function rowsChain(rows) {
  const q = {};
  ['where', 'whereRaw', 'select', 'orderBy'].forEach((m) => { q[m] = jest.fn(() => q); });
  q.limit = jest.fn(async () => rows);
  return q;
}

beforeEach(() => jest.clearAllMocks());

describe('registration', () => {
  test('both partner tools are registered and in the cross-context READ set', () => {
    const names = COMMS_TOOLS.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['list_call_partners', 'get_partner_call_history']));
    const readNames = COMMS_READ_TOOLS.map((t) => t.name);
    expect(readNames).toEqual(expect.arrayContaining(['list_call_partners', 'get_partner_call_history']));
  });

  test('read-only: neither tool is (or should be) in the UI-confirm write gate set', () => {
    expect(UI_GATED_WRITE_TOOL_NAMES.has('list_call_partners')).toBe(false);
    expect(UI_GATED_WRITE_TOOL_NAMES.has('get_partner_call_history')).toBe(false);
  });
});

describe('list_call_partners aggregation', () => {
  const mkRow = (over = {}) => ({
    phone_key: '4074933469', from_phone: '+14074933469',
    created_at: '2026-07-08T21:38:00.000Z',
    call_summary: 'Realtor Melissa called to urgently schedule a WDO inspection.',
    caller_name: 'Melissa', organization: 'Coldwell Banker',
    relationship: 'real_estate_agent', wdo_related: true,
    ...over,
  });

  test('groups by phone, counts calls + WDO calls, keeps newest identity', async () => {
    db.mockImplementation(() => rowsChain([
      mkRow({ created_at: '2026-07-08T21:38:00.000Z' }),
      mkRow({ created_at: '2026-07-01T10:00:00.000Z', caller_name: null, wdo_related: false }),
      mkRow({ phone_key: '8777175476', from_phone: '+18777175476', caller_name: 'Robert', organization: 'New Day USA', relationship: 'lender' }),
    ]));
    const res = await executeCommsTool('list_call_partners', {});
    expect(res.partner_count).toBe(2);
    const melissa = res.partners.find((p) => p.phone === '+14074933469');
    expect(melissa.calls).toBe(2);
    expect(melissa.wdo_calls).toBe(1);
    expect(melissa.name).toBe('Melissa');
    expect(melissa.first_call).toBe('2026-07-01T10:00:00.000Z');
    // Sorted by call volume.
    expect(res.partners[0].phone).toBe('+14074933469');
  });

  test('relationship filter narrows to one arranger type', async () => {
    db.mockImplementation(() => rowsChain([
      mkRow(),
      mkRow({ phone_key: '8777175476', from_phone: '+18777175476', relationship: 'lender' }),
    ]));
    const res = await executeCommsTool('list_call_partners', { relationship: 'lender' });
    expect(res.partners).toHaveLength(1);
    expect(res.partners[0].relationship).toBe('lender');
  });
});

describe('get_partner_call_history', () => {
  test('requires a usable phone', async () => {
    const res = await executeCommsTool('get_partner_call_history', { phone: '123' });
    expect(res.error).toMatch(/10 digits/);
  });

  test('maps calls with the captured other party', async () => {
    db.mockImplementation(() => rowsChain([{
      id: 'c1', created_at: '2026-07-08T21:38:00.000Z', direction: 'inbound',
      duration_seconds: 180, call_summary: 'WDO booking', disposition: null,
      caller_name: 'Melissa', organization: 'Coldwell Banker',
      requested_service: 'WDO inspection',
      secondary_contact: { first_name: 'Joseph', last_name: 'Haught', role: 'home_buyer' },
    }]));
    const res = await executeCommsTool('get_partner_call_history', { phone: '+1 (407) 493-3469' });
    expect(res.call_count).toBe(1);
    expect(res.calls[0].other_party).toBe('Joseph Haught (home_buyer)');
    expect(res.calls[0].requested_service).toBe('WDO inspection');
  });
});
