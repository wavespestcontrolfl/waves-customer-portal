// GATE_STATION_FAST_COMPLETE: the technician's per-station statuses go to the
// report writer as authoritative inputs, over whatever the note says (the
// sweep chip's pattern). Mirrors generate-report-sweep-correction.test.js.
// The customer's active stations as the registry holds them (four rodent, one of another program).
let mockStationRows = [1, 2, 3, 4].map((n) => ({ id: `s${n}`, program: 'rodent' })).concat([{ id: 't1', program: 'termite' }]);
const mockProfile = { serviceKey: 'rodent_bait_quarterly', findingsType: 'rodent_bait_station' };
const mockProvider = jest.fn(async () => ({ ok: true, text: 'WHAT WE DID\n\nTreated the exterior perimeter.\n\nWHAT WE FOUND\n\nNo activity noted.' }));
jest.mock('../services/llm/call', () => ({ callOpenAI: (...args) => mockProvider(...args), callAnthropic: (...args) => mockProvider(...args) }));
jest.mock('../services/pest-pressure/store', () => ({ loadActiveConfig: async () => null }));
jest.mock('../services/service-completion-profiles', () => ({
  ...jest.requireActual('../services/service-completion-profiles'),
  resolveCompletionProfileForScheduledService: async () => mockProfile,
}));
jest.mock('../services/service-report/report-copy-context', () => ({ buildReportCopyContext: async () => ({ contextText: '', signals: {} }) }));
jest.mock('../models/db', () => {
  const db = jest.fn((table) => {
    const chain = {};
    for (const name of ['where', 'whereIn', 'select', 'orderBy', 'limit', 'leftJoin']) chain[name] = () => chain;
    chain.first = async () => table === 'scheduled_services'
      ? { id: '11111111-1111-4111-8111-111111111111', service_type: 'Quarterly Pest Control Service', customer_id: 'customer-1' } : null;
    chain.then = (resolve) => Promise.resolve(table === 'termite_stations' ? mockStationRows : []).then(resolve);
    return chain;
  });
  db.raw = jest.fn(); db.fn = { now: () => new Date() }; return db;
});
const router = require('../routes/admin-schedule');
const handler = router.stack.find((layer) => layer.route?.path === '/generate-report').route.stack.at(-1).handle;
const db = require('../models/db');
// Captured once so per-test overrides (the assessment-validation tests
// below) can be reverted in beforeEach — no other test in this file relies
// on lawn_assessments resolving truthy, so leaking a custom impl forward
// would silently open the lawn-assessment-gate branch for unrelated tests.
const defaultDbImpl = db.getMockImplementation();

function mkReq(body) {
  return {
    techRole: 'admin',
    body: {
      scheduledServiceId: '11111111-1111-4111-8111-111111111111',
      serviceType: 'Quarterly Pest Control Service',
      ...body,
    },
  };
}
function mkRes() {
  return { statusCode: 200, status(code) { this.statusCode = code; return this; }, json: jest.fn() };
}

beforeEach(() => { mockProvider.mockClear(); db.mockImplementation(defaultDbImpl); });


const NOTE = 'Bait eaten at station 2. Everything else looked fine.';
const FINDINGS = { type: 'rodent_bait_station', values: { stations_checked: '3', stations_inaccessible: '0', bait_consumption: 'Light' } };
const send = async (extra, gate = 'true') => {
  if (gate === null) delete process.env.GATE_STATION_FAST_COMPLETE; else process.env.GATE_STATION_FAST_COMPLETE = gate;
  mockProvider.mockClear();
  const res = mkRes();
  await handler(mkReq({ serviceNotes: NOTE, actionsCompleted: [], structuredFindings: FINDINGS, fresh: true, ...extra }), res);
  expect(res.statusCode).toBe(200);
  return mockProvider.mock.calls[0][0].text;
};
afterEach(() => { delete process.env.GATE_STATION_FAST_COMPLETE; });

