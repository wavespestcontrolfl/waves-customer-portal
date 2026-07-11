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
  ['where', 'whereRaw', 'whereNotNull', 'select', 'orderBy'].forEach((m) => { q[m] = jest.fn(() => q); });
  // list_call_partners awaits the builder directly (keyset batching); the
  // history tool awaits .limit(). Support both: limit stays chainable and the
  // object is thenable, resolving the rows once (subsequent batches empty).
  let served = false;
  q.limit = jest.fn(() => q);
  q.then = (resolve, reject) => {
    const out = served ? [] : rows;
    served = true;
    return Promise.resolve(out).then(resolve, reject);
  };
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
  const enriched = (caller) => JSON.stringify({ caller });
  const mkRow = (over = {}) => ({
    from_phone: '+14074933469',
    created_at: '2026-07-08T21:38:00.000Z',
    call_summary: 'Realtor Melissa called to urgently schedule a WDO inspection.',
    ai_extraction_enriched: enriched({ name_full: 'Melissa', organization_name: 'Coldwell Banker', relationship_to_property: 'real_estate_agent' }),
    ...over,
  });

  test('groups by phone, counts calls + WDO calls, keeps newest identity', async () => {
    db.mockImplementation(() => rowsChain([
      mkRow({ created_at: '2026-07-08T21:38:00.000Z' }),
      mkRow({ created_at: '2026-07-01T10:00:00.000Z', call_summary: 'Realtor follow-up about the estimate.', ai_extraction_enriched: enriched({ relationship_to_property: 'real_estate_agent' }) }),
      mkRow({ from_phone: '+18777175476', ai_extraction_enriched: enriched({ name_full: 'Robert', organization_name: 'New Day USA', relationship_to_property: 'lender' }) }),
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
      mkRow({ from_phone: '+18777175476', ai_extraction_enriched: enriched({ relationship_to_property: 'lender' }) }),
    ]));
    const res = await executeCommsTool('list_call_partners', { relationship: 'lender' });
    expect(res.partners).toHaveLength(1);
    expect(res.partners[0].relationship).toBe('lender');
  });

  test('a legacy row with NO enriched payload still matches via its summary', async () => {
    // Pre-V2 rows (or failed V2 runs) have null ai_extraction_enriched but a
    // usable summary — the fallback must see them or the aggregate undercounts
    // exactly the legacy partners the tool documents supporting.
    db.mockImplementation(() => rowsChain([
      mkRow({ from_phone: '+19410000003', ai_extraction_enriched: null, call_summary: 'A realtor called about a WDO inspection for a pending sale.' }),
    ]));
    const res = await executeCommsTool('list_call_partners', {});
    expect(res.partner_count).toBe(1);
    expect(res.partners[0].relationship).toBe('real_estate_agent');
  });

  test('split first/last caller names label the partner when name_full is absent', async () => {
    db.mockImplementation(() => rowsChain([
      mkRow({ ai_extraction_enriched: enriched({ first_name: 'Kathy', last_name: 'Callahan', relationship_to_property: 'real_estate_agent' }) }),
    ]));
    const res = await executeCommsTool('list_call_partners', {});
    expect(res.partners[0].name).toBe('Kathy Callahan');
  });

  test('WDO counts from the STRUCTURED extraction even when the prose summary never says WDO', async () => {
    db.mockImplementation(() => rowsChain([
      mkRow({
        call_summary: 'Realtor called about an inspection for a closing next week.',
        ai_extraction_enriched: JSON.stringify({
          caller: { name_full: 'Melissa', relationship_to_property: 'real_estate_agent' },
          service_request: { primary_service_category: 'wdo' },
        }),
      }),
      // Real WDO calls usually persist as category 'termite' — inspection-only
      // intent on an arranger call is the real-estate WDO pattern.
      mkRow({
        created_at: '2026-07-07T10:00:00.000Z',
        call_summary: 'Agent needs an inspection before the sale closes.',
        ai_extraction_enriched: JSON.stringify({
          caller: { name_full: 'Melissa', relationship_to_property: 'real_estate_agent' },
          service_request: { primary_service_category: 'termite', service_intent: 'inspection_only' },
        }),
      }),
    ]));
    const res = await executeCommsTool('list_call_partners', {});
    expect(res.partners[0].wdo_calls).toBe(2);
  });

  test("a partner's follow-up calls WITHOUT the arranger signal still count in their totals", async () => {
    db.mockImplementation(() => rowsChain([
      // Bare follow-up first (as prod DESC order would): no relationship, no
      // org, no arranger phrasing — must still aggregate into the partner.
      mkRow({
        created_at: '2026-07-09T09:00:00.000Z',
        call_summary: 'Caller asked when the report would be ready.',
        ai_extraction_enriched: JSON.stringify({ caller: {} }),
      }),
      // The signal-bearing call.
      mkRow({ created_at: '2026-07-08T21:38:00.000Z' }),
    ]));
    const res = await executeCommsTool('list_call_partners', {});
    expect(res.partner_count).toBe(1);
    expect(res.partners[0].calls).toBe(2);
    expect(res.partners[0].first_call).toBe('2026-07-08T21:38:00.000Z');
    expect(res.partners[0].last_call).toBe('2026-07-09T09:00:00.000Z');
  });

  test('legacy rows: malformed JSON never throws, full arranger phrases match, relationship is inferred', async () => {
    db.mockImplementation(() => rowsChain([
      // Malformed legacy extraction — must be skipped gracefully, not throw.
      mkRow({ from_phone: '+19410000001', call_summary: 'General pest quote.', ai_extraction_enriched: '{truncated' }),
      // Pre-1.7.0 row: relationship forced to "other", summary carries the
      // FULL phrase "title company" (a truncated stem would miss this).
      mkRow({ from_phone: '+19410000002', call_summary: 'The title company called to order a WDO clearance letter before closing.', ai_extraction_enriched: enriched({ relationship_to_property: 'other' }) }),
    ]));
    const res = await executeCommsTool('list_call_partners', { relationship: 'lender' });
    expect(res.error).toBeUndefined();
    expect(res.partners).toHaveLength(1);
    expect(res.partners[0].phone).toBe('+19410000002');
    expect(res.partners[0].relationship).toBe('lender');
  });
});

