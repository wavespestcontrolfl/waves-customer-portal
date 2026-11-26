// GET /api/admin/protocols/completion-actions for a booked follow-up visit. A follow-up booked from a finished visit copies that visit's name,
// so its name alone matches the first visit's card. With ?visitId= the route reads the visit and serves the program's follow-up card instead:
// a flea follow-up must never offer the growth regulator again. Real handler and real protocols.json; synthetic visit rows.
jest.mock('../models/db', () => jest.fn());
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: jest.fn(), requireAdmin: jest.fn(), requireTechOrAdmin: jest.fn(),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const db = require('../models/db');
const adminProtocolsRouter = require('../routes/admin-protocols');

const handler = adminProtocolsRouter.stack.find((layer) => layer.route?.path === '/completion-actions' && layer.route.methods.get).route.stack[0].handle;
const VISIT = '3f2c1d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const CATALOG = [
  { id: 'ant', name: 'Atticus Antapex WSG', aliases: [] },
  { id: 'tek', name: 'Tekko Pro IGR', aliases: [] },
  { id: 'fast', name: 'Onslaught Fastcap', aliases: [] },
  { id: 'gel', name: 'Advion Evolution Cockroach Gel Bait', aliases: [] },
];

function readQuery(rows) {
  const query = {};
  for (const method of ['where', 'orWhereNull', 'whereIn', 'whereNotIn', 'join', 'select', 'orderByRaw', 'orderBy']) query[method] = jest.fn(() => query);
  query.first = jest.fn(async () => rows[0] || null);
  query.then = (onFulfilled, onRejected) => Promise.resolve(rows).then(onFulfilled, onRejected);
  query.catch = (onRejected) => Promise.resolve(rows).catch(onRejected);
  return query;
}

let visitRows;
async function actions(query) {
  const res = { json: jest.fn(), status: jest.fn() };
  res.status.mockReturnValue(res);
  const next = jest.fn();
  await handler({ query }, res, next);
  expect(next).not.toHaveBeenCalled();
  expect(res.status).not.toHaveBeenCalled();
  return JSON.parse(JSON.stringify(res.json.mock.calls[0][0]));
}
const namesOf = (body) => body.actions.map((action) => action.product?.name).filter(Boolean);

beforeEach(() => {
  jest.clearAllMocks();
  visitRows = [];
  db.mockImplementation((table) => {
    if (table === 'products_catalog') return readQuery(CATALOG);
    if (table === 'product_aliases') return readQuery([]);
    if (table === 'scheduled_services') return readQuery(visitRows);
    throw new Error(`Unexpected table: ${table}`);
  });
});

describe('/completion-actions on a booked follow-up visit', () => {
  test('a flea follow-up gets treatment 2: the growth regulator is not offered again', async () => {
    visitRows = [{ followup_source_service_id: 'a-finished-visit' }];
    const body = await actions({ serviceType: 'Flea Control Service', visitId: VISIT });
    expect(body).toMatchObject({ programKey: 'flea', visit: { visit: 2 } });
    expect(namesOf(body)).not.toContain('Tekko Pro IGR');
  });

  test('the first flea visit, and a call with no visit, keep treatment 1', async () => {
    visitRows = [{ followup_source_service_id: null }];
    const first = await actions({ serviceType: 'Flea Control Service', visitId: VISIT });
    expect(first).toMatchObject({ programKey: 'flea', visit: { visit: 1 } });
    expect(namesOf(first)).toEqual(expect.arrayContaining(['Atticus Antapex WSG', 'Tekko Pro IGR']));
    const noVisit = await actions({ serviceType: 'Flea Control Service' });
    expect(noVisit.visit.visit).toBe(1);
    // A value that is not a visit id is never sent to the database.
    visitRows = [{ followup_source_service_id: 'x' }];
    expect((await actions({ serviceType: 'Flea Control Service', visitId: 'not-an-id' })).visit.visit).toBe(1);
  });

  test('a cockroach and a bed bug follow-up get their follow-up cards; a program with none keeps its card', async () => {
    visitRows = [{ followup_source_service_id: 'a-finished-visit' }];
    expect(await actions({ serviceType: 'Cockroach Control Service', visitId: VISIT })).toMatchObject({ programKey: 'cockroach', visit: { visit: 3 } });
    expect(await actions({ serviceType: 'Bed Bug Treatment Service', visitId: VISIT })).toMatchObject({ programKey: 'bed_bug', visit: { visit: 3 } });
    expect(await actions({ serviceType: 'Quarterly Pest Control', visitId: VISIT })).toMatchObject({ programKey: 'pest', visit: { visit: 1 } });
  });
});
