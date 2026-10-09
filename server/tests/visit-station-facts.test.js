/**
 * Station exceptions read from a technician's note (GATE_STATION_FAST_COMPLETE,
 * owner 2026-10-08, services/visit-station-facts.js) and the typed-facts route
 * that carries them to the Fast Complete sheet.
 *
 *  - A station exception stands only when its number is an ACTIVE station of the
 *    visit's program, its status is activity / serviced / inaccessible, and its
 *    quote is in the note word for word and states that number.
 *  - Anything else is dropped (the tech can still tap); a failure reads as no
 *    exceptions, never an error; access codes never reach the provider.
 *  - The route loads the registry itself, reads stations only with the gate on,
 *    for a bait station visit with no companion form, and answers exactly as
 *    before otherwise.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

let mockDbCurrent = null;
jest.mock('../models/db', () => {
  const defaultChain = () => {
    const chain = {};
    const methods = [
      'where', 'whereIn', 'whereNot', 'whereNull', 'whereNotNull', 'whereRaw', 'andWhere',
      'orWhere', 'join', 'leftJoin', 'select', 'orderBy', 'groupBy', 'limit',
      'offset', 'update', 'insert', 'del', 'onConflict', 'merge', 'ignore',
    ];
    for (const m of methods) chain[m] = () => chain;
    chain.first = async () => null;
    chain.returning = async () => [];
    chain.count = async () => [{ count: 0 }];
    chain.columnInfo = async () => ({});
    chain.then = (resolve) => Promise.resolve([]).then(resolve);
    chain.catch = () => chain;
    return chain;
  };
  const proxy = (...args) => (mockDbCurrent ? mockDbCurrent(...args) : defaultChain());
  proxy.transaction = () => Promise.resolve();
  proxy.raw = (sql) => ({ toString: () => sql });
  proxy.fn = { now: () => new Date() };
  proxy.schema = { hasTable: async () => true, hasColumn: async () => true };
  return proxy;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/job-costing', () => ({
  calculateJobCost: jest.fn(async () => ({})),
  resolveServiceRecord: jest.requireActual('../services/job-costing').resolveServiceRecord,
}));
jest.mock('../services/time-tracking', () => ({ adminEditEntry: jest.fn(async () => ({})) }));
jest.mock('../services/llm/call', () => ({
  ...jest.requireActual('../services/llm/call'),
  dispatchWithFallback: jest.fn(),
}));
let mockProfile = null;
jest.mock('../services/service-completion-profiles', () => ({
  ...jest.requireActual('../services/service-completion-profiles'),
  resolveCompletionProfileForScheduledService: async () => mockProfile,
}));
const { dispatchWithFallback } = require('../services/llm/call');
const {
  readStationExceptions, validateStationExceptions, namableStations, stationFactsSchema, STATION_SHEET_PROGRAMS, EXCEPTION_STATUSES,
} = require('../services/visit-station-facts');
const router = require('../routes/admin-dispatch');

const answer = (json) => ({ ok: true, json });
// A termite_stations row as the registry holds it.
const row = (number, extra = {}) => ({ id: `st-${number}`, station_number: number, program: 'termite', is_active: true, ...extra });
const ROSTER = [row(1), row(2), row(3), row(4), row(7)];
const NOTE = 'Station 4 had activity, I replaced the bait in 7. Everything else looked fine.';
const item = (number, status, quote) => ({ number, status, quote });

beforeEach(() => {
  dispatchWithFallback.mockReset();
  mockDbCurrent = null;
  mockProfile = null;
});

describe('which forms the sheet reads stations for', () => {
  test('termite and rodent bait stations only: a trap check keeps the full form', () => {
    expect(STATION_SHEET_PROGRAMS).toEqual({ termite_bait_station: 'termite', rodent_bait_station: 'rodent' });
    expect(STATION_SHEET_PROGRAMS).not.toHaveProperty('rodent_trapping');
    expect(EXCEPTION_STATUSES).toEqual(['activity', 'serviced', 'inaccessible']);
  });

  test('the model schema carries no numeric bounds (Anthropic structured output rejects them)', () => {
    const walk = (node) => {
      if (!node || typeof node !== 'object') return;
      expect(node).not.toHaveProperty('minimum');
      expect(node).not.toHaveProperty('maximum');
      expect(node).not.toHaveProperty('minItems');
      expect(node).not.toHaveProperty('maxItems');
      Object.values(node).forEach(walk);
    };
    walk(stationFactsSchema());
  });
});

describe('validateStationExceptions: the code verifies what the model heard', () => {
  const check = (exceptions, note = NOTE, stations = ROSTER, opts = { program: 'termite' }) => validateStationExceptions({ exceptions }, note, stations, opts);

  test('keeps an exception whose station is active in the program, whose status is one of the three and whose words are in the note and state the number', () => {
    expect(check([
      item(4, 'activity', 'station 4 had activity'),
      item(7, 'serviced', 'I replaced the bait in 7'),
    ])).toEqual([
      { id: 'st-4', number: 4, status: 'activity', quote: 'station 4 had activity' },
      { id: 'st-7', number: 7, status: 'serviced', quote: 'i replaced the bait in 7' },
    ]);
  });

  test('a station number the property does not have is dropped (a wrong number)', () => {
    expect(check([item(5, 'activity', 'station 5 had activity')], 'Station 5 had activity.')).toEqual([]);
    expect(check([item(40, 'activity', 'station 4 had activity')])).toEqual([]);
  });

  test('a retired station is dropped', () => {
    const stations = [row(1), row(4, { is_active: false }), row(7)];
    expect(check([item(4, 'activity', 'station 4 had activity')], NOTE, stations)).toEqual([]);
    expect(check([item(7, 'serviced', 'I replaced the bait in 7')], NOTE, stations)).toHaveLength(1);
  });

  test('another program\'s station is dropped, and a registry of mixed programs names nothing without a program', () => {
    const stations = [row(1), row(4, { program: 'rodent' }), row(7)];
    expect(check([item(4, 'activity', 'station 4 had activity')], NOTE, stations)).toEqual([]);
    expect(check([item(4, 'activity', 'station 4 had activity')], NOTE, stations, { program: 'rodent' })).toHaveLength(1);
    expect(check([item(7, 'serviced', 'I replaced the bait in 7')], NOTE, stations, {})).toEqual([]);
  });

  test('a quote that is not in the note is dropped, whatever the model made of it', () => {
    expect(check([item(4, 'activity', 'station 4 was chewed through')])).toEqual([]);
    expect(check([item(4, 'activity', 'the termites are all over station 4')])).toEqual([]);
  });

  test('a quote that does not state the number is dropped: a number the note does not state is never guessed', () => {
    // The words are in the note, but they name station 4 and not station 7.
    expect(check([item(7, 'activity', 'station 4 had activity')])).toEqual([]);
    expect(check([item(4, 'activity', 'had activity')], 'Station 4 had activity.')).toEqual([]);
    // A short bare quote proves too little.
    expect(check([item(4, 'activity', '4')], 'Station 4 had activity.')).toEqual([]);
  });

  test('a number said in words stands, and a decimal or ordinal states no station', () => {
    expect(check([item(7, 'serviced', 'replaced the bait in station seven')], 'Replaced the bait in station seven.')).toHaveLength(1);
    expect(check([item(4, 'activity', 'the 4th one had activity')], 'The 4th one had activity.')).toEqual([]);
    expect(check([item(4, 'activity', 'about 4.5 ounces')], 'Used about 4.5 ounces.')).toEqual([]);
  });

  test('a status that is not one of the three is dropped: ok is the default and never an exception', () => {
    expect(check([item(4, 'ok', 'station 4 had activity')])).toEqual([]);
    expect(check([item(4, 'broken', 'station 4 had activity')])).toEqual([]);
    expect(check([item(4, undefined, 'station 4 had activity')])).toEqual([]);
  });

  test('a station given two different statuses is dropped (unsure), two of the same is one', () => {
    const note = 'Station 4 had activity and I could not get to station 4.';
    expect(check([item(4, 'activity', 'station 4 had activity'), item(4, 'inaccessible', 'get to station 4')], note)).toEqual([]);
    expect(check([item(4, 'activity', 'station 4 had activity'), item(4, 'activity', 'station 4 had activity')], note)).toHaveLength(1);
  });

  test('a number held by two active stations names none', () => {
    expect(check([item(4, 'activity', 'station 4 had activity')], NOTE, [row(4), { ...row(4), id: 'dup' }])).toEqual([]);
    expect(namableStations([row(4), { ...row(4), id: 'dup' }, row(5)], 'termite').map((s) => s.number)).toEqual([5]);
  });

  test('junk in the answer is nothing, never an error', () => {
    for (const json of [null, {}, { exceptions: 'x' }, { exceptions: [null, 4, {}] }]) {
      expect(validateStationExceptions(json, NOTE, ROSTER, { program: 'termite' })).toEqual([]);
    }
    expect(check([item('4', 'activity', 'station 4 had activity')])).toEqual([]);
    expect(check([item(4.5, 'activity', 'station 4 had activity')])).toEqual([]);
  });
});

describe('readStationExceptions', () => {
  test('reads the exceptions and hands only verified ones back, naming the stations of the program', async () => {
    dispatchWithFallback.mockResolvedValue(answer({ exceptions: [
      item(4, 'activity', 'Station 4 had activity'),
      item(9, 'activity', 'station 9 was chewed'),
      item(7, 'serviced', 'I replaced the bait in 7'),
    ] }));
    const result = await readStationExceptions({ note: NOTE, stations: ROSTER, program: 'termite' });
    expect(result.status).toBe('read');
    expect(result.exceptions.map((e) => [e.number, e.status])).toEqual([[4, 'activity'], [7, 'serviced']]);
    const call = dispatchWithFallback.mock.calls[0][1];
    expect(call.laneId).toBe('visit_typed_facts');
    expect(call.system).toContain('1, 2, 3, 4, 7');
    expect(call.system).toContain('termite');
  });

  test('the rodent program reads consumption, not infestation', async () => {
    dispatchWithFallback.mockResolvedValue(answer({ exceptions: [] }));
    await readStationExceptions({ note: NOTE, stations: [row(4, { program: 'rodent' })], program: 'rodent' });
    expect(dispatchWithFallback.mock.calls[0][1].system).toContain('bait consumption');
  });

  test('a trap check is never read; no stations, no note or a long note makes no model call', async () => {
    expect(await readStationExceptions({ note: NOTE, stations: [row(4, { program: 'trapping' })], program: 'trapping' })).toMatchObject({ status: 'no_program', exceptions: [] });
    expect(await readStationExceptions({ note: NOTE, stations: [], program: 'termite' })).toMatchObject({ status: 'no_stations' });
    expect(await readStationExceptions({ note: NOTE, stations: [row(4, { is_active: false })], program: 'termite' })).toMatchObject({ status: 'no_stations' });
    expect(await readStationExceptions({ note: '   ', stations: ROSTER, program: 'termite' })).toMatchObject({ status: 'empty_note' });
    expect(await readStationExceptions({ note: 'x'.repeat(9000), stations: ROSTER, program: 'termite' })).toMatchObject({ status: 'too_long' });
    expect(dispatchWithFallback).not.toHaveBeenCalled();
  });

  test('access codes never reach the provider', async () => {
    dispatchWithFallback.mockResolvedValue(answer({ exceptions: [] }));
    await readStationExceptions({ note: 'Gate code is 4471. Station 4 had activity.', stations: ROSTER, program: 'termite' });
    const sent = dispatchWithFallback.mock.calls[0][1].text;
    expect(sent).not.toContain('4471');
    expect(sent).toContain('Station 4 had activity.');
  });

  test('a failed or throwing call is no exceptions, never an error', async () => {
    dispatchWithFallback.mockResolvedValue({ ok: false });
    expect(await readStationExceptions({ note: NOTE, stations: ROSTER, program: 'termite' })).toMatchObject({ status: 'failed', exceptions: [] });
    dispatchWithFallback.mockRejectedValue(new Error('provider down'));
    expect(await readStationExceptions({ note: NOTE, stations: ROSTER, program: 'termite' })).toMatchObject({ status: 'failed', exceptions: [] });
  });
});

function invoke(params, body, actor = { techRole: 'admin', technicianId: 'admin-1' }) {
  const layer = router.stack.find((l) => l.route && l.route.path === '/:serviceId/typed-facts' && l.route.methods.post);
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  return new Promise((resolve, reject) => {
    handler({ params, body, ...actor }, res, (err) => (err ? reject(err) : resolve(res)))
      .then(() => resolve(res))
      .catch(reject);
  });
}

const TODAY = new Date().toISOString().slice(0, 10);
const SERVICE = { id: 'svc-1', customer_id: 'cust-1', technician_id: 'tech-1', status: 'confirmed', scheduled_date: TODAY, service_type: 'Termite Monitoring' };
// A database that answers the visit and the customer's station rows.
function stationDb(service, stations, calls = []) {
  return (table) => {
    const chain = {};
    chain.where = (clause) => { calls.push({ table, clause }); return chain; };
    chain.select = async () => stations;
    chain.first = async () => (table === 'scheduled_services' ? service : null);
    return chain;
  };
}
const TYPED_FIELDS = { fields: { stations_checked: { said: false, value: 0, quote: '' }, termite_activity: { value: 'not_said', quote: '' }, bait_consumption: { value: 'not_said', quote: '' } } };
// The reader answers the typed fields call first and the station call second, or by lane prompt.
function modelAnswers(stationJson) {
  dispatchWithFallback.mockImplementation(async (_policy, request) => (
    String(request.system).includes('station number') ? answer(stationJson) : answer(TYPED_FIELDS)
  ));
}
const SHEET_STATIONS = ROSTER.map((s) => ({ id: s.id, number: s.station_number }));

describe('POST /:serviceId/typed-facts with the sheet\'s stations', () => {
  const saved = { typed: process.env.GATE_TYPED_VOICE_FILL, station: process.env.GATE_STATION_FAST_COMPLETE };
  const restore = (name, value) => { if (value === undefined) delete process.env[name]; else process.env[name] = value; };
  afterEach(() => { restore('GATE_TYPED_VOICE_FILL', saved.typed); restore('GATE_STATION_FAST_COMPLETE', saved.station); });
  beforeEach(() => {
    process.env.GATE_TYPED_VOICE_FILL = 'true';
    process.env.GATE_STATION_FAST_COMPLETE = 'true';
    mockProfile = { serviceKey: 'termite_monitoring', findingsType: 'termite_bait_station' };
  });

  test('answers the verified exceptions beside the fields, from the registry the server loads', async () => {
    const calls = [];
    mockDbCurrent = stationDb(SERVICE, ROSTER, calls);
    modelAnswers({ exceptions: [item(4, 'activity', 'station 4 had activity'), item(7, 'serviced', 'I replaced the bait in 7'), item(9, 'activity', 'station 9')] });
    const res = await invoke({ serviceId: 'svc-1' }, { note: NOTE, stations: SHEET_STATIONS });
    expect(res.body).toMatchObject({ available: true, status: 'read', stationRead: 'read' });
    expect(res.body.stationExceptions.map((e) => [e.id, e.status])).toEqual([['st-4', 'activity'], ['st-7', 'serviced']]);
    // The registry was read for THIS customer's active stations.
    expect(calls).toContainEqual({ table: 'termite_stations', clause: { customer_id: 'cust-1', is_active: true } });
  });

  test('a station the client names that the registry does not hold (or holds retired or in another program) is never an exception', async () => {
    // The registry query returns active rows only; a retired row the client still shows is not in it.
    mockDbCurrent = stationDb(SERVICE, [row(1), row(7), row(4, { program: 'rodent' })]);
    modelAnswers({ exceptions: [item(4, 'activity', 'station 4 had activity'), item(7, 'serviced', 'I replaced the bait in 7')] });
    const res = await invoke({ serviceId: 'svc-1' }, { note: NOTE, stations: [...SHEET_STATIONS, { id: 'ghost', number: 8 }] });
    expect(res.body.stationExceptions.map((e) => e.number)).toEqual([7]);
    // And a registry row the sheet did not show is not named either.
    mockDbCurrent = stationDb(SERVICE, ROSTER);
    const sheetShowed = await invoke({ serviceId: 'svc-1' }, { note: NOTE, stations: [{ id: 'st-7', number: 7 }] });
    expect(sheetShowed.body.stationExceptions.map((e) => e.number)).toEqual([7]);
  });

  test('gate off, no stations carried, a combined visit or any other form: the answer is exactly as before', async () => {
    mockDbCurrent = stationDb(SERVICE, ROSTER);
    modelAnswers({ exceptions: [item(4, 'activity', 'station 4 had activity')] });
    process.env.GATE_STATION_FAST_COMPLETE = 'false';
    let res = await invoke({ serviceId: 'svc-1' }, { note: NOTE, stations: SHEET_STATIONS });
    expect(res.body).not.toHaveProperty('stationExceptions');
    expect(res.body).not.toHaveProperty('stationRead');
    process.env.GATE_STATION_FAST_COMPLETE = 'true';
    res = await invoke({ serviceId: 'svc-1' }, { note: NOTE });
    expect(res.body).not.toHaveProperty('stationExceptions');
    res = await invoke({ serviceId: 'svc-1' }, { note: NOTE, stations: [] });
    expect(res.body).not.toHaveProperty('stationExceptions');
    mockProfile = { serviceKey: 'termite_monitoring', findingsType: 'termite_bait_station', companions: [{ type: 'rodent_bait_station' }] };
    res = await invoke({ serviceId: 'svc-1' }, { note: NOTE, stations: SHEET_STATIONS });
    expect(res.body).not.toHaveProperty('stationExceptions');
    // A trap check keeps the full form: no station read.
    mockProfile = { serviceKey: 'rodent_trapping', findingsType: 'rodent_trapping' };
    res = await invoke({ serviceId: 'svc-1' }, { note: NOTE, stations: SHEET_STATIONS });
    expect(res.body).not.toHaveProperty('stationExceptions');
    expect(dispatchWithFallback.mock.calls.some(([, request]) => String(request.system).includes('station number'))).toBe(false);
  });

  test('a registry that cannot be read is a failed station read, not an error', async () => {
    mockDbCurrent = (table) => {
      const chain = {};
      chain.where = () => chain;
      chain.select = async () => { throw new Error('db down'); };
      chain.first = async () => (table === 'scheduled_services' ? SERVICE : null);
      return chain;
    };
    modelAnswers({ exceptions: [] });
    const res = await invoke({ serviceId: 'svc-1' }, { note: NOTE, stations: SHEET_STATIONS });
    expect(res.body).toMatchObject({ available: true, stationRead: 'failed', stationExceptions: [] });
  });

  test('a technician reads only their own current visit, stations or not', async () => {
    mockDbCurrent = stationDb(SERVICE, ROSTER);
    const res = await invoke({ serviceId: 'svc-1' }, { note: NOTE, stations: SHEET_STATIONS }, { techRole: 'technician', technicianId: 'tech-2' });
    expect(res.statusCode).toBe(403);
    expect(dispatchWithFallback).not.toHaveBeenCalled();
  });
});