const OBS = 'Technician station checks, observed (authoritative: they override anything the note says about a station): ';
const DONE = 'Technician station checks, work done (authoritative: they override anything the note says about a station): ';
const sectionsOf = (text) => ({
  completed: text.slice(text.indexOf('[COMPLETED WORK]'), text.indexOf('[OBSERVED BY TECHNICIAN]')),
  observed: text.slice(text.indexOf('[OBSERVED BY TECHNICIAN]'), text.indexOf('[REPORTED BY CUSTOMER]')),
});

test('a station the tech corrected to Serviced is work done, under the completed work, over the note', async () => {
  const { completed, observed } = sectionsOf(await send({ stationChecks: [{ number: 2, status: 'serviced' }] }));
  expect(completed).toContain(`Actions completed: Not specified\n${DONE}station 2: the technician serviced the station`);
  expect(completed).not.toContain('Technician station checks, observed');
  // The stations found OK are an observation, with the same authority: every
  // OTHER station, since station 2 is an exception (serviced).
  expect(observed).toContain(`${OBS}Every other station was checked and is OK.`);
  expect(observed).not.toContain('every station was checked');
  expect(observed).not.toContain('serviced the station');
});

test('bait consumption and a station nobody could reach are what the technician observed, never work performed', async () => {
  const text = await send({ stationChecks: [{ number: 3, status: 'inaccessible' }, { number: 2, status: 'activity' }, { number: 1, status: 'serviced' }] });
  const { completed, observed } = sectionsOf(text);
  expect(observed).toMatch(/observed \(authoritative.*\): station 2: bait consumption.*; station 3: could not be reached or checked\. Every other station was checked and is OK\./);
  expect(observed).not.toContain('station 1:');
  expect(completed).toContain('work done (authoritative');
  expect(completed).toContain('station 1: the technician serviced the station');
  expect(completed).not.toContain('bait consumption');
  expect(completed).not.toContain('could not be reached');
});

test('an empty list says every station is OK, as an observation, over a note that named one', async () => {
  const { completed, observed } = sectionsOf(await send({ stationChecks: [] }));
  expect(observed).toContain(`${OBS}every station was checked and is OK.`);
  expect(completed).not.toContain('Technician station checks');
});

test('nothing is added with the gate off, without a list, or for a status that is not known', async () => {
  expect(await send({ stationChecks: [{ number: 2, status: 'serviced' }] }, null)).not.toContain('Technician station checks');
  expect(await send({})).not.toContain('Technician station checks');
  expect(await send({ stationChecks: [{ number: 2, status: 'broken' }] })).not.toContain('Technician station checks');
  expect(await send({ stationChecks: [{ number: 2, status: 'activity' }, { number: 2, status: 'serviced' }] })).not.toContain('Technician station checks');
  expect(await send({ stationChecks: 'station 2' })).not.toContain('Technician station checks');
});

test('a corrected status is a different request: the cached draft for the old one is not served', async () => {
  const unique = { serviceNotes: 'Cache check: bait eaten at station 2, nothing else.', fresh: false };
  await send({ ...unique, stationChecks: [{ number: 2, status: 'activity' }] });
  // The same request again is served from the cache; the corrected one is not.
  mockProvider.mockClear();
  const res = mkRes();
  await handler(mkReq({ serviceNotes: unique.serviceNotes, actionsCompleted: [], structuredFindings: FINDINGS, stationChecks: [{ number: 2, status: 'activity' }] }), res);
  expect(mockProvider).not.toHaveBeenCalled();
  const text = await send({ ...unique, stationChecks: [{ number: 2, status: 'serviced' }] });
  expect(text).toContain('station 2: the technician serviced the station');
});