describe('get_partner_call_history', () => {
  test('requires a usable phone', async () => {
    const res = await executeCommsTool('get_partner_call_history', { phone: '123' });
    expect(res.error).toMatch(/10 digits/);
  });

  test('maps calls (both directions) with the captured other party; malformed extraction is fail-open', async () => {
    let capturedWhereRaw = null;
    db.mockImplementation(() => {
      const q = {};
      ['where', 'select', 'orderBy'].forEach((m) => { q[m] = jest.fn(() => q); });
      q.whereRaw = jest.fn((sql, bindings) => { capturedWhereRaw = { sql, bindings }; return q; });
      q.limit = jest.fn(async () => [
        {
          id: 'c1', created_at: '2026-07-08T21:38:00.000Z', direction: 'inbound',
          duration_seconds: 180, call_summary: 'WDO booking', disposition: null,
          ai_extraction: JSON.stringify({ requested_service: 'WDO inspection', secondary_contact: { first_name: 'Joseph', last_name: 'Haught', role: 'home_buyer' } }),
        },
        // Staff called the partner back — outbound leg must appear too.
        { id: 'c2', created_at: '2026-07-09T10:00:00.000Z', direction: 'outbound', duration_seconds: 60, call_summary: 'Callback about scheduling', disposition: null, ai_extraction: '{broken' },
        // Both generations present: V1 carries the flattened COARSE category,
        // V2 the specific service — specific must win.
        {
          id: 'c4', created_at: '2026-07-10T12:00:00.000Z', direction: 'inbound', duration_seconds: 90, call_summary: 'Booked', disposition: null,
          ai_extraction: JSON.stringify({ requested_service: 'termite' }),
          ai_extraction_enriched: JSON.stringify({ service_request: { specific_service_name: 'WDO Inspection Service' } }),
        },
        // Post-1.7.0 call: parties + service exist ONLY in the V2 payload.
        {
          id: 'c3', created_at: '2026-07-10T10:00:00.000Z', direction: 'inbound', duration_seconds: 200, call_summary: 'WDO for a closing', disposition: null,
          ai_extraction: null,
          ai_extraction_enriched: JSON.stringify({
            service_request: { specific_service_name: 'WDO Inspection Service' },
            secondary_contacts: [
              { first_name: 'Leslie', last_name: 'Ferraro', role: 'home_buyer' },
              { first_name: 'Rigo', last_name: 'Rivera', role: 'home_seller' },
              { email: 'tenant.contact@example.com', role: 'tenant' },
            ],
          }),
        },
      ]);
      return q;
    });
    const res = await executeCommsTool('get_partner_call_history', { phone: '+1 (407) 493-3469' });
    expect(res.call_count).toBe(4);
    // Specific V2 service beats the flattened V1 category.
    expect(res.calls.find((c) => c.id === 'c4').requested_service).toBe('WDO Inspection Service');
    // V2-only multi-party context surfaces in the drilldown.
    const v2only = res.calls.find((c) => c.id === 'c3');
    expect(v2only.requested_service).toBe('WDO Inspection Service');
    expect(v2only.other_party).toBe('Leslie Ferraro (home_buyer); Rigo Rivera (home_seller); tenant.contact@example.com (tenant)');
    const inbound = res.calls.find((c) => c.id === 'c1');
    expect(inbound.other_party).toBe('Joseph Haught (home_buyer)');
    expect(inbound.requested_service).toBe('WDO inspection');
    // Malformed legacy extraction fails open per-row, not per-tool.
    const outbound = res.calls.find((c) => c.id === 'c2');
    expect(outbound.requested_service).toBeNull();
    // Contact-only party (no name captured) still labels by email.
    const c3check = res.calls.find((c) => c.id === 'c3');
    expect(c3check).toBeTruthy();
    // Both phone columns are matched.
    expect(capturedWhereRaw.sql).toContain('from_phone');
    expect(capturedWhereRaw.sql).toContain('to_phone');
    expect(capturedWhereRaw.bindings).toEqual(['4074933469', '4074933469']);
  });
});
