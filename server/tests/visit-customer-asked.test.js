/**
 * visit-customer-asked.js: the "Customer asked" facts on the tech Visit Brief. Each of the four sources shows; an
 * office-only message, a call quote and a closed portal request never do; no money keys; a failed read omits the
 * key; the caps hold. The re-service gather itself is proven in reservice-asks.test.js and is stubbed here.
 */

jest.mock('../models/db', () => {
  const fn = () => { throw new Error('global db must not be used: dbh is passed explicitly'); };
  fn.transaction = jest.fn();
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const mockGather = jest.fn();
jest.mock('../services/reservice-asks', () => ({
  ...jest.requireActual('../services/reservice-asks'),
  gatherReserviceAsks: (...args) => mockGather(...args),
}));

const { customerAskedFacts, MAX_ITEMS, MAX_TEXT_CHARS } = require('../services/visit-customer-asked');
const logger = require('../services/logger');

const SVC = {
  id: 'svc-1',
  customer_id: 'cust-1',
  service_type: 'Pest Control Re-Service',
  created_at: '2026-11-20T15:00:00.000Z',
  notes: null,
};

// One service_requests read, resolving to `rows` (or throwing); `calls` records the builder chain.
function fakeDbh({ rows = [], fail = false } = {}) {
  const calls = [];
  const dbh = (table) => {
    calls.push(['table', table]);
    const q = {};
    for (const m of ['where', 'whereIn', 'orderBy', 'limit']) q[m] = (...args) => { calls.push([m, ...args]); return q; };
    q.select = async (...cols) => {
      calls.push(['select', ...cols]);
      if (fail) throw Object.assign(new Error('boom with customer text'), { code: 'ECONNRESET' });
      return rows;
    };
    return q;
  };
  dbh.calls = calls;
  return dbh;
}

const asks = (items) => ({ ok: true, lane: 'pest', window: {}, items });
const askItem = (over) => ({ id: 'text:1', source: 'text', at: '2026-11-22T14:00:00.000Z', text: 'Ants are back in the kitchen.', quoted: true, pests: ['Ants'], ...over });

beforeEach(() => {
  mockGather.mockReset();
  mockGather.mockResolvedValue({ ok: false, reason: 'not_reservice' });
  process.env.GATE_RESERVICE_ASKS = 'true';
  logger.warn.mockClear();
});
afterAll(() => { delete process.env.GATE_RESERVICE_ASKS; });

describe('customerAskedFacts', () => {
  test('shows all four sources, newest first, with labels data the panel needs', async () => {
    mockGather.mockResolvedValue(asks([
      askItem({ id: 'booking:svc-1', source: 'request_form', at: '2026-11-20T15:00:00.000Z', text: 'Ants in the kitchen.', pests: ['Ants'] }),
      askItem({ id: 'text:9', at: '2026-11-22T14:00:00.000Z', text: 'They are worse today.', pests: [] }),
    ]));
    const svc = { ...SVC, notes: 'Self-booked. Notes: Please text before you arrive — Unit: 5' };
    const dbh = fakeDbh({ rows: [{ subject: 'Lawn Care', description: 'Brown patch by the gate', source: null, created_at: '2026-11-23T10:00:00.000Z' }] });
    const facts = await customerAskedFacts(svc, dbh);
    expect(facts.items.map((i) => i.kind)).toEqual(['portal_request', 'reservice_words', 'reservice_reason', 'booking_note']);
    expect(facts.items[0]).toEqual({ kind: 'portal_request', at: '2026-11-23T10:00:00.000Z', text: 'Lawn Care: Brown patch by the gate', source: 'portal' });
    expect(facts.items[1]).toMatchObject({ text: 'They are worse today.', source: 'text' });
    expect(facts.items[2]).toMatchObject({ text: 'Ants in the kitchen.', source: 'picker', pests: ['Ants'] });
    expect(facts.items[3]).toEqual({ kind: 'booking_note', at: SVC.created_at, text: 'Please text before you arrive' });
    expect(mockGather).toHaveBeenCalledWith('svc-1', { knex: dbh });
  });

  test('an office-only message and a call quote are not shown; a booking paraphrase from a call is, marked call', async () => {
    mockGather.mockResolvedValue(asks([
      askItem({ id: 'text:2', text: 'Ants are back.', officeOnly: 'refund' }),
      askItem({ id: 'call:3', source: 'call', text: 'On your call, you said the roaches are bad.', quoted: false }),
      askItem({ id: 'booking:svc-1', source: 'call', quoted: false, text: 'Roaches under the sink.', pests: ['Cockroaches'] }),
      askItem({ id: 'text:4', text: '', officeOnly: 'damage' }),
    ]));
    const facts = await customerAskedFacts(SVC, fakeDbh());
    expect(facts.items).toHaveLength(1);
    expect(facts.items[0]).toMatchObject({ kind: 'reservice_reason', source: 'call', text: 'Roaches under the sink.' });
    expect(JSON.stringify(facts)).not.toMatch(/refund|you said/);
  });

  test('a closed portal request is not read, and a card row shows only its service, never its description', async () => {
    const dbh = fakeDbh({ rows: [{ subject: 'Quote requested in portal chat: Lawn Care', description: 'Their words: x. $149 per visit', source: 'portal_chat', created_at: '2026-11-23T10:00:00.000Z' }] });
    const facts = await customerAskedFacts(SVC, dbh);
    expect(facts.items).toEqual([{ kind: 'portal_request', at: '2026-11-23T10:00:00.000Z', text: 'Quote requested in portal chat: Lawn Care', source: 'portal' }]);
    expect(JSON.stringify(facts)).not.toMatch(/149/);
    const statusFilter = dbh.calls.filter((c) => c[0] === 'where' && typeof c[1] === 'function');
    expect(statusFilter).toHaveLength(2);
    // The open filter runs on a stub chain: replay it to see the terminal statuses it excludes.
    const seen = [];
    const chain = { whereNull: () => chain, orWhereNotIn: (col, list) => { seen.push([col, list]); return chain; }, orWhereIn: () => chain };
    statusFilter.forEach(([, fn]) => fn.call(chain));
    expect(seen[0]).toEqual(['status', ['resolved', 'closed', 'cancelled']]);
    // Only the columns a technician may see are read: no pricing_revision.
    expect(dbh.calls.find((c) => c[0] === 'select').slice(1)).toEqual(['subject', 'description', 'source', 'created_at']);
    expect(dbh.calls.find((c) => c[0] === 'where' && c[1]?.customer_id)[1]).toEqual({ customer_id: 'cust-1' });
  });

  test('a promotion card row shows its service line, not the server description', async () => {
    const dbh = fakeDbh({ rows: [{ subject: 'Interested in adding Mosquito', description: 'Customer expressed interest via promotion card: p-1', source: null, created_at: '2026-11-23T10:00:00.000Z' }] });
    const facts = await customerAskedFacts(SVC, dbh);
    expect(facts.items[0].text).toBe('Interested in adding Mosquito');
  });

  test('no money keys and no source gate-off read: with the gate off the re-service gather never runs', async () => {
    process.env.GATE_RESERVICE_ASKS = 'false';
    const facts = await customerAskedFacts({ ...SVC, notes: 'Self-booked. Notes: Gate is open' }, fakeDbh());
    expect(mockGather).not.toHaveBeenCalled();
    expect(Object.keys(facts.items[0]).sort()).toEqual(['at', 'kind', 'text']);
    expect(JSON.stringify(facts)).not.toMatch(/price|total|amount|discount|invoice|pricing/i);
  });

  test('a re-service request line in the notes is the reason, not a booking note', async () => {
    const facts = await customerAskedFacts({ ...SVC, notes: 'Self-booked. Notes: Re-service request: ants are back — Unit: 5' }, fakeDbh());
    expect(facts).toBeNull();
  });

  test('every read failing omits the key, logs error codes only, and never throws', async () => {
    mockGather.mockRejectedValue(Object.assign(new Error('customer text in message'), { code: 'XX000' }));
    const facts = await customerAskedFacts(SVC, fakeDbh({ fail: true }));
    expect(facts).toBeNull();
    const logged = logger.warn.mock.calls.map((c) => c[0]).join('\n');
    expect(logged).toContain('XX000');
    expect(logged).toContain('ECONNRESET');
    expect(logged).not.toMatch(/customer text/);
  });

  test('one failed source leaves the others', async () => {
    const facts = await customerAskedFacts({ ...SVC, notes: 'Self-booked. Notes: Beware of the dog' }, fakeDbh({ fail: true }));
    expect(facts.items.map((i) => i.kind)).toEqual(['booking_note']);
  });

  test('caps: 8 items, 280 characters each, repeats of one wording collapse', async () => {
    const long = `${'word '.repeat(100)}end`;
    mockGather.mockResolvedValue(asks(Array.from({ length: 10 }, (_, n) => askItem({
      id: `text:${n}`, at: `2026-11-${String(10 + n).padStart(2, '0')}T14:00:00.000Z`, text: n === 9 ? long : `Ants in room ${n}.`,
    }))));
    const rows = [
      { subject: 'Pest issue', description: 'Ants in room 3', source: null, created_at: '2026-11-01T10:00:00.000Z' },
      { subject: 'Pest issue', description: 'Ants in room 3', source: null, created_at: '2026-11-02T10:00:00.000Z' },
    ];
    const facts = await customerAskedFacts(SVC, fakeDbh({ rows }));
    expect(facts.items).toHaveLength(MAX_ITEMS);
    expect(facts.items[0].text.length).toBeLessThanOrEqual(MAX_TEXT_CHARS);
    expect(facts.items[0].text.endsWith('…')).toBe(true);
    const times = facts.items.map((i) => Date.parse(i.at));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });
});