// Codex P2 on #6205: no "every other station is OK" when no station remains. The
// roster total is the server's own read of the registry.
describe('the OK remainder against the roster the server reads', () => {
  const rosterOf = (n) => { mockStationRows = Array.from({ length: n }, (_, i) => ({ id: `s${i + 1}`, program: 'rodent' })); };
  afterAll(() => rosterOf(4));

  test('the only station flagged: no remainder is claimed', async () => {
    rosterOf(1);
    const { observed } = sectionsOf(await send({ stationChecks: [{ number: 1, status: 'inaccessible' }] }));
    expect(observed).toContain('station 1: could not be reached or checked.');
    expect(observed).not.toMatch(/is OK/);
  });

  test('all three flagged, one of them serviced: no remainder, and no empty observed line', async () => {
    rosterOf(3);
    const text = await send({ stationChecks: [{ number: 1, status: 'activity' }, { number: 2, status: 'inaccessible' }, { number: 3, status: 'serviced' }] });
    expect(text).not.toMatch(/is OK/);
    rosterOf(1);
    const only = sectionsOf(await send({ stationChecks: [{ number: 1, status: 'serviced' }] }));
    expect(only.completed).toContain('station 1: the technician serviced the station');
    expect(only.observed).not.toContain('Technician station checks');
  });

  test('two of three flagged: the remainder is kept', async () => {
    rosterOf(3);
    const { observed } = sectionsOf(await send({ stationChecks: [{ number: 1, status: 'activity' }, { number: 2, status: 'inaccessible' }] }));
    expect(observed).toMatch(/Every other station was checked and is OK\.$/m);
  });

  test('another program\'s stations do not count toward the roster', async () => {
    mockStationRows = [{ id: 's1', program: 'rodent' }, { id: 't1', program: 'termite' }, { id: 't2', program: 'termite' }];
    const { observed } = sectionsOf(await send({ stationChecks: [{ number: 1, status: 'activity' }] }));
    expect(observed).not.toMatch(/is OK/);
  });
});

// Codex P2 on #6205: when both providers fail, the deterministic fallback copy
// gets the same station facts as the prompt.
describe('the deterministic fallback when both providers fail', () => {
  const fallback = async (extra, gate = 'true') => {
    if (gate === null) delete process.env.GATE_STATION_FAST_COMPLETE; else process.env.GATE_STATION_FAST_COMPLETE = gate;
    mockProvider.mockReset();
    mockProvider.mockResolvedValue({ ok: false, reason: 'provider_error' });
    const res = mkRes();
    await handler(mkReq({ serviceNotes: NOTE, actionsCompleted: [], structuredFindings: FINDINGS, fresh: true, ...extra }), res);
    mockProvider.mockReset();
    mockProvider.mockImplementation(async () => ({ ok: true, text: 'WHAT WE DID\n\nTreated the exterior perimeter.\n\nWHAT WE FOUND\n\nNo activity noted.' }));
    return { status: res.statusCode, body: res.json.mock.calls[0][0] };
  };

  test('activity and a station nobody could reach are stated', async () => {
    const { status, body } = await fallback({ stationChecks: [{ number: 2, status: 'activity' }, { number: 3, status: 'inaccessible' }] });
    expect(status).toBe(200);
    expect(body).toMatchObject({ fallback: true, deterministic: true });
    expect(body.report).toContain('Checked the rodent bait stations');
    expect(body.report).toContain('Bait consumption was found at station 2');
    expect(body.report).toContain('Could not reach station 3');
    expect(body.report).toContain('Every other station was checked and found OK');
  });

  test('a visit whose only recorded work is servicing a station returns copy, not a 503', async () => {
    const { status, body } = await fallback({ stationChecks: [{ number: 1, status: 'serviced' }, { number: 4, status: 'serviced' }] });
    expect(status).toBe(200);
    expect(body.report).toContain('Serviced stations 1, 4');
  });

  test('all OK says the stations were checked and found OK', async () => {
    const { status, body } = await fallback({ stationChecks: [] });
    expect(status).toBe(200);
    expect(body.report).toContain('Checked the rodent bait stations');
    expect(body.report).toContain('Every station was checked and found OK');
  });

  test('every station flagged claims no OK remainder', async () => {
    const { body } = await fallback({ stationChecks: [1, 2, 3, 4].map((number) => ({ number, status: 'inaccessible' })) });
    expect(body.report).toContain('Could not reach stations 1, 2, 3, 4');
    expect(body.report).not.toMatch(/found OK/);
  });

  test('gate off: the fallback is exactly what it is without station checks', async () => {
    const withChecks = await fallback({ stationChecks: [{ number: 2, status: 'activity' }] }, null);
    const without = await fallback({}, null);
    expect(withChecks).toEqual(without);
    expect(JSON.stringify(withChecks.body)).not.toMatch(/station 2|bait stations/);
  });
});
