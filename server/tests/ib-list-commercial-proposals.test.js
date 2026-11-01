// list_commercial_proposals (Intelligence Bar + the owner's read-only MCP): the live commercial proposals as ids, codes,
// dates and flags only. The real query builder runs against a fake pg client so the SQL is asserted; the proposal
// normalizer runs for real; the readiness functions #7364 added are stubbed so each branch of their verdicts is pinned
// here without a database. Synthetic data only.
jest.mock('../models/db', () => {
  const db = require('knex')({ client: 'pg' });
  db.__queries = [];
  db.__rows = () => [];
  db.client.acquireConnection = async () => ({});
  db.client.releaseConnection = async () => {};
  db.client._query = async (_, query) => {
    db.__queries.push(query);
    query.response = { command: 'SELECT', rows: db.__rows(query) };
    return query;
  };
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

let mockSignLive = true;
let mockVisitLive = true;
jest.mock('../config/feature-gates', () => ({
  ...jest.requireActual('../config/feature-gates'),
  commercialProposalSignLive: () => mockSignLive,
  commercialFirstVisitLive: () => mockVisitLive,
}));

const mockClosed = jest.fn(() => false);
jest.mock('../routes/estimate-public', () => ({ estimateClosedOnline: (...a) => mockClosed(...a) }));
const mockAgreement = jest.fn();
jest.mock('../services/commercial-proposal-agreement', () => ({ agreementAdminStatus: (...a) => mockAgreement(...a) }));
const mockReadiness = jest.fn();
jest.mock('../services/commercial-first-visit', () => ({ firstVisitReadiness: (...a) => mockReadiness(...a) }));

const db = require('../models/db');
const { executeEstimateTool, ESTIMATE_TOOLS } = require('../services/intelligence-bar/estimate-tools');

const authored = (over = {}) => ({
  proposal: {
    enabled: true,
    title: 'Sample Plaza service plan',
    preparedFor: 'Sample Plaza LLC',
    propertyAddress: '1 Example Way',
    buildingUse: 'nonresidential',
    buildings: [{ name: 'Main', lineItems: [{ description: 'Quarterly pest control', unitPrice: 100, frequency: 'quarterly' }] }],
    commercialTerms: { paymentTerms: 'autopay' },
    ...over,
  },
});

let n = 0;
const row = (over = {}) => {
  n += 1;
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    estimate_slug: `EST-${1000 + n}`,
    status: 'sent',
    customer_id: `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    customer_name: 'Pat Example',
    address: '2 Example Way',
    created_at: '2026-10-30T12:00:00.000Z',
    sent_at: '2026-10-30T13:00:00.000Z',
    viewed_at: null,
    expires_at: '2026-11-30T13:00:00.000Z',
    archived_at: null,
    bill_by_invoice: false,
    estimate_data: authored(),
    ...over,
  };
};

const run = (input = {}) => executeEstimateTool('list_commercial_proposals', input);

beforeEach(() => {
  n = 0;
  mockSignLive = true;
  mockVisitLive = true;
  db.__queries.length = 0;
  db.__rows = () => [];
  mockClosed.mockReset().mockReturnValue(false);
  mockAgreement.mockReset().mockResolvedValue({ state: 'none' });
  mockReadiness.mockReset().mockResolvedValue({ state: 'online' });
});

describe('the tool definition', () => {
  test('is a bounded read with only scope, limit and offset', () => {
    const tool = ESTIMATE_TOOLS.find((t) => t.name === 'list_commercial_proposals');
    expect(Object.keys(tool.input_schema.properties).sort()).toEqual(['limit', 'offset', 'scope']);
    expect(tool.input_schema.properties.limit).toMatchObject({ minimum: 1, maximum: 50 });
    expect(tool.input_schema.properties.scope.enum).toEqual(['open', 'all']);
    expect(tool.input_schema.required).toBeUndefined();
  });

  test('is a plain read in the action policy', () => {
    expect(require('../services/intelligence-bar/action-policy.json').list_commercial_proposals)
      .toMatchObject({ kind: 'read', approval: null, module: 'estimate-tools.js' });
  });
});

describe('the query', () => {
  test('selects only the needed columns of unarchived estimates with an enabled proposal, open ones by default, newest first', async () => {
    await run({});
    const { sql, bindings } = db.__queries[0];
    expect(sql).toMatch(/from "estimates"/);
    expect(sql).toMatch(/"archived_at" is null/);
    expect(sql).toContain("estimate_data->'proposal'->>'enabled' = 'true'");
    expect(sql).toMatch(/"status" not in \(\$1, \$2, \$3\)/);
    expect(bindings.slice(0, 3)).toEqual(['accepted', 'declined', 'expired']);
    expect(sql).toMatch(/order by "created_at" desc, "id" desc/);
    expect(sql).not.toMatch(/select \*/);
    expect(sql).not.toMatch(/"token"|"notes"|"customer_phone"|"customer_email"/);
  });

  test('scope all keeps every status', async () => {
    await run({ scope: 'all' });
    expect(db.__queries[0].sql).not.toMatch(/"status" not in/);
  });
});

describe('the rows', () => {
  test('a row is ids, codes, dates and flags only', async () => {
    const first = row({ viewed_at: '2026-10-31T09:00:00.000Z' });
    db.__rows = () => [first];
    mockAgreement.mockResolvedValue({ state: 'awaiting', signingBlocked: 'terms_conflict', field: 'paymentTerms', note: 'Online signing needs the proposal terms to match the agreement: free text.' });
    const out = await run({});
    expect(out).toEqual({
      scope: 'open',
      proposals: [{
        estimate_id: first.id,
        estimate_number: 'EST-1001',
        status: 'sent',
        customer_id: first.customer_id,
        created_at: '2026-10-30T12:00:00.000Z',
        sent_at: '2026-10-30T13:00:00.000Z',
        viewed_at: '2026-10-31T09:00:00.000Z',
        expires_at: '2026-11-30T13:00:00.000Z',
        bill_by_invoice: false,
        payment_terms: 'autopay',
        building_use: 'nonresidential',
        closed_online: false,
        signing: { state: 'awaiting', blocked: 'terms_conflict' },
        first_visit: { state: 'online', reason: null },
      }],
      returned_count: 1,
      has_more: false,
      next_offset: null,
    });
    const text = JSON.stringify(out);
    for (const word of ['Sample Plaza', 'Example Way', 'Pat Example', 'Quarterly pest control', 'free text', 'field']) expect(text).not.toContain(word);
  });

  test('the readiness functions get the row and the closed verdict', async () => {
    const first = row();
    db.__rows = () => [first];
    mockClosed.mockReturnValue(true);
    mockAgreement.mockResolvedValue({ state: 'none', signingBlocked: 'closed' });
    mockReadiness.mockResolvedValue({ state: 'office', reason: 'closed' });
    const [item] = (await run({})).proposals;
    expect(mockClosed).toHaveBeenCalledWith(first);
    expect(mockAgreement).toHaveBeenCalledWith(first, db, { closed: true });
    expect(mockReadiness).toHaveBeenCalledWith(first, { conn: db, closed: true });
    expect(item).toMatchObject({ closed_online: true, signing: { state: 'none', blocked: 'closed' }, first_visit: { state: 'office', reason: 'closed' } });
  });

  test('a booked first visit adds its date and nothing else of the visit', async () => {
    db.__rows = () => [row()];
    mockReadiness.mockResolvedValue({ state: 'booked', visit: { date: '2026-11-12', windowStart: '08:00', windowEnd: '10:00' } });
    const [item] = (await run({})).proposals;
    expect(item.first_visit).toEqual({ state: 'booked', reason: null, visit_date: '2026-11-12' });
  });

  test('a signed agreement has no block', async () => {
    db.__rows = () => [row()];
    mockAgreement.mockResolvedValue({ state: 'signed' });
    expect((await run({})).proposals[0].signing).toEqual({ state: 'signed', blocked: null });
  });

  test('signing and first_visit are null while their gates are off, and never asked', async () => {
    db.__rows = () => [row()];
    mockSignLive = false;
    mockVisitLive = false;
    const [item] = (await run({})).proposals;
    expect(item.signing).toBeNull();
    expect(item.first_visit).toBeNull();
    expect(mockAgreement).not.toHaveBeenCalled();
    expect(mockReadiness).not.toHaveBeenCalled();
  });

  test('a throw reads as closed, signing unknown and first visit unknown; the rest of the list survives', async () => {
    const [a, b] = [row(), row()];
    db.__rows = () => [a, b];
    mockClosed.mockImplementationOnce(() => { throw new Error('boom'); });
    mockAgreement.mockRejectedValueOnce(new Error('boom'));
    mockReadiness.mockRejectedValueOnce(new Error('boom'));
    const out = await run({});
    expect(out.proposals).toHaveLength(2);
    expect(out.proposals[0]).toMatchObject({ closed_online: true, signing: { state: 'unknown', blocked: null }, first_visit: { state: 'unknown', reason: null } });
    expect(out.proposals[1]).toMatchObject({ closed_online: false, signing: { state: 'none', blocked: null }, first_visit: { state: 'online' } });
  });

  test('invoice mode, no terms and no building use read as flag, null and null', async () => {
    db.__rows = () => [row({ bill_by_invoice: true, estimate_data: authored({ buildingUse: undefined, commercialTerms: undefined }) })];
    const [item] = (await run({})).proposals;
    expect(item).toMatchObject({ bill_by_invoice: true, payment_terms: null, building_use: null });
  });

  test('a residential pick and a Net term come through as their codes', async () => {
    db.__rows = () => [row({ estimate_data: JSON.stringify(authored({ buildingUse: 'residential', commercialTerms: { paymentTerms: 'net30' } })) })];
    const [item] = (await run({})).proposals;
    expect(item).toMatchObject({ building_use: 'residential', payment_terms: 'net30' });
  });
});

describe('which estimates count as authored', () => {
  test('a synthesized fallback, a disabled proposal and an unreadable row are left out', async () => {
    const keep = row();
    db.__rows = () => [
      row({ estimate_data: { proposal: { enabled: true } } }), // no itemization: the synthesized fallback
      row({ estimate_data: authored({ enabled: false }) }),
      row({ estimate_data: '{not json' }),
      keep,
    ];
    const out = await run({});
    expect(out.proposals.map((p) => p.estimate_id)).toEqual([keep.id]);
  });
});

describe('paging', () => {
  const many = (count) => Array.from({ length: count }, () => row());

  test('default limit 25: a 26th proposal sets has_more and next_offset', async () => {
    const rows = many(26);
    db.__rows = () => rows;
    const out = await run({});
    expect(out.returned_count).toBe(25);
    expect(out.has_more).toBe(true);
    expect(out.next_offset).toBe(25);
  });

  test('offset skips proposals, and the last page ends the chain', async () => {
    const rows = many(7);
    db.__rows = () => rows;
    const page = await run({ limit: 3, offset: 3 });
    expect(page.proposals.map((p) => p.estimate_id)).toEqual(rows.slice(3, 6).map((r) => r.id));
    expect(page).toMatchObject({ has_more: true, next_offset: 6 });
    const last = await run({ limit: 3, offset: 6 });
    expect(last.proposals.map((p) => p.estimate_id)).toEqual([rows[6].id]);
    expect(last).toMatchObject({ has_more: false, next_offset: null });
  });

  test('the limit is capped at 50 and floored at 1', async () => {
    const rows = many(60);
    db.__rows = () => rows;
    expect((await run({ limit: 500 })).returned_count).toBe(50);
    expect((await run({ limit: 0 })).returned_count).toBe(1);
    expect((await run({ limit: -4 })).returned_count).toBe(1);
  });

  test('a full database chunk of non-authored rows does not end the scan', async () => {
    const filler = Array.from({ length: 100 }, () => row({ estimate_data: { proposal: { enabled: true } } }));
    const keep = row();
    let chunk = 0;
    db.__rows = () => [filler, [keep]][chunk++] || [];
    const out = await run({});
    expect(out.proposals.map((p) => p.estimate_id)).toEqual([keep.id]);
    expect(db.__queries).toHaveLength(2);
    expect(db.__queries[1].sql).toMatch(/offset \$\d+/);
  });
});

describe('an empty list', () => {
  test('is a plain non-empty object', async () => {
    expect(await run({})).toEqual({ scope: 'open', proposals: [], returned_count: 0, has_more: false, next_offset: null });
  });
});
